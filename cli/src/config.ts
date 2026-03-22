import { readFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

export interface ProjectConfig {
  runtime?: string;
  model?: string;
}

export interface Config {
  nomad_addr: string;
  defaults: { runtime: string; model: string };
  projects: Record<string, ProjectConfig>;
  ntfy_topic?: string;
}

const DEFAULT_CONFIG: Config = {
  nomad_addr: "http://yeet-01.tailnet:4646",
  defaults: { runtime: "opencode", model: "anthropic/claude-sonnet-4" },
  projects: {},
};

export function loadConfig(): Config {
  const configPath = join(homedir(), ".config", "yeet", "config.json");
  try {
    const raw = readFileSync(configPath, "utf-8");
    const parsed = JSON.parse(raw) as Partial<Config>;
    return { ...DEFAULT_CONFIG, ...parsed, defaults: { ...DEFAULT_CONFIG.defaults, ...parsed.defaults } };
  } catch {
    return DEFAULT_CONFIG;
  }
}

export function getProjectConfig(project: string): { runtime: string; model: string } {
  const cfg = loadConfig();
  const proj = cfg.projects[project];
  return {
    runtime: proj?.runtime ?? cfg.defaults.runtime,
    model: proj?.model ?? cfg.defaults.model,
  };
}

export function getNomadAddr(): string {
  return process.env["NOMAD_ADDR"] ?? loadConfig().nomad_addr;
}

export function getNomadToken(): string | undefined {
  return process.env["NOMAD_TOKEN"];
}
