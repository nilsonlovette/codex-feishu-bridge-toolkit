param(
  [string]$CodexExePath = "",
  [string]$RunnerLaunchScriptPath = (Join-Path $env:USERPROFILE ".codex\bridge\electron-runner\launch-bridged-codex-clone.ps1"),
  [string]$UserDataPath = (Join-Path $env:APPDATA "Codex")
)

$ErrorActionPreference = "Stop"

if (-not (Test-Path -LiteralPath $RunnerLaunchScriptPath)) {
  throw "Runner launch script not found: $RunnerLaunchScriptPath"
}

$logDir = Join-Path $env:LOCALAPPDATA "Codex\FeishuBridge\logs"
New-Item -ItemType Directory -Force -Path $logDir | Out-Null
$stdoutPath = Join-Path $logDir "codex-launcher-stdout.log"
$stderrPath = Join-Path $logDir "codex-launcher-stderr.log"

$launchText = @(
  "$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss zzz') launch_mode=bridged_clone",
  "runnerLaunchScript=$RunnerLaunchScriptPath",
  "requestedCodexExePath=$CodexExePath",
  "userDataPath=$UserDataPath"
)
$launchText | Set-Content -LiteralPath $stdoutPath -Encoding UTF8
"" | Set-Content -LiteralPath $stderrPath -Encoding UTF8

& powershell.exe -NoProfile -ExecutionPolicy Bypass -File $RunnerLaunchScriptPath -UserDataPath $UserDataPath 1>>$stdoutPath 2>>$stderrPath
