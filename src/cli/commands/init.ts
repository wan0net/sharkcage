/**
 * sharkcage init
 *
 * Three modes:
 * 1. New install — install OpenClaw + sharkcage together, sandboxed from the start
 * 2. Existing install — wrap a running OpenClaw with sharkcage (with warnings)
 * 3. Skills only — just the capability model for new skills, no outer sandbox
 */

import { mkdirSync, existsSync, writeFileSync } from "node:fs";
import * as p from "@clack/prompts";

type Mode = "new" | "existing" | "skills-only";

interface SharkcageConfig {
  mode: Mode;
  channels: string[];
  outerSandbox: boolean;
  openclawManaged: boolean;
}

const home = process.env.HOME ?? ".";
const configDir = `${home}/.config/sharkcage`;

export default async function init() {
  p.intro("sharkcage — OpenClaw, but you trust it.");

  // --- Mode ---
  const mode = await p.select({
    message: "How would you like to set up sharkcage?",
    options: [
      {
        value: "new" as Mode,
        label: "New install",
        hint: "Install OpenClaw + sharkcage together. Everything sandboxed from the start.",
      },
      {
        value: "existing" as Mode,
        label: "Existing OpenClaw install",
        hint: "Wrap your running OpenClaw with the outer sandbox. Existing skills need approval.",
      },
      {
        value: "skills-only" as Mode,
        label: "Skills only",
        hint: "Don't touch OpenClaw. Just sandbox new skills you install.",
      },
    ],
  });

  if (p.isCancel(mode)) { p.cancel("Cancelled."); process.exit(0); }

  // --- Warning for existing installs ---
  if (mode === "existing") {
    p.note(
      "Your existing skills have been running without a sandbox.\n" +
      "Sharkcage can't undo anything they've already done.\n" +
      "We recommend reviewing your installed skills before proceeding.",
      "Warning"
    );

    const proceed = await p.confirm({ message: "Continue?" });
    if (p.isCancel(proceed) || !proceed) { p.cancel("Cancelled."); process.exit(0); }
  }

  // --- Channels (new + existing only) ---
  let channels: string[] = ["webchat"];

  if (mode !== "skills-only") {
    const selected = await p.multiselect({
      message: "Which chat platforms?",
      options: [
        { value: "webchat", label: "Web Chat", hint: "built-in to OpenClaw" },
        { value: "signal", label: "Signal" },
        { value: "telegram", label: "Telegram" },
        { value: "whatsapp", label: "WhatsApp" },
        { value: "discord", label: "Discord" },
        { value: "slack", label: "Slack" },
        { value: "imessage", label: "iMessage" },
        { value: "matrix", label: "Matrix" },
      ],
      initialValues: ["webchat"],
      required: true,
    });

    if (p.isCancel(selected)) { p.cancel("Cancelled."); process.exit(0); }
    channels = selected;
  }

  // --- Config check ---
  mkdirSync(configDir, { recursive: true });
  const configPath = `${configDir}/sandcastle.json`;

  if (existsSync(configPath)) {
    const overwrite = await p.confirm({ message: "Config already exists. Overwrite?" });
    if (p.isCancel(overwrite) || !overwrite) {
      p.outro("Keeping existing config.");
      return;
    }
  }

  // --- Write config ---
  const config: SharkcageConfig = {
    mode,
    channels,
    outerSandbox: mode !== "skills-only",
    openclawManaged: mode === "new",
  };

  writeFileSync(configPath, JSON.stringify(config, null, 2) + "\n");

  // --- Create directories ---
  for (const dir of [`${configDir}/data`, `${configDir}/plugins`, `${configDir}/approvals`]) {
    mkdirSync(dir, { recursive: true });
  }

  // --- Next steps ---
  const steps: Record<Mode, string> = {
    "new": `1. Start sharkcage (installs OpenClaw if needed):
   sc start

2. Install skills:
   sc plugin add <url>

3. Open the dashboard:
   http://127.0.0.1:18789/sharkcage/`,

    "existing": `1. Stop your current OpenClaw:
   openclaw stop

2. Start through sharkcage:
   sc start

3. Review and approve existing skills:
   sc plugin list
   sc approve <skill-name>

4. Open the dashboard:
   http://127.0.0.1:18789/sharkcage/`,

    "skills-only": `1. Start the supervisor (OpenClaw stays as-is):
   sc start

2. Install skills through sharkcage:
   sc plugin add <url>

3. Skills run sandboxed. OpenClaw itself is not sandboxed.
   To add the outer sandbox later, re-run: sc init`,
  };

  p.note(steps[mode], "Next steps");
  p.outro("Setup complete.");
}
