const command = process.argv[2];

const commands: Record<string, () => Promise<void>> = {
  start: () => import("./commands/start.ts").then((m) => m.default()),
  stop: () => import("./commands/stop.ts").then((m) => m.default()),
  status: () => import("./commands/status.ts").then((m) => m.default()),
  init: () => import("./commands/init.ts").then((m) => m.default()),
  skill: () => import("./commands/plugin.ts").then((m) => m.default()),
  verify: () => import("./commands/verify.ts").then((m) => m.default()),
  approve: () => import("./commands/approve.ts").then((m) => m.default()),
  sign: () => import("./commands/sign.ts").then((m) => m.default()),
  trust: () => import("./commands/trust.ts").then((m) => m.default()),
  upgrade: () => import("./commands/upgrade.ts").then((m) => m.default()),
  config: () => import("./commands/config.ts").then((m) => m.default()),
  audit: () => import("./commands/audit.ts").then((m) => m.default()),
};

if (!command || command === "help" || command === "--help") {
  console.log(`sc — trust layer for OpenClaw

Commands:
  start                          Start sharkcage + sandboxed OpenClaw
  stop                           Stop sharkcage
  init                           Setup wizard
  status                         Show running status

  skill add <url|path>           Install a skill
  skill list                     List installed skills
  skill remove <name>            Remove a skill
  skill infer <name>             Infer capabilities from source

  approve <name>                 Review and approve skill capabilities
  verify <path>                  Scan a skill for issues
  sign <path>                    Sign a skill manifest
  trust <fingerprint>            Trust a skill signer

  config show                    Show gateway sandbox config
  config add-service <host>      Add a host to the outer sandbox
  config remove-service <host>   Remove a host from the outer sandbox

  upgrade                        Safely upgrade OpenClaw with rollback

  audit                          Show recent audit log entries
  audit --blocked                Show only blocked calls
`);
  process.exit(0);
}

const handler = commands[command];
if (!handler) {
  console.error(`Unknown command: ${command}\nRun 'sc help' for usage.`);
  process.exit(1);
}

await handler();
