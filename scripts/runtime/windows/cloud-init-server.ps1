param(
  [Parameter(Mandatory = $true)]
  [int]$Port,
  [Parameter(Mandatory = $true)]
  [string]$Directory
)

$ErrorActionPreference = 'Stop'

if (-not (Test-Path $Directory)) {
  throw "Missing cloud-init directory: $Directory"
}

function Write-HttpResponse {
  param(
    [System.Net.Sockets.NetworkStream]$Stream,
    [int]$StatusCode,
    [string]$Body
  )

  $statusText = 'OK'
  if ($StatusCode -eq 404) {
    $statusText = 'Not Found'
  } elseif ($StatusCode -ne 200) {
    $statusText = 'Error'
  }

  $bodyBytes = [System.Text.Encoding]::UTF8.GetBytes($Body)
  $headers = "HTTP/1.1 $StatusCode $statusText`r`nContent-Type: text/plain; charset=utf-8`r`nContent-Length: $($bodyBytes.Length)`r`nConnection: close`r`n`r`n"
  $headerBytes = [System.Text.Encoding]::ASCII.GetBytes($headers)
  $Stream.Write($headerBytes, 0, $headerBytes.Length)
  $Stream.Write($bodyBytes, 0, $bodyBytes.Length)
}

$listener = [System.Net.Sockets.TcpListener]::new([System.Net.IPAddress]::Loopback, $Port)
$listener.Start()

Write-Host "cloud-init server listening on 127.0.0.1:$Port"

try {
  while ($true) {
    $client = $listener.AcceptTcpClient()
    try {
      $stream = $client.GetStream()
      $reader = New-Object System.IO.StreamReader($stream, [System.Text.Encoding]::ASCII, $false, 1024, $true)
      $requestLine = $reader.ReadLine()

      if (-not $requestLine) {
        Write-HttpResponse -Stream $stream -StatusCode 404 -Body 'empty request'
        continue
      }

      $parts = $requestLine -split '\s+'
      $path = '/'
      if ($parts.Length -ge 2) {
        $path = $parts[1]
      }

      while ($true) {
        $headerLine = $reader.ReadLine()
        if ($headerLine -eq $null -or $headerLine -eq '') {
          break
        }
      }

      $cleanPath = $path.TrimStart('/')
      if (-not $cleanPath) {
        $cleanPath = 'meta-data'
      }
      $safeName = [System.IO.Path]::GetFileName($cleanPath)
      $filePath = Join-Path $Directory $safeName

      if (Test-Path $filePath) {
        $content = Get-Content $filePath -Raw -Encoding UTF8
        Write-HttpResponse -Stream $stream -StatusCode 200 -Body $content
      } else {
        Write-HttpResponse -Stream $stream -StatusCode 404 -Body "not found: $safeName"
      }
    } finally {
      try { $client.Close() } catch {}
    }
  }
} finally {
  try { $listener.Stop() } catch {}
}
