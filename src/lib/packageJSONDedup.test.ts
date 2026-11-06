import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import zlib from "node:zlib";
import { Readable, Writable } from "node:stream";
import type http from "node:http";
import { handlePackageJSON } from "@src/lib/proxyHandlers";
import type { H2ConnectionManager } from "@src/lib/h2ConnectionManager";

/** Stand-in for an HTTP/2 client stream; the test drives the response. */
class FakeUpstreamStream extends Readable {
  _read() {}
  // The handler calls end() to finish the (empty) request body.
  end() {
    return this;
  }
  respond(status: number, headers: Record<string, string>, body?: string | Buffer) {
    this.emit("response", { ":status": status, ...headers });
    if (body) this.push(body);
    this.push(null);
  }
}

/** ServerResponse stand-in that records status, headers and body. */
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

  get raw() {
    return Buffer.concat(this.chunks);
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

const REGISTRY = "https://registry.npmjs.org";
const SERVER_URL = "http://proxy.local";
const ETAG = '"upstream-etag"';
const UPSTREAM_BODY = JSON.stringify({
  name: "pkg",
  versions: {
    "1.0.0": { dist: { tarball: `${REGISTRY}/pkg/-/pkg-1.0.0.tgz` } },
  },
});

let dir: string;

function makePaths() {
  return {
    dir,
    packageJSON: path.join(dir, "package.json"),
    packageMetaData: path.join(dir, "package.meta.json"),
    tarball: null,
  };
}

function fakeUpstream() {
  const streams: FakeUpstreamStream[] = [];
  const request = vi.fn(async () => {
    const s = new FakeUpstreamStream();
    streams.push(s);
    return s;
  });
  const upstream = { request } as unknown as H2ConnectionManager;
  return { upstream, request, streams };
}

function call(
  upstream: H2ConnectionManager,
  res: MockRes,
  clientETag?: string,
  acceptsGzip = false,
) {
  return handlePackageJSON(
    upstream,
    { ":method": "GET", ":path": "/pkg" },
    makePaths(),
    { pkgName: "pkg", tarball: null } as never,
    SERVER_URL,
    4873,
    res as unknown as http.ServerResponse,
    undefined,
    clientETag,
    REGISTRY,
    undefined,
    undefined,
    undefined,
    acceptsGzip,
  );
}

/** Lets the handlers reach `upstream.request()` before the test responds. */
const tick = () => new Promise((r) => setTimeout(r, 0));

beforeEach(async () => {
  dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "pkgdedup-"));
});

afterEach(async () => {
  await fs.promises.rm(dir, {
    recursive: true,
    force: true,
    maxRetries: 10,
    retryDelay: 20,
  });
});

describe("handlePackageJSON gzip", () => {
  const cached = () => zlib.gunzipSync(fs.readFileSync(path.join(dir, "package.json"))).toString();

  it("stores gzip and serves plain to a client without gzip", async () => {
    const { upstream, streams } = fakeUpstream();
    const res = new MockRes();
    const done = call(upstream, res);
    await tick();
    streams[0].respond(200, { etag: ETAG }, UPSTREAM_BODY);
    await done;

    expect(res.body).toContain(`${SERVER_URL}/pkg/-/pkg-1.0.0.tgz`);
    expect(res.headers["content-encoding"]).toBeUndefined();
    expect(cached()).toBe(res.body);
  });

  it("unpacks a gzip upstream to rewrite links and sends gzip to the client", async () => {
    const { upstream, streams } = fakeUpstream();
    const res = new MockRes();
    const done = call(upstream, res, undefined, true);
    await tick();
    streams[0].respond(
      200,
      { etag: ETAG, "content-encoding": "gzip" },
      zlib.gzipSync(UPSTREAM_BODY),
    );
    await done;

    expect(res.headers["content-encoding"]).toBe("gzip");
    const sent = zlib.gunzipSync(res.raw).toString();
    expect(sent).toContain(`${SERVER_URL}/pkg/-/pkg-1.0.0.tgz`);
    expect(cached()).toBe(sent);
  });

  it("still finishes the cache write when the client disconnects", async () => {
    const { upstream, streams } = fakeUpstream();
    const res = new MockRes();
    res.destroy();
    const done = call(upstream, res);
    await tick();
    streams[0].respond(200, { etag: ETAG }, UPSTREAM_BODY);
    await done;

    expect(cached()).toContain(`${SERVER_URL}/pkg/-/pkg-1.0.0.tgz`);
  });

  it.each([true, false])(
    "still finishes the cache write when the client drops mid-download (gzip: %s)",
    async (acceptsGzip) => {
      const { upstream, streams } = fakeUpstream();
      const res = new MockRes();
      const done = call(upstream, res, undefined, acceptsGzip);
      await tick();
      streams[0].emit("response", { ":status": 200, etag: ETAG });
      await new Promise((r) => setTimeout(r, 50));
      res.destroy();
      streams[0].push(UPSTREAM_BODY);
      streams[0].push(null);
      await done;

      expect(cached()).toContain(`${SERVER_URL}/pkg/-/pkg-1.0.0.tgz`);
    },
  );
});

describe("handlePackageJSON concurrent deduplication", () => {
  it("makes one upstream request and serves every concurrent client", async () => {
    const { upstream, request, streams } = fakeUpstream();
    const leaderRes = new MockRes();
    const followerRes = new MockRes();

    const done = Promise.all([
      call(upstream, leaderRes),
      call(upstream, followerRes),
    ]);
    await tick();
    streams[0].respond(200, { etag: ETAG }, UPSTREAM_BODY);
    await done;
    await Promise.all([leaderRes.finished, followerRes.finished]);

    expect(request).toHaveBeenCalledTimes(1);
    expect(leaderRes.statusCode).toBe(200);
    expect(followerRes.statusCode).toBe(200);
    expect(followerRes.body).toBe(leaderRes.body);
    expect(followerRes.body).toContain(SERVER_URL);
    expect(followerRes.headers.etag).toBe(ETAG);
  });

  it("answers a follower that already holds the ETag with 304", async () => {
    const { upstream, streams } = fakeUpstream();
    const leaderRes = new MockRes();
    const followerRes = new MockRes();

    const done = Promise.all([
      call(upstream, leaderRes),
      call(upstream, followerRes, ETAG),
    ]);
    await tick();
    streams[0].respond(200, { etag: ETAG }, UPSTREAM_BODY);
    await done;
    await followerRes.finished;

    expect(followerRes.statusCode).toBe(304);
  });

  it("passes a non-200 upstream status to every follower", async () => {
    const { upstream, request, streams } = fakeUpstream();
    const leaderRes = new MockRes();
    const followerRes = new MockRes();

    const done = Promise.all([
      call(upstream, leaderRes),
      call(upstream, followerRes),
    ]);
    await tick();
    streams[0].respond(404, {});
    await done;

    expect(request).toHaveBeenCalledTimes(1);
    expect(leaderRes.statusCode).toBe(404);
    expect(followerRes.statusCode).toBe(404);
  });

  it("fetches again once the previous fetch has settled", async () => {
    const { upstream, request, streams } = fakeUpstream();

    const first = call(upstream, new MockRes());
    await tick();
    streams[0].respond(404, {});
    await first;

    const second = call(upstream, new MockRes());
    await tick();
    streams[1].respond(404, {});
    await second;

    expect(request).toHaveBeenCalledTimes(2);
  });
});
