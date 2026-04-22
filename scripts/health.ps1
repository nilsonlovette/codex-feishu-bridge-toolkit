param(
  [string]$PipeName = "\\.\pipe\codex-feishu-bridge",
  [int]$TimeoutMs = 2500,
  [switch]$Json
)

$ErrorActionPreference = "Stop"
$node = Get-Command node -ErrorAction SilentlyContinue
if (!$node) {
  throw "Node.js is required for the named-pipe health probe."
}

$env:CODEX_FEISHU_BRIDGE_PIPE = $PipeName
$env:CODEX_FEISHU_BRIDGE_TIMEOUT_MS = [string]$TimeoutMs

$script = @'
const net = require("net");
const pipeName = process.env.CODEX_FEISHU_BRIDGE_PIPE || "\\\\.\\pipe\\codex-feishu-bridge";
const timeoutMs = Number(process.env.CODEX_FEISHU_BRIDGE_TIMEOUT_MS || 2500);

function finish(result, code) {
  process.stdout.write(JSON.stringify(result, null, 2) + "\n");
  process.exit(code);
}

const startedAt = Date.now();
const socket = net.createConnection(pipeName);
let buffer = "";
let finished = false;

const timer = setTimeout(() => {
  if (finished) return;
  finished = true;
  socket.destroy();
  finish({ ok: false, error: "timeout", elapsedMs: Date.now() - startedAt }, 1);
}, timeoutMs);

socket.on("connect", () => {
  socket.write(JSON.stringify({ type: "health" }) + "\n");
});

socket.on("data", (chunk) => {
  buffer += chunk.toString("utf8");
  const newline = buffer.indexOf("\n");
  if (newline === -1) return;
  const line = buffer.slice(0, newline).trim();
  clearTimeout(timer);
  finished = true;
  socket.end();
  try {
    const parsed = JSON.parse(line);
    finish({ ok: true, elapsedMs: Date.now() - startedAt, response: parsed }, 0);
  } catch (error) {
    finish({ ok: false, error: "invalid_json", raw: line, elapsedMs: Date.now() - startedAt }, 1);
  }
});

socket.on("error", (error) => {
  if (finished) return;
  clearTimeout(timer);
  finished = true;
  finish({ ok: false, error: error.message, elapsedMs: Date.now() - startedAt }, 1);
});
'@

$output = $script | node -
if ($Json) {
  $output
} else {
  $result = $output | ConvertFrom-Json
  if ($result.ok) {
    Write-Host "[health] ok elapsedMs=$($result.elapsedMs)"
    $result.response | ConvertTo-Json -Depth 16
  } else {
    Write-Host "[health] failed error=$($result.error) elapsedMs=$($result.elapsedMs)"
    exit 1
  }
}

