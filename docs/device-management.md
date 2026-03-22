# Device Management

How physical USB devices (security keys, dev boards, HSMs) are managed across a fleet of Dell 5070 thin clients running code-orchestration on Nomad.

---

## Overview

The system manages physical devices attached to runner machines. Tasks can require specific devices, and Nomad routes tasks to nodes that have those devices by matching job constraints against node metadata. Devices are never accessed directly by the coding agent -- they go through wrapper scripts that handle locking, timeouts, and logging.

The flow is:

1. Devices are plugged into Dell 5070 runners and given stable names via udev rules.
2. The Nomad client on each runner advertises attached devices via its `meta` block (e.g., `device_yubikey = true`).
3. When a task requires a device, the `yeet` CLI adds a Nomad constraint targeting that device's metadata key, and Nomad schedules the job on a node that satisfies the constraint.
4. The `run-agent.sh` entrypoint acquires an exclusive flock on the device before starting the task.
5. The coding agent (Crush/Claude/Aider) accesses the device only through wrapper scripts.
6. After the task completes, the lock is released and the device becomes available again.

There is no custom device registry API. Nomad IS the device registry. Device presence is encoded in node metadata, and the standard Nomad API (`GET /v1/nodes`) is the query interface.

---

## Device Types

| Type | Examples | Access Method | Typical Operations |
|------|----------|---------------|--------------------|
| USB Security Key | YubiKey 5 NFC, SoloKey | hidraw, FIDO2 libs, ykman | FIDO2 auth testing, OTP generation, PIV operations |
| HSM | YubiHSM 2, Nitrokey HSM | PKCS#11 (via p11-kit) | Key generation, signing, certificate ops |
| Dev Board | ESP32, Raspberry Pi Pico | USB serial (ttyUSB/ttyACM) | Firmware flash, serial console, integration testing |
| Smart Card | OpenPGP cards | PC/SC (pcscd) | Signing, authentication |
| USB Storage | USB drives | block device | Firmware images, test data |

---

## Device Discovery and Naming (udev)

Every device gets a stable, predictable symlink in `/dev/` so that scripts can reference devices by name rather than by ephemeral paths like `/dev/ttyUSB0` which change depending on plug order.

### Rule File

All rules live in a single file:

```
/etc/udev/rules.d/90-code-orchestration.rules
```

The `90-` prefix ensures these rules run after the default system rules but can still be overridden by rules in the 99 range if needed.

### Matching Attributes

udev rules match devices by their USB attributes:

- **`ATTRS{idVendor}`** -- USB vendor ID (4 hex digits)
- **`ATTRS{idProduct}`** -- USB product ID (4 hex digits)
- **`ATTRS{serial}`** -- USB serial number string (unique per device, when available)
- **`ENV{ID_PATH}`** -- physical USB port path (for distinguishing identical devices on different ports)

To discover attributes for a connected device:

```bash
udevadm info --name=/dev/ttyUSB0 --attribute-walk
```

This walks up the device tree printing every attribute. Look for `idVendor`, `idProduct`, and `serial` in the output.

### Rule Syntax

Each rule sets a symlink, permissions, and group:

```
SYMLINK+="device-name"    # creates /dev/device-name -> /dev/actual-device
MODE="0660"               # owner + group read/write, no world access
GROUP="devices"            # only members of the devices group can access
```

### Concrete udev Rules

**YubiKey 5 NFC** (vendor `1050`, product `0407`):

```udev
# YubiKey 5 NFC -- primary security key
SUBSYSTEM=="usb", ATTRS{idVendor}=="1050", ATTRS{idProduct}=="0407", \
  SYMLINK+="yubikey-1", MODE="0660", GROUP="devices"
```

**YubiHSM 2** (vendor `1050`, product `0030`):

```udev
# YubiHSM 2 -- hardware security module
SUBSYSTEM=="usb", ATTRS{idVendor}=="1050", ATTRS{idProduct}=="0030", \
  SYMLINK+="yubihsm-1", MODE="0660", GROUP="devices"
```

**ESP32 with CP2102 USB-serial** (vendor `10c4`, product `ea60`) -- single device:

```udev
# ESP32 dev board (CP2102 serial) -- single unit
SUBSYSTEM=="tty", ATTRS{idVendor}=="10c4", ATTRS{idProduct}=="ea60", \
  SYMLINK+="esp32-main", MODE="0660", GROUP="devices"
```

**Multiple identical ESP32s** distinguished by USB port path:

