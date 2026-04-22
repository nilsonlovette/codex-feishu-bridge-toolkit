# Post-Update Adaptation

Codex desktop updates can change frontend bundles, Electron versions, app-server contracts, or local resource layout. Do not mechanically replay an old bridge patch against a new build.

## Update Flow

1. Snapshot first: bridge config, SQLite database files, changed bridge source files, and the current app package metadata.
2. Classify the update: layout-only, frontend helper shape change, app-server/API change, internal notification shape change, Electron/Node ABI change, or state schema change.
3. Preserve the locked behavior: explicit binding, forward-only sync, no visible-window target inference, no history backfill, one visible assistant card per logical reply, and controlled restart route verification.
4. Adapt the smallest seam that moved.
5. Re-run static checks, matching-runtime tests, SQLite integrity checks, and a live two-way Feishu/Codex smoke test.

## Frontend Helper Drift

If a new desktop build makes a frontend helper such as `thread-follower-start-turn` throw shape errors, treat that helper as a changed seam. Examples include:

- Window-affinity errors that say the conversation must continue in the original window.
- Type errors from a packaged frontend asset, such as trying to read `match` from an undefined value.

Recommended response:

- Do not keep retrying the broken frontend helper.
- Fall back to a structured native/app-server turn-start path when available.
- Add a regression test that proves the helper error becomes a safe fallback instead of a terminal inbound failure.
- Verify that failed inbound messages remain terminal and are not replayed later.

## Active Output Performance

Post-update adaptation must keep the local Codex desktop responsive while the bridge mirrors replies.

If the user reports intermittent typing stalls only in the Codex bridged window:

- Do not assume it is keyboard hardware, IME, or Windows text input if other apps type normally.
- Measure the bridge's cheap metadata read path separately from full thread reads.
- Treat repeated full `readThread(..., { includeTurns: true })` calls as a typing-lag risk when sessions are large.
- Do not make frequency reductions the final repair if a data-path fix is available.

Preferred active-output design:

- Use lightweight metadata reads for idle/no-change checks.
- Use app-server internal notification events for active assistant/card updates. Common useful events include assistant message delta, item completed, and turn completed notifications.
- Keep focused tests that prove active streaming/card updates do not call the full thread-read path.
- Keep one visible assistant card per logical reply; delta events should patch the same card/session, not create a new reply each time.

## Matching Runtime Tests

If the bridge uses native Node modules such as SQLite bindings, run database tests with the same Electron/Node ABI that the bridge uses at runtime. A system `node --test` run can skip or misreport native-module tests if the native module was compiled for Electron.

Generic pattern:

```powershell
$env:ELECTRON_RUN_AS_NODE = "1"
& $BridgeElectron --test $BridgeStoreTest
```

For pure JavaScript tests, system Node can still be useful. For native SQLite, Electron-as-Node is the source of truth.

## Live Smoke Gate

After code tests pass, perform a live smoke test:

1. Send one short Feishu message.
2. Confirm it lands as a local committed Codex user turn.
3. Confirm exactly one assistant CardKit session is created for the reply.
4. Confirm the card reaches a final state.
5. Confirm no duplicate provider message rows, no duplicate cards per turn, no open pending actions, and SQLite integrity remains `ok`.
6. While the reply is streaming and the card is updating, type in the Codex desktop input box for 30-40 seconds and confirm there are no periodic stalls.

If the change touches message rendering or attachment handling, expand the smoke gate to the nine-mode matrix:

- Feishu to Codex: text, image, file, text+image.
- Codex to Feishu: text, image, file, text+image, text+file.

For Feishu image-only inbound, the expected Codex desktop result is the native image attachment plus an empty-content bubble. Placeholder body text is a regression.

For assistant cards, verify the three sections from their real sources:

- thinking section from thinking/reasoning events;
- tool section from structured tool events;
- final section from assistant final text;
- completed footer/status from terminal turn or item completion.

Do not repair missing tool summaries with routine delayed replay if the root cause is that early events arrived before the card session was bound. Bind first, then consume events.

If a committed inbound Feishu turn is not visible because a Codex context-compaction boundary happened at the same time, use a one-shot refresh of the same conversation route. Do not resubmit the message or alter the ledger.

## Host Input Stability

If desktop typing is lagging during bridge validation, first determine whether the lag is system-wide or Codex-window-only. Refresh only user-mode input components such as the IME/text input host and raise the active desktop app priority for system-wide input lag. For Codex-window-only lag, inspect bridge polling, full thread reads, app-server event handling, and CardKit patch flow before blaming Windows input.
