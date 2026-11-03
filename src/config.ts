function required(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`${name} env variable is missing`);
  }
  return value;
}

/** Upstream npm registry, e.g. https://registry.npmjs.com (legacy name: UPSTREAM). */
export const TARGET: string =
  process.env.NPM_UPSTREAM || process.env.UPSTREAM || required("NPM_UPSTREAM");

/** Port this proxy listens on. */
export const PORT: number = Number(required("PORT"));

/** Public URL of this proxy, used to rewrite tarball links (e.g. http://localhost:4873). */
export const SERVER_URL: string = required("SERVER_URL");

/** Directory where cached package metadata and tarballs are stored. */
export const STORAGE: string = process.env.STORAGE || "./storage";

/** Path prefix of the upstream registry (derived from NPM_UPSTREAM). */
export const BASE_PATH: string = new URL(TARGET).pathname;

/** When true, serve cached metadata without revalidating against the upstream (304 check). */
export const SKIP_304_CHECK: boolean =
  process.env.SKIP_304_CHECK === "true" || process.env.SKIP_304_CHECK === "1";

/**
 * How often (ms) to PING the upstream HTTP/2 session. A session whose previous
 * PING is still unanswered when the next is due is treated as dead and torn
 * down, so a silently dropped connection is replaced instead of hanging
 * requests. 0 disables the keepalive.
 */
export const PING_INTERVAL_MS: number = Number(
  process.env.PING_INTERVAL_MS ?? 30_000,
);

/**
 * Optional SOCKS5 proxy for the upstream connection. When SOCKS_HOST is unset,
 * the proxy connects directly. Useful for tunnelling around restrictive firewalls.
 */
export const SOCKS_PROXY: { host: string; port: number } | null =
  process.env.SOCKS_HOST
    ? {
        host: process.env.SOCKS_HOST,
        port: Number(process.env.SOCKS_PORT || 1080),
      }
    : null;

/**
 * Upstream PyPI, e.g. https://pypi.org. The proxy requests `/simple/<name>/`
 * below it, so a trailing "/simple" here is dropped rather than doubled.
 */
export const PYPI_UPSTREAM: string = (
  process.env.PYPI_UPSTREAM || "https://pypi.org"
).replace(/\/+$/, "").replace(/\/simple$/, "");

/** Host the PyPI index links package files to; those links are rewritten to this proxy. */
export const PYPI_FILES_UPSTREAM: string = (
  process.env.PYPI_FILES_UPSTREAM || "https://files.pythonhosted.org"
).replace(/\/$/, "");

/** Normalizes a route prefix to "/x" form; "" mounts at the root. */
function routePrefix(value: string | undefined, fallback: string): string {
  const p = (value ?? fallback).replace(/\/+$/, "");
  return p && !p.startsWith("/") ? `/${p}` : p;
}

/** Route prefix npm clients use, e.g. --registry http://host:4873/npm */
export const NPM_PATH: string = routePrefix(process.env.NPM_PATH, "/npm");

/** pip/uv index-url path, e.g. --index-url http://host:4873/pypi */
export const PYPI_PATH: string = routePrefix(process.env.PYTHON_PATH, "/pypi");

/** Route the rewritten index links serve package files (wheels, sdists) from. */
export const PYPI_FILE_PATH = "/pypi/files";
