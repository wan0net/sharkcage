# Deployment Guide: Dell 5070 Runner Fleet

This document covers end-to-end setup of Dell OptiPlex 5070 Micro thin clients as autonomous coding agent runners for code-orchestration. Follow it top to bottom to go from bare hardware to a working fleet.

---

## 1. Hardware: Dell OptiPlex 5070 Micro

The Dell OptiPlex 5070 Micro is a small-form-factor desktop that makes an excellent always-on runner node.

**Specs (typical used unit, ~$80-120 AUD):**

- CPU: Intel Celeron/Pentium (base), or i5-9500T if upgraded
- RAM: 4-8 GB DDR4 (8 GB recommended)
- Storage: 128-256 GB M.2 SSD
- Network: Gigabit Ethernet (Intel I219-LM)
- USB: 4x USB 3.0, 1x USB-C (front and rear)
- Power: ~15W typical draw, fanless or near-silent

**Why these boxes work:**

Claude Code, Crush, and Aider are API-call-heavy, not compute-heavy. The LLM inference runs in the cloud. These boxes just run the CLI process, manage local files, and shuttle JSON over HTTPS. A Celeron with 4 GB RAM is more than enough. Three of them running 24/7 cost roughly $15-20 AUD per year in electricity.

The multiple USB 3.0 ports matter for device-attached tasks (YubiKeys, ESP32 boards, serial consoles).

---

## 2. OS Installation

### Base OS

Ubuntu Server 24.04 LTS, minimal installation. No desktop environment, no snaps beyond what ships by default.

### Autoinstall via USB

Use Ubuntu's autoinstall (cloud-init) mechanism for repeatable, hands-off installs. Flash the Ubuntu Server 24.04 ISO to a USB drive, then add an autoinstall config.

Create `autoinstall.yaml` and place it on a second USB drive or embed it in the ISO:

```yaml
#cloud-config
autoinstall:
  version: 1

  locale: en_AU.UTF-8
  timezone: Australia/Sydney

  keyboard:
    layout: us

  identity:
    hostname: co-dell-01
    username: runner
    # Password hash for initial login. Generate with:
    #   mkpasswd --method=sha-512
    # This is "changeme" -- change it on first login or let Ansible handle it.
    password: "$6$rounds=4096$randomsalt$hashedpasswordhere"

  ssh:
    install-server: true
    allow-pw: true
    authorized-keys:
      - ssh-ed25519 AAAA... runner-fleet-key

  network:
    version: 2
    ethernets:
      eno1:
        dhcp4: false
        addresses:
          - 192.168.1.101/24
        routes:
          - to: default
            via: 192.168.1.1
        nameservers:
          addresses:
            - 1.1.1.1
            - 8.8.8.8

  storage:
    layout:
      name: lvm

  packages:
    - openssh-server
    - curl
    - git

  late-commands:
    - curtin in-target --target=/target -- systemctl enable ssh

  user-data:
    disable_root: true
```

Change the `hostname` and `addresses` per box:

| Box | Hostname | IP |
|-----|----------|----|
| Dell 1 | `co-dell-01` | `192.168.1.101` |
| Dell 2 | `co-dell-02` | `192.168.1.102` |
| Dell 3 | `co-dell-03` | `192.168.1.103` |

Static IPs are recommended for lab stability. If you prefer DHCP, use DHCP reservations on your router so the IPs stay consistent.

After install, verify you can SSH in:

```bash
ssh runner@192.168.1.101
```

---

## 3. Ansible Provisioning

One playbook provisions everything after the base OS is installed. Run it from your laptop (or any machine with Ansible and network access to the Dells).

### Prerequisites (on your control machine)

```bash
sudo apt install ansible    # or brew install ansible on macOS
ssh-keygen -t ed25519 -f ~/.ssh/co-fleet -C "code-orchestration fleet"
```

Copy the public key to each Dell during OS install (via autoinstall `authorized-keys`) or manually:

```bash
ssh-copy-id -i ~/.ssh/co-fleet runner@192.168.1.101
```

### Inventory File

Create `ansible/inventory.ini`:

```ini
[runners]
co-dell-01 ansible_host=192.168.1.101
co-dell-02 ansible_host=192.168.1.102
co-dell-03 ansible_host=192.168.1.103

[redis]
co-dell-01 ansible_host=192.168.1.101

[runners:vars]
ansible_user=runner
ansible_ssh_private_key_file=~/.ssh/co-fleet
ansible_become=true
ansible_become_method=sudo
```

### Playbook

Create `ansible/playbook.yml`:

