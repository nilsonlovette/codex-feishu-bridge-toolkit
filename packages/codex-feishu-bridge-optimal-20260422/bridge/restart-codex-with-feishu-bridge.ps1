param(
  [int]$GracePeriodSeconds = 5,
  [int]$ShutdownTimeoutSeconds = 15,
  [string]$CodexExePath = "",
  [string]$SwitchScriptPath = (Join-Path $PSScriptRoot "switch-and-verify-bridged-clone.ps1"),
  [string]$OfficialUserDataPath = (Join-Path $env:APPDATA "Codex"),
  [string]$SwitchProbeOutputPath = (Join-Path $env:LOCALAPPDATA "Codex\FeishuBridge\logs\clone-switch-verify-latest.json"),
  [string]$WrapperProbeOutputPath = (Join-Path $env:LOCALAPPDATA "Codex\FeishuBridge\logs\controlled-restart-launch-latest.json")
)

$ErrorActionPreference = "Stop"

function Write-WrapperProbe {
  param(
    [Parameter(Mandatory = $true)]
    [string]$Stage,
    [string]$LastError = $null,
    [System.Collections.IEnumerable]$DelegateOutput = @()
  )

  $probeDir = Split-Path -Parent $WrapperProbeOutputPath
  if (-not [string]::IsNullOrWhiteSpace($probeDir)) {
    New-Item -ItemType Directory -Force -Path $probeDir | Out-Null
  }

  $payload = [ordered]@{
    generatedLocal = (Get-Date).ToString("yyyy-MM-dd HH:mm:ss zzz")
    wrapperStage = $Stage
    gracePeriodSeconds = $GracePeriodSeconds
    shutdownTimeoutSeconds = $ShutdownTimeoutSeconds
    codexExePath = $CodexExePath
    switchScriptPath = $SwitchScriptPath
    switchProbeOutputPath = $SwitchProbeOutputPath
    officialUserDataPath = $OfficialUserDataPath
    delegateOutput = @($DelegateOutput)
    lastError = $LastError
  }

  $payload | ConvertTo-Json -Depth 6 | Set-Content -LiteralPath $WrapperProbeOutputPath -Encoding UTF8
}

if (-not (Test-Path -LiteralPath $SwitchScriptPath)) {
  throw "Switch script not found: $SwitchScriptPath"
}

if ($GracePeriodSeconds -lt 0) {
  throw "GracePeriodSeconds must be >= 0"
}

if ($ShutdownTimeoutSeconds -lt 1) {
  throw "ShutdownTimeoutSeconds must be >= 1"
}

Write-WrapperProbe -Stage "wrapper_started"

try {
  Write-Output "Preparing Codex restart with Feishu bridge hook..."
  Write-Output "Delegating restart to bridged clone switch path..."
  $delegateOutput = & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $SwitchScriptPath `
    -GracePeriodSeconds $GracePeriodSeconds `
    -ShutdownTimeoutSeconds $ShutdownTimeoutSeconds `
    -OfficialCodexExePath $CodexExePath `
    -OfficialUserDataPath $OfficialUserDataPath `
    -ProbeOutputPath $SwitchProbeOutputPath 2>&1

  Write-WrapperProbe -Stage "delegated_to_switch_script" -DelegateOutput $delegateOutput
} catch {
  Write-WrapperProbe -Stage "wrapper_failed" -LastError $_.Exception.ToString()
  throw
}