When you have two or more ESP32 boards with CP2102 chips, they share the same vendor and product IDs and may not have unique serial numbers. Use `ENV{ID_PATH}` to distinguish them by the physical USB port they are plugged into:

```udev
# ESP32 on USB port 1 (front left on Dell 5070)
SUBSYSTEM=="tty", ATTRS{idVendor}=="10c4", ATTRS{idProduct}=="ea60", \
  ENV{ID_PATH}=="pci-0000:00:14.0-usb-0:1:1.0", \
  SYMLINK+="esp32-front", MODE="0660", GROUP="devices"

# ESP32 on USB port 3 (rear right on Dell 5070)
SUBSYSTEM=="tty", ATTRS{idVendor}=="10c4", ATTRS{idProduct}=="ea60", \
  ENV{ID_PATH}=="pci-0000:00:14.0-usb-0:3:1.0", \
  SYMLINK+="esp32-rear", MODE="0660", GROUP="devices"
```

Find the port path for a device with:

```bash
udevadm info --name=/dev/ttyUSB0 | grep ID_PATH=
```

### Reloading Rules

After editing the rules file:

```bash
udevadm control --reload-rules && udevadm trigger
```

Verify the symlink was created:

```bash
ls -la /dev/yubikey-1
# lrwxrwxrwx 1 root root 15 Mar 22 10:00 /dev/yubikey-1 -> bus/usb/001/005
```

---

## Device Inventory via Nomad Node Metadata

There is no custom device registry or inventory API. Nomad node metadata is the single source of truth for which devices exist on which nodes.

### How It Works

Each Nomad client advertises its attached devices in the `meta` block of its client configuration (`/etc/nomad.d/client.hcl` or equivalent):

```hcl
client {
  enabled = true

  meta {
    # Device presence flags
    device_yubikey     = "true"
    device_yubikey_path = "/dev/yubikey-1"

    device_yubihsm     = "true"
    device_yubihsm_path = "/dev/yubihsm-1"

    device_esp32       = "true"
    device_esp32_path  = "/dev/esp32-main"
  }
}
```

The naming convention is:

- **`device_{name}`** -- presence flag, set to `"true"` when the device is connected.
- **`device_{name}_path`** -- the `/dev/` path to the device (the udev symlink).

A node with multiple devices of the same type uses suffixed names:

```hcl
meta {
  device_esp32_front      = "true"
  device_esp32_front_path = "/dev/esp32-front"

  device_esp32_rear       = "true"
  device_esp32_rear_path  = "/dev/esp32-rear"
}
```

### Querying the Device Inventory

The `yeet devices` command queries all Nomad nodes and extracts device metadata:

```bash
yeet devices
```

Output:

```
NODE        DEVICE           PATH               STATUS
dell-01     yubikey          /dev/yubikey-1      available
dell-01     yubihsm          /dev/yubihsm-1      available
dell-02     esp32            /dev/esp32-main     available
dell-03     esp32_front      /dev/esp32-front    available
dell-03     esp32_rear       /dev/esp32-rear     available
```

Under the hood, `yeet devices` calls the Nomad API:

```bash
# List all nodes
curl -s http://localhost:4646/v1/nodes | jq '.[] | .ID'

# Get metadata for a specific node
curl -s http://localhost:4646/v1/node/<node-id> | jq '.Meta'
```

Then it filters for keys starting with `device_` that do not end in `_path`, pairs each with its corresponding `_path` key, and displays the result.

To get the raw metadata for all nodes in a scriptable format:

```bash
# All device metadata across the fleet
for node_id in $(curl -s http://localhost:4646/v1/nodes | jq -r '.[].ID'); do
  echo "=== $(curl -s http://localhost:4646/v1/node/$node_id | jq -r '.Name') ==="
  curl -s http://localhost:4646/v1/node/$node_id | jq '.Meta | to_entries[] | select(.key | startswith("device_"))'
done
```

---

## Device Routing via Nomad Constraints

Device routing is handled entirely by Nomad's constraint system. When a task requires a device, the job specification includes a constraint that targets the device's metadata key. Nomad's scheduler evaluates the constraint against all nodes and places the job on a node that satisfies it.

### How Constraints Work

A job that needs a YubiKey includes:

