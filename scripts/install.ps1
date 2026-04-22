param(
  [string]$BridgeSourcePath = "",
  [string]$ConfigDir = "$env:LOCALAPPDATA\Codex\FeishuBridge",
  [switch]$Force
)

$ErrorActionPreference = "Stop"
$RepoRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$TemplatePath = Join-Path $RepoRoot "templates\bridge-config.example.json"
$ConfigPath = Join-Path $ConfigDir "bridge-config.json"

function Write-Step([string]$Message) {
  Write-Host "[install] $Message"
}

if (!(Test-Path $TemplatePath)) {
  throw "Missing template: $TemplatePath"
}

New-Item -ItemType Directory -Force -Path $ConfigDir | Out-Null
New-Item -ItemType Directory -Force -Path (Join-Path $ConfigDir "logs") | Out-Null
New-Item -ItemType Directory -Force -Path (Join-Path $ConfigDir "maintenance") | Out-Null

if ((Test-Path $ConfigPath) -and !$Force) {
  Write-Step "Config already exists: $ConfigPath"
} else {
  Copy-Item -Path $TemplatePath -Destination $ConfigPath -Force:$Force
  Write-Step "Wrote config template: $ConfigPath"
}

$node = Get-Command node -ErrorAction SilentlyContinue
if ($node) {
  Write-Step "Node found: $($node.Source)"
} else {
  Write-Step "Node was not found on PATH. Install Node.js if your bridge sidecar requires it."
}

if ($BridgeSourcePath) {
  $resolvedBridge = Resolve-Path $BridgeSourcePath -ErrorAction SilentlyContinue
  if (!$resolvedBridge) {
    throw "BridgeSourcePath does not exist: $BridgeSourcePath"
  }

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
      Write-Step "Found $item"
    } else {
      Write-Step "Missing optional/implementation-specific file: $item"
    }
  }
}

Write-Step "Install bootstrap complete."

