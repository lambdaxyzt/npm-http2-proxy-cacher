import path from "node:path";
import { Transform, type TransformCallback } from "node:stream";
import { StringDecoder } from "node:string_decoder";
import { STORAGE } from "@src/lib/getPackagePaths";
import type { getPackagePaths } from "@src/lib/getPackagePaths";

const ROOT = path.resolve(STORAGE, "python");
const FILES_ROOT = path.resolve(ROOT, "files");

type PypiRequest = {
  kind: "index" | "file";
  /** Path below PYPI_UPSTREAM, e.g. `/simple/requests/`. */
  upstreamPath: string;
  paths: ReturnType<typeof getPackagePaths>;
};

/**
 * Maps `[/simple]/<name>/` (the index pip/uv read, PYTHON_PATH stripped) and
 * `/files/<path>` (wheels and sdists the rewritten index links to) to upstream
 * paths and cache files. Returns null for anything else, including paths
 * escaping the cache.
 */
export function parsePypiRequest(url: string): PypiRequest | null {
  const rawPath = url.split("?")[0];

  // "/simple" is optional: pip may use PYTHON_PATH or PYTHON_PATH/simple as
  // index-url, and a downstream proxy always asks for /simple/<name>/.
  const index = rawPath.match(/^(?:\/simple)?\/([A-Za-z0-9._-]+)\/?$/);
  // Bare "/simple/" is the full package listing, which isn't served.
  if (index && !/^\/simple\/?$/.test(rawPath)) {
    // PEP 503 normalized name, so every spelling shares one cache entry.
    const name = index[1].toLowerCase().replace(/[-_.]+/g, "-");
    const dir = path.resolve(ROOT, "simple", name);
    return {
      kind: "index",
      upstreamPath: `/simple/${name}/`,
      paths: {
        dir,
        packageJSON: path.join(dir, "index.html"),
        packageMetaData: path.join(dir, "index.meta.json"),
        tarball: null,
      },
    };
  }

  const file = rawPath.match(/^\/files\/(.+)$/);
  if (file) {
    let decoded: string;
    try {
      decoded = decodeURIComponent(file[1]);
    } catch {
      return null;
    }
    const filePath = path.resolve(FILES_ROOT, decoded);
    if (!filePath.startsWith(FILES_ROOT + path.sep)) return null;
    return {
      kind: "file",
      upstreamPath: `/${file[1]}`,
      paths: {
        dir: path.dirname(filePath),
        packageJSON: "",
        packageMetaData: "",
        tarball: filePath,
      },
    };
  }

  return null;
}

/**
 * Points every link in an index page that leads into `filesUpstream` at
 * `${filesPublicUrl}/...`. Links are resolved against `pageUrl` first, so
 * absolute links (pypi.org) and relative ones (Nexus, devpi) both work.
 */
export function rewritePypiLinks(
  html: string,
  pageUrl: string,
  filesUpstream: string,
  filesPublicUrl: string,
): string {
  const base = new URL(`${filesUpstream}/`).href;
  return html.replace(/href=(["'])(.*?)\1/g, (match, quote, href) => {
    let resolved: string;
    try {
      resolved = new URL(href, pageUrl).href;
    } catch {
      return match;
    }
    if (!resolved.startsWith(base)) return match;
    return `href=${quote}${filesPublicUrl}/${resolved.slice(base.length)}${quote}`;
  });
}

/**
 * Streaming `rewritePypiLinks`. Links only appear inside tags, so each chunk is
 * rewritten up to its last `<` and only that unfinished tag is held back.
 */
export class PypiLinkRewriteTransform extends Transform {
  private decoder = new StringDecoder("utf8");
  private tail = "";

  constructor(
    private pageUrl: string,
    private filesUpstream: string,
    private filesPublicUrl: string,
  ) {
    super();
  }

  private rewrite(html: string) {
    return rewritePypiLinks(html, this.pageUrl, this.filesUpstream, this.filesPublicUrl);
  }

  _transform(chunk: Buffer, _encoding: BufferEncoding, callback: TransformCallback) {
    const text = this.tail + this.decoder.write(chunk);
    const cut = text.lastIndexOf("<");
    this.tail = cut === -1 ? "" : text.slice(cut);
    callback(null, this.rewrite(cut === -1 ? text : text.slice(0, cut)));
  }

  _flush(callback: TransformCallback) {
    callback(null, this.rewrite(this.tail + this.decoder.end()));
  }
}
