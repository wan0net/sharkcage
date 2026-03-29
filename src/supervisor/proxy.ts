import { createServer, createConnection, type Socket, type Server } from "node:net";
import type { TokenRegistry } from "./token-registry.js";
import type { AuditLog } from "./audit.js";
import { buildAllowedTargets, checkTarget } from "./proxy-allowlist.js";

// SOCKS5 constants
const SOCKS5_VERSION = 0x05;
const AUTH_VERSION = 0x01;
const AUTH_METHOD_USERPASS = 0x02;
const AUTH_METHOD_NO_ACCEPTABLE = 0xff;
const CMD_CONNECT = 0x01;
const ATYP_IPV4 = 0x01;
const ATYP_DOMAIN = 0x03;
const ATYP_IPV6 = 0x04;
const REP_SUCCESS = 0x00;
const REP_NOT_ALLOWED = 0x02;
const REP_HOST_UNREACHABLE = 0x04;
const REP_CMD_NOT_SUPPORTED = 0x07;
const REP_ATYP_NOT_SUPPORTED = 0x08;

/**
 * Minimal SOCKS5 reply (bound addr = 0.0.0.0:0).
 */
function socks5Reply(rep: number): Buffer {
  return Buffer.from([SOCKS5_VERSION, rep, 0x00, ATYP_IPV4, 0, 0, 0, 0, 0, 0]);
}

/**
 * Parse a SOCKS5 CONNECT request from a buffer.
 * Returns null if the buffer is incomplete.
 */
function parseConnectRequest(
  buf: Buffer
): { host: string; port: number; consumed: number } | null {
  // [VER=0x05][CMD][RSV=0x00][ATYP][ADDR...][PORT(2)]
  if (buf.length < 4) return null;

  const atyp = buf[3];
  let host: string;
  let offset: number;

  if (atyp === ATYP_IPV4) {
    if (buf.length < 10) return null;
    host = `${buf[4]}.${buf[5]}.${buf[6]}.${buf[7]}`;
    offset = 8;
  } else if (atyp === ATYP_DOMAIN) {
    if (buf.length < 5) return null;
    const len = buf[4];
    if (buf.length < 5 + len + 2) return null;
    host = buf.slice(5, 5 + len).toString("utf8");
    offset = 5 + len;
  } else if (atyp === ATYP_IPV6) {
    if (buf.length < 22) return null;
    const parts: string[] = [];
    for (let i = 0; i < 16; i += 2) {
      parts.push(buf.slice(4 + i, 6 + i).toString("hex"));
    }
    host = parts.join(":");
    offset = 20;
  } else {
    return null; // unknown ATYP — caller handles
  }

  const port = (buf[offset] << 8) | buf[offset + 1];
  return { host, port, consumed: offset + 2 };
}

/**
 * Handle a single SOCKS5 client connection through the full handshake.
 */
