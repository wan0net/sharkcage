# Sandbox Policies

Policies are YAML files consumed by `openshell-sandbox --policy-data <path>`. They define filesystem, network, and process constraints for agent tasks.

## How it works

**`base.yaml`** is the restrictive default: read-only system paths, writable `/tmp`, no network, sensible process limits.

**`run-agent.sh`** generates per-task policies at runtime by extending `base.yaml`:

- **Filesystem (read_write):** Adds the project workspace path so the agent can modify code.
- **Devices:** If `--needs` specifies devices (e.g., `gpu`, `usb`), their paths are added to `filesystem.read_write`.
- **Network:** Adds LLM API hosts and `github.com` to `network.allowed_hosts` based on the configured runtime.
- **Review/analyze mode:** The workspace path goes into `filesystem.read_only` instead of `read_write`, preventing modifications.

Generated policies are written to `/tmp` and cleaned up after the task completes.

## Testing a policy

```bash
openshell-sandbox --policy-data policy.yaml -- echo "works"
```
