# Diagnostics

The minimum healthy observation set is:

- Bridge health: online, current sidecar process if applicable, and transport mode.
- Pending actions: zero for a settled system.
- SQLite quick_check: `ok`.
- Recent card status: completed cards should be finalized, not stuck in processing.
- Maintenance result: retention/cleanup should complete without deleting active pending rows.
- Controlled restart: completed ticket, origin conversation restored, and recovery report delivered or an explicit delivery error recorded.
- Input responsiveness: Codex desktop should remain responsive while a reply is streaming and the Feishu card is updating.

## Commands

```powershell
.\scripts\doctor.ps1 -BridgeSourcePath "D:\path\to\your\bridge" -CheckPipe
.\scripts\health.ps1
```

If a test touches native SQLite bindings, run it with the same Electron runtime used by the bridge:

```powershell
$env:ELECTRON_RUN_AS_NODE = "1"
& $BridgeElectron --test $BridgeStoreTest
```

Do not treat a system Node ABI mismatch as proof that the live bridge database is broken. Re-run the affected database test with the matching Electron runtime before making a diagnosis.

## Observation Protocol

For live testing, use simple messages first:

1. Send a short Feishu message and wait 60 seconds.
2. Confirm the Codex desktop receives it quickly.
3. Confirm the Feishu card starts rendering promptly.
4. Confirm the same card reaches a final state.
5. Run doctor checks after the message settles.
6. During a streaming reply, type in the Codex desktop input box for 30-40 seconds and note whether stalls appear.

For full message-mode validation, verify all nine modes after any change that touches ingress, egress, attachments, binding, or card streaming:

1. Feishu to Codex text.
2. Feishu to Codex image.
3. Feishu to Codex file.
4. Feishu to Codex text plus image.
5. Codex to Feishu text.
6. Codex to Feishu image.
7. Codex to Feishu file.
8. Codex to Feishu text plus image.
9. Codex to Feishu text plus file.

The expected Feishu image-only to Codex rendering is a native image attachment with an empty-content user bubble. A literal text marker in that bubble means the bridge is injecting placeholder text instead of using the native empty request path.

For assistant cards, compare the Codex desktop run with the Feishu card:

- Thinking content is complete and in the thinking section.
- Tool summaries match the actual tool calls and do not rely on delayed catch-up.
- Final text is complete and in the final section.
- The card finalizes after the Codex turn completes.

For restart testing:

1. Stop using the bridge briefly.
2. Perform a controlled restart.
3. Verify the restart ticket reached `completed`.
4. Verify the desktop route or active-thread return value matches the stored origin conversation.
5. Verify warning and recovery-report ledger rows were delivered or explicitly marked failed.
6. Run doctor checks.
7. Send one short message from Feishu.
8. Verify no duplicate cards, no stale pending actions, and no SQLite corruption.

For forward-only bridges:

- Manual clicks or reading old Codex conversations should not change the binding.
- Old Codex history should not be replayed into Feishu after interruption.
- If context snapshots are retired, the SQLite schema should not contain snapshot tables and maintenance should not keep stale "missing table" errors.

For Codex-window-only typing lag:

- Compare metadata-only thread reads with full thread reads.
- If full reads are much slower, remove repeated active-output full reads before changing polling frequency.
- Prefer app-server internal events for assistant delta, item completion, and turn completion so CardKit updates do not need to parse full historical turns.

For compaction-boundary checks:

- If a Feishu inbound message is missing only from the visible Codex bubble, first verify the durable ledger and native session event stream.
- If the message is already committed and associated with the active turn, use at most one route refresh for the same conversation.
- Do not create a new message, backfill from history, or resend the inbound payload to fix a visibility-only miss.

## Red Flags

- Card remains in processing after the Codex answer is complete.
- Pending actions grow while no messages are being processed.
- SQLite quick_check is not `ok`.
- Sidecar is online but CardKit updates fail.
- Restart causes old completed cards to re-open or re-patch.
- Restart reports completion based only on health binding without route confirmation.
- Old user messages appear in Feishu after restart even though no new binding trigger occurred.
- A frontend helper starts throwing shape errors after a desktop update and inbound messages are retried instead of safely falling back or failing terminally.
- Local Codex typing stalls periodically while Feishu cards are updating, especially when the active session is large.
