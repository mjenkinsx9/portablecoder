param(
  [switch]$Force
)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..\..\..')).Path
. (Join-Path $PSScriptRoot 'lib\common.ps1')
$manifestPath = Join-Path $repoRoot 'runtime\linux\vm-manifest.json'
$runtimeDir = Join-Path $repoRoot 'runtime'
$qemuDir = Join-Path $runtimeDir 'qemu'
$linuxDir = Join-Path $runtimeDir 'linux'
$imagesDir = Join-Path $linuxDir 'images'
$sshDir = Join-Path $linuxDir 'ssh'
$stateTmpDir = Join-Path $repoRoot 'state\tmp'
$vmImage = Join-Path $imagesDir 'ubuntu.qcow2'
$sshPrivate = Join-Path $sshDir 'id_ed25519'
$sshPublic = Join-Path $sshDir 'id_ed25519.pub'

function Resolve-Tool {
  param([string]$Name)
  $cmd = Get-Command $Name -ErrorAction SilentlyContinue
  if ($cmd) {
    return $cmd.Source
  }
  return $null
}

function Download-File {
  param(
    [string]$Url,
    [string]$Destination
  )
  Write-Host "Downloading: $Url"
  Invoke-WebRequest -Uri $Url -OutFile $Destination -UseBasicParsing
}

function Read-FirstHashToken {
  param([string]$Text)
  $lines = $Text -split "`r?`n"
  foreach ($line in $lines) {
    $trimmed = $line.Trim()
    if ($trimmed) {
      $parts = $trimmed -split '\s+'
      if ($parts.Length -gt 0) {
        return $parts[0].ToLowerInvariant()
      }
    }
  }
  return $null
}

function Install-QemuFromInstaller {
  param(
    [string]$InstallerPath,
    [string]$InstallDir
  )

  Ensure-Dir $InstallDir
  $qemuExePath = Join-Path $InstallDir 'qemu-system-x86_64.exe'
  if (Test-Path $qemuExePath) {
    Remove-Item $qemuExePath -Force -ErrorAction SilentlyContinue
  }

  # Try NSIS-style silent install first.
  $nsisArg = "/S /D=$InstallDir"
  $proc = Start-Process -FilePath $InstallerPath -ArgumentList $nsisArg -PassThru -Wait
  Start-Sleep -Seconds 2
  if (Test-Path $qemuExePath) {
    return
  }

  # Try Inno Setup style as fallback.
  $innoArgs = @('/VERYSILENT', '/SUPPRESSMSGBOXES', '/NORESTART', '/SP-', "/DIR=$InstallDir")
  $proc2 = Start-Process -FilePath $InstallerPath -ArgumentList $innoArgs -PassThru -Wait
  Start-Sleep -Seconds 2
  if (Test-Path $qemuExePath) {
    return
  }

  throw "QEMU installer did not produce expected binary: $qemuExePath"
}

if (-not (Test-Path $manifestPath)) {
  throw "Missing manifest: $manifestPath"
}

$manifest = Get-Content $manifestPath -Raw | ConvertFrom-Json
$bootstrap = $manifest.bootstrap.windows
if (-not $bootstrap) {
  throw "Manifest is missing bootstrap.windows settings: $manifestPath"
}

$qemuInstallerUrl = if ($env:PCODER_QEMU_INSTALLER_URL) { $env:PCODER_QEMU_INSTALLER_URL } else { $bootstrap.qemu_installer_url }
$qemuShaUrl = if ($env:PCODER_QEMU_SHA512_URL) { $env:PCODER_QEMU_SHA512_URL } else { $bootstrap.qemu_installer_sha512_url }
$ubuntuImageUrl = if ($env:PCODER_UBUNTU_IMAGE_URL) { $env:PCODER_UBUNTU_IMAGE_URL } else { $bootstrap.ubuntu_image_url }
$ubuntuShaSumsUrl = if ($env:PCODER_UBUNTU_SHA256SUMS_URL) { $env:PCODER_UBUNTU_SHA256SUMS_URL } else { $bootstrap.ubuntu_image_sha256sums_url }

if (-not $qemuInstallerUrl) {
  throw 'QEMU installer URL is not set. Provide PCODER_QEMU_INSTALLER_URL or runtime/linux/vm-manifest.json bootstrap.windows.qemu_installer_url.'
}
if (-not $ubuntuImageUrl) {
  throw 'Ubuntu image URL is not set. Provide PCODER_UBUNTU_IMAGE_URL or runtime/linux/vm-manifest.json bootstrap.windows.ubuntu_image_url.'
}

Ensure-Dir $runtimeDir
Ensure-Dir $qemuDir
Ensure-Dir $linuxDir
Ensure-Dir $imagesDir
Ensure-Dir $sshDir
Ensure-Dir $stateTmpDir

