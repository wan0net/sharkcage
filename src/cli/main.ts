import { Command } from "commander";

const program = new Command();

program
  .name("sc")
  .description("sharkcage — trust layer for OpenClaw")
  .version("1.2.0");

program
  .command("start")
  .description("Start sharkcage + sandboxed OpenClaw")
  .option("--foreground", "Stay in foreground (for systemd)")
  .action(async (opts: { foreground?: boolean }) => {
    const m = await import("./commands/start.ts");
    await m.default({ foreground: opts.foreground });
  });

program
  .command("stop")
  .description("Stop sharkcage")
  .action(async () => {
    const m = await import("./commands/stop.ts");
    await m.default();
  });

program
  .command("status")
  .description("Show running status")
  .action(async () => {
    const m = await import("./commands/status.ts");
    await m.default();
  });

program
  .command("init")
  .description("Setup wizard")
  .option("--non-interactive", "Fail instead of prompting; use defaults/flags where possible")
  .option("--mode <mode>", "Sandbox mode: full | skills-only")
  .option("--service-user <user>", "Create/use a dedicated runtime user")
  .option("--no-service-user", "Do not configure a dedicated runtime user")
  .option("--install-service", "Install a systemd service")
  .option("--enable-service", "Enable the systemd service")
  .option("--start-service", "Start the systemd service")
  .action(async (opts: {
    nonInteractive?: boolean;
    mode?: string;
    serviceUser?: string | boolean;
    installService?: boolean;
    enableService?: boolean;
    startService?: boolean;
  }) => {
    const m = await import("./commands/init.ts");
    await m.default(opts);
  });

program
  .command("skill")
  .description("Manage skills (add | list | remove | infer)")
  .argument("<action>", "add | list | remove | infer")
  .argument("[args...]", "Additional arguments")
  .action(async () => {
    const m = await import("./commands/plugin.ts");
    await m.default();
  });

program
  .command("approve")
  .description("Review and approve skill capabilities")
  .argument("<name>", "Skill name")
  .action(async () => {
    const m = await import("./commands/approve.ts");
    await m.default();
  });

program
  .command("verify")
  .description("Scan a skill for issues")
  .argument("<path>", "Path to skill")
  .action(async () => {
    const m = await import("./commands/verify.ts");
    await m.default();
  });

program
  .command("sign")
  .description("Sign a skill manifest")
  .argument("<path>", "Path to skill")
  .action(async () => {
    const m = await import("./commands/sign.ts");
    await m.default();
  });

program
  .command("trust")
  .description("Trust a skill signer")
  .argument("<fingerprint>", "Signer fingerprint")
  .action(async () => {
    const m = await import("./commands/trust.ts");
    await m.default();
  });

program
  .command("config")
  .description("Manage gateway sandbox config (show | add-service | remove-service)")
  .argument("<action>", "show | add-service | remove-service")
  .argument("[args...]", "Additional arguments")
  .action(async () => {
    const m = await import("./commands/config.ts");
    await m.default();
  });

program
  .command("upgrade")
  .description("Safely upgrade OpenClaw with rollback")
  .action(async () => {
    const m = await import("./commands/upgrade.ts");
    await m.default();
  });

program
  .command("user")
  .description("Manage dedicated OpenClaw user (copy-in | shell | home | info)")
  .argument("<action>", "copy-in | shell | home | info")
  .argument("[args...]", "Additional arguments")
  .option("--mode <perms>", "File permissions (e.g. 600, 755)")
  .option("--dest <path>", "Destination path relative to user home")
  .action(async (action: string, args: string[], options: { mode?: string; dest?: string }) => {
    const m = await import("./commands/user.ts");
    await m.default(action, args, options);
  });

program
  .command("audit")
  .description("Show recent audit log entries")
  .option("--blocked", "Show only blocked calls")
  .option("--skill <name>", "Filter by skill name")
  .option("--tool <name>", "Filter by tool name")
  .option("--tail <n>", "Show last N entries")
  .action(async () => {
    const m = await import("./commands/audit.ts");
    await m.default();
  });

program.parse();
