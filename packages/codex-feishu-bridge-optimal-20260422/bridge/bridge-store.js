"use strict";

const Database = require("better-sqlite3");
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

function nowIso() {
  return new Date().toISOString();
}

const DEFAULT_MAINTENANCE_BATCH_LIMIT = 5000;
const DEFAULT_DELIVERED_ATTEMPT_MAX_AGE_MS = 5 * 60 * 1000;
const DEFAULT_FAILED_ATTEMPT_MAX_AGE_MS = 24 * 60 * 60 * 1000;
const DEFAULT_COMPLETED_ACTION_MAX_AGE_MS = 5 * 60 * 1000;
const DEFAULT_COMPLETED_FEISHU_CARD_SESSION_MAX_AGE_MS = 24 * 60 * 60 * 1000;
const DEFAULT_COMPLETED_FEISHU_CARD_SESSION_KEEP_PER_THREAD = 50;
const DEFAULT_RUNTIME_TRANSIENT_STATE_MAX_AGE_MS = 15 * 60 * 1000;
const DEFAULT_MESSAGE_LEDGER_PAYLOAD_MAX_AGE_MS = 60 * 60 * 1000;
const DEFAULT_FAILED_MESSAGE_LEDGER_PAYLOAD_MAX_AGE_MS = 24 * 60 * 60 * 1000;
const DEFAULT_PHYSICAL_COMPACTION_COOLDOWN_MS = 24 * 60 * 60 * 1000;
const DEFAULT_PHYSICAL_COMPACTION_MIN_FREELIST_BYTES = 32 * 1024 * 1024;
const DEFAULT_PHYSICAL_COMPACTION_MIN_FREE_RATIO = 0.25;
const DEFAULT_PHYSICAL_COMPACTION_ACTIVE_WINDOW_MS = 2 * 60 * 1000;
const DEFAULT_SQLITE_MAINTENANCE_ARTIFACT_MAX_AGE_MS = 24 * 60 * 60 * 1000;
const DEFAULT_SQLITE_MAINTENANCE_ARTIFACT_KEEP_RECENT = 1;
const SQLITE_LAST_PHYSICAL_COMPACTION_KEY =
  "sqlite_maintenance:last_physical_compaction";

