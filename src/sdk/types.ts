// ============================================================================
// Tool definitions — OpenAI function calling format
// ============================================================================

export interface ToolDef {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
}

export interface ToolCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}

export interface Message {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  tool_call_id?: string;
  tool_calls?: ToolCall[];
}

// ============================================================================
// Plugins — extend the gateway with new tools that need infrastructure
// ============================================================================

/**
 * A plugin adds tools that call external services.
 * Plugins declare network/env/filesystem permissions they need.
 * Plugins must be signed and trusted before the gateway loads them.
 *
 * Examples: a weather API tool, a Jira integration, an MCP server bridge.
 */
export interface PluginManifest {
  name: string;
  version: string;
  type: "plugin";
  description: string;
  author?: string;
  homepage?: string;
  license?: string;

  /**
   * How the plugin is executed:
   * - "deno" (default): loaded as a Deno module in-process or subprocess
   * - "docker": run as a container, communicates via stdin/stdout JSON
   * - "process": run as an external subprocess with Deno permission flags
   */
  runtime?: "deno" | "docker" | "process";

  /** Docker image name (required when runtime is "docker") */
  image?: string;

  /** Named capabilities this plugin requests (user approves/denies) */
  capabilities: PluginCapability[];

  /** Entry point (TypeScript/JavaScript, used for deno/process runtimes) */
  main: string;

  /** Ed25519 signature of plugin contents */
  signature?: string;

  /** Signer's public key fingerprint */
  signer?: string;

  /** MCP server config, if this plugin wraps an MCP server */
  mcp?: McpConfig;
}

// ============================================================================
// Capabilities — named permissions that plugins request
// ============================================================================

/**
 * A named capability that a plugin requests.
 * Users see these during install and approve/deny each one.
 *
 * Capabilities are human-readable and map to enforcement rules
 * (Deno flags, network policies, etc.) under the hood.
 */
export interface PluginCapability {
  /** The capability identifier */
  capability: CapabilityName;
  /** Why the plugin needs this — shown to the user */
  reason: string;
  /** Scope narrows the capability (e.g., which hosts, which entities) */
  scope?: string[];
}

/**
 * Defined capability names. Each maps to specific enforcement rules.
 *
 * NETWORK:
 *   network.external    — Call external APIs (scope: host allowlist)
 *   network.internal    — Access LAN/Tailscale services (scope: host allowlist)
 *
 * HOME:
 *   home.read           — Read Home Assistant entity states (scope: entity patterns)
 *   home.control        — Control HA devices (scope: domain allowlist e.g. ["light", "climate"])
 *   home.automation     — Trigger HA automations
 *
 * DATA:
 *   data.meals          — Access meal/food storage data
 *   data.history        — Read conversation history
 *   data.memory         — Read/write long-term memory
 *   data.preferences    — Read user preferences
 *
 * FLEET:
 *   fleet.dispatch      — Dispatch coding tasks to Nomad
 *   fleet.read          — Read fleet status, logs, costs
 *   fleet.manage        — Drain/activate nodes (destructive)
 *
 * NOTIFY:
 *   notify.signal       — Send Signal messages
 *   notify.push         — Send push notifications
 *
 * SYSTEM:
 *   system.files.read   — Read files (scope: path allowlist)
 *   system.files.write  — Write files (scope: path allowlist)
 *   system.exec         — Run subprocesses (scope: binary allowlist)
 *   system.env          — Access environment variables (scope: var allowlist)
 *
 * COST:
 *   cost.api            — Make API calls that cost money (scope: provider names)
 */
export type CapabilityName =
  // Network
  | "network.external"
  | "network.internal"
  // Home
  | "home.read"
  | "home.control"
  | "home.automation"
  // Data
  | "data.meals"
  | "data.history"
  | "data.memory"
  | "data.preferences"
  // Fleet
  | "fleet.dispatch"
  | "fleet.read"
  | "fleet.manage"
  // Notify
  | "notify.signal"
  | "notify.push"
  // System (dangerous — always flagged)
  | "system.files.read"
  | "system.files.write"
  | "system.exec"
  | "system.env"
  // Cost
  | "cost.api";