```hcl
job "sign-release" {
  # ...

  constraint {
    attribute = "${meta.device_yubikey}"
    value     = "true"
  }

  group "default" {
    task "sign" {
      driver = "exec"
      config {
        command = "/opt/code-orchestration/run-agent.sh"
        args    = ["--needs", "yubikey", "--", "sign the release artifacts"]
      }
    }
  }
}
```

Nomad will only schedule this job on nodes where `device_yubikey = "true"` in the node metadata. If no node satisfies the constraint, the job remains in a `pending` state until a suitable node becomes available.

### The `--needs` Flag

The `yeet` CLI's `--needs` flag translates device requirements into Nomad constraints automatically:

```bash
# Single device requirement
yeet run --needs yubikey -- "sign the release artifacts with the YubiKey"

# Multiple device requirements (all must be on the same node)
yeet run --needs yubikey --needs yubihsm -- "generate a key on the HSM and enroll it on the YubiKey"

# Specific device variant
yeet run --needs esp32_front -- "flash firmware to the front ESP32"
```

Each `--needs <device>` flag adds a constraint block to the dispatched Nomad job:

```hcl
constraint {
  attribute = "${meta.device_<device>}"
  value     = "true"
}
```

The device path is made available to the task via the Nomad meta interpolation. The `run-agent.sh` entrypoint reads `${meta.device_<device>_path}` to know which `/dev/` path to lock and pass to wrapper scripts.

### Multiple Devices on the Same Node

If a task needs two devices (e.g., both a YubiKey and an HSM), both constraints must be satisfied by the same node. Nomad handles this naturally -- all constraints on a job must be satisfied by the placed node:

```bash
yeet run --needs yubikey --needs yubihsm -- "enroll the HSM key onto the YubiKey"
```

This produces:

```hcl
constraint {
  attribute = "${meta.device_yubikey}"
  value     = "true"
}

constraint {
  attribute = "${meta.device_yubihsm}"
  value     = "true"
}
```

Only nodes with both devices will be eligible.

### What Happens When No Node Matches

If no node currently has the required device, the Nomad job enters `pending` status. The allocation will show a "constraint filtering" message in `nomad alloc status`:

```
Constraint "${meta.device_yubikey}" = "true" filtered 4 nodes
All nodes were filtered
```

The job remains pending until either:

- A node with the device comes online (or has its metadata updated to advertise the device).
- The job is manually stopped.

---

## Device Locking

Exclusive access to devices is enforced using `flock(1)` advisory locks. This prevents two tasks from accessing the same device simultaneously. Even though Nomad handles routing, locking is still necessary because multiple jobs could be scheduled on the same node if it has enough resources, and two jobs could both target the same device.

### Lock File Convention

```
/var/lock/code-orchestration/device-{name}.lock
```

Examples:
- `/var/lock/code-orchestration/device-yubikey-1.lock`
- `/var/lock/code-orchestration/device-esp32-main.lock`
- `/var/lock/code-orchestration/device-yubihsm-1.lock`

The lock directory is created on runner startup:

```bash
mkdir -p /var/lock/code-orchestration
chown root:devices /var/lock/code-orchestration
chmod 0770 /var/lock/code-orchestration
```

### Lock Operations

**Acquire (non-blocking, fail if busy):**

```bash
flock -n /var/lock/code-orchestration/device-yubikey-1.lock -c "your-command-here"
```

The `-n` flag makes it non-blocking -- if the lock is already held, it fails immediately instead of waiting.

**Check if a device is free:**

```bash
flock -n /var/lock/code-orchestration/device-yubikey-1.lock -c "echo free" || echo "busy"
```

**Release:** Automatic when the process holding the lock exits. No explicit release step is needed.

### Full Lifecycle

1. **Nomad schedules** a job with `constraint { attribute = "${meta.device_yubikey}" value = "true" }` onto a node that has the device.
2. **`run-agent.sh` starts** on the target node.
3. **`run-agent.sh` checks** the device symlink exists in `/dev/`.
4. **`run-agent.sh` acquires flock** on `/var/lock/code-orchestration/device-yubikey-1.lock`.
5. **If the lock is already held** (another task on the same node is using the device), `run-agent.sh` can either wait with a timeout or fail immediately. Default: fail immediately, Nomad reschedules.
6. **Runtime spawns** (Crush/Claude/Aider). The coding agent accesses the device through the wrapper script. The wrapper verifies the lock is held before proceeding.
7. **Task completes** (success or failure).
8. **`run-agent.sh` exits**, which **releases the flock** automatically.

### Error Cases

**Device locked by another task:**

