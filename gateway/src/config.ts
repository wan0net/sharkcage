export interface ProjectConfig {
  runtime?: string;
  model?: string;
}

export interface GatewayConfig {
  nomad_addr: string;
  defaults: { runtime: string; model: string };
  projects: Record<string, ProjectConfig>;
  signal_cli_url: string;
  signal_account: string;
  signal_allowed_numbers: string[];
  openrouter_api_key: string;
  openrouter_model: string;
  webhook_port: number;
  data_dir: string;
  ntfy_topic?: string;
}

const DEFAULT_CONFIG: GatewayConfig = {
  nomad_addr: "http://localhost:4646",
  defaults: { runtime: "opencode", model: "anthropic/claude-sonnet-4" },
  projects: {},
  signal_cli_url: "http://127.0.0.1:7583",
  signal_account: "",
  signal_allowed_numbers: [],
  openrouter_api_key: "",
  openrouter_model: "anthropic/claude-3-5-haiku-20241022",
  webhook_port: 8787,
  data_dir: "./data",
};

export function loadConfig(): GatewayConfig {
  const home = Deno.env.get("HOME") ?? Deno.env.get("USERPROFILE") ?? ".";
  const configPath = `${home}/.config/yeet/gateway.json`;
  try {
    const raw = Deno.readTextFileSync(configPath);
    const parsed = JSON.parse(raw) as Partial<GatewayConfig>;
    return {
      ...DEFAULT_CONFIG,
      ...parsed,
      defaults: { ...DEFAULT_CONFIG.defaults, ...parsed.defaults },
      signal_allowed_numbers: parsed.signal_allowed_numbers ?? DEFAULT_CONFIG.signal_allowed_numbers,
    };
  } catch {
    return DEFAULT_CONFIG;
  }
}

function env(key: string): string | undefined {
  return Deno.env.get(key);
}

export function getConfig(): GatewayConfig {
  const cfg = loadConfig();
  return {
    ...cfg,
    nomad_addr: env("NOMAD_ADDR") ?? cfg.nomad_addr,
    signal_cli_url: env("SIGNAL_CLI_URL") ?? cfg.signal_cli_url,
    signal_account: env("SIGNAL_ACCOUNT") ?? cfg.signal_account,
    openrouter_api_key: env("OPENROUTER_API_KEY") ?? cfg.openrouter_api_key,
    openrouter_model: env("OPENROUTER_MODEL") ?? cfg.openrouter_model,
    webhook_port: env("WEBHOOK_PORT") ? parseInt(env("WEBHOOK_PORT")!, 10) : cfg.webhook_port,
    data_dir: env("GATEWAY_DATA_DIR") ?? cfg.data_dir,
  };
}

export function getNomadAddr(): string {
  return env("NOMAD_ADDR") ?? loadConfig().nomad_addr;
}

export function getNomadToken(): string | undefined {
  return env("NOMAD_TOKEN");
}

export function getProjectConfig(project: string): { runtime: string; model: string } {
  const cfg = loadConfig();
  const proj = cfg.projects[project];
  return {
    runtime: proj?.runtime ?? cfg.defaults.runtime,
    model: proj?.model ?? cfg.defaults.model,
  };
}