```yaml
---
- name: Provision code-orchestration runner fleet
  hosts: runners
  become: true

  vars:
    tailscale_authkey: "{{ lookup('env', 'TAILSCALE_AUTHKEY') }}"
    redis_password: "{{ lookup('env', 'CO_REDIS_PASSWORD') }}"
    anthropic_api_key: "{{ lookup('env', 'ANTHROPIC_API_KEY') }}"
    openai_api_key: "{{ lookup('env', 'OPENAI_API_KEY') | default('', true) }}"
    google_api_key: "{{ lookup('env', 'GOOGLE_API_KEY') | default('', true) }}"
    github_deploy_key: "{{ lookup('file', '~/.ssh/co-github-deploy') }}"
    node_version: "22"
    co_repo: "git@github.com:wan0net/code-orchestration.git"
    co_base_dir: "/opt/code-orchestration"

  roles:
    - base
    - tailscale
    - node
    - redis
    - runtimes
    - git
    - devices
    - runner
```

### Role: base

`ansible/roles/base/tasks/main.yml`:

```yaml
---
- name: Update apt cache and upgrade all packages
  apt:
    update_cache: true
    upgrade: dist
    cache_valid_time: 3600

- name: Install essential packages
  apt:
    name:
      - git
      - curl
      - wget
      - jq
      - build-essential
      - usbutils
      - unattended-upgrades
      - apt-listchanges
      - ufw
      - htop
      - tmux
      - logrotate
      - python3-pip
    state: present

- name: Set timezone to Australia/Sydney
  timezone:
    name: Australia/Sydney

- name: Configure unattended-upgrades
  copy:
    dest: /etc/apt/apt.conf.d/50unattended-upgrades
    content: |
      Unattended-Upgrade::Allowed-Origins {
          "${distro_id}:${distro_codename}-security";
          "${distro_id}ESMApps:${distro_codename}-apps-security";
      };
      Unattended-Upgrade::AutoFixInterruptedDpkg "true";
      Unattended-Upgrade::Remove-Unused-Dependencies "true";
      Unattended-Upgrade::Automatic-Reboot "false";

- name: Enable unattended-upgrades timer
  copy:
    dest: /etc/apt/apt.conf.d/20auto-upgrades
    content: |
      APT::Periodic::Update-Package-Lists "1";
      APT::Periodic::Unattended-Upgrade "1";

- name: Create devices group
  group:
    name: devices
    state: present

- name: Ensure runner user exists and is in devices group
  user:
    name: runner
    groups: devices
    append: true
    shell: /bin/bash

- name: Configure UFW - deny all incoming by default
  ufw:
    direction: incoming
    policy: deny

- name: Configure UFW - allow all outgoing
  ufw:
    direction: outgoing
    policy: allow

- name: Configure UFW - allow SSH from Tailscale subnet
  ufw:
    rule: allow
    port: "22"
    proto: tcp
    from_ip: 100.64.0.0/10
    comment: "SSH via Tailscale only"

- name: Configure UFW - allow runner health endpoint from Tailscale
  ufw:
    rule: allow
    port: "9090"
    proto: tcp
    from_ip: 100.64.0.0/10
    comment: "Health endpoint via Tailscale"

- name: Enable UFW
  ufw:
    state: enabled

- name: Configure logrotate for code-orchestration
  copy:
    dest: /etc/logrotate.d/code-orchestration
    content: |
      /var/log/code-orchestration/*.log {
          daily
          missingok
          rotate 14
          compress
          delaycompress
          notifempty
          create 0640 runner runner
      }
```

### Role: tailscale

`ansible/roles/tailscale/tasks/main.yml`:

```yaml
---
- name: Add Tailscale signing key
  shell: |
    curl -fsSL https://pkgs.tailscale.com/stable/ubuntu/noble.noarmor.gpg \
      | tee /usr/share/keyrings/tailscale-archive-keyring.gpg > /dev/null
  args:
    creates: /usr/share/keyrings/tailscale-archive-keyring.gpg

- name: Add Tailscale apt repository
  copy:
    dest: /etc/apt/sources.list.d/tailscale.list
    content: |
      deb [signed-by=/usr/share/keyrings/tailscale-archive-keyring.gpg] https://pkgs.tailscale.com/stable/ubuntu noble main

- name: Install Tailscale
  apt:
    name: tailscale
    state: present
    update_cache: true

- name: Enable and start Tailscale service
  systemd:
    name: tailscaled
    enabled: true
    state: started

- name: Join Tailscale network
  shell: |
    tailscale up \
      --authkey={{ tailscale_authkey }} \
      --hostname={{ inventory_hostname }} \
      --ssh
  args:
    creates: /var/lib/tailscale/tailscaled.state
  when: tailscale_authkey | length > 0

- name: Get Tailscale IP
  command: tailscale ip -4
  register: tailscale_ip
  changed_when: false

- name: Store Tailscale IP as fact
  set_fact:
    ts_ip: "{{ tailscale_ip.stdout | trim }}"
```

### Role: node

`ansible/roles/node/tasks/main.yml`:

