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

export class H2ConnectionManager {
  private session: http2.ClientHttp2Session | null = null;
  private readonly connecting = new SingleFlight<http2.ClientHttp2Session>();
  private readonly connect: Connect;

  constructor(
    targetUrl: string,
    socksProxy: SocksProxy | null = null,
    // Injectable for testing; defaults to a real SOCKS/TLS HTTP/2 connection.
    connect?: Connect,
  ) {
    this.connect = connect ?? (() => connectViaSocks(targetUrl, socksProxy));
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

      this.session = session;
      return session;
    });

    return promise;
  }

  close() {
    const session = this.session;
    this.session = null;
    if (session && !session.destroyed) session.close();
  }
}
