import http from "node:http";
import fs from "node:fs";
import crypto from "node:crypto";
import { PassThrough, pipeline } from "node:stream";
import {
  StreamingReplaceURLTransform,
  StreamingReplaceTransform,
} from "@src/lib/replaceDomainJSONFile/index";
import { ensureDirectory, isPathExist, randomID } from "@src/util";
import { getPackagePaths } from "@src/lib/getPackagePaths";
import {
  writePackageMeta,
  updatePackageMetaUrl,
  readPackageMeta,
  getEtagForRegistry,
  getRewriteUrl,
} from "@src/lib/packageMeta";
import { SingleFlight } from "@src/lib/singleFlight";
import type { parseRequest } from "@src/lib/parseRequest";
import type { H2ConnectionManager } from "@src/lib/h2ConnectionManager";

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
async function downloadTarball(
  upstream: H2ConnectionManager,
  headers: Record<string, string>,
  packagePaths: ReturnType<typeof getPackagePaths>,
  leaderRes: http.ServerResponse,
): Promise<void> {
  const proxyReq = await upstream.request(headers);

  return new Promise<void>((resolve, reject) => {

    // Hoisted so the upstream `error` handler can tear down an in-progress
    // write, even if the failure arrives after the temp file was opened.
    let tempFile: string | undefined;
    let fileStream: fs.WriteStream | undefined;

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

      tempFile = `${packagePaths.tarball}.${randomID()}.tmp`;
      fileStream = fs.createWriteStream(tempFile);
      const currentTempFile = tempFile;
      const tee = new PassThrough();
      proxyReq.pipe(tee);
      tee.pipe(fileStream);
      tee.pipe(leaderRes);

      fileStream.on("finish", () => {
        fs.rename(currentTempFile, packagePaths.tarball!, (err) => {
          if (err) {
            fs.unlink(currentTempFile, () => {});
            reject(err);
          } else {
            resolve();
          }
        });
      });
      fileStream.on("error", (err) => {
        fs.unlink(currentTempFile, () => {});
        reject(err);
      });
    });

    proxyReq.on("error", (err) => {
      // `.pipe()` does not forward source errors to the write stream, so on an
      // upstream failure the temp file would otherwise be left orphaned on disk.
      if (fileStream) fileStream.destroy();
      if (tempFile) fs.unlink(tempFile, () => {});
      if (!leaderRes.headersSent) leaderRes.writeHead(502);
      leaderRes.end();
      reject(err);
    });

    proxyReq.end();
  });
}

