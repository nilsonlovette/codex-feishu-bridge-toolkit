param(
  [int]$GracePeriodSeconds = 5,
  [int]$ShutdownTimeoutSeconds = 15,
  [int]$PipeWaitSeconds = 45,
  [string]$RestartScriptPath = (Join-Path $PSScriptRoot "restart-codex-with-feishu-bridge.ps1"),
  [string]$ProbeOutputPath = (Join-Path $env:LOCALAPPDATA "Codex\FeishuBridge\logs\restart-verify-latest.json")
)

$ErrorActionPreference = "Stop"

if (-not (Test-Path -LiteralPath $RestartScriptPath)) {
  throw "Restart script not found: $RestartScriptPath"
}

$probeDir = Split-Path -Parent $ProbeOutputPath
if (-not [string]::IsNullOrWhiteSpace($probeDir)) {
  New-Item -ItemType Directory -Force -Path $probeDir | Out-Null
}

function Invoke-BridgeHealthProbe {
  $code = @'
const net = require("node:net");
const req = { jsonrpc: "2.0", id: "health", method: "bridge.health", params: {} };
const client = net.connect("\\\\.\\pipe\\codex-feishu-bridge");
let buffer = "";
client.on("connect", () => client.write(JSON.stringify(req) + "\n"));
client.on("data", (chunk) => {
  buffer += chunk.toString("utf8");
  const idx = buffer.indexOf("\n");
  if (idx >= 0) {
    console.log(buffer.slice(0, idx));
    client.end();
  }
});
client.on("error", (error) => {
  console.error(String((error && error.stack) || error));
  process.exitCode = 1;
});
'@

  $tempFile = Join-Path $env:TEMP "codex-feishu-bridge-health.js"
  Set-Content -LiteralPath $tempFile -Value $code -Encoding UTF8
  try {
    return & node $tempFile 2>&1
  } finally {
    Remove-Item -LiteralPath $tempFile -Force -ErrorAction SilentlyContinue
  }
}

$hookProbePath = Join-Path $env:LOCALAPPDATA "Codex\FeishuBridge\logs\codex-hook-probe.txt"
$env:CODEX_FEISHU_BRIDGE_HOOK_PROBE_FILE = $hookProbePath

$restartOutput = & powershell -NoProfile -ExecutionPolicy Bypass -File $RestartScriptPath -GracePeriodSeconds $GracePeriodSeconds -ShutdownTimeoutSeconds $ShutdownTimeoutSeconds 2>&1

$deadline = (Get-Date).AddSeconds($PipeWaitSeconds)
$lastError = $null
$healthPayload = $null

while ((Get-Date) -lt $deadline) {
  try {
    $probeOutput = Invoke-BridgeHealthProbe
    $probeText = ($probeOutput | Out-String).Trim()
    if (-not [string]::IsNullOrWhiteSpace($probeText)) {
      $healthPayload = $probeText | ConvertFrom-Json
      break
    }
  } catch {
    $lastError = $_.Exception.Message
  }
  Start-Sleep -Seconds 2
}

$result = [ordered]@{
  generatedLocal = (Get-Date).ToString("yyyy-MM-dd HH:mm:ss zzz")
  restartScriptPath = $RestartScriptPath
  hookProbePath = $hookProbePath
  probeOutputPath = $ProbeOutputPath
  restartOutput = @($restartOutput)
  bridgeHealthy = ($null -ne $healthPayload)
  healthPayload = $healthPayload
  lastError = $lastError
}

$result | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath $ProbeOutputPath -Encoding UTF8
Write-Output "Wrote restart verification to $ProbeOutputPath"