```yaml
---
- name: Add NodeSource signing key
  shell: |
    curl -fsSL https://deb.nodesource.com/gpgkey/nodesource-repo.gpg.key \
      | gpg --dearmor -o /usr/share/keyrings/nodesource.gpg
  args:
    creates: /usr/share/keyrings/nodesource.gpg

- name: Add NodeSource repository
  copy:
    dest: /etc/apt/sources.list.d/nodesource.list
    content: |
      deb [signed-by=/usr/share/keyrings/nodesource.gpg] https://deb.nodesource.com/node_{{ node_version }}.x nodistro main

- name: Install Node.js
  apt:
    name: nodejs
    state: present
    update_cache: true

- name: Install pnpm globally
  npm:
    name: pnpm
    global: true
    state: present

- name: Verify Node.js installation
  command: node --version
  register: node_ver
  changed_when: false

- name: Verify pnpm installation
  command: pnpm --version
  register: pnpm_ver
  changed_when: false

- name: Print Node.js and pnpm versions
  debug:
    msg: "Node.js {{ node_ver.stdout }}, pnpm {{ pnpm_ver.stdout }}"
```

### Role: redis

`ansible/roles/redis/tasks/main.yml`:

```yaml
---
- name: Install Redis
  apt:
    name: redis-server
    state: present
  when: inventory_hostname in groups['redis']

- name: Configure Redis
  copy:
    dest: /etc/redis/redis.conf
    content: |
      # code-orchestration Redis configuration
      # Bind to Tailscale IP and localhost only
      bind {{ ts_ip }} 127.0.0.1

      # Require authentication
      requirepass {{ redis_password }}

      # Persistence - AOF for durability
      appendonly yes
      appendfilename "appendonly.aof"
      appendfsync everysec

      # Memory limits
      maxmemory 256mb
      maxmemory-policy noeviction

      # Standard settings
      port 6379
      daemonize no
      supervised systemd
      loglevel notice
      logfile /var/log/redis/redis-server.log

      # Security
      protected-mode yes
      rename-command FLUSHALL ""
      rename-command FLUSHDB ""
      rename-command DEBUG ""

      # Performance
      tcp-backlog 511
      timeout 0
      tcp-keepalive 300
      databases 4
    owner: redis
    group: redis
    mode: "0640"
  when: inventory_hostname in groups['redis']
  notify: restart redis

- name: Enable and start Redis
  systemd:
    name: redis-server
    enabled: true
    state: started
  when: inventory_hostname in groups['redis']

handlers:
  - name: restart redis
    systemd:
      name: redis-server
      state: restarted
```

Note: Place the handler in `ansible/roles/redis/handlers/main.yml`:

```yaml
---
- name: restart redis
  systemd:
    name: redis-server
    state: restarted
```

### Role: runtimes

`ansible/roles/runtimes/tasks/main.yml`:

```yaml
---
- name: Install Claude Code CLI
  npm:
    name: "@anthropic-ai/claude-code"
    global: true
    state: present

- name: Verify Claude Code installation
  command: claude --version
  register: claude_ver
  changed_when: false
  ignore_errors: true

- name: Install Go (for Crush)
  apt:
    name: golang-go
    state: present

- name: Install Crush via go install
  become: true
  become_user: runner
  shell: |
    export GOPATH=/home/runner/go
    export PATH=$PATH:/usr/local/go/bin:$GOPATH/bin
    go install github.com/crushcoding/crush@latest
  args:
    creates: /home/runner/go/bin/crush

- name: Symlink Crush to /usr/local/bin
  file:
    src: /home/runner/go/bin/crush
    dest: /usr/local/bin/crush
    state: link
  ignore_errors: true

- name: Install Aider (optional)
  pip:
    name: aider-chat
    state: present
    executable: pip3
  ignore_errors: true

- name: Deploy environment file with API keys
  copy:
    dest: "{{ co_base_dir }}/.env"
    content: |
      NODE_ENV=production
      ANTHROPIC_API_KEY={{ anthropic_api_key }}
      OPENAI_API_KEY={{ openai_api_key }}
      GOOGLE_API_KEY={{ google_api_key }}
      REDIS_URL=redis://:{{ redis_password }}@{{ hostvars[groups['redis'][0]]['ts_ip'] }}:6379
    owner: runner
    group: runner
    mode: "0600"

- name: Print runtime versions
  debug:
    msg: "Claude Code: {{ claude_ver.stdout | default('not installed') }}"
```

### Role: git

`ansible/roles/git/tasks/main.yml`:

