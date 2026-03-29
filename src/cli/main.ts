const command = process.argv[2];

const commands: Record<string, () => Promise<void>> = {
  start: () => import("./commands/start.ts").then((m) => m.default()),
  stop: () => import("./commands/stop.ts").then((m) => m.default()),
  run: () => import("./commands/run.ts").then((m) => m.default()),
  status: () => import("./commands/status.ts").then((m) => m.default()),
  init: () => import("./commands/init.ts").then((m) => m.default()),
  plugin: () => import("./commands/plugin.ts").then((m) => m.default()),
  sign: () => import("./commands/sign.ts").then((m) => m.default()),
  verify: () => import("./commands/verify.ts").then((m) => m.default()),
  config: () => import("./commands/config.ts").then((m) => m.default()),
  audit: () => import("./commands/audit.ts").then((m) => m.default()),
  approve: () => import("./commands/approve.ts").then((m) => m.default()),
};

if (!command || command === "help" || command === "--help") {
  console.log(`sc — trust layer for OpenClaw

Commands:
  start                      Start sharkcage (installs deps, launches supervisor + OpenClaw)
  stop                       Stop sharkcage
  init                       Setup wizard
  status                     Show running status
  plugin add|list|remove     Skill management
  verify <path>              Scan a skill for issues
  approve <skill>            Review and approve capabilities
  config add-service|remove  Manage gateway services
  audit                      Query audit log
  run <project> "<prompt>"   Dispatch a coding task to fleet
  sign <path>                Sign a skill
`);
  process.exit(0);
}

const handler = commands[command];
if (!handler) {
  console.error(`Unknown command: ${command}\nRun 'sc help' for usage.`);
  process.exit(1);
}

await handler();
