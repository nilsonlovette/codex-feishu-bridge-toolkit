param(
  [string]$ConfigPath = "$env:LOCALAPPDATA\Codex\FeishuBridge\bridge-config.json",
  [string]$BridgeSourcePath = "",
  [string]$PipeName = "\\.\pipe\codex-feishu-bridge",
  [switch]$CheckPipe,
  [switch]$Json
)

$ErrorActionPreference = "Stop"
$checks = New-Object System.Collections.Generic.List[object]

function Add-Check([string]$Name, [string]$Status, [string]$Detail) {
  $checks.Add([pscustomobject]@{
    name = $Name
    status = $Status
    detail = $Detail
  }) | Out-Null
}

function Test-Placeholder([string]$Value, [string]$Placeholder) {
  return [string]::IsNullOrWhiteSpace($Value) -or $Value -eq $Placeholder
}

$node = Get-Command node -ErrorAction SilentlyContinue
if ($node) {
  Add-Check "node" "pass" "Node.js found"
} else {
  Add-Check "node" "warn" "Node.js not found on PATH"
}

if (Test-Path $ConfigPath) {
  try {
    $config = Get-Content -Raw -Encoding UTF8 $ConfigPath | ConvertFrom-Json
    Add-Check "config-json" "pass" "Config JSON parsed"

    if ($config.enabled) {
      Add-Check "config-enabled" "pass" "Bridge config enabled"
    } else {
      Add-Check "config-enabled" "warn" "Bridge config is disabled"
    }

    if (Test-Placeholder $config.appId "cli_xxx") {
      Add-Check "app-id" "fail" "App ID is missing or placeholder"
    } else {
      Add-Check "app-id" "pass" "App ID configured"
    }

    if (Test-Placeholder $config.appSecret "xxx") {
      Add-Check "app-secret" "fail" "App secret is missing or placeholder"
    } else {
      Add-Check "app-secret" "pass" "App secret configured, value hidden"
    }

    $allowlist = @($config.allowlistOpenIds)
    if ($allowlist.Count -eq 0 -or ($allowlist -contains "ou_xxx")) {
      Add-Check "allowlist" "fail" "Allowlist is empty or placeholder"
    } else {
      Add-Check "allowlist" "pass" "Allowlist configured, values hidden"
    }

    if (Test-Placeholder $config.defaultOpenId "ou_xxx") {
      Add-Check "default-open-id" "fail" "Default open ID is missing or placeholder"
    } else {
      Add-Check "default-open-id" "pass" "Default open ID configured, value hidden"
    }

    if ($config.sidecarMode -eq "long-connection" -and $config.longConnection.enabled) {
      Add-Check "long-connection" "pass" "Feishu sidecar long connection enabled"
    } else {
      Add-Check "long-connection" "warn" "Long connection mode is not fully enabled"
    }

    if ($config.assistantCard.streamingBackend -eq "cardkit" -and $config.assistantCard.cardkit.enabled) {
      Add-Check "assistant-card" "pass" "CardKit assistant cards enabled"
    } else {
      Add-Check "assistant-card" "warn" "CardKit assistant cards are not enabled"
    }

    if (
      $config.assistantCard.cardkit.progressElementId -eq "think_md" -and
      $config.assistantCard.cardkit.toolElementId -eq "tools_md" -and
      $config.assistantCard.cardkit.finalElementId -eq "final_md"
    ) {
      Add-Check "card-columns" "pass" "Three card columns configured"
    } else {
      Add-Check "card-columns" "warn" "Three card column IDs differ from the verified template"
    }

    if ([int]$config.runtime.pollIntervalMs -eq 2000 -and [int]$config.runtime.staleBindingMs -eq 15000) {
      Add-Check "runtime-timing" "pass" "Runtime timing matches verified template"
    } else {
      Add-Check "runtime-timing" "warn" "Runtime timing differs from verified template"
    }
  } catch {
    Add-Check "config-json" "fail" $_.Exception.Message
  }
} else {
  Add-Check "config-file" "fail" "Config not found: $ConfigPath"
}

if ($BridgeSourcePath) {
  $resolvedBridge = Resolve-Path $BridgeSourcePath -ErrorAction SilentlyContinue
  if ($resolvedBridge) {
    Add-Check "bridge-source" "pass" "Bridge source path exists"
    $required = @(
      "runtime.js",
      "bridge-store.js",
      "configure-feishu-bridge.ps1",
      "launch-codex-with-feishu-bridge.ps1",
      "feishu-sidecar\index.js"
    )
    foreach ($item in $required) {
      $candidate = Join-Path $resolvedBridge.Path $item
      if (Test-Path $candidate) {
        Add-Check "bridge-file:$item" "pass" "Found"
      } else {
        Add-Check "bridge-file:$item" "warn" "Missing or implementation-specific"
      }
    }
  } else {
    Add-Check "bridge-source" "fail" "Bridge source path does not exist"
  }
} else {
  Add-Check "bridge-source" "warn" "Bridge source path not provided"
}

if ($CheckPipe) {
  try {
    $healthOutput = & (Join-Path $PSScriptRoot "health.ps1") -PipeName $PipeName -Json
    $health = $healthOutput | ConvertFrom-Json
    if ($health.ok) {
      Add-Check "pipe-health" "pass" "Bridge pipe responded in $($health.elapsedMs) ms"
    } else {
      Add-Check "pipe-health" "fail" "Bridge pipe failed: $($health.error)"
    }
  } catch {
    Add-Check "pipe-health" "fail" $_.Exception.Message
  }
} else {
  Add-Check "pipe-health" "warn" "Skipped; pass -CheckPipe to probe local bridge pipe"
}

$statusRank = @{ pass = 0; warn = 1; fail = 2 }
$worst = ($checks | ForEach-Object { $statusRank[$_.status] } | Measure-Object -Maximum).Maximum
$summary = [pscustomobject]@{
  ok = ($worst -lt 2)
  generatedAt = (Get-Date).ToString("o")
  checks = $checks
}

if ($Json) {
  $summary | ConvertTo-Json -Depth 32
} else {
  foreach ($check in $checks) {
    Write-Host "[$($check.status)] $($check.name) - $($check.detail)"
  }
  if ($summary.ok) {
    Write-Host "[doctor] completed without failing checks"
  } else {
    Write-Host "[doctor] failing checks found"
  }
}

if (!$summary.ok) {
  exit 1
}
