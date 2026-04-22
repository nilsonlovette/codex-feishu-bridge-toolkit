# Codex Feishu Bridge Toolkit

A sanitized public toolkit and downloadable optimal package for reproducing a local Codex Desktop to Feishu private-chat bridge.

This is a community starter toolkit. It is not an official OpenAI or Feishu product.

## Build The Bridge, Not The Mess

Codex Feishu Bridge Toolkit packages the currently verified bridge shape into a clean GitHub download. It keeps the useful runtime, sidecar, config template, diagnostics, and operating rules while removing private runtime state, secrets, logs, local paths, thread IDs, databases, and historical detours.

Use it when you want:

- Feishu private-chat messages to reach the active bound local Codex desktop thread.
- Codex assistant replies to come back as one Feishu CardKit card with thinking, tool summary, and final reply sections.
- Bidirectional message sync across the nine verified modes: Feishu to Codex text, image, file, text+image; Codex to Feishu text, image, file, text+image, text+file.
- Codex Plan Mode "implement plan" clicks to mirror as `实施计划` instead of reposting the hidden full prompt.
- Setup scripts that refuse placeholder secrets before enabling the bridge.
- Diagnostics that check health, pending actions, SQLite durability, card finalization, controlled restart, and maintenance.
- A Codex skill that teaches the same guardrails every time the bridge is changed.

## Download The Optimal Package

Use the current reproducible snapshot:

- Source folder: `packages/codex-feishu-bridge-optimal-20260422/`
- Downloadable archive: `packages/codex-feishu-bridge-optimal-20260422.zip`

The package is built from the live bridge version that passed the latest end-to-end checks: nine message modes, new/old conversation auto-rebind, native image-only inbound, three-section CardKit streaming, tool summary completeness, final status completion, controlled restart recovery, and Plan Mode `实施计划` normalization.

## What This Provides

- A safe configuration template for the current verified local Codex-to-Feishu bridge.
- A sanitized source package containing the runtime, sidecar, CardKit renderer, restart helpers, and Feishu bridge configuration shape.
- PowerShell scripts for install bootstrap, config writing, health checks, doctor checks, and pre-upload sanitization.
- A Codex skill that captures stable bridge operation knowledge: inbound Feishu messages, explicit Codex desktop thread binding, CardKit assistant cards, outbound mirroring, SQLite durability, screenless main-link rules, controlled restart, and recovery guardrails.
- Public docs for architecture, Feishu app setup, diagnostics, and safety rules.
- A post-update adaptation playbook for revalidating a new Codex desktop build without blindly replaying old bridge patches.
- A performance guardrail for Codex-window-only typing lag caused by repeated full thread reads during active Feishu card updates.
- A live-smoke matrix for the nine message modes that matter in practice.

## What This Does Not Include

- No app secrets, tenant tokens, open IDs, thread IDs, SQLite databases, logs, runtime state, node_modules, local package extracts, or personal paths.
- No guarantee that every Codex desktop build exposes the same internal bridge surface. Use the doctor script to check compatibility before enabling the bridge.
- No history-replay bridge. The recommended baseline is forward-only synchronization from the binding trigger onward.

## Quick Start

Run PowerShell from this repository:

```powershell
.\scripts\install.ps1 -BridgeSourcePath "D:\path\to\your\bridge"
.\scripts\configure.ps1 -AppId "cli_xxx" -AppSecret "<your-secret>" -AllowlistOpenIds @("ou_xxx") -DefaultOpenId "ou_xxx" -Enable
.\scripts\doctor.ps1 -BridgeSourcePath "D:\path\to\your\bridge" -CheckPipe
```

If you only want to validate this repository before upload:

```powershell
.\scripts\sanitize-check.ps1
```

To use the optimal package directly, download `packages/codex-feishu-bridge-optimal-20260422.zip`, unzip it, follow the package README, and configure your own Feishu app credentials.

## Recommended Setup Flow

1. Create a Feishu custom app and enable bot permissions.
2. Add the bot to the target chat or test with a single allowlisted user first.
3. Run `install.ps1` to create the local config directory and copy the example config if missing.
4. Run `configure.ps1` with your app credentials and allowlisted open IDs.
5. Start your compatible local bridge implementation.
6. Run `doctor.ps1 -CheckPipe` and confirm health, config, pending state, and SQLite checks are clean.
7. Send a simple Feishu message and verify that the Codex reply card finalizes.

## Upload Checklist

Before pushing to GitHub:

- Run `.\scripts\sanitize-check.ps1`.
- Confirm no `bridge-config.json`, `.db`, `.sqlite`, `.log`, `.env`, `node_modules`, or local runtime directories are staged.
- Confirm docs only contain placeholders such as `cli_xxx` and `ou_xxx`.
- Confirm the package is positioned as a toolkit/starter, not as a dump of a private local bridge.

## Repository Layout

```text
docs/
  architecture.md
  diagnostics.md
  feishu-app-setup.md
  post-update-adaptation.md
  safety-rules.md
scripts/
  configure.ps1
  doctor.ps1
  health.ps1
  install.ps1
  sanitize-check.ps1
skills/
  codex-feishu-bridge/
    SKILL.md
    agents/openai.yaml
    references/
templates/
  bridge-config.example.json
packages/
  codex-feishu-bridge-optimal-20260422/
  codex-feishu-bridge-optimal-20260422.zip
```

## Stability Principle

The bridge should be slimmed by deleting proven dead ends, not by removing recovery paths that protect message delivery. Keep SQLite durability, pending/retry handling, CardKit finalization safeguards, allowlist checks, and controlled restart checks unless live evidence proves a simpler replacement is safer.

For the normal message path, do not infer the bridge target from the visible Codex window, clipboard state, or old snapshots. Manual clicks and passive viewing of old conversations should not affect routing. Controlled restart is the exception: it should explicitly navigate back to the stored origin conversation and verify that route before claiming recovery.

For user-visible message sync, prefer native structured events and attachment metadata over synthetic placeholder text. Image-only inbound messages should render through the native attachment path with an empty request body, not as a forced textual marker.

## Post-Update Principle

After a Codex desktop update, treat the bridge as an adapter that must be revalidated against the new build. Compare the changed integration seams first, then patch only the seam that moved. If a packaged frontend helper changes shape, prefer a structured native/app-server path when available and add a focused regression test before declaring the update stable.

For active assistant replies, prefer event/delta-driven CardKit updates over repeated full thread reads. A bridge can be online and still hurt the local operator if it parses a large session every few seconds while the user is typing in Codex.
