param(
  [int]$GracePeriodSeconds = 5,
  [int]$ShutdownTimeoutSeconds = 15,
  [int]$PipeWaitSeconds = 60,
  [string]$OfficialCodexExePath = "",
  [string]$RunnerLaunchScriptPath = (Join-Path $env:USERPROFILE ".codex\bridge\electron-runner\launch-bridged-codex-clone.ps1"),
  [string]$OfficialUserDataPath = (Join-Path $env:APPDATA "Codex"),
  [string]$ProbeOutputPath = (Join-Path $env:LOCALAPPDATA "Codex\FeishuBridge\logs\clone-switch-verify-latest.json"),
  [string]$CloneAppRoot = (Split-Path -Parent $PSScriptRoot),
  [string]$RunnerResourcesRoot = (Join-Path $env:USERPROFILE ".codex\bridge\electron-runner\node_modules\electron\dist\resources"),
  [string]$RunnerRoot = (Join-Path $env:USERPROFILE ".codex\bridge\electron-runner")
)

$ErrorActionPreference = "Stop"

if (-not (Test-Path -LiteralPath $RunnerLaunchScriptPath)) {
  throw "Runner launch script not found: $RunnerLaunchScriptPath"
}

$probeDir = Split-Path -Parent $ProbeOutputPath
if (-not [string]::IsNullOrWhiteSpace($probeDir)) {
  New-Item -ItemType Directory -Force -Path $probeDir | Out-Null
}

$stage = "starting"
$launchOutput = @()
$healthPayload = $null
$lastError = $null
$probeText = $null

function Write-ProbeResult {
  $result = [ordered]@{
    generatedLocal = (Get-Date).ToString("yyyy-MM-dd HH:mm:ss zzz")
    stage = $stage
    runnerLaunchScriptPath = $RunnerLaunchScriptPath
    officialUserDataPath = $OfficialUserDataPath
    probeOutputPath = $ProbeOutputPath
    launchOutput = @($launchOutput)
    bridgeHealthy = ($null -ne $healthPayload)
    healthPayload = $healthPayload
    probeText = $probeText
    lastError = $lastError
  }

  $result | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath $ProbeOutputPath -Encoding UTF8
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

function Get-BridgedCloneProcesses {
  Get-CimInstance Win32_Process -ErrorAction SilentlyContinue |
    Where-Object {
      ($_.Name -eq "electron.exe" -and (
          $_.CommandLine -like "*$CloneAppRoot*" -or
          $_.CommandLine -like "*\\bridge\\feishu-sidecar\\index.js*" -or
          $_.CommandLine -like "*$RunnerRoot*"
      )) -or
      ($_.Name -eq "codex.exe" -and $_.ExecutablePath -like "$RunnerResourcesRoot\\codex.exe") -or
      ($_.Name -eq "node.exe" -and $_.CommandLine -like "*$RunnerRoot*")
    }
}

function Stop-ProcessSet {
  param(
    [Parameter(Mandatory = $true)]
    [string]$Label,
    [Parameter(Mandatory = $true)]
    [System.Collections.IEnumerable]$Processes,
    [int]$WaitSeconds = 15
  )

  $processList = @($Processes)
  if ($processList.Count -eq 0) {
    return
  }

  foreach ($proc in $processList) {
    try {
      $liveProc = Get-Process -Id $proc.ProcessId -ErrorAction Stop
      if ($liveProc.CloseMainWindow()) {
        Write-Output "Sent CloseMainWindow to $Label PID $($proc.ProcessId)"
      }
    } catch {
      Write-Output "CloseMainWindow skipped for $Label PID $($proc.ProcessId): $($_.Exception.Message)"
    }
  }

  $deadline = (Get-Date).AddSeconds($WaitSeconds)
  while ((Get-Date) -lt $deadline) {
    $alive = @(
      $processList |
        Where-Object { Get-Process -Id $_.ProcessId -ErrorAction SilentlyContinue }
    )
    if ($alive.Count -eq 0) {
      return
    }
    Start-Sleep -Milliseconds 500
  }

  foreach ($proc in $processList) {
    try {
      Stop-Process -Id $proc.ProcessId -Force -ErrorAction Stop
      Write-Output "Force-stopped $Label PID $($proc.ProcessId)"
    } catch {
      Write-Output "Failed to force-stop $Label PID $($proc.ProcessId): $($_.Exception.Message)"
    }
  }
}

try {
  Write-Output "Switching from official Codex package to bridged writable clone..."
  if ($GracePeriodSeconds -gt 0) {
    $stage = "grace_period"
    Write-ProbeResult
    Write-Output "Grace period: $GracePeriodSeconds seconds"
    Start-Sleep -Seconds $GracePeriodSeconds
  }

  $stage = "closing_official_codex"
  Write-ProbeResult
  $targets = @(
    Get-Process -Name "Codex" -ErrorAction SilentlyContinue |
      Where-Object { $_.Path -eq $OfficialCodexExePath }
  )

  foreach ($proc in $targets) {
    try {
      if ($proc.CloseMainWindow()) {
        Write-Output "Sent CloseMainWindow to official Codex PID $($proc.Id)"
      } else {
        Write-Output "Official Codex PID $($proc.Id) had no closeable main window; will monitor process exit."
      }
    } catch {
      Write-Output "CloseMainWindow failed for PID $($proc.Id): $($_.Exception.Message)"
    }
  }

  $deadline = (Get-Date).AddSeconds($ShutdownTimeoutSeconds)
  while ((Get-Date) -lt $deadline) {
    $alive = @(
      Get-Process -Name "Codex" -ErrorAction SilentlyContinue |
        Where-Object { $_.Path -eq $OfficialCodexExePath }
    )
    if (@($alive).Count -eq 0) {
      break
    }
    Start-Sleep -Milliseconds 500
  }

  $remaining = @(
    Get-Process -Name "Codex" -ErrorAction SilentlyContinue |
      Where-Object { $_.Path -eq $OfficialCodexExePath }
  )
  foreach ($proc in $remaining) {
    try {
      Stop-Process -Id $proc.Id -Force -ErrorAction Stop
      Write-Output "Force-stopped official Codex PID $($proc.Id)"
    } catch {
      Write-Output "Failed to force-stop official Codex PID $($proc.Id): $($_.Exception.Message)"
    }
  }

  $stage = "stopping_existing_clone"
  Write-ProbeResult
  $existingCloneProcesses = @(Get-BridgedCloneProcesses)
  Stop-ProcessSet -Label "bridged clone" -Processes $existingCloneProcesses -WaitSeconds $ShutdownTimeoutSeconds

  $stage = "launching_bridged_clone"
  Write-ProbeResult
  $launchOutput = & powershell -NoProfile -ExecutionPolicy Bypass -File $RunnerLaunchScriptPath -UserDataPath $OfficialUserDataPath 2>&1

  $stage = "probing_bridge_health"
  Write-ProbeResult
  $pipeDeadline = (Get-Date).AddSeconds($PipeWaitSeconds)
  while ((Get-Date) -lt $pipeDeadline) {
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

  $stage = "completed"
  Write-ProbeResult
  Write-Output "Wrote clone switch verification to $ProbeOutputPath"
} catch {
  $lastError = $_.Exception.ToString()
  $stage = "failed"
  Write-ProbeResult
  throw
}
