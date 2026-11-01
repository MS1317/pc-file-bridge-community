$ErrorActionPreference = 'Stop'

$pm2Path = '$(Join-Path $env:APPDATA 'npm\pm2.cmd')'

& $pm2Path resurrect | Out-Null
if ($LASTEXITCODE -ne 0) {
  exit $LASTEXITCODE
}

$mcpReady = $false
$deadline = [DateTime]::UtcNow.AddSeconds(60)
while ([DateTime]::UtcNow -lt $deadline) {
  try {
    $health = Invoke-RestMethod -UseBasicParsing -Uri 'http://127.0.0.1:4779/health' -TimeoutSec 2
    if ($health.ok -eq $true -and $health.data.bridgeApiHealthy -eq $true) {
      $mcpReady = $true
      break
    }
  } catch {
  }
  Start-Sleep -Seconds 1
}

if (-not $mcpReady) {
  exit 1
}

& $pm2Path restart tunnel | Out-Null
exit $LASTEXITCODE
