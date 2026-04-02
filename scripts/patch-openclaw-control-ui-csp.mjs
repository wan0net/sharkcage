import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const distDir = join(process.cwd(), "node_modules", "openclaw", "dist");

function findGatewayBundle() {
  for (const entry of readdirSync(distDir)) {
    if (entry.startsWith("gateway-cli-") && entry.endsWith(".js")) {
      return join(distDir, entry);
    }
  }
  return null;
}

function patchControlUiCsp(source) {
  let next = source.replace(
    "hashes?.length ? `script-src 'self' ${hashes.map((h) => `'${h}'`).join(\" \")}` : \"script-src 'self'\",",
    "hashes?.length ? `script-src 'self' 'unsafe-eval' ${hashes.map((h) => `'${h}'`).join(\" \")}` : \"script-src 'self' 'unsafe-eval'\",",
  );

  if (next === source) {
    next = source.replace(
      "hashes?.length ? `script-src 'self' 'unsafe-eval' ${hashes.map((h) => `'${h}'`).join(\" \")}` : \"script-src 'self'\",",
      "hashes?.length ? `script-src 'self' 'unsafe-eval' ${hashes.map((h) => `'${h}'`).join(\" \")}` : \"script-src 'self' 'unsafe-eval'\",",
    );
  }

  return next;
}

const gatewayBundle = findGatewayBundle();
if (!gatewayBundle) {
  console.warn("[sharkcage] OpenClaw gateway bundle not found; skipping control UI CSP patch.");
  process.exit(0);
}

const original = readFileSync(gatewayBundle, "utf-8");
const patched = patchControlUiCsp(original);

if (patched === original) {
  if (original.includes("script-src 'self' 'unsafe-eval'")) {
    console.log("[sharkcage] OpenClaw control UI CSP patch already applied.");
    process.exit(0);
  }
  console.warn("[sharkcage] OpenClaw control UI CSP patch did not match the installed bundle.");
  process.exit(0);
}

writeFileSync(gatewayBundle, patched);
console.log("[sharkcage] Patched OpenClaw control UI CSP to allow unsafe-eval.");
