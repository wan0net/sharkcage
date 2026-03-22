---
layout: doc
title: Deployment
description: Setup guide, Ansible playbooks, Nomad config, Tailscale mesh, systemd services.
---

# Deployment Guide

This document covers end-to-end setup of physical machines (e.g., Dell OptiPlex 5070 Micro, Intel NUC, any x86 Linux box) as autonomous coding agent runners for yeet. The architecture uses HashiCorp Nomad for job scheduling -- a single Go binary replaces Redis, BullMQ, and the custom worker daemon. Follow it top to bottom to go from bare hardware to a working fleet.

---

## 1. Hardware

Any low-power x86 Linux box makes an excellent always-on runner node. The Dell OptiPlex 5070 Micro is one good option -- a small-form-factor desktop that's cheap and quiet.

**Specs (typical used unit, ~$80-120 AUD):**

- CPU: Intel Celeron/Pentium (base), or i5-9500T if upgraded
- RAM: 4-8 GB DDR4 (8 GB recommended)
- Storage: 128-256 GB M.2 SSD
- Network: Gigabit Ethernet (Intel I219-LM)
- USB: 4x USB 3.0, 1x USB-C (front and rear)
- Power: ~15W typical draw, fanless or near-silent

**Why these boxes work:**

Claude Code, OpenCode, and Aider are API-call-heavy, not compute-heavy. The LLM inference runs in the cloud. The nodes just run the CLI process, manage local files, and shuttle JSON over HTTPS. A Celeron with 4 GB RAM is more than enough. Three nodes running 24/7 cost roughly $15-20 AUD per year in electricity.

Nomad server + client is a single ~100MB Go binary with minimal resource requirements. It runs comfortably alongside the coding agents on these low-power nodes. No JVM, no database server, no container runtime needed.

The multiple USB 3.0 ports matter for device-attached tasks (YubiKeys, ESP32 boards, serial consoles).

---

## 2. OS Installation

### Base OS

Ubuntu Server 24.04 LTS, minimal installation. No desktop environment, no snaps beyond what ships by default.

**Kernel requirement:** OpenShell sandboxing uses Landlock LSM for filesystem isolation, which requires kernel 5.13+. Ubuntu 22.04+ ships a compatible kernel. Ubuntu 24.04 (kernel 6.8) has full Landlock v3 support. If Landlock is unavailable, OpenShell degrades gracefully in `best_effort` mode but filesystem isolation will be reduced.

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
    hostname: yeet-01
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

| Node | Hostname | IP |
|------|----------|----|
| Runner 1 | `yeet-01` | `192.168.1.101` |
| Runner 2 | `yeet-02` | `192.168.1.102` |
| Runner 3 | `yeet-03` | `192.168.1.103` |

Static IPs are recommended for lab stability. If you prefer DHCP, use DHCP reservations on your router so the IPs stay consistent.

After install, verify you can SSH in:

```bash
ssh runner@192.168.1.101
```

---

## 3. Ansible Provisioning

One playbook provisions everything after the base OS is installed. Run it from your laptop (or any machine with Ansible and network access to the nodes).

### Prerequisites (on your control machine)

```bash
sudo apt install ansible    # or brew install ansible on macOS
ssh-keygen -t ed25519 -f ~/.ssh/co-fleet -C "yeet runner fleet"
```

Copy the public key to each node during OS install (via autoinstall `authorized-keys`) or manually:

```bash
ssh-copy-id -i ~/.ssh/co-fleet runner@192.168.1.101
```

### Inventory File

Create `ansible/inventory.ini`:

