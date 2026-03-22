# Device Management

How physical USB devices (security keys, dev boards, HSMs) are managed across a fleet of Dell 5070 thin clients running code-orchestration.

---

## Overview

The system manages physical devices attached to runner machines. Tasks can require specific devices, and the orchestrator routes tasks to runners that have those devices connected and available. Devices are never accessed directly by the coding agent -- they go through wrapper scripts that handle locking, timeouts, and logging.

The flow is:

1. Devices are plugged into Dell 5070 runners and given stable names via udev rules.
2. The runner daemon discovers devices and reports inventory to the API.
3. When a task requires a device, the orchestrator routes it to a runner that has it available.
4. The runner acquires an exclusive lock on the device before starting the task.
5. The coding agent (Crush/Claude/Aider) accesses the device only through wrapper scripts.
6. After the task completes, the lock is released and the device becomes available again.

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

## Device Inventory

The runner daemon discovers and tracks devices, reporting their state to the orchestrator API.

### Discovery Process

On startup and periodically (every 60 seconds):

1. Scan `/dev/` for known symlinks (defined by udev rules).
2. Cross-reference with expected devices in the runner config file.
3. Report inventory to the API.

### Inventory Payload

The runner sends a device inventory report to `POST /api/runners/{runner_id}/devices`:

```json
{
  "runner_id": "dell-02",
  "devices": [
    {
      "name": "yubikey-1",
      "type": "usb-security-key",
      "vendor": "1050",
      "product": "0407",
      "serial": "12345678",
      "path": "/dev/yubikey-1",
      "status": "connected",
      "locked_by": null
    },
    {
      "name": "esp32-main",
      "type": "usb-serial",
      "vendor": "10c4",
      "product": "ea60",
      "path": "/dev/esp32-main",
      "baud": 115200,
      "status": "connected",
      "locked_by": "task-abc123"
    }
  ]
}
```

### Hotplug Detection

Rather than relying solely on the 60-second polling interval, the runner daemon can detect hotplug events in real-time using two methods:

**udevadm monitor** -- subscribes to the kernel's uevent stream:

```bash
udevadm monitor --subsystem-match=usb --subsystem-match=tty
```

The runner daemon spawns this as a child process and parses its stdout for `add` and `remove` events, triggering an immediate inventory update when a known device is plugged or unplugged.

**inotify on /dev/** -- watches for symlink creation and removal:

The runner daemon sets up inotify watches on `/dev/` for the specific symlink names it expects (e.g., `yubikey-1`, `esp32-main`). This catches changes faster than polling and with less overhead than parsing udevadm monitor output.

In practice, both methods are used: inotify for speed, polling as a fallback to catch anything inotify missed.

---

## Device Locking

Exclusive access to devices is enforced using `flock(1)` advisory locks. This prevents two tasks from accessing the same device simultaneously.

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

1. **Task arrives** requiring `yubikey-1`.
2. **Orchestrator routes** the task to a runner that reports `yubikey-1` as `connected` and `locked_by: null`.
3. **Runner checks** the device symlink exists in `/dev/`.
4. **Runner acquires flock** on `/var/lock/code-orchestration/device-yubikey-1.lock`.
5. **Runner updates** device status to `locked_by: "task-abc123"` and reports to API.
6. **Runtime spawns** (Crush/Claude/Aider). The coding agent accesses the device through the wrapper script. The wrapper verifies the lock is held before proceeding.
7. **Task completes** (success or failure).
8. **Runner process exits**, which **releases the flock** automatically.
9. **Runner updates** device status to `locked_by: null` and reports to API.

### Error Cases

**Device locked by another task:**

The orchestrator will not route a task to a runner where the required device is already locked. If a task is submitted and the only runner with the required device is busy, the task enters the queue. It will be picked up when the device becomes free (the runner reports `locked_by: null` on its next heartbeat or status change event).

**Device disconnected while locked:**

If a device disappears (symlink vanishes from `/dev/`) while a task holds its lock:

1. The runner detects the disconnection (via inotify or health check).
2. The runner pauses the task's execution.
3. The runner sends a notification to the orchestrator with the event details.
4. The runner waits for the device to reappear (reconnection) or for a configurable timeout (default: 5 minutes).
5. If the device reappears, execution resumes.
6. If the timeout expires, the task is marked as failed with error `device_disconnected`.

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

The runner daemon continuously monitors device health to detect problems early.

### Health Check Loop

Every 60 seconds, on each runner, for each expected device:

1. **Check symlink exists** in `/dev/` -- if the symlink is gone, the device has been unplugged.
2. **For serial devices** -- try opening the port non-blocking (`stty -F /dev/esp32-main`). If this fails, the device may be in a bad state.
3. **For USB devices** -- check presence in `lsusb` output by vendor:product ID.
4. **For PKCS#11 devices** -- run `pkcs11-tool --module <module> --list-slots` and verify the expected slot appears.

Status changes are reported to the API immediately via `POST /api/runners/{runner_id}/devices/status` -- the runner does not wait for the next 60-second heartbeat.

If a device disappears while a task is using it, the runner pauses the task and sends a notification to the user.

### Device Status States

```
connected  -->  locked        (task acquires device)
locked     -->  connected     (task completes, lock released)
connected  -->  disconnected  (device unplugged)
disconnected -> connected     (device plugged back in)
connected  -->  error         (device present but not responding)
error      -->  connected     (device recovers, e.g., after reset)
```

State transitions are logged and reported. The orchestrator uses these states to make routing decisions -- it will never route a task to a device in `disconnected` or `error` state.

---

## Remote Device Access

For when a device is physically attached to one Dell but needed from another. This is a future capability, not in v1. In v1, tasks are always routed to the runner that has the required device.

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

### When to Use Remote Access vs. Task Routing

In most cases, it is simpler and more reliable to route the task to the runner that has the device. Remote device access adds latency, failure modes, and configuration complexity.

Use remote access only when:
- A task needs devices that are on different runners (e.g., sign with HSM on dell-01, then flash firmware on dell-03).
- A device is expensive/rare and you cannot duplicate it across runners.
- You need to consolidate devices on fewer machines for physical security reasons.

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

### 6. Write Wrapper Script

Create `/opt/code-orchestration/devices/your-device.sh`:

- Copy the structure from an existing wrapper (e.g., `yubikey.sh` for USB devices, `serial.sh` for serial devices).
- Set the correct `DEVICE` path and `LOCK` path.
- Define the allowed subcommands.
- Make it executable: `chmod 755 /opt/code-orchestration/devices/your-device.sh`.

### 7. Add to Runner Config

Add the device to the runner's configuration file so the daemon knows to look for it:

```yaml
devices:
  - name: your-device-name
    type: usb-serial          # or usb-security-key, hsm, smart-card, usb-storage
    vendor: "XXXX"
    product: "YYYY"
    path: /dev/your-device-name
    capabilities:
      - firmware-flash
      - serial-monitor
```

### 8. Restart Runner Daemon

```bash
systemctl restart code-orchestration-runner
```

Alternatively, the runner daemon will auto-detect the new device on its next health check cycle (within 60 seconds), but the config file must be updated first so the daemon knows to expect it.

### 9. Verify

```bash
co devices
```

This should show the new device as `connected` on the runner. You can also check the API directly:

```bash
curl -s http://localhost:8080/api/runners/dell-02/devices | jq .
```

The device is now available for task routing. Any task that declares a requirement for this device (by name or by capability) will be routed to this runner.
