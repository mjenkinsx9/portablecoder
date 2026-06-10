param(
  [switch]$SkipToolChecks,
  [int]$SshReadyTimeoutSeconds = 300
)

$ErrorActionPreference = 'Stop'

$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..\..\..')).Path
. (Join-Path $PSScriptRoot 'lib\common.ps1')
$stateDir = Join-Path $repoRoot 'state\vm'
$startCmd = Join-Path $PSScriptRoot 'start-vm.cmd'
$stopCmd = Join-Path $PSScriptRoot 'stop-vm.cmd'
$bootstrapCmd = Join-Path $PSScriptRoot 'bootstrap-runtime.cmd'
$qemuExe = Join-Path $repoRoot 'runtime\qemu\qemu-system-x86_64.exe'
$vmImage = Join-Path $repoRoot 'runtime\linux\images\ubuntu.qcow2'
$sshKey = Join-Path $repoRoot 'runtime\linux\ssh\id_ed25519'
$sshPortFile = Join-Path $stateDir 'ssh-port.txt'
$modeFile = Join-Path $stateDir 'qemu-mode.txt'
$pidFile = Join-Path $stateDir 'qemu.pid'
$knownHostsFile = Join-Path $stateDir 'known_hosts'

$checks = New-Object System.Collections.Generic.List[Object]

function Add-Check {
  param(
    [string]$Name,
    [bool]$Ok,
    [string]$Detail
  )
  $checks.Add([PSCustomObject]@{
    name = $Name
    ok = $Ok
    detail = $Detail
  }) | Out-Null
}

function Invoke-Ssh {
  param(
    [string]$SshExe,
    [string]$SshPort,
    [string]$SshUser,
    [string]$Script
  )

  $args = @(
    '-p', $SshPort,
    '-i', $sshKey,
    '-o', 'BatchMode=yes',
    '-o', 'StrictHostKeyChecking=no',
    '-o', "UserKnownHostsFile=$knownHostsFile",
    '-o', 'ConnectTimeout=5',
    "$SshUser@127.0.0.1",
    $Script
  )

  $previousErrorAction = $ErrorActionPreference
  try {
    # Native ssh writes host-key notices to stderr; keep stderr non-terminating for probe loops.
    $ErrorActionPreference = 'Continue'
    $rawOutput = & $SshExe @args 2>&1
    $exitCode = $LASTEXITCODE

    $normalized = @()
    foreach ($entry in @($rawOutput)) {
      if ($null -eq $entry) {
        continue
      }
      if ($entry -is [System.Management.Automation.ErrorRecord]) {
        $normalized += $entry.ToString()
      } else {
        $normalized += [string]$entry
      }
    }

    return @{
      status = $exitCode
      output = [string]::Join("`n", $normalized)
    }
  } catch {
    return @{
      status = 1
      output = $_.Exception.Message
    }
  } finally {
    $ErrorActionPreference = $previousErrorAction
  }
}

function Get-ExistingVmProcess {
  if (-not (Test-Path $pidFile)) {
    return $null
  }
  $rawLine = Get-Content $pidFile -ErrorAction SilentlyContinue | Select-Object -First 1
  if (-not $rawLine) {
    return $null
  }
  $raw = "$rawLine".Trim()
  if (-not $raw) {
    return $null
  }
  return Get-Process -Id $raw -ErrorAction SilentlyContinue
}

Add-Check -Name 'artifact:qemu' -Ok (Test-Path $qemuExe) -Detail $qemuExe
Add-Check -Name 'artifact:image' -Ok (Test-Path $vmImage) -Detail $vmImage
Add-Check -Name 'artifact:ssh-key' -Ok (Test-Path $sshKey) -Detail $sshKey
Add-Check -Name 'script:bootstrap-runtime' -Ok (Test-Path $bootstrapCmd) -Detail $bootstrapCmd
Add-Check -Name 'script:start-vm' -Ok (Test-Path $startCmd) -Detail $startCmd
Add-Check -Name 'script:stop-vm' -Ok (Test-Path $stopCmd) -Detail $stopCmd

$fatalArtifactFailure = $false
foreach ($check in $checks) {
  if (-not $check.ok) {
    $fatalArtifactFailure = $true
    break
  }
}
if ($fatalArtifactFailure) {
  foreach ($check in $checks) {
    if ($check.ok) {
      Write-Host "[ok]   $($check.name) -> $($check.detail)"
    } else {
      Write-Host "[fail] $($check.name) -> $($check.detail)"
    }
  }
  Write-Host ''
  Write-Host 'Smoke check aborted: required artifacts are missing.'
  Write-Host 'Run: scripts\runtime\windows\bootstrap-runtime.cmd'
  exit 2
}

if (-not (Test-Path $stateDir)) {
  New-Item -ItemType Directory -Path $stateDir | Out-Null
}

$existingVm = Get-ExistingVmProcess
$hadVmAlreadyRunning = $false
if ($existingVm) {
  $hadVmAlreadyRunning = $true
  Add-Check -Name 'vm:preexisting' -Ok $true -Detail "pid=$($existingVm.Id)"
} else {
  Add-Check -Name 'vm:preexisting' -Ok $true -Detail 'none'
}

