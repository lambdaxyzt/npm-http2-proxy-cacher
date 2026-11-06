import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import zlib from "node:zlib";
import { vi } from "vitest";
import { Writable } from "node:stream";
import type http from "node:http";
import { gzipLegacyCache, serveCachedPackageJSON } from "@src/lib/proxyHandlers";
import { readPackageMeta } from "@src/lib/packageMeta";

describe("gzipLegacyCache", () => {
  let dir: string;
  let plain: string;
  let gzip: string;

  beforeEach(async () => {
    dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "legacycache-"));
    plain = path.join(dir, "package.json");
    gzip = `${plain}.gzip`;
  });

  afterEach(async () => {
    await fs.promises.rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 20 });
  });

  it("converts a plain file once, even for concurrent requests", async () => {
    await fs.promises.writeFile(plain, '{"name":"pkg"}');

    await Promise.all([gzipLegacyCache(gzip), gzipLegacyCache(gzip), gzipLegacyCache(gzip)]);

    expect(zlib.gunzipSync(await fs.promises.readFile(gzip)).toString()).toBe('{"name":"pkg"}');
    expect(await fs.promises.readdir(dir)).toEqual(["package.json.gzip"]);
  });

  it("fixes stale links in a converted file, in the response and on disk", async () => {
    const OLD = "http://localhost:3859";
    const NEW = "http://localhost:3859/npm";
    const meta = path.join(dir, "package.meta.json");
    await fs.promises.writeFile(plain, `{"tarball":"${OLD}/pkg/-/pkg-1.0.0.tgz"}`);
    await fs.promises.writeFile(meta, JSON.stringify({ url: OLD, etags: { r: '"e"' } }));

    await gzipLegacyCache(gzip);

    const chunks: Buffer[] = [];
    const res = new Writable({
      write(chunk, _encoding, callback) {
        chunks.push(Buffer.from(chunk));
        callback();
      },
    }) as unknown as http.ServerResponse;
    res.writeHead = (() => res) as never;
    const paths = { dir, packageJSON: gzip, packageMetaData: meta, tarball: null };
    serveCachedPackageJSON(paths, res, '"e"', undefined, OLD, NEW);
    await new Promise((resolve) => res.on("finish", resolve));

    const fixed = `{"tarball":"${NEW}/pkg/-/pkg-1.0.0.tgz"}`;
    expect(Buffer.concat(chunks).toString()).toBe(fixed);

    // The fixed copy lands on disk after the response, so wait for meta.url.
    await vi.waitFor(async () => expect((await readPackageMeta(meta))?.url).toBe(NEW), {
      timeout: 3000,
      interval: 50,
    });
    expect(zlib.gunzipSync(await fs.promises.readFile(gzip)).toString()).toBe(fixed);
    expect((await readPackageMeta(meta))?.etags).toEqual({ r: '"e"' });
  });

  it("leaves an existing gzip file alone", async () => {
    await fs.promises.writeFile(plain, "old");
    await fs.promises.writeFile(gzip, zlib.gzipSync("new"));

    await gzipLegacyCache(gzip);

    expect(zlib.gunzipSync(await fs.promises.readFile(gzip)).toString()).toBe("new");
  });

  it("does nothing when there is no cache", async () => {
    await gzipLegacyCache(gzip);

    expect(await fs.promises.readdir(dir)).toEqual([]);
  });
});
