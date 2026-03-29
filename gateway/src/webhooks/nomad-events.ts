import * as nomad from "../nomad.ts";

export interface JobEvent {
  jobId: string;
  status: "complete" | "dead" | "running";
  project: string;
  runtime: string;
}

type EventHandler = (event: JobEvent) => void;

export class NomadEventPoller {
  private intervalMs: number;
  private timer: ReturnType<typeof setInterval> | null = null;
  private handler: EventHandler | null = null;
  private knownStates: Map<string, string> = new Map();

  constructor(intervalMs = 15000) {
    this.intervalMs = intervalMs;
  }

  onJobEvent(handler: EventHandler): void {
    this.handler = handler;
  }

  start(): void {
    // Initial poll to seed known states
    this.poll().catch((err) => console.error("[events] initial poll error:", err));

    this.timer = setInterval(() => {
      this.poll().catch((err) => console.error("[events] poll error:", err));
    }, this.intervalMs);

    console.log(`[events] polling every ${this.intervalMs / 1000}s`);
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  private async poll(): Promise<void> {
    const jobs = await nomad.listJobs("batch");
    const agentJobs = jobs.filter(
      (j) =>
        String(j.ParentID) === "run-coding-agent" ||
        String(j.ID).startsWith("run-coding-agent/")
    );

    for (const job of agentJobs) {
      const id = String(job.ID);
      const status = String(job.Status);
      const previousStatus = this.knownStates.get(id);

      this.knownStates.set(id, status);

      // Only fire event on state transitions to terminal states
      if (previousStatus && previousStatus !== status && (status === "complete" || status === "dead")) {
        const meta = (job.Meta ?? {}) as Record<string, string>;
        this.handler?.({
          jobId: id,
          status: status as "complete" | "dead",
          project: meta.project ?? "unknown",
          runtime: meta.runtime ?? "unknown",
        });
      }
    }

    // Clean up old entries (keep last 200)
    if (this.knownStates.size > 200) {
      const entries = [...this.knownStates.entries()];
      this.knownStates = new Map(entries.slice(-200));
    }
  }
}
