export interface SandboxStartupDecision {
  allowed: boolean;
  mode: "secure" | "insecure";
  message?: string;
}

export function resolveSandboxStartupDecision(hasAsrt: boolean): SandboxStartupDecision {
  if (hasAsrt) return { allowed: true, mode: "secure" };

  if (process.env.SHARKCAGE_ALLOW_INSECURE === "1") {
    return {
      allowed: true,
      mode: "insecure",
      message: "srt not found — running in explicitly allowed insecure mode",
    };
  }

  return {
    allowed: false,
    mode: "insecure",
    message: "srt not found — refusing to start without kernel sandbox. Set SHARKCAGE_ALLOW_INSECURE=1 only for development.",
  };
}
