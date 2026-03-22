#!/usr/bin/env node

import { getProjectConfig } from "./config.js";
import * as nomad from "./nomad.js";

// --- Formatting helpers ---
const bold = (t: string) => `\x1b[1m${t}\x1b[0m`;
const dim = (t: string) => `\x1b[2m${t}\x1b[0m`;
const green = (t: string) => `\x1b[32m${t}\x1b[0m`;
const red = (t: string) => `\x1b[31m${t}\x1b[0m`;
const yellow = (t: string) => `\x1b[33m${t}\x1b[0m`;

function table(headers: string[], rows: string[][]): string {
  const widths = headers.map((h, i) =>
    Math.max(h.length, ...rows.map((r) => (r[i] ?? "").length))
  );
  const sep = widths.map((w) => "-".repeat(w)).join("  ");
  const fmt = (row: string[]) => row.map((c, i) => (c ?? "").padEnd(widths[i])).join("  ");
  return [bold(fmt(headers)), dim(sep), ...rows.map((r) => fmt(r))].join("\n");
}

function parseOpts(args: string[]): { positional: string[]; flags: Record<string, string> } {
  const positional: string[] = [];
  const flags: Record<string, string> = {};
  for (let i = 0; i < args.length; i++) {
    if (args[i].startsWith("--")) {
      const key = args[i].slice(2);
      flags[key] = args[++i] ?? "";
    } else {
      positional.push(args[i]);
    }
  }
  return { positional, flags };
}

// --- Commands ---

async function cmdRun(args: string[]) {
  const { positional, flags } = parseOpts(args);
  const project = positional[0];
  const prompt = positional[1];
  if (!project || !prompt) return console.error("Usage: yeet run <project> \"<prompt>\" [options]");

  const defaults = getProjectConfig(project);
  const meta: Record<string, string> = {
    runtime: flags.runtime ?? defaults.runtime,
    model: flags.model ?? defaults.model,
    mode: flags.mode ?? "unspecified-low",
  };
  if (flags.budget) meta.budget = flags.budget;
  if (flags.session) meta.session_id = flags.session;
  if (flags.needs) meta.needs_device = flags.needs;

  const res = await nomad.dispatch(project, prompt, meta);
  console.log(green(`Dispatched: ${res.DispatchedJobID}`));
  console.log(dim(`Logs: yeet logs ${res.DispatchedJobID}`));
}

async function cmdStatus() {
  const jobs = await nomad.listJobs("batch");
  const agentJobs = jobs.filter((j) => String(j.ParentID) === "run-coding-agent" || String(j.ID).startsWith("run-coding-agent/"));
  if (!agentJobs.length) return console.log(dim("No active dispatches."));

  const rows = agentJobs.map((j) => {
    const meta = (j.Meta ?? {}) as Record<string, string>;
    const status = String(j.Status);
    const colored = status === "running" ? green(status) : status === "dead" ? dim(status) : yellow(status);
    return [String(j.ID).slice(-20), meta.project ?? "-", meta.runtime ?? "-", colored, String(j.SubmitTime ?? "-").slice(0, 19)];
  });
  console.log(table(["ID", "Project", "Runtime", "Status", "Started"], rows));
}

async function cmdLogs(args: string[]) {
  const jobId = args[0];
  if (!jobId) return console.error("Usage: yeet logs <job-id>");

  const allocs = await nomad.getJobAllocations(jobId);
  if (!allocs.length) return console.error(red("No allocations found for job."));
  const allocId = String(allocs[0].ID);
  await nomad.streamLogs(allocId, "execute", true);
}

async function cmdStop(args: string[]) {
  const jobId = args[0];
  if (!jobId) return console.error("Usage: yeet stop <job-id>");
  await nomad.stopJob(jobId);
  console.log(green(`Stopped: ${jobId}`));
}

async function cmdContinue(args: string[]) {
  const { positional } = parseOpts(args);
  const jobId = positional[0];
  const prompt = positional[1];
  if (!jobId || !prompt) return console.error("Usage: yeet continue <job-id> \"<prompt>\"");

  const sessionVar = await nomad.getVar(`sessions/${jobId}`);
  const sessionId = sessionVar ? String((sessionVar.Items as Record<string, string>)?.session_id ?? jobId) : jobId;

  const job = await nomad.getJob(jobId);
  const meta = (job.Meta ?? {}) as Record<string, string>;
  const project = meta.project;
  if (!project) return console.error(red("Could not determine project from original job."));

  const newMeta: Record<string, string> = { ...meta, session_id: sessionId };
  const res = await nomad.dispatch(project, prompt, newMeta);
  console.log(green(`Continued: ${res.DispatchedJobID}`));
  console.log(dim(`Session: ${sessionId}`));
}

