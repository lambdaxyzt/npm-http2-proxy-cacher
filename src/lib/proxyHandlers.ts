import http from "node:http";
import http2 from "node:http2";
import fs from "node:fs";
import crypto from "node:crypto";
import { PassThrough, pipeline } from "node:stream";
import { StreamingReplaceURLTransform } from "@src/lib/replaceDomainJSONFile/index";
import { ensureDirectory, isPathExist, randomID } from "@src/util";
import { getPackagePaths } from "@src/lib/getPackagePaths";
import { writePackageMeta } from "@src/lib/packageMeta";
import { SingleFlight } from "@src/lib/singleFlight";
import type { parseRequest } from "@src/lib/parseRequest";

/**
 * Coalesces concurrent downloads of the same tarball. Keyed by the tarball's
 * final cache path so simultaneous `npm install`s trigger a single upstream
 * fetch instead of one per client.
 */
const tarballDownloads = new SingleFlight<void>();

function serveTarballFromCache(tarballPath: string, res: http.ServerResponse) {
  const stream = fs.createReadStream(tarballPath);
  res.writeHead(200, { "content-type": "application/octet-stream" });
  stream.pipe(res);
  stream.on("error", () => {
    if (!res.headersSent) res.writeHead(502);
    res.end();
  });
}

/**
 * Downloads the tarball from upstream into the cache, optionally teeing the
 * bytes to `leaderRes` so the request that started the download is served
 * live. Resolves once a non-200 response is proxied or the cache file has been
 * written and atomically renamed into place; rejects on upstream/write errors.
 */
function downloadTarball(
  client: http2.ClientHttp2Session,
  headers: Record<string, string>,
  packagePaths: ReturnType<typeof getPackagePaths>,
  leaderRes: http.ServerResponse,
): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const proxyReq = client.request(headers);

    proxyReq.on("response", async (h) => {
      const status = h[":status"] || 500;
      const responseHeaders = { ...h };
      delete responseHeaders[":status"];

      if (status !== 200) {
        leaderRes.writeHead(status, responseHeaders);
        proxyReq.pipe(leaderRes);
        // Not cacheable, but the request itself succeeded end-to-end.
        proxyReq.on("end", () => resolve());
        return;
      }

      await ensureDirectory(packagePaths.dir);
      leaderRes.writeHead(status, responseHeaders);

      const tempFile = `${packagePaths.tarball}.${randomID()}.tmp`;
      const fileStream = fs.createWriteStream(tempFile);
      const tee = new PassThrough();
      proxyReq.pipe(tee);
      tee.pipe(fileStream);
      tee.pipe(leaderRes);

      fileStream.on("finish", () => {
        fs.rename(tempFile, packagePaths.tarball!, (err) => {
          if (err) {
            fs.unlink(tempFile, () => {});
            reject(err);
          } else {
            resolve();
          }
        });
      });
      fileStream.on("error", (err) => {
        fs.unlink(tempFile, () => {});
        reject(err);
      });
    });

    proxyReq.on("error", (err) => {
      if (!leaderRes.headersSent) leaderRes.writeHead(502);
      leaderRes.end();
      reject(err);
    });

    proxyReq.end();
  });
}

export async function handleTarball(
  client: http2.ClientHttp2Session,
  headers: Record<string, string>,
  packagePaths: ReturnType<typeof getPackagePaths>,
  res: http.ServerResponse,
) {
  const tarballPath = packagePaths.tarball!;

  if (await isPathExist(tarballPath)) {
    serveTarballFromCache(tarballPath, res);
    return;
  }

  // If another request is already downloading this exact tarball, wait for it
  // and serve the finished cache file instead of hitting upstream again.
  const existing = tarballDownloads.peek(tarballPath);
  if (existing) {
    try {
      await existing;
      if (await isPathExist(tarballPath)) {
        serveTarballFromCache(tarballPath, res);
        return;
      }
    } catch {
      // Leader failed; fall through and attempt the download ourselves.
    }
  }

  const { promise, leader } = tarballDownloads.run(tarballPath, () =>
    downloadTarball(client, headers, packagePaths, res),
  );

  // A follower that raced past the peek() check above: don't tee to it here
  // (the leader owns `res` only when we are the leader). Wait, then serve cache.
  if (!leader) {
    try {
      await promise;
      if (await isPathExist(tarballPath)) {
        serveTarballFromCache(tarballPath, res);
        return;
      }
    } catch {
      // ignore
    }
    if (!res.headersSent) res.writeHead(502);
    res.end();
    return;
  }

  // Leader: the download streams live to `res`; surface unexpected failures.
  promise.catch((err) => {
    console.error(err);
    if (!res.headersSent) res.writeHead(502);
    if (!res.writableEnded) res.end();
  });
}

