---
name: codex-feishu-bridge
description: Build, configure, validate, troubleshoot, slim, and safely operate a local Codex-to-Feishu bridge with Feishu private-chat inbound, explicit Codex desktop thread binding, nine-mode message sync, three-section CardKit assistant cards, outbound mirroring, SQLite durability, screenless main-link rules, controlled restart origin-thread restoration, and recovery guardrails.
---

# Codex Feishu Bridge

Use this skill when a user wants to set up, package, diagnose, slim, or safely operate a local Codex-to-Feishu bridge.

## Core Rule

Protect function and stability before reducing steps. Delete retired or duplicate branches only after a read-only observation proves the main link remains healthy.

The main bridge link should be event and binding driven. Manual clicks or viewing old Codex conversations must not create a binding decision, switch the bridge target, or trigger history backfill.

## Current Behavior To Preserve

- Nine-mode message sync is the baseline: Feishu to Codex text, image, file, text+image; Codex to Feishu text, image, file, text+image, text+file.
- Feishu image-only inbound should use native attachment handling with an empty request body. Do not force a textual placeholder into the Codex user bubble.
- Codex user-message mirroring to Feishu should come from native user-message events plus idempotent ledger state, not from window snapshots or visible conversation selection.
- Assistant cards should have three append-only sections: thinking, tool summary, and final reply.
- Tool summaries should come from structured tool call/completion events and be available during normal streaming, not from delayed catch-up as the primary path.
- Card completion should be driven by terminal turn/item status and should settle the footer/status after the final section is complete.
- If a committed Feishu inbound turn crosses a Codex context-compaction boundary and only the visible bubble is missing, use a one-shot same-route refresh. Do not resubmit, replay, or mutate message history.
- Operator-facing final reports may use short native status icons or glyphs when helpful, but correctness must not depend on Feishu-only decoration.

## Public Safety Boundary

- Never print or commit app secrets, tenant tokens, real open IDs, chat IDs, local thread IDs, SQLite databases, logs, or local extracted app packages.
- Do not delete pending/recovery state to hide a symptom.
- Do not bypass allowlist validation for convenience.
- Prefer a controlled restart and post-restart verification over a blind process kill.

## Setup Workflow

1. Read `references/setup.md` for the install and config flow.
2. Use `scripts/install.ps1` to create local config directories and copy the example config if missing.
3. Use `scripts/configure.ps1` with user-supplied credentials and allowlisted open IDs.
4. Start the user's compatible local bridge implementation.
5. Run `scripts/doctor.ps1 -CheckPipe` and fix failures before live testing.
6. Send one short Feishu message, wait for settlement, then re-run diagnostics.

## Post-Update Adaptation Workflow

Use `docs/post-update-adaptation.md` when the Codex desktop version changes.

- Snapshot config, SQLite files, app package metadata, and changed bridge files before editing.
- Classify the changed seam before patching: resource layout, frontend helper shape, native/app-server API, Electron/Node ABI, or state schema.
- Do not blindly reapply old patches.
- If a frontend helper such as `thread-follower-start-turn` starts throwing shape errors after an update, prefer a validated native/app-server turn-start route and add a focused fallback test.
- If active assistant output can be observed through app-server notifications, prefer event/delta-driven card updates over repeated full thread reads.
- For native SQLite tests, run with the matching Electron runtime by setting `ELECTRON_RUN_AS_NODE=1`.
- Live success requires Feishu inbound, Codex local commit, exactly one assistant card, final card settlement, no duplicate rows, no open pending actions, SQLite integrity `ok`, and no Codex-window typing stalls while the assistant card is updating.

## Diagnostic Workflow

Use `references/diagnostics.md` and check:

- Bridge health.
- Pending actions.
- SQLite quick_check.
- Recent card status and finalization.
- Maintenance/retention result.
- Controlled restart origin-thread restoration when restart behavior changed.
- Codex desktop input responsiveness while a reply is streaming and the Feishu card is being patched.
- All nine message modes when ingress, egress, attachments, binding, or card streaming changed.
- Three-section assistant card parity with the Codex desktop run: thinking, tool summaries, final text, and completed status.

## Performance Rule

Do not preserve remote sync by making local Codex typing worse.

If typing lag only appears inside the Codex bridged window while other apps type normally, inspect bridge/runtime work before treating it as a system-wide IME problem.

Known high-risk pattern:

- The active Codex session is large.
- Metadata reads are fast, but full `readThread(..., { includeTurns: true })` calls are hundreds of milliseconds.
- A timer or active-card path repeatedly does full reads while the user is typing.

Preferred shape:

- Idle/no-change polling reads lightweight metadata first and skips full turns when the thread has not changed.
- Active assistant output uses app-server internal events such as assistant delta, item completed, and turn completed notifications.
- Tests prove active output does not need full thread reads.
- Frequency reductions are temporary diagnostics, not the final fix, unless the user explicitly accepts lower responsiveness.

## Slimming Workflow

Safe simplification candidates:

- Retired clipboard handoff.
- Duplicate diagnostics with the same source of truth.
- Legacy branches with no caller.
- Manual multi-step setup that can become a guarded script.
- Historical snapshot tables and snapshot-based user-message repair after the bridge has moved to a forward-only sync policy.
- Visible-window target inference in the normal message path after explicit binding is available.

Default preserve list:

- SQLite durability and quick_check.
- Pending/retry recovery.
- CardKit create/patch/finalize safeguards.
- Controlled restart verification, including explicit navigation back to the stored origin thread and route confirmation.
- Allowlist checks.
- Config placeholder validation.

## Post-Update Guardrails

- Treat `health.activeThread` as a bridge health signal, not proof that the desktop UI is showing the expected conversation.
- For controlled restart, navigate to the stored origin conversation ID, then verify the renderer route or active-thread return value matches.
- Do not reintroduce snapshot replay, old-message catch-up, or "repair missing user messages from history" unless the user explicitly asks for archival synchronization.
- If context snapshot tables are retired, update SQLite maintenance so stale cleanup errors do not remain as false health warnings.
- Do not keep retrying a broken frontend helper after a desktop update. Classify it as a seam change, use a structured fallback, and test that the failure is terminal or safely routed.
- For compaction-boundary visibility misses, first prove the inbound turn is already committed in durable/native state, then refresh the same route once. Do not turn a display miss into a duplicate delivery.

## Host Typing-Lag First Aid

If the operator reports keyboard lag while diagnosing the bridge, first separate OS-wide input lag from Codex-window-only lag. Default OS-wide relief is limited to refreshing user-mode input processes and raising the active desktop app priority. If only Codex lags, inspect bridge polling, full thread reads, app-server notifications, and CardKit update flow before touching unrelated apps, vendor services, drivers, or Windows services.