export async function handleTarball(
  upstream: H2ConnectionManager,
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
    downloadTarball(upstream, headers, packagePaths, res),
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
 *
 * When `storedUrl` (the proxy URL the file's tarball links were rewritten to)
 * differs from `currentUrl` (the proxy URL now in effect) — e.g. `SERVER_URL`
 * changed since caching — the stale host is rewritten to the current one as the
 * body streams out, so downstream tarball URLs always point at this proxy. The
 * fixed content is also persisted back to the cache (and `meta.url` updated) so
 * subsequent serves match and skip the rewrite.
 */
export function serveCachedPackageJSON(
  packagePaths: ReturnType<typeof getPackagePaths>,
  res: http.ServerResponse,
  etag: string | undefined,
  clientETag: string | undefined,
  storedUrl?: string,
  currentUrl?: string,
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
  stream.on("error", () => {
    if (!res.headersSent) res.writeHead(502);
    res.end();
  });
  res.writeHead(200, responseHeaders);

  if (!(storedUrl && currentUrl && storedUrl !== currentUrl)) {
    stream.pipe(res);
    return;
  }

  // Rewrite the stale proxy host in tarball links to the current one, fanning
  // the fixed bytes out to the client and, in parallel, back to disk.
  const rewrite = new StreamingReplaceTransform(storedUrl, currentUrl);
  const tee = new PassThrough();
  pipeline(stream, rewrite, tee, (err) => {
    if (err) console.error(err);
  });
  tee.pipe(res);

  // Persist the fixed content atomically. Best-effort: failures here must not
  // affect the response, which streams from the same `tee`.
  const tempFile = `${packagePaths.packageJSON}.${randomID()}.tmp`;
  const fileStream = fs.createWriteStream(tempFile);
  tee.pipe(fileStream);
  fileStream.on("finish", async () => {
    try {
      await fs.promises.rename(tempFile, packagePaths.packageJSON);
      await updatePackageMetaUrl(packagePaths.packageMetaData, currentUrl);
    } catch (err) {
      console.error(err);
      fs.unlink(tempFile, () => {});
    }
  });
  fileStream.on("error", (err) => {
    console.error(err);
    fs.unlink(tempFile, () => {});
  });
}

/**
 * Outcome of one upstream metadata fetch, shared with every request that was
 * coalesced onto it. `cached` means the cache file now holds current metadata
 * (upstream answered 200 and we stored it, or 304 and ours was still fresh);
 * otherwise `status` is the code to pass on (404 for an unknown package, ...).
 */
type PackageJSONOutcome = { cached: true } | { cached: false; status: number };

/**
 * Coalesces concurrent metadata fetches for the same package, keyed by its
 * cache path, so a burst of installs resolving the same dependency makes one
 * upstream request and one cache write instead of one per client.
 */
const packageJSONFetches = new SingleFlight<PackageJSONOutcome>();

/**
 * Fetches package metadata from upstream, streaming it live to `leaderRes`
 * while rewriting tarball links and writing the cache. Resolves once the
 * outcome is final: for a 200, only after the cache file and its metadata are
 * on disk, so coalesced followers can serve from it. Rejects on upstream or
 * write errors.
 */
async function fetchPackageJSON(
  upstream: H2ConnectionManager,
  headers: Record<string, string>,
  packagePaths: ReturnType<typeof getPackagePaths>,
  parsedRequest: ReturnType<typeof parseRequest>,
  serverUrl: string,
  leaderRes: http.ServerResponse,
  cachedEtag: string | undefined,
  clientETag: string | undefined,
  registryUrl: string,
  storedUrl: string | undefined,
): Promise<PackageJSONOutcome> {
  const proxyReq = await upstream.request(headers);

  return new Promise<PackageJSONOutcome>((resolve, reject) => {
    // Hoisted so the upstream `error` handler can clean up an in-progress write.
    let tempFile: string | undefined;
    let fileStream: fs.WriteStream | undefined;

    proxyReq.on("response", async (h) => {
      const status = h[":status"] || 500;

      if (status === 304) {
        // Cache is still fresh upstream; serve it, honouring the client's ETag
        // and rewriting a stale proxy host if SERVER_URL changed since caching.
        serveCachedPackageJSON(
          packagePaths,
          leaderRes,
          cachedEtag,
          clientETag,
          storedUrl,
          serverUrl,
        );
        resolve({ cached: true });
        return;
      }

      if (status !== 200) {
        const passStatus = status >= 500 ? 502 : status;
        leaderRes.writeHead(passStatus);
        leaderRes.end();
        // Drain so the stream is released instead of sitting on flow control.
        proxyReq.resume();
        resolve({ cached: false, status: passStatus });
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
      leaderRes.writeHead(200, responseHeaders);

      // Ensure the cache directory exists before writing, otherwise the write
      // silently fails with ENOENT and the metadata is never cached.
      await ensureDirectory(packagePaths.dir);

      tempFile = `${packagePaths.packageJSON}.${randomID()}.tmp`;
      fileStream = fs.createWriteStream(tempFile);
      const currentTempFile = tempFile;
      const transform = new StreamingReplaceURLTransform(
        parsedRequest.pkgName,
        serverUrl,
      );
      const tee = new PassThrough();
      const hasher = crypto.createHash("sha256");
      tee.on("data", (chunk) => hasher.update(chunk));
      pipeline(proxyReq, transform, tee, (err) => {
        if (err) {
          // The pipeline error does not reach `fileStream` through `.pipe()`, so
          // tear it down explicitly to avoid leaving an orphaned temp file.
          if (fileStream) fileStream.destroy();
          fs.unlink(currentTempFile, () => {});
          if (!leaderRes.writableEnded) leaderRes.end();
          reject(err);
        }
      });
      tee.pipe(fileStream);
      tee.pipe(leaderRes);

      fileStream.on("finish", async () => {
        // Fall back to a content hash when upstream doesn't supply an ETag, so
        // the metadata always carries one for future 304 revalidation.
        const etag = upstreamEtag ?? `"${hasher.digest("hex")}"`;
        try {
          await fs.promises.rename(currentTempFile, packagePaths.packageJSON);
          await writePackageMeta(packagePaths.packageMetaData, {
            // Record the URL the tarball links were actually rewritten to, so a
            // later SERVER_URL change can be detected and fixed up on serve.
            url: serverUrl,
            registryUrl,
            etag,
          });
          resolve({ cached: true });
        } catch (err) {
          fs.unlink(currentTempFile, () => {});
          reject(err);
        }
      });

      fileStream.on("error", (err) => {
        fs.unlink(currentTempFile, () => {});
        reject(err);
      });
    });

    proxyReq.on("error", (err) => {
      // Clean up a partially written temp file if the failure lands after the
      // response started streaming to disk.
      if (fileStream) fileStream.destroy();
      if (tempFile) fs.unlink(tempFile, () => {});
      if (!leaderRes.headersSent) leaderRes.writeHead(502);
      leaderRes.end();
      reject(err);
    });

    proxyReq.end();
  });
}

export async function handlePackageJSON(
  upstream: H2ConnectionManager,
  headers: Record<string, string>,
  packagePaths: ReturnType<typeof getPackagePaths>,
  parsedRequest: ReturnType<typeof parseRequest>,
  serverUrl: string,
  port: number,
  res: http.ServerResponse,
  cachedEtag: string | undefined,
  clientETag: string | undefined,
  registryUrl: string,
  storedUrl: string | undefined,
) {
  const { promise, leader } = packageJSONFetches.run(
    packagePaths.packageJSON,
    () =>
      fetchPackageJSON(
        upstream,
        headers,
        packagePaths,
        parsedRequest,
        serverUrl,
        res,
        cachedEtag,
        clientETag,
        registryUrl,
        storedUrl,
      ),
  );

  if (leader) {
    // The leader's response streams live from upstream; surface failures only.
    try {
      await promise;
    } catch (err) {
      console.error(err);
      if (!res.headersSent) res.writeHead(502);
      if (!res.writableEnded) res.end();
    }
    return;
  }

  // Follower: wait for the leader's fetch, then answer from what it produced.
  let outcome: PackageJSONOutcome;
  try {
    outcome = await promise;
  } catch {
    res.writeHead(502);
    res.end();
    return;
  }

  if (!outcome.cached) {
    res.writeHead(outcome.status);
    res.end();
    return;
  }

  // Re-read the metadata the leader just wrote: the ETag and rewrite URL may
  // differ from what this request saw before it was coalesced.
  const meta = await readPackageMeta(packagePaths.packageMetaData);
  serveCachedPackageJSON(
    packagePaths,
    res,
    getEtagForRegistry(meta, registryUrl),
    clientETag,
    getRewriteUrl(meta),
    serverUrl,
  );
}
