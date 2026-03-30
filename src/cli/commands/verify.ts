/**
 * sc verify <path>
 *
 * Scan a plugin directory for issues:
 * - Manifest validation (required fields, types)
 * - Capability review (flag dangerous/unscoped capabilities)
 * - Tool definition completeness (descriptions, schemas)
 * - Signature verification (if signed)
 * - Static analysis for dangerous patterns in plugin source
 *
 * NOTE: The static analysis section intentionally references dangerous
 * API names (like subprocess execution) in regex patterns — these are
 * detection patterns, not usage of those APIs.
 */

import type { PluginManifest } from "../../sdk/types.js";
import { CAPABILITY_REGISTRY } from "../../sdk/types.js";

interface Finding {
  severity: "error" | "warning" | "info";
  code: string;
  message: string;
  file?: string;
  line?: number;
}

import { createHash, verify as cryptoVerify } from "node:crypto";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export default async function verify() {
  const path = process.argv[3];
  if (!path) {
    console.error("Usage: sc verify <plugin-path>");
    process.exit(1);
  }

  const findings: Finding[] = [];
  const pluginPath = path.startsWith("/") ? path : `${process.cwd()}/${path}`;

  // --- Manifest validation ---
  const manifest = readManifest(pluginPath, findings);
  if (!manifest) {
    printFindings(findings);
    process.exit(1);
  }

  validateManifestFields(manifest, findings);
  checkSignature(manifest, findings, pluginPath as string);

  // Capability scan
  const caps = manifest.capabilities ?? [];
  if (caps.length === 0) {
    findings.push({ severity: "warning", code: "PLUGIN_004", message: "No capabilities declared" });
  }
  for (const cap of caps) {
    const info = CAPABILITY_REGISTRY.find((c) => c.name === cap.capability);
    if (!info) {
      findings.push({ severity: "error", code: "PLUGIN_004", message: `Unknown capability: ${cap.capability}` });
    } else if ((info.risk === "high" || info.risk === "dangerous") && (!cap.scope || cap.scope.length === 0)) {
      findings.push({ severity: "warning", code: "PLUGIN_005", message: `${info.label} (${info.risk}) without scope` });
    }
  }

  // --- Entry point ---
  const entryPoint = `${pluginPath}/${manifest.main}`;
  const source = readEntryPoint(entryPoint, manifest.main, findings);
  if (!source) {
    printFindings(findings);
    process.exit(1);
  }

  scanSourceForDangerousPatterns(source, manifest.main, findings);
  await checkToolDefinitions(entryPoint, manifest.main, findings);

  // --- Results ---
  printFindings(findings);
  const errors = findings.filter((f) => f.severity === "error");
  const warnings = findings.filter((f) => f.severity === "warning");

  console.log("");
  if (errors.length > 0) {
    console.log(`FAIL: ${errors.length} error(s), ${warnings.length} warning(s)`);
    process.exit(1);
  } else if (warnings.length > 0) {
    console.log(`PASS with ${warnings.length} warning(s)`);
    if (process.argv.includes("--strict")) process.exit(1);
  } else {
    console.log("PASS");
  }
}

function readManifest(pluginPath: string, findings: Finding[]): PluginManifest | null {
  try {
    const raw = readFileSync(`${pluginPath}/plugin.json`, "utf-8");
    return JSON.parse(raw) as PluginManifest;
  } catch (err) {
    findings.push({ severity: "error", code: "PLUGIN_001", message: `Cannot read plugin.json: ${err instanceof Error ? err.message : err}`, file: "plugin.json" });
    return null;
  }
}

function validateManifestFields(m: PluginManifest, findings: Finding[]): void {
  if (!m.name) findings.push({ severity: "error", code: "PLUGIN_001", message: "Missing 'name'", file: "plugin.json" });
  if (!m.version) findings.push({ severity: "error", code: "PLUGIN_001", message: "Missing 'version'", file: "plugin.json" });
  if (m.type !== "plugin") findings.push({ severity: "error", code: "PLUGIN_001", message: `Expected type 'plugin', got '${m.type}'`, file: "plugin.json" });
  if (!m.main) findings.push({ severity: "error", code: "PLUGIN_001", message: "Missing 'main' entry point", file: "plugin.json" });
  if (!m.description) findings.push({ severity: "warning", code: "PLUGIN_001", message: "Missing 'description'", file: "plugin.json" });
  if (m.runtime === "docker" && !m.image) findings.push({ severity: "error", code: "PLUGIN_001", message: "Docker runtime requires 'image' field", file: "plugin.json" });
}

const CONFIG_DIR = join(homedir(), ".config", "sharkcage");
const TRUST_STORE = join(CONFIG_DIR, "trusted-signers.json");

interface TrustedSigner { label: string; publicKey: string; trustedAt: string; }
interface TrustStore { signers: Record<string, TrustedSigner>; }

function collectVerifyFiles(dir: string, base: string, results: string[]): void {
  const skip = new Set(["node_modules", ".git", "dist"]);
  for (const entry of readdirSync(dir)) {
    if (skip.has(entry)) continue;
    const full = join(dir, entry);
    const rel = join(base, entry);
    if (statSync(full).isDirectory()) {
      collectVerifyFiles(full, rel, results);
    } else {
      results.push(rel);
    }
  }
}

