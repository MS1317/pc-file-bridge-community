# Start the bridge in the background and wait until it is healthy (Windows).
# Run it at sign-in to keep the bridge available after a restart.
# See "Start at sign-in" in the README.
$ErrorActionPreference = 'Stop'

$repoRoot = Split-Path -Parent $PSScriptRoot
$healthUrl = 'http://127.0.0.1:4779/health'

function Test-Bridge {
  try {
    $health = Invoke-RestMethod -UseBasicParsing -Uri $healthUrl -TimeoutSec 2
    return ($health.ok -eq $true -and $health.data.bridgeApiHealthy -eq $true)
  } catch {
    return $false
  }
}

if (Test-Bridge) {
  Write-Output 'PC File Bridge is already running.'
  exit 0
}

$logDir = Join-Path $repoRoot 'data'
New-Item -ItemType Directory -Force -Path $logDir | Out-Null
Start-Process -FilePath 'cmd.exe' -WindowStyle Hidden -WorkingDirectory $repoRoot `
  -ArgumentList '/d', '/c', 'pnpm bridge:start > data\bridge.log 2>&1'

$deadline = [DateTime]::UtcNow.AddSeconds(120)
while ([DateTime]::UtcNow -lt $deadline) {
  if (Test-Bridge) {
    Write-Output 'PC File Bridge is running.'
    exit 0
  }
  Start-Sleep -Seconds 1
}

Write-Output 'PC File Bridge did not become healthy. See data\bridge.log.'
exit 1
