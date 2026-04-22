param(
  [string]$ConfigPath = "$env:LOCALAPPDATA\\Codex\\FeishuBridge\\bridge-config.json",
  [string]$AppId,
  [string]$AppSecret,
  [string[]]$AllowlistOpenIds,
  [string]$DefaultOpenId,
  [switch]$Enable,
  [switch]$Disable,
  [switch]$EnableDiagnostics,
  [switch]$DisableDiagnostics,
  [int]$DiagnosticsPort = 47631
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

function New-BridgeConfigTemplate {
  [ordered]@{
    enabled = $false
    appId = ""
    appSecret = ""
    encryptKey = ""
    verificationToken = ""
    allowlistOpenIds = @()
    defaultOpenId = ""
    sidecarNodePath = ""
    sidecarMode = "long-connection"
    longConnection = [ordered]@{
      enabled = $true
      idleReconnectMs = 5000
    }
    diagnosticsHttp = [ordered]@{
      enabled = $false
      host = "127.0.0.1"
      port = 47631
    }
    runtime = [ordered]@{
      pollIntervalMs = 1500
      staleBindingMs = 10000
      submitTimeoutMs = 5000
    }
  }
}

function ConvertTo-HashtableDeep([object]$Value) {
  if ($null -eq $Value) {
    return $null
  }
  if ($Value -is [System.Collections.IDictionary]) {
    $map = [ordered]@{}
    foreach ($key in $Value.Keys) {
      $map[$key] = ConvertTo-HashtableDeep $Value[$key]
    }
    return $map
  }
  if ($Value -is [System.Collections.IEnumerable] -and -not ($Value -is [string])) {
    $items = @()
    foreach ($entry in $Value) {
      $items += ,(ConvertTo-HashtableDeep $entry)
    }
    return $items
  }
  if ($Value -is [pscustomobject]) {
    $map = [ordered]@{}
    foreach ($property in $Value.PSObject.Properties) {
      $map[$property.Name] = ConvertTo-HashtableDeep $property.Value
    }
    return $map
  }
  return $Value
}

$configDir = Split-Path -Parent $ConfigPath
if (-not (Test-Path -LiteralPath $configDir)) {
  New-Item -ItemType Directory -Path $configDir -Force | Out-Null
}

$config =
  if (Test-Path -LiteralPath $ConfigPath) {
    ConvertTo-HashtableDeep (Get-Content -LiteralPath $ConfigPath -Raw | ConvertFrom-Json)
  } else {
    New-BridgeConfigTemplate
  }

if (-not $config.Contains('longConnection')) {
  $config.longConnection = [ordered]@{
    enabled = $true
    idleReconnectMs = 5000
  }
}
if (-not $config.Contains('diagnosticsHttp')) {
  $config.diagnosticsHttp = [ordered]@{
    enabled = $false
    host = "127.0.0.1"
    port = 47631
  }
}
if (-not $config.Contains('runtime')) {
  $config.runtime = [ordered]@{
    pollIntervalMs = 1500
    staleBindingMs = 10000
    submitTimeoutMs = 5000
  }
}

if ($PSBoundParameters.ContainsKey('AppId')) {
  $config.appId = $AppId
}
if ($PSBoundParameters.ContainsKey('AppSecret')) {
  $config.appSecret = $AppSecret
}
if ($PSBoundParameters.ContainsKey('AllowlistOpenIds')) {
  $config.allowlistOpenIds = @($AllowlistOpenIds | Where-Object { -not [string]::IsNullOrWhiteSpace($_) })
}
if ($PSBoundParameters.ContainsKey('DefaultOpenId')) {
  $config.defaultOpenId = $DefaultOpenId
} elseif (
  $PSBoundParameters.ContainsKey('AllowlistOpenIds') -and
  $config.allowlistOpenIds.Count -eq 1 -and
  [string]::IsNullOrWhiteSpace([string]$config.defaultOpenId)
) {
  $config.defaultOpenId = $config.allowlistOpenIds[0]
}

if ($Enable.IsPresent) {
  $config.enabled = $true
}
if ($Disable.IsPresent) {
  $config.enabled = $false
}

if ($EnableDiagnostics.IsPresent) {
  $config.diagnosticsHttp.enabled = $true
}
if ($DisableDiagnostics.IsPresent) {
  $config.diagnosticsHttp.enabled = $false
}
if ($PSBoundParameters.ContainsKey('DiagnosticsPort')) {
  $config.diagnosticsHttp.port = $DiagnosticsPort
}

if (-not $config.Contains('sidecarNodePath') -or [string]::IsNullOrWhiteSpace([string]$config.sidecarNodePath)) {
  $config.sidecarNodePath = ""
}

$json = $config | ConvertTo-Json -Depth 10
$utf8NoBom = [System.Text.UTF8Encoding]::new($false)
[System.IO.File]::WriteAllText($ConfigPath, $json + [Environment]::NewLine, $utf8NoBom)

[pscustomobject]@{
  ok = $true
  configPath = $ConfigPath
  enabled = [bool]$config.enabled
  appId = [string]$config.appId
  allowlistOpenIds = @($config.allowlistOpenIds)
  defaultOpenId = [string]$config.defaultOpenId
  sidecarNodePath = [string]$config.sidecarNodePath
  diagnosticsEnabled = [bool]$config.diagnosticsHttp.enabled
  diagnosticsPort = [int]$config.diagnosticsHttp.port
} | ConvertTo-Json -Depth 6
