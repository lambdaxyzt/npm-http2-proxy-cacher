import http from "node:http";
import fs from "node:fs";
import { connectViaSocks } from "@src/lib/h2Connection";
import { handleTarball, handlePackageJSON } from "@src/lib/proxyHandlers";
import { parseRequest } from "@src/lib/parseRequest";
import { getPackagePaths } from "@src/lib/getPackagePaths";
import { isPathExist } from "@src/util";
import {
  TARGET,
  PORT,
  SERVER_URL,
  BASE_PATH,
  SKIP_304_CHECK,
  SOCKS_PROXY,
} from "@src/config";

const client = await connectViaSocks(TARGET, SOCKS_PROXY);

const server = http.createServer(async (req, res) => {
  console.log(`incoming request`, req.url);
  if (req.method !== "GET" || !req.url) {
    res.writeHead(405);
    res.end();
    return;
  }

  const upstreamPath = BASE_PATH + req.url;
  const parsedRequest = parseRequest(req.url);
  const packagePaths = getPackagePaths(parsedRequest);

  const headers: Record<string, string> = {
    ":method": "GET",
    ":path": upstreamPath,
  };

  if (packagePaths.tarball) {
    await handleTarball(client, headers, packagePaths, res);
    return;
  }

  const hasCache =
    (await isPathExist(packagePaths.packageJSON)) &&
    (await isPathExist(packagePaths.packageMetaData));

  if (hasCache && SKIP_304_CHECK) {
    const stream = fs.createReadStream(packagePaths.packageJSON);
    res.writeHead(200, { "content-type": "application/json" });
    stream.pipe(res);
    return;
  }

  if (hasCache) {
    const data = JSON.parse(
      await fs.promises.readFile(packagePaths.packageMetaData, "utf-8"),
    );
    if (data.etag) {
      headers["If-None-Match"] = data.etag;
    }
  }

  handlePackageJSON(client, headers, packagePaths, parsedRequest, SERVER_URL, PORT, res);
});

server.listen(PORT, "0.0.0.0", () => {
  console.log(`proxy listening on :${PORT}`);
});

function shutdown(signal: string) {
  console.log(`received ${signal}, shutting down`);
  server.close(() => {
    if (!client.destroyed) client.close();
    process.exit(0);
  });
}

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
