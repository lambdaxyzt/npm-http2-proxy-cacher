import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Writable } from "node:stream";
import type http from "node:http";
import { serveCachedPackageJSON } from "@src/lib/proxyHandlers";
import { readPackageMeta } from "@src/lib/packageMeta";

/** Polls `fn` until it returns truthy or the timeout elapses. */
async function waitFor<T>(fn: () => Promise<T> | T, ms = 1000): Promise<T> {
  const deadline = Date.now() + ms;
  for (;;) {
    const value = await fn();
    if (value) return value;
    if (Date.now() > deadline) throw new Error("waitFor timed out");
    await new Promise((r) => setTimeout(r, 10));
  }
}

/**
 * Minimal ServerResponse stand-in: a Writable that records the status/headers
 * from writeHead and buffers the body so we can assert on what was served.
 */
class MockRes extends Writable {
  statusCode = 0;
  headers: Record<string, unknown> = {};
  headersSent = false;
  private chunks: Buffer[] = [];
  private done!: () => void;
  finished = new Promise<void>((resolve) => (this.done = resolve));

  writeHead(status: number, headers?: Record<string, unknown>) {
    this.statusCode = status;
    if (headers) this.headers = headers;
    this.headersSent = true;
    return this;
  }

  get body() {
    return Buffer.concat(this.chunks).toString("utf-8");
  }

  _write(chunk: Buffer, _enc: BufferEncoding, cb: () => void) {
    this.chunks.push(Buffer.from(chunk));
    cb();
  }

  end(chunk?: Buffer) {
    if (chunk) this.chunks.push(Buffer.from(chunk));
    super.end();
    this.done();
    return this;
  }
}

function makePaths(dir: string) {
  return {
    dir,
    packageJSON: path.join(dir, "package.json"),
    packageMetaData: path.join(dir, "package.meta.json"),
    tarball: null,
  };
}

let dir: string;
const ETAG = '"abc123"';
const CACHED_BODY = JSON.stringify({ name: "pkg", versions: {} });

beforeEach(async () => {
  dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "servecache-"));
  await fs.promises.writeFile(path.join(dir, "package.json"), CACHED_BODY);
});

afterEach(async () => {
  // maxRetries rides out the brief window where the background disk-persist
  // (from the SERVER_URL fix-up) still holds a handle on Windows.
  await fs.promises.rm(dir, {
    recursive: true,
    force: true,
    maxRetries: 10,
    retryDelay: 20,
  });
});

describe("serveCachedPackageJSON (downstream 304)", () => {
  it("returns 304 with the ETag when the client's If-None-Match matches", async () => {
    const res = new MockRes();
    serveCachedPackageJSON(
      makePaths(dir),
      res as unknown as http.ServerResponse,
      ETAG,
      ETAG,
    );
    await res.finished;

    expect(res.statusCode).toBe(304);
    expect(res.headers.etag).toBe(ETAG);
    expect(res.body).toBe("");
  });

  it("returns 200 with the body and ETag when the client's ETag differs", async () => {
    const res = new MockRes();
    serveCachedPackageJSON(
      makePaths(dir),
      res as unknown as http.ServerResponse,
      ETAG,
      '"stale"',
    );
    await res.finished;

    expect(res.statusCode).toBe(200);
    expect(res.headers.etag).toBe(ETAG);
    expect(res.headers["content-type"]).toBe("application/json");
    expect(res.body).toBe(CACHED_BODY);
  });

  it("returns 200 with the body when the client sends no ETag", async () => {
    const res = new MockRes();
    serveCachedPackageJSON(
      makePaths(dir),
      res as unknown as http.ServerResponse,
      ETAG,
      undefined,
    );
    await res.finished;

    expect(res.statusCode).toBe(200);
    expect(res.headers.etag).toBe(ETAG);
    expect(res.body).toBe(CACHED_BODY);
  });

  it("does not send an ETag header when none is cached", async () => {
    const res = new MockRes();
    serveCachedPackageJSON(
      makePaths(dir),
      res as unknown as http.ServerResponse,
      undefined,
      '"whatever"',
    );
    await res.finished;

    expect(res.statusCode).toBe(200);
    expect(res.headers.etag).toBeUndefined();
    expect(res.body).toBe(CACHED_BODY);
  });
});

describe("serveCachedPackageJSON (SERVER_URL fix-up)", () => {
  const OLD = "http://old-host:3000";
  const NEW = "http://new-host:8080";
  const TARBALL_BODY = JSON.stringify({
    dist: { tarball: `${OLD}/pkg/-/pkg-1.0.0.tgz` },
  });

  beforeEach(async () => {
    await fs.promises.writeFile(path.join(dir, "package.json"), TARBALL_BODY);
  });

  it("rewrites the stale proxy host when the stored URL differs", async () => {
    const res = new MockRes();
    serveCachedPackageJSON(
      makePaths(dir),
      res as unknown as http.ServerResponse,
      ETAG,
      undefined,
      OLD,
      NEW,
    );
    await res.finished;

    expect(res.statusCode).toBe(200);
    expect(res.body).toContain(`${NEW}/pkg/-/pkg-1.0.0.tgz`);
    expect(res.body).not.toContain(OLD);
  });

  it("persists the fixed content and updated meta.url to disk", async () => {
    // Seed an existing meta with an ETag that must survive the url update.
    const metaPath = path.join(dir, "package.meta.json");
    await fs.promises.writeFile(
      metaPath,
      JSON.stringify({ url: OLD, etags: { "https://reg": '"e"' } }),
    );

    const res = new MockRes();
    serveCachedPackageJSON(
      makePaths(dir),
      res as unknown as http.ServerResponse,
      ETAG,
      undefined,
      OLD,
      NEW,
    );
    await res.finished;

    // The on-disk package.json is rewritten...
    const onDisk = await waitFor(async () => {
      const c = await fs.promises.readFile(path.join(dir, "package.json"), "utf-8");
      return c.includes(NEW) ? c : undefined;
    });
    expect(onDisk).not.toContain(OLD);

    // ...and meta.url is updated to the new host, preserving ETags.
    const meta = await waitFor(async () => {
      const m = await readPackageMeta(metaPath);
      return m?.url === NEW ? m : undefined;
    });
    expect(meta.url).toBe(NEW);
    expect(meta.etags?.["https://reg"]).toBe('"e"');
  });

  it("serves the cache untouched when the stored URL still matches", async () => {
    const res = new MockRes();
    serveCachedPackageJSON(
      makePaths(dir),
      res as unknown as http.ServerResponse,
      ETAG,
      undefined,
      OLD,
      OLD,
    );
    await res.finished;

    expect(res.body).toBe(TARBALL_BODY);
  });

  it("serves untouched for legacy caches with no stored URL", async () => {
    const res = new MockRes();
    serveCachedPackageJSON(
      makePaths(dir),
      res as unknown as http.ServerResponse,
      ETAG,
      undefined,
      undefined,
      NEW,
    );
    await res.finished;

    expect(res.body).toBe(TARBALL_BODY);
  });

  it("still returns 304 (no body) even when the stored URL differs", async () => {
    const res = new MockRes();
    serveCachedPackageJSON(
      makePaths(dir),
      res as unknown as http.ServerResponse,
      ETAG,
      ETAG,
      OLD,
      NEW,
    );
    await res.finished;

    expect(res.statusCode).toBe(304);
    expect(res.body).toBe("");
  });
});
