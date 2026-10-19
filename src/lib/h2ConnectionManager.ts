import http2 from "node:http2";
import { connectViaSocks, type SocksProxy } from "@src/lib/h2Connection";
import { SingleFlight } from "@src/lib/singleFlight";

/**
 * Keeps a single long-lived HTTP/2 session to the upstream registry and
 * transparently re-establishes it when the session is destroyed, closed, or
 * sends a GOAWAY. Without this, an idle upstream that tears down the session
 * would make every subsequent `session.request()` throw ERR_HTTP2_INVALID_SESSION
 * and crash the process.
 */
type Connect = () => Promise<http2.ClientHttp2Session>;

function isDeadSessionError(err: unknown): boolean {
  const code = (err as NodeJS.ErrnoException | null)?.code;
  return (
    code === "ERR_HTTP2_INVALID_SESSION" || code === "ERR_HTTP2_GOAWAY_SESSION"
  );
}

export class H2ConnectionManager {
  private session: http2.ClientHttp2Session | null = null;
  private readonly connecting = new SingleFlight<http2.ClientHttp2Session>();
  private readonly connect: Connect;
  private readonly pingIntervalMs: number;

  constructor(
    targetUrl: string,
    socksProxy: SocksProxy | null = null,
    {
      // Injectable for testing; defaults to a real SOCKS/TLS HTTP/2 connection.
      connect,
      pingIntervalMs = 30_000,
    }: { connect?: Connect; pingIntervalMs?: number } = {},
  ) {
    this.connect = connect ?? (() => connectViaSocks(targetUrl, socksProxy));
    this.pingIntervalMs = pingIntervalMs;
  }

  private isUsable(
    s: http2.ClientHttp2Session | null,
  ): s is http2.ClientHttp2Session {
    return !!s && !s.destroyed && !s.closed;
  }

  /**
   * Returns a live session, reconnecting if necessary. Concurrent callers that
   * arrive during a reconnect share the same connection attempt.
   */
  async getSession(): Promise<http2.ClientHttp2Session> {
    if (this.isUsable(this.session)) return this.session;

    const { promise } = this.connecting.run("session", async () => {
      const session = await this.connect();

      // Stop handing out a session once the upstream is done with it so the
      // next getSession() reconnects instead of using a dead session.
      const invalidate = () => {
        if (this.session === session) this.session = null;
      };
      session.on("close", invalidate);
      session.on("error", invalidate);
      session.on("goaway", invalidate);
      this.keepAlive(session);

      this.session = session;
      return session;
    });

    return promise;
  }

  /**
   * Opens a stream on a live session. The session is resolved at call time, not
   * captured earlier, because callers may await (cache checks, waiting on a
   * coalesced download) long enough for upstream to tear the session down. If
   * the session dies between getSession() and request(), it is dropped and the
   * request is retried once on a fresh connection.
   */
  async request(
    headers: http2.OutgoingHttpHeaders,
  ): Promise<http2.ClientHttp2Stream> {
    for (let attempt = 0; ; attempt++) {
      const session = await this.getSession();
      try {
        return session.request(headers);
      } catch (err) {
        if (attempt > 0 || !isDeadSessionError(err)) throw err;
        if (this.session === session) this.session = null;
      }
    }
  }

  /**
   * PINGs the session periodically. A connection dropped without a FIN/RST (an
   * idle-killed SOCKS tunnel, a NAT timeout) never emits `close`, so requests
   * on it would hang forever. If a PING errors, or is still unanswered when the
   * next one is due, the session is destroyed: that fails its in-flight streams
   * (which answer 502) and fires `close`, so the next request reconnects.
   */
  private keepAlive(session: http2.ClientHttp2Session) {
    if (this.pingIntervalMs <= 0) return;

    let awaitingAck = false;
    const timer = setInterval(() => {
      if (session.destroyed) return clearInterval(timer);
      if (awaitingAck) {
        session.destroy(new Error("HTTP/2 PING timed out"));
        return;
      }
      awaitingAck = true;
      try {
        session.ping((err) => {
          awaitingAck = false;
          if (err && !session.destroyed) session.destroy(err);
        });
      } catch (err) {
        // ping() throws if the session is already closing.
        session.destroy(err as Error);
      }
    }, this.pingIntervalMs);
    // Never keep the process alive just to ping.
    timer.unref();
    session.on("close", () => clearInterval(timer));
  }

  close() {
    const session = this.session;
    this.session = null;
    if (session && !session.destroyed) session.close();
  }
}
