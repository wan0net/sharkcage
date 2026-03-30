import { randomUUID } from "node:crypto";
import { Socks5Server } from "@pondwader/socks5-server";
import type { AuditLog } from "./audit.js";
import type { AllowedTarget, SkillCapability, TokenEntry } from "./types.js";

const PROXY_PORT = 18800;
const TOKEN_TTL_MS = 10 * 60 * 1000; // 10 minutes

/**
 * Issues short-lived tokens that map to skill identity + capabilities.
 * Used as the SOCKS5 username so the proxy can enforce per-skill allowlists.
 */
export class TokenRegistry {
  private entries = new Map<string, TokenEntry>();

  issue(skill: string, capabilities: SkillCapability[]): string {
    const token = randomUUID();
    const timeoutHandle = setTimeout(() => {
      this.entries.delete(token);
    }, TOKEN_TTL_MS);

    // Allow the timer to be garbage-collected if the process exits
    if (typeof timeoutHandle === "object" && "unref" in timeoutHandle) {
      (timeoutHandle as NodeJS.Timeout).unref();
    }

    this.entries.set(token, {
      skill,
      capabilities,
      issuedAt: Date.now(),
      timeoutHandle,
    });

    return token;
  }

  lookup(token: string): { skill: string; capabilities: SkillCapability[] } | null {
    const entry = this.entries.get(token);
    if (!entry) return null;
    return { skill: entry.skill, capabilities: entry.capabilities };
  }

  revoke(token: string): void {
    const entry = this.entries.get(token);
    if (entry) {
      clearTimeout(entry.timeoutHandle);
      this.entries.delete(token);
    }
  }
}

/**
 * Parse a URL or host:port string into host and port components.
 * Strips scheme if present.
 */
function parseHostPort(raw: string, defaultPort: number): { host: string; port: number } {
  const stripped = raw.replace(/^https?:\/\//, "").replace(/\/$/, "");
  const lastColon = stripped.lastIndexOf(":");
  if (lastColon === -1) {
    return { host: stripped, port: defaultPort };
  }
  const host = stripped.slice(0, lastColon);
  const portStr = stripped.slice(lastColon + 1);
  const port = parseInt(portStr, 10);
  return { host, port: isNaN(port) ? defaultPort : port };
}

/**
 * Build the set of allowed SOCKS5 proxy targets for a skill based on its
 * approved capabilities and the current env (which contains service URLs).
 */
export function buildAllowedTargets(
  capabilities: SkillCapability[],
  env: Record<string, string>
): AllowedTarget[] {
  const targets: AllowedTarget[] = [];

  // Allow loopback connections to the proxy itself (needed for the SOCKS5 handshake).
  // The supervisor API (18790) is intentionally NOT allowed — skills must not reach it.
  targets.push({ host: "127.0.0.1", port: PROXY_PORT, capability: "internal" });

  for (const cap of capabilities) {
    const c = cap.capability;

    if (c === "home.read" || c === "home.control" || c === "home.automation") {
      const raw = env["HA_URL"] ?? "127.0.0.1:8123";
      const { host, port } = parseHostPort(raw, 8123);
      targets.push({ host, port, capability: c });
      continue;
    }

    if (c === "data.meals") {
      const raw = env["MEALS_API_URL"] ?? "127.0.0.1:8788";
      const { host, port } = parseHostPort(raw, 8788);
      targets.push({ host, port, capability: c });
      continue;
    }

    if (c === "fleet.dispatch" || c === "fleet.read" || c === "fleet.manage" || c.startsWith("fleet.")) {
      const raw = env["NOMAD_ADDR"] ?? "127.0.0.1:4646";
      const { host, port } = parseHostPort(raw, 4646);
      targets.push({ host, port, capability: c });
      continue;
    }

    if (c === "network.external") {
      if (!cap.scope || cap.scope.length === 0) {
        // Unrestricted outbound — wildcard sentinel
        targets.push({ host: "*", port: 0, capability: c });
      } else {
        for (const entry of cap.scope) {
          const { host, port } = parseHostPort(entry, 443);
          targets.push({ host, port, capability: c });
        }
      }
      continue;
    }

    if (c === "network.internal") {
      if (!cap.scope || cap.scope.length === 0) {
        // Unrestricted internal — wildcard sentinel
        targets.push({ host: "*", port: 0, capability: c });
      } else {
        // scope contains explicit host:port pairs
        for (const entry of cap.scope) {
          const { host, port } = parseHostPort(entry, 80);
          targets.push({ host, port, capability: c });
        }
      }
      continue;
    }
  }

  return targets;
}

/**
 * Check whether a connection to host:port is permitted by the allowlist.
 */
export function checkTarget(
  allowed: AllowedTarget[],
  host: string,
  port: number
): { allowed: boolean; capability?: string; reason?: string } {
  // Normalise localhost aliases to 127.0.0.1
  const normHost = (host === "localhost" || host === "::1") ? "127.0.0.1" : host;

  // Always block the supervisor API — even for wildcard network.internal
  if ((normHost === "127.0.0.1" || normHost === "localhost") && (port === 18790 || port === 18800)) {
    return { allowed: false, reason: "supervisor ports blocked" };
  }

  for (const target of allowed) {
    // Wildcard sentinel — allow any host/port
    if (target.host === "*") {
      return { allowed: true, capability: target.capability };
    }
    const normTarget = target.host === "localhost" ? "127.0.0.1" : target.host;
    if (normTarget === normHost && target.port === port) {
      return { allowed: true, capability: target.capability };
    }
  }

  return { allowed: false };
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
): Socks5Server {
  const server = new Socks5Server();

  // Auth: validate token from username field
  server.setAuthHandler((conn, accept, deny) => {
    const identity = tokenRegistry.lookup(conn.username ?? "");
    if (!identity) {
      deny();
      return;
    }
    // Store identity on connection for rulesetValidator
    conn.metadata = { identity };
    accept();
  });

  // Ruleset: check target against per-skill allowlist
  server.setRulesetValidator((conn, accept, deny) => {
    const identity = conn.metadata?.identity as { skill: string; capabilities: SkillCapability[] } | undefined;
    if (!identity) {
      deny();
      return;
    }

    const allowed = buildAllowedTargets(identity.capabilities, env);
    const check = checkTarget(allowed, conn.destAddress ?? "", conn.destPort ?? 0);

    audit.logProxy({
      timestamp: new Date().toISOString(),
      skill: identity.skill,
      host: conn.destAddress ?? "",
      port: conn.destPort ?? 0,
      allowed: check.allowed,
      capability: check.capability ?? null,
    });

    if (check.allowed) {
      console.log(`ALLOWED ${identity.skill} → ${conn.destAddress}:${conn.destPort} (${check.capability})`);
      accept();
    } else {
      console.warn(`DENIED ${identity.skill} → ${conn.destAddress}:${conn.destPort} (no matching capability)`);
      deny();
    }
  });

  // Use default TCP splice connection handler
  server.useDefaultConnectionHandler();

  server.listen(port, "127.0.0.1", () => {
    console.log(`SOCKS5 listening on 127.0.0.1:${port}`);
  });

  return server;
}