```ini
[runners]
yeet-01 ansible_host=192.168.1.101 nomad_role=server
yeet-02 ansible_host=192.168.1.102 nomad_role=client
yeet-03 ansible_host=192.168.1.103 nomad_role=client

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
- name: Provision yeet runner fleet
  hosts: runners
  become: true

  vars:
    tailscale_authkey: "{{ lookup('env', 'TAILSCALE_AUTHKEY') }}"
    anthropic_api_key: "{{ lookup('env', 'ANTHROPIC_API_KEY') }}"
    openai_api_key: "{{ lookup('env', 'OPENAI_API_KEY') | default('', true) }}"
    google_api_key: "{{ lookup('env', 'GOOGLE_API_KEY') | default('', true) }}"
    github_deploy_key: "{{ lookup('file', '~/.ssh/co-github-deploy') }}"
    node_version: "22"
    openshell_version: "0.1.0"
    co_repo: "git@github.com:wan0net/yeet.git"
    co_base_dir: "/opt/yeet"

  roles:
    - base
    - tailscale
    - node
    - nomad
    - runtimes
    - sandbox
    - git
    - devices
    - jobs
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

- name: Configure UFW - allow Nomad HTTP API from Tailscale
  ufw:
    rule: allow
    port: "4646"
    proto: tcp
    from_ip: 100.64.0.0/10
    comment: "Nomad HTTP API via Tailscale"

- name: Configure UFW - allow Nomad RPC from Tailscale
  ufw:
    rule: allow
    port: "4647"
    proto: tcp
    from_ip: 100.64.0.0/10
    comment: "Nomad RPC via Tailscale"

- name: Configure UFW - allow Nomad Serf from Tailscale
  ufw:
    rule: allow
    port: "4648"
    proto: tcp
    from_ip: 100.64.0.0/10
    comment: "Nomad Serf via Tailscale"

- name: Enable UFW
  ufw:
    state: enabled

- name: Configure logrotate for yeet runner
  copy:
    dest: /etc/logrotate.d/yeet
    content: |
      /var/log/yeet/*.log {
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

### Role: nomad

`ansible/roles/nomad/tasks/main.yml`:

```yaml
---
- name: Download Nomad binary
  get_url:
    url: "https://releases.hashicorp.com/nomad/{{ nomad_version }}/nomad_{{ nomad_version }}_linux_amd64.zip"
    dest: /tmp/nomad.zip
    checksum: "sha256:{{ nomad_sha256 }}"
  vars:
    nomad_version: "1.9.7"
    nomad_sha256: "check-releases.hashicorp.com-for-current-hash"

- name: Install unzip
  apt:
    name: unzip
    state: present

- name: Extract Nomad binary
  unarchive:
    src: /tmp/nomad.zip
    dest: /usr/local/bin/
    remote_src: true
    mode: "0755"

- name: Verify Nomad installation
  command: nomad version
  register: nomad_ver
  changed_when: false

- name: Print Nomad version
  debug:
    msg: "{{ nomad_ver.stdout }}"

- name: Create Nomad data directory
  file:
    path: /opt/nomad/data
    state: directory
    owner: root
    group: root
    mode: "0700"

- name: Create Nomad config directory
  file:
    path: /etc/nomad.d
    state: directory
    owner: root
    group: root
    mode: "0755"

- name: Deploy Nomad server+client config
  copy:
    dest: /etc/nomad.d/nomad.hcl
    content: |
      data_dir = "/opt/nomad/data"
      bind_addr = "0.0.0.0"

      advertise {
        http = "{{ ts_ip }}:4646"
        rpc  = "{{ ts_ip }}:4647"
        serf = "{{ ts_ip }}:4648"
      }

      server {
        enabled          = true
        bootstrap_expect = 1
      }

      client {
        enabled = true
        meta {
          "project_peer6" = "true"
          "project_rule1" = "true"
        }
      }

      plugin "raw_exec" {
        config {
          enabled = true
        }
      }

      acl {
        enabled = true
      }
    owner: root
    group: root
    mode: "0640"
  when: nomad_role == "server"
  notify: restart nomad

- name: Deploy Nomad client-only config
  copy:
    dest: /etc/nomad.d/nomad.hcl
    content: |
      data_dir = "/opt/nomad/data"

      server {
        enabled = false
      }

      client {
        enabled = true
        servers = ["yeet-01.tailnet:4646"]
        meta {
          "project_login2"      = "true"
          "device_yubikey"      = "true"
          "device_yubikey_path" = "/dev/yubikey-1"
        }
      }

      plugin "raw_exec" {
        config {
          enabled = true
        }
      }
    owner: root
    group: root
    mode: "0640"
  when: nomad_role == "client"
  notify: restart nomad

- name: Deploy Nomad systemd service
  copy:
    dest: /etc/systemd/system/nomad.service
    content: |
      [Unit]
      Description=HashiCorp Nomad
      Documentation=https://nomadproject.io/docs/
      Wants=network-online.target
      After=network-online.target

      [Service]
      ExecStart=/usr/local/bin/nomad agent -config=/etc/nomad.d/
      ExecReload=/bin/kill -HUP $MAINPID
      KillMode=process
      KillSignal=SIGINT
      LimitNOFILE=65536
      LimitNPROC=infinity
      Restart=on-failure
      RestartSec=2
      TasksMax=infinity

      [Install]
      WantedBy=multi-user.target
    mode: "0644"
  notify: reload systemd

