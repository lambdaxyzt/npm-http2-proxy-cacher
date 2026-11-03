import http from "node:http";
import { H2ConnectionManager } from "@src/lib/h2ConnectionManager";
import {
  handleTarball,
  handlePackageJSON,
  serveCachedPackageJSON,
} from "@src/lib/proxyHandlers";
import type { Transform } from "node:stream";
import { parseRequest } from "@src/lib/parseRequest";
import { parsePypiRequest, PypiLinkRewriteTransform } from "@src/lib/pypi";
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
  PYPI_UPSTREAM,
  PYPI_FILES_UPSTREAM,
  NPM_PATH,
  PYPI_PATH,
  PYPI_FILE_PATH,
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

const pypiIndex = new H2ConnectionManager(PYPI_UPSTREAM, SOCKS_PROXY, {
  pingIntervalMs: PING_INTERVAL_MS,
});
const pypiFiles = new H2ConnectionManager(PYPI_FILES_UPSTREAM, SOCKS_PROXY, {
  pingIntervalMs: PING_INTERVAL_MS,
});
const PYPI_BASE_PATH = new URL(PYPI_UPSTREAM).pathname.replace(/\/$/, "");
const PYPI_FILES_BASE_PATH = new URL(PYPI_FILES_UPSTREAM).pathname.replace(/\/$/, "");
// Public URLs that rewritten download links point at.
const NPM_PUBLIC_URL = SERVER_URL + NPM_PATH;
const PYPI_FILES_PUBLIC_URL = SERVER_URL + PYPI_FILE_PATH;

/** Returns `url` with `prefix` removed, or null when it isn't under it. */
function stripPrefix(url: string, prefix: string): string | null {
  if (!prefix) return url;
  return url.startsWith(`${prefix}/`) ? url.slice(prefix.length) : null;
}

/**
 * Serves cached metadata (npm package.json or a PyPI index page), revalidating
 * it upstream with the stored ETag unless SKIP_304_CHECK is set.
 */
async function serveMetadata(
  upstream: H2ConnectionManager,
  registryUrl: string,
  headers: Record<string, string>,
  packagePaths: ReturnType<typeof getPackagePaths>,
  parsedRequest: ReturnType<typeof parseRequest>,
  publicUrl: string,
  req: http.IncomingMessage,
  res: http.ServerResponse,
  makeTransform?: () => Transform,
  contentType?: string,
) {
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
  const cachedEtag = getEtagForRegistry(meta, registryUrl);
  // Proxy URL the cached links were rewritten to; if it has since changed
  // (SERVER_URL or the route prefix), the stale one is fixed up on serve.
  // Caches that predate the stored URL were rewritten to the bare SERVER_URL.
  const storedUrl = getRewriteUrl(meta) ?? (hasCache ? SERVER_URL : undefined);

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
      publicUrl,
      contentType,
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
    upstream,
    headers,
    packagePaths,
    parsedRequest,
    publicUrl,
    PORT,
    res,
    cachedEtag,
    clientETag,
    registryUrl,
    storedUrl,
    makeTransform,
    contentType,
  );
}

const server = http.createServer(async (req, res) => {
  console.log(`incoming request`, req.url);
  if (req.method !== "GET" || !req.url) {
    res.writeHead(405);
    res.end();
    return;
  }

  try {
    // Files first: PYTHON_FILE_PATH usually sits under PYTHON_PATH.
    const fileUrl = stripPrefix(req.url, PYPI_FILE_PATH);
    const file = fileUrl === null ? null : parsePypiRequest(`/files${fileUrl}`);
    if (file?.kind === "file") {
      const headers = {
        ":method": "GET",
        ":path": PYPI_FILES_BASE_PATH + file.upstreamPath,
      };
      await handleTarball(pypiFiles, headers, file.paths, res);
      return;
    }
    const pypiUrl = stripPrefix(req.url, PYPI_PATH);
    const pypi = pypiUrl === null ? null : parsePypiRequest(pypiUrl);
    if (pypi?.kind === "index") {
      // Ask for HTML (PEP 503) so the cached format is fixed regardless of
      // which format the client prefers; pip and uv both accept it.
      const upstreamPath = PYPI_BASE_PATH + pypi.upstreamPath;
      const headers: Record<string, string> = {
        ":method": "GET",
        ":path": upstreamPath,
        accept: "text/html",
      };
      const pageUrl = new URL(upstreamPath, PYPI_UPSTREAM).href;
      await serveMetadata(
        pypiIndex,
        PYPI_UPSTREAM,
        headers,
        pypi.paths,
        { pkgName: "", tarball: null },
        PYPI_FILES_PUBLIC_URL,
        req,
        res,
        () =>
          new PypiLinkRewriteTransform(pageUrl, PYPI_FILES_UPSTREAM, PYPI_FILES_PUBLIC_URL),
        "text/html",
      );
      return;
    }

    const npmUrl = stripPrefix(req.url, NPM_PATH);
    const parsedRequest = npmUrl === null ? null : parseRequest(npmUrl);
    if (!parsedRequest?.pkgName) {
      res.writeHead(404);
      res.end();
      return;
    }

    const headers: Record<string, string> = {
      ":method": "GET",
      ":path": BASE_PATH + npmUrl,
    };
    const packagePaths = getPackagePaths(parsedRequest);

    if (packagePaths.tarball) {
      await handleTarball(connection, headers, packagePaths, res);
      return;
    }

    await serveMetadata(
      connection,
      TARGET,
      headers,
      packagePaths,
      parsedRequest,
      NPM_PUBLIC_URL,
      req,
      res,
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
    pypiIndex.close();
    pypiFiles.close();
    process.exit(0);
  });
}

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
