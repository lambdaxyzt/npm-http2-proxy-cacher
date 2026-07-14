import { describe, it, expect, vi } from "vitest";
import { EventEmitter } from "node:events";
import type http2 from "node:http2";
import { H2ConnectionManager } from "@src/lib/h2ConnectionManager";

/** Minimal stand-in for an HTTP/2 client session. */
class FakeSession extends EventEmitter {
  destroyed = false;
  closed = false;
  close() {
    this.closed = true;
    this.emit("close");
  }
}

function fake() {
  return new FakeSession() as unknown as http2.ClientHttp2Session;
}

describe("H2ConnectionManager", () => {
  it("reuses a live session across calls", async () => {
    const session = fake();
    const connect = vi.fn(async () => session);
    const mgr = new H2ConnectionManager("https://x", null, connect);

    expect(await mgr.getSession()).toBe(session);
    expect(await mgr.getSession()).toBe(session);
    expect(connect).toHaveBeenCalledTimes(1);
  });

  it("reconnects after the session is destroyed", async () => {
    const first = fake();
    const second = fake();
    const connect = vi
      .fn<() => Promise<http2.ClientHttp2Session>>()
      .mockResolvedValueOnce(first)
      .mockResolvedValueOnce(second);
    const mgr = new H2ConnectionManager("https://x", null, connect);

    expect(await mgr.getSession()).toBe(first);
    (first as unknown as FakeSession).destroyed = true;

    expect(await mgr.getSession()).toBe(second);
    expect(connect).toHaveBeenCalledTimes(2);
  });

  it("reconnects after the session closes or sends goaway", async () => {
    const first = fake();
    const second = fake();
    const connect = vi
      .fn<() => Promise<http2.ClientHttp2Session>>()
      .mockResolvedValueOnce(first)
      .mockResolvedValueOnce(second);
    const mgr = new H2ConnectionManager("https://x", null, connect);

    await mgr.getSession();
    // Upstream tears the session down.
    (first as unknown as FakeSession).emit("goaway");

    expect(await mgr.getSession()).toBe(second);
  });

  it("coalesces concurrent connects into a single attempt", async () => {
    const session = fake();
    const connect = vi.fn(async () => {
      await new Promise((r) => setTimeout(r, 10));
      return session;
    });
    const mgr = new H2ConnectionManager("https://x", null, connect);

    const [a, b] = await Promise.all([mgr.getSession(), mgr.getSession()]);
    expect(a).toBe(session);
    expect(b).toBe(session);
    expect(connect).toHaveBeenCalledTimes(1);
  });
});
