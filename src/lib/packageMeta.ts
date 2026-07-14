import fs from "node:fs";

/**
 * On-disk shape of `package.meta.json`. ETags are kept in a map keyed by the
 * upstream registry URL so the same cached package can track a distinct ETag
 * per registry it was (re)validated against.
 */
export type PackageMeta = {
  /**
   * The proxy URL that tarball links in the cached package.json were rewritten
   * to (i.e. the `SERVER_URL` in effect when it was cached). If `SERVER_URL`
   * later changes, this lets us rewrite the stale host to the current one when
   * serving from cache.
   */
  url?: string;
  /** ETag per upstream registry URL, e.g. `{ "https://registry.npmjs.org": "\"abc\"" }`. */
  etags?: Record<string, string>;
  /** Legacy single ETag, read for backward compatibility with older caches. */
  etag?: string;
};

/** Reads and parses the metadata file, or returns null if missing/corrupt. */
export async function readPackageMeta(
  metaPath: string,
): Promise<PackageMeta | null> {
  try {
    const raw = await fs.promises.readFile(metaPath, "utf-8");
    const data = JSON.parse(raw);
    return data && typeof data === "object" ? (data as PackageMeta) : null;
  } catch {
    return null;
  }
}

/**
 * Returns the proxy URL the cached package.json's tarball links were rewritten
 * to, or undefined for legacy caches that didn't record it.
 */
export function getRewriteUrl(meta: PackageMeta | null): string | undefined {
  return meta && typeof meta.url === "string" ? meta.url : undefined;
}

/** Returns the cached ETag for a given upstream registry, if any. */
export function getEtagForRegistry(
  meta: PackageMeta | null,
  registryUrl: string,
): string | undefined {
  if (!meta) return undefined;
  const perRegistry = meta.etags?.[registryUrl];
  if (typeof perRegistry === "string") return perRegistry;
  // Fall back to the legacy single-ETag field written by older versions.
  return typeof meta.etag === "string" ? meta.etag : undefined;
}

/**
 * Persists the ETag for `registryUrl`, preserving ETags already stored for
 * other registries and dropping the legacy single-ETag field.
 */
export async function writePackageMeta(
  metaPath: string,
  {
    url,
    registryUrl,
    etag,
  }: { url: string; registryUrl: string; etag: string },
): Promise<void> {
  const existing = await readPackageMeta(metaPath);
  const etags = { ...(existing?.etags ?? {}), [registryUrl]: etag };
  await fs.promises.writeFile(
    metaPath,
    JSON.stringify({ url, etags }),
    "utf-8",
  );
}

/**
 * Updates only the rewrite `url`, preserving any per-registry ETags. Used after
 * a cached package.json is fixed up on disk for a new SERVER_URL so subsequent
 * serves match and skip the rewrite.
 */
export async function updatePackageMetaUrl(
  metaPath: string,
  url: string,
): Promise<void> {
  const existing = await readPackageMeta(metaPath);
  const etags = existing?.etags ?? {};
  await fs.promises.writeFile(
    metaPath,
    JSON.stringify({ url, etags }),
    "utf-8",
  );
}
