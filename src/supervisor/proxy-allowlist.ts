import type { AllowedTarget, SkillCapability } from "./types.js";

const SUPERVISOR_API_PORT = 18790;
const PROXY_PORT = 18800;

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

  // Always allow loopback connections to the supervisor API and proxy itself
  targets.push({ host: "127.0.0.1", port: SUPERVISOR_API_PORT, capability: "internal" });
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

    if (c === "network.internal") {
      // scope contains explicit host:port pairs
      for (const entry of (cap.scope ?? [])) {
        const { host, port } = parseHostPort(entry, 80);
        targets.push({ host, port, capability: c });
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
): { allowed: boolean; capability?: string } {
  // Normalise localhost aliases to 127.0.0.1
  const normHost = host === "localhost" ? "127.0.0.1" : host;

  for (const target of allowed) {
    const normTarget = target.host === "localhost" ? "127.0.0.1" : target.host;
    if (normTarget === normHost && target.port === port) {
      return { allowed: true, capability: target.capability };
    }
  }

  return { allowed: false };
}