```yaml
---
- name: Install GitHub CLI
  shell: |
    curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg \
      | dd of=/usr/share/keyrings/githubcli-archive-keyring.gpg
    echo "deb [arch=$(dpkg --print-architecture) signed-by=/usr/share/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" \
      | tee /etc/apt/sources.list.d/github-cli.list > /dev/null
    apt update && apt install -y gh
  args:
    creates: /usr/bin/gh

- name: Configure git user for runner
  become: true
  become_user: runner
  git_config:
    name: "{{ item.name }}"
    value: "{{ item.value }}"
    scope: global
  loop:
    - { name: "user.name", value: "code-orchestration" }
    - { name: "user.email", value: "co-runner@link42.app" }

- name: Create .ssh directory for runner
  file:
    path: /home/runner/.ssh
    state: directory
    owner: runner
    group: runner
    mode: "0700"

- name: Deploy GitHub deploy key
  copy:
    content: "{{ github_deploy_key }}"
    dest: /home/runner/.ssh/github_deploy
    owner: runner
    group: runner
    mode: "0600"

- name: Configure SSH to use deploy key for GitHub
  copy:
    dest: /home/runner/.ssh/config
    content: |
      Host github.com
        HostName github.com
        User git
        IdentityFile ~/.ssh/github_deploy
        IdentitiesOnly yes
        StrictHostKeyChecking accept-new
    owner: runner
    group: runner
    mode: "0644"

- name: Create workspaces directory
  file:
    path: "{{ co_base_dir }}/workspaces"
    state: directory
    owner: runner
    group: runner
    mode: "0755"

- name: Add GitHub to known_hosts
  become: true
  become_user: runner
  shell: |
    ssh-keyscan github.com >> /home/runner/.ssh/known_hosts 2>/dev/null
  args:
    creates: /home/runner/.ssh/known_hosts
```

### Role: devices

`ansible/roles/devices/tasks/main.yml`:

```yaml
---
- name: Install device tool packages
  apt:
    name:
      - yubikey-manager
      - opensc
      - libpkcs11-helper1
      - picocom
      - python3-serial
      - usbguard
    state: present

- name: Install esptool
  pip:
    name: esptool
    state: present
    executable: pip3

- name: Create device directories
  file:
    path: "{{ item }}"
    state: directory
    owner: runner
    group: devices
    mode: "0775"
  loop:
    - "{{ co_base_dir }}/devices"
    - /var/lock/code-orchestration
    - /var/log/code-orchestration

- name: Deploy udev rules for USB devices
  copy:
    dest: /etc/udev/rules.d/90-code-orchestration.rules
    content: |
      # YubiKey 5 series
      SUBSYSTEM=="usb", ATTR{idVendor}=="1050", ATTR{idProduct}=="0407", \
        SYMLINK+="yubikey-%n", GROUP="devices", MODE="0660", \
        TAG+="systemd", ENV{SYSTEMD_ALIAS}="/dev/yubikey-%n"

      # ESP32 (Silicon Labs CP210x)
      SUBSYSTEM=="tty", ATTRS{idVendor}=="10c4", ATTRS{idProduct}=="ea60", \
        SYMLINK+="esp32-%n", GROUP="devices", MODE="0660"

      # ESP32 (WCH CH340)
      SUBSYSTEM=="tty", ATTRS{idVendor}=="1a86", ATTRS{idProduct}=="7523", \
        SYMLINK+="esp32-%n", GROUP="devices", MODE="0660"

      # Generic USB serial adapters
      SUBSYSTEM=="tty", ATTRS{idVendor}=="0403", ATTRS{idProduct}=="6001", \
        SYMLINK+="serial-%n", GROUP="devices", MODE="0660"
    mode: "0644"
  notify: reload udev

- name: Deploy device wrapper script - YubiKey info
  copy:
    dest: "{{ co_base_dir }}/devices/yubikey-info.sh"
    content: |
      #!/bin/bash
      # Wrapper: get YubiKey info with locking
      set -euo pipefail
      LOCKFILE="/var/lock/code-orchestration/yubikey.lock"
      DEVICE="${1:-/dev/yubikey-1}"

      exec 200>"$LOCKFILE"
      flock -w 30 200 || { echo "ERROR: Could not acquire YubiKey lock"; exit 1; }

      ykman --device "$DEVICE" info
    owner: runner
    group: devices
    mode: "0755"

- name: Deploy device wrapper script - ESP32 flash
  copy:
    dest: "{{ co_base_dir }}/devices/esp32-flash.sh"
    content: |
      #!/bin/bash
      # Wrapper: flash ESP32 firmware with locking
      set -euo pipefail
      LOCKFILE="/var/lock/code-orchestration/esp32.lock"
      DEVICE="${1:-/dev/esp32-main}"
      FIRMWARE="${2:?Usage: esp32-flash.sh <device> <firmware.bin>}"

      exec 200>"$LOCKFILE"
      flock -w 60 200 || { echo "ERROR: Could not acquire ESP32 lock"; exit 1; }

      esptool.py --port "$DEVICE" --baud 115200 write_flash 0x0 "$FIRMWARE"
    owner: runner
    group: devices
    mode: "0755"

- name: Configure USBGuard base policy
  copy:
    dest: /etc/usbguard/rules.conf
    content: |
      # Allow hub devices (internal)
      allow with-interface equals { 09:00:00 }
      # Allow HID (keyboard/mouse for emergency local access)
      allow with-interface one-of { 03:00:00 03:01:01 03:01:02 }
      # Allow YubiKey
      allow id 1050:0407
      # Allow ESP32 CP210x
      allow id 10c4:ea60
      # Allow ESP32 CH340
      allow id 1a86:7523
      # Block everything else
      reject
    mode: "0600"
  notify: restart usbguard

handlers:
  - name: reload udev
    shell: udevadm control --reload-rules && udevadm trigger

  - name: restart usbguard
    systemd:
      name: usbguard
      state: restarted
```