If flock acquisition fails (another allocation on the same node holds the lock), `run-agent.sh` exits with a non-zero status. Nomad will reschedule the allocation according to the job's `reschedule` stanza. If the job uses `type = "batch"`, Nomad retries up to the configured `attempts` count. This is a transient condition -- the device will free up when the other task finishes.

To minimize lock contention, consider setting `count = 1` on the task group and using Nomad's `resources` block to limit concurrency on device-bearing nodes.

**Device disconnected while locked:**

If a device disappears (symlink vanishes from `/dev/`) while a task holds its lock:

1. The wrapper script detects the device is gone on the next operation and returns an error.
2. The task fails.
3. Nomad's `restart` policy determines what happens next (retry on the same node, or reschedule to another node).
4. If the device is permanently gone, update the node's Nomad metadata to remove the device (see "Device Health Monitoring" below) so that future jobs are not scheduled there.

---

## Device Wrapper Scripts

The coding agent (Crush/Claude/Aider) accesses devices through wrapper scripts, never directly. This provides a control point for locking verification, timeouts, output logging, and output sanitization.

### Location

```
/opt/code-orchestration/devices/
```

All wrapper scripts live in this directory and are added to the runtime's `PATH`.

### What Every Wrapper Does

1. **Checks the device lock** is held by the calling task (fails fast if not).
2. **Sets a timeout** (default 30 seconds, configurable per-device or per-invocation).
3. **Logs the command and output** to the audit log at `/var/log/code-orchestration/device-audit.log`.
4. **Sanitizes output** -- no raw binary dumped to stdout, large outputs truncated to 64KB.

### yubikey.sh

Wraps `ykman` for YubiKey operations.

```bash
#!/bin/bash
# Usage: yubikey.sh <subcommand> [args...]
# Examples:
#   yubikey.sh info
#   yubikey.sh fido credentials list
#   yubikey.sh oath accounts list
#   yubikey.sh piv certificates export 9a -

set -euo pipefail

DEVICE="/dev/yubikey-1"
LOCK="/var/lock/code-orchestration/device-yubikey-1.lock"
TIMEOUT="${DEVICE_TIMEOUT:-30}"
LOG="/var/log/code-orchestration/device-audit.log"

# Verify lock is held by checking that a non-blocking lock attempt FAILS.
# If flock -n succeeds, it means no one holds the lock -- that is an error.
flock -n "$LOCK" -c "exit 1" 2>/dev/null && {
  echo "ERROR: Device lock not held. Acquire lock before accessing device." >&2
  exit 1
}

# Verify device exists
if [ ! -e "$DEVICE" ]; then
  echo "ERROR: Device $DEVICE not found. Is the YubiKey connected?" >&2
  exit 1
fi

# Log the command
echo "$(date -Iseconds) task=${TASK_ID:-unknown} device=yubikey-1 cmd=ykman $*" >> "$LOG"

# Execute with timeout, capture and log output
timeout "$TIMEOUT" ykman --device "$DEVICE" "$@" 2>&1 | head -c 65536 | tee -a "$LOG"
```

### serial.sh

Wraps serial communication for dev boards (ESP32, Pico, etc.).

```bash
#!/bin/bash
# Usage: serial.sh <device-name> <command> [args...]
# Commands:
#   serial.sh esp32-main send "AT+RST"           -- send a string and read response
#   serial.sh esp32-main flash firmware.bin       -- flash firmware via esptool
#   serial.sh esp32-main monitor 10              -- monitor serial output for N seconds
#   serial.sh esp32-main baud                    -- print configured baud rate

set -euo pipefail

DEVICE_NAME="${1:?Usage: serial.sh <device-name> <command> [args...]}"
COMMAND="${2:?Usage: serial.sh <device-name> <command> [args...]}"
shift 2

DEVICE="/dev/$DEVICE_NAME"
LOCK="/var/lock/code-orchestration/device-${DEVICE_NAME}.lock"
TIMEOUT="${DEVICE_TIMEOUT:-30}"
LOG="/var/log/code-orchestration/device-audit.log"
BAUD="${DEVICE_BAUD:-115200}"

# Verify lock is held
flock -n "$LOCK" -c "exit 1" 2>/dev/null && {
  echo "ERROR: Device lock not held for $DEVICE_NAME." >&2
  exit 1
}

# Verify device exists
if [ ! -e "$DEVICE" ]; then
  echo "ERROR: Device $DEVICE not found. Is the board connected?" >&2
  exit 1
fi

# Log the command
echo "$(date -Iseconds) task=${TASK_ID:-unknown} device=$DEVICE_NAME cmd=serial $COMMAND $*" >> "$LOG"

case "$COMMAND" in
  send)
    # Send a string to the serial port and read the response
    echo "$*" > "$DEVICE"
    timeout "$TIMEOUT" head -n 20 "$DEVICE" 2>&1 | tee -a "$LOG"
    ;;
  flash)
    # Flash firmware using esptool.py
    FIRMWARE="${1:?Usage: serial.sh <device> flash <firmware-file>}"
    timeout 120 esptool.py --port "$DEVICE" --baud "$BAUD" write_flash 0x0 "$FIRMWARE" 2>&1 | tee -a "$LOG"
    ;;
  monitor)
    # Monitor serial output for N seconds
    DURATION="${1:-10}"
    timeout "$DURATION" cat "$DEVICE" 2>&1 | head -c 65536 | tee -a "$LOG"
    ;;
  baud)
    echo "$BAUD"
    ;;
  *)
    echo "ERROR: Unknown command '$COMMAND'. Use: send, flash, monitor, baud" >&2
    exit 1
    ;;
esac
```