- name: Enable and start Nomad
  systemd:
    name: nomad
    enabled: true
    state: started
    daemon_reload: true
```

Place handlers in `ansible/roles/nomad/handlers/main.yml`:

```yaml
---
- name: reload systemd
  systemd:
    daemon_reload: true

- name: restart nomad
  systemd:
    name: nomad
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

- name: Install Go (for OpenCode)
  apt:
    name: golang-go
    state: present

- name: Install OpenCode via go install
  become: true
  become_user: runner
  shell: |
    export GOPATH=/home/runner/go
    export PATH=$PATH:/usr/local/go/bin:$GOPATH/bin
    go install github.com/opencodedevs/opencode@latest
  args:
    creates: /home/runner/go/bin/opencode

- name: Symlink OpenCode to /usr/local/bin
  file:
    src: /home/runner/go/bin/opencode
    dest: /usr/local/bin/opencode
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
    owner: runner
    group: runner
    mode: "0600"

- name: Print runtime versions
  debug:
    msg: "Claude Code: {{ claude_ver.stdout | default('not installed') }}"
```

### Role: sandbox

`ansible/roles/sandbox/tasks/main.yml`:

Installs NVIDIA OpenShell (`openshell-sandbox`), a standalone Rust binary that provides kernel-level sandboxing for agent processes. Requires Linux kernel 5.13+ with Landlock LSM support (Ubuntu 22.04+ has this by default).

```yaml
---
- name: Download openshell-sandbox binary
  get_url:
    url: "https://github.com/NVIDIA/OpenShell/releases/download/v{{ openshell_version }}/openshell-sandbox-linux-amd64"
    dest: /usr/local/bin/openshell-sandbox
    mode: '0755'

- name: Verify openshell-sandbox installation
  command: openshell-sandbox --version
  register: openshell_ver
  changed_when: false

- name: Print OpenShell version
  debug:
    msg: "OpenShell: {{ openshell_ver.stdout }}"

- name: Create policy directories
  file:
    path: /opt/yeet/policies
    state: directory
    owner: runner
    group: runner
    mode: '0755'

- name: Deploy base OPA/Rego policy rules
  copy:
    src: policies/agent.rego
    dest: /opt/yeet/policies/agent.rego
    owner: runner
    group: runner
    mode: '0644'

- name: Deploy per-project policy templates
  copy:
    src: "policies/projects/"
    dest: /opt/yeet/policies/projects/
    owner: runner
    group: runner
    mode: '0644'

- name: Check Landlock LSM availability
  shell: cat /sys/kernel/security/lsm
  register: lsm_list
  changed_when: false
  ignore_errors: true

- name: Warn if Landlock is not available
  debug:
    msg: >-
      WARNING: Landlock LSM not detected in kernel. OpenShell will run in
      best_effort mode with reduced filesystem isolation. Upgrade to kernel
      5.13+ or Ubuntu 22.04+ for full sandboxing.
  when: lsm_list.stdout is not search("landlock")
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
    - { name: "user.name", value: "yeet-runner" }
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
    - /var/lock/yeet
    - /var/log/yeet

- name: Deploy udev rules for USB devices
  copy:
    dest: /etc/udev/rules.d/90-yeet.rules
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
      LOCKFILE="/var/lock/yeet/yubikey.lock"
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
      LOCKFILE="/var/lock/yeet/esp32.lock"
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
```

Place handlers in `ansible/roles/devices/handlers/main.yml`:

```yaml
---
- name: reload udev
  shell: udevadm control --reload-rules && udevadm trigger

- name: restart usbguard
  systemd:
    name: usbguard
    state: restarted
```

### Role: jobs

`ansible/roles/jobs/tasks/main.yml`:

```yaml
---
- name: Create yeet directories
  file:
    path: "{{ item }}"
    state: directory
    owner: runner
    group: runner
    mode: "0755"
  loop:
    - "{{ co_base_dir }}"
    - "{{ co_base_dir }}/jobs"
    - "{{ co_base_dir }}/scripts"