Note: Place handlers in `ansible/roles/devices/handlers/main.yml`:

```yaml
---
- name: reload udev
  shell: udevadm control --reload-rules && udevadm trigger

- name: restart usbguard
  systemd:
    name: usbguard
    state: restarted
```

### Role: runner

`ansible/roles/runner/tasks/main.yml`:

```yaml
---
- name: Create code-orchestration base directory
  file:
    path: "{{ co_base_dir }}"
    state: directory
    owner: runner
    group: runner
    mode: "0755"

- name: Clone code-orchestration repository
  become: true
  become_user: runner
  git:
    repo: "{{ co_repo }}"
    dest: "{{ co_base_dir }}"
    version: main
    update: true
    force: false

- name: Install code-orchestration dependencies
  become: true
  become_user: runner
  command: pnpm install --frozen-lockfile
  args:
    chdir: "{{ co_base_dir }}"

- name: Build code-orchestration
  become: true
  become_user: runner
  command: pnpm build
  args:
    chdir: "{{ co_base_dir }}"

- name: Deploy runner config
  template:
    src: config.yaml.j2
    dest: "{{ co_base_dir }}/config.yaml"
    owner: runner
    group: runner
    mode: "0640"

- name: Deploy systemd service file
  copy:
    dest: /etc/systemd/system/code-orchestration-runner.service
    content: |
      [Unit]
      Description=code-orchestration runner daemon
      After=network-online.target redis.service
      Wants=network-online.target

      [Service]
      Type=simple
      User=runner
      Group=runner
      WorkingDirectory={{ co_base_dir }}
      ExecStart=/usr/bin/node dist/runner/index.js
      Restart=always
      RestartSec=10
      Environment=NODE_ENV=production
      EnvironmentFile={{ co_base_dir }}/.env

      # Security hardening
      NoNewPrivileges=true
      ProtectSystem=strict
      ReadWritePaths={{ co_base_dir }} /var/lock/code-orchestration /var/log/code-orchestration /tmp
      PrivateTmp=true

      # Resource limits
      LimitNOFILE=65536

      [Install]
      WantedBy=multi-user.target
    mode: "0644"
  notify: reload systemd

- name: Enable and start code-orchestration runner
  systemd:
    name: code-orchestration-runner
    enabled: true
    state: started
    daemon_reload: true

- name: Deploy worktree cleanup cron
  cron:
    name: "Clean old code-orchestration worktrees"
    user: runner
    minute: "0"
    hour: "3"
    weekday: "0"
    job: >-
      find {{ co_base_dir }}/workspaces -maxdepth 3 -name '.git' -type f
      -mtime +7 -execdir git worktree remove --force . \; 2>/dev/null || true

handlers:
  - name: reload systemd
    systemd:
      daemon_reload: true
```

Note: Place the handler in `ansible/roles/runner/handlers/main.yml`:

```yaml
---
- name: reload systemd
  systemd:
    daemon_reload: true
```

### Runner Config Template

`ansible/roles/runner/templates/config.yaml.j2`:

```yaml
runner_id: {{ inventory_hostname }}
api_url: https://co-api.link42.app
redis_url: redis://:{{ redis_password }}@{{ hostvars[groups['redis'][0]]['ts_ip'] }}:6379

runtimes:
  crush:
    binary: /usr/local/bin/crush
    default_model: anthropic/claude-sonnet-4
  claude:
    binary: /usr/local/bin/claude
    default_model: sonnet

projects:
  login2:
    repo: git@github.com:wan0net/auth.git
    path: {{ co_base_dir }}/workspaces/login2
    preferred_runtime: claude
  peer6:
    repo: git@github.com:wan0net/mentor.git
    path: {{ co_base_dir }}/workspaces/peer6
    preferred_runtime: crush

devices: []

queues:
  - tasks:general
```

---

## 4. Runner Configuration Reference

Each runner gets a `config.yaml` deployed by Ansible. Here is a fully populated example for a runner with USB devices attached:

```yaml
runner_id: co-dell-02
api_url: https://co-api.link42.app
redis_url: redis://:password@100.x.y.z:6379

runtimes:
  crush:
    binary: /usr/local/bin/crush
    default_model: anthropic/claude-sonnet-4
  claude:
    binary: /usr/local/bin/claude
    default_model: sonnet

projects:
  login2:
    repo: git@github.com:wan0net/auth.git
    path: /opt/code-orchestration/workspaces/login2
    preferred_runtime: claude
  peer6:
    repo: git@github.com:wan0net/mentor.git
    path: /opt/code-orchestration/workspaces/peer6
    preferred_runtime: crush

devices:
  - name: yubikey-1
    type: usb-security-key
    symlink: /dev/yubikey-1
  - name: esp32-main
    type: usb-serial
    symlink: /dev/esp32-main
    baud: 115200

queues:
  - tasks:login2
  - tasks:peer6
  - tasks:needs-usb-security-key
  - tasks:general
```

