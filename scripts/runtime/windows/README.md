# Windows Runtime Scripts

These scripts manage the portable Linux VM backend.

Current status:
- QEMU launch policy is implemented (WHPX first, TCG fallback).
- VM metadata files are written for launcher orchestration.

Scripts:
- `bootstrap-runtime.cmd`
- `bootstrap-runtime.ps1` (download QEMU + Ubuntu image + generate SSH key)
- `start-vm.cmd`
- `start-vm.ps1` (tries WHPX acceleration first, then falls back to TCG)
- `stop-vm.cmd`
- `cloud-init-server.ps1` (NoCloud-Net metadata server for first boot)
- `smoke-check.cmd`
- `smoke-check.ps1` (artifact + VM + SSH + guest tool checks)

State files produced:
- `state/vm/qemu.pid`
- `state/vm/qemu-mode.txt`
- `state/vm/ssh-port.txt`
- `state/vm/qemu.log`
- `state/vm/qemu.err.log`
- `state/vm/cloud-init-http.pid`
- `state/vm/cloud-init-port.txt`
- `state/vm/cloud-init/*`

Smoke command:
- `scripts\runtime\windows\smoke-check.cmd`
- Optional: `scripts\runtime\windows\smoke-check.cmd -SkipToolChecks`

Bootstrap command:
- `scripts\runtime\windows\bootstrap-runtime.cmd`
- Or `scripts\pcoder runtime bootstrap`
