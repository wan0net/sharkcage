import type { CapabilityName } from "../sdk/types.js";

export interface ResourceRequirements {
  /** Environment variables required by this capability */
  env?: string[];
  /** Default network domains required by this capability (can be overridden by scope) */
  network?: string[];
  /** Environment variable that contains a dynamic network domain (e.g. HA_URL) */
  networkFromEnv?: string;
  /** File paths required by this capability (can be overridden by scope) */
  files?: string[];
  /** Patterns used to detect this capability in source code during inference */
  detection?: {
    patterns: (string | RegExp)[];
    label: string;
  };
}

/**
 * Mapping from functional capability names to the low-level resources they grant.
 * 
 * This keeps the supervisor's execution logic generic. To add a new capability,
 * just add an entry here.
 */
export const CAPABILITY_RESOURCE_MAP: Record<string, ResourceRequirements> = {
  "home.read": {
    env: ["HA_URL", "HA_TOKEN"],
    networkFromEnv: "HA_URL",
    network: ["homeassistant.local:8123"],
    detection: {
      patterns: ["8123", "HA_URL", "HA_TOKEN", "home-assistant", "/api/states"],
      label: "Home Assistant API"
    }
  },
  "home.control": {
    env: ["HA_URL", "HA_TOKEN"],
    networkFromEnv: "HA_URL",
    network: ["homeassistant.local:8123"],
    detection: {
      patterns: [/\/api\/services\/[\w]+.*POST/, /fetch.*\/api\/services/],
      label: "Home Assistant control services"
    }
  },
  "home.automation": {
    env: ["HA_URL", "HA_TOKEN"],
    networkFromEnv: "HA_URL",
    network: ["homeassistant.local:8123"]
  },
  "data.meals": {
    env: ["MEALS_API_URL", "MEALS_API_TOKEN"],
    networkFromEnv: "MEALS_API_URL",
    network: ["localhost:8788"],
    detection: {
      patterns: ["MEALS_API", "meals", "fridge", "pantry", "recipe"],
      label: "meal/food data"
    }
  },
  "data.history": {
    detection: {
      patterns: ["conversation_history", "history"],
      label: "conversation history"
    }
  },
  "data.memory": {
    detection: {
      patterns: ["memory", "remember", "recall"],
      label: "memory/recall operations"
    }
  },
  "fleet.dispatch": {
    env: ["NOMAD_ADDR", "NOMAD_TOKEN"],
    networkFromEnv: "NOMAD_ADDR",
    network: ["localhost:4646"],
    detection: {
      patterns: ["NOMAD_ADDR", "nomad", "/v1/jobs", "/v1/allocations"],
      label: "Nomad API"
    }
  },
  "fleet.read": {
    env: ["NOMAD_ADDR", "NOMAD_TOKEN"],
    networkFromEnv: "NOMAD_ADDR",
    network: ["localhost:4646"]
  },
  "fleet.manage": {
    env: ["NOMAD_ADDR", "NOMAD_TOKEN"],
    networkFromEnv: "NOMAD_ADDR",
    network: ["localhost:4646"]
  },
  "cost.api": {
    env: ["OPENROUTER_API_KEY"],
    detection: {
      patterns: ["openai", "anthropic", "OPENROUTER", "workers-ai", "gpt", "claude", /\bllm\b/],
      label: "paid AI APIs"
    }
  },
  "notify.signal": {
    env: ["SIGNAL_CLI_URL", "SIGNAL_ACCOUNT"],
    detection: {
      patterns: ["signal", "signal-cli"],
      label: "Signal messaging"
    }
  },
  "notify.push": {
    detection: {
      patterns: ["ntfy", "pushover", /push\s*\(/],
      label: "push notification services"
    }
  }
};

/**
 * Get all possible environment variables that the supervisor might need to pass to skills.
 */
export function getAllServiceEnvVars(): string[] {
  const envVars = new Set<string>();
  for (const resource of Object.values(CAPABILITY_RESOURCE_MAP)) {
    if (resource.env) resource.env.forEach(v => envVars.add(v));
    if (resource.networkFromEnv) envVars.add(resource.networkFromEnv);
  }
  return [...envVars];
}