$qemuExe = Join-Path $qemuDir 'qemu-system-x86_64.exe'
$qemuInstallerFileName = [System.IO.Path]::GetFileName($qemuInstallerUrl)
if (-not $qemuInstallerFileName) {
  $qemuInstallerFileName = 'qemu-w64-setup.exe'
}
$qemuInstallerPath = Join-Path $stateTmpDir $qemuInstallerFileName

if ($Force -or -not (Test-Path $qemuExe)) {
  Download-File -Url $qemuInstallerUrl -Destination $qemuInstallerPath

  if ($qemuShaUrl) {
    try {
      $shaTempPath = Join-Path $stateTmpDir 'qemu-installer.sha512'
      Download-File -Url $qemuShaUrl -Destination $shaTempPath
      $expectedHash = Read-FirstHashToken -Text (Get-Content $shaTempPath -Raw)
      if ($expectedHash) {
        $actualHash = (Get-FileHash -Path $qemuInstallerPath -Algorithm SHA512).Hash.ToLowerInvariant()
        if ($actualHash -ne $expectedHash) {
          throw "QEMU installer hash mismatch. expected=$expectedHash actual=$actualHash"
        }
      }
    } catch {
      throw "Failed to validate QEMU installer checksum: $($_.Exception.Message)"
    }
  }

  Install-QemuFromInstaller -InstallerPath $qemuInstallerPath -InstallDir $qemuDir
}

if (-not (Test-Path $qemuExe)) {
  throw "QEMU bootstrap failed, missing binary: $qemuExe"
}

if ($Force -or -not (Test-Path $vmImage)) {
  Download-File -Url $ubuntuImageUrl -Destination $vmImage

  if ($ubuntuShaSumsUrl) {
    try {
      $imageFileName = [System.IO.Path]::GetFileName($ubuntuImageUrl)
      $sumsPath = Join-Path $stateTmpDir 'ubuntu-SHA256SUMS'
      Download-File -Url $ubuntuShaSumsUrl -Destination $sumsPath
      $sumLine = (Get-Content $sumsPath) | Where-Object { $_ -match ('\*?' + [regex]::Escape($imageFileName) + '$') } | Select-Object -First 1
      if (-not $sumLine) {
        throw "No checksum entry for $imageFileName in $ubuntuShaSumsUrl"
      }
      $expectedHash = ($sumLine -split '\s+')[0].ToLowerInvariant()
      $actualHash = (Get-FileHash -Path $vmImage -Algorithm SHA256).Hash.ToLowerInvariant()
      if ($actualHash -ne $expectedHash) {
        throw "Ubuntu image hash mismatch. expected=$expectedHash actual=$actualHash"
      }
      Write-Host 'Ubuntu image checksum verified (SHA-256).'
    } catch {
      # Never leave an unverified image where the next run would trust it.
      Remove-Item $vmImage -Force -ErrorAction SilentlyContinue
      throw
    }
  } else {
    Write-Host 'Warning: no SHA256SUMS URL configured; skipping image verification.'
  }
}

if (-not (Test-Path $vmImage)) {
  throw "VM image bootstrap failed, missing image: $vmImage"
}

$qemuImgExe = Join-Path $qemuDir 'qemu-img.exe'
if (Test-Path $qemuImgExe) {
  $targetSizeGb = 20
  Write-Host "Resizing VM image to ${targetSizeGb}G..."
  $resizeProc = Start-Process -FilePath $qemuImgExe -ArgumentList "resize `"$vmImage`" ${targetSizeGb}G" -PassThru -Wait -NoNewWindow
  if ($resizeProc.ExitCode -ne 0) {
    Write-Host "Warning: qemu-img resize failed (exit $($resizeProc.ExitCode)). VM disk may be small."
  }
}

if ($Force) {
  Remove-Item $sshPrivate -Force -ErrorAction SilentlyContinue
  Remove-Item $sshPublic -Force -ErrorAction SilentlyContinue
}

if (-not (Test-Path $sshPrivate) -or -not (Test-Path $sshPublic)) {
  $sshKeygen = Resolve-Tool 'ssh-keygen'
  if (-not $sshKeygen) {
    throw "Missing ssh-keygen in PATH. Install OpenSSH client feature or set up runtime/linux/ssh/id_ed25519 manually."
  }

  # Start-Process rejects empty ArgumentList elements, so pass -N "" in one string.
  $genArgs = "-t ed25519 -N `"`" -f `"$sshPrivate`" -C portable-coder"
  $keyProc = Start-Process -FilePath $sshKeygen -ArgumentList $genArgs -PassThru -Wait -NoNewWindow
  if ($keyProc.ExitCode -ne 0) {
    throw "ssh-keygen failed with exit code $($keyProc.ExitCode)"
  }
}

Write-Host 'Runtime bootstrap completed.'
Write-Host "  qemu:  $qemuExe"
Write-Host "  image: $vmImage"
Write-Host "  ssh:   $sshPrivate"
Write-Host ''
Write-Host 'Next step: scripts\runtime\windows\smoke-check.cmd'
