import http2 from "node:http2";
import net from "node:net";
import tls from "node:tls";
import { SocksClient } from "socks";

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
      });

      client.on("error", (err) => {
        cleanup();
        reject(new Error(`HTTP/2 error: ${err.message}`));
      });

      client.on("close", () => cleanup());

      console.log(`Successfully connected to ${targetUrl}`);
      resolve(client);
    });
  });
}
