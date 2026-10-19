import http from "node:http";
import { H2ConnectionManager } from "@src/lib/h2ConnectionManager";
import {
  handleTarball,
  handlePackageJSON,
  serveCachedPackageJSON,
} from "@src/lib/proxyHandlers";
import { parseRequest } from "@src/lib/parseRequest";
import { getPackagePaths, STORAGE } from "@src/lib/getPackagePaths";
import { cleanupTempFiles } from "@src/lib/cleanupTempFiles";
import {
  readPackageMeta,
  getEtagForRegistry,
  getRewriteUrl,
} from "@src/lib/packageMeta";
import { isPathExist } from "@src/util";
import {
  TARGET,
  PORT,
  SERVER_URL,
  BASE_PATH,
  SKIP_304_CHECK,
  SOCKS_PROXY,
  PING_INTERVAL_MS,
} from "@src/config";

// Reap partial cache writes orphaned by a previous hard crash before serving.
const removedTempFiles = await cleanupTempFiles(STORAGE);
if (removedTempFiles > 0) {
  console.log(`removed ${removedTempFiles} orphaned .tmp file(s) from ${STORAGE}`);
}

const connection = new H2ConnectionManager(TARGET, SOCKS_PROXY, {
  pingIntervalMs: PING_INTERVAL_MS,
});
// Fail fast at startup if the upstream is unreachable.
await connection.getSession();

const server = http.createServer(async (req, res) => {
  console.log(`incoming request`, req.url);
  if (req.method !== "GET" || !req.url) {
    res.writeHead(405);
    res.end();
    return;
  }

  const parsedRequest = parseRequest(req.url);
  if (!parsedRequest.pkgName) {
    res.writeHead(404);
    res.end();
    return;
  }

  const upstreamPath = BASE_PATH + req.url;
  const packagePaths = getPackagePaths(parsedRequest);

  const headers: Record<string, string> = {
    ":method": "GET",
    ":path": upstreamPath,
  };

  try {
    if (packagePaths.tarball) {
      await handleTarball(connection, headers, packagePaths, res);
      return;
    }

    const hasCache =
      (await isPathExist(packagePaths.packageJSON)) &&
      (await isPathExist(packagePaths.packageMetaData));

    // ETag the downstream client already holds, if any.
    const clientETag =
      typeof req.headers["if-none-match"] === "string"
        ? req.headers["if-none-match"]
        : undefined;

    // ETag we cached from this upstream registry. May be missing on older
    // metadata files that were written before ETags were persisted per registry.
    const meta = hasCache
      ? await readPackageMeta(packagePaths.packageMetaData)
      : null;
    const cachedEtag = getEtagForRegistry(meta, TARGET);
    // Proxy URL the cached tarball links were rewritten to; if SERVER_URL has
    // since changed, the stale host is fixed up when serving from cache.
    const storedUrl = getRewriteUrl(meta);

    // Serve straight from cache without revalidating — but only when we actually
    // have an ETag to hand out. If it's missing we fall through to re-fetch and
    // populate it.
    if (hasCache && SKIP_304_CHECK && cachedEtag) {
      serveCachedPackageJSON(
        packagePaths,
        res,
        cachedEtag,
        clientETag,
        storedUrl,
        SERVER_URL,
      );
      return;
    }

    // Only revalidate with an ETag we actually hold; without one we want a full
    // 200 so we can capture and persist the ETag.
    if (cachedEtag) {
      headers["If-None-Match"] = cachedEtag;
    }

    // Handlers resolve the upstream session only when they actually issue a
    // request, so a session torn down while we awaited above is never used.
    await handlePackageJSON(
      connection,
      headers,
      packagePaths,
      parsedRequest,
      SERVER_URL,
      PORT,
      res,
      cachedEtag,
      clientETag,
      TARGET,
      storedUrl,
    );
  } catch (err) {
    console.error(err);
    if (!res.headersSent) res.writeHead(502);
    if (!res.writableEnded) res.end();
  }
});

server.listen(PORT, "0.0.0.0", () => {
  console.log(`proxy listening on :${PORT}`);
});

function shutdown(signal: string) {
  console.log(`received ${signal}, shutting down`);
  server.close(() => {
    connection.close();
    process.exit(0);
  });
}

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