/** Risk level of a capability — determines UI treatment during install */
export type CapabilityRisk = "low" | "medium" | "high" | "dangerous";

/** Metadata about a capability for display purposes */
export interface CapabilityInfo {
  name: CapabilityName;
  label: string;
  description: string;
  risk: CapabilityRisk;
}

/** The full capability registry — used by CLI and frontend for display */
export const CAPABILITY_REGISTRY: CapabilityInfo[] = [
  // Network
  { name: "network.external", label: "External Network", description: "Call APIs on the public internet", risk: "medium" },
  { name: "network.internal", label: "Internal Network", description: "Access services on your local network", risk: "medium" },
  // Home
  { name: "home.read", label: "Read Home State", description: "See sensor values, light states, temperatures", risk: "low" },
  { name: "home.control", label: "Control Devices", description: "Turn devices on/off, adjust settings", risk: "medium" },
  { name: "home.automation", label: "Trigger Automations", description: "Run Home Assistant automations", risk: "medium" },
  // Data
  { name: "data.meals", label: "Meal Data", description: "Access fridge, pantry, recipes, and meal history", risk: "low" },
  { name: "data.history", label: "Conversation History", description: "Read past conversations", risk: "medium" },
  { name: "data.memory", label: "Long-term Memory", description: "Read and write persistent facts", risk: "medium" },
  { name: "data.preferences", label: "User Preferences", description: "Read personal preferences and settings", risk: "low" },
  // Fleet
  { name: "fleet.dispatch", label: "Dispatch Tasks", description: "Send coding tasks to fleet machines", risk: "medium" },
  { name: "fleet.read", label: "Fleet Status", description: "See running jobs, node health, costs", risk: "low" },
  { name: "fleet.manage", label: "Manage Fleet", description: "Drain or activate fleet nodes", risk: "high" },
  // Notify
  { name: "notify.signal", label: "Send Messages", description: "Send Signal messages on your behalf", risk: "high" },
  { name: "notify.push", label: "Push Notifications", description: "Send push notifications to your devices", risk: "low" },
  // System
  { name: "system.files.read", label: "Read Files", description: "Read files on the filesystem", risk: "high" },
  { name: "system.files.write", label: "Write Files", description: "Create or modify files", risk: "dangerous" },
  { name: "system.exec", label: "Run Programs", description: "Execute programs and scripts", risk: "dangerous" },
  { name: "system.env", label: "Environment Variables", description: "Access system environment variables", risk: "high" },
  // Cost
  { name: "cost.api", label: "Paid API Calls", description: "Make API calls that incur costs", risk: "medium" },
];

/**
 * User's approval state for a plugin's capabilities.
 * Stored in ~/.config/sharkcage/approvals/{plugin-name}.json
 */
export interface CapabilityApproval {
  plugin: string;
  version: string;
  approved: CapabilityName[];
  denied: CapabilityName[];
  approvedAt: string; // ISO date
}

/**
 * Maps capabilities to Deno runtime permissions.
 * This is an internal detail — users never see Deno flags.
 */
export interface DenoPermissionMapping {
  net?: boolean | string[];
  env?: boolean | string[];
  read?: boolean | string[];
  write?: boolean | string[];
  run?: boolean | string[];
  ffi?: boolean;
}

/** Legacy — kept for backward compatibility with existing plugin loader */
export type PluginPermissions = DenoPermissionMapping;

export interface McpConfig {
  transport: "stdio" | "http";
  command?: string;
  args?: string[];
  url?: string;
  env?: Record<string, string>;
}

export interface ToolPlugin {
  /** Tool definition(s) this plugin provides */
  definitions: ToolDef[];

  /** Called once when the plugin is loaded */
  init?(): Promise<void>;

  /** Called when the gateway shuts down */
  cleanup?(): Promise<void>;