### hsm.sh

Wraps PKCS#11 operations via `pkcs11-tool` for YubiHSM 2 and Nitrokey HSM devices.

```bash
#!/bin/bash
# Usage: hsm.sh <subcommand> [args...]
# Examples:
#   hsm.sh list-objects                           -- list all objects on the HSM
#   hsm.sh list-slots                             -- list available PKCS#11 slots
#   hsm.sh sign --key-id 01 --input data.bin      -- sign data with key 01
#   hsm.sh generate-keypair --key-type EC:prime256v1 --id 02
#   hsm.sh read-certificate --id 01               -- read certificate from slot

set -euo pipefail

LOCK="/var/lock/code-orchestration/device-yubihsm-1.lock"
TIMEOUT="${DEVICE_TIMEOUT:-30}"
LOG="/var/log/code-orchestration/device-audit.log"
PKCS11_MODULE="/usr/lib/pkcs11/yubihsm_pkcs11.so"

# Verify lock is held
flock -n "$LOCK" -c "exit 1" 2>/dev/null && {
  echo "ERROR: Device lock not held for yubihsm-1." >&2
  exit 1
}

# HSM PIN from environment (never from arguments or task prompts)
if [ -z "${HSM_PIN:-}" ]; then
  echo "ERROR: HSM_PIN environment variable not set." >&2
  exit 1
fi

SUBCOMMAND="${1:?Usage: hsm.sh <subcommand> [args...]}"
shift

# Log the command (redact PIN)
echo "$(date -Iseconds) task=${TASK_ID:-unknown} device=yubihsm-1 cmd=hsm $SUBCOMMAND $*" >> "$LOG"

case "$SUBCOMMAND" in
  list-objects)
    timeout "$TIMEOUT" pkcs11-tool --module "$PKCS11_MODULE" --login --pin "$HSM_PIN" \
      --list-objects 2>&1 | tee -a "$LOG"
    ;;
  list-slots)
    timeout "$TIMEOUT" pkcs11-tool --module "$PKCS11_MODULE" --list-slots 2>&1 | tee -a "$LOG"
    ;;
  sign)
    timeout "$TIMEOUT" pkcs11-tool --module "$PKCS11_MODULE" --login --pin "$HSM_PIN" \
      --sign --mechanism ECDSA "$@" 2>&1 | tee -a "$LOG"
    ;;
  generate-keypair)
    timeout "$TIMEOUT" pkcs11-tool --module "$PKCS11_MODULE" --login --pin "$HSM_PIN" \
      --keypairgen "$@" 2>&1 | tee -a "$LOG"
    ;;
  read-certificate)
    timeout "$TIMEOUT" pkcs11-tool --module "$PKCS11_MODULE" --login --pin "$HSM_PIN" \
      --read-object --type cert "$@" 2>&1 | tee -a "$LOG"
    ;;
  *)
    echo "ERROR: Unknown subcommand '$SUBCOMMAND'." >&2
    echo "Available: list-objects, list-slots, sign, generate-keypair, read-certificate" >&2
    exit 1
    ;;
esac
```

---

## Device Health Monitoring

Device health monitoring ensures that Nomad node metadata stays in sync with the actual devices present on each node. Unlike a custom daemon that reports to a central API, the approach here is to keep the Nomad client metadata accurate so that Nomad's scheduler makes correct placement decisions.

