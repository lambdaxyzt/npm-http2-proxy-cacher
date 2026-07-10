import http from "node:http";
import http2 from "node:http2";
import fs from "node:fs";
import { PassThrough, pipeline } from "node:stream";
import { StreamingReplaceURLTransform } from "@src/lib/replaceDomainJSONFile/index";
import { ensureDirectory, isPathExist, randomID } from "@src/util";
import { getPackagePaths } from "@src/lib/getPackagePaths";
import type { parseRequest } from "@src/lib/parseRequest";

export async function handleTarball(
  client: http2.ClientHttp2Session,
  headers: Record<string, string>,
  packagePaths: ReturnType<typeof getPackagePaths>,
  res: http.ServerResponse,
) {
  if (await isPathExist(packagePaths.tarball!)) {
    const stream = fs.createReadStream(packagePaths.tarball!);
    res.writeHead(200, { "content-type": "application/octet-stream" });
    stream.pipe(res);
    return;
  }

  await ensureDirectory(packagePaths.dir);
  const proxyReq = client.request(headers);

  proxyReq.on("response", (h) => {
    const status = h[":status"] || 500;
    const responseHeaders = { ...h };
    delete responseHeaders[":status"];
    res.writeHead(status, responseHeaders);

    if (status === 200) {
      const tempFile = `${packagePaths.tarball}.${randomID()}.tmp`;
      const fileStream = fs.createWriteStream(tempFile);
      const tee = new PassThrough();
      proxyReq.pipe(tee);
      tee.pipe(fileStream);
      tee.pipe(res);

      fileStream.on("finish", () => {
        fs.rename(tempFile, packagePaths.tarball!, (err) => {
          if (err) fs.unlink(tempFile, () => {});
        });
      });
      fileStream.on("error", () => {
        fs.unlink(tempFile, () => {});
      });
    } else {
      proxyReq.pipe(res);
    }
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

export function handlePackageJSON(
  client: http2.ClientHttp2Session,
  headers: Record<string, string>,
  packagePaths: ReturnType<typeof getPackagePaths>,
  parsedRequest: ReturnType<typeof parseRequest>,
  serverUrl: string,
  port: number,
  res: http.ServerResponse,
) {
  const proxyReq = client.request(headers);

  proxyReq.on("response", async (h) => {
    const status = h[":status"] || 500;

    if (status === 304) {
      const stream = fs.createReadStream(packagePaths.packageJSON);
      res.writeHead(200, { "content-type": "application/json" });
      stream.pipe(res);
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
    const etag = responseHeaders.etag;
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
    pipeline(proxyReq, transform, tee, (err) => {
      if (err) console.error(err);
    });
    tee.pipe(fileStream);
    tee.pipe(res);

    fileStream.on("finish", async () => {
      try {
        await fs.promises.rename(tempFile, packagePaths.packageJSON);
        await fs.promises.writeFile(
          packagePaths.packageMetaData,
          JSON.stringify({ url: `http://localhost:${port}`, etag }),
          "utf-8",
        );
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
