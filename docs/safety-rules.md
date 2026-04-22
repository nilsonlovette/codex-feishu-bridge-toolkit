# Safety Rules

## Never Commit

- App secret, tenant token, verification token, encrypt key.
- Real Feishu open IDs or chat IDs.
- Local Codex thread IDs.
- SQLite databases.
- Logs.
- `node_modules`.
- Local extracted app packages.
- User-specific absolute paths.

## Change Rules

- Make one link change at a time.
- Validate after every change.
- Prefer read-only observation before repair.
- Preserve recovery state unless the user explicitly approves a cleanup after backup.
- Do not delete pending rows to hide a symptom.
- Do not infer the bridge target from the visible Codex window in the normal message path.
- Do not backfill old Codex history into Feishu unless the user explicitly wants archival synchronization.
- Do not keep retrying a desktop frontend helper after a version update proves its argument shape has changed.
- Do not hide Codex-window typing stalls by only lowering bridge/card frequencies when a full-read or event-shape fix is available.
- Do not create synthetic user-message text for attachment-only messages when the native attachment path can render the correct empty body.
- Do not use delayed catch-up as the primary way to make tool summaries complete; fix the event/card binding order first.
- Do not resubmit or replay Feishu inbound messages to fix a Codex context-compaction visibility miss.

## Simplification Rules

Safe candidates:

- Retired clipboard path.
- Duplicate diagnostics that report the same source of truth.
- Legacy branches that no longer have a caller.
- Manual multi-step flows replaced by a single guarded script.
- Historical snapshot tables and snapshot-based repair after forward-only delivery has been verified.
- Visible-window target inference after explicit thread binding is available.
- Fragile frontend submission helpers after a structured native/app-server route has been validated.
- Active-output full thread reads after an event/delta notification path has been validated.
- Catch-up tool-summary replay after the active-output event binding order has been fixed.

Unsafe candidates without more evidence:

- SQLite durability.
- Pending/retry recovery.
- CardKit finalization guards.
- Controlled restart verification.
- Allowlist checks.
- Config placeholder validation.

## Controlled Restart Rules

- Use the stored origin conversation ID to restore the desktop after restart.
- Verify restoration with renderer route or active-thread return values, not only with bridge health binding.
- Verify the recovery report ledger row is delivered or its failure is explicit.
- Keep completed restart tickets until post-restart verification is captured, then clear only through the bridge control surface.

## Forward-Only Sync Rules

- Treat Feishu as a remote communication transport, not a full history mirror, unless the user asks otherwise.
- Start synchronization from the user-message binding trigger onward.
- Ignore manual clicks or passive viewing of old conversations.
- Remove snapshot replay and old-message repair code only after backup, tests, and a live health check.

## Host Stability Rules

- If typing lag or IME stutter is present, stabilize the local input path before judging bridge latency.
- Default input relief should be limited to user-mode text input processes and active-app priority.
- If only the Codex bridged window lags, inspect bridge polling, full thread reads, app-server notifications, and CardKit updates before treating it as a Windows input problem.
- Do not restart unrelated chat apps, browsers, vendor tools, drivers, or Windows services during the default bridge health pass.