  /** Execute a tool call. Name will match one of the definitions. */
  execute(name: string, args: Record<string, unknown>): Promise<string>;
}

// ============================================================================
// Skills — self-contained capabilities that need no infrastructure
// ============================================================================

/**
 * A skill is a persona + instructions for using existing tools.
 * Skills don't add new tools — they teach the agent how to use
 * tools that are already loaded (from plugins or core).
 *
 * Skills are defined as SKILL.md files with YAML frontmatter.
 * They don't need signing because they contain no executable code.
 *
 * Examples: a "meal planner" skill that knows how to use meals_* tools,
 * a "home electrician" skill that knows HA entity patterns,
 * a "code reviewer" skill that knows how to use fleet tools for reviews.
 */
export interface SkillManifest {
  name: string;
  version: string;
  type: "skill";
  description: string;
  author?: string;

  /** Optional metadata */
  metadata?: {
    emoji?: string;
    /** Tools this skill expects to be available (informational, not enforced) */
    uses_tools?: string[];
    /** Tags for discovery */
    tags?: string[];
  };
}

export interface Skill {
  manifest: SkillManifest;
  /** The full SKILL.md content (injected into system prompt when active) */
  instructions: string;
}

// ============================================================================
// Channels — input/output adapters
// ============================================================================

export interface InboundMessage {
  channelType: string;
  channelId: string;
  userId: string;
  userName: string;
  text: string;
  timestamp: Date;
}

export interface OutboundMessage {
  channelType: string;
  channelId: string;
  text: string;
}

export interface Channel {
  name: string;
  start(): Promise<void>;
  stop(): Promise<void>;
  send(msg: OutboundMessage): Promise<void>;
  onMessage(handler: (msg: InboundMessage) => void): void;
}

// ============================================================================
// Signing & Trust
// ============================================================================

export type TrustLevel = "full" | "prompt" | "audit";

export interface TrustedSigner {
  name: string;
  fingerprint: string;
  public_key: string;
  trust: TrustLevel;
}

export interface TrustStore {
  signers: TrustedSigner[];
}

export interface SignatureResult {
  valid: boolean;
  signer?: string;
  fingerprint?: string;
  error?: string;
}

// ============================================================================
// Scanning — plugin and skill validation
// ============================================================================

export type ScanSeverity = "error" | "warning" | "info";

export interface ScanFinding {
  severity: ScanSeverity;
  code: string;
  message: string;
  file?: string;
  line?: number;
}

export interface ScanResult {
  passed: boolean;
  findings: ScanFinding[];
}

/**
 * Scan codes:
 *
 * PLUGIN_001  Missing or invalid plugin.json
 * PLUGIN_002  Unsigned plugin
 * PLUGIN_003  Signature verification failed
 * PLUGIN_004  Requests dangerous permissions (run, ffi, write)
 * PLUGIN_005  Requests net: true (unrestricted network)
 * PLUGIN_006  Tool definition missing description
 * PLUGIN_007  Tool definition missing parameter schema
 * PLUGIN_008  MCP config missing required fields
 *
 * SKILL_001   Missing or invalid SKILL.md frontmatter
 * SKILL_002   References tools that don't exist in any loaded plugin
 * SKILL_003   Contains executable code blocks (skills should be instructions only)
 */

// ============================================================================
// Gateway config (shared types)
// ============================================================================

export interface GatewayConfig {
  /** Nomad API address */
  nomad_addr: string;
  /** Default runtime and model for coding tasks */
  defaults: { runtime: string; model: string };
  /** Per-project overrides */
  projects: Record<string, { runtime?: string; model?: string }>;
  /** Signal channel config */
  signal_cli_url: string;
  signal_account: string;
  signal_allowed_numbers: string[];
  /** LLM inference */
  openrouter_api_key: string;
  openrouter_model: string;
  /** Webhook server */
  webhook_port: number;
  /** Data directory for SQLite and logs */
  data_dir: string;
}