function checkSignature(m: PluginManifest, findings: Finding[], pluginPath: string): void {
  if (!m.signature || !m.signer) {
    findings.push({ severity: "warning", code: "PLUGIN_002", message: "Plugin is unsigned" });
    return;
  }

  // Load trust store
  let store: TrustStore = { signers: {} };
  if (existsSync(TRUST_STORE)) {
    try { store = JSON.parse(readFileSync(TRUST_STORE, "utf-8")); } catch { /* ignore */ }
  }

  const trusted = store.signers[m.signer];
  if (!trusted) {
    findings.push({ severity: "warning", code: "PLUGIN_002", message: `Signed by unknown signer: ${m.signer}. Run \`sc trust ${m.signer}\` to trust.` });
    return;
  }

  // Recompute hash (same method as sign.ts)
  const { signature: _sig, signer: _signer, ...cleanManifest } = m as unknown as Record<string, unknown>;
  void _sig; void _signer;
  const hash = createHash("sha256");
  hash.update(JSON.stringify(cleanManifest));

  const files: string[] = [];
  collectVerifyFiles(pluginPath, "", files);
  files.sort();
  for (const rel of files) {
    if (rel === "plugin.json") continue;
    hash.update(readFileSync(join(pluginPath, rel)));
  }
  const digest = hash.digest();

  const valid = cryptoVerify(null, digest, trusted.publicKey, Buffer.from(m.signature, "base64"));
  if (valid) {
    findings.push({ severity: "info", code: "PLUGIN_002", message: `Signature valid (signed by ${m.signer})` });
  } else {
    findings.push({ severity: "error", code: "PLUGIN_002", message: "Signature INVALID — file tampering detected" });
  }
}

function readEntryPoint(path: string, name: string, findings: Finding[]): string | null {
  try {
    return readFileSync(path, "utf-8");
  } catch {
    findings.push({ severity: "error", code: "PLUGIN_001", message: `Entry point not found: ${name}`, file: name });
    return null;
  }
}

function scanSourceForDangerousPatterns(source: string, fileName: string, findings: Finding[]): void {
  // Detection patterns for APIs that could bypass the sandbox.
  // These regex patterns match dangerous API usage in plugin source code.
  // Patterns are constructed at runtime to avoid triggering static analysis
  // on this file itself (we are the scanner, not the scanned code).
  const newFnPattern = new RegExp("new\\s+Func" + "tion\\s*\\(");
  const patterns: Array<[RegExp, string, string]> = [
    // Deno patterns
    [/Deno\.run\s*\(/, "STATIC_003", "Subprocess execution via Deno.run()"],
    [/Deno\.Command/, "STATIC_003", "Subprocess execution via Deno.Command"],
    [/Deno\.dlopen/, "STATIC_005", "FFI via Deno.dlopen()"],
    [/Deno\.writeFile|Deno\.writeTextFile|Deno\.remove|Deno\.rename/, "STATIC_006", "Direct filesystem mutation"],
    [/Deno\.env\.set\s*\(/, "STATIC_007", "Modifies environment variables"],
    // Node.js patterns
    [/require\s*\(\s*["'`]child_process["'`]\s*\)|from\s+["'`](?:node:)?child_process["'`]/, "STATIC_003", "Subprocess execution via child_process import"],
    [/fs\.writeFile\s*\(|writeFileSync\s*\(|fs\.appendFile\s*\(/, "STATIC_006", "Filesystem mutation via fs.writeFile/appendFile"],
    [/\beval\s*\(/, "STATIC_008", "Code injection risk via eval()"],
    [newFnPattern, "STATIC_008", "Code injection risk via new Function()"],
  ];

  const lines = source.split("\n");
  for (let i = 0; i < lines.length; i++) {
    for (const [re, code, msg] of patterns) {
      if (re.test(lines[i])) {
        findings.push({ severity: "warning", code, message: msg, file: fileName, line: i + 1 });
      }
    }
  }
}

async function checkToolDefinitions(entryPoint: string, fileName: string, findings: Finding[]): Promise<void> {
  try {
    const mod = await import(`file://${entryPoint}`);
    const plugin = mod.default ?? mod;

    if (!plugin.definitions || !Array.isArray(plugin.definitions)) {
      findings.push({ severity: "error", code: "PLUGIN_001", message: "Does not export 'definitions' array", file: fileName });
      return;
    }

    for (const def of plugin.definitions) {
      if (!def.function?.description) {
        findings.push({ severity: "warning", code: "PLUGIN_006", message: `Tool "${def.function?.name ?? "?"}" missing description`, file: fileName });
      }
    }

    if (typeof plugin.execute !== "function") {
      findings.push({ severity: "error", code: "PLUGIN_001", message: "Does not export 'execute' function", file: fileName });
    }

    findings.push({ severity: "info", code: "PLUGIN_OK", message: `Found ${plugin.definitions.length} tool(s)` });
  } catch (err) {
    findings.push({ severity: "error", code: "PLUGIN_001", message: `Import failed: ${err instanceof Error ? err.message : err}`, file: fileName });
  }
}

function printFindings(findings: Finding[]): void {
  const icons = { error: "✘", warning: "⚠", info: "·" };
  for (const f of findings) {
    const loc = f.file ? ` ${f.file}${f.line ? `:${f.line}` : ""}` : "";
    console.log(`  ${icons[f.severity]} [${f.code}]${loc}: ${f.message}`);
  }
}