### Option 1: Periodic Device Check Script (Recommended)

A systemd timer or cron job runs every 60 seconds on each node, checks which devices are actually present, and updates the Nomad client metadata if anything has changed.

```bash
#!/bin/bash
# /opt/code-orchestration/device-health.sh
# Runs periodically to sync device presence with Nomad node metadata.

set -euo pipefail

NOMAD_ADDR="${NOMAD_ADDR:-http://localhost:4646}"
NODE_ID=$(nomad node status -self -json | jq -r '.ID')

# Define expected devices and their symlinks
declare -A DEVICES=(
  ["yubikey"]="/dev/yubikey-1"
  ["yubihsm"]="/dev/yubihsm-1"
  ["esp32"]="/dev/esp32-main"
)

CHANGED=false
META_ARGS=()

for device in "${!DEVICES[@]}"; do
  path="${DEVICES[$device]}"
  meta_key="device_${device}"

  if [ -e "$path" ]; then
    META_ARGS+=("${meta_key}=true" "${meta_key}_path=${path}")
  else
    META_ARGS+=("${meta_key}=false" "${meta_key}_path=")
  fi
done

# Update node metadata via Nomad API
# This requires the node to have the meta block mutable (Nomad 1.7+)
# or we update the client config file and reload.

# Approach A: Use nomad node meta apply (Nomad 1.7+)
nomad node meta apply "${META_ARGS[@]}"

# Approach B: For older Nomad, update the config file and reload
# This is more disruptive but works on all versions:
#   1. Generate new meta block
#   2. Write to /etc/nomad.d/devices.hcl
#   3. systemctl reload nomad
```

The `nomad node meta apply` command (Nomad 1.7+) allows updating node metadata at runtime without restarting the Nomad client. For older versions, the script must rewrite the config file and reload the Nomad service.

**systemd timer setup:**

```ini
# /etc/systemd/system/device-health.timer
[Unit]
Description=Check device health and update Nomad metadata

[Timer]
OnBootSec=10s
OnUnitActiveSec=60s

[Install]
WantedBy=timers.target
```

```ini
# /etc/systemd/system/device-health.service
[Unit]
Description=Device health check for code-orchestration

[Service]
Type=oneshot
ExecStart=/opt/code-orchestration/device-health.sh
User=root
```

### Option 2: Let It Fail and Retry

The simpler alternative is to not actively monitor devices at all. If a device is disconnected:

1. The Nomad node metadata still says `device_yubikey = "true"`.
2. Nomad schedules a job requiring a YubiKey onto that node.
3. `run-agent.sh` tries to access `/dev/yubikey-1`, finds it missing, and exits with an error.
4. Nomad's `reschedule` stanza kicks in and tries again (possibly on the same node, possibly on another).
5. Eventually an operator notices the failures, fixes the device, or updates the metadata manually.

This approach is acceptable for small fleets where device disconnection is rare. It trades monitoring complexity for occasional wasted allocation attempts.

### Option 3: udev-triggered Metadata Update

Use a udev rule to trigger a metadata update immediately when a device is plugged or unplugged:

```udev
# /etc/udev/rules.d/91-nomad-device-meta.rules
# Trigger metadata update on YubiKey plug/unplug
SUBSYSTEM=="usb", ATTRS{idVendor}=="1050", ATTRS{idProduct}=="0407", \
  RUN+="/opt/code-orchestration/device-health.sh"
```

This gives near-instant metadata updates but requires careful scripting to avoid race conditions (the device symlink may not exist yet when the udev rule fires on plug-in). Best combined with Option 1 as a fallback.

### Health Check Summary

| Approach | Latency | Complexity | Best For |
|----------|---------|------------|----------|
| Periodic script (Option 1) | Up to 60s | Medium | Production fleets |
| Let it fail (Option 2) | Until job fails | Low | Small/dev setups |
| udev-triggered (Option 3) | Near-instant | High | Latency-sensitive setups |

For most deployments, Option 1 is the right balance. Option 2 is fine when you are getting started. Option 3 is worth adding later if stale metadata causes frequent failed allocations.

---

## Remote Device Access

For when a device is physically attached to one Dell but needed from another. In most cases, the simpler and more reliable approach is to route the task to the node that has the device via Nomad constraints. Remote device access is a fallback for edge cases.

### USB/IP