function parseJsonSafely(value, fallback = null) {
  if (value == null) {
    return fallback;
  }
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

function mergeCardChunk(existingChunk, nextChunk, key) {
  const existingText = String(existingChunk?.text ?? "").trim();
  const nextText = String(nextChunk?.text ?? "").trim();
  let text = nextText || existingText;
  if (existingText && nextText) {
    if (nextText.startsWith(existingText)) {
      text = nextText;
    } else if (existingText.startsWith(nextText)) {
      text = existingText;
    } else {
      text = `${existingText}\n\n${nextText}`;
    }
  }
  const turnStatus =
    [existingChunk, nextChunk].some(
      (chunk) => String(chunk?.turnStatus ?? "").trim().toLowerCase() === "completed",
    )
      ? "completed"
      : String(nextChunk?.turnStatus ?? existingChunk?.turnStatus ?? "").trim() || null;
  return {
    ...(existingChunk ?? {}),
    ...(nextChunk ?? {}),
    key,
    text,
    observedAt: nextChunk?.observedAt ?? existingChunk?.observedAt,
    turnStatus,
  };
}

function mergeCardState(existingState, nextState) {
  const existing = existingState != null && typeof existingState === "object" ? existingState : {};
  const next = nextState != null && typeof nextState === "object" ? { ...nextState } : {};
  let sectionStreams = next.sectionStreams;
  if (existing.sectionStreams && !sectionStreams) {
    sectionStreams = existing.sectionStreams;
  } else if (existing.sectionStreams && sectionStreams) {
    sectionStreams = { ...sectionStreams };
    for (const section of ["progress", "tool", "final"]) {
      const merged = { order: [], chunksByKey: {}, completedKeys: [] };
      for (const stream of [existing.sectionStreams?.[section], sectionStreams?.[section]]) {
        for (const key of Array.isArray(stream?.order) ? stream.order : []) {
          if (key && !merged.order.includes(key)) merged.order.push(key);
        }
        for (const key of Array.isArray(stream?.completedKeys) ? stream.completedKeys : []) {
          if (key && !merged.completedKeys.includes(key)) merged.completedKeys.push(key);
        }
        for (const [key, chunk] of Object.entries(stream?.chunksByKey ?? {})) {
          merged.chunksByKey[key] = mergeCardChunk(merged.chunksByKey[key], chunk, key);
        }
      }
      sectionStreams[section] = merged;
    }
  }
  for (const field of [
    "sourceCompletedAt",
    "completedAt",
    "presentationCompletedAt",
    "finalItemKey",
  ]) {
    next[field] = next[field] ?? existing[field];
  }
  if (existing.sectionMode === "typed") next.sectionMode = "typed";
  if ((!Array.isArray(next.items) || next.items.length === 0) && Array.isArray(existing.items)) {
    next.items = existing.items;
  }
  if (next.toolSummary == null && existing.toolSummary != null) {
    next.toolSummary = existing.toolSummary;
  }
  return { ...next, sectionStreams };
}

function positiveInteger(value, fallback) {
  const normalized = Math.floor(Number(value));
  if (!Number.isFinite(normalized) || normalized <= 0) {
    return fallback;
  }
  return normalized;
}

function positiveMilliseconds(value, fallback) {
  const normalized = Number(value);
  if (!Number.isFinite(normalized) || normalized <= 0) {
    return fallback;
  }
  return normalized;
}

function nonNegativeInteger(value, fallback) {
  const normalized = Math.floor(Number(value));
  if (!Number.isFinite(normalized) || normalized < 0) {
    return fallback;
  }
  return normalized;
}

function directorySizeBytes(dirPath) {
  let total = 0;
  const entries = fs.readdirSync(dirPath, { withFileTypes: true });
  for (const entry of entries) {
    const childPath = path.join(dirPath, entry.name);
    if (entry.isDirectory()) {
      total += directorySizeBytes(childPath);
    } else if (entry.isFile()) {
      total += fs.statSync(childPath).size;
    }
  }
  return total;
}

class BridgeStore {
  constructor(storePath) {
    this.storePath = path.resolve(storePath);
    this.rootDir = path.dirname(this.storePath);
    this.db = new Database(this.storePath);
    this.db.pragma("busy_timeout = 5000");
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("foreign_keys = ON");
    this._prepareSchema();
  }

  _prepareSchema() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS bindings (
        binding_id TEXT PRIMARY KEY,
        feishu_open_id TEXT NOT NULL,
        feishu_chat_id TEXT NOT NULL,
        local_thread_id TEXT NOT NULL,
        local_conversation_id TEXT NOT NULL,
        context_version INTEGER NOT NULL DEFAULT 1,
        follow_current_thread INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE(feishu_open_id, feishu_chat_id)
      );

      CREATE TABLE IF NOT EXISTS message_ledger (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        provider TEXT NOT NULL,
        provider_message_id TEXT NOT NULL,
        binding_id TEXT NOT NULL,
        origin TEXT NOT NULL,
        direction TEXT NOT NULL,
        role TEXT NOT NULL,
        text TEXT NOT NULL,
        raw_json TEXT,
        status TEXT NOT NULL,
        local_turn_id TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE(provider, provider_message_id)
      );

      CREATE TABLE IF NOT EXISTS pending_actions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        action_type TEXT NOT NULL,
        binding_id TEXT,
        payload_json TEXT NOT NULL,
        status TEXT NOT NULL,
        attempts INTEGER NOT NULL DEFAULT 0,
        available_at TEXT NOT NULL,
        last_error TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      DROP TABLE IF EXISTS context_snapshots;
      DROP TABLE IF EXISTS context_snapshot_heads;

      CREATE TABLE IF NOT EXISTS delivery_attempts (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        ledger_id INTEGER NOT NULL,
        destination TEXT NOT NULL,
        status TEXT NOT NULL,
        attempt_no INTEGER NOT NULL,
        error_text TEXT,
        created_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS bridge_runtime_state (
        key TEXT PRIMARY KEY,
        value_json TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS feishu_card_sessions (
        session_id TEXT PRIMARY KEY,
        binding_id TEXT NOT NULL,
        local_thread_id TEXT NOT NULL,
        local_turn_id TEXT NOT NULL,
        send_identity TEXT NOT NULL,
        feishu_open_id TEXT NOT NULL,
        feishu_chat_id TEXT NOT NULL,
        card_message_id TEXT,
        mode TEXT NOT NULL,
        status TEXT NOT NULL,
        last_revision INTEGER NOT NULL DEFAULT 0,
        last_applied_revision INTEGER NOT NULL DEFAULT 0,
        last_render_hash TEXT,
        degraded_reason TEXT,
        state_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE(binding_id, local_turn_id, send_identity)
      );

      CREATE INDEX IF NOT EXISTS idx_delivery_attempts_status_created_at
        ON delivery_attempts(status, created_at);
      CREATE INDEX IF NOT EXISTS idx_pending_actions_status_updated_at
        ON pending_actions(status, updated_at);
      CREATE INDEX IF NOT EXISTS idx_feishu_card_sessions_status_updated_at
        ON feishu_card_sessions(status, updated_at);
      CREATE INDEX IF NOT EXISTS idx_feishu_card_sessions_thread_status_updated_at
        ON feishu_card_sessions(binding_id, local_thread_id, send_identity, status, updated_at);
    `);

    this.statements = {
      getBindingByUser: this.db.prepare(
        `SELECT * FROM bindings WHERE feishu_open_id = ? AND feishu_chat_id = ?`,
      ),
      getBindingById: this.db.prepare(
        `SELECT * FROM bindings WHERE binding_id = ?`,
      ),
      listBindings: this.db.prepare(`SELECT * FROM bindings ORDER BY updated_at DESC`),
      upsertBinding: this.db.prepare(`
        INSERT INTO bindings (
          binding_id, feishu_open_id, feishu_chat_id, local_thread_id, local_conversation_id,
          context_version, follow_current_thread, created_at, updated_at
        ) VALUES (
          @binding_id, @feishu_open_id, @feishu_chat_id, @local_thread_id, @local_conversation_id,
          @context_version, @follow_current_thread, @created_at, @updated_at
        )
        ON CONFLICT(feishu_open_id, feishu_chat_id) DO UPDATE SET
          binding_id = excluded.binding_id,
          local_thread_id = excluded.local_thread_id,
          local_conversation_id = excluded.local_conversation_id,
          context_version = excluded.context_version,
          follow_current_thread = excluded.follow_current_thread,
          updated_at = excluded.updated_at
      `),
      insertMessageLedger: this.db.prepare(`
        INSERT OR IGNORE INTO message_ledger (
          provider, provider_message_id, binding_id, origin, direction, role, text, raw_json,
          status, local_turn_id, created_at, updated_at
        ) VALUES (
          @provider, @provider_message_id, @binding_id, @origin, @direction, @role, @text,
          @raw_json, @status, @local_turn_id, @created_at, @updated_at
        )
      `),
      getMessageLedger: this.db.prepare(
        `SELECT * FROM message_ledger WHERE provider = ? AND provider_message_id = ?`,
      ),
      updateMessageLedger: this.db.prepare(`
        UPDATE message_ledger
        SET status = @status,
            local_turn_id = COALESCE(@local_turn_id, local_turn_id),
            updated_at = @updated_at
        WHERE provider = @provider AND provider_message_id = @provider_message_id
      `),
      getMessageLedgerById: this.db.prepare(
        `SELECT * FROM message_ledger WHERE id = ?`,
      ),
      updateMessageLedgerById: this.db.prepare(`
        UPDATE message_ledger
        SET status = @status,
            local_turn_id = COALESCE(@local_turn_id, local_turn_id),
            updated_at = @updated_at
        WHERE id = @id
      `),
      updateMessageLedgerRawJsonById: this.db.prepare(`
        UPDATE message_ledger
        SET raw_json = @raw_json
        WHERE id = @id
      `),
      getPendingActionById: this.db.prepare(
        `SELECT * FROM pending_actions WHERE id = ?`,
      ),
      insertPendingAction: this.db.prepare(`
        INSERT INTO pending_actions (
          action_type, binding_id, payload_json, status, attempts, available_at, last_error, created_at, updated_at
        ) VALUES (
          @action_type, @binding_id, @payload_json, @status, @attempts, @available_at, @last_error, @created_at, @updated_at
        )
      `),
      listPendingActions: this.db.prepare(
        `SELECT * FROM pending_actions WHERE status != 'completed' ORDER BY created_at ASC`,
      ),
      listReadyPendingActions: this.db.prepare(
        `SELECT * FROM pending_actions WHERE status != 'completed' AND available_at <= ? ORDER BY created_at ASC`,
      ),
      updatePendingAction: this.db.prepare(`
        UPDATE pending_actions
        SET binding_id = COALESCE(@binding_id, binding_id),
            payload_json = COALESCE(@payload_json, payload_json),
            status = COALESCE(@status, status),
            attempts = attempts + @attempts_delta,
            available_at = COALESCE(@available_at, available_at),
            last_error = @last_error,
            updated_at = @updated_at
        WHERE id = @id
      `),
      setRuntimeState: this.db.prepare(`
        INSERT INTO bridge_runtime_state (key, value_json, updated_at)
        VALUES (@key, @value_json, @updated_at)
        ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at
      `),
      getRuntimeState: this.db.prepare(
        `SELECT value_json FROM bridge_runtime_state WHERE key = ?`,
      ),
      deleteRuntimeState: this.db.prepare(
        `DELETE FROM bridge_runtime_state WHERE key = ?`,
      ),
      selectPrunableRuntimeStateKeys: this.db.prepare(`
        SELECT key
        FROM bridge_runtime_state
        WHERE updated_at < @cutoff
          AND (
            key LIKE 'sidecar:selfUserMirrorMessage:%'
            OR key LIKE 'sidecar:selfUserMirrorFallback:%'
            OR key LIKE 'sidecar:suppressedDesktopEcho:%'
            OR key LIKE 'sidecar:userSendAuthPending:%'
            OR (
              key LIKE 'sidecar:queuedInbound:%'
              AND json_extract(value_json, '$.status') IN ('processed', 'stale_ignored')
            )
          )
        ORDER BY updated_at ASC
        LIMIT @batch_limit
      `),
      getFeishuCardSessionById: this.db.prepare(
        `SELECT * FROM feishu_card_sessions WHERE session_id = ?`,
      ),
      updateFeishuCardSessionCardMessageId: this.db.prepare(`
        UPDATE feishu_card_sessions
        SET card_message_id = ?, updated_at = ?
        WHERE session_id = ?
      `),
      getFeishuCardSessionByTurn: this.db.prepare(`
        SELECT *
        FROM feishu_card_sessions
        WHERE binding_id = ? AND local_turn_id = ? AND send_identity = ?
      `),
      getLatestFeishuCardSessionByThreadAndStatus: this.db.prepare(`
        SELECT *
        FROM feishu_card_sessions
        WHERE binding_id = ? AND local_thread_id = ? AND send_identity = ? AND status = ?
        ORDER BY created_at DESC, updated_at DESC
        LIMIT 1
      `),
      getLatestFeishuCardSessionByThread: this.db.prepare(`
        SELECT *
        FROM feishu_card_sessions
        WHERE binding_id = ? AND local_thread_id = ? AND send_identity = ?
        ORDER BY created_at DESC, updated_at DESC
        LIMIT 1
      `),
      listFeishuCardSessionsByThreadAndStatus: this.db.prepare(`
        SELECT *
        FROM feishu_card_sessions
        WHERE binding_id = ? AND local_thread_id = ? AND send_identity = ? AND status = ?
        ORDER BY created_at DESC, updated_at DESC
      `),
      listFeishuCardSessionsByStatus: this.db.prepare(`
        SELECT *
        FROM feishu_card_sessions
        WHERE status = ? AND send_identity = ?
        ORDER BY updated_at ASC, created_at ASC
      `),
      selectPrunableCompletedFeishuCardSessionIds: this.db.prepare(`
        SELECT session.session_id
        FROM feishu_card_sessions AS session
        WHERE session.status = 'completed'
          AND session.updated_at < @cutoff
          AND NOT (
            json_extract(session.state_json, '$.cardkit.cardId') IS NOT NULL
            AND json_extract(session.state_json, '$.cardkit.finalizedAt') IS NULL
          )
          AND (
            SELECT COUNT(*)
            FROM feishu_card_sessions AS newer
            WHERE newer.binding_id = session.binding_id
              AND newer.local_thread_id = session.local_thread_id
              AND newer.send_identity = session.send_identity
              AND newer.status = 'completed'
              AND (
                newer.updated_at > session.updated_at
                OR (
                  newer.updated_at = session.updated_at
                  AND newer.session_id > session.session_id
                )
              )
          ) >= @keep_per_thread
        ORDER BY session.updated_at ASC, session.session_id ASC
        LIMIT @batch_limit
      `),
      deleteFeishuCardSessionById: this.db.prepare(`
        DELETE FROM feishu_card_sessions WHERE session_id = ?
      `),
      upsertFeishuCardSession: this.db.prepare(`
        INSERT INTO feishu_card_sessions (
          session_id, binding_id, local_thread_id, local_turn_id, send_identity,
          feishu_open_id, feishu_chat_id, card_message_id, mode, status,
          last_revision, last_applied_revision, last_render_hash, degraded_reason,
          state_json, created_at, updated_at
        ) VALUES (
          @session_id, @binding_id, @local_thread_id, @local_turn_id, @send_identity,
          @feishu_open_id, @feishu_chat_id, @card_message_id, @mode, @status,
          @last_revision, @last_applied_revision, @last_render_hash, @degraded_reason,
          @state_json, @created_at, @updated_at
        )
        ON CONFLICT(binding_id, local_turn_id, send_identity) DO UPDATE SET
          local_thread_id = excluded.local_thread_id,
          feishu_open_id = excluded.feishu_open_id,
          feishu_chat_id = excluded.feishu_chat_id,
          card_message_id = excluded.card_message_id,
          mode = excluded.mode,
          status = excluded.status,
          last_revision = excluded.last_revision,
          last_applied_revision = excluded.last_applied_revision,
          last_render_hash = excluded.last_render_hash,
          degraded_reason = excluded.degraded_reason,
          state_json = excluded.state_json,
          updated_at = excluded.updated_at
      `),
      insertDeliveryAttempt: this.db.prepare(`
        INSERT INTO delivery_attempts (
          ledger_id, destination, status, attempt_no, error_text, created_at
        ) VALUES (
          @ledger_id, @destination, @status, @attempt_no, @error_text, @created_at
        )
      `),
      countDeliveryAttemptsByLedger: this.db.prepare(
        `SELECT COUNT(*) AS count FROM delivery_attempts WHERE ledger_id = ?`,
      ),
      selectPrunableDeliveryAttemptIds: this.db.prepare(`
        SELECT id
        FROM delivery_attempts
        WHERE status = @status
          AND created_at < @cutoff
        ORDER BY id ASC
        LIMIT @batch_limit
      `),
      deleteDeliveryAttemptById: this.db.prepare(`
        DELETE FROM delivery_attempts WHERE id = ?
      `),
      selectPrunablePendingActionIds: this.db.prepare(`
        SELECT id
        FROM pending_actions
        WHERE status = 'completed'
          AND updated_at < @cutoff
        ORDER BY id ASC
        LIMIT @batch_limit
      `),
      deletePendingActionById: this.db.prepare(`
        DELETE FROM pending_actions WHERE id = ?
      `),
      selectPrunableMessageLedgerPayloadIds: this.db.prepare(`
        SELECT id
        FROM message_ledger
        WHERE raw_json IS NOT NULL
          AND (
            (
              status IN ('delivered', 'local_committed')
              AND updated_at < @payload_cutoff
            )
            OR (
              status = 'failed'
              AND updated_at < @failed_payload_cutoff
            )
          )
        ORDER BY id ASC
        LIMIT @batch_limit
      `),
      clearMessageLedgerPayloadById: this.db.prepare(`
        UPDATE message_ledger
        SET raw_json = NULL
        WHERE id = ?
      `),
      countNonCompletedPendingActions: this.db.prepare(`
        SELECT COUNT(*) AS count
        FROM pending_actions
        WHERE status != 'completed'
      `),
      countPendingMessageLedgerRows: this.db.prepare(`
        SELECT COUNT(*) AS count
        FROM message_ledger
        WHERE status IN ('pending_feishu_delivery', 'delivery_retry', 'pending_local_commit')
      `),
      countRecentlyProcessingCardSessions: this.db.prepare(`
        SELECT COUNT(*) AS count
        FROM feishu_card_sessions
        WHERE status = 'processing'
          AND updated_at >= ?
      `),
      getRecentCommittedInboundByBindingAndText: this.db.prepare(`
        SELECT *
        FROM message_ledger
        WHERE binding_id = ?
          AND origin = 'feishu_inbound'
          AND direction = 'inbound'
          AND role = 'user'
          AND status IN ('pending_local_commit', 'local_committed')
          AND text = ?
          AND created_at >= ?
        ORDER BY id DESC
        LIMIT 1
      `),
      getInboundLedgerByBindingAndLocalTurnId: this.db.prepare(`
        SELECT *
        FROM message_ledger
        WHERE binding_id = ?
          AND origin = 'feishu_inbound'
          AND direction = 'inbound'
          AND role = 'user'
          AND status IN ('pending_local_commit', 'local_committed')
          AND local_turn_id = ?
        ORDER BY id DESC
        LIMIT 1
      `),
      getRecentCommittedInboundByBinding: this.db.prepare(`
        SELECT *
        FROM message_ledger
        WHERE binding_id = ?
          AND origin = 'feishu_inbound'
          AND direction = 'inbound'
          AND role = 'user'
          AND status IN ('pending_local_commit', 'local_committed')
          AND created_at >= ?
        ORDER BY id DESC
        LIMIT ?
      `),
      getRecentDesktopLocalOutboundByBindingAndText: this.db.prepare(`
        SELECT *
        FROM message_ledger
        WHERE binding_id = ?
          AND origin = 'desktop_local'
          AND direction = 'outbound'
          AND role = 'user'
          AND status IN ('pending_feishu_delivery', 'delivery_retry', 'delivered')
          AND text = ?
          AND (created_at >= ? OR updated_at >= ?)
        ORDER BY id DESC
        LIMIT 1
      `),
    };
  }

  close() {
    this.db.close();
  }

  getBindingByUser(feishuOpenId, feishuChatId) {
    return this.statements.getBindingByUser.get(feishuOpenId, feishuChatId) ?? null;
  }

  getBindingById(bindingId) {
    return this.statements.getBindingById.get(bindingId) ?? null;
  }

  listBindings() {
    return this.statements.listBindings.all();
  }

  upsertBinding({
    bindingId,
    feishuOpenId,
    feishuChatId,
    localThreadId,
    localConversationId,
    contextVersion,
    followCurrentThread,
  }) {
    const timestamp = nowIso();
    const existing = this.getBindingByUser(feishuOpenId, feishuChatId);
    const binding_id = bindingId ?? existing?.binding_id ?? crypto.randomUUID();
    this.statements.upsertBinding.run({
      binding_id,
      feishu_open_id: feishuOpenId,
      feishu_chat_id: feishuChatId,
      local_thread_id: localThreadId,
      local_conversation_id: localConversationId,
      context_version: contextVersion ?? 1,
      follow_current_thread: followCurrentThread ? 1 : 0,
      created_at: timestamp,
      updated_at: timestamp,
    });
    return this.getBindingByUser(feishuOpenId, feishuChatId);
  }

  getMessageLedger(provider, providerMessageId) {
    return this._parseMessageLedger(
      this.statements.getMessageLedger.get(provider, providerMessageId) ?? null,
    );
  }

  getMessageLedgerById(id) {
    return this._parseMessageLedger(
      this.statements.getMessageLedgerById.get(id) ?? null,
    );
  }

  insertMessageLedgerEntry({
    provider,
    providerMessageId,
    bindingId,
    origin,
    direction,
    role,
    text,
    rawJson = null,
    status,
    localTurnId = null,
  }) {
    const timestamp = nowIso();
    this.statements.insertMessageLedger.run({
      provider,
      provider_message_id: providerMessageId,
      binding_id: bindingId,
      origin,
      direction,
      role,
      text,
      raw_json: rawJson == null ? null : JSON.stringify(rawJson),
      status,
      local_turn_id: localTurnId,
      created_at: timestamp,
      updated_at: timestamp,
    });
    return this.getMessageLedger(provider, providerMessageId);
  }

  insertInboundLedger({ providerMessageId, bindingId, text, rawEvent, status }) {
    return this.insertMessageLedgerEntry({
      provider: "feishu",
      providerMessageId,
      bindingId,
      origin: "feishu_inbound",
      direction: "inbound",
      role: "user",
      text,
      rawJson: rawEvent ?? null,
      status,
      localTurnId: null,
    });
  }

  insertOutboundLedger({
    providerMessageId,
    bindingId,
    origin,
    role,
    text,
    rawPayload = null,
    status = "pending_feishu_delivery",
    localTurnId = null,
  }) {
    return this.insertMessageLedgerEntry({
      provider: "codex_local",
      providerMessageId,
      bindingId,
      origin,
      direction: "outbound",
      role,
      text,
      rawJson: rawPayload,
      status,
      localTurnId,
    });
  }

  updateInboundLedgerStatus(providerMessageId, status, localTurnId = null) {
    this.statements.updateMessageLedger.run({
      provider: "feishu",
      provider_message_id: providerMessageId,
      status,
      local_turn_id: localTurnId,
      updated_at: nowIso(),
    });
    return this.statements.getMessageLedger.get("feishu", providerMessageId);
  }

  getInboundLedgerByBindingAndLocalTurnId(bindingId, localTurnId) {
    const normalizedTurnId = String(localTurnId ?? "").trim();
    if (!bindingId || !normalizedTurnId) {
      return null;
    }
    return this._parseMessageLedger(
      this.statements.getInboundLedgerByBindingAndLocalTurnId.get(
        bindingId,
        normalizedTurnId,
      ) ?? null,
    );
  }

  recordPendingAction(actionType, bindingId, payload, lastError = null) {
    const timestamp = nowIso();
    const result = this.statements.insertPendingAction.run({
      action_type: actionType,
      binding_id: bindingId,
      payload_json: JSON.stringify(payload),
      status: "pending",
      attempts: 0,
      available_at: timestamp,
      last_error: lastError,
      created_at: timestamp,
      updated_at: timestamp,
    });
    return this.getPendingActionById(result.lastInsertRowid);
  }

  listPendingActions() {
    return this.statements.listPendingActions.all().map((row) => this._parsePendingAction(row));
  }

  listReadyPendingActions(availableAt = nowIso()) {
    return this.statements.listReadyPendingActions
      .all(availableAt)
      .map((row) => this._parsePendingAction(row));
  }

  getPendingActionById(id) {
    const row = this.statements.getPendingActionById.get(id);
    return this._parsePendingAction(row);
  }

  updatePendingAction(id, { bindingId, payload, status, attemptsDelta = 0, availableAt, lastError }) {
    this.statements.updatePendingAction.run({
      id,
      binding_id: bindingId ?? null,
      payload_json: payload == null ? null : JSON.stringify(payload),
      status: status ?? null,
      attempts_delta: attemptsDelta,
      available_at: availableAt ?? null,
      last_error: lastError ?? null,
      updated_at: nowIso(),
    });
    return this.getPendingActionById(id);
  }

  completePendingAction(id, payload = null) {
    return this.updatePendingAction(id, {
      payload,
      status: "completed",
      lastError: null,
    });
  }

  retryPendingAction(id, lastError, payload = null, delayMs = 0) {
    return this.updatePendingAction(id, {
      payload,
      status: "pending",
      attemptsDelta: 1,
      availableAt: new Date(Date.now() + delayMs).toISOString(),
      lastError,
    });
  }

  _deleteRowsByIds(ids, statement) {
    const normalizedIds = (Array.isArray(ids) ? ids : [])
      .map((row) => Number(row?.id ?? row))
      .filter((id) => Number.isInteger(id) && id > 0);
    if (normalizedIds.length === 0) {
      return 0;
    }
    const deleteBatch = this.db.transaction((values) => {
      for (const id of values) {
        statement.run(id);
      }
    });
    deleteBatch(normalizedIds);
    return normalizedIds.length;
  }

  _deleteRuntimeStateKeys(keys) {
    const normalizedKeys = (Array.isArray(keys) ? keys : [])
      .map((row) => String(row?.key ?? row ?? "").trim())
      .filter(Boolean);
    if (normalizedKeys.length === 0) {
      return 0;
    }
    const deleteBatch = this.db.transaction((values) => {
      for (const key of values) {
        this.statements.deleteRuntimeState.run(key);
      }
    });
    deleteBatch(normalizedKeys);
    return normalizedKeys.length;
  }

  _deleteFeishuCardSessionIds(rows) {
    const normalizedIds = (Array.isArray(rows) ? rows : [])
      .map((row) => String(row?.session_id ?? row ?? "").trim())
      .filter(Boolean);
    if (normalizedIds.length === 0) {
      return 0;
    }
    const deleteBatch = this.db.transaction((values) => {
      for (const sessionId of values) {
        this.statements.deleteFeishuCardSessionById.run(sessionId);
      }
    });
    deleteBatch(normalizedIds);
    return normalizedIds.length;
  }

  _clearMessageLedgerPayloads(ids) {
    const normalizedIds = (Array.isArray(ids) ? ids : [])
      .map((row) => Number(row?.id ?? row))
      .filter((id) => Number.isInteger(id) && id > 0);
    if (normalizedIds.length === 0) {
      return 0;
    }
    const clearBatch = this.db.transaction((values) => {
      for (const id of values) {
        this.statements.clearMessageLedgerPayloadById.run(id);
      }
    });
    clearBatch(normalizedIds);
    return normalizedIds.length;
  }

  _getDatabasePageStats() {
    const pageSize = this.db.prepare("PRAGMA page_size").get().page_size;
    const pageCount = this.db.prepare("PRAGMA page_count").get().page_count;
    const freelistCount = this.db.prepare("PRAGMA freelist_count").get().freelist_count;
    const freeBytes = pageSize * freelistCount;
    return {
      pageSize,
      pageCount,
      freelistCount,
      freeBytes,
      freeRatio: pageCount > 0 ? freelistCount / pageCount : 0,
      databaseBytes: pageSize * pageCount,
    };
  }

  _getPhysicalCompactionActiveWork(activeWindowMs) {
    const activeCutoff = new Date(
      Date.now() -
        positiveMilliseconds(
          activeWindowMs,
          DEFAULT_PHYSICAL_COMPACTION_ACTIVE_WINDOW_MS,
        ),
    ).toISOString();
    return {
      pendingActions: this.statements.countNonCompletedPendingActions.get().count,
      pendingLedgerRows: this.statements.countPendingMessageLedgerRows.get().count,
      recentlyProcessingCardSessions:
        this.statements.countRecentlyProcessingCardSessions.get(activeCutoff).count,
    };
  }

  compactDatabaseIfNeeded({
    enabled = true,
    cooldownMs = DEFAULT_PHYSICAL_COMPACTION_COOLDOWN_MS,
    minFreelistBytes = DEFAULT_PHYSICAL_COMPACTION_MIN_FREELIST_BYTES,
    minFreeRatio = DEFAULT_PHYSICAL_COMPACTION_MIN_FREE_RATIO,
    activeWindowMs = DEFAULT_PHYSICAL_COMPACTION_ACTIVE_WINDOW_MS,
  } = {}) {
    const result = {
      attempted: false,
      completed: false,
      skippedReason: null,
      before: this._getDatabasePageStats(),
      after: null,
      error: null,
    };
    if (!enabled) {
      result.skippedReason = "disabled";
      return result;
    }
    const activeWork = this._getPhysicalCompactionActiveWork(activeWindowMs);
    result.activeWork = activeWork;
    if (
      activeWork.pendingActions > 0 ||
      activeWork.pendingLedgerRows > 0 ||
      activeWork.recentlyProcessingCardSessions > 0
    ) {
      result.skippedReason = "active_work";
      return result;
    }
    const minBytes = Math.max(0, Number(minFreelistBytes) || 0);
    const minRatio = Math.max(0, Number(minFreeRatio) || 0);
    if (result.before.freeBytes < minBytes || result.before.freeRatio < minRatio) {
      result.skippedReason = "below_threshold";
      return result;
    }
    const lastCompaction = this.getRuntimeState(SQLITE_LAST_PHYSICAL_COMPACTION_KEY);
    const lastAt = Date.parse(
      String(lastCompaction?.finishedAt ?? lastCompaction?.startedAt ?? ""),
    );
    const normalizedCooldownMs = positiveMilliseconds(
      cooldownMs,
      DEFAULT_PHYSICAL_COMPACTION_COOLDOWN_MS,
    );
    if (
      lastCompaction?.completed === true &&
      Number.isFinite(lastAt) &&
      Date.now() - lastAt < normalizedCooldownMs
    ) {
      result.skippedReason = "cooldown";
      result.nextEligibleAt = new Date(lastAt + normalizedCooldownMs).toISOString();
      return result;
    }
    const startedAt = nowIso();
    result.attempted = true;
    try {
      try {
        this.db.pragma("wal_checkpoint(TRUNCATE)");
      } catch {
        // Best effort before the exclusive rewrite.
      }
      this.db.exec("VACUUM");
      this.db.pragma("journal_mode = WAL");
      try {
        this.db.pragma("wal_checkpoint(TRUNCATE)");
      } catch {
        // Best effort after the exclusive rewrite.
      }
      result.after = this._getDatabasePageStats();
      result.completed = true;
    } catch (error) {
      result.error = error instanceof Error ? error.message : String(error);
    }
    const finishedAt = nowIso();
    this.setRuntimeState(SQLITE_LAST_PHYSICAL_COMPACTION_KEY, {
      ...result,
      startedAt,
      finishedAt,
    });
    return result;
  }

  pruneDeliveryAttempts({
    deliveredMaxAgeMs = DEFAULT_DELIVERED_ATTEMPT_MAX_AGE_MS,
    failedMaxAgeMs = DEFAULT_FAILED_ATTEMPT_MAX_AGE_MS,
    batchLimit = DEFAULT_MAINTENANCE_BATCH_LIMIT,
  } = {}) {
    const limit = positiveInteger(batchLimit, DEFAULT_MAINTENANCE_BATCH_LIMIT);
    const deliveredCutoff = new Date(
      Date.now() - positiveMilliseconds(deliveredMaxAgeMs, DEFAULT_DELIVERED_ATTEMPT_MAX_AGE_MS),
    ).toISOString();
    const failedCutoff = new Date(
      Date.now() - positiveMilliseconds(failedMaxAgeMs, DEFAULT_FAILED_ATTEMPT_MAX_AGE_MS),
    ).toISOString();
    const deliveredIds = this.statements.selectPrunableDeliveryAttemptIds.all({
      status: "delivered",
      cutoff: deliveredCutoff,
      batch_limit: limit,
    });
    const failedIds = this.statements.selectPrunableDeliveryAttemptIds.all({
      status: "failed",
      cutoff: failedCutoff,
      batch_limit: limit,
    });
    return (
      this._deleteRowsByIds(deliveredIds, this.statements.deleteDeliveryAttemptById) +
      this._deleteRowsByIds(failedIds, this.statements.deleteDeliveryAttemptById)
    );
  }

  pruneCompletedPendingActions({
    maxAgeMs = DEFAULT_COMPLETED_ACTION_MAX_AGE_MS,
    batchLimit = DEFAULT_MAINTENANCE_BATCH_LIMIT,
  } = {}) {
    const cutoff = new Date(
      Date.now() - positiveMilliseconds(maxAgeMs, DEFAULT_COMPLETED_ACTION_MAX_AGE_MS),
    ).toISOString();
    const ids = this.statements.selectPrunablePendingActionIds.all({
      cutoff,
      batch_limit: positiveInteger(batchLimit, DEFAULT_MAINTENANCE_BATCH_LIMIT),
    });
    return this._deleteRowsByIds(ids, this.statements.deletePendingActionById);
  }

  pruneCompletedFeishuCardSessions({
    maxAgeMs = DEFAULT_COMPLETED_FEISHU_CARD_SESSION_MAX_AGE_MS,
    keepPerThread = DEFAULT_COMPLETED_FEISHU_CARD_SESSION_KEEP_PER_THREAD,
    batchLimit = DEFAULT_MAINTENANCE_BATCH_LIMIT,
  } = {}) {
    const cutoff = new Date(
      Date.now() -
        positiveMilliseconds(
          maxAgeMs,
          DEFAULT_COMPLETED_FEISHU_CARD_SESSION_MAX_AGE_MS,
        ),
    ).toISOString();
    const rows = this.statements.selectPrunableCompletedFeishuCardSessionIds.all({
      cutoff,
      keep_per_thread: nonNegativeInteger(
        keepPerThread,
        DEFAULT_COMPLETED_FEISHU_CARD_SESSION_KEEP_PER_THREAD,
      ),
      batch_limit: positiveInteger(batchLimit, DEFAULT_MAINTENANCE_BATCH_LIMIT),
    });
    return this._deleteFeishuCardSessionIds(rows);
  }

  pruneRuntimeTransientState({
    maxAgeMs = DEFAULT_RUNTIME_TRANSIENT_STATE_MAX_AGE_MS,
    batchLimit = DEFAULT_MAINTENANCE_BATCH_LIMIT,
  } = {}) {
    const cutoff = new Date(
      Date.now() - positiveMilliseconds(maxAgeMs, DEFAULT_RUNTIME_TRANSIENT_STATE_MAX_AGE_MS),
    ).toISOString();
    const keys = this.statements.selectPrunableRuntimeStateKeys.all({
      cutoff,
      batch_limit: positiveInteger(batchLimit, DEFAULT_MAINTENANCE_BATCH_LIMIT),
    });
    return this._deleteRuntimeStateKeys(keys);
  }

  pruneMessageLedgerPayloads({
    payloadMaxAgeMs = DEFAULT_MESSAGE_LEDGER_PAYLOAD_MAX_AGE_MS,
    failedPayloadMaxAgeMs = DEFAULT_FAILED_MESSAGE_LEDGER_PAYLOAD_MAX_AGE_MS,
    batchLimit = DEFAULT_MAINTENANCE_BATCH_LIMIT,
  } = {}) {
    const ids = this.statements.selectPrunableMessageLedgerPayloadIds.all({
      payload_cutoff: new Date(
        Date.now() - positiveMilliseconds(payloadMaxAgeMs, DEFAULT_MESSAGE_LEDGER_PAYLOAD_MAX_AGE_MS),
      ).toISOString(),
      failed_payload_cutoff: new Date(
        Date.now() -
          positiveMilliseconds(
            failedPayloadMaxAgeMs,
            DEFAULT_FAILED_MESSAGE_LEDGER_PAYLOAD_MAX_AGE_MS,
          ),
      ).toISOString(),
      batch_limit: positiveInteger(batchLimit, DEFAULT_MAINTENANCE_BATCH_LIMIT),
    });
    return this._clearMessageLedgerPayloads(ids);
  }

  pruneSqliteMaintenanceArtifacts({
    artifactMaxAgeMs = DEFAULT_SQLITE_MAINTENANCE_ARTIFACT_MAX_AGE_MS,
    keepRecent = DEFAULT_SQLITE_MAINTENANCE_ARTIFACT_KEEP_RECENT,
  } = {}) {
    const maintenanceDir = path.join(this.rootDir, "maintenance");
    const result = {
      maintenanceDir,
      deletedDirs: 0,
      deletedBytes: 0,
      keptDirs: 0,
      skippedReason: null,
      errors: [],
    };
    if (!fs.existsSync(maintenanceDir)) {
      result.skippedReason = "missing";
      return result;
    }

    let entries = [];
    try {
      entries = fs
        .readdirSync(maintenanceDir, { withFileTypes: true })
        .filter(
          (entry) =>
            entry.isDirectory() && entry.name.startsWith("bridge-sqlite-compact-"),
        )
        .map((entry) => {
          const dirPath = path.join(maintenanceDir, entry.name);
          return {
            name: entry.name,
            path: dirPath,
            mtimeMs: fs.statSync(dirPath).mtimeMs,
          };
        })
        .sort((left, right) => right.mtimeMs - left.mtimeMs);
    } catch (error) {
      result.skippedReason = "unreadable";
      result.errors.push(error instanceof Error ? error.message : String(error));
      return result;
    }

    const maxAgeMs = positiveMilliseconds(
      artifactMaxAgeMs,
      DEFAULT_SQLITE_MAINTENANCE_ARTIFACT_MAX_AGE_MS,
    );
    const normalizedKeepRecent = nonNegativeInteger(
      keepRecent,
      DEFAULT_SQLITE_MAINTENANCE_ARTIFACT_KEEP_RECENT,
    );
    const cutoffMs = Date.now() - maxAgeMs;
    const maintenanceRoot = path.resolve(maintenanceDir);
    for (const [index, entry] of entries.entries()) {
      const target = path.resolve(entry.path);
      const relativeTarget = path.relative(maintenanceRoot, target);
      const safeTarget =
        relativeTarget &&
        !relativeTarget.startsWith("..") &&
        !path.isAbsolute(relativeTarget) &&
        path.basename(target).startsWith("bridge-sqlite-compact-");
      if (!safeTarget || index < normalizedKeepRecent || entry.mtimeMs >= cutoffMs) {
        result.keptDirs += 1;
        continue;
      }

      try {
        const bytes = directorySizeBytes(target);
        fs.rmSync(target, { recursive: true, force: true, maxRetries: 2 });
        result.deletedDirs += 1;
        result.deletedBytes += bytes;
      } catch (error) {
        result.errors.push({
          path: target,
          message: error instanceof Error ? error.message : String(error),
        });
      }
    }

    return result;
  }

  runMaintenance(options = {}) {
    const result = {
      deliveryAttemptsDeleted: this.pruneDeliveryAttempts({
        deliveredMaxAgeMs: options.deliveredAttemptMaxAgeMs,
        failedMaxAgeMs: options.failedAttemptMaxAgeMs,
        batchLimit: options.batchLimit,
      }),
      completedPendingActionsDeleted: this.pruneCompletedPendingActions({
        maxAgeMs: options.completedPendingActionMaxAgeMs,
        batchLimit: options.batchLimit,
      }),
      completedFeishuCardSessionsDeleted: this.pruneCompletedFeishuCardSessions({
        maxAgeMs: options.completedFeishuCardSessionMaxAgeMs,
        keepPerThread: options.completedFeishuCardSessionKeepPerThread,
        batchLimit: options.batchLimit,
      }),
      runtimeStateDeleted: this.pruneRuntimeTransientState({
        maxAgeMs: options.runtimeTransientStateMaxAgeMs,
        batchLimit: options.batchLimit,
      }),
      messageLedgerPayloadsCleared: this.pruneMessageLedgerPayloads({
        payloadMaxAgeMs: options.messageLedgerPayloadMaxAgeMs,
        failedPayloadMaxAgeMs: options.failedMessageLedgerPayloadMaxAgeMs,
        batchLimit: options.batchLimit,
      }),
      sqliteMaintenanceArtifacts: this.pruneSqliteMaintenanceArtifacts({
        artifactMaxAgeMs: options.sqliteMaintenanceArtifactMaxAgeMs,
        keepRecent: options.sqliteMaintenanceArtifactKeepRecent,
      }),
      physicalCompaction: this.compactDatabaseIfNeeded({
        enabled: options.physicalCompactionEnabled,
        cooldownMs: options.physicalCompactionCooldownMs,
        minFreelistBytes: options.physicalCompactionMinFreelistBytes,
        minFreeRatio: options.physicalCompactionMinFreeRatio,
        activeWindowMs: options.physicalCompactionActiveWindowMs,
      }),
      optimized: false,
      checkpointed: false,
    };
    try {
      this.db.pragma("optimize");
      result.optimized = true;
    } catch {
      result.optimized = false;
    }
    try {
      this.db.pragma("wal_checkpoint(PASSIVE)");
      result.checkpointed = true;
    } catch {
      result.checkpointed = false;
    }
    return result;
  }

  getRuntimeState(key) {
    const row = this.statements.getRuntimeState.get(key);
    return row == null ? null : JSON.parse(row.value_json);
  }

  setRuntimeState(key, value) {
    this.statements.setRuntimeState.run({
      key,
      value_json: JSON.stringify(value),
      updated_at: nowIso(),
    });
  }

  deleteRuntimeState(key) {
    this.statements.deleteRuntimeState.run(key);
  }

  getFeishuCardSessionById(sessionId) {
    return this._parseFeishuCardSession(
      this.statements.getFeishuCardSessionById.get(sessionId) ?? null,
    );
  }

  getFeishuCardSessionByTurn(bindingId, localTurnId, sendIdentity = "bot") {
    const normalizedBindingId = String(bindingId ?? "").trim();
    const normalizedTurnId = String(localTurnId ?? "").trim();
    const normalizedIdentity = String(sendIdentity ?? "bot").trim() || "bot";
    if (!normalizedBindingId || !normalizedTurnId) {
      return null;
    }
    return this._parseFeishuCardSession(
      this.statements.getFeishuCardSessionByTurn.get(
        normalizedBindingId,
        normalizedTurnId,
        normalizedIdentity,
      ) ?? null,
    );
  }

  updateFeishuCardSessionCardMessageId(sessionId, cardMessageId) {
    const normalizedSessionId = String(sessionId ?? "").trim();
    if (!normalizedSessionId) {
      return null;
    }
    this.statements.updateFeishuCardSessionCardMessageId.run(
      cardMessageId ?? null,
      nowIso(),
      normalizedSessionId,
    );
    return this.getFeishuCardSessionById(normalizedSessionId);
  }

  getLatestFeishuCardSessionByThreadAndStatus(
    bindingId,
    localThreadId,
    sendIdentity = "bot",
    status = "processing",
  ) {
    const normalizedBindingId = String(bindingId ?? "").trim();
    const normalizedThreadId = String(localThreadId ?? "").trim();
    const normalizedIdentity = String(sendIdentity ?? "bot").trim() || "bot";
    const normalizedStatus = String(status ?? "processing").trim() || "processing";
    if (!normalizedBindingId || !normalizedThreadId) {
      return null;
    }
    return this._parseFeishuCardSession(
      this.statements.getLatestFeishuCardSessionByThreadAndStatus.get(
        normalizedBindingId,
        normalizedThreadId,
        normalizedIdentity,
        normalizedStatus,
      ) ?? null,
    );
  }

  getLatestFeishuCardSessionByThread(bindingId, localThreadId, sendIdentity = "bot") {
    const normalizedBindingId = String(bindingId ?? "").trim();
    const normalizedThreadId = String(localThreadId ?? "").trim();
    const normalizedIdentity = String(sendIdentity ?? "bot").trim() || "bot";
    if (!normalizedBindingId || !normalizedThreadId) {
      return null;
    }
    return this._parseFeishuCardSession(
      this.statements.getLatestFeishuCardSessionByThread.get(
        normalizedBindingId,
        normalizedThreadId,
        normalizedIdentity,
      ) ?? null,
    );
  }

  listFeishuCardSessionsByThreadAndStatus(
    bindingId,
    localThreadId,
    sendIdentity = "bot",
    status = "processing",
  ) {
    const normalizedBindingId = String(bindingId ?? "").trim();
    const normalizedThreadId = String(localThreadId ?? "").trim();
    const normalizedIdentity = String(sendIdentity ?? "bot").trim() || "bot";
    const normalizedStatus = String(status ?? "processing").trim() || "processing";
    if (!normalizedBindingId || !normalizedThreadId) {
      return [];
    }
    return this.statements.listFeishuCardSessionsByThreadAndStatus
      .all(normalizedBindingId, normalizedThreadId, normalizedIdentity, normalizedStatus)
      .map((row) => this._parseFeishuCardSession(row));
  }

  listFeishuCardSessionsByStatus(status = "processing", sendIdentity = "bot") {
    const normalizedStatus = String(status ?? "processing").trim() || "processing";
    const normalizedIdentity = String(sendIdentity ?? "bot").trim() || "bot";
    return this.statements.listFeishuCardSessionsByStatus
      .all(normalizedStatus, normalizedIdentity)
      .map((row) => this._parseFeishuCardSession(row));
  }

  upsertFeishuCardSession({
    sessionId,
    bindingId,
    localThreadId,
    localTurnId,
    sendIdentity = "bot",
    feishuOpenId,
    feishuChatId,
    cardMessageId = null,
    mode = "card",
    status = "active",
    lastRevision = 0,
    lastAppliedRevision = 0,
    lastRenderHash = null,
    degradedReason = null,
    state = {},
  }) {
    const timestamp = nowIso();
    const existing =
      this.getFeishuCardSessionByTurn(bindingId, localTurnId, sendIdentity) ??
      (sessionId ? this.getFeishuCardSessionById(sessionId) : null);
    const normalizedSessionId =
      String(sessionId ?? existing?.session_id ?? crypto.randomUUID()).trim() || crypto.randomUUID();
    const normalizedLastAppliedRevision = Math.max(
      0,
      Number(lastAppliedRevision) || 0,
      Number(existing?.last_applied_revision) || 0,
    );
    const normalizedLastRevision = Math.max(
      0,
      Number(lastRevision) || 0,
      Number(existing?.last_revision) || 0,
      normalizedLastAppliedRevision,
    );
    const mergedState = mergeCardState(existing?.state_json, state);
    const mergedStatus =
      existing?.status === "completed" && !["degraded", "interrupted"].includes(status)
        ? "completed"
        : status;
    this.statements.upsertFeishuCardSession.run({
      session_id: normalizedSessionId,
      binding_id: bindingId,
      local_thread_id: localThreadId,
      local_turn_id: localTurnId,
      send_identity: sendIdentity,
      feishu_open_id: feishuOpenId,
      feishu_chat_id: feishuChatId,
      card_message_id: cardMessageId,
      mode,
      status: mergedStatus,
      last_revision: normalizedLastRevision,
      last_applied_revision: normalizedLastAppliedRevision,
      last_render_hash: lastRenderHash,
      degraded_reason: degradedReason,
      state_json: JSON.stringify(mergedState),
      created_at: existing?.created_at ?? timestamp,
      updated_at: timestamp,
    });
    return this.getFeishuCardSessionById(normalizedSessionId);
  }

  listMessageLedgerByStatus(statuses, direction = null) {
    if (!Array.isArray(statuses) || statuses.length === 0) {
      return [];
    }
    const placeholders = statuses.map(() => "?").join(", ");
    let query = `SELECT * FROM message_ledger WHERE status IN (${placeholders})`;
    const params = [...statuses];
    if (direction != null) {
      query += ` AND direction = ?`;
      params.push(direction);
    }
    query += ` ORDER BY created_at ASC`;
    return this.db
      .prepare(query)
      .all(...params)
      .map((row) => this._parseMessageLedger(row));
  }

  updateMessageLedgerStatusById(id, status, localTurnId = null) {
    this.statements.updateMessageLedgerById.run({
      id,
      status,
      local_turn_id: localTurnId,
      updated_at: nowIso(),
    });
    return this.getMessageLedgerById(id);
  }

  updateMessageLedgerRawPayloadById(id, rawPayload = null) {
    this.statements.updateMessageLedgerRawJsonById.run({
      id,
      raw_json: rawPayload == null ? null : JSON.stringify(rawPayload),
    });
    return this.getMessageLedgerById(id);
  }

  recordDeliveryAttempt(ledgerId, destination, status, errorText = null) {
    const existingCount =
      this.statements.countDeliveryAttemptsByLedger.get(ledgerId)?.count ?? 0;
    this.statements.insertDeliveryAttempt.run({
      ledger_id: ledgerId,
      destination,
      status,
      attempt_no: existingCount + 1,
      error_text: errorText,
      created_at: nowIso(),
    });
  }

  getRecentCommittedInboundByBindingAndText(
    bindingId,
    text,
    windowMs = 15000,
  ) {
    const cutoff = new Date(Date.now() - Math.max(0, Number(windowMs) || 0)).toISOString();
    return this._parseMessageLedger(
      this.statements.getRecentCommittedInboundByBindingAndText.get(
        bindingId,
        text,
        cutoff,
      ) ?? null,
    );
  }

  getRecentCommittedInboundByBinding(bindingId, windowMs = 15000, limit = 8) {
    const cutoff = new Date(Date.now() - Math.max(0, Number(windowMs) || 0)).toISOString();
    const normalizedLimit = Math.max(1, Math.min(50, Number(limit) || 8));
    return this.statements.getRecentCommittedInboundByBinding
      .all(bindingId, cutoff, normalizedLimit)
      .map((row) => this._parseMessageLedger(row));
  }

  getRecentDesktopLocalOutboundByBindingAndText(
    bindingId,
    text,
    windowMs = 10 * 60 * 1000,
  ) {
    const cutoff = new Date(Date.now() - Math.max(0, Number(windowMs) || 0)).toISOString();
    return this._parseMessageLedger(
      this.statements.getRecentDesktopLocalOutboundByBindingAndText.get(
        bindingId,
        text,
        cutoff,
        cutoff,
      ) ?? null,
    );
  }

  _parsePendingAction(row) {
    if (row == null) {
      return null;
    }
    return {
      ...row,
      payload_json: JSON.parse(row.payload_json),
    };
  }

  _parseMessageLedger(row) {
    if (row == null) {
      return null;
    }
    return {
      ...row,
      raw_json:
        row.raw_json == null
          ? null
          : (() => {
              try {
                return JSON.parse(row.raw_json);
              } catch {
                return row.raw_json;
            }
          })(),
    };
  }

  _parseFeishuCardSession(row) {
    if (row == null) {
      return null;
    }
    return {
      ...row,
      state_json:
        row.state_json == null
          ? {}
          : (() => {
              try {
                return JSON.parse(row.state_json);
              } catch {
                return {};
              }
            })(),
    };
  }
}

module.exports = {
  BridgeStore,
};
