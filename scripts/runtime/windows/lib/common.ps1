function Ensure-Dir {
  param([string]$PathToCreate)
  if (-not (Test-Path $PathToCreate)) {
    New-Item -ItemType Directory -Path $PathToCreate -Force | Out-Null
  }
}

function Resolve-SshExe {
  param([string]$RepoRoot)
  if ($env:PCODER_SSH_CMD -and (Test-Path $env:PCODER_SSH_CMD)) {
    return $env:PCODER_SSH_CMD
  }
  $bundled = Join-Path $RepoRoot 'runtime\ssh\ssh.exe'
  if (Test-Path $bundled) {
    return $bundled
  }
  $fromPath = Get-Command ssh -ErrorAction SilentlyContinue
  if ($fromPath) {
    return $fromPath.Source
  }
  return $null
}

function Stop-CloudInitServer {
  param(
    [string]$PidFile,
    [string]$PortFile,
    [string]$DataDir
  )
  if (Test-Path $PidFile) {
    $raw = Get-Content $PidFile -ErrorAction SilentlyContinue | Select-Object -First 1
    $pidValue = "$raw".Trim()
    if ($pidValue) {
      Stop-Process -Id $pidValue -Force -ErrorAction SilentlyContinue
      Write-Host "cloud-init server stop requested for PID $pidValue."
    }
  }
  Remove-Item $PidFile -ErrorAction SilentlyContinue
  Remove-Item $PortFile -ErrorAction SilentlyContinue
  if ($DataDir -and (Test-Path $DataDir)) {
    Remove-Item $DataDir -Recurse -Force -ErrorAction SilentlyContinue
  }
}