$startedHere = $false
try {
  & $startCmd
  if ($LASTEXITCODE -ne 0) {
    Add-Check -Name 'vm:start' -Ok $false -Detail "exit=$LASTEXITCODE"
    throw "start-vm.cmd failed with exit code $LASTEXITCODE"
  }
  $startedHere = -not $hadVmAlreadyRunning
  Add-Check -Name 'vm:start' -Ok $true -Detail 'ok'

  if (-not (Test-Path $pidFile)) {
    Add-Check -Name 'vm:pid-file' -Ok $false -Detail 'missing'
    throw 'Missing VM pid file.'
  }
  Add-Check -Name 'vm:pid-file' -Ok $true -Detail $pidFile

  if (-not (Test-Path $modeFile)) {
    Add-Check -Name 'vm:mode-file' -Ok $false -Detail 'missing'
    throw 'Missing VM mode file.'
  }
  $modeRaw = Get-Content $modeFile | Select-Object -First 1
  $mode = "$modeRaw".Trim()
  $modeOk = $mode -eq 'accelerated-whpx' -or $mode -eq 'portable-fallback-tcg'
  Add-Check -Name 'vm:mode' -Ok $modeOk -Detail $mode
  if (-not $modeOk) {
    throw "Unexpected VM mode value: $mode"
  }

  if (-not (Test-Path $sshPortFile)) {
    Add-Check -Name 'vm:ssh-port-file' -Ok $false -Detail 'missing'
    throw 'Missing VM SSH port file.'
  }
  $sshPortRaw = Get-Content $sshPortFile | Select-Object -First 1
  $sshPort = "$sshPortRaw".Trim()
  $portNum = 0
  [void][int]::TryParse($sshPort, [ref]$portNum)
  $portOk = $portNum -ge 1 -and $portNum -le 65535
  Add-Check -Name 'vm:ssh-port' -Ok $portOk -Detail $sshPort
  if (-not $portOk) {
    throw "Invalid SSH port value: $sshPort"
  }

  $sshExe = Resolve-SshExe -RepoRoot $repoRoot
  if (-not $sshExe) {
    Add-Check -Name 'ssh:client' -Ok $false -Detail 'not found'
    throw 'No SSH client found.'
  }
  Add-Check -Name 'ssh:client' -Ok $true -Detail $sshExe
  $sshUser = if ($env:PCODER_VM_USER) { $env:PCODER_VM_USER } else { 'portable' }
  Add-Check -Name 'ssh:user' -Ok $true -Detail $sshUser

  $sshReady = $false
  $pollIntervalSeconds = 2
  $maxAttempts = [Math]::Max([Math]::Ceiling($SshReadyTimeoutSeconds / $pollIntervalSeconds), 1)
  $lastProbeOutput = ''
  for ($attempt = 1; $attempt -le $maxAttempts; $attempt++) {
    $probe = Invoke-Ssh -SshExe $sshExe -SshPort $sshPort -SshUser $sshUser -Script 'echo vm-ready'
    if ($probe.output) {
      $lastProbeOutput = $probe.output.Trim()
    }
    if ($probe.status -eq 0 -and $probe.output -match 'vm-ready') {
      $sshReady = $true
      Add-Check -Name 'ssh:ready' -Ok $true -Detail "attempt=$attempt"
      break
    }
    Start-Sleep -Seconds $pollIntervalSeconds
  }
  if (-not $sshReady) {
    Add-Check -Name 'ssh:ready' -Ok $false -Detail "timeout (${SshReadyTimeoutSeconds}s)"
    $lastDetail = $lastProbeOutput
    if (-not $lastDetail) {
      $lastDetail = '(no ssh output)'
    }
    $lastDetail = $lastDetail -replace '\r?\n', ' '
    $hint = ''
    if ($mode -eq 'accelerated-whpx') {
      $hint = " Hint: retry with `$env:PCODER_VM_ACCEL_MODE='tcg' to force software virtualization."
    }
    throw "Timed out waiting for VM SSH readiness after ${SshReadyTimeoutSeconds}s. Last output: $lastDetail$hint"
  }

  if (-not $SkipToolChecks) {
    foreach ($tool in @('codex', 'claude')) {
      $hasTool = Invoke-Ssh -SshExe $sshExe -SshPort $sshPort -SshUser $sshUser -Script "command -v $tool >/dev/null 2>&1"
      $toolFound = $hasTool.status -eq 0
      $toolDetail = 'missing'
      if ($toolFound) {
        $toolDetail = 'found'
      }
      Add-Check -Name "guest:$tool:command" -Ok $toolFound -Detail $toolDetail

      if ($toolFound) {
        $version = Invoke-Ssh -SshExe $sshExe -SshPort $sshPort -SshUser $sshUser -Script "$tool --version"
        $versionOk = $version.status -eq 0
        $versionDetail = 'ok'
        if (-not $versionOk) {
          $versionDetail = $version.output.Trim()
          if (-not $versionDetail) {
            $versionDetail = 'version command failed'
          }
        }
        Add-Check -Name "guest:$tool:version" -Ok $versionOk -Detail $versionDetail
      }
    }
  }
}
catch {
  Add-Check -Name 'smoke:exception' -Ok $false -Detail $_.Exception.Message
}
finally {
  if ($startedHere -and (Test-Path $stopCmd)) {
    & $stopCmd | Out-Null
  }
}

$failed = 0
foreach ($check in $checks) {
  if ($check.ok) {
    Write-Host "[ok]   $($check.name) -> $($check.detail)"
  } else {
    $failed += 1
    Write-Host "[fail] $($check.name) -> $($check.detail)"
  }
}

if ($failed -gt 0) {
  Write-Host ''
  Write-Host "Smoke check completed with $failed failure(s)."
  exit 1
}

Write-Host ''
Write-Host 'Smoke check completed successfully.'
exit 0
