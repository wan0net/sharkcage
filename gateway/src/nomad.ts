import { getNomadAddr, getNomadToken } from "./config.ts";

function headers(): Record<string, string> {
  const h: Record<string, string> = { "Content-Type": "application/json" };
  const token = getNomadToken();
  if (token) h["X-Nomad-Token"] = token;
  return h;
}

function url(path: string): string {
  return `${getNomadAddr()}${path}`;
}

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(url(path), {
    method,
    headers: headers(),
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Nomad API ${method} ${path}: ${res.status} ${text}`);
  }
  return res.json() as Promise<T>;
}

export interface DispatchResponse {
  DispatchedJobID: string;
  EvalID: string;
  EvalCreateIndex: number;
  JobCreateIndex: number;
}

export async function dispatch(
  project: string,
  prompt: string,
  meta: Record<string, string>
): Promise<DispatchResponse> {
  const payload = btoa(prompt);
  return request<DispatchResponse>("POST", "/v1/job/run-coding-agent/dispatch", {
    Payload: payload,
    Meta: { project, ...meta },
  });
}

export async function getJob(jobId: string): Promise<Record<string, unknown>> {
  return request("GET", `/v1/job/${encodeURIComponent(jobId)}`);
}

export async function getJobAllocations(jobId: string): Promise<Record<string, unknown>[]> {
  return request("GET", `/v1/job/${encodeURIComponent(jobId)}/allocations`);
}

export async function readLogs(allocId: string, task: string, bytes = 16384): Promise<string> {
  const params = new URLSearchParams({
    task,
    type: "stdout",
    plain: "true",
    origin: "end",
    offset: String(bytes),
  });
  const res = await fetch(url(`/v1/client/fs/logs/${allocId}?${params}`), { headers: headers() });
  if (!res.ok) throw new Error(`Log read failed: ${res.status}`);
  return res.text();
}

export async function stopJob(jobId: string): Promise<void> {
  await request("DELETE", `/v1/job/${encodeURIComponent(jobId)}?purge=false`);
}

export async function listJobs(type?: string): Promise<Record<string, unknown>[]> {
  const params = type ? `?type=${type}` : "";
  return request("GET", `/v1/jobs${params}`);
}

export async function listNodes(): Promise<Record<string, unknown>[]> {
  return request("GET", "/v1/nodes");
}

export async function drainNode(nodeId: string): Promise<void> {
  await request("POST", `/v1/node/${nodeId}/drain`, {
    DrainSpec: { Deadline: 3600000000000 },
    MarkEligible: false,
  });
}

export async function enableNode(nodeId: string): Promise<void> {
  await request("POST", `/v1/node/${nodeId}/eligibility`, { Eligibility: "eligible" });
}

export async function getVar(path: string): Promise<Record<string, unknown> | null> {
  try {
    return await request("GET", `/v1/var/${encodeURIComponent(path)}`);
  } catch {
    return null;
  }
}

export async function listVars(prefix: string): Promise<Record<string, unknown>[]> {
  return request("GET", `/v1/vars?prefix=${encodeURIComponent(prefix)}`);
}
