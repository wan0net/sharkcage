import type { ToolPlugin, ToolDef, ScanResult, ScanFinding, PluginManifest, SkillManifest, CapabilityRisk } from "./types.js";
import { CAPABILITY_REGISTRY } from "./types.js";

/**
 * Test a tool plugin by calling each of its defined tools with sample args.
 * Returns results for each tool call.
 */
export async function testPlugin(
  plugin: ToolPlugin,
  calls: Array<{ name: string; args: Record<string, unknown> }>
): Promise<Array<{ name: string; result: string; error?: string }>> {
  if (plugin.init) await plugin.init();

  const results = [];
  for (const call of calls) {
    try {
      const result = await plugin.execute(call.name, call.args);
      results.push({ name: call.name, result });
    } catch (err) {
      results.push({
        name: call.name,
        result: "",
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  if (plugin.cleanup) await plugin.cleanup();
  return results;
}

/**
 * Scan a plugin manifest for common issues.
 */
export function scanPluginManifest(manifest: PluginManifest): ScanResult {
  const findings: ScanFinding[] = [];

  if (!manifest.name) {
    findings.push({ severity: "error", code: "PLUGIN_001", message: "Missing plugin name" });
  }
  if (!manifest.version) {
    findings.push({ severity: "error", code: "PLUGIN_001", message: "Missing plugin version" });
  }
  if (!manifest.main) {
    findings.push({ severity: "error", code: "PLUGIN_001", message: "Missing plugin entry point (main)" });
  }
  if (!manifest.signature) {
    findings.push({ severity: "warning", code: "PLUGIN_002", message: "Plugin is unsigned" });
  }

  // Scan capabilities for risk
  const capabilities = manifest.capabilities ?? [];
  if (capabilities.length === 0) {
    findings.push({ severity: "warning", code: "PLUGIN_004", message: "Plugin declares no capabilities" });
  }
  for (const cap of capabilities) {
    const info = CAPABILITY_REGISTRY.find((c) => c.name === cap.capability);
    if (!info) {
      findings.push({ severity: "error", code: "PLUGIN_004", message: `Unknown capability: ${cap.capability}` });
      continue;
    }
    if (!cap.reason) {
      findings.push({ severity: "warning", code: "PLUGIN_004", message: `Capability "${cap.capability}" missing reason` });
    }

    // Flag by risk level
    const severityMap: Record<CapabilityRisk, "info" | "warning" | "error"> = {
      low: "info",
      medium: "info",
      high: "warning",
      dangerous: "warning",
    };
    const severity = severityMap[info.risk];

    // Unscoped dangerous capabilities are extra suspicious
    if ((info.risk === "high" || info.risk === "dangerous") && (!cap.scope || cap.scope.length === 0)) {
      findings.push({
        severity: "warning",
        code: "PLUGIN_005",
        message: `${info.label} (${info.risk}) requested without scope — plugin could abuse this`,
      });
    } else {
      findings.push({
        severity,
        code: "PLUGIN_OK",
        message: `${info.label} (${info.risk})${cap.scope ? `: ${cap.scope.join(", ")}` : ""}`,
      });
    }
  }

  return {
    passed: !findings.some((f) => f.severity === "error"),
    findings,
  };
}

/**
 * Scan tool definitions for completeness.
 */
export function scanToolDefs(defs: ToolDef[]): ScanResult {
  const findings: ScanFinding[] = [];

  for (const def of defs) {
    if (!def.function.description) {
      findings.push({
        severity: "error",
        code: "PLUGIN_006",
        message: `Tool "${def.function.name}" missing description`,
      });
    }
    if (!def.function.parameters || Object.keys(def.function.parameters).length === 0) {
      findings.push({
        severity: "info",
        code: "PLUGIN_007",
        message: `Tool "${def.function.name}" has no parameter schema`,
      });
    }
  }

  return {
    passed: !findings.some((f) => f.severity === "error"),
    findings,
  };
}

/**
 * Scan a SKILL.md frontmatter for issues.
 */
export function scanSkillManifest(manifest: SkillManifest, availableTools: string[]): ScanResult {
  const findings: ScanFinding[] = [];

  if (!manifest.name) {
    findings.push({ severity: "error", code: "SKILL_001", message: "Missing skill name" });
  }
  if (!manifest.version) {
    findings.push({ severity: "error", code: "SKILL_001", message: "Missing skill version" });
  }

  if (manifest.metadata?.uses_tools) {
    for (const tool of manifest.metadata.uses_tools) {
      if (!availableTools.includes(tool)) {
        findings.push({
          severity: "warning",
          code: "SKILL_002",
          message: `Skill references tool "${tool}" which is not available`,
        });
      }
    }
  }

  return {
    passed: !findings.some((f) => f.severity === "error"),
    findings,
  };
}
