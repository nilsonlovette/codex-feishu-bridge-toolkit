param(
  [Parameter(Mandatory = $true)]
  [string]$AppId,

  [Parameter(Mandatory = $true)]
  [string]$AppSecret,

  [Parameter(Mandatory = $true)]
  [string[]]$AllowlistOpenIds,

  [Parameter(Mandatory = $true)]
  [string]$DefaultOpenId,

  [string]$ConfigPath = "$env:LOCALAPPDATA\Codex\FeishuBridge\bridge-config.json",
  [string]$DiagnosticsHost = "127.0.0.1",
  [int]$DiagnosticsPort = 47631,
  [switch]$Enable
)

$ErrorActionPreference = "Stop"
$RepoRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$TemplatePath = Join-Path $RepoRoot "templates\bridge-config.example.json"

if (!(Test-Path $TemplatePath)) {
  throw "Missing template: $TemplatePath"
}

if ($Enable) {
  if ($AppId -eq "cli_xxx" -or $AppId.Length -lt 8) {
    throw "Refusing to enable with placeholder or invalid AppId."
  }
  if ($AppSecret -eq "xxx" -or $AppSecret.Length -lt 8) {
    throw "Refusing to enable with placeholder or invalid AppSecret."
  }
  if ($DefaultOpenId -eq "ou_xxx" -or $DefaultOpenId.Length -lt 8) {
    throw "Refusing to enable with placeholder or invalid DefaultOpenId."
  }
}

$config = Get-Content -Raw -Encoding UTF8 $TemplatePath | ConvertFrom-Json
$config.enabled = [bool]$Enable
$config.appId = $AppId
$config.appSecret = $AppSecret
$config.allowlistOpenIds = @($AllowlistOpenIds)
$config.defaultOpenId = $DefaultOpenId
$config.diagnosticsHttp.host = $DiagnosticsHost
$config.diagnosticsHttp.port = $DiagnosticsPort

$dir = Split-Path -Parent $ConfigPath
New-Item -ItemType Directory -Force -Path $dir | Out-Null

$json = $config | ConvertTo-Json -Depth 32
$utf8NoBom = [System.Text.UTF8Encoding]::new($false)
[System.IO.File]::WriteAllText($ConfigPath, $json + [Environment]::NewLine, $utf8NoBom)

Write-Host "[configure] Wrote config: $ConfigPath"
Write-Host "[configure] Enabled: $([bool]$Enable)"
Write-Host "[configure] Secret values were not printed."

