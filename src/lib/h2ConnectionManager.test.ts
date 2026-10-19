import { describe, it, expect, vi, afterEach } from "vitest";
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
  destroy(err?: Error) {
    this.destroyed = true;
    if (err) this.emit("error", err);
    this.emit("close");
  }
  /** Pending PING ack; tests call it to simulate the upstream answering. */
  pendingAck: ((err: Error | null) => void) | null = null;
  ping(cb: (err: Error | null) => void) {
    this.pendingAck = cb;
    return true;
  }
  request(_headers: unknown) {
    if (this.destroyed) {
      throw Object.assign(new Error("The session has been destroyed"), {
        code: "ERR_HTTP2_INVALID_SESSION",
      });
    }
    return { from: this };
  }
}

function fake() {
  return new FakeSession() as unknown as http2.ClientHttp2Session;
}

describe("H2ConnectionManager", () => {
  it("reuses a live session across calls", async () => {
    const session = fake();
    const connect = vi.fn(async () => session);
    const mgr = new H2ConnectionManager("https://x", null, { connect });

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
    const mgr = new H2ConnectionManager("https://x", null, { connect });

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
    const mgr = new H2ConnectionManager("https://x", null, { connect });

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
    const mgr = new H2ConnectionManager("https://x", null, { connect });

    const [a, b] = await Promise.all([mgr.getSession(), mgr.getSession()]);
    expect(a).toBe(session);
    expect(b).toBe(session);
    expect(connect).toHaveBeenCalledTimes(1);
  });

  it("retries request() on a fresh session when the session died unnoticed", async () => {
    const first = new FakeSession();
    const second = new FakeSession();
    const connect = vi
      .fn<() => Promise<http2.ClientHttp2Session>>()
      .mockResolvedValueOnce(first as unknown as http2.ClientHttp2Session)
      .mockResolvedValueOnce(second as unknown as http2.ClientHttp2Session);
    const mgr = new H2ConnectionManager("https://x", null, { connect });
    await mgr.getSession();

    // request() throws even though the session still looked usable.
    const spy = vi.spyOn(first, "request").mockImplementation(() => {
      throw Object.assign(new Error("destroyed"), {
        code: "ERR_HTTP2_INVALID_SESSION",
      });
    });

    const stream = (await mgr.request({})) as unknown as { from: FakeSession };
    expect(spy).toHaveBeenCalledTimes(1);
    expect(stream.from).toBe(second);
    expect(connect).toHaveBeenCalledTimes(2);
  });

  it("does not retry unrelated request() errors", async () => {
    const session = new FakeSession();
    vi.spyOn(session, "request").mockImplementation(() => {
      throw new Error("boom");
    });
    const connect = vi.fn(
      async () => session as unknown as http2.ClientHttp2Session,
    );
    const mgr = new H2ConnectionManager("https://x", null, { connect });

    await expect(mgr.request({})).rejects.toThrow("boom");
    expect(connect).toHaveBeenCalledTimes(1);
  });

  describe("keepalive", () => {
    afterEach(() => vi.useRealTimers());

    async function setup() {
      vi.useFakeTimers();
      const first = new FakeSession();
      const second = new FakeSession();
      const connect = vi
        .fn<() => Promise<http2.ClientHttp2Session>>()
        .mockResolvedValueOnce(first as unknown as http2.ClientHttp2Session)
        .mockResolvedValueOnce(second as unknown as http2.ClientHttp2Session);
      const mgr = new H2ConnectionManager("https://x", null, {
        connect,
        pingIntervalMs: 1000,
      });
      await mgr.getSession();
      return { mgr, first, second };
    }

    it("keeps a session whose PINGs are answered", async () => {
      const { mgr, first } = await setup();
      for (let i = 0; i < 3; i++) {
        vi.advanceTimersByTime(1000);
        first.pendingAck!(null);
      }
      expect(first.destroyed).toBe(false);
      expect(await mgr.getSession()).toBe(first);
    });

    it("destroys and replaces a session whose PING goes unanswered", async () => {
      const { mgr, first, second } = await setup();
      first.on("error", () => {});
      vi.advanceTimersByTime(1000); // PING sent
      vi.advanceTimersByTime(1000); // still no ack -> dead
      expect(first.destroyed).toBe(true);
      expect(await mgr.getSession()).toBe(second);
    });

    it("destroys a session whose PING fails", async () => {
      const { first } = await setup();
      first.on("error", () => {});
      vi.advanceTimersByTime(1000);
      first.pendingAck!(new Error("ping failed"));
      expect(first.destroyed).toBe(true);
    });
  });
});