- name: Clone yeet repository
  become: true
  become_user: runner
  git:
    repo: "{{ co_repo }}"
    dest: "{{ co_base_dir }}"
    version: main
    update: true
    force: false

- name: Deploy run-agent.sh script
  copy:
    src: scripts/run-agent.sh
    dest: "{{ co_base_dir }}/scripts/run-agent.sh"
    owner: runner
    group: runner
    mode: "0755"

- name: Deploy job templates
  copy:
    src: "jobs/"
    dest: "{{ co_base_dir }}/jobs/"
    owner: runner
    group: runner
    mode: "0644"

- name: Register parameterized job with Nomad
  become: true
  become_user: runner
  shell: |
    nomad job run {{ co_base_dir }}/jobs/run-coding-agent.nomad.hcl
  environment:
    NOMAD_ADDR: "http://{{ ts_ip }}:4646"
  changed_when: true

- name: Deploy worktree cleanup cron
  cron:
    name: "Clean old yeet worktrees"
    user: runner
    minute: "0"
    hour: "3"
    weekday: "0"
    job: >-
      find {{ co_base_dir }}/workspaces -maxdepth 3 -name '.git' -type f
      -mtime +7 -execdir git worktree remove --force . \; 2>/dev/null || true
```

---

## 4. Nomad ACL Setup

After the Nomad server is running on yeet-01, bootstrap ACLs. This is a one-time manual step.

### Step 1: Bootstrap ACL

```bash
ssh runner@yeet-01

export NOMAD_ADDR=http://127.0.0.1:4646
nomad acl bootstrap
```

This prints a management token. Save it securely (password manager). This token has full access and should only be used for administration.

### Step 2: Create policy for `yeet` CLI

Write the policy file:

```bash
cat > /tmp/yeet-cli-policy.hcl << 'EOF'
namespace "default" {
  policy = "write"
  capabilities = ["submit-job", "dispatch-job", "read-job", "read-logs", "alloc-exec", "alloc-lifecycle"]
}

node {
  policy = "read"
}

variable {
  path "cost/*"
  capabilities = ["read", "write"]
}

variable {
  path "sessions/*"
  capabilities = ["read", "write"]
}
EOF
```

Apply it:

```bash
export NOMAD_TOKEN=<management-token>
nomad acl policy apply yeet-cli-policy /tmp/yeet-cli-policy.hcl
```

### Step 3: Create client token

```bash
nomad acl token create -name="yeet-cli" -policy="yeet-cli-policy"
```

This prints the client token. Save it -- this is what your laptop uses to talk to Nomad.

### Step 4: Configure token on laptop

```bash
export NOMAD_TOKEN=<yeet-cli-token>
```

Or set it in the `yeet` config file (see section 5).

---

## 5. `yeet` CLI Installation on Laptop

### Install

```bash
npm install -g @wan0net/yeet
```

Or clone the repo and link it:

```bash
git clone git@github.com:wan0net/yeet.git
cd yeet
pnpm install && pnpm build
npm link
```

### Configure

Create `~/.config/yeet/config.yaml`:

```yaml
# ~/.config/yeet/config.yaml
nomad_addr: http://yeet-01.tailnet:4646
nomad_token: <acl-token>

defaults:
  runtime: opencode
  model: anthropic/claude-sonnet-4

projects:
  peer6:
    runtime: opencode
    model: anthropic/claude-sonnet-4
  login2:
    runtime: claude
    model: opus

notifications:
  ntfy_topic: yeet-notifications
```

Verify connectivity:

```bash
yeet runners        # Should list all Nomad client nodes
yeet status         # Should show registered jobs
```

---

## 6. Networking

### Tailscale Mesh

Every node and your laptop join the same Tailnet. This provides:

- **SSH from anywhere**: `ssh runner@yeet-01` via MagicDNS (e.g., `yeet-01.tail-net.ts.net`)
- **Nomad API access**: `yeet` CLI on your laptop talks to Nomad server over Tailscale
- **Cross-network routing**: If a node is on a different subnet or physical location, Tailscale routes traffic
- **ACLs**: Configure Tailscale ACLs to restrict which devices can reach the runners

Install Tailscale on your laptop:

```bash
# macOS
brew install tailscale

