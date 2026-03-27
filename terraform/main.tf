terraform {
  required_providers {
    proxmox = {
      source  = "bpg/proxmox"
      version = ">= 0.66.1"
    }
  }
}

provider "proxmox" {
  endpoint = var.proxmox_host
  username = var.proxmox_username
  password = var.proxmox_password
  insecure = true
  tmp_dir  = "/var/tmp"

  ssh {
    username = "root"
    agent    = true

    node {
      name    = "pve-prd-01"
      address = "10.42.10.11"
    }
    node {
      name    = "pve-prd-02"
      address = "10.42.10.12"
    }
    node {
      name    = "pve-prd-03"
      address = "10.42.10.13"
    }
  }
}

locals {
  vms = {
    "yeet-01" = {
      vm_id       = 200
      ip          = "10.42.10.100"
      node        = "pve-prd-01"
      cores       = 4
      memory      = 4096
      disk_size   = 32
      description = "yeet master - Nomad server + NemoClaw gateway"
    }
    "yeet-02" = {
      vm_id       = 201
      ip          = "10.42.10.101"
      node        = "pve-prd-02"
      cores       = 2
      memory      = 2048
      disk_size   = 20
      description = "yeet worker 1 - coding agent runner"
    }
    "yeet-03" = {
      vm_id       = 202
      ip          = "10.42.10.102"
      node        = "pve-prd-03"
      cores       = 2
      memory      = 2048
      disk_size   = 20
      description = "yeet worker 2 - coding agent runner"
    }
  }

  # Unique nodes that need the cloud image
  nodes = toset([for vm in local.vms : vm.node])
}

# Download cloud image to each node
resource "proxmox_virtual_environment_download_file" "cloud_image" {
  for_each = local.nodes

  content_type        = "iso"
  datastore_id        = "local-zfs-fs"
  node_name           = each.value
  url                 = var.cloud_image_url
  overwrite_unmanaged = true
  overwrite           = true
}

# Create VMs
resource "proxmox_virtual_environment_vm" "yeet" {
  for_each = local.vms

  name        = each.key
  description = each.value.description
  node_name   = each.value.node
  vm_id       = each.value.vm_id
  tags        = ["yeet", "ansible-managed"]

  started = true
  on_boot = true

  agent {
    enabled = true
    trim    = true
  }

  initialization {
    datastore_id = var.vm_disk_location
    interface    = "scsi2"

    user_account {
      username = var.user
      keys     = [var.ssh_key]
    }

    ip_config {
      ipv4 {
        address = "${each.value.ip}/23"
        gateway = var.vm_gateway
      }
    }
  }

  operating_system {
    type = "l26"
  }

  cpu {
    cores        = each.value.cores
    sockets      = 1
    type         = "x86-64-v2-AES"
    architecture = "x86_64"
  }

  memory {
    dedicated = each.value.memory
  }

  scsi_hardware = "virtio-scsi-pci"

  disk {
    datastore_id = var.vm_disk_location
    file_id      = proxmox_virtual_environment_download_file.cloud_image[each.value.node].id
    interface    = "scsi0"
    file_format  = "raw"
    size         = each.value.disk_size
    ssd          = true
  }

  network_device {
    model  = "virtio"
    bridge = var.vm_bridge
  }

  boot_order = ["scsi0"]

  lifecycle {
    ignore_changes = [
      network_device,
      tags,
    ]
  }
}
