param(
  [switch]$Force,
  [int]$GracefulTimeoutSeconds = 15
)

$ErrorActionPreference = 'Stop'

$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..\..\..')).Path
. (Join-Path $PSScriptRoot 'lib\common.ps1')

$stateDir = Join-Path $repoRoot 'state\vm'
$vmPid = Join-Path $stateDir 'qemu.pid'
$vmMode = Join-Path $stateDir 'qemu-mode.txt'
$sshPortFile = Join-Path $stateDir 'ssh-port.txt'
$sshKey = Join-Path $repoRoot 'runtime\linux\ssh\id_ed25519'
$cloudInitPidFile = Join-Path $stateDir 'cloud-init-http.pid'
$cloudInitPortFile = Join-Path $stateDir 'cloud-init-port.txt'
$cloudInitDir = Join-Path $stateDir 'cloud-init'
$knownHostsFile = Join-Path $stateDir 'known_hosts'

function Try-GracefulShutdown {
  param([int]$QemuPid)

  $sshExe = Resolve-SshExe -RepoRoot $repoRoot
  if (-not $sshExe) { return $false }
  if (-not (Test-Path $sshPortFile)) { return $false }
  if (-not (Test-Path $sshKey)) { return $false }

  $sshPort = (Get-Content $sshPortFile | Select-Object -First 1).Trim()
  $sshUser = if ($env:PCODER_VM_USER) { $env:PCODER_VM_USER } else { 'portable' }

  $sshArgs = @(
    '-p', $sshPort,
    '-i', $sshKey,
    '-o', 'BatchMode=yes',
    '-o', 'StrictHostKeyChecking=no',
    '-o', "UserKnownHostsFile=$knownHostsFile",
    '-o', 'ConnectTimeout=3',
    "$sshUser@127.0.0.1",
    'sudo', 'poweroff'
  )

  try {
    $proc = Start-Process -FilePath $sshExe -ArgumentList $sshArgs -PassThru -WindowStyle Hidden -Wait
  } catch {
    return $false
  }

  $deadline = (Get-Date).AddSeconds($GracefulTimeoutSeconds)
  while ((Get-Date) -lt $deadline) {
    $qemuProc = Get-Process -Id $QemuPid -ErrorAction SilentlyContinue
    if (-not $qemuProc) {
      Write-Host "VM shut down gracefully (pid: $QemuPid)."
      return $true
    }
    Start-Sleep -Milliseconds 500
  }

  return $false
}

Stop-CloudInitServer -PidFile $cloudInitPidFile -PortFile $cloudInitPortFile -DataDir $cloudInitDir

if (-not (Test-Path $vmPid)) {
  Write-Host 'No pid file found. If VM is running, stop it manually from Task Manager.'
  Remove-Item $vmMode -ErrorAction SilentlyContinue
  Remove-Item $sshPortFile -ErrorAction SilentlyContinue
  exit 0
}

$pidRaw = (Get-Content $vmPid | Select-Object -First 1).Trim()
$qemuProcess = Get-Process -Id $pidRaw -ErrorAction SilentlyContinue
if (-not $qemuProcess) {
  Write-Host "VM process $pidRaw not found (already exited)."
  Remove-Item $vmPid -ErrorAction SilentlyContinue
  Remove-Item $vmMode -ErrorAction SilentlyContinue
  Remove-Item $sshPortFile -ErrorAction SilentlyContinue
  exit 0
}

$graceful = $false
if (-not $Force) {
  $graceful = Try-GracefulShutdown -QemuPid $pidRaw
}

if (-not $graceful) {
  Stop-Process -Id $pidRaw -Force -ErrorAction SilentlyContinue
  Write-Host "VM force-stopped (pid: $pidRaw)."
}

Remove-Item $vmPid -ErrorAction SilentlyContinue
Remove-Item $vmMode -ErrorAction SilentlyContinue
Remove-Item $sshPortFile -ErrorAction SilentlyContinue
exit 0