Fields:

- **runner_id**: Matches the hostname. Used to identify this runner in the API and logs.
- **api_url**: The code-orchestration API endpoint. Either a Cloudflare Worker URL or a Tailscale IP if self-hosted.
- **redis_url**: Connection string for the BullMQ Redis instance. Use the Tailscale IP of whichever Dell runs Redis.
- **runtimes**: Available coding agent CLIs on this box. Each entry specifies the binary path and default model.
- **projects**: Git repos this runner can work on. Cloned to the specified path. `preferred_runtime` is a hint for task routing.
- **devices**: USB devices attached to this specific runner. The `symlink` is created by udev rules.
- **queues**: BullMQ queues this runner subscribes to. A runner with a YubiKey subscribes to `tasks:needs-usb-security-key` in addition to general queues.

---

## 5. Systemd Service

The complete unit file is deployed by Ansible (see Role: runner above). For reference:

```ini
[Unit]
Description=code-orchestration runner daemon
After=network-online.target redis.service
Wants=network-online.target

[Service]
Type=simple
User=runner
Group=runner
WorkingDirectory=/opt/code-orchestration
ExecStart=/usr/bin/node dist/runner/index.js
Restart=always
RestartSec=10
Environment=NODE_ENV=production
EnvironmentFile=/opt/code-orchestration/.env

# Security hardening
NoNewPrivileges=true
ProtectSystem=strict
ReadWritePaths=/opt/code-orchestration /var/lock/code-orchestration /var/log/code-orchestration /tmp
PrivateTmp=true

# Resource limits
LimitNOFILE=65536

[Install]
WantedBy=multi-user.target
```

Managing the service:

```bash
# Start/stop/restart
sudo systemctl start code-orchestration-runner
sudo systemctl stop code-orchestration-runner
sudo systemctl restart code-orchestration-runner

# Check status
sudo systemctl status code-orchestration-runner

# View logs (live follow)
journalctl -u code-orchestration-runner -f

# View logs (last 100 lines)
journalctl -u code-orchestration-runner -n 100

# Enable on boot
sudo systemctl enable code-orchestration-runner
```

---

## 6. Networking

### Internal LAN

All Dells sit on the same LAN segment for low-latency Redis access. If they are on different networks, Tailscale handles routing transparently -- just use Tailscale IPs for Redis connections.

### Tailscale Mesh

Every Dell and your laptop join the same Tailnet. This provides:

- **SSH from anywhere**: `ssh runner@co-dell-01` via MagicDNS (e.g., `co-dell-01.tail-net.ts.net`)
- **Cross-network routing**: If a Dell is on a different subnet or even a different physical location, Tailscale routes traffic
- **ACLs**: Configure Tailscale ACLs to restrict which devices can reach the runners

Install Tailscale on your laptop too:

```bash
# macOS
brew install tailscale

# Then from any network:
ssh runner@co-dell-01    # MagicDNS resolves via Tailscale
```

### Outbound Connectivity

Runners need outbound HTTPS access to:

| Service | Endpoint |
|---------|----------|
| GitHub | `github.com`, `api.github.com` |
| Anthropic API | `api.anthropic.com` |
| OpenAI API | `api.openai.com` |
| Google API | `generativelanguage.googleapis.com` |
| Cloudflare | Various, for Workers deployment |
| npm registry | `registry.npmjs.org` |

No inbound ports are required from the public internet. All inbound access is via Tailscale.

### DNS

If the code-orchestration API is a Cloudflare Worker, point `co-api.link42.app` to the Worker route in Cloudflare DNS. If you self-host the API on a Dell, use:

- Tailscale IP directly (e.g., `http://100.x.y.z:3000`), or
- MagicDNS hostname (e.g., `http://co-dell-01:3000`)

---

## 7. Redis Configuration

Redis runs on one Dell (designated in the `[redis]` group in Ansible inventory). It holds the BullMQ task queues.

### Full Configuration

Deployed by the `redis` Ansible role. The key settings:

```
# Bind to Tailscale IP and localhost only -- never 0.0.0.0
bind 100.x.y.z 127.0.0.1

# Require authentication
requirepass <strong-password-here>

# AOF persistence -- survives restarts without losing queued tasks
appendonly yes
appendfilename "appendonly.aof"
appendfsync everysec

# Memory limits -- 256MB is more than enough for task queues
maxmemory 256mb
maxmemory-policy noeviction

# Security
protected-mode yes

# Disable dangerous commands
rename-command FLUSHALL ""
rename-command FLUSHDB ""
rename-command DEBUG ""
```

### Verifying Redis

```bash
# From the Redis host
redis-cli -a '<password>' ping
# Should return: PONG

# From another Dell (via Tailscale)
redis-cli -h 100.x.y.z -a '<password>' ping

# Check memory usage
redis-cli -a '<password>' info memory | grep used_memory_human

# Check AOF status
redis-cli -a '<password>' info persistence | grep aof
```

