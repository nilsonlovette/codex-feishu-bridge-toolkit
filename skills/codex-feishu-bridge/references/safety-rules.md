# Safety Rules Reference

## Do Not Upload

- Real Feishu credentials or IDs.
- Local Codex thread IDs.
- SQLite databases.
- Logs.
- `node_modules`.
- Extracted local app packages.

## Validate After Each Change

After every bridge change, run:

1. Health check.
2. Pending check.
3. SQLite quick_check.
4. Recent card status check.
5. One short live Feishu message if the change touches the main link.

## Restart Rule

Use controlled restart when possible. After restart, confirm no duplicate card patches, no stale pending rows, and no completed card stuck in processing.

Controlled restart has one special rule: it may explicitly navigate back to the stored origin conversation ID. That is different from normal bridge traffic. Normal message routing should not infer targets from the visible window, old snapshots, clipboard state, or the conversation the user happened to click.

## Forward-Only Sync Rule

When the user's bridge is intended as a remote communication transport, not a second archive:

- Start synchronization from the binding trigger onward.
- Do not backfill old Codex history into Feishu after interruption.
- Do not "repair" missing user messages from old snapshots.
- Do not record manual viewing or clicking old conversations as a routing signal.
- Keep only current health, binding state, delivery state, controlled restart state, and errors.
- Do not inject fake body text for attachment-only messages when the native empty-body attachment path exists.
- Do not use delayed replay as the normal solution for missing tool summaries; fix card-session binding before consuming structured tool events.
- Do not resubmit a Feishu inbound message just because a Codex context-compaction boundary hid the visible bubble.
