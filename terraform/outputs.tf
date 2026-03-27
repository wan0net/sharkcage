output "vms" {
  value = {
    for name, vm in proxmox_virtual_environment_vm.yeet : name => {
      id   = vm.vm_id
      ip   = local.vms[name].ip
      node = local.vms[name].node
    }
  }
}