### Backup

The AOF file is at `/var/lib/redis/appendonly.aof`. To back up:

```bash
# Copy AOF file (safe to copy while Redis is running with appendfsync everysec)
cp /var/lib/redis/appendonly.aof /backup/redis-aof-$(date +%Y%m%d).aof
```

To restore, stop Redis, replace the AOF file, and start Redis.

---

## 8. Monitoring and Maintenance

### Logs

```bash
# Live runner logs
journalctl -u code-orchestration-runner -f

# Last hour of logs
journalctl -u code-orchestration-runner --since "1 hour ago"

# Redis logs
journalctl -u redis-server -f

# Application logs (if writing to file)
tail -f /var/log/code-orchestration/runner.log
```

### Queue Monitoring

Bull Board provides a web dashboard for inspecting queues (waiting, active, completed, failed jobs). It runs alongside the API service. Access it via Tailscale:

```
http://co-dell-01:3000/admin/queues
```

### Tailscale Admin Console

View which Dells are online, their Tailscale IPs, and last-seen timestamps at:

```
https://login.tailscale.com/admin/machines
```

### Disk Space

Git worktrees accumulate over time. A weekly cron job (deployed by the runner role) cleans worktrees older than 7 days:

```bash
# Manual cleanup
find /opt/code-orchestration/workspaces -maxdepth 3 -name '.git' -type f \
  -mtime +7 -execdir git worktree remove --force . \; 2>/dev/null

# Check disk usage
du -sh /opt/code-orchestration/workspaces/*
df -h /
```

### Health Endpoint

Each runner exposes a local HTTP health endpoint on port 9090:

```bash
curl http://localhost:9090/health
# Returns: {"status":"ok","runner_id":"co-dell-02","uptime":123456,"active_tasks":1}

# From your laptop (via Tailscale)
curl http://co-dell-02:9090/health
```

### System Health

```bash
# CPU and memory
htop

# Systemd service status
systemctl status code-orchestration-runner redis-server tailscaled

# Network connectivity
tailscale status
ping -c 1 api.anthropic.com

# USB devices
lsusb
udevadm info /dev/yubikey-1
```

---

## 9. Backup and Recovery

### What is Ephemeral

Runner state is intentionally ephemeral. Everything can be rebuilt from:

- **Configuration**: Stored in the code-orchestration repo, managed by Ansible
- **Task data**: Stored in Redis (AOF-backed)
- **Code**: Stored in GitHub repos (just re-clone)

### What to Back Up

| Data | Location | Backup Method |
|------|----------|---------------|
| Redis AOF | `/var/lib/redis/appendonly.aof` | Copy file (cron or manual) |
| API keys | `/opt/code-orchestration/.env` | Stored in your password manager, deployed by Ansible |
| SSH keys | `~/.ssh/co-fleet`, `~/.ssh/co-github-deploy` | Stored in your password manager |
| Ansible inventory | `ansible/inventory.ini` | In the code-orchestration repo |
| Tailscale auth | Tailscale admin console | Re-generate auth key if needed |

### Recovery Procedure

If a Dell dies or you need to add a replacement:

1. Install Ubuntu Server 24.04 on the new hardware (use autoinstall USB, ~10 minutes)
2. Update Ansible inventory with the new hostname and IP
3. Set environment variables for secrets on your control machine
4. Run the playbook:

```bash
export TAILSCALE_AUTHKEY="tskey-auth-..."
export CO_REDIS_PASSWORD="your-redis-password"
export ANTHROPIC_API_KEY="sk-ant-..."

ansible-playbook -i ansible/inventory.ini ansible/playbook.yml --limit co-dell-04
```

5. Attach USB devices and verify udev rules:

```bash
ssh runner@co-dell-04 "lsusb && ls -la /dev/yubikey* /dev/esp32* 2>/dev/null"
```

6. Verify the runner is online:

```bash
co runners
```

Total recovery time: approximately 15 minutes from bare metal to running tasks.

---

## 10. Security Hardening

### Firewall

UFW is configured to deny all inbound traffic except from the Tailscale subnet (100.64.0.0/10):

```bash
# Verify firewall rules
sudo ufw status verbose

# Expected output:
# Status: active
# Default: deny (incoming), allow (outgoing), deny (routed)
# 22/tcp    ALLOW IN    100.64.0.0/10    # SSH via Tailscale only
# 9090/tcp  ALLOW IN    100.64.0.0/10    # Health endpoint via Tailscale
```

### SSH

- Key-only authentication (password auth disabled after initial setup)
- No root login
- Tailscale SSH as fallback (configured in the tailscale role)

Harden `/etc/ssh/sshd_config`:

```
PermitRootLogin no
PasswordAuthentication no
PubkeyAuthentication yes
AuthorizedKeysFile .ssh/authorized_keys
AllowUsers runner
```

### USBGuard

