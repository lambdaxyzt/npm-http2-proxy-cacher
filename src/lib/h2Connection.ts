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
      const detail = describeTlsFailure(tlsSocket, err);
      cleanup();
      reject(new Error(`TLS error: ${detail}`));
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

/**
 * Certificate failures ("certificate has expired", "self signed certificate in
 * chain", ...) are useless without knowing *which* certificate was rejected:
 * the real upstream, a TLS-intercepting middlebox, or a stale clock making a
 * valid certificate look out of date. Node still exposes the peer chain on a
 * failed handshake, so fold the identifying details into the error message.
 */
function describeTlsFailure(
  tlsSocket: tls.TLSSocket | null,
  err: NodeJS.ErrnoException,
): string {
  const parts = [err.message];
  if (err.code) parts.push(`code=${err.code}`);

  let peer: tls.PeerCertificate | undefined;
  try {
    peer = tlsSocket?.getPeerCertificate(true);
  } catch {
    // Socket already torn down; the message without chain details will do.
  }

  if (peer?.subject) {
    parts.push(
      `peer=${peer.subject.CN ?? "?"}`,
      `issuer=${peer.issuer?.CN ?? "?"}`,
      `valid=${peer.valid_from} .. ${peer.valid_to}`,
    );
  }

  // The chain the server actually sent, so an expired intermediate or an
  // unexpected interception root is visible at a glance.
  const chain: string[] = [];
  for (let cert = peer?.issuerCertificate; cert?.subject; ) {
    chain.push(`${cert.issuer?.CN ?? "?"} -> ${cert.subject.CN ?? "?"} (${cert.valid_to})`);
    // The root is self-issued and points at itself; stop before looping forever.
    if (cert.issuerCertificate === cert || chain.length > 8) break;
    cert = cert.issuerCertificate;
  }
  if (chain.length) parts.push(`chain=[${chain.join(", ")}]`);

  parts.push(`clientTime=${new Date().toISOString()}`);
  return parts.join(" ");
}
