import http2 from "node:http2";
import net from "node:net";
import tls from "node:tls";
import { SocksClient } from "socks";

/**
 * HTTP/2 flow-control window (per-stream and connection-level). The default is
 * only 64 KiB, which caps throughput at window/RTT — brutal for multi-MB
 * package metadata over a high-latency link (e.g. a SOCKS tunnel), where a
 * single response can take tens of seconds. 16 MiB lets a whole metadata
 * document stream in one flight.
 */
const H2_WINDOW_SIZE = 16 * 1024 * 1024;

export interface SocksProxy {
  host: string;
  port: number;
}

/**
 * Opens an HTTP/2 session to `targetUrl`. When `socksProxy` is provided the
 * underlying TCP connection is tunnelled through a SOCKS5 proxy; otherwise it
 * connects directly. TLS with ALPN "h2" is negotiated in both cases.
 */
export async function connectViaSocks(
  targetUrl: string,
  socksProxy: SocksProxy | null = null,
): Promise<http2.ClientHttp2Session> {
  const url = new URL(targetUrl);
  const host = url.hostname;
  const port = Number(url.port) || 443;

  const socket = socksProxy
    ? (
        await SocksClient.createConnection({
          proxy: { host: socksProxy.host, port: socksProxy.port, type: 5 },
          command: "connect",
          destination: { host, port },
        })
      ).socket
    : net.connect({ host, port });

  return new Promise<http2.ClientHttp2Session>((resolve, reject) => {
    let tlsSocket: tls.TLSSocket | null = null;
    let client: http2.ClientHttp2Session | null = null;

    function cleanup() {
      if (client && !client.destroyed) client.close();
      if (tlsSocket && !tlsSocket.destroyed) tlsSocket.destroy();
      if (!socket.destroyed) socket.destroy();
    }

    tlsSocket = tls.connect({
      socket,
      servername: host,
      ALPNProtocols: ["h2"],
    });

    tlsSocket.on("error", (err) => {
      cleanup();
      reject(new Error(`TLS error: ${err.message}`));
    });

    tlsSocket.on("secureConnect", () => {
      if (tlsSocket!.alpnProtocol !== "h2") {
        cleanup();
        reject(new Error("HTTP/2 not negotiated"));
        return;
      }

      client = http2.connect(targetUrl, {
        createConnection: () => tlsSocket!,
        // Advertise a large per-stream receive window so the upstream can send
        // a full metadata document without stalling on WINDOW_UPDATE frames.
        settings: { initialWindowSize: H2_WINDOW_SIZE },
      });

      client.on("error", (err) => {
        cleanup();
        reject(new Error(`HTTP/2 error: ${err.message}`));
      });

      client.on("close", () => cleanup());

      // Raise the connection-level flow-control window too (setLocalWindowSize
      // governs the whole session, not just individual streams).
      client.setLocalWindowSize(H2_WINDOW_SIZE);

      console.log(`Successfully connected to ${targetUrl}`);
      resolve(client);
    });
  });
}
