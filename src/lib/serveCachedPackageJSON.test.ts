import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Writable } from "node:stream";
import type http from "node:http";
import { serveCachedPackageJSON } from "@src/lib/proxyHandlers";

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
  await fs.promises.rm(dir, { recursive: true, force: true });
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
