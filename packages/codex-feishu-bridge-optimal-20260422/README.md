# Codex Feishu Bridge Optimal 2026-04-22

This package is a sanitized snapshot of the verified local Codex Desktop to Feishu bridge.

It is not an official OpenAI or Feishu product. It is a reproducible reference package for builders who want the same bridge shape without private secrets, local state, logs, databases, or machine-specific IDs.

## Verified Behavior

- Feishu to Codex: text, image, file, and text plus image.
- Codex to Feishu: text, image, file, text plus image, and text plus file.
- Codex assistant replies render as one Feishu card with three live sections: thinking, tool summary, final reply.
- Tool summaries use structured tool events and preserve repeated calls.
- Follow-current binding rebinds from native user message data when switching Codex conversations.
- Image-only Feishu inbound uses the native attachment path with an empty request body.
- Codex Plan Mode implementation requests mirror to Feishu as `实施计划`, not as the full hidden `PLEASE IMPLEMENT THIS PLAN:` prompt.
- Controlled restart uses a persisted ticket, warning message, route restoration, and health verification.

## Contents

```text
bridge/
  runtime.js
  bridge-store.js
  config.js
  pipe-server.js
  renderer-dom-adapter.js
  sidecar-manager.js
  electron-feishu-bridge-bootstrap.js
  electron-feishu-require-hook.js
  configure-feishu-bridge.ps1
  restart-and-verify-feishu-bridge.ps1
  restart-codex-with-feishu-bridge.ps1
  switch-and-verify-bridged-clone.ps1
  feishu-sidecar/
    index.js
    mermaid-renderer.js
    package.json
    package-lock.json
templates/
  bridge-config.example.json
```

## Install Outline

1. Copy `bridge/` into the target Codex bridge root for the Codex Desktop build you are adapting.
2. Copy `templates/bridge-config.example.json` to `%LOCALAPPDATA%\Codex\FeishuBridge\bridge-config.json`.
3. Replace `cli_xxx`, `xxx`, and `ou_xxx` with your Feishu app ID, app secret, allowlist open IDs, and default open ID.
4. In `bridge/feishu-sidecar`, run `npm install --omit=dev`.
5. Make sure the host Codex runtime can resolve `better-sqlite3`; if not, run `npm install better-sqlite3` in the bridge host package that loads `runtime.js`.
6. Launch Codex through your bridged Electron runner, then verify `bridge.health` over `\\.\pipe\codex-feishu-bridge`.

## Safety Notes

- Do not commit your real `bridge-config.json`, SQLite database, logs, inbound attachments, Feishu tokens, open IDs, chat IDs, or local thread IDs.
- Treat every Codex Desktop update as an adapter change. Recompare the native notification and thread-reading seams before copying this package forward.
- Keep message synchronization forward-only from the active binding. Do not replay old history to "repair" cards.
- If you change message routing, rerun the nine-mode message smoke test before publishing.

## Smoke Test Checklist

- Feishu to Codex: text, image, file, text plus image.
- Codex to Feishu: text, image, file, text plus image, text plus file.
- New and old Codex conversations both auto-bind when the user sends a message.
- Assistant card reaches completed status after final reply.
- Plan Mode `实施计划` appears in Feishu as one short user message.
