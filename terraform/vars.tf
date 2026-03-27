variable "proxmox_host" {
  type        = string
  description = "Proxmox API endpoint URL"
  default     = "https://10.42.10.11:8006"
}

variable "proxmox_username" {
  type        = string
  description = "Proxmox API username"
  default     = "root@pam"
}

variable "proxmox_password" {
  type        = string
  description = "Proxmox API password"
  sensitive   = true
}

variable "vm_gateway" {
  type        = string
  description = "Default gateway"
  default     = "10.42.10.1"
}

variable "vm_bridge" {
  type        = string
  description = "Proxmox network bridge"
  default     = "vmbr1"
}

variable "vm_disk_location" {
  type        = string
  description = "Datastore for VM disks"
  default     = "local-zfs"
}

variable "cloud_image_url" {
  type        = string
  description = "Ubuntu cloud image URL"
  default     = "https://cloud-images.ubuntu.com/noble/current/noble-server-cloudimg-amd64.img"
}

variable "user" {
  type        = string
  description = "Cloud-init user"
  default     = "semaphore"
}

variable "ssh_key" {
  type        = string
  description = "SSH public key for cloud-init"
  default     = "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIAlvcyPPAcF6/Xu+j20MxfkCs9n8wTUU8W/svn5ZEkLk"
}