Kernel-native USB over TCP. The runner with the device exports it, and a remote runner imports it as if it were locally connected.

**Server side (runner with the device):**

```bash
# Load kernel module
modprobe usbip-host

# List exportable devices
usbip list -l

# Export the YubiKey (bus ID from usbip list)
usbip bind -b 1-2
```

**Client side (runner that needs the device):**

```bash
# Load kernel module
modprobe vhci-hcd

# Import the device from dell-03
usbip attach -r dell-03 -b 1-2

# The device now appears locally in /dev/ and lsusb
```

**Characteristics:**
- Latency: ~300ms per operation over LAN, acceptable for infrequent operations.
- Good for: security key operations, HSM signing, anything that does not require sustained high-throughput.
- Bad for: serial monitoring, firmware flashing, anything timing-sensitive.
- One consumer at a time (same as physical USB).

### ser2net

Maps serial ports to TCP sockets. Simple YAML configuration, one connection at a time.

**Configuration (`/etc/ser2net.yaml`):**

```yaml
connection: &esp32-main
  accepter: tcp,2000
  enable: on
  connector: serialdev,/dev/esp32-main,115200n81,local
  options:
    kickolduser: true
    telnet-brk-on-sync: true
```

**Client side:**

```bash
# Connect to the remote serial port
telnet dell-03 2000

# Or use socat to create a local PTY
socat pty,link=/dev/esp32-remote,raw tcp:dell-03:2000
```

**Characteristics:**
- Very simple to set up and debug.
- Good for: serial console access, sending AT commands, reading sensor output.
- Bad for: firmware flashing (timing-sensitive, needs direct USB).
- Single connection at a time (`kickolduser` drops the old connection if a new one arrives).

### p11-kit PKCS#11 Remoting

Forwards PKCS#11 cryptographic operations over an SSH tunnel. The private key material never leaves the HSM -- only the PKCS#11 API calls are forwarded.

**Server side (runner with the HSM):**

```bash
# p11-kit server listens on a Unix socket
p11-kit server --provider /usr/lib/pkcs11/yubihsm_pkcs11.so \
  "unix:path=/run/p11-kit/hsm.sock"
```

**Client side (over SSH tunnel):**

```bash
# Forward the Unix socket over SSH
ssh -L /run/p11-kit/remote-hsm.sock:/run/p11-kit/hsm.sock dell-03

# Use the remote PKCS#11 module as if it were local
pkcs11-tool --module /usr/lib/p11-kit-client.so --list-slots
```

**Characteristics:**
- Best option for HSMs -- crypto operations are forwarded, keys never leave the device.
- Good for: signing, certificate operations, key generation.
- Bad for: nothing, really -- if you need remote HSM access, this is the correct approach.
- Secured by SSH authentication and tunnel encryption.

### When to Use Remote Access vs. Nomad Constraints

In most cases, Nomad constraints are simpler and more reliable. The task is routed to the node with the device, and there is no network hop or remote device protocol to worry about.

Use remote access only when:
- A task needs devices that are on different nodes (e.g., sign with HSM on dell-01, then flash firmware on dell-03). In this case, consider splitting into two jobs instead.
- A device is expensive/rare and you cannot duplicate it across nodes.
- You need to consolidate devices on fewer machines for physical security reasons.

If you find yourself reaching for USB/IP or ser2net frequently, consider whether the task should be split into multiple Nomad jobs, each with its own device constraint, chained via job dependencies.

---

## Security Considerations

### Access Control

- **Wrapper scripts are the only way** the coding agent touches devices. The runtime sandbox does not have direct access to `/dev/` -- only the wrapper scripts in `/opt/code-orchestration/devices/` are on the PATH.
- **Device permission group (`devices`)** -- only the runner daemon's user is a member of this group. The coding agent's sandboxed process inherits group membership from the runner, which sets it up before spawning the runtime.
- **USBGuard whitelist** on each runner. Only known vendor:product pairs are allowed to enumerate. Unknown USB devices are blocked at the kernel level.

Example USBGuard policy (`/etc/usbguard/rules.conf`):

```
# Allow known devices
allow id 1050:0407  # YubiKey 5 NFC
allow id 1050:0030  # YubiHSM 2
allow id 10c4:ea60  # CP2102 (ESP32)
allow id 2e8a:0005  # Raspberry Pi Pico

# Block everything else
reject
```

### Audit Logging

Every device interaction is logged to `/var/log/code-orchestration/device-audit.log` with:

- ISO 8601 timestamp
- Task ID
- Device name
- Full command (with arguments)
- Command output (truncated to 64KB)

The audit log is append-only (set with `chattr +a`) and rotated daily via logrotate.

### Secrets Handling

- **HSM PINs** are stored in environment variables set by the runner daemon, never in task prompts, task definitions, or wrapper script arguments.
- **FIDO2 PINs** follow the same pattern -- injected via environment, never passed as CLI arguments (which would be visible in `/proc`).
- The wrapper scripts never echo or log PIN values.

### Serial Port Safety

The `serial.sh` wrapper prevents arbitrary serial commands. It restricts operations to a known set (`send`, `flash`, `monitor`, `baud`) and does not expose raw port access. This prevents a coding agent from sending arbitrary AT commands or initiating firmware flashing without going through the wrapper's safety checks (lock verification, timeout, logging).

---

## Adding a New Device

Step-by-step process for adding a new physical device to the system.

### 1. Plug It In

Connect the device to a USB port on the target Dell 5070 runner. Prefer a consistent port (e.g., always rear-left for YubiKeys) so that the udev port-path rule remains stable.

### 2. Identify Attributes

```bash
# Find the device path
dmesg | tail -20
# Look for the new ttyUSB/ttyACM or usb device

# Get full attribute tree
udevadm info --name=/dev/ttyUSB0 --attribute-walk
# Or for non-serial USB devices:
udevadm info --name=/dev/bus/usb/001/005 --attribute-walk

# Note down: idVendor, idProduct, serial (if available), ID_PATH (if you have duplicates)
```

### 3. Write udev Rule

Add a rule to `/etc/udev/rules.d/90-code-orchestration.rules`:

```udev
# Description of the device
SUBSYSTEM=="tty", ATTRS{idVendor}=="XXXX", ATTRS{idProduct}=="YYYY", \
  SYMLINK+="your-device-name", MODE="0660", GROUP="devices"
```

### 4. Reload udev

```bash
udevadm control --reload-rules && udevadm trigger
```

### 5. Verify Symlink

```bash
ls -la /dev/your-device-name
# Should show a symlink pointing to the actual device node
```

### 6. Update Nomad Client Metadata

Add the device to the Nomad client's `meta` block. There are two ways:

**Option A: Runtime metadata update (Nomad 1.7+):**

```bash
nomad node meta apply \
  device_yourdevice=true \
  device_yourdevice_path=/dev/your-device-name
```

This takes effect immediately with no restart required.

**Option B: Config file update (any Nomad version):**

Edit the Nomad client configuration (e.g., `/etc/nomad.d/devices.hcl`):

```hcl
client {
  meta {
    device_yourdevice      = "true"
    device_yourdevice_path = "/dev/your-device-name"
  }
}
```

Then reload or restart Nomad:

```bash
systemctl reload nomad
# or if reload is not sufficient:
systemctl restart nomad
```

### 7. Write Wrapper Script

Create `/opt/code-orchestration/devices/your-device.sh`:

- Copy the structure from an existing wrapper (e.g., `yubikey.sh` for USB devices, `serial.sh` for serial devices).
- Set the correct `DEVICE` path and `LOCK` path.
- Define the allowed subcommands.
- Make it executable: `chmod 755 /opt/code-orchestration/devices/your-device.sh`.

### 8. Update the Device Health Script

If you are using the periodic device health script (Option 1 from "Device Health Monitoring"), add the new device to its `DEVICES` map:

```bash
declare -A DEVICES=(
  # ... existing devices ...
  ["yourdevice"]="/dev/your-device-name"
)
```

### 9. Add USBGuard Rule

If USBGuard is enabled, whitelist the new device's vendor:product ID in `/etc/usbguard/rules.conf`:

```
allow id XXXX:YYYY  # Description of your device
```

Then reload USBGuard:

```bash
usbguard allow-device XXXX:YYYY
# or edit rules.conf and restart:
systemctl restart usbguard
```

### 10. Verify

```bash
yeet devices
```

This should show the new device as available on the node. You can also verify directly via the Nomad API:

```bash
curl -s http://localhost:4646/v1/node/$(nomad node status -self -json | jq -r '.ID') \
  | jq '.Meta | to_entries[] | select(.key | startswith("device_"))'
```

The device is now available for task routing. Any task dispatched with `--needs yourdevice` will be routed to this node:

```bash
yeet run --needs yourdevice -- "test the new device"
```
