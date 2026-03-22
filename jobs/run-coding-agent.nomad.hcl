# =============================================================================
# run-coding-agent.nomad.hcl
# =============================================================================
#
# Parameterized batch job template for dispatching coding agent tasks.
# This is the core of the yeet orchestration system. One template handles all
# coding agent dispatches -- Claude Code, Codex, Aider, Goose, Amp.
#
# How it works:
#   1. Operator runs: yeet run peer6 "Add pagination to the mentors list"
#   2. yeet CLI POSTs to Nomad: /v1/job/run-coding-agent/dispatch
#      with meta {project, runtime, model} and the prompt as payload.
#   3. Nomad creates a child batch job (e.g., run-coding-agent/dispatch-<timestamp>-<hash>).
#   4. The constraint routes the job to a node that has the project cloned.
#   5. raw_exec runs /opt/yeet/scripts/run-agent.sh with meta as env vars
#      and the prompt written to ${NOMAD_TASK_DIR}/prompt.txt.
#   6. stdout/stderr are captured by Nomad's log system.
#   7. Exit code determines success/failure; restart policy handles retries.
#
# =============================================================================

job "run-coding-agent" {
  type = "batch"

  # ---------------------------------------------------------------------------
  # Parameterized: this job is never run directly. It serves as a template
  # that Nomad clones when dispatched via the API.
  #
  # - payload: the prompt text, delivered as a file to the task.
  # - meta_required: must be supplied at dispatch time or the dispatch fails.
  # - meta_optional: may be omitted; the adapter script handles defaults.
  # ---------------------------------------------------------------------------
  parameterized {
    payload       = "required"
    meta_required = ["project", "runtime", "model"]
    meta_optional = ["mode", "budget", "session_id", "needs_device"]
  }

  # ---------------------------------------------------------------------------
  # Constraint: route to a node that has the project repository cloned.
  #
  # Each Nomad client advertises project availability via node metadata:
  #   meta { "project_peer6" = "true", "project_login2" = "true", ... }
  #
  # This constraint dynamically resolves the meta key based on the dispatched
  # project name. For example, dispatching with project=peer6 evaluates:
  #   ${meta.project_peer6} == "true"
  #
  # NOTE: Dynamic attribute interpolation (${meta.project_${NOMAD_META_project}})
  # works in recent Nomad versions for parameterized jobs. If this proves
  # unreliable, the yeet CLI can fall back to generating a non-parameterized
  # job spec with the constraint hardcoded at dispatch time.
  # ---------------------------------------------------------------------------
  constraint {
    attribute = "${meta.project_${NOMAD_META_project}}"
    value     = "true"
  }

  group "agent" {

    # -------------------------------------------------------------------------
    # Reschedule: if the task fails after exhausting restart attempts, try
    # placing it on a different node. Limited to 1 reschedule attempt to
    # avoid runaway retries across the fleet.
    # -------------------------------------------------------------------------
    reschedule {
      attempts  = 1
      interval  = "1h"
      delay     = "30s"
      unlimited = false
    }

    task "execute" {
      # -----------------------------------------------------------------------
      # Driver: raw_exec runs the script directly on the host as the runner
      # user. No container overhead. The agent needs native access to git
      # worktrees, coding agent binaries, and optionally USB devices.
      # -----------------------------------------------------------------------
      driver = "raw_exec"

      config {
        command = "/opt/yeet/scripts/run-agent.sh"
        args    = []  # All configuration arrives via environment variables
      }

      # -----------------------------------------------------------------------
      # Dispatch payload: Nomad writes the prompt text (sent as the dispatch
      # payload) to this file path inside the task directory. The adapter
      # script reads it via the CO_PROMPT_FILE env var.
      # -----------------------------------------------------------------------
      dispatch_payload {
        file = "prompt.txt"
      }

      # -----------------------------------------------------------------------
      # Environment: map Nomad meta values to CO_* environment variables.
      # The adapter script (run-agent.sh) reads these to determine which
      # project, runtime, model, mode, and budget to use. This decouples
      # the job template from runtime-specific CLI flags.
      #
      # Variables:
      #   CO_PROJECT      - Project name (e.g., "peer6", "login2", "rule1")
      #   CO_RUNTIME      - Coding agent runtime (e.g., "claude-code", "codex", "aider")
      #   CO_MODEL        - Model identifier (e.g., "sonnet", "opus", "gpt-4o")
      #   CO_MODE         - Delegation mode (e.g., "quick", "deep", "unspecified-low")
      #   CO_BUDGET        - Cost budget cap for the agent session
      #   CO_SESSION_ID   - Previous session ID for --resume/--continue flows
      #   CO_NEEDS_DEVICE - Device type required (e.g., "yubikey"); triggers flock
      #   CO_PROMPT_FILE  - Absolute path to the prompt file written by Nomad
      # -----------------------------------------------------------------------
      env {
        CO_PROJECT      = "${NOMAD_META_project}"
        CO_RUNTIME      = "${NOMAD_META_runtime}"
        CO_MODEL        = "${NOMAD_META_model}"
        CO_MODE         = "${NOMAD_META_mode}"
        CO_BUDGET       = "${NOMAD_META_budget}"
        CO_SESSION_ID   = "${NOMAD_META_session_id}"
        CO_NEEDS_DEVICE = "${NOMAD_META_needs_device}"
        CO_PROMPT_FILE  = "${NOMAD_TASK_DIR}/prompt.txt"
      }

      # -----------------------------------------------------------------------
      # Resources: conservative allocation. Coding agents are I/O bound
      # (waiting on LLM API responses), not CPU or memory bound. The main
      # resource consumption is the Node.js/Python runtime for the agent CLI.
      #
      #   cpu:    500 MHz -- sufficient for API-call-heavy workloads
      #   memory: 512 MB -- enough for Node.js (Claude Code, Codex) or
      #                      Python (Aider, Goose) runtimes with headroom
      # -----------------------------------------------------------------------
      resources {
        cpu    = 500
        memory = 512
      }

      # -----------------------------------------------------------------------
      # Restart policy: retry failed tasks before giving up. Coding agent
      # failures are typically transient (API rate limits, network blips,
      # temporary git lock conflicts).
      #
      #   attempts: 2 retries (3 total runs including the initial attempt)
      #   delay:    30s between retries (enough for rate limits to clear)
      #   interval: 10m window for the retry budget
      #   mode:     "fail" -- after exhausting retries, mark the allocation
      #             as failed (triggers reschedule to another node if available)
      # -----------------------------------------------------------------------
      restart {
        attempts = 2
        interval = "10m"
        delay    = "30s"
        mode     = "fail"
      }

      # -----------------------------------------------------------------------
      # Kill timeout: when Nomad sends SIGINT to stop a job (via yeet stop
      # or node drain), give the agent time to finish its current operation,
      # save session state, and clean up the git worktree. 30s is generous
      # enough for graceful shutdown without leaving orphaned worktrees.
      # -----------------------------------------------------------------------
      kill_timeout = "30s"
    }
  }
}