# Then from any network:
ssh runner@yeet-01    # MagicDNS resolves via Tailscale
```

### Nomad Ports

The Nomad server listens on the Tailscale IP, not a public address.

| Port | Protocol | Purpose |
|------|----------|---------|
| 4646 | TCP | HTTP API (job submission, UI, status queries) |
| 4647 | TCP | RPC (internal server-client communication) |
| 4648 | TCP/UDP | Serf (cluster membership gossip) |

All three ports are firewalled to accept connections only from the Tailscale subnet (100.64.0.0/10).

### Outbound Connectivity

Runners need outbound HTTPS access to:

| Service | Endpoint |
|---------|----------|
| GitHub | `github.com`, `api.github.com` |
| Anthropic API | `api.anthropic.com` |
| OpenAI API | `api.openai.com` |
| Google API | `generativelanguage.googleapis.com` |
| npm registry | `registry.npmjs.org` |
| HashiCorp (updates) | `releases.hashicorp.com` |

No inbound ports are required from the public internet. All inbound access is via Tailscale.

---

## 7. Nomad UI

Nomad ships with a built-in web UI. No additional software to install.

### Access

Open in your browser (from any machine on the Tailnet):

```
http://yeet-01.tailnet:4646/ui
```

### Authentication

Click the ACL token icon in the top-right corner and paste your management token or `yeet-cli` token. The UI respects ACL policies -- you see only what your token permits.

### What You Get

- **Jobs**: List of registered jobs, their status, deployment history
- **Allocations**: Running, completed, and failed task instances with logs
- **Nodes**: All client nodes in the cluster, their status, resource usage, metadata
- **Topology**: Visual map of which allocations run on which nodes
- **Logs**: Live-streaming stdout/stderr from any allocation

The UI replaces the need for Bull Board or any custom monitoring dashboard. Everything about job scheduling, execution, and history is visible here.

---

## 8. Monitoring and Maintenance

### Fleet Health

```bash
# List all nodes and their status
nomad node status

# Detailed info on a specific node
nomad node status -verbose <node-id>

# From your laptop via yeet CLI
yeet runners
```

### Live Logs

```bash
# Stream logs from a running allocation
nomad alloc logs -f <alloc-id> execute

# Stream stderr
nomad alloc logs -f -stderr <alloc-id> execute

# Via yeet CLI
yeet logs <task-id>
```

### Nomad Service Logs

```bash
# Live follow of Nomad daemon itself
journalctl -u nomad -f

# Last hour
journalctl -u nomad --since "1 hour ago"
```

### Disk Cleanup

Git worktrees accumulate over time. A weekly cron job (deployed by the jobs role) cleans worktrees older than 7 days.

```bash
# Manual worktree cleanup
find /opt/yeet/workspaces -maxdepth 3 -name '.git' -type f \
  -mtime +7 -execdir git worktree remove --force . \; 2>/dev/null