Only expected USB devices are permitted. The policy in `/etc/usbguard/rules.conf` whitelists by vendor:product ID:

```bash
# Check USBGuard status
sudo usbguard list-devices

# If a new device type needs to be allowed, add it to the Ansible role
# and re-run the playbook. Do not edit rules.conf manually on the boxes.
```

### API Key Security

- Stored in `/opt/code-orchestration/.env` with mode `0600`, owned by `runner:runner`
- Never committed to git
- Deployed by Ansible from environment variables on your control machine
- Rotate keys by updating the env vars and re-running Ansible

### Systemd Security

The service unit applies:

- `NoNewPrivileges=true`: Prevents privilege escalation
- `ProtectSystem=strict`: Mounts the filesystem read-only except for explicit `ReadWritePaths`
- `PrivateTmp=true`: Isolates /tmp for the service
- `ReadWritePaths`: Only the directories the runner actually needs

### Audit Trail

All tool calls and device interactions are logged to `/var/log/code-orchestration/`. Combined with systemd journal, this provides a complete audit trail of what each runner executed.

---

## 11. Adding a New Runner

Step-by-step procedure:

**1. Install the OS.**

Flash Ubuntu Server 24.04 to USB with autoinstall config. Update `autoinstall.yaml` with the new hostname (`co-dell-04`) and IP (`192.168.1.104`). Boot the Dell from USB. Installation completes unattended in about 10 minutes.

**2. Add to Ansible inventory.**

Edit `ansible/inventory.ini`:

```ini
[runners]
co-dell-01 ansible_host=192.168.1.101
co-dell-02 ansible_host=192.168.1.102
co-dell-03 ansible_host=192.168.1.103
co-dell-04 ansible_host=192.168.1.104
```

**3. Copy SSH key.**

```bash
ssh-copy-id -i ~/.ssh/co-fleet runner@192.168.1.104
```

**4. Run the playbook (targeted).**

```bash
ansible-playbook -i ansible/inventory.ini ansible/playbook.yml --limit co-dell-04
```

This installs everything: Tailscale, Node.js, runtimes, git config, device tools, and the runner service.

**5. Attach USB devices.**

Plug in any YubiKeys, ESP32 boards, or serial adapters. Verify they are detected and udev rules created the expected symlinks:

```bash
ssh runner@co-dell-04 "lsusb"
ssh runner@co-dell-04 "ls -la /dev/yubikey* /dev/esp32* 2>/dev/null"
```

If you have new device types, add udev rules to the `devices` Ansible role and re-run:

```bash
ansible-playbook -i ansible/inventory.ini ansible/playbook.yml --limit co-dell-04 --tags devices
```

**6. Update runner config.**

Edit `ansible/roles/runner/templates/config.yaml.j2` or use host-specific variables to set the projects, devices, and queues for the new runner. Re-run:

```bash
ansible-playbook -i ansible/inventory.ini ansible/playbook.yml --limit co-dell-04 --tags runner
```

**7. Start and verify.**

```bash
# Check the service is running
ssh runner@co-dell-04 "sudo systemctl status code-orchestration-runner"

# Check it registered with the API
co runners

# The new runner should appear in the list with status "idle"
```

---

## Quick Reference

### Fleet Commands

```bash
# Provision entire fleet
ansible-playbook -i ansible/inventory.ini ansible/playbook.yml

# Provision one box
ansible-playbook -i ansible/inventory.ini ansible/playbook.yml --limit co-dell-02

# Update runtimes only
ansible-playbook -i ansible/inventory.ini ansible/playbook.yml --tags runtimes

# SSH to a runner
ssh runner@co-dell-01

# Check all runners
co runners

# Check queue status
co status
```

### Troubleshooting

| Problem | Check |
|---------|-------|
| Runner not picking up tasks | `journalctl -u code-orchestration-runner -n 50` |
| Redis connection refused | `redis-cli -h <ts-ip> -a <password> ping` |
| Tailscale offline | `tailscale status` on the box |
| USB device not found | `lsusb` and `ls /dev/yubikey*` |
| Disk full | `df -h /` and clean worktrees |
| API key expired | Update env var, re-run Ansible runtimes role |
| Service won't start | `systemctl status code-orchestration-runner` and check ExecStart path |

### File Locations

| Path | Purpose |
|------|---------|
| `/opt/code-orchestration/` | Application root |
| `/opt/code-orchestration/config.yaml` | Runner configuration |
| `/opt/code-orchestration/.env` | API keys and secrets |
| `/opt/code-orchestration/workspaces/` | Cloned project repos and worktrees |
| `/opt/code-orchestration/devices/` | Device wrapper scripts |
| `/var/lock/code-orchestration/` | Device lock files |
| `/var/log/code-orchestration/` | Application logs |
| `/var/lib/redis/appendonly.aof` | Redis persistence |
| `/etc/udev/rules.d/90-code-orchestration.rules` | USB device rules |
| `/etc/usbguard/rules.conf` | USB device whitelist |