async function cmdRunners() {
  const nodes = await nomad.listNodes();
  if (!nodes.length) return console.log(dim("No nodes found."));

  const rows = nodes.map((n) => {
    const meta = (n.Meta ?? {}) as Record<string, string>;
    const projects = Object.keys(meta).filter((k) => k.startsWith("project_") && meta[k] === "true").map((k) => k.replace("project_", ""));
    const devices = Object.keys(meta).filter((k) => k.startsWith("device_") && !k.includes("_path") && meta[k] === "true").map((k) => k.replace("device_", ""));
    const status = String(n.Status);
    const colored = status === "ready" ? green(status) : status === "down" ? red(status) : yellow(status);
    return [String(n.Name), colored, projects.join(", ") || "-", devices.join(", ") || "-"];
  });
  console.log(table(["Name", "Status", "Projects", "Devices"], rows));
}

async function cmdDrain(args: string[]) {
  const name = args[0];
  if (!name) return console.error("Usage: yeet drain <node-name>");
  const nodes = await nomad.listNodes();
  const node = nodes.find((n) => String(n.Name) === name);
  if (!node) return console.error(red(`Node not found: ${name}`));
  await nomad.drainNode(String(node.ID));
  console.log(yellow(`Draining: ${name}`));
}

async function cmdActivate(args: string[]) {
  const name = args[0];
  if (!name) return console.error("Usage: yeet activate <node-name>");
  const nodes = await nomad.listNodes();
  const node = nodes.find((n) => String(n.Name) === name);
  if (!node) return console.error(red(`Node not found: ${name}`));
  await nomad.enableNode(String(node.ID));
  console.log(green(`Activated: ${name}`));
}

async function cmdCost(args: string[]) {
  const { flags } = parseOpts(args);
  const _period = flags.period ?? "month"; // eslint-disable-line @typescript-eslint/no-unused-vars
  const vars = await nomad.listVars("cost/");
  if (!vars.length) return console.log(dim("No cost data found."));

  const byProject: Record<string, { tasks: number; cost: number }> = {};
  for (const v of vars) {
    const items = (v.Items ?? {}) as Record<string, string>;
    const project = items.project ?? "unknown";
    const cost = parseFloat(items.cost_usd ?? "0");
    if (!byProject[project]) byProject[project] = { tasks: 0, cost: 0 };
    byProject[project].tasks++;
    byProject[project].cost += cost;
  }

  const rows = Object.entries(byProject).map(([p, d]) => [p, String(d.tasks), `$${d.cost.toFixed(4)}`]);
  console.log(table(["Project", "Tasks", "Total Cost"], rows));
}

async function cmdPolicy(args: string[]) {
  const jobId = args[0];
  if (!jobId) return console.error("Usage: yeet policy <job-id>");
  const policyVar = await nomad.getVar(`policies/${jobId}`);
  if (!policyVar) return console.log(dim("No policy found for this job."));
  const items = (policyVar.Items ?? {}) as Record<string, string>;
  console.log(items.policy ?? JSON.stringify(items, null, 2));
}

function cmdHelp() {
  console.log(`${bold("yeet")} — agent-agnostic coding orchestrator

${bold("Usage:")}
  yeet <command> [args] [options]

${bold("Commands:")}
  run <project> "<prompt>"     Dispatch a coding agent job
    --runtime <rt>             Runtime (default: from config)
    --model <model>            Model (default: from config)
    --mode <mode>              Mode (default: unspecified-low)
    --budget <n>               Token budget
    --session <id>             Resume session
    --needs <device>           Require device (e.g., yubikey)

  status                       List active/recent dispatched jobs
  logs <job-id>                Stream logs from a job
  stop <job-id>                Stop a running job
  continue <job-id> "<prompt>" Continue a previous session
  runners                      List fleet nodes
  drain <node-name>            Drain a node
  activate <node-name>         Re-enable a drained node
  cost [--period day|week|month]  Show cost breakdown
  policy <job-id>              Show sandbox policy for a job
  help                         Show this help

${bold("Config:")} ~/.config/yeet/config.json
${bold("Env:")} NOMAD_ADDR, NOMAD_TOKEN`);
}

// --- Main ---

const [cmd, ...args] = process.argv.slice(2);

const commands: Record<string, (args: string[]) => Promise<void> | void> = {
  run: cmdRun, status: () => cmdStatus(), logs: cmdLogs, stop: cmdStop,
  continue: cmdContinue, runners: () => cmdRunners(), drain: cmdDrain,
  activate: cmdActivate, cost: cmdCost, policy: cmdPolicy, help: () => cmdHelp(),
};

const handler = commands[cmd ?? "help"];
if (!handler) {
  console.error(red(`Unknown command: ${cmd}`));
  cmdHelp();
  process.exit(1);
}

Promise.resolve(handler(args)).catch((err: Error) => {
  console.error(red(`Error: ${err.message}`));
  process.exit(1);
});
