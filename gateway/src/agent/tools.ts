import type { ToolDef } from "./inference.ts";
import * as nomad from "../nomad.ts";
import { getProjectConfig } from "../config.ts";
import { mealToolDefs, executeMealTool } from "../tools/meals.ts";

const yeetToolDefs: ToolDef[] = [
  {
    type: "function",
    function: {
      name: "dispatch_task",
      description: "Dispatch a coding agent task to the fleet. Use when the user wants to run, implement, fix, review, or test something on a project.",
      parameters: {
        type: "object",
        properties: {
          project: { type: "string", description: "Project name (e.g., peer6, login2)" },
          prompt: { type: "string", description: "The coding task description" },
          runtime: { type: "string", description: "Runtime override: opencode, claude, or aider" },
          model: { type: "string", description: "Model override" },
          mode: { type: "string", enum: ["implement", "test", "review", "analyze", "unspecified-low"], description: "Task mode (default: unspecified-low)" },
          budget: { type: "string", description: "Cost budget cap in USD" },
          session_id: { type: "string", description: "Session ID to resume a previous task" },
          needs_device: { type: "string", description: "Required USB device (e.g., yubikey)" },
        },
        required: ["project", "prompt"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "fleet_status",
      description: "Show status of active jobs and fleet nodes. Use when the user asks what's running, fleet health, or wants a status update.",
      parameters: {
        type: "object",
        properties: {
          filter: { type: "string", enum: ["jobs", "runners", "all"], description: "What to show (default: all)" },
        },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "read_logs",
      description: "Read recent logs from a running or completed job.",
      parameters: {
        type: "object",
        properties: {
          job_id: { type: "string", description: "Job ID or partial match" },
        },
        required: ["job_id"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "stop_job",
      description: "Stop a running job. Use when the user wants to cancel or kill a task.",
      parameters: {
        type: "object",
        properties: {
          job_id: { type: "string", description: "Job ID to stop" },
        },
        required: ["job_id"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "continue_session",
      description: "Continue a previous coding session with new instructions.",
      parameters: {
        type: "object",
        properties: {
          job_id: { type: "string", description: "Previous job ID to continue" },
          prompt: { type: "string", description: "New instructions" },
        },
        required: ["job_id", "prompt"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "manage_node",
      description: "Drain or activate a fleet node.",
      parameters: {
        type: "object",
        properties: {
          action: { type: "string", enum: ["drain", "activate"], description: "Action to perform" },
          node_name: { type: "string", description: "Node name (e.g., yeet-01, yeet-02)" },
        },
        required: ["action", "node_name"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "cost_report",
      description: "Show cost breakdown by project.",
      parameters: {
        type: "object",
        properties: {},
      },
    },
  },
];

// Combined tool definitions from all domains
export const toolDefs: ToolDef[] = [...yeetToolDefs, ...mealToolDefs];

export async function executeTool(name: string, args: Record<string, unknown>): Promise<string> {
  // Route meal tools to their executor
  if (name.startsWith("meals_")) {
    return executeMealTool(name, args);
  }

  try {
    switch (name) {
      case "dispatch_task":
        return await execDispatch(args);
      case "fleet_status":
        return await execStatus(args);
      case "read_logs":
        return await execLogs(args);
      case "stop_job":
        return await execStop(args);
      case "continue_session":
        return await execContinue(args);
      case "manage_node":
        return await execManageNode(args);
      case "cost_report":
        return await execCost();
      default:
        return `Unknown tool: ${name}`;
    }
  } catch (err) {
    return `Error: ${err instanceof Error ? err.message : String(err)}`;
  }
}

async function execDispatch(args: Record<string, unknown>): Promise<string> {
  const project = String(args.project);
  const prompt = String(args.prompt);
  const defaults = getProjectConfig(project);

  const meta: Record<string, string> = {
    runtime: String(args.runtime ?? defaults.runtime),
    model: String(args.model ?? defaults.model),
    mode: String(args.mode ?? "unspecified-low"),
  };
  if (args.budget) meta.budget = String(args.budget);
  if (args.session_id) meta.session_id = String(args.session_id);
  if (args.needs_device) meta.needs_device = String(args.needs_device);

  const res = await nomad.dispatch(project, prompt, meta);
  return JSON.stringify({
    status: "dispatched",
    job_id: res.DispatchedJobID,
    project,
    runtime: meta.runtime,
    model: meta.model,
    mode: meta.mode,
  });
}

async function execStatus(args: Record<string, unknown>): Promise<string> {
  const filter = String(args.filter ?? "all");
  const result: Record<string, unknown> = {};

  if (filter === "all" || filter === "jobs") {
    const jobs = await nomad.listJobs("batch");
    const agentJobs = jobs.filter(
      (j) => String(j.ParentID) === "run-coding-agent" || String(j.ID).startsWith("run-coding-agent/")
    );
    result.jobs = agentJobs.map((j) => {
      const meta = (j.Meta ?? {}) as Record<string, string>;
      return {
        id: String(j.ID).slice(-20),
        project: meta.project ?? "-",
        runtime: meta.runtime ?? "-",
        status: String(j.Status),
        submitted: String(j.SubmitTime ?? "-").slice(0, 19),
      };
    });
  }

  if (filter === "all" || filter === "runners") {
    const nodes = await nomad.listNodes();
    result.runners = nodes.map((n) => {
      const meta = (n.Meta ?? {}) as Record<string, string>;
      const projects = Object.keys(meta)
        .filter((k) => k.startsWith("project_") && meta[k] === "true")
        .map((k) => k.replace("project_", ""));
      const devices = Object.keys(meta)
        .filter((k) => k.startsWith("device_") && !k.includes("_path") && meta[k] === "true")
        .map((k) => k.replace("device_", ""));
      return {
        name: String(n.Name),
        status: String(n.Status),
        projects,
        devices,
      };
    });
  }

  return JSON.stringify(result);
}

async function execLogs(args: Record<string, unknown>): Promise<string> {
  const jobId = String(args.job_id);
  const allocs = await nomad.getJobAllocations(jobId);
  if (!allocs.length) return "No allocations found for this job.";
  const allocId = String(allocs[0].ID);
  const logs = await nomad.readLogs(allocId, "execute");
  // Truncate to last 2000 chars to avoid overwhelming the LLM
  return logs.length > 2000 ? "..." + logs.slice(-2000) : logs;
}

async function execStop(args: Record<string, unknown>): Promise<string> {
  const jobId = String(args.job_id);
  await nomad.stopJob(jobId);
  return JSON.stringify({ status: "stopped", job_id: jobId });
}

async function execContinue(args: Record<string, unknown>): Promise<string> {
  const jobId = String(args.job_id);
  const prompt = String(args.prompt);

  const sessionVar = await nomad.getVar(`sessions/${jobId}`);
  const sessionId = sessionVar
    ? String((sessionVar.Items as Record<string, string>)?.session_id ?? jobId)
    : jobId;

  const job = await nomad.getJob(jobId);
  const meta = (job.Meta ?? {}) as Record<string, string>;
  const project = meta.project;
  if (!project) return "Error: Could not determine project from original job.";

  const newMeta: Record<string, string> = { ...meta, session_id: sessionId };
  const res = await nomad.dispatch(project, prompt, newMeta);
  return JSON.stringify({
    status: "continued",
    job_id: res.DispatchedJobID,
    session_id: sessionId,
    project,
  });
}

async function execManageNode(args: Record<string, unknown>): Promise<string> {
  const action = String(args.action);
  const nodeName = String(args.node_name);

  const nodes = await nomad.listNodes();
  const node = nodes.find((n) => String(n.Name) === nodeName);
  if (!node) return `Node not found: ${nodeName}`;

  const nodeId = String(node.ID);
  if (action === "drain") {
    await nomad.drainNode(nodeId);
    return JSON.stringify({ status: "draining", node: nodeName });
  } else if (action === "activate") {
    await nomad.enableNode(nodeId);
    return JSON.stringify({ status: "activated", node: nodeName });
  }
  return `Unknown action: ${action}`;
}

async function execCost(): Promise<string> {
  const vars = await nomad.listVars("cost/");
  if (!vars.length) return "No cost data found.";

  const byProject: Record<string, { tasks: number; cost: number }> = {};
  for (const v of vars) {
    const items = (v.Items ?? {}) as Record<string, string>;
    const project = items.project ?? "unknown";
    const cost = parseFloat(items.cost_usd ?? "0");
    if (!byProject[project]) byProject[project] = { tasks: 0, cost: 0 };
    byProject[project].tasks++;
    byProject[project].cost += cost;
  }

  return JSON.stringify(
    Object.entries(byProject).map(([project, data]) => ({
      project,
      tasks: data.tasks,
      total_cost_usd: data.cost.toFixed(4),
    }))
  );
}
