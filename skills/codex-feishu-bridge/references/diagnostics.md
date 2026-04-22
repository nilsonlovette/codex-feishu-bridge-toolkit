# Diagnostics Reference

A healthy bridge should settle to:

- Bridge health online.
- Pending actions zero after messages finish.
- SQLite quick_check ok.
- Recent assistant cards finalized.
- Maintenance result successful or skipped for a clear reason.
- Controlled restart tickets completed, with warning and recovery report delivered when restart behavior is under test.
- Nine message modes passing when message rendering, attachments, binding, outbound mirroring, or card streaming changed.
- Three-section assistant cards settled: thinking, tool summary, final reply, and completed status.

## Read-Only First

Always inspect before repair:

```powershell
.\scripts\doctor.ps1 -CheckPipe
.\scripts\health.ps1
```

For database tests that load native SQLite bindings, use the Electron runtime that matches the bridge:

```powershell
$env:ELECTRON_RUN_AS_NODE = "1"
& $BridgeElectron --test $BridgeStoreTest
```

If system Node reports a native-module ABI mismatch, rerun with the matching Electron runtime before diagnosing the bridge as unhealthy.

If cards remain in processing after Codex output completes, inspect CardKit create/patch/finalize logs and recent card state before changing timing.

If pending actions are nonzero while idle, inspect whether they are active, stale, or recovery rows. Do not delete them without backup and a clear reason.

## Message Mode Checks

Run the full nine-mode matrix after any change that touches attachment rendering, message classification, binding, outbound mirroring, or assistant card streaming:

1. Feishu to Codex text.
2. Feishu to Codex image.
3. Feishu to Codex file.
4. Feishu to Codex text plus image.
5. Codex to Feishu text.
6. Codex to Feishu image.
7. Codex to Feishu file.
8. Codex to Feishu text plus image.
9. Codex to Feishu text plus file.

For Feishu image-only inbound, the expected Codex bubble is native empty content below the image attachment. A literal placeholder means the bridge is writing synthetic body text.

For assistant card streaming, verify thinking, tool summary, final reply, and completed status independently. A completed final reply with an in-progress footer is still a card-state bug.

## Controlled Restart Checks

Do not treat a generic health `activeThread` value as proof that the desktop UI returned to the origin conversation. Some bridges expose the bound thread in health even when the visible UI has not been restored.

For restart validation, require all of these:

1. Restart ticket status is `completed`.
2. The stored origin conversation ID is still present.
3. A renderer route or explicit navigation check reports the same origin conversation after restart.
4. The recovery report ledger row is delivered or its failure is recorded explicitly.
5. Pending actions settle back to zero.

If the bridge has retired snapshot history, confirm the live SQLite schema no longer has context snapshot tables and that maintenance does not leave stale "missing snapshot table" errors.

After a desktop update, also check for frontend helper shape errors. If a helper such as `thread-follower-start-turn` throws a packaged frontend type error, the safe path is to classify that helper as drifted, fall back to a structured native/app-server turn-start route, and add a regression test.

If a Feishu inbound message disappears only from the visible Codex UI around a context-compaction boundary, first verify durable ledger/native session evidence. If it is already committed, use a one-shot same-conversation route refresh; do not replay the message.