async function handleSocks5(
  conn: Socket,
  tokenRegistry: TokenRegistry,
  audit: AuditLog,
  env: Record<string, string>
): Promise<void> {
  let buf = Buffer.alloc(0);

  function accumulate(chunk: Buffer): void {
    buf = Buffer.concat([buf, chunk]);
  }

  function waitForBytes(n: number): Promise<Buffer> {
    return new Promise((resolve, reject) => {
      function tryResolve() {
        if (buf.length >= n) {
          resolve(buf);
          return true;
        }
        return false;
      }

      if (tryResolve()) return;

      conn.on("data", function handler(chunk: Buffer) {
        accumulate(chunk);
        if (tryResolve()) {
          conn.removeListener("data", handler);
        }
      });

      conn.once("close", () => reject(new Error("connection closed during handshake")));
      conn.once("error", reject);
    });
  }

  conn.on("data", accumulate);

  try {
    // --- Phase 1: Greeting ---
    // [VER][NMETHODS][METHODS...]
    await waitForBytes(2);
    if (buf[0] !== SOCKS5_VERSION) {
      conn.destroy();
      return;
    }
    const nmethods = buf[1];
    await waitForBytes(2 + nmethods);
    buf = buf.slice(2 + nmethods); // consume greeting

    // We only accept username/password auth
    conn.write(Buffer.from([SOCKS5_VERSION, AUTH_METHOD_USERPASS]));

    // --- Phase 2: Username/Password Auth (RFC 1929) ---
    // [0x01][ULEN][USER...][PLEN][PASS...]
    await waitForBytes(2);
    if (buf[0] !== AUTH_VERSION) {
      conn.write(Buffer.from([AUTH_VERSION, 0x01]));
      conn.destroy();
      return;
    }
    const ulen = buf[1];
    await waitForBytes(2 + ulen + 1);
    const token = buf.slice(2, 2 + ulen).toString("utf8");
    const plen = buf[2 + ulen];
    await waitForBytes(2 + ulen + 1 + plen);
    buf = buf.slice(2 + ulen + 1 + plen); // consume auth message

    const identity = tokenRegistry.lookup(token);
    if (!identity) {
      conn.write(Buffer.from([AUTH_VERSION, 0x01])); // auth failure
      conn.destroy();
      return;
    }
    conn.write(Buffer.from([AUTH_VERSION, 0x00])); // auth success

    const allowed = buildAllowedTargets(identity.capabilities, env);

    // --- Phase 3: CONNECT request ---
    // [VER][CMD][RSV][ATYP][ADDR...][PORT(2)]
    await waitForBytes(4);
    if (buf[0] !== SOCKS5_VERSION) {
      conn.write(socks5Reply(REP_CMD_NOT_SUPPORTED));
      conn.destroy();
      return;
    }

    const cmd = buf[1];
    if (cmd !== CMD_CONNECT) {
      conn.write(socks5Reply(REP_CMD_NOT_SUPPORTED));
      conn.destroy();
      return;
    }

    const atyp = buf[3];
    if (atyp === ATYP_IPV6) {
      // We parse IPv6 but still check it — keep going
    }
    if (atyp !== ATYP_IPV4 && atyp !== ATYP_DOMAIN && atyp !== ATYP_IPV6) {
      conn.write(socks5Reply(REP_ATYP_NOT_SUPPORTED));
      conn.destroy();
      return;
    }

    // Ensure we have enough bytes for the full address
    let minBytes = 4;
    if (atyp === ATYP_IPV4) minBytes = 10;
    else if (atyp === ATYP_IPV6) minBytes = 22;
    else if (atyp === ATYP_DOMAIN) {
      await waitForBytes(5);
      minBytes = 5 + buf[4] + 2;
    }
    await waitForBytes(minBytes);

    const parsed = parseConnectRequest(buf);
    if (!parsed) {
      conn.write(socks5Reply(REP_ATYP_NOT_SUPPORTED));
      conn.destroy();
      return;
    }
    buf = buf.slice(parsed.consumed); // consume connect request

    // Remove the accumulate listener — we're done with the handshake
    conn.removeAllListeners("data");

    const { host, port } = parsed;
    const check = checkTarget(allowed, host, port);

    await audit.logProxy({
      timestamp: new Date().toISOString(),
      skill: identity.skill,
      host,
      port,
      allowed: check.allowed,
      capability: check.capability ?? null,
    });

    if (!check.allowed) {
      console.warn(
        `DENIED ${identity.skill} → ${host}:${port} (no matching capability)`
      );
      conn.write(socks5Reply(REP_NOT_ALLOWED));
      conn.destroy();
      return;
    }

    // --- Phase 4: TCP splice ---
    const upstream = createConnection({ host, port }, () => {
      conn.write(socks5Reply(REP_SUCCESS));

      // Replay any data that arrived before we removed the accumulate listener
      if (buf.length > 0) {
        upstream.write(buf);
        buf = Buffer.alloc(0);
      }

      conn.pipe(upstream);
      upstream.pipe(conn);

      console.log(`ALLOWED ${identity.skill} → ${host}:${port} (${check.capability})`);
    });

    upstream.on("error", (err) => {
      console.error(`upstream error ${host}:${port}:`, err.message);
      conn.write(socks5Reply(REP_HOST_UNREACHABLE));
      conn.destroy();
    });

    conn.on("close", () => upstream.destroy());
    upstream.on("close", () => conn.destroy());
  } catch (err) {
    // Handshake failed (e.g. client disconnected)
    conn.destroy();
  }
}

/**
 * Start the SOCKS5 localhost proxy.
 * Skills receive ALL_PROXY=socks5://<token>:x@127.0.0.1:18800
 * so all outbound TCP goes through here for enforcement.
 */
export function startLocalhostProxy(
  port: number,
  tokenRegistry: TokenRegistry,
  audit: AuditLog,
  env: Record<string, string> = {}
): Server {
  const server = createServer((conn: Socket) => {
    handleSocks5(conn, tokenRegistry, audit, env).catch((err) => {
      console.error("unhandled error:", err);
      conn.destroy();
    });
  });

  server.listen(port, "127.0.0.1", () => {
    console.log(`SOCKS5 listening on 127.0.0.1:${port}`);
  });

  server.on("error", (err) => {
    console.error("server error:", err);
  });

  return server;
}