# Check disk usage
du -sh /opt/yeet/workspaces/*
df -h /

# Nomad garbage collection (clean old allocations)
nomad system gc
```

### System Health

```bash
# CPU and memory
htop

# Nomad and Tailscale status
systemctl status nomad tailscaled

# Network connectivity
tailscale status
ping -c 1 api.anthropic.com

# USB devices
lsusb
udevadm info /dev/yubikey-1
```

---

## 9. Backup and Recovery

### What to Back Up

Nomad state can be snapshotted, but in practice the system is designed to be ephemeral and re-provisionable.

| Data | Location | Backup Method |
|------|----------|---------------|
| Nomad Raft state | `/opt/nomad/data` | `nomad operator snapshot save backup.snap` |
| API keys | `/opt/yeet/.env` | Stored in your password manager, deployed by Ansible |
| SSH keys | `~/.ssh/co-fleet`, `~/.ssh/co-github-deploy` | Stored in your password manager |
| Ansible inventory | `ansible/inventory.ini` | In the yeet repo |
| Nomad ACL tokens | Generated at bootstrap | Stored in your password manager |
| Tailscale auth | Tailscale admin console | Re-generate auth key if needed |

### Nomad State Snapshot

```bash
# Save a snapshot of Nomad's Raft state
export NOMAD_ADDR=http://yeet-01.tailnet:4646
export NOMAD_TOKEN=<management-token>
nomad operator snapshot save backup-$(date +%Y%m%d).snap

# Restore from snapshot (if needed)
nomad operator snapshot restore backup-20260322.snap
```

### Recovery Procedure

If a node dies or you need to rebuild from scratch:

1. Install Ubuntu Server 24.04 on the new hardware (use autoinstall USB, ~10 minutes)
2. Update Ansible inventory with the new hostname and IP
3. Set environment variables for secrets on your control machine
4. Run the playbook:

```bash
export TAILSCALE_AUTHKEY="tskey-auth-..."
export ANTHROPIC_API_KEY="sk-ant-..."

ansible-playbook -i ansible/inventory.ini ansible/playbook.yml --limit yeet-04
```

5. If replacing the server node (yeet-01), restore the Raft snapshot or re-bootstrap ACLs and re-register jobs
6. If replacing a client node, it auto-joins the cluster via Tailscale -- no extra steps
7. Verify:

```bash
nomad node status    # New node appears
yeet runners           # Shows in fleet
```

Total recovery time: approximately 15 minutes from bare metal to accepting jobs.

Git repos are re-cloned from GitHub on first job dispatch. The job template is re-registered by the `jobs` Ansible role.

---

## 10. Security Hardening

### Nomad API Access

The Nomad HTTP API binds to the Tailscale IP, not a public address. UFW rules restrict ports 4646-4648 to the Tailscale subnet (100.64.0.0/10). The API is not reachable from the public internet.

### ACL Tokens

All API access requires a valid ACL token. The management token is used only for administration. The `yeet-cli` token has scoped permissions (submit jobs, read logs, manage variables). No anonymous access is permitted.

### raw_exec as Unprivileged User

The `raw_exec` driver runs tasks as the `runner` user, not root. Configure this in the Nomad client config if needed:

```hcl
plugin "raw_exec" {
  config {
    enabled = true
  }
}

client {
  options {
    "driver.raw_exec.enable" = "1"
  }
}
```

Jobs specify `user = "runner"` in the task block to enforce this.

### Firewall

UFW is configured to deny all inbound traffic except from the Tailscale subnet:

```bash
# Verify firewall rules
sudo ufw status verbose

# Expected output:
# Status: active
# Default: deny (incoming), allow (outgoing), deny (routed)
# 22/tcp    ALLOW IN    100.64.0.0/10    # SSH via Tailscale only
# 4646/tcp  ALLOW IN    100.64.0.0/10    # Nomad HTTP API via Tailscale
# 4647/tcp  ALLOW IN    100.64.0.0/10    # Nomad RPC via Tailscale
# 4648/tcp  ALLOW IN    100.64.0.0/10    # Nomad Serf via Tailscale
```

### SSH

- Key-only authentication (password auth disabled after initial setup)
- No root login
- Tailscale SSH as fallback

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

- Stored in `/opt/yeet/.env` with mode `0600`, owned by `runner:runner`
- Never committed to git
- Deployed by Ansible from environment variables on your control machine
- Rotate keys by updating the env vars and re-running Ansible

### Agent Sandboxing (OpenShell)

NVIDIA OpenShell provides kernel-level sandboxing for agent processes via the `openshell-sandbox` binary. Each agent execution is confined with three layers of isolation:

- **Landlock**: Filesystem access control -- agents can only read/write paths explicitly allowed by the policy (e.g., the project worktree, `/tmp`). Prevents reading secrets, `.env` files, SSH keys, or other project directories.
- **Seccomp**: Syscall filtering -- blocks dangerous syscalls (e.g., `ptrace`, `mount`, `reboot`) while allowing normal file I/O, network, and process operations.
- **Network namespaces**: Confines network access per policy -- agents can reach `api.anthropic.com` and `github.com` but not the local network or Nomad API.

Policies are defined in OPA/Rego format at `/opt/yeet/policies/agent.rego`, with per-project overrides in `/opt/yeet/policies/projects/`. The `sandbox` Ansible role deploys both the binary and policies. See the [architecture doc](./architecture.md) for the full sandboxing design.

### Unattended Security Upgrades

Configured by the `base` Ansible role. Security patches from Ubuntu are applied automatically. Automatic reboots are disabled -- schedule reboots during maintenance windows if kernel updates require them.

---

## 11. Adding a New Runner

**1. Install the OS.**

Flash Ubuntu Server 24.04 to USB with autoinstall config. Update `autoinstall.yaml` with the new hostname (`yeet-04`) and IP (`192.168.1.104`). Boot the machine from USB. Installation completes unattended in about 10 minutes.

**2. Add to Ansible inventory.**

Edit `ansible/inventory.ini`:

```ini
[runners]
yeet-01 ansible_host=192.168.1.101 nomad_role=server
yeet-02 ansible_host=192.168.1.102 nomad_role=client
yeet-03 ansible_host=192.168.1.103 nomad_role=client
yeet-04 ansible_host=192.168.1.104 nomad_role=client
```

**3. Run the playbook (targeted).**

```bash
ansible-playbook -i ansible/inventory.ini ansible/playbook.yml --limit yeet-04
```

This installs everything: Tailscale, Node.js, Nomad (client mode), runtimes, git config, device tools, and job templates.

**4. Node auto-joins the Nomad cluster.**

The client-mode Nomad config points at `yeet-01.tailnet:4646`. Once Tailscale is up and Nomad starts, the new node registers with the server automatically. No manual cluster join step.

**5. Set node metadata for projects and devices.**

Edit the Nomad client config (via Ansible host vars or the config template) to declare what this node can do:

```hcl
client {
  meta {
    "project_peer6"  = "true"
    "project_login2" = "true"
    "device_yubikey" = "true"
  }
}
```

Re-run the playbook or restart Nomad for metadata changes to take effect.

**6. Verify.**

```bash
# From your laptop
nomad node status          # New node appears with "ready" status
yeet runners                 # Shows the new runner in the fleet

# From the new node
nomad node status -self     # Confirms client is connected to server
systemctl status nomad      # Service is active
```

The new node immediately starts accepting job dispatches that match its metadata constraints.

---

## Quick Reference

### Fleet Commands

```bash
# Provision entire fleet
ansible-playbook -i ansible/inventory.ini ansible/playbook.yml

# Provision one box
ansible-playbook -i ansible/inventory.ini ansible/playbook.yml --limit yeet-02

# Update runtimes only
ansible-playbook -i ansible/inventory.ini ansible/playbook.yml --tags runtimes

# SSH to a runner
ssh runner@yeet-01

# Check all runners
yeet runners

# Check job status
yeet status

# Nomad cluster overview
nomad node status
nomad job status
```

### Troubleshooting

| Problem | Check |
|---------|-------|
| Runner not picking up tasks | `journalctl -u nomad -n 50` on the node |
| Node not joining cluster | `nomad agent-info` and check server address, Tailscale connectivity |
| Nomad API unreachable | `curl http://yeet-01.tailnet:4646/v1/status/leader` |
| ACL token rejected | Verify token with `nomad acl token self` |
| Tailscale offline | `tailscale status` on the box |
| USB device not found | `lsusb` and `ls /dev/yubikey*` |
| Disk full | `df -h /`, clean worktrees, `nomad system gc` |
| API key expired | Update env var, re-run Ansible runtimes role |
| Sandbox not isolating filesystem | `cat /sys/kernel/security/lsm` -- must include `landlock` |
| openshell-sandbox not found | Verify binary at `/usr/local/bin/openshell-sandbox`, re-run `sandbox` role |
| Sandbox test fails | `openshell-sandbox --policy-data /opt/yeet/policies/test.yaml -- echo "sandbox works"` |

### File Locations

| Path | Purpose |
|------|---------|
| `/opt/yeet/` | Application root |
| `/opt/yeet/jobs/` | Nomad job templates |
| `/opt/yeet/scripts/` | Agent runner scripts |
| `/opt/yeet/.env` | API keys and secrets |
| `/opt/yeet/workspaces/` | Cloned project repos and worktrees |
| `/opt/yeet/devices/` | Device wrapper scripts |
| `/opt/nomad/data/` | Nomad state data |
| `/etc/nomad.d/nomad.hcl` | Nomad configuration |
| `/etc/systemd/system/nomad.service` | Nomad systemd unit |
| `/var/lock/yeet/` | Device lock files |
| `/var/log/yeet/` | Application logs |
| `/etc/udev/rules.d/90-yeet.rules` | USB device rules |
| `/usr/local/bin/openshell-sandbox` | OpenShell sandbox binary |
| `/opt/yeet/policies/` | Sandbox policy directory |
| `/opt/yeet/policies/agent.rego` | Base OPA/Rego sandbox policy |
| `/etc/usbguard/rules.conf` | USB device whitelist |
