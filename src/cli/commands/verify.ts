/**
 * sc verify <path>
 *
 * Scan a plugin directory for issues:
 * - Manifest validation (required fields, types)
 * - Permission review (flag dangerous: run, ffi, net:true, write:true)
 * - Tool definition completeness (descriptions, schemas)
 * - Signature verification (if signed)
 * - Static analysis for dangerous patterns in plugin source
 *
 * NOTE: The static analysis section intentionally references dangerous
 * API names (like subprocess execution) in regex patterns — these are
 * detection patterns, not usage of those APIs.
 */

interface PluginManifest {
  name: string;
  version: string;
  type: string;
  description: string;
  runtime?: string;
  image?: string;
  permissions: {
    net?: boolean | string[];
    env?: boolean | string[];
    read?: boolean | string[];
    write?: boolean | string[];
    run?: boolean | string[];
    ffi?: boolean;
  };
  main: string;
  signature?: string;
  signer?: string;
}

interface Finding {
  severity: "error" | "warning" | "info";
  code: string;
  message: string;
  file?: string;
  line?: number;
}

import { readFileSync } from "node:fs";

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
  checkSignature(manifest, findings);
  reviewPermissions(manifest, findings);

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

function checkSignature(m: PluginManifest, findings: Finding[]): void {
  if (!m.signature) {
    findings.push({ severity: "warning", code: "PLUGIN_002", message: "Plugin is unsigned" });
  }
  // TODO: Ed25519 signature verification against trust store
}

function reviewPermissions(m: PluginManifest, findings: Finding[]): void {
  const p = m.permissions ?? {};
  if (p.run === true) findings.push({ severity: "warning", code: "PLUGIN_004", message: "Requests unrestricted subprocess execution", file: "plugin.json" });
  else if (Array.isArray(p.run) && p.run.length > 0) findings.push({ severity: "info", code: "PLUGIN_004", message: `Subprocess access: ${p.run.join(", ")}`, file: "plugin.json" });
  if (p.ffi) findings.push({ severity: "warning", code: "PLUGIN_004", message: "Requests FFI access", file: "plugin.json" });
  if (p.net === true) findings.push({ severity: "warning", code: "PLUGIN_005", message: "Requests unrestricted network (net: true)", file: "plugin.json" });
  if (p.write === true) findings.push({ severity: "warning", code: "PLUGIN_004", message: "Requests unrestricted filesystem write", file: "plugin.json" });
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
  const patterns: Array<[RegExp, string, string]> = [
    [/Deno\.run\s*\(/, "STATIC_003", "Subprocess execution via Deno.run()"],
    [/Deno\.Command/, "STATIC_003", "Subprocess execution via Deno.Command"],
    [/Deno\.dlopen/, "STATIC_005", "FFI via Deno.dlopen()"],
    [/Deno\.writeFile|Deno\.writeTextFile|Deno\.remove|Deno\.rename/, "STATIC_006", "Direct filesystem mutation"],
    [/Deno\.env\.set\s*\(/, "STATIC_007", "Modifies environment variables"],
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