/**
 * Serves the cached package metadata to a downstream client, honouring the
 * client's own `If-None-Match`. If `clientETag` matches the ETag we hold, the
 * client's copy is current and we reply `304 Not Modified`; otherwise we send
 * `200` with the cached body and an `ETag` header so the client can revalidate
 * next time.
 */
export function serveCachedPackageJSON(
  packagePaths: ReturnType<typeof getPackagePaths>,
  res: http.ServerResponse,
  etag: string | undefined,
  clientETag: string | undefined,
) {
  if (etag && clientETag === etag) {
    res.writeHead(304, { etag });
    res.end();
    return;
  }

  const responseHeaders: Record<string, string> = {
    "content-type": "application/json",
  };
  if (etag) responseHeaders.etag = etag;

  const stream = fs.createReadStream(packagePaths.packageJSON);
  res.writeHead(200, responseHeaders);
  stream.pipe(res);
  stream.on("error", () => {
    if (!res.headersSent) res.writeHead(502);
    res.end();
  });
}

export function handlePackageJSON(
  client: http2.ClientHttp2Session,
  headers: Record<string, string>,
  packagePaths: ReturnType<typeof getPackagePaths>,
  parsedRequest: ReturnType<typeof parseRequest>,
  serverUrl: string,
  port: number,
  res: http.ServerResponse,
  cachedEtag: string | undefined,
  clientETag: string | undefined,
  registryUrl: string,
) {
  const proxyReq = client.request(headers);

  proxyReq.on("response", async (h) => {
    const status = h[":status"] || 500;

    if (status === 304) {
      // Cache is still fresh upstream; serve it, honouring the client's ETag.
      serveCachedPackageJSON(packagePaths, res, cachedEtag, clientETag);
      return;
    }

    if (status !== 200) {
      res.writeHead(status >= 500 ? 502 : status);
      res.end();
      return;
    }

    const responseHeaders = { ...h };
    delete responseHeaders[":status"];
    delete responseHeaders["content-length"];
    delete responseHeaders["Content-Length"];
    // Prefer the upstream ETag; if upstream sent none we derive one from a
    // hash of the stored content so downstream revalidation still works.
    const upstreamEtag =
      typeof responseHeaders.etag === "string" ? responseHeaders.etag : undefined;
    res.writeHead(200, responseHeaders);

    // Ensure the cache directory exists before writing, otherwise the write
    // silently fails with ENOENT and the metadata is never cached.
    await ensureDirectory(packagePaths.dir);

    const tempFile = `${packagePaths.packageJSON}.${randomID()}.tmp`;
    const fileStream = fs.createWriteStream(tempFile);
    const transform = new StreamingReplaceURLTransform(
      parsedRequest.pkgName,
      serverUrl,
    );
    const tee = new PassThrough();
    const hasher = crypto.createHash("sha256");
    tee.on("data", (chunk) => hasher.update(chunk));
    pipeline(proxyReq, transform, tee, (err) => {
      if (err) console.error(err);
    });
    tee.pipe(fileStream);
    tee.pipe(res);

    fileStream.on("finish", async () => {
      // Fall back to a content hash when upstream doesn't supply an ETag, so
      // the metadata always carries one for future 304 revalidation.
      const etag = upstreamEtag ?? `"${hasher.digest("hex")}"`;
      try {
        await fs.promises.rename(tempFile, packagePaths.packageJSON);
        await writePackageMeta(packagePaths.packageMetaData, {
          url: `http://localhost:${port}`,
          registryUrl,
          etag,
        });
      } catch {
        fs.unlink(tempFile, () => {});
      }
    });

    fileStream.on("error", () => {
      fs.unlink(tempFile, () => {});
    });
  });

  proxyReq.on("error", (err) => {
    console.error(err);
    if (!res.headersSent) {
      res.writeHead(502);
    }
    res.end();
  });

  proxyReq.end();
}
