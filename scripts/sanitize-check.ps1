param(
  [string]$RepoRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
)

$ErrorActionPreference = "Stop"
$findings = New-Object System.Collections.Generic.List[object]

$blockedExtensions = @(".db", ".sqlite", ".sqlite3", ".log")
$skipDirs = @(".git", "node_modules", "dist", "build", "coverage")
$textExtensions = @(".md", ".json", ".ps1", ".yaml", ".yml", ".txt", ".gitignore", "")

function Add-Finding([string]$Path, [int]$Line, [string]$Reason) {
  $findings.Add([pscustomobject]@{
    path = $Path
    line = $Line
    reason = $Reason
  }) | Out-Null
}

$files = Get-ChildItem -Path $RepoRoot -Recurse -File | Where-Object {
  $full = $_.FullName
  foreach ($skip in $skipDirs) {
    if ($full -match [regex]::Escape("\$skip\")) {
      return $false
    }
  }
  return $true
}

foreach ($file in $files) {
  $relative = Resolve-Path -Relative $file.FullName
  if ($blockedExtensions -contains $file.Extension.ToLowerInvariant()) {
    Add-Finding $relative 0 "Runtime database or log file should not be committed"
    continue
  }

  $isText = $textExtensions -contains $file.Extension.ToLowerInvariant()
  if (!$isText) {
    continue
  }

  $lines = Get-Content -Encoding UTF8 $file.FullName
  for ($i = 0; $i -lt $lines.Count; $i++) {
    $line = $lines[$i]
    $lineNo = $i + 1

    if ($line -match 'C:\\Users\\[^\\]+\\') {
      Add-Finding $relative $lineNo "User-specific absolute path"
    }
    if ($line -match '019d[0-9a-fA-F-]{20,}') {
      Add-Finding $relative $lineNo "Looks like a local Codex thread ID"
    }
    if ($line -match '\bou_[A-Za-z0-9_-]{8,}\b') {
      Add-Finding $relative $lineNo "Looks like a real Feishu open ID"
    }
    if ($line -match '\boc_[A-Za-z0-9_-]{8,}\b') {
      Add-Finding $relative $lineNo "Looks like a real Feishu chat ID"
    }
    if ($line -match '\bcli_[A-Za-z0-9]{8,}\b') {
      Add-Finding $relative $lineNo "Looks like a real Feishu app ID"
    }
    if ($line -match '"appSecret"\s*:\s*"(?!xxx|<[^>]+>|CHANGE_ME)[^"]{8,}"') {
      Add-Finding $relative $lineNo "Looks like a real app secret in JSON"
    }
    if ($line -match '(tenant_access_token|encrypt_key|verification_token)\s*[:=]\s*["''][^"'']{8,}["'']') {
      Add-Finding $relative $lineNo "Looks like a Feishu secret token"
    }
  }
}

if ($findings.Count -gt 0) {
  Write-Host "[sanitize] findings:"
  foreach ($finding in $findings) {
    Write-Host "- $($finding.path):$($finding.line) $($finding.reason)"
  }
  exit 1
}

Write-Host "[sanitize] ok"
