"use strict";

const { createHash, randomUUID } = require("node:crypto");
const { spawn } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

const {
  resolveBridgePaths,
  ensureBridgeDirectories,
  loadBridgeConfig,
} = require("./config");
const { BridgeStore } = require("./bridge-store");
const { NamedPipeJsonRpcServer } = require("./pipe-server");
const { RendererDomAdapter } = require("./renderer-dom-adapter");
const { SidecarManager } = require("./sidecar-manager");

function nowIso() {
  return new Date().toISOString();
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const INBOUND_ECHO_COMPARABLE_TTL_MS = 15000;
const INBOUND_ECHO_TURN_TTL_MS = 24 * 60 * 60 * 1000;
const CONTROLLED_RESTART_TICKET_KEY = "controlled_restart_ticket";
const CONTROLLED_RESTART_LAST_CLEARED_AUDIT_KEY =
  "controlled_restart_audit:last_cleared";
const CONTROLLED_RESTART_TAIL_ENTRY_LIMIT = 6;
const CONTROLLED_RESTART_TAIL_TEXT_HASH_CHARS = 400;
const CONTROLLED_RESTART_TAIL_MIN_MATCHES = 4;
const CONTROLLED_RESTART_TAIL_REQUIRED_LAST_WINDOW = 2;
const CONTROLLED_RESTART_TAIL_RETRY_DELAYS_MS = [800, 1500, 2500];
const CONTROLLED_RESTART_ACTIVE_THREAD_PROBE_DELAYS_MS = [600, 1200, 2000];
const CONTROLLED_RESTART_READINESS_PROBE_DELAYS_MS = [
  1200,
  2500,
  4000,
  6000,
  9000,
];
const CONTROLLED_RESTART_WARNING_TIMEOUT_MS = 12000;
const CONTROLLED_RESTART_REPORT_TIMEOUT_MS = 12000;
const CONTROLLED_RESTART_RECOVERY_DEADLINE_MS = 90000;
const CONTROLLED_RESTART_RECOVERY_LOOP_DELAYS_MS = [
  1000,
  2000,
  4000,
  7000,
  10000,
];
const NATIVE_ITEM_COMPLETION_PROBE_DELAYS_MS = [1200, 2500, 5000, 10000];
const NATIVE_ASSISTANT_SECTIONS = new Set(["progress", "tool", "final"]);
const NATIVE_TOOL_ITEM_TYPES = new Set([
  "commandExecution",
  "mcpToolCall",
  "dynamicToolCall",
  "fileChange",
  "imageGeneration",
  "collabAgentToolCall",
]);
const SQLITE_MAINTENANCE_INTERVAL_MS = 60 * 1000;
const SQLITE_MAINTENANCE_INITIAL_DELAY_MS = 5 * 1000;
const SQLITE_MAINTENANCE_BATCH_LIMIT = 5000;
const DELIVERED_ATTEMPT_MAX_AGE_MS = 5 * 60 * 1000;
const FAILED_ATTEMPT_MAX_AGE_MS = 24 * 60 * 60 * 1000;
const COMPLETED_PENDING_ACTION_MAX_AGE_MS = 5 * 60 * 1000;
const COMPLETED_FEISHU_CARD_SESSION_MAX_AGE_MS = 24 * 60 * 60 * 1000;
const COMPLETED_FEISHU_CARD_SESSION_KEEP_PER_THREAD = 50;
const RUNTIME_TRANSIENT_STATE_MAX_AGE_MS = 15 * 60 * 1000;
const MESSAGE_LEDGER_PAYLOAD_MAX_AGE_MS = 60 * 60 * 1000;
const FAILED_MESSAGE_LEDGER_PAYLOAD_MAX_AGE_MS = 24 * 60 * 60 * 1000;
const SQLITE_PHYSICAL_COMPACTION_COOLDOWN_MS = 24 * 60 * 60 * 1000;
const SQLITE_PHYSICAL_COMPACTION_MIN_FREELIST_BYTES = 32 * 1024 * 1024;
const SQLITE_PHYSICAL_COMPACTION_MIN_FREE_RATIO = 0.25;
const SQLITE_PHYSICAL_COMPACTION_ACTIVE_WINDOW_MS = 2 * 60 * 1000;
const SQLITE_MAINTENANCE_ARTIFACT_MAX_AGE_MS = 24 * 60 * 60 * 1000;
const SQLITE_MAINTENANCE_ARTIFACT_KEEP_RECENT = 1;
const CONTROLLED_RESTART_LOCKED_STATUSES = new Set([
  "prepared",
  "warning_sent",
  "restart_requested",
  "app_started",
  "bridge_healthy",
  "origin_thread_restored",
]);
const CONTROLLED_RESTART_TERMINAL_STATUSES = new Set([
  "completed",
  "failed",
  "needs_manual_recover",
]);
const CONTROLLED_RESTART_MANUAL_CLEAR_DEFAULT_STATUSES = new Set([
  "needs_manual_recover",
  "failed",
  "completed",
]);
const CONTROLLED_RESTART_STATUS_ORDER = new Map([
  ["prepared", 0],
  ["warning_sent", 1],
  ["restart_requested", 2],
  ["app_started", 3],
  ["bridge_healthy", 4],
  ["origin_thread_restored", 5],
  ["completed", 6],
  ["needs_manual_recover", 7],
  ["failed", 8],
]);
const CONTROLLED_RESTART_RESTART_SCRIPT_RELATIVE_PATH =
  "restart-codex-with-feishu-bridge.ps1";

function normalizeConversationId(value) {
  if (value == null) {
    return null;
  }
  const isLikelyConversationId = (candidate) => {
    if (candidate == null) {
      return false;
    }
    const normalized = String(candidate).trim();
    if (!normalized || /\s/.test(normalized)) {
      return false;
    }
    return (
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
        normalized,
      ) ||
      /^[0-9a-f]{24,}$/i.test(normalized) ||
      /^(?:thread|conversation|chat|conv|local)[:_-][A-Za-z0-9._:-]{8,}$/i.test(
        normalized,
      ) ||
      (/^[A-Za-z0-9][A-Za-z0-9._:-]{15,}$/.test(normalized) &&
        /\d/.test(normalized))
    );
  };
  const raw = String(value).trim();
  if (!raw) {
    return null;
  }
  const directMatch =
    raw.match(/\bcodex:\/\/threads\/([^/?#\s]+)/i) ??
    raw.match(/\/local\/([^/?#\s]+)/i) ??
    raw.match(/\/thread\/([^/?#\s]+)/i) ??
    raw.match(/[?&](?:chat|conversationId)=([^&#\s]+)/i);
  if (directMatch?.[1]) {
    const decoded = decodeURIComponent(directMatch[1]).trim() || null;
    return isLikelyConversationId(decoded) ? decoded : null;
  }
  return isLikelyConversationId(raw) ? raw : null;
}

function normalizeNativeTurnStatus(value) {
  if (value == null) {
    return null;
  }
  if (typeof value === "string") {
    return value.trim().toLowerCase() || null;
  }
  if (typeof value === "object") {
    for (const key of ["type", "status", "state", "kind"]) {
      const normalized = normalizeNativeTurnStatus(value[key]);
      if (normalized) {
        return normalized;
      }
    }
  }
  return null;
}

function normalizeComparableText(value) {
  return String(value ?? "")
    .replace(/\u00a0/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function hashComparableTextSha256(value) {
  return createHash("sha256")
    .update(String(value ?? ""), "utf8")
    .digest("hex");
}

function normalizeTurnStatusComparable(value) {
  if (value == null) {
    return null;
  }
  if (typeof value === "string") {
    const normalized = String(value).trim().toLowerCase();
    return normalized || null;
  }
  if (typeof value === "object") {
    return (
      normalizeTurnStatusComparable(value.type) ??
      normalizeTurnStatusComparable(value.status) ??
      normalizeTurnStatusComparable(value.state) ??
      null
    );
  }
  const normalized = String(value).trim().toLowerCase();
  return normalized || null;
}

function sanitizeToolSummaryLabels(labels) {
  const values = Array.isArray(labels) ? labels : [];
  const unique = [];
  for (const value of values) {
    const normalized = normalizeComparableText(value);
    if (!normalized || unique.includes(normalized)) {
      continue;
    }
    unique.push(normalized);
  }
  return unique.slice(0, 20);
}

function truncateBridgeLabel(value, maxLength = 120) {
  const normalized = normalizeComparableText(value);
  const limit = Math.max(16, Number(maxLength) || 120);
  if (!normalized || normalized.length <= limit) {
    return normalized;
  }
  return `${normalized.slice(0, limit - 3).trimEnd()}...`;
}

function createMinimalWindowAccess(electron) {
  const getAllWindows = () => {
    const BrowserWindow = electron?.BrowserWindow;
    if (!(BrowserWindow?.getAllWindows instanceof Function)) {
      return [];
    }
    return BrowserWindow.getAllWindows();
  };
  const getPreferredWindow = () => {
    const windows = getAllWindows().filter(
      (window) => window != null && !window.isDestroyed?.(),
    );
    return (
      windows.find((window) => window.isFocused?.()) ??
      windows.find((window) => window.isVisible?.()) ??
      windows[0] ??
      null
    );
  };
  return {
    start() {
      return true;
    },
    async stop() {
      return true;
    },
    getPreferredWindow,
    getPreferredWebContents() {
      return getPreferredWindow()?.webContents ?? null;
    },
  };
}

class FeishuBridgeRuntime {
  constructor({ electron, app, buildFlavor, handlerRegistry, bridgeRoot }) {
    this.electron = electron;
    this.app = app;
    this.buildFlavor = buildFlavor;
    this.handlerRegistry = handlerRegistry;
    this.bridgeRoot = bridgeRoot;
    this.paths = resolveBridgePaths();
    this.config = null;
    this.store = null;
    this.pipeServer = null;
    this.windowAccess = createMinimalWindowAccess(electron);
    this.rendererAdapter = new RendererDomAdapter({
      windowTracker: this.windowAccess,
    });
    this.sidecarManager = null;
    this.status = {
      status: "offline",
      buildFlavor,
      startedAt: null,
      lastError: null,
      configLoaded: false,
      sidecar: null,
      lastUpdatedAt: nowIso(),
    };
    this.pollTimer = null;
    this.maintenanceTimer = null;
    this.nativeBindingPollState = new Map();
    this.followActivationEmissions = new Map();
    this.nativeAssistantStreams = new Map();
    this.nativeTurnToolSummaries = new Map();
    this.nativeItemCompletionProbeTimers = new Map();
    this.rolloutEventCache = new Map();
    this.rolloutAssistantEventTimers = new Map();
    this.rolloutAssistantPollTimers = new Map();
    this.completedNativeTurns = new Set();
    this.controlledRestartRecoveryPromise = null;
    this.controlledRestartRecoveryRestartId = null;
    this.controlledRestartCancelledRestartIds = new Set();
    this.viewMessageHookInstalled = false;
    this.nativeTurnNotificationDisposer = null;
    this.pendingUserMessageBindingPoll = false;
    this.recentViewActivityAtMs = 0;
    this.recentSubmitActivityAtMs = 0;
    this.recentInboundActivityAtMs = 0;
  }

  async start() {
    ensureBridgeDirectories(this.paths);
    this.config = loadBridgeConfig(this.paths);
    this.store = new BridgeStore(this.paths.storePath);
    this.pipeServer = new NamedPipeJsonRpcServer({
      pipeName: this.paths.pipeName,
      runtime: this,
    });
    await this.pipeServer.start();
    this.sidecarManager = new SidecarManager({
      bridgeRoot: this.bridgeRoot,
      config: this.config,
      onStateChange: (sidecar) => {
        this.status.sidecar = sidecar;
        this._recomputeStatus();
      },
    });
    this.status.startedAt = nowIso();
    this.status.configLoaded = true;
    if (this.config.enabled) {
      await this.sidecarManager.start();
    }
    this._installViewMessageActivityHook();
    this._refreshNativeTurnNotificationHook();
    const pollIntervalMs = Math.max(
      2000,
      Number(this.config?.runtime?.pollIntervalMs ?? 2000),
    );
    this.pollTimer = setInterval(
      () => this._pollBindings().catch((error) => this._recordError(error)),
      pollIntervalMs,
    );
    this.pollTimer.unref?.();
    this._startStoreMaintenance();
    this._recomputeStatus();
    this._scheduleControlledRestartRecovery();
  }

  async stop() {
    if (this.pollTimer != null) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
    if (this.maintenanceTimer != null) {
      clearTimeout(this.maintenanceTimer);
      this.maintenanceTimer = null;
    }
    if (this.rolloutAssistantEventTimers instanceof Map) {
      for (const timer of this.rolloutAssistantEventTimers.values()) {
        clearTimeout(timer);
      }
      this.rolloutAssistantEventTimers.clear();
    }
    if (this.rolloutAssistantPollTimers instanceof Map) {
      for (const timer of this.rolloutAssistantPollTimers.values()) {
        clearTimeout(timer);
      }
      this.rolloutAssistantPollTimers.clear();
    }
    if (this.nativeItemCompletionProbeTimers instanceof Map) {
      for (const timer of this.nativeItemCompletionProbeTimers.values()) {
        clearTimeout(timer);
      }
      this.nativeItemCompletionProbeTimers.clear();
    }
    this._uninstallNativeTurnNotificationHook();
    await this.sidecarManager?.stop();
    await this.pipeServer?.close();
    await this.windowAccess?.stop?.();
    this.store?.close();
  }

  _startStoreMaintenance() {
    if (this.maintenanceTimer != null) {
      clearTimeout(this.maintenanceTimer);
    }
    const intervalMs = Math.max(
      60_000,
      Number(this.config?.runtime?.sqliteMaintenanceIntervalMs) ||
        SQLITE_MAINTENANCE_INTERVAL_MS,
    );
    const runOnce = () => {
      this.maintenanceTimer = null;
      this._runStoreMaintenance();
      this.maintenanceTimer = setTimeout(runOnce, intervalMs);
      this.maintenanceTimer.unref?.();
    };
    const initialDelayMs = Math.max(
      5_000,
      Number(
        this.config?.runtime?.sqliteMaintenanceInitialDelayMs,
      ) || SQLITE_MAINTENANCE_INITIAL_DELAY_MS,
    );
    this.maintenanceTimer = setTimeout(runOnce, initialDelayMs);
    this.maintenanceTimer.unref?.();
  }

  _runStoreMaintenance() {
    try {
      const result = this.store?.runMaintenance?.({
        batchLimit: Math.max(
          50,
          Number(this.config?.runtime?.sqliteMaintenanceBatchLimit) ||
            SQLITE_MAINTENANCE_BATCH_LIMIT,
        ),
        deliveredAttemptMaxAgeMs: this._getRuntimeWindowMs(
          "deliveredAttemptMaxAgeMs",
          DELIVERED_ATTEMPT_MAX_AGE_MS,
          60_000,
        ),
        failedAttemptMaxAgeMs: this._getRuntimeWindowMs(
          "failedAttemptMaxAgeMs",
          FAILED_ATTEMPT_MAX_AGE_MS,
          60_000,
        ),
        completedPendingActionMaxAgeMs: this._getRuntimeWindowMs(
          "completedPendingActionMaxAgeMs",
          COMPLETED_PENDING_ACTION_MAX_AGE_MS,
          60_000,
        ),
        completedFeishuCardSessionMaxAgeMs: this._getRuntimeWindowMs(
          "completedFeishuCardSessionMaxAgeMs",
          COMPLETED_FEISHU_CARD_SESSION_MAX_AGE_MS,
          60 * 60 * 1000,
        ),
        completedFeishuCardSessionKeepPerThread: Math.max(
          0,
          Number.isFinite(
            Number(this.config?.runtime?.completedFeishuCardSessionKeepPerThread),
          )
            ? Math.floor(
                Number(this.config?.runtime?.completedFeishuCardSessionKeepPerThread),
              )
            : COMPLETED_FEISHU_CARD_SESSION_KEEP_PER_THREAD,
        ),
        runtimeTransientStateMaxAgeMs: this._getRuntimeWindowMs(
          "runtimeTransientStateMaxAgeMs",
          RUNTIME_TRANSIENT_STATE_MAX_AGE_MS,
          60_000,
        ),
        messageLedgerPayloadMaxAgeMs: this._getRuntimeWindowMs(
          "messageLedgerPayloadMaxAgeMs",
          MESSAGE_LEDGER_PAYLOAD_MAX_AGE_MS,
          60_000,
        ),
        failedMessageLedgerPayloadMaxAgeMs: this._getRuntimeWindowMs(
          "failedMessageLedgerPayloadMaxAgeMs",
          FAILED_MESSAGE_LEDGER_PAYLOAD_MAX_AGE_MS,
          60_000,
        ),
        sqliteMaintenanceArtifactMaxAgeMs: this._getRuntimeWindowMs(
          "sqliteMaintenanceArtifactMaxAgeMs",
          SQLITE_MAINTENANCE_ARTIFACT_MAX_AGE_MS,
          60_000,
        ),
        sqliteMaintenanceArtifactKeepRecent: Math.max(
          0,
          Number.isFinite(
            Number(this.config?.runtime?.sqliteMaintenanceArtifactKeepRecent),
          )
            ? Number(this.config?.runtime?.sqliteMaintenanceArtifactKeepRecent)
            : SQLITE_MAINTENANCE_ARTIFACT_KEEP_RECENT,
        ),
        physicalCompactionEnabled:
          this.config?.runtime?.sqlitePhysicalCompactionEnabled !== false,
        physicalCompactionCooldownMs: this._getRuntimeWindowMs(
          "sqlitePhysicalCompactionCooldownMs",
          SQLITE_PHYSICAL_COMPACTION_COOLDOWN_MS,
          60_000,
        ),
        physicalCompactionMinFreelistBytes: Math.max(
          1024 * 1024,
          Number(this.config?.runtime?.sqlitePhysicalCompactionMinFreelistBytes) ||
            SQLITE_PHYSICAL_COMPACTION_MIN_FREELIST_BYTES,
        ),
        physicalCompactionMinFreeRatio: Math.max(
          0,
          Number(this.config?.runtime?.sqlitePhysicalCompactionMinFreeRatio) ||
            SQLITE_PHYSICAL_COMPACTION_MIN_FREE_RATIO,
        ),
        physicalCompactionActiveWindowMs: this._getRuntimeWindowMs(
          "sqlitePhysicalCompactionActiveWindowMs",
          SQLITE_PHYSICAL_COMPACTION_ACTIVE_WINDOW_MS,
          30_000,
        ),
      });
      if (result != null) {
        this.store?.setRuntimeState?.("sqlite_maintenance:last_result", {
          ...result,
          ranAt: nowIso(),
        });
        this.store?.deleteRuntimeState?.("sqlite_maintenance:last_error");
      }
    } catch (error) {
      this.store?.setRuntimeState?.("sqlite_maintenance:last_error", {
        message: error instanceof Error ? error.message : String(error),
        ranAt: nowIso(),
      });
    }
  }

  _normalizeControlledRestartTicket(ticket) {
    if (ticket == null || typeof ticket !== "object") {
      return null;
    }
    const normalizedStatus = String(ticket.status ?? "").trim().toLowerCase();
    const normalizedBindingId = String(ticket.originBindingId ?? "").trim() || null;
    const normalizedThreadId =
      normalizeConversationId(ticket.originLocalThreadId) ??
      normalizeConversationId(ticket.originLocalConversationId) ??
      null;
    const normalizeTimestamp = (value) => {
      const normalized = String(value ?? "").trim();
      return normalized || null;
    };
    const normalizeText = (value) => {
      const normalized = String(value ?? "").trim();
      return normalized || null;
    };
    const resumeAttempts = Math.max(0, Number(ticket.resumeAttempts ?? 0) || 0);
    const normalizedSignature =
      ticket.preRestartTailSignature != null &&
      typeof ticket.preRestartTailSignature === "object"
        ? {
            threadId:
              normalizeConversationId(ticket.preRestartTailSignature.threadId) ?? null,
            entryCount:
              Number(ticket.preRestartTailSignature.entryCount ?? 0) || 0,
            entries: Array.isArray(ticket.preRestartTailSignature.entries)
              ? ticket.preRestartTailSignature.entries
                  .map((entry) => ({
                    role: normalizeText(entry?.role) ?? "unknown",
                    turnId: normalizeText(entry?.turnId),
                    itemIndex:
                      entry?.itemIndex == null
                        ? null
                        : Number(entry.itemIndex ?? 0),
                    textHash: normalizeText(entry?.textHash),
                  }))
                  .filter((entry) => entry.textHash != null)
              : [],
          }
        : null;
    const normalized = {
      restartId: normalizeText(ticket.restartId),
      reason: normalizeText(ticket.reason),
      status: normalizedStatus || null,
      createdAt: normalizeTimestamp(ticket.createdAt),
      warningSentAt: normalizeTimestamp(ticket.warningSentAt),
      restartRequestedAt: normalizeTimestamp(ticket.restartRequestedAt),
      appStartedAt: normalizeTimestamp(ticket.appStartedAt),
      bridgeHealthyAt: normalizeTimestamp(ticket.bridgeHealthyAt),
      originBindingId: normalizedBindingId,
      originLocalThreadId: normalizedThreadId,
      originFeishuOpenId: normalizeText(ticket.originFeishuOpenId),
      originFeishuChatId: normalizeText(ticket.originFeishuChatId),
      preRestartTailSignature: normalizedSignature,
      resumeAttempts,
      lastError: normalizeText(ticket.lastError),
      reportLastError: normalizeText(ticket.reportLastError),
      reportDeliveredAt: normalizeTimestamp(ticket.reportDeliveredAt),
      completedAt: normalizeTimestamp(ticket.completedAt),
      updatedAt: normalizeTimestamp(ticket.updatedAt) ?? nowIso(),
    };
    if (!normalized.restartId || !normalized.status || !normalized.originBindingId) {
      return null;
    }
    return normalized;
  }

  _getControlledRestartTicket() {
    return this._normalizeControlledRestartTicket(
      this.store?.getRuntimeState?.(CONTROLLED_RESTART_TICKET_KEY) ?? null,
    );
  }

  _setControlledRestartTicket(ticket) {
    const normalized = this._normalizeControlledRestartTicket(ticket);
    if (normalized == null) {
      throw new Error("controlled_restart_ticket_invalid");
    }
    this.store?.setRuntimeState?.(CONTROLLED_RESTART_TICKET_KEY, normalized);
    this._publishSharedState?.();
    return normalized;
  }

  _clearControlledRestartTicket() {
    this.store?.deleteRuntimeState?.(CONTROLLED_RESTART_TICKET_KEY);
    this._publishSharedState?.();
  }

  _buildControlledRestartWarningText(restartId) {
    const shortRestartId = String(restartId ?? "").trim().slice(0, 8) || "unknown";
    return `\u26a0\ufe0f \u6b63\u5728\u6267\u884c\u53d7\u63a7\u91cd\u542f [restartId: ${shortRestartId}]\uff0c\u9884\u8ba1\u77ed\u6682\u4e2d\u65ad\uff1b\u91cd\u542f\u540e\u4f1a\u56de\u5230\u5f53\u524d\u5bf9\u8bdd\u7ee7\u7eed\u6c47\u62a5\u3002`;
  }

  _buildControlledRestartWarningProviderMessageId(restartId) {
    const normalizedRestartId = String(restartId ?? "").trim();
    if (!normalizedRestartId) {
      throw new Error("controlled_restart_restart_id_missing");
    }
    return `controlled_restart_warning:${normalizedRestartId}`;
  }

  _buildControlledRestartRecoveredText(restartId) {
    const shortRestartId = String(restartId ?? "").trim().slice(0, 8) || "unknown";
    return `\u2705 \u53d7\u63a7\u91cd\u542f\u5df2\u6062\u590d [restartId: ${shortRestartId}]\uff0c\u5df2\u56de\u5230\u539f\u4f1a\u8bdd\u3002`;
  }

  _buildControlledRestartReportProviderMessageId(restartId) {
    const normalizedRestartId = String(restartId ?? "").trim();
    if (!normalizedRestartId) {
      throw new Error("controlled_restart_restart_id_missing");
    }
    return `controlled_restart_report:${normalizedRestartId}`;
  }

  _getControlledRestartScriptPath() {
    const root = this.bridgeRoot ?? __dirname;
    return path.join(root, CONTROLLED_RESTART_RESTART_SCRIPT_RELATIVE_PATH);
  }

  _resolveControlledRestartBinding({ bindingId = null } = {}) {
    const normalizedBindingId = String(bindingId ?? "").trim() || null;
    if (normalizedBindingId) {
      return this.store?.getBindingById?.(normalizedBindingId) ?? null;
    }
    const bindings = this.store?.listBindings?.() ?? [];
    if (Array.isArray(bindings) && bindings.length === 1) {
      return bindings[0] ?? null;
    }
    return null;
  }

  async _waitForControlledRestartWarningDelivery(
    providerMessageId,
    {
      timeoutMs = CONTROLLED_RESTART_WARNING_TIMEOUT_MS,
      pollIntervalMs = 400,
    } = {},
  ) {
    const normalizedProviderMessageId = String(providerMessageId ?? "").trim();
    if (!normalizedProviderMessageId) {
      throw new Error("controlled_restart_warning_message_id_missing");
    }
    const deadline = Date.now() + Math.max(1000, Number(timeoutMs ?? 0) || 0);
    while (Date.now() <= deadline) {
      const ledger =
        this.store?.getMessageLedger?.("codex_local", normalizedProviderMessageId) ??
        null;
      const status = String(ledger?.status ?? "").trim().toLowerCase();
      if (status === "delivered") {
        return { ok: true, ledger };
      }
      if (status === "failed") {
        return { ok: false, reason: "warning_delivery_failed", ledger };
      }
      await sleep(Math.max(150, Number(pollIntervalMs ?? 0) || 150));
    }
    const ledger =
      this.store?.getMessageLedger?.("codex_local", normalizedProviderMessageId) ??
      null;
    return { ok: false, reason: "warning_delivery_timeout", ledger };
  }

  async _sendControlledRestartWarningToFeishu(
    binding,
    {
      restartId,
      text,
      warningTimeoutMs = CONTROLLED_RESTART_WARNING_TIMEOUT_MS,
    } = {},
  ) {
    const normalizedText = String(text ?? "").trim();
    if (binding == null) {
      throw new Error("controlled_restart_binding_unavailable");
    }
    if (!normalizedText) {
      throw new Error("controlled_restart_warning_text_missing");
    }
    const providerMessageId =
      this._buildControlledRestartWarningProviderMessageId(restartId);
    if (this.store?.getMessageLedger?.("codex_local", providerMessageId) == null) {
      this.store?.insertOutboundLedger?.({
        providerMessageId,
        bindingId: binding.binding_id,
        origin: "controlled_restart",
        role: "assistant",
        text: normalizedText,
        rawPayload: {
          feishuOpenId: binding.feishu_open_id ?? null,
          feishuChatId: binding.feishu_chat_id ?? null,
          eventType: "controlled_restart_warning",
          generatedAt: nowIso(),
          restartId: String(restartId ?? "").trim() || null,
          localThreadId: binding.local_thread_id ?? null,
          localConversationId: binding.local_conversation_id ?? null,
        },
        status: "pending_feishu_delivery",
        localTurnId: null,
      });
    }
    const delivery = await this._waitForControlledRestartWarningDelivery(
      providerMessageId,
      { timeoutMs: warningTimeoutMs },
    );
    if (!delivery.ok) {
      if (delivery.ledger?.id != null && delivery.ledger?.status !== "delivered") {
        this.store?.updateMessageLedgerStatusById?.(delivery.ledger.id, "failed");
      }
      throw new Error(String(delivery.reason ?? "warning_delivery_failed"));
    }
    return {
      ok: true,
      providerMessageId,
      ledger: delivery.ledger ?? null,
    };
  }

  async _sendControlledRestartReportToFeishu(
    binding,
    {
      restartId,
      text,
      reportTimeoutMs = CONTROLLED_RESTART_REPORT_TIMEOUT_MS,
    } = {},
  ) {
    const normalizedText = String(text ?? "").trim();
    if (binding == null) {
      throw new Error("controlled_restart_binding_unavailable");
    }
    if (!normalizedText) {
      throw new Error("controlled_restart_report_text_missing");
    }
    const providerMessageId =
      this._buildControlledRestartReportProviderMessageId(restartId);
    if (this.store?.getMessageLedger?.("codex_local", providerMessageId) == null) {
      this.store?.insertOutboundLedger?.({
        providerMessageId,
        bindingId: binding.binding_id,
        origin: "controlled_restart",
        role: "assistant",
        text: normalizedText,
        rawPayload: {
          feishuOpenId: binding.feishu_open_id ?? null,
          feishuChatId: binding.feishu_chat_id ?? null,
          eventType: "controlled_restart_report",
          generatedAt: nowIso(),
          restartId: String(restartId ?? "").trim() || null,
          localThreadId: binding.local_thread_id ?? null,
          localConversationId: binding.local_conversation_id ?? null,
        },
        status: "pending_feishu_delivery",
        localTurnId: null,
      });
    }
    const delivery = await this._waitForControlledRestartWarningDelivery(
      providerMessageId,
      { timeoutMs: reportTimeoutMs },
    );
    if (!delivery.ok) {
      if (delivery.ledger?.id != null && delivery.ledger?.status !== "delivered") {
        this.store?.updateMessageLedgerStatusById?.(delivery.ledger.id, "failed");
      }
      throw new Error(String(delivery.reason ?? "report_delivery_failed"));
    }
    return {
      ok: true,
      providerMessageId,
      ledger: delivery.ledger ?? null,
    };
  }

  async _launchControlledRestartScript({
    gracePeriodSeconds = 5,
    shutdownTimeoutSeconds = 15,
  } = {}) {
    const scriptPath = this._getControlledRestartScriptPath();
    if (!fs.existsSync(scriptPath)) {
      throw new Error(`controlled_restart_script_missing:${scriptPath}`);
    }
    const normalizedGracePeriodSeconds = String(
      Math.max(0, Number(gracePeriodSeconds ?? 5) || 0),
    );
    const normalizedShutdownTimeoutSeconds = String(
      Math.max(1, Number(shutdownTimeoutSeconds ?? 15) || 1),
    );
    const escapedScriptPath = String(scriptPath).replace(/'/g, "''");
    const helperScript = [
      "$ErrorActionPreference = 'Stop'",
      "$arguments = @(",
      "  '-NoProfile',",
      "  '-ExecutionPolicy',",
      "  'Bypass',",
      "  '-File',",
      `  '${escapedScriptPath}',`,
      "  '-GracePeriodSeconds',",
      `  '${normalizedGracePeriodSeconds}',`,
      "  '-ShutdownTimeoutSeconds',",
      `  '${normalizedShutdownTimeoutSeconds}'`,
      ")",
      `$process = Start-Process -WindowStyle Hidden -WorkingDirectory '${path
        .dirname(scriptPath)
        .replace(/'/g, "''")}' -FilePath 'powershell.exe' -ArgumentList $arguments -PassThru`,
      "Write-Output $process.Id",
    ].join("\n");
    const encodedHelperScript = Buffer.from(helperScript, "utf16le").toString(
      "base64",
    );
    const child = spawn(
      "powershell.exe",
      [
        "-NoProfile",
        "-ExecutionPolicy",
        "Bypass",
        "-EncodedCommand",
        encodedHelperScript,
      ],
      {
        windowsHide: true,
        detached: false,
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (chunk) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr?.on("data", (chunk) => {
      stderr += chunk.toString("utf8");
    });
    await new Promise((resolve, reject) => {
      child.once("error", (error) => {
        reject(error);
      });
      child.once("close", (code) => {
        if (Number(code ?? 0) !== 0) {
          const output = [stderr.trim(), stdout.trim()].filter(Boolean).join(" | ");
          reject(
            new Error(
              `controlled_restart_helper_failed:${code}${output ? `:${output}` : ""}`,
            ),
          );
          return;
        }
        resolve();
      });
    });
    const launchedPid = Number.parseInt(String(stdout).trim(), 10);
    return {
      ok: true,
      scriptPath,
      pid: Number.isFinite(launchedPid) ? launchedPid : null,
    };
  }

  async debugStartControlledRestart({
    bindingId = null,
    reason = "manual_restart",
    gracePeriodSeconds = 5,
    shutdownTimeoutSeconds = 15,
    warningTimeoutMs = CONTROLLED_RESTART_WARNING_TIMEOUT_MS,
  } = {}) {
    const existingTicket = this._getControlledRestartTicket();
    if (
      existingTicket != null &&
      !this._isControlledRestartTerminalStatus(existingTicket.status)
    ) {
      return {
        ok: false,
        started: false,
        error: "controlled_restart_already_active",
        restartId: existingTicket.restartId,
        status: existingTicket.status,
      };
    }
    const binding = this._resolveControlledRestartBinding({ bindingId });
    if (binding == null) {
      return {
        ok: false,
        started: false,
        error: "controlled_restart_binding_unresolved",
      };
    }
    const originThreadId =
      normalizeConversationId(binding.local_thread_id) ??
      normalizeConversationId(binding.local_conversation_id) ??
      null;
    if (originThreadId == null) {
      return {
        ok: false,
        started: false,
        error: "controlled_restart_origin_thread_unavailable",
      };
    }
    const restartId = randomUUID();
    const tailCapture = await this._captureControlledRestartTailSignature({
      binding,
      originThreadId,
    });
    const preRestartTailSignature = tailCapture?.ok
      ? tailCapture.actualSignature
      : null;
    if (
      preRestartTailSignature == null ||
      !Array.isArray(preRestartTailSignature.entries) ||
      preRestartTailSignature.entries.length === 0
    ) {
      return {
        ok: false,
        started: false,
        error: tailCapture?.reason ?? "controlled_restart_tail_signature_unavailable",
        restartId,
        bindingId: binding.binding_id,
      };
    }
    const preparedTicket = this._setControlledRestartTicket({
      restartId,
      reason: String(reason ?? "").trim() || "manual_restart",
      status: "prepared",
      createdAt: nowIso(),
      restartRequestedAt: null,
      originBindingId: binding.binding_id,
      originLocalThreadId: originThreadId,
      originFeishuOpenId: String(binding.feishu_open_id ?? "").trim() || null,
      originFeishuChatId: String(binding.feishu_chat_id ?? "").trim() || null,
      preRestartTailSignature,
      resumeAttempts: 0,
      lastError: null,
      completedAt: null,
      reportDeliveredAt: null,
      phase1Minimal: true,
    });
    try {
      const warning = await this._sendControlledRestartWarningToFeishu(binding, {
        restartId,
        text: this._buildControlledRestartWarningText(restartId),
        warningTimeoutMs,
      });
      const warnedTicket = this._setControlledRestartTicket({
        ...preparedTicket,
        status: "warning_sent",
        warningSentAt: nowIso(),
        updatedAt: nowIso(),
      });
      const launchResult = await this._launchControlledRestartScript({
        gracePeriodSeconds,
        shutdownTimeoutSeconds,
      });
      const restartTicket = this._setControlledRestartTicket({
        ...warnedTicket,
        status: "restart_requested",
        restartRequestedAt: nowIso(),
        lastError: null,
        updatedAt: nowIso(),
      });
      return {
        ok: true,
        started: true,
        restartId,
        displayRestartId: restartId.slice(0, 8),
        bindingId: binding.binding_id,
        providerMessageId: warning.providerMessageId,
        warningLedgerId: warning.ledger?.id ?? null,
        scriptPath: launchResult.scriptPath,
        pid: launchResult.pid ?? null,
        ticket: restartTicket,
      };
    } catch (error) {
      const failedTicket = this._setControlledRestartTicket({
        ...preparedTicket,
        status: "failed",
        lastError: error instanceof Error ? error.message : String(error),
        completedAt: nowIso(),
        updatedAt: nowIso(),
      });
      return {
        ok: false,
        started: false,
        error: failedTicket.lastError,
        restartId,
        bindingId: binding.binding_id,
        ticket: failedTicket,
      };
    }
  }

  _buildControlledRestartTailSignature(
    snapshot,
    { limit = CONTROLLED_RESTART_TAIL_ENTRY_LIMIT } = {},
  ) {
    const normalizedLimit = Math.max(
      1,
      Number(limit ?? CONTROLLED_RESTART_TAIL_ENTRY_LIMIT) || 1,
    );
    const comparable = this._buildControlledRestartComparableSequence(snapshot);
    const entries = this._selectControlledRestartStableAnchorEntries(
      comparable.entries,
      { limit: normalizedLimit },
    ).map(({ role, turnId, itemIndex, textHash }) => ({
      role,
      turnId,
      itemIndex,
      textHash,
    }));
    return {
      threadId: comparable.threadId,
      entryCount: entries.length,
      entries,
    };
  }

  _buildControlledRestartComparableSequence(snapshot) {
    const threadId =
      normalizeConversationId(snapshot?.localThreadId) ??
      normalizeConversationId(snapshot?.localConversationId) ??
      null;
    const messages = Array.isArray(snapshot?.visibleMessages)
      ? snapshot.visibleMessages
      : [];
    const entries = messages
      .map((message, index) => {
        const normalizedText = normalizeComparableText(message?.text).slice(
          0,
          CONTROLLED_RESTART_TAIL_TEXT_HASH_CHARS,
        );
        const textHash = hashComparableTextSha256(normalizedText);
        if (!textHash) {
          return null;
        }
        return {
          role: String(message?.role ?? "").trim() || "unknown",
          turnId: String(message?.turnId ?? "").trim() || null,
          itemIndex:
            message?.itemIndex == null ? index : Number(message.itemIndex ?? 0),
          textHash,
          turnStatus: normalizeTurnStatusComparable(message?.turnStatus),
        };
      })
      .filter(Boolean);
    return { threadId, entryCount: entries.length, entries };
  }

  _selectControlledRestartStableAnchorEntries(
    entries,
    { limit = CONTROLLED_RESTART_TAIL_ENTRY_LIMIT } = {},
  ) {
    const normalizedEntries = Array.isArray(entries) ? entries.filter(Boolean) : [];
    const normalizedLimit = Math.max(
      1,
      Number(limit ?? CONTROLLED_RESTART_TAIL_ENTRY_LIMIT) || 1,
    );
    const unstableTailTurnIds = new Set();
    for (let index = normalizedEntries.length - 1; index >= 0; index -= 1) {
      const entry = normalizedEntries[index];
      if (entry?.turnStatus === "completed") {
        break;
      }
      const normalizedTurnId = String(entry?.turnId ?? "").trim() || null;
      if (normalizedTurnId != null) {
        unstableTailTurnIds.add(normalizedTurnId);
      }
    }
    const stableEntries = normalizedEntries.filter((entry) => {
      const normalizedTurnId = String(entry?.turnId ?? "").trim() || null;
      return normalizedTurnId == null || !unstableTailTurnIds.has(normalizedTurnId);
    });
    const sourceEntries = stableEntries.length > 0 ? stableEntries : normalizedEntries;
    return sourceEntries.slice(-normalizedLimit);
  }

  _compareControlledRestartTailSignatures(
    expected,
    actual,
    {
      minimumMatches = CONTROLLED_RESTART_TAIL_MIN_MATCHES,
      requiredLastWindow = CONTROLLED_RESTART_TAIL_REQUIRED_LAST_WINDOW,
    } = {},
  ) {
    const normalizedExpected =
      expected != null && typeof expected === "object" ? expected : null;
    const normalizedActual =
      actual != null && typeof actual === "object" ? actual : null;
    if (normalizedExpected == null || normalizedActual == null) {
      return {
        ok: false,
        reason: "signature_missing",
        matchedCount: 0,
        requiredMatches: Math.max(1, Number(minimumMatches ?? 1) || 1),
        lastWindowMatched: false,
      };
    }
    if (
      normalizeConversationId(normalizedExpected.threadId) != null &&
      normalizeConversationId(normalizedExpected.threadId) !==
        normalizeConversationId(normalizedActual.threadId)
    ) {
      return {
        ok: false,
        reason: "thread_mismatch",
        matchedCount: 0,
        requiredMatches: Math.max(1, Number(minimumMatches ?? 1) || 1),
        lastWindowMatched: false,
      };
    }
    const expectedEntries = Array.isArray(normalizedExpected.entries)
      ? normalizedExpected.entries
      : [];
    const actualEntries = Array.isArray(normalizedActual.entries)
      ? normalizedActual.entries
      : [];
    let matchedCount = 0;
    const matchedExpectedIndexes = [];
    let actualSearchIndex = 0;
    for (
      let expectedIndex = 0;
      expectedIndex < expectedEntries.length;
      expectedIndex += 1
    ) {
      const expectedEntry = expectedEntries[expectedIndex];
      let matchedActualIndex = -1;
      for (
        let actualIndex = actualSearchIndex;
        actualIndex < actualEntries.length;
        actualIndex += 1
      ) {
        const actualEntry = actualEntries[actualIndex];
        if (
          expectedEntry?.role === actualEntry?.role &&
          String(expectedEntry?.turnId ?? "") === String(actualEntry?.turnId ?? "") &&
          Number(expectedEntry?.itemIndex ?? 0) ===
            Number(actualEntry?.itemIndex ?? 0) &&
          expectedEntry?.textHash === actualEntry?.textHash
        ) {
          matchedActualIndex = actualIndex;
          break;
        }
      }
      if (matchedActualIndex !== -1) {
        matchedCount += 1;
        matchedExpectedIndexes.push(expectedIndex);
        actualSearchIndex = matchedActualIndex + 1;
      }
    }
    const normalizedLastWindow = Math.max(
      1,
      Math.min(Number(requiredLastWindow ?? 1) || 1, expectedEntries.length),
    );
    const lastWindowFloor = Math.max(0, expectedEntries.length - normalizedLastWindow);
    const lastWindowMatched = matchedExpectedIndexes.some(
      (expectedIndex) => expectedIndex >= lastWindowFloor,
    );
    const requiredMatches = Math.max(1, expectedEntries.length);
    return {
      ok: matchedCount >= requiredMatches && lastWindowMatched,
      reason:
        matchedCount >= requiredMatches && lastWindowMatched
          ? "matched"
          : "insufficient_overlap",
      matchedCount,
      requiredMatches,
      lastWindowMatched,
      retryDelaysMs: [...CONTROLLED_RESTART_TAIL_RETRY_DELAYS_MS],
    };
  }

  _getBindingResumeLockState(bindingId) {
    const normalizedBindingId = String(bindingId ?? "").trim();
    if (!normalizedBindingId) {
      return null;
    }
    const ticket = this._getControlledRestartTicket();
    if (
      ticket == null ||
      ticket.originBindingId !== normalizedBindingId ||
      !CONTROLLED_RESTART_LOCKED_STATUSES.has(
        String(ticket.status ?? "").trim().toLowerCase(),
      )
    ) {
      return null;
    }
    return {
      restartId: ticket.restartId,
      status: ticket.status,
      originBindingId: ticket.originBindingId,
      originLocalThreadId: ticket.originLocalThreadId,
      preRestartTailSignature: ticket.preRestartTailSignature ?? null,
      resumeAttempts: ticket.resumeAttempts ?? 0,
    };
  }

  _isBindingResumeLocked(bindingId) {
    return this._getBindingResumeLockState(bindingId) != null;
  }

  _isBindingResumeRebindLocked(bindingId) {
    return this._isBindingResumeLocked(bindingId);
  }

  _isBindingResumeHistoryEmissionLocked(bindingId) {
    return this._isBindingResumeLocked(bindingId);
  }

  _buildControlledRestartSharedState() {
    const ticket = this._getControlledRestartTicket();
    if (ticket == null) {
      return null;
    }
    return {
      restartId: ticket.restartId,
      status: ticket.status,
      originBindingId: ticket.originBindingId,
      originLocalThreadId: ticket.originLocalThreadId,
      resumeAttempts: ticket.resumeAttempts ?? 0,
      hasTailSignature:
        ticket.preRestartTailSignature != null &&
        Array.isArray(ticket.preRestartTailSignature.entries) &&
        ticket.preRestartTailSignature.entries.length > 0,
    };
  }

  _buildControlledRestartClearedAuditSnapshot(ticket) {
    const normalizedTicket = this._normalizeControlledRestartTicket(ticket);
    if (normalizedTicket == null) {
      return null;
    }
    return {
      restartId: normalizedTicket.restartId,
      status: normalizedTicket.status,
      originBindingId: normalizedTicket.originBindingId,
      originLocalThreadId: normalizedTicket.originLocalThreadId,
      resumeAttempts: Number(normalizedTicket.resumeAttempts ?? 0),
      lastError: normalizedTicket.lastError ?? null,
      reportLastError: normalizedTicket.reportLastError ?? null,
      updatedAt: normalizedTicket.updatedAt ?? null,
      completedAt: normalizedTicket.completedAt ?? null,
      hasTailSignature:
        normalizedTicket.preRestartTailSignature != null &&
        Array.isArray(normalizedTicket.preRestartTailSignature.entries) &&
        normalizedTicket.preRestartTailSignature.entries.length > 0,
    };
  }

  _isControlledRestartTerminalStatus(status) {
    return CONTROLLED_RESTART_TERMINAL_STATUSES.has(
      String(status ?? "").trim().toLowerCase(),
    );
  }

  _getControlledRestartRecoveryDeadlineMs() {
    return this._getRuntimeWindowMs(
      "controlledRestartRecoveryDeadlineMs",
      CONTROLLED_RESTART_RECOVERY_DEADLINE_MS,
      30000,
    );
  }

  _getControlledRestartRecoveryLoopDelayMs(attemptIndex = 0) {
    const normalizedAttemptIndex = Math.max(0, Number(attemptIndex ?? 0) || 0);
    const configured = this.config?.runtime?.controlledRestartRecoveryLoopDelaysMs;
    const source =
      Array.isArray(configured) && configured.length > 0
        ? configured
        : CONTROLLED_RESTART_RECOVERY_LOOP_DELAYS_MS;
    const normalizedSource = source
      .map((value) => Math.max(0, Number(value ?? 0) || 0))
      .filter((value) => Number.isFinite(value));
    if (normalizedSource.length === 0) {
      return 1000;
    }
    return normalizedSource[
      Math.min(normalizedAttemptIndex, normalizedSource.length - 1)
    ];
  }

  _shouldAttemptControlledRestartRecovery(ticket = null) {
    const normalizedTicket =
      ticket != null
        ? this._normalizeControlledRestartTicket(ticket)
        : this._getControlledRestartTicket();
    return (
      normalizedTicket != null &&
      !this._isControlledRestartTerminalStatus(normalizedTicket.status)
    );
  }

  _isControlledRestartRecoveryCancelled(restartId) {
    const normalizedRestartId = String(restartId ?? "").trim();
    if (!(this.controlledRestartCancelledRestartIds instanceof Set)) {
      this.controlledRestartCancelledRestartIds = new Set();
    }
    return (
      normalizedRestartId.length > 0 &&
      this.controlledRestartCancelledRestartIds.has(normalizedRestartId)
    );
  }

  _advanceControlledRestartTicket(ticket, nextStatus, extra = {}) {
    const normalizedTicket = this._normalizeControlledRestartTicket(ticket);
    const normalizedNextStatus = String(nextStatus ?? "").trim().toLowerCase();
    if (normalizedTicket == null || !normalizedNextStatus) {
      throw new Error("controlled_restart_ticket_invalid");
    }
    if (this._isControlledRestartRecoveryCancelled(normalizedTicket.restartId)) {
      throw new Error("controlled_restart_recovery_cancelled");
    }
    const currentRank =
      CONTROLLED_RESTART_STATUS_ORDER.get(
        String(normalizedTicket.status ?? "").trim().toLowerCase(),
      ) ?? 0;
    const nextRank =
      CONTROLLED_RESTART_STATUS_ORDER.get(normalizedNextStatus) ?? currentRank;
    return this._setControlledRestartTicket({
      ...normalizedTicket,
      ...extra,
      status: nextRank >= currentRank ? normalizedNextStatus : normalizedTicket.status,
      updatedAt: nowIso(),
    });
  }

  _isControlledRestartReadinessHardFail(result) {
    const reason = String(result?.reason ?? result?.error ?? "")
      .trim()
      .toLowerCase();
    return reason === "origin_thread_unavailable";
  }

  _buildControlledRestartDeadlineExceededError(lastFailure = null) {
    const detail = String(lastFailure?.error ?? lastFailure?.reason ?? "")
      .trim()
      .toLowerCase();
    return detail
      ? `controlled_restart_restore_deadline_exceeded:${detail}`
      : "controlled_restart_restore_deadline_exceeded";
  }

  _scheduleControlledRestartRecovery() {
    const ticket = this._getControlledRestartTicket();
    if (!this._shouldAttemptControlledRestartRecovery(ticket)) {
      return false;
    }
    if (
      this.controlledRestartRecoveryPromise != null &&
      this.controlledRestartRecoveryRestartId === ticket.restartId
    ) {
      return true;
    }
    this.controlledRestartRecoveryRestartId = ticket.restartId;
    this.controlledRestartRecoveryPromise = this._runControlledRestartRecovery(ticket)
      .catch((error) => {
        const latest = this._getControlledRestartTicket();
        if (latest?.restartId === ticket.restartId) {
          this._setControlledRestartTicket({
            ...latest,
            status: "needs_manual_recover",
            lastError: error instanceof Error ? error.message : String(error),
            updatedAt: nowIso(),
          });
        }
      })
      .finally(() => {
        if (this.controlledRestartRecoveryRestartId === ticket.restartId) {
          this.controlledRestartRecoveryRestartId = null;
          this.controlledRestartRecoveryPromise = null;
        }
      });
    this.controlledRestartRecoveryPromise.catch(() => {});
    return true;
  }

  async _runControlledRestartRecovery(ticket = null) {
    const initialTicket =
      ticket != null
        ? this._normalizeControlledRestartTicket(ticket)
        : this._getControlledRestartTicket();
    if (!this._shouldAttemptControlledRestartRecovery(initialTicket)) {
      return { ok: false, skipped: true, reason: "ticket_not_recoverable" };
    }
    if (this._isControlledRestartRecoveryCancelled(initialTicket.restartId)) {
      return {
        ok: false,
        skipped: true,
        reason: "controlled_restart_recovery_cancelled",
      };
    }
    let currentTicket = this._advanceControlledRestartTicket(
      initialTicket,
      "app_started",
      {
        appStartedAt: initialTicket?.appStartedAt ?? nowIso(),
        lastError: null,
        reportLastError: null,
      },
    );
    const appStartedAtMs = Date.parse(currentTicket.appStartedAt ?? "") || Date.now();
    const recoveryDeadlineAtMs =
      appStartedAtMs + this._getControlledRestartRecoveryDeadlineMs();
    const bridgeHealthyRank =
      CONTROLLED_RESTART_STATUS_ORDER.get("bridge_healthy") ?? 0;
    let supervisorCycle = 0;
    let lastFailure = null;
    while (Date.now() <= recoveryDeadlineAtMs) {
      if (supervisorCycle > 0) {
        await sleep(this._getControlledRestartRecoveryLoopDelayMs(supervisorCycle - 1));
      }
      if (this._isControlledRestartRecoveryCancelled(currentTicket.restartId)) {
        return {
          ok: false,
          skipped: true,
          reason: "controlled_restart_recovery_cancelled",
        };
      }
      const latestTicket = this._getControlledRestartTicket();
      if (latestTicket == null || latestTicket.restartId !== currentTicket.restartId) {
        return { ok: false, skipped: true, reason: "controlled_restart_ticket_missing" };
      }
      currentTicket = latestTicket;
      const bridgeHealthy =
        (CONTROLLED_RESTART_STATUS_ORDER.get(
          String(currentTicket.status ?? "").trim().toLowerCase(),
        ) ?? 0) >= bridgeHealthyRank;
      if (!bridgeHealthy) {
        const readinessResult = await this._waitForControlledRestartRestoreReadiness(
          currentTicket.originLocalThreadId,
        );
        if (!readinessResult?.ok) {
          if (this._isControlledRestartReadinessHardFail(readinessResult)) {
            const failedTicket = this._setControlledRestartTicket({
              ...currentTicket,
              status: "needs_manual_recover",
              resumeAttempts:
                Number(currentTicket.resumeAttempts ?? 0) +
                Math.max(1, Number(readinessResult?.probeAttempts ?? 0) || 1),
              lastError: String(
                readinessResult?.error ??
                  readinessResult?.reason ??
                  "controlled_restart_restore_not_ready",
              ),
              updatedAt: nowIso(),
            });
            return { ok: false, ticket: failedTicket, readinessResult };
          }
          currentTicket = this._setControlledRestartTicket({
            ...currentTicket,
            resumeAttempts:
              Number(currentTicket.resumeAttempts ?? 0) +
              Math.max(1, Number(readinessResult?.probeAttempts ?? 0) || 1),
            lastError: String(
              readinessResult?.error ??
                readinessResult?.reason ??
                "controlled_restart_restore_not_ready",
            ),
            updatedAt: nowIso(),
          });
          lastFailure = {
            stage: "readiness",
            error: String(
              readinessResult?.error ??
                readinessResult?.reason ??
                "controlled_restart_restore_not_ready",
            ),
            readinessResult,
          };
          supervisorCycle += 1;
          continue;
        }
        currentTicket = this._advanceControlledRestartTicket(
          currentTicket,
          "bridge_healthy",
          {
            bridgeHealthyAt: currentTicket?.bridgeHealthyAt ?? nowIso(),
            lastError: null,
          },
        );
      }
      const restoreResult = await this.restoreRestartOriginThread(currentTicket);
      if (restoreResult?.ok) {
        currentTicket = this._advanceControlledRestartTicket(
          currentTicket,
          "origin_thread_restored",
          {
            resumeAttempts:
              Number(currentTicket.resumeAttempts ?? 0) +
              Math.max(1, Number(restoreResult.attempts ?? 0) || 1),
            lastError: null,
          },
        );
        let completedTicket = this._setControlledRestartTicket({
          ...currentTicket,
          status: "completed",
          completedAt: nowIso(),
          lastError: null,
          reportLastError: null,
          updatedAt: nowIso(),
        });
        const binding =
          this.store?.getBindingById?.(completedTicket.originBindingId) ?? null;
        if (binding != null) {
          try {
            await this._sendControlledRestartReportToFeishu(binding, {
              restartId: completedTicket.restartId,
              text: this._buildControlledRestartRecoveredText(
                completedTicket.restartId,
              ),
            });
            completedTicket = this._setControlledRestartTicket({
              ...completedTicket,
              reportDeliveredAt: nowIso(),
              reportLastError: null,
              updatedAt: nowIso(),
            });
          } catch (error) {
            completedTicket = this._setControlledRestartTicket({
              ...completedTicket,
              reportLastError: error instanceof Error ? error.message : String(error),
              updatedAt: nowIso(),
            });
          }
        }
        return { ok: true, ticket: completedTicket, restoreResult };
      }
      if (restoreResult?.kind === "hard_fail") {
        const failedTicket = this._setControlledRestartTicket({
          ...currentTicket,
          status: "needs_manual_recover",
          resumeAttempts:
            Number(currentTicket.resumeAttempts ?? 0) +
            Math.max(1, Number(restoreResult?.attempts ?? 0) || 1),
          lastError: String(
            restoreResult?.error ??
              restoreResult?.reason ??
              "controlled_restart_restore_failed",
          ),
          updatedAt: nowIso(),
        });
        return { ok: false, ticket: failedTicket, restoreResult };
      }
      currentTicket = this._setControlledRestartTicket({
        ...currentTicket,
        resumeAttempts:
          Number(currentTicket.resumeAttempts ?? 0) +
          Math.max(1, Number(restoreResult?.attempts ?? 0) || 1),
        lastError: String(
          restoreResult?.error ??
            restoreResult?.reason ??
            "controlled_restart_restore_failed",
        ),
        updatedAt: nowIso(),
      });
      lastFailure = {
        stage: "restore",
        error: String(
          restoreResult?.error ??
            restoreResult?.reason ??
            "controlled_restart_restore_failed",
        ),
        restoreResult,
      };
      supervisorCycle += 1;
    }
    const failedTicket = this._setControlledRestartTicket({
      ...currentTicket,
      status: "needs_manual_recover",
      lastError: this._buildControlledRestartDeadlineExceededError(lastFailure),
      updatedAt: nowIso(),
    });
    return { ok: false, ticket: failedTicket, timedOut: true, lastFailure };
  }

  async _resolveControlledRestartActiveThread(originThreadId) {
    const normalizedOriginThreadId = normalizeConversationId(originThreadId);
    if (normalizedOriginThreadId == null) {
      return {
        ok: false,
        reason: "origin_thread_unavailable",
        activeThreadId: null,
        activeThread: null,
        probes: 0,
      };
    }
    const probeDelays = [...CONTROLLED_RESTART_ACTIVE_THREAD_PROBE_DELAYS_MS];
    const totalProbes = probeDelays.length + 1;
    for (let probeIndex = 0; probeIndex < totalProbes; probeIndex += 1) {
      if (probeIndex > 0) {
        await sleep(probeDelays[probeIndex - 1]);
      }
      const nativeThread = await this._readNativeThread(normalizedOriginThreadId);
      if (nativeThread != null) {
        return {
          ok: true,
          reason: "native_thread_readable",
          activeThreadId: normalizedOriginThreadId,
          activeThread: {
            localThreadId: normalizedOriginThreadId,
            localConversationId: normalizedOriginThreadId,
            resolutionSource: "native_read_thread",
          },
          probes: probeIndex + 1,
        };
      }
    }
    return {
      ok: false,
      reason: "native_thread_unreadable",
      activeThreadId: null,
      activeThread: null,
      probes: totalProbes,
    };
  }

  async _waitForControlledRestartRestoreReadiness(originThreadId) {
    const normalizedOriginThreadId = normalizeConversationId(originThreadId);
    if (normalizedOriginThreadId == null) {
      return {
        ok: false,
        reason: "origin_thread_unavailable",
        activeThreadId: null,
        activeThread: null,
        probeAttempts: 0,
      };
    }
    const probeDelays = [...CONTROLLED_RESTART_READINESS_PROBE_DELAYS_MS];
    const totalProbes = probeDelays.length + 1;
    let lastProbe = null;
    for (let probeIndex = 0; probeIndex < totalProbes; probeIndex += 1) {
      if (probeIndex > 0) {
        await sleep(probeDelays[probeIndex - 1]);
      }
      const nativeThread = await this._readNativeThread(normalizedOriginThreadId);
      if (nativeThread == null || typeof nativeThread !== "object") {
        lastProbe = { ok: false, reason: "native_thread_not_ready" };
        continue;
      }
      return {
        ok: true,
        reason: "native_thread_ready",
        activeThreadId: normalizedOriginThreadId,
        activeThread: {
          localThreadId: normalizedOriginThreadId,
          localConversationId: normalizedOriginThreadId,
          resolutionSource: "native_read_thread",
        },
        probeAttempts: probeIndex + 1,
        activeThreadMatched: true,
      };
    }
    return {
      ok: false,
      reason: lastProbe?.reason ?? "active_thread_unresolved",
      activeThreadId: lastProbe?.activeThreadId ?? null,
      activeThread: lastProbe?.activeThread ?? null,
      probeAttempts: totalProbes,
    };
  }

  async _validateControlledRestartRendererThread(originThreadId) {
    const normalizedOriginThreadId = normalizeConversationId(originThreadId);
    if (normalizedOriginThreadId == null) {
      return {
        ok: false,
        reason: "origin_thread_unavailable",
        activeThreadId: null,
        activeThread: null,
      };
    }
    let activeThread = null;
    try {
      activeThread = await this._getRendererActiveThread();
    } catch (error) {
      return {
        ok: false,
        reason: "renderer_active_thread_unavailable",
        error: error instanceof Error ? error.message : String(error),
        activeThreadId: null,
        activeThread: null,
      };
    }
    const activeThreadId =
      normalizeConversationId(activeThread?.localThreadId) ??
      normalizeConversationId(activeThread?.localConversationId) ??
      null;
    if (this._isRendererOnThread(activeThread, normalizedOriginThreadId)) {
      return {
        ok: true,
        reason: "renderer_thread_matched",
        activeThreadId: activeThreadId ?? normalizedOriginThreadId,
        activeThread,
      };
    }
    return {
      ok: false,
      reason: activeThread == null ? "renderer_thread_unavailable" : "renderer_thread_mismatch",
      activeThreadId,
      activeThread,
    };
  }

  async restoreRestartOriginThread(ticket = null) {
    const normalizedTicket =
      ticket != null
        ? this._normalizeControlledRestartTicket(ticket)
        : this._getControlledRestartTicket();
    if (normalizedTicket == null) {
      return {
        ok: false,
        kind: "hard_fail",
        error: "controlled_restart_ticket_missing",
        attempts: 0,
      };
    }
    const binding =
      this.store?.getBindingById?.(normalizedTicket.originBindingId) ?? null;
    if (binding == null) {
      return {
        ok: false,
        kind: "hard_fail",
        error: "origin_binding_not_found",
        attempts: 0,
      };
    }
    const originThreadId =
      normalizeConversationId(normalizedTicket.originLocalThreadId) ??
      normalizeConversationId(binding.local_thread_id) ??
      null;
    if (originThreadId == null) {
      return {
        ok: false,
        kind: "hard_fail",
        error: "origin_thread_unavailable",
        attempts: 0,
      };
    }
    const expectedSignature = normalizedTicket.preRestartTailSignature ?? null;
    if (
      expectedSignature == null ||
      !Array.isArray(expectedSignature.entries) ||
      expectedSignature.entries.length === 0
    ) {
      return {
        ok: false,
        kind: "hard_fail",
        error: "tail_signature_missing",
        attempts: 0,
      };
    }
    const retryDelays = [...CONTROLLED_RESTART_TAIL_RETRY_DELAYS_MS];
    const totalAttempts = retryDelays.length + 1;
    let lastFailure = null;
    for (let attemptIndex = 0; attemptIndex < totalAttempts; attemptIndex += 1) {
      if (attemptIndex > 0) {
        await sleep(retryDelays[attemptIndex - 1]);
      }
      try {
        await this.debugNavigateToLocalConversation({
          conversationId: originThreadId,
          settleMs: 1200,
        });
      } catch (error) {
        lastFailure = {
          ok: false,
          kind: "soft_fail",
          attempts: attemptIndex + 1,
          error: error instanceof Error ? error.message : String(error),
          stage: "navigate",
        };
        continue;
      }
      const rendererThreadResult =
        await this._validateControlledRestartRendererThread(originThreadId);
      if (!rendererThreadResult.ok) {
        lastFailure = {
          ok: false,
          kind: "soft_fail",
          attempts: attemptIndex + 1,
          error: String(rendererThreadResult.reason ?? "renderer_thread_unresolved"),
          stage: "renderer_thread_validation",
          activeThreadId: rendererThreadResult.activeThreadId ?? null,
        };
        continue;
      }
      const activeThreadResult =
        await this._resolveControlledRestartActiveThread(originThreadId);
      if (!activeThreadResult.ok) {
        lastFailure = {
          ok: false,
          kind: "soft_fail",
          attempts: attemptIndex + 1,
          error: String(activeThreadResult.reason ?? "native_thread_unresolved"),
          stage: "native_thread_validation",
          activeThreadId: activeThreadResult.activeThreadId ?? null,
          probes: Number(activeThreadResult.probes ?? 0),
        };
        continue;
      }
      const activeThreadId =
        rendererThreadResult.activeThreadId ?? activeThreadResult.activeThreadId;
      const signatureResult = await this._validateControlledRestartTailSignature({
        binding,
        expectedSignature,
        originThreadId,
      });
      if (signatureResult.ok) {
        return {
          ok: true,
          attempts: attemptIndex + 1,
          bindingId: binding.binding_id,
          originThreadId,
          activeThreadId,
          comparison: signatureResult.comparison,
          actualSignature: signatureResult.actualSignature,
        };
      }
      lastFailure = {
        ok: false,
        kind: "soft_fail",
        attempts: attemptIndex + 1,
        error: `tail_signature_${signatureResult.reason ?? "mismatch"}`,
        stage: "tail_signature_validation",
        comparison: signatureResult.comparison ?? null,
      };
    }
    return (
      lastFailure ?? {
        ok: false,
        kind: "soft_fail",
        attempts: totalAttempts,
        error: "controlled_restart_restore_unverified",
      }
    );
  }

  async _captureControlledRestartTailSignature({ binding, originThreadId }) {
    const normalizedThreadId = normalizeConversationId(originThreadId);
    if (binding == null || normalizedThreadId == null) {
      return {
        ok: false,
        reason: "origin_thread_unavailable",
        snapshot: null,
        actualSignature: null,
      };
    }
    const nativeThread = await this._readNativeThread(normalizedThreadId);
    if (nativeThread != null) {
      const snapshot = this._buildNativeContextBundle(binding, nativeThread, {
        localThreadId: normalizedThreadId,
        localConversationId: normalizedThreadId,
      });
      const actualSequence = this._buildControlledRestartComparableSequence(snapshot);
      return {
        ok: true,
        snapshot,
        actualSequence,
        actualSignature: this._buildControlledRestartTailSignature(snapshot),
      };
    }
    return {
      ok: false,
      reason: "native_thread_unavailable",
      snapshot: null,
      actualSignature: null,
    };
  }

  async _validateControlledRestartTailSignature({
    binding,
    expectedSignature,
    originThreadId,
  } = {}) {
    const capture = await this._captureControlledRestartTailSignature({
      binding,
      originThreadId,
    });
    if (!capture.ok) {
      return {
        ok: false,
        reason: capture.reason ?? "snapshot_unavailable",
        comparison: null,
        actualSignature: capture.actualSignature ?? null,
        snapshot: capture.snapshot ?? null,
      };
    }
    const comparison = this._compareControlledRestartTailSignatures(
      expectedSignature,
      capture.actualSequence ?? capture.actualSignature,
    );
    return {
      ok: comparison.ok,
      reason: comparison.reason,
      comparison,
      actualSignature: capture.actualSignature,
      snapshot: capture.snapshot,
    };
  }

  debugClearControlledRestartTicket({
    restartId = null,
    bindingId = null,
    allowActive = false,
    clearedBy = "manual_debug_rpc",
    reason = "manual_unlock",
  } = {}) {
    const ticket = this._getControlledRestartTicket();
    if (ticket == null) {
      return {
        ok: false,
        cleared: false,
        error: "controlled_restart_ticket_missing",
      };
    }
    const providedRestartId = String(restartId ?? "").trim() || null;
    const providedBindingId = String(bindingId ?? "").trim() || null;
    if (providedRestartId != null && providedRestartId !== ticket.restartId) {
      return {
        ok: false,
        cleared: false,
        error: "restart_id_mismatch",
        previousStatus: ticket.status,
      };
    }
    if (providedBindingId != null && providedBindingId !== ticket.originBindingId) {
      return {
        ok: false,
        cleared: false,
        error: "binding_id_mismatch",
        previousStatus: ticket.status,
      };
    }
    const previousStatus = String(ticket.status ?? "").trim().toLowerCase();
    const wasActive = !CONTROLLED_RESTART_MANUAL_CLEAR_DEFAULT_STATUSES.has(
      previousStatus,
    );
    if (wasActive && !allowActive) {
      return {
        ok: false,
        cleared: false,
        error: "active_ticket_clear_not_allowed",
        previousStatus,
        status: previousStatus,
      };
    }
    if (wasActive && ticket.restartId) {
      if (!(this.controlledRestartCancelledRestartIds instanceof Set)) {
        this.controlledRestartCancelledRestartIds = new Set();
      }
      this.controlledRestartCancelledRestartIds.add(ticket.restartId);
    }
    const clearedAt = nowIso();
    this.store?.setRuntimeState?.(CONTROLLED_RESTART_LAST_CLEARED_AUDIT_KEY, {
      manualClearedAt: clearedAt,
      manualClearedBy: String(clearedBy ?? "").trim() || "manual_debug_rpc",
      clearedReason: String(reason ?? "").trim() || "manual_unlock",
      clearedTicket: this._buildControlledRestartClearedAuditSnapshot(ticket),
    });
    this._clearControlledRestartTicket();
    return {
      ok: true,
      cleared: true,
      restartId: ticket.restartId,
      bindingId: ticket.originBindingId,
      previousStatus,
      wasActive,
      clearedAt,
    };
  }

  async handleRpc(method, params) {
    switch (method) {
      case "bridge.health":
        return this.health();
      case "bridge.getActiveThread":
        return this.getActiveThread();
      case "bridge.bindCurrentThread":
        return this.bindCurrentThread(params);
      case "bridge.resolveBinding":
        return this.resolveBinding(params);
      case "bridge.exportContextBundle":
        return this.exportContextBundle(params);
      case "bridge.submitInboundFeishuMessage":
        return this.submitInboundFeishuMessage(params);
      case "bridge.debugSubmitProbe":
        return this.debugSubmitProbe(params);
      case "bridge.debugOpenNewThreadSurface":
        return this.debugOpenNewThreadSurface(params);
      case "bridge.debugTriggerNewThreadShortcut":
        return this.debugTriggerNewThreadShortcut(params);
      case "bridge.debugProbeUiAction":
        return this.debugProbeUiAction(params);
      case "bridge.debugInvokeElectronBridgeMessage":
        return this.debugInvokeElectronBridgeMessage(params);
      case "bridge.debugInspectProcessHandles":
        return this.debugInspectProcessHandles();
      case "bridge.debugInspectObjectPath":
        return this.debugInspectObjectPath(params);
      case "bridge.debugListInvokeHandlers":
        return this.debugListInvokeHandlers();
      case "bridge.debugSendMessageForView":
        return this.debugSendMessageForView(params);
      case "bridge.debugCopyCurrentSessionId":
        return this.debugCopyCurrentSessionId(params);
      case "bridge.debugGetThreadRole":
        return this.debugGetThreadRole(params);
      case "bridge.debugCallObjectMethod":
        return this.debugCallObjectMethod(params);
      case "bridge.debugNavigateToRoute":
        return this.debugNavigateToRoute(params);
      case "bridge.debugNavigateToLocalConversation":
        return this.debugNavigateToLocalConversation(params);
      case "bridge.debugNavigateToNewThread":
        return this.debugNavigateToNewThread(params);
      case "bridge.debugGetControlledRestartTicket":
        return this._getControlledRestartTicket();
      case "bridge.debugStartControlledRestart":
        return this.debugStartControlledRestart(params);
      case "bridge.debugClearControlledRestartTicket":
        return this.debugClearControlledRestartTicket(params);
      case "bridge.listPendingTurns":
        return this.listPendingTurns();
      case "bridge.unbind":
        return this.unbind(params);
      default:
        throw new Error(`unsupported_rpc_method:${method}`);
    }
  }

  async health() {
    return {
      ok: true,
      ...this._getPublicStatus(),
      pipeName: this.paths.pipeName,
      storePath: this.paths.storePath,
      activeThread: this._getHealthActiveThread(),
      windows: [],
      invokeHandlers: {
        messageFromView:
          this.handlerRegistry.getInvokeHandler("codex_desktop:message-from-view") !=
          null,
      },
      pendingActions: this.store.listPendingActions().length,
      bindingCount: this.store.listBindings().length,
      controlledRestart: this._buildControlledRestartSharedState(),
    };
  }

  _getHealthActiveThread() {
    const bindings = this.store?.listBindings?.() ?? [];
    if (!Array.isArray(bindings) || bindings.length !== 1) {
      return null;
    }
    const binding = bindings[0];
    const threadId =
      normalizeConversationId(binding?.local_thread_id) ??
      normalizeConversationId(binding?.local_conversation_id) ??
      null;
    if (threadId == null) {
      return null;
    }
    return {
      localThreadId: threadId,
      localConversationId: threadId,
      resolutionSource: "binding",
    };
  }

  _getPublicStatus() {
    return {
      ...(this.status != null && typeof this.status === "object" ? this.status : {}),
    };
  }

  async getActiveThread({
    publishSharedState = true,
  } = {}) {
    const active = this._getHealthActiveThread();
    this.status.lastUpdatedAt = nowIso();
    if (publishSharedState) {
      this._publishSharedState();
    }
    return active;
  }

  _getRuntimeWindowMs(key, fallback, minimum = 0) {
    return Math.max(minimum, Number(this.config?.runtime?.[key] ?? fallback));
  }

  _getFocusedIdleNativePollMs() {
    return this._getRuntimeWindowMs("focusedIdleNativePollMs", 9000, 4000);
  }

  _getActiveNativePollMs() {
    return this._getRuntimeWindowMs(
      "activeNativePollMs",
      this.config?.runtime?.pollIntervalMs ?? 3000,
      1500,
    );
  }

  _getPostSubmitFastWindowMs() {
    return this._getRuntimeWindowMs("postSubmitFastWindowMs", 12000, 3000);
  }

  _extractShallowSubmitSignals(payload) {
    const submitSignals = [];
    const candidateValues = [];
    if (Array.isArray(payload)) {
      candidateValues.push(...payload.slice(0, 3));
    } else {
      candidateValues.push(payload);
    }
    for (const candidate of candidateValues) {
      if (candidate == null) {
        continue;
      }
      if (typeof candidate === "string") {
        submitSignals.push(candidate);
        continue;
      }
      if (typeof candidate !== "object") {
        continue;
      }
      for (const key of ["type", "action", "kind", "event", "command", "name", "intent"]) {
        const value = candidate[key];
        if (typeof value === "string" && value) {
          submitSignals.push(value);
        }
      }
      const nestedMessage = candidate.message;
      if (nestedMessage && typeof nestedMessage === "object") {
        for (const key of ["type", "action", "kind", "event", "command", "name", "intent"]) {
          const value = nestedMessage[key];
          if (typeof value === "string" && value) {
            submitSignals.push(value);
          }
        }
      }
    }
    return submitSignals;
  }

  _looksLikeSubmitPayload(payload) {
    const signals = this._extractShallowSubmitSignals(payload);
    if (signals.length === 0) {
      return false;
    }
    return signals.some((signal) =>
      /\b(send|submit|submitted|enter|return_key|promptsubmitted|dispatchsubmit)\b/.test(
        String(signal).toLowerCase(),
      ),
    );
  }

  _notePossibleSubmitActivity(nowMs = Date.now()) {
    this.recentSubmitActivityAtMs = nowMs;
    this.userJustSentMessage = true;
    this.pendingUserMessageBindingPoll = true;
  }

  _noteViewMessageActivity(payload) {
    if (this._looksLikeSubmitPayload(payload)) {
      this._notePossibleSubmitActivity(Date.now());
    }
  }

  _installViewMessageActivityHook() {
    if (this.viewMessageHookInstalled) {
      return true;
    }
    if (typeof this.handlerRegistry?.registerInvokeWrapper !== "function") {
      return false;
    }
    this.viewMessageHookInstalled = this.handlerRegistry.registerInvokeWrapper(
      "codex_desktop:message-from-view",
      (listener) => {
        if (typeof listener !== "function") {
          return listener;
        }
        return async (...args) => {
          this._noteViewMessageActivity(args.slice(1));
          return listener(...args);
        };
      },
    );
    return this.viewMessageHookInstalled;
  }

  _isActiveTurnStatus(status) {
    return new Set([
      "queued",
      "running",
      "streaming",
      "inprogress",
      "in_progress",
      "in-progress",
      "submitting",
      "submitted",
      "waiting",
      "processing",
      "active",
    ]).has(String(status ?? "").trim().toLowerCase());
  }

  _shouldThrottleNativeBindingPoll(binding) {
    if (binding == null) {
      return false;
    }
    const nowMs = Date.now();
    const previous = this.nativeBindingPollState.get(binding.binding_id) ?? null;
    const activeTurn = this._isActiveTurnStatus(previous?.lastTurnStatus);
    const fastWindowMs = this._getPostSubmitFastWindowMs();
    const hasRecentFastActivity =
      (this.recentSubmitActivityAtMs > 0 && nowMs - this.recentSubmitActivityAtMs < fastWindowMs) ||
      (this.recentInboundActivityAtMs > 0 && nowMs - this.recentInboundActivityAtMs < fastWindowMs);
    if (previous == null || !Number.isFinite(previous.lastReadAtMs)) {
      return false;
    }
    const minIntervalMs =
      !activeTurn && !hasRecentFastActivity
        ? this._getFocusedIdleNativePollMs()
        : this._getActiveNativePollMs();
    return nowMs - previous.lastReadAtMs < minIntervalMs;
  }

  _rememberNativeBindingMetadata(binding, thread) {
    if (binding == null) {
      return;
    }
    const previous = this.nativeBindingPollState.get(binding.binding_id) ?? {};
    this.nativeBindingPollState.set(binding.binding_id, {
      ...previous,
      lastReadAtMs: Date.now(),
      lastTurnStatus: previous.lastTurnStatus ?? "idle",
      lastThreadUpdatedAt:
        this._getNativeThreadUpdatedAt(thread) ??
        previous.lastThreadUpdatedAt ??
        null,
    });
  }

  _getNativeThreadUpdatedAt(thread) {
    const updatedAt = String(thread?.updatedAt ?? thread?.updated_at ?? "").trim();
    return updatedAt || null;
  }

  _hasNativeTurnNotificationHook() {
    return this.nativeTurnNotificationDisposer instanceof Function;
  }

  _hasRecentSubmitActivity(windowMs = this._getPostSubmitFastWindowMs()) {
    return (
      this.recentSubmitActivityAtMs > 0 &&
      Date.now() - this.recentSubmitActivityAtMs < Math.max(0, Number(windowMs) || 0)
    );
  }

  _shouldFollowCurrentRebindFromNativeTurnStart() {
    return this._hasRecentSubmitActivity(this._getFollowCurrentNativeTurnWindowMs());
  }

  _getFollowCurrentNativeTurnWindowMs() {
    return this._getRuntimeWindowMs("followCurrentNativeTurnWindowMs", 5000, 1500);
  }

  _hasFollowCurrentBindings() {
    return (this.store?.listBindings?.() ?? []).some(
      (binding) => binding?.follow_current_thread,
    );
  }

  _refreshNativeTurnNotificationHook() {
    if ((this.store?.listBindings?.() ?? []).length > 0) {
      return this._installNativeTurnNotificationHook();
    }
    this._uninstallNativeTurnNotificationHook();
    return false;
  }

  _installNativeTurnNotificationHook() {
    if (this.nativeTurnNotificationDisposer != null) {
      return true;
    }
    const client = this._getNativeAppServerClient();
    if (
      client == null ||
      !(client.registerInternalNotificationHandler instanceof Function)
    ) {
      return false;
    }
    try {
      this.nativeTurnNotificationDisposer =
        client.registerInternalNotificationHandler((notification) => {
          void this._handleNativeInternalNotification(notification);
        });
      return true;
    } catch {
      this.nativeTurnNotificationDisposer = null;
      return false;
    }
  }

  _uninstallNativeTurnNotificationHook() {
    if (!(this.nativeTurnNotificationDisposer instanceof Function)) {
      this.nativeTurnNotificationDisposer = null;
      return;
    }
    try {
      this.nativeTurnNotificationDisposer();
    } catch {
      // Best-effort cleanup only.
    }
    this.nativeTurnNotificationDisposer = null;
  }

  async _handleNativeInternalNotification(notification) {
    const method = String(notification?.method ?? "").trim();
    if (method.startsWith("turn/") || method.startsWith("item/")) {
      void this._emitNativeUserMessageForNativeNotification(notification).catch(
        (error) => this._recordError(error),
      );
      this._scheduleRolloutAssistantEventsForNativeNotification(
        notification,
        method === "turn/completed" ? 80 : 180,
      );
    }
    if (method === "item/started") {
      this._handleNativeItemStartedNotification(notification);
      return;
    }
    if (method === "item/agentMessage/delta") {
      this._handleNativeAssistantDeltaNotification(notification);
      return;
    }
    if (method === "item/reasoning/summaryTextDelta") {
      this._handleNativeReasoningSummaryDeltaNotification(notification);
      return;
    }
    if (method === "item/commandExecution/outputDelta") {
      this._handleNativeToolOutputDeltaNotification(notification);
      return;
    }
    if (method === "item/completed") {
      this._handleNativeItemCompletedNotification(notification);
      return;
    }
    if (method === "turn/completed") {
      await this._handleNativeTurnCompletedNotification(notification);
      return;
    }
    if (
      method !== "turn/started" ||
      !this._hasFollowCurrentBindings()
    ) {
      return;
    }
    if (!this._shouldFollowCurrentRebindFromNativeTurnStart(notification)) {
      return;
    }
    const localThreadId =
      normalizeConversationId(notification?.params?.threadId) ??
      normalizeConversationId(notification?.params?.conversationId) ??
      normalizeConversationId(notification?.params?.turn?.threadId) ??
      null;
    if (localThreadId == null) {
      return;
    }
    let reboundAny = false;
    const followBindings = (this.store?.listBindings?.() ?? []).filter(
      (binding) => binding?.follow_current_thread,
    );
    const localTurnId =
      normalizeConversationId(notification?.params?.turnId) ??
      normalizeConversationId(notification?.params?.localTurnId) ??
      normalizeConversationId(notification?.params?.turn?.id) ??
      normalizeConversationId(notification?.params?.turn?.turnId) ??
      null;
    for (const binding of followBindings) {
      if (this._isBindingResumeRebindLocked(binding.binding_id)) {
        continue;
      }
      this._rememberFollowActivationEmission(binding, localThreadId, {
        localTurnId,
      });
      if (normalizeConversationId(binding.local_thread_id) === localThreadId) {
        continue;
      }
      this._rebindFollowCurrentThread(binding, localThreadId);
      reboundAny = true;
    }
    if (reboundAny) {
      this._publishSharedState();
    }
  }

  _getNativeNotificationThreadId(notification) {
    return (
      normalizeConversationId(notification?.params?.threadId) ??
      normalizeConversationId(notification?.params?.conversationId) ??
      normalizeConversationId(notification?.params?.turn?.threadId) ??
      null
    );
  }

  _getNativeNotificationTurnId(notification) {
    return (
      normalizeConversationId(notification?.params?.turnId) ??
      normalizeConversationId(notification?.params?.localTurnId) ??
      normalizeConversationId(notification?.params?.turn?.id) ??
      normalizeConversationId(notification?.params?.turn?.turnId) ??
      normalizeConversationId(notification?.params?.item?.turnId) ??
      null
    );
  }

  _getNativeNotificationItemId(notification) {
    return (
      String(notification?.params?.itemId ?? "").trim() ||
      String(notification?.params?.item?.id ?? "").trim() ||
      "agent-message"
    );
  }

  _getBindingsForNativeThread(localThreadId) {
    const normalizedThreadId = normalizeConversationId(localThreadId) ?? null;
    if (normalizedThreadId == null) {
      return [];
    }
    const bindings = this.store?.listBindings?.() ?? [];
    return bindings.filter(
      (binding) =>
        normalizeConversationId(binding?.local_thread_id) === normalizedThreadId &&
        !this._isBindingResumeRebindLocked(binding?.binding_id),
    );
  }

  _markNativeBindingEventDriven(
    binding,
    { turnStatus = "inProgress", windowMs = 30000 } = {},
  ) {
    if (binding == null) {
      return;
    }
    const previous = this.nativeBindingPollState.get(binding.binding_id) ?? {};
    this.nativeBindingPollState.set(binding.binding_id, {
      ...previous,
      lastReadAtMs: Date.now(),
      lastTurnStatus: String(turnStatus ?? "").trim() || previous.lastTurnStatus || "idle",
      lastThreadUpdatedAt: previous.lastThreadUpdatedAt ?? null,
      eventDrivenUntilMs: Date.now() + Math.max(1000, Number(windowMs) || 0),
    });
  }

  _normalizeNativeAssistantSection(section) {
    const normalized = String(section ?? "").trim().toLowerCase();
    return NATIVE_ASSISTANT_SECTIONS.has(normalized) ? normalized : "final";
  }

  _normalizeNativeAgentMessagePhase(phase) {
    return String(phase ?? "").trim().toLowerCase();
  }

  _getNativeAgentMessagePhase(notification, item = null) {
    const candidates = [
      item?.phase,
      item?.channel,
      notification?.params?.phase,
      notification?.params?.channel,
      notification?.params?.item?.phase,
      notification?.params?.item?.channel,
      notification?.params?.message?.phase,
      notification?.params?.message?.channel,
      notification?.params?.responseItem?.phase,
      notification?.params?.responseItem?.channel,
    ];
    for (const candidate of candidates) {
      const phase = this._normalizeNativeAgentMessagePhase(candidate);
      if (phase) {
        return phase;
      }
    }
    return "";
  }

  _getNativeAgentMessageSection(notification, item = null) {
    const phase = this._getNativeAgentMessagePhase(notification, item);
    if (
      phase === "commentary" ||
      phase === "progress" ||
      phase === "status" ||
      phase === "thinking" ||
      phase === "analysis"
    ) {
      return "progress";
    }
    return "final";
  }

  _getNativeAssistantStreamKey(
    bindingId,
    localThreadId,
    localTurnId,
    itemId,
    section = "final",
  ) {
    const normalizedBindingId = String(bindingId ?? "").trim();
    const normalizedThreadId = normalizeConversationId(localThreadId) ?? null;
    const normalizedTurnId = normalizeConversationId(localTurnId) ?? null;
    const normalizedItemId = String(itemId ?? "").trim();
    const normalizedSection = this._normalizeNativeAssistantSection(section);
    if (
      !normalizedBindingId ||
      normalizedThreadId == null ||
      normalizedTurnId == null ||
      !normalizedItemId
    ) {
      return null;
    }
    return `${normalizedBindingId}:${normalizedThreadId}:${normalizedTurnId}:${normalizedSection}:${normalizedItemId}`;
  }

  _findNativeAssistantStreamForItem(binding, localThreadId, localTurnId, itemId) {
    if (!(this.nativeAssistantStreams instanceof Map)) {
      return null;
    }
    for (const section of NATIVE_ASSISTANT_SECTIONS) {
      const key = this._getNativeAssistantStreamKey(
        binding?.binding_id,
        localThreadId,
        localTurnId,
        itemId,
        section,
      );
      if (key == null) {
        continue;
      }
      const existing = this.nativeAssistantStreams.get(key);
      if (existing != null) {
        return existing;
      }
    }
    return null;
  }

  _getOrCreateNativeAssistantStream(
    binding,
    localThreadId,
    localTurnId,
    itemId,
    options = {},
  ) {
    const section = this._normalizeNativeAssistantSection(options?.section);
    const existingForItem = this._findNativeAssistantStreamForItem(
      binding,
      localThreadId,
      localTurnId,
      itemId,
    );
    if (existingForItem != null) {
      if (existingForItem.section !== section) {
        const nextKey = this._getNativeAssistantStreamKey(
          binding?.binding_id,
          localThreadId,
          localTurnId,
          itemId,
          section,
        );
        if (nextKey != null) {
          this.nativeAssistantStreams.delete(existingForItem.key);
          existingForItem.key = nextKey;
          existingForItem.section = section;
          existingForItem.itemType =
            String(options?.itemType ?? "").trim() || existingForItem.itemType;
          this.nativeAssistantStreams.set(nextKey, existingForItem);
        }
      }
      return existingForItem;
    }
    const key = this._getNativeAssistantStreamKey(
      binding?.binding_id,
      localThreadId,
      localTurnId,
      itemId,
      section,
    );
    if (key == null) {
      return null;
    }
    if (!(this.nativeAssistantStreams instanceof Map)) {
      this.nativeAssistantStreams = new Map();
    }
    const existing = this.nativeAssistantStreams.get(key);
    if (existing != null) {
      return existing;
    }
    const created = {
      key,
      binding,
      localThreadId,
      localTurnId,
      itemId: String(itemId ?? "").trim(),
      itemType: String(options?.itemType ?? "").trim() || null,
      section,
      text: "",
      partsByIndex: {},
      lastEmittedText: "",
      lastEmittedStatus: null,
      itemIndex: 0,
      turnIndex: 0,
      timer: null,
    };
    this.nativeAssistantStreams.set(key, created);
    return created;
  }

  _reclassifyNativeFinalStreamsAsProgress(localThreadId, localTurnId) {
    const normalizedThreadId = normalizeConversationId(localThreadId) ?? null;
    const normalizedTurnId = normalizeConversationId(localTurnId) ?? null;
    if (normalizedThreadId == null || normalizedTurnId == null) {
      return false;
    }
    let changed = false;
    for (const stream of Array.from(this.nativeAssistantStreams?.values?.() ?? [])) {
      if (
        normalizeConversationId(stream.localThreadId) !== normalizedThreadId ||
        normalizeConversationId(stream.localTurnId) !== normalizedTurnId ||
        stream.section !== "final"
      ) {
        continue;
      }
      const nextKey = this._getNativeAssistantStreamKey(
        stream.binding?.binding_id,
        stream.localThreadId,
        stream.localTurnId,
        stream.itemId,
        "progress",
      );
      if (!nextKey || nextKey === stream.key) {
        continue;
      }
      this.nativeAssistantStreams.delete(stream.key);
      stream.key = nextKey;
      stream.section = "progress";
      this.nativeAssistantStreams.set(nextKey, stream);
      this._flushNativeAssistantStream(stream);
      changed = true;
    }
    return changed;
  }

  _scheduleNativeAssistantStreamFlush(stream, delayMs = 250) {
    if (stream == null || stream.timer != null) {
      return;
    }
    stream.timer = setTimeout(() => {
      stream.timer = null;
      this._flushNativeAssistantStream(stream.key);
    }, Math.max(50, Number(delayMs) || 0));
  }

  _flushNativeAssistantStream(streamOrKey, { completed = false } = {}) {
    const stream =
      typeof streamOrKey === "string"
        ? this.nativeAssistantStreams?.get(streamOrKey)
        : streamOrKey;
    if (stream == null) {
      return false;
    }
    if (stream.timer != null) {
      clearTimeout(stream.timer);
      stream.timer = null;
    }
    const text = String(stream.text ?? "").trim();
    const turnStatus = completed ? "completed" : "inProgress";
    if (!text) {
      if (completed) {
        this.nativeAssistantStreams?.delete?.(stream.key);
      }
      return false;
    }
    if (
      !completed &&
      stream.lastEmittedText === text &&
      stream.lastEmittedStatus === turnStatus
    ) {
      return false;
    }
    if (!(this.pipeServer?.notify instanceof Function)) {
      return false;
    }
    this.pipeServer.notify("bridge.turnEvent", {
      bindingId: stream.binding?.binding_id,
      feishuOpenId: stream.binding?.feishu_open_id,
      feishuChatId: stream.binding?.feishu_chat_id,
      eventType: "assistant_reply_completed",
      message: {
        role: "assistant",
        text,
        assistantSection: stream.section,
        bridgeSection: stream.section,
        streamKind: stream.section,
        itemId: stream.itemId,
        itemType: stream.itemType,
        localThreadId: stream.localThreadId,
        localConversationId: stream.localThreadId,
        turnId: stream.localTurnId,
        itemIndex: stream.itemIndex,
        turnIndex: stream.turnIndex,
        turnStatus,
      },
      generatedAt: nowIso(),
    });
    stream.lastEmittedText = text;
    stream.lastEmittedStatus = turnStatus;
    if (completed) {
      this.nativeAssistantStreams.delete(stream.key);
    }
    return true;
  }

  _extractNativeAgentMessageText(item) {
    const directCandidates = [
      item?.text,
      item?.message,
      item?.content?.text,
      item?.content?.message,
      item?.content,
    ];
    for (const candidate of directCandidates) {
      if (typeof candidate === "string" && candidate.trim()) {
        return candidate;
      }
    }
    if (Array.isArray(item?.content)) {
      return item.content
        .map((part) => {
          if (typeof part === "string") {
            return part;
          }
          return String(part?.text ?? part?.content ?? "").trim();
        })
        .filter(Boolean)
        .join("");
    }
    return "";
  }

  _extractNativeReasoningSummaryText(item) {
    const summary = Array.isArray(item?.summary) ? item.summary : [];
    const summaryText = summary
      .map((part) => String(part ?? "").trim())
      .filter(Boolean)
      .join("\n\n")
      .trim();
    if (summaryText) {
      return summaryText;
    }
    const direct = String(item?.text ?? item?.summaryText ?? "").trim();
    return direct;
  }

  _emitNativeAssistantSectionEvent({
    binding,
    localThreadId,
    localTurnId,
    section = "final",
    text = "",
    turnStatus = "inProgress",
    itemId = null,
    itemType = null,
    itemIndex = 0,
    turnIndex = 0,
    eventSubtype = null,
    toolSummaryLabels = [],
    toolStateSummary = null,
    sourceCompleted = false,
    allowEmpty = false,
  } = {}) {
    const normalizedSection = this._normalizeNativeAssistantSection(section);
    const normalizedText = String(text ?? "").trim();
    if (
      !allowEmpty &&
      !normalizedText &&
      sanitizeToolSummaryLabels(toolSummaryLabels).length === 0
    ) {
      return false;
    }
    if (!(this.pipeServer?.notify instanceof Function)) {
      return false;
    }
    this.pipeServer.notify("bridge.turnEvent", {
      bindingId: binding?.binding_id,
      feishuOpenId: binding?.feishu_open_id,
      feishuChatId: binding?.feishu_chat_id,
      eventType: "assistant_reply_completed",
      message: {
        role: "assistant",
        text: normalizedText,
        assistantSection: normalizedSection,
        bridgeSection: normalizedSection,
        streamKind: normalizedSection,
        eventSubtype: String(eventSubtype ?? "").trim() || null,
        itemId: String(itemId ?? "").trim() || null,
        itemType: String(itemType ?? "").trim() || null,
        localThreadId,
        localConversationId: localThreadId,
        turnId: localTurnId,
        itemIndex,
        turnIndex,
        turnStatus,
        sourceCompleted: Boolean(sourceCompleted),
        ...(sanitizeToolSummaryLabels(toolSummaryLabels).length > 0
          ? {
              toolSummaryLabels: sanitizeToolSummaryLabels(toolSummaryLabels),
            }
          : {}),
        ...(toolStateSummary != null && typeof toolStateSummary === "object"
          ? {
              toolStateSummary: {
                ...toolStateSummary,
              },
            }
          : {}),
      },
      generatedAt: nowIso(),
    });
    return true;
  }

  _getNativeTurnToolSummaryKey(bindingId, localThreadId, localTurnId) {
    const normalizedBindingId = String(bindingId ?? "").trim();
    const normalizedThreadId = normalizeConversationId(localThreadId) ?? null;
    const normalizedTurnId = normalizeConversationId(localTurnId) ?? null;
    if (!normalizedBindingId || normalizedThreadId == null || normalizedTurnId == null) {
      return null;
    }
    return `${normalizedBindingId}:${normalizedThreadId}:${normalizedTurnId}`;
  }

  _getOrCreateNativeTurnToolSummary(binding, localThreadId, localTurnId) {
    const key = this._getNativeTurnToolSummaryKey(
      binding?.binding_id,
      localThreadId,
      localTurnId,
    );
    if (key == null) {
      return null;
    }
    const existing = this.nativeTurnToolSummaries.get(key);
    if (existing != null) {
      return existing;
    }
    const created = {
      key,
      binding,
      localThreadId,
      localTurnId,
      startedAt: nowIso(),
      completedAt: null,
      entries: new Map(),
      lastEmittedText: "",
      lastEmittedStatus: null,
    };
    this.nativeTurnToolSummaries.set(key, created);
    return created;
  }

  _isNativeToolItem(item) {
    const type = String(item?.type ?? "").trim();
    return NATIVE_TOOL_ITEM_TYPES.has(type);
  }

  _buildNativeToolSummaryLabel(item, fallbackType = null) {
    const type = String(item?.type ?? fallbackType ?? "").trim();
    if (type === "commandExecution") {
      const command = truncateBridgeLabel(
        item?.command ?? item?.cmd ?? item?.shellCommand ?? "",
      );
      return command ? `\u8fd0\u884c\u547d\u4ee4: ${command}` : "\u8fd0\u884c\u547d\u4ee4";
    }
    if (type === "mcpToolCall") {
      const server = truncateBridgeLabel(item?.server ?? "", 48);
      const tool = truncateBridgeLabel(item?.tool ?? item?.name ?? "", 72);
      const joined = [server, tool].filter(Boolean).join("/");
      return joined
        ? `\u8c03\u7528 MCP \u5de5\u5177: ${joined}`
        : "\u8c03\u7528 MCP \u5de5\u5177";
    }
    if (type === "dynamicToolCall") {
      const tool = truncateBridgeLabel(item?.tool ?? item?.name ?? "", 96);
      return tool ? `\u8c03\u7528\u5de5\u5177: ${tool}` : "\u8c03\u7528\u5de5\u5177";
    }
    if (type === "fileChange") {
      return "\u7f16\u8f91\u6587\u4ef6";
    }
    if (type === "imageGeneration") {
      return "\u751f\u6210\u56fe\u7247";
    }
    if (type === "collabAgentToolCall") {
      const tool = truncateBridgeLabel(item?.tool ?? item?.name ?? "", 96);
      return tool
        ? `\u8c03\u7528\u5b50\u4efb\u52a1: ${tool}`
        : "\u8c03\u7528\u5b50\u4efb\u52a1";
    }
    return "";
  }

  _buildNativeToolStateSummary(state, labels, turnStatus = "inProgress") {
    return {
      source: "app_server_native",
      dataSource: "native_event_stream",
      startedAt: state.startedAt,
      completedAt: turnStatus === "completed" ? nowIso() : state.completedAt,
      visibleToolSummaryLabels: labels,
    };
  }

  _emitNativeToolSummaryState(state, turnStatus = "inProgress") {
    if (state == null) {
      return false;
    }
    const labels = sanitizeToolSummaryLabels(
      Array.from(state.entries.values()).map((entry) => entry?.label),
    );
    if (labels.length === 0) {
      return false;
    }
    const summaryKey = labels.join("\n");
    if (state.lastEmittedText === summaryKey && state.lastEmittedStatus === turnStatus) {
      return false;
    }
    const emitted = this._emitNativeAssistantSectionEvent({
      binding: state.binding,
      localThreadId: state.localThreadId,
      localTurnId: state.localTurnId,
      section: "tool",
      text: "",
      turnStatus,
      itemId: "tool_summary_state",
      itemType: "toolSummary",
      eventSubtype: "tool_summary_state",
      toolSummaryLabels: labels,
      toolStateSummary: this._buildNativeToolStateSummary(state, labels, turnStatus),
    });
    if (emitted) {
      state.lastEmittedText = summaryKey;
      state.lastEmittedStatus = turnStatus;
      if (turnStatus === "completed") {
        state.completedAt = state.completedAt ?? nowIso();
      }
    }
    return emitted;
  }

  _updateNativeToolSummaryFromItem(binding, localThreadId, localTurnId, item) {
    if (!this._isNativeToolItem(item)) {
      return false;
    }
    const state = this._getOrCreateNativeTurnToolSummary(
      binding,
      localThreadId,
      localTurnId,
    );
    if (state == null) {
      return false;
    }
    const itemId = String(item?.id ?? item?.itemId ?? item?.callId ?? "").trim() ||
      `${String(item?.type ?? "tool")}:${state.entries.size + 1}`;
    const label = this._buildNativeToolSummaryLabel(item);
    if (!label) {
      return false;
    }
    const previous = state.entries.get(itemId) ?? null;
    const previousLabel = String(previous?.label ?? "");
    let effectiveLabel = label;
    if (previousLabel) {
      if (label === previousLabel || previousLabel.startsWith(label)) {
        effectiveLabel = previousLabel;
      } else if (!label.startsWith(previousLabel)) {
        effectiveLabel = previousLabel;
      }
    }
    state.entries.set(itemId, {
      label: effectiveLabel,
      itemType: String(item?.type ?? "").trim() || null,
      observedAt: nowIso(),
    });
    if (previousLabel === effectiveLabel) {
      return false;
    }
    const labels = sanitizeToolSummaryLabels(
      Array.from(state.entries.values()).map((entry) => entry?.label),
    );
    const emitted = this._emitNativeAssistantSectionEvent({
      binding: state.binding,
      localThreadId: state.localThreadId,
      localTurnId: state.localTurnId,
      section: "tool",
      text: `- ${effectiveLabel}`,
      turnStatus: "inProgress",
      itemId,
      itemType: String(item?.type ?? "").trim() || "tool",
      eventSubtype: "tool_item",
      toolSummaryLabels: labels,
      toolStateSummary: this._buildNativeToolStateSummary(state, labels, "inProgress"),
    });
    if (emitted) {
      state.lastEmittedText = labels.join("\n");
      state.lastEmittedStatus = "inProgress";
    }
    return emitted;
  }

  _handleNativeItemStartedNotification(notification) {
    return this._scheduleRolloutAssistantEventsForNativeNotification(notification, 120);
  }

  _handleNativeAssistantDeltaNotification(notification) {
    return this._scheduleRolloutAssistantEventsForNativeNotification(notification, 120);
  }

  _handleNativeReasoningSummaryDeltaNotification(notification) {
    return this._scheduleRolloutAssistantEventsForNativeNotification(notification, 120);
  }

  _handleNativeToolOutputDeltaNotification(notification) {
    return this._scheduleRolloutAssistantEventsForNativeNotification(notification, 200);
  }

  _handleNativeItemCompletedNotification(notification) {
    const item = notification?.params?.item;
    const itemType = String(item?.type ?? "").trim();
    if (["agentMessage", "reasoning"].includes(itemType) || this._isNativeToolItem(item)) {
      return this._scheduleRolloutAssistantEventsForNativeNotification(notification, 120);
    }
    if (!["agentMessage", "reasoning"].includes(itemType) && !this._isNativeToolItem(item)) {
      return false;
    }
    const localThreadId = this._getNativeNotificationThreadId(notification);
    const localTurnId = this._getNativeNotificationTurnId(notification);
    const itemId = this._getNativeNotificationItemId(notification);
    if (localThreadId == null || localTurnId == null) {
      return false;
    }
    if (this._isNativeToolItem(item)) {
      let emitted = false;
      for (const binding of this._getBindingsForNativeThread(localThreadId)) {
        emitted =
          this._updateNativeToolSummaryFromItem(
            binding,
            localThreadId,
            localTurnId,
            item,
          ) || emitted;
        this._markNativeBindingEventDriven(binding, {
          turnStatus: "inProgress",
          windowMs: 30000,
        });
      }
      this._scheduleNativeItemCompletionProbe(localThreadId, localTurnId);
      return emitted;
    }
    const completedText =
      itemType === "reasoning"
        ? this._extractNativeReasoningSummaryText(item)
        : this._extractNativeAgentMessageText(item);
    const section =
      itemType === "reasoning"
        ? "progress"
        : this._getNativeAgentMessageSection(notification, item);
    let emitted = false;
    for (const binding of this._getBindingsForNativeThread(localThreadId)) {
      const stream = this._getOrCreateNativeAssistantStream(
        binding,
        localThreadId,
        localTurnId,
        itemId,
        {
          section,
          itemType,
        },
      );
      if (stream == null) {
        continue;
      }
      if (completedText.trim()) {
        stream.text = completedText;
      }
      stream.itemCompleted = true;
      this._markNativeBindingEventDriven(binding, {
        turnStatus: "inProgress",
        windowMs: 30000,
      });
      if (stream.section === "final") {
        emitted = true;
        continue;
      }
      emitted = this._flushNativeAssistantStream(stream, { completed: false }) || emitted;
    }
    this._scheduleNativeItemCompletionProbe(localThreadId, localTurnId);
    return emitted;
  }

  _getNativeItemCompletionProbeKey(localThreadId, localTurnId) {
    const normalizedThreadId = normalizeConversationId(localThreadId) ?? null;
    const normalizedTurnId = normalizeConversationId(localTurnId) ?? null;
    if (normalizedThreadId == null || normalizedTurnId == null) {
      return null;
    }
    return `${normalizedThreadId}:${normalizedTurnId}`;
  }

  _clearNativeItemCompletionProbe(localThreadId, localTurnId) {
    const key = this._getNativeItemCompletionProbeKey(localThreadId, localTurnId);
    if (key == null || !(this.nativeItemCompletionProbeTimers instanceof Map)) {
      return false;
    }
    const record = this.nativeItemCompletionProbeTimers.get(key);
    const timer = record?.timer ?? record;
    if (timer != null) {
      clearTimeout(timer);
    }
    return this.nativeItemCompletionProbeTimers.delete(key);
  }

  _scheduleNativeItemCompletionProbe(localThreadId, localTurnId, options = {}) {
    const key = this._getNativeItemCompletionProbeKey(localThreadId, localTurnId);
    if (key == null) {
      return false;
    }
    if (!(this.nativeItemCompletionProbeTimers instanceof Map)) {
      this.nativeItemCompletionProbeTimers = new Map();
    }
    if (this.nativeItemCompletionProbeTimers.has(key)) {
      if (!options?.force) {
        return false;
      }
      this._clearNativeItemCompletionProbe(localThreadId, localTurnId);
    }
    const attempt = Math.max(0, Number(options?.attempt ?? 0) || 0);
    if (attempt >= NATIVE_ITEM_COMPLETION_PROBE_DELAYS_MS.length) {
      return false;
    }
    const delayMs = Math.max(
      250,
      Number(options?.delayMs) ||
        NATIVE_ITEM_COMPLETION_PROBE_DELAYS_MS[
          Math.min(attempt, NATIVE_ITEM_COMPLETION_PROBE_DELAYS_MS.length - 1)
        ],
    );
    const timer = setTimeout(() => {
      this.nativeItemCompletionProbeTimers?.delete?.(key);
      void this._runNativeItemCompletionProbe(localThreadId, localTurnId, { attempt }).catch(
        (error) => {
          this._log?.("warn", "Native item completion terminal probe failed", {
            localThreadId: normalizeConversationId(localThreadId) ?? null,
            localTurnId: normalizeConversationId(localTurnId) ?? null,
            reason: error instanceof Error ? error.message : String(error ?? "unknown_error"),
          });
        },
      );
    }, delayMs);
    if (timer != null && timer.unref instanceof Function) {
      timer.unref();
    }
    this.nativeItemCompletionProbeTimers.set(key, {
      timer,
      attempt,
      delayMs,
      scheduledAtMs: Date.now(),
    });
    return true;
  }

  _hasActiveNativeAssistantStreamForTurn(localThreadId, localTurnId) {
    const normalizedThreadId = normalizeConversationId(localThreadId) ?? null;
    const normalizedTurnId = normalizeConversationId(localTurnId) ?? null;
    if (normalizedThreadId == null || normalizedTurnId == null) {
      return false;
    }
    return Array.from(this.nativeAssistantStreams?.values?.() ?? []).some(
      (stream) =>
        normalizeConversationId(stream?.localThreadId) === normalizedThreadId &&
        normalizeConversationId(stream?.localTurnId) === normalizedTurnId,
    );
  }

  _scheduleNextNativeItemCompletionProbeIfActive(localThreadId, localTurnId, attempt) {
    if (!this._hasActiveNativeAssistantStreamForTurn(localThreadId, localTurnId)) {
      return false;
    }
    const nextAttempt = Math.max(0, Number(attempt ?? 0) || 0) + 1;
    if (nextAttempt >= NATIVE_ITEM_COMPLETION_PROBE_DELAYS_MS.length) {
      return false;
    }
    return this._scheduleNativeItemCompletionProbe(localThreadId, localTurnId, {
      attempt: nextAttempt,
    });
  }

  _completeNativeTurnStreams(localThreadId, localTurnId) {
    const normalizedThreadId = normalizeConversationId(localThreadId) ?? null;
    const normalizedTurnId = normalizeConversationId(localTurnId) ?? null;
    if (normalizedThreadId == null || normalizedTurnId == null) {
      return false;
    }
    let emitted = false;
    for (const stream of Array.from(this.nativeAssistantStreams?.values?.() ?? [])) {
      if (
        normalizeConversationId(stream.localThreadId) !== normalizedThreadId ||
        normalizeConversationId(stream.localTurnId) !== normalizedTurnId
      ) {
        continue;
      }
      emitted = this._flushNativeAssistantStream(stream, { completed: false }) || emitted;
      if (stream.timer != null) {
        clearTimeout(stream.timer);
        stream.timer = null;
      }
      this.nativeAssistantStreams.delete(stream.key);
    }
    for (const state of Array.from(this.nativeTurnToolSummaries?.values?.() ?? [])) {
      if (
        normalizeConversationId(state.localThreadId) !== normalizedThreadId ||
        normalizeConversationId(state.localTurnId) !== normalizedTurnId
      ) {
        continue;
      }
      emitted = this._emitNativeToolSummaryState(state, "inProgress") || emitted;
      this.nativeTurnToolSummaries.delete(state.key);
    }
    if (!emitted) {
      this._clearNativeItemCompletionProbe(normalizedThreadId, normalizedTurnId);
      return false;
    }
    for (const binding of this._getBindingsForNativeThread(normalizedThreadId)) {
      emitted =
        this._emitNativeAssistantSectionEvent({
          binding,
          localThreadId: normalizedThreadId,
          localTurnId: normalizedTurnId,
          section: "final",
          text: "",
          turnStatus: "completed",
          eventSubtype: "turn_completed",
          sourceCompleted: true,
          allowEmpty: true,
        }) || emitted;
      this._markNativeBindingEventDriven(binding, {
        turnStatus: "completed",
        windowMs: 30000,
      });
    }
    this._clearNativeItemCompletionProbe(normalizedThreadId, normalizedTurnId);
    return emitted;
  }

  async _runNativeItemCompletionProbe(localThreadId, localTurnId, options = {}) {
    const attempt = Math.max(0, Number(options?.attempt ?? 0) || 0);
    const normalizedThreadId = normalizeConversationId(localThreadId) ?? null;
    const normalizedTurnId = normalizeConversationId(localTurnId) ?? null;
    if (normalizedThreadId == null || normalizedTurnId == null) {
      return false;
    }
    const nativeThread = await this._readNativeThread(normalizedThreadId);
    if (nativeThread == null || !Array.isArray(nativeThread.turns)) {
      this._scheduleNextNativeItemCompletionProbeIfActive(
        normalizedThreadId,
        normalizedTurnId,
        attempt,
      );
      return false;
    }
    const targetTurn =
      nativeThread.turns.find(
        (turn) => normalizeConversationId(turn?.id) === normalizedTurnId,
      ) ?? null;
    if (normalizeNativeTurnStatus(targetTurn?.status) !== "completed") {
      this._scheduleNextNativeItemCompletionProbeIfActive(
        normalizedThreadId,
        normalizedTurnId,
        attempt,
      );
      return false;
    }
    return this._completeNativeTurnStreams(normalizedThreadId, normalizedTurnId);
  }

  async _handleNativeTurnCompletedNotification(notification) {
    const localThreadId = this._getNativeNotificationThreadId(notification);
    const localTurnId = this._getNativeNotificationTurnId(notification);
    if (localThreadId == null || localTurnId == null) {
      return false;
    }
    await this._emitRolloutAssistantEventsForNativeTurn(localThreadId, localTurnId, {
      sourceCompleted: true,
    });
    this._scheduleRolloutAssistantEventsForNativeNotification(notification, 800);
    return this._completeNativeTurnStreams(localThreadId, localTurnId);
  }

  _getFollowActivationEmissionKey(bindingId, localThreadId) {
    const normalizedBindingId = String(bindingId ?? "").trim();
    const normalizedThreadId = normalizeConversationId(localThreadId) ?? null;
    if (!normalizedBindingId || normalizedThreadId == null) {
      return null;
    }
    return `${normalizedBindingId}:${normalizedThreadId}`;
  }

  _rememberFollowActivationEmission(binding, localThreadId, { localTurnId = null } = {}) {
    const key = this._getFollowActivationEmissionKey(binding?.binding_id, localThreadId);
    if (key == null) {
      return false;
    }
    if (!(this.followActivationEmissions instanceof Map)) {
      this.followActivationEmissions = new Map();
    }
    this.followActivationEmissions.set(key, {
      localTurnId:
        normalizeConversationId(localTurnId) ??
        (String(localTurnId ?? "").trim() || null),
      expiresAtMs: Date.now() + Math.max(30000, this._getFollowCurrentNativeTurnWindowMs()),
    });
    this.nativeBindingPollState?.delete?.(binding.binding_id);
    return true;
  }

  _hasFollowActivationEmission(bindingId, localThreadId) {
    if (!(this.followActivationEmissions instanceof Map)) {
      return false;
    }
    const key = this._getFollowActivationEmissionKey(bindingId, localThreadId);
    if (key == null) {
      return false;
    }
    const marker = this.followActivationEmissions.get(key);
    if (marker == null) {
      return false;
    }
    if (Number(marker.expiresAtMs ?? 0) <= Date.now()) {
      this.followActivationEmissions.delete(key);
      return false;
    }
    return true;
  }

  _consumeFollowActivationEntries(bindingId, localThreadId, entries) {
    if (!(this.followActivationEmissions instanceof Map)) {
      return [];
    }
    const key = this._getFollowActivationEmissionKey(bindingId, localThreadId);
    if (key == null) {
      return [];
    }
    const marker = this.followActivationEmissions.get(key);
    if (marker == null) {
      return [];
    }
    if (Number(marker.expiresAtMs ?? 0) <= Date.now()) {
      this.followActivationEmissions.delete(key);
      return [];
    }
    const normalizedTurnId = normalizeConversationId(marker.localTurnId) ?? null;
    const selected = (Array.isArray(entries) ? entries : []).filter((entry) => {
      if (normalizedTurnId == null) {
        return true;
      }
      return normalizeConversationId(entry?.message?.turnId) === normalizedTurnId;
    });
    if (selected.length > 0) {
      this.followActivationEmissions.delete(key);
    }
    return selected;
  }

  _rebindFollowCurrentThread(binding, localThreadId) {
    const normalizedThreadId = normalizeConversationId(localThreadId);
    if (binding == null || normalizedThreadId == null) {
      return binding;
    }
    if (this._isBindingResumeRebindLocked(binding.binding_id)) {
      return binding;
    }
    const rebound = this.store.upsertBinding({
      bindingId: binding.binding_id,
      feishuOpenId: binding.feishu_open_id,
      feishuChatId: binding.feishu_chat_id,
      localThreadId: normalizedThreadId,
      localConversationId: normalizedThreadId,
      contextVersion: binding.context_version,
      followCurrentThread: true,
    });
    this.nativeBindingPollState?.delete?.(binding.binding_id);
    return rebound;
  }

  _getNativePollTargetThreadId(binding) {
    return normalizeConversationId(binding?.local_thread_id);
  }

  async _refreshFollowCurrentBindingTarget(binding) {
    return binding;
  }

  async bindCurrentThread({
    feishuOpenId,
    feishuChatId,
    followCurrentThread = true,
    localThreadId = null,
    localConversationId = null,
  }) {
    const resolvedThreadId =
      normalizeConversationId(localThreadId) ??
      normalizeConversationId(localConversationId) ??
      null;
    if (resolvedThreadId == null) {
      throw new Error("explicit_thread_id_required_for_screenless_binding");
    }
    const binding = this.store.upsertBinding({
      feishuOpenId,
      feishuChatId,
      localThreadId: resolvedThreadId,
      localConversationId: resolvedThreadId,
      contextVersion: 1,
      followCurrentThread,
    });
    this._refreshNativeTurnNotificationHook();
    this._publishSharedState();
    return {
      ok: true,
      binding,
      activeThread: {
        localThreadId: resolvedThreadId,
        localConversationId: resolvedThreadId,
        resolutionSource: "explicit",
      },
    };
  }

  async resolveBinding({ bindingId, feishuOpenId, feishuChatId }) {
    if (bindingId) {
      return this.store.getBindingById(bindingId);
    }
    if (feishuOpenId && feishuChatId) {
      return this.store.getBindingByUser(feishuOpenId, feishuChatId);
    }
    return null;
  }

  async unbind({ bindingId, feishuOpenId, feishuChatId }) {
    const binding =
      (bindingId ? this.store.getBindingById(bindingId) : null) ??
      (feishuOpenId && feishuChatId
        ? this.store.getBindingByUser(feishuOpenId, feishuChatId)
        : null);
    if (binding == null) {
      return { ok: true, removed: false };
    }
    this.store.db.prepare(`DELETE FROM bindings WHERE binding_id = ?`).run(binding.binding_id);
    this._refreshNativeTurnNotificationHook();
    return { ok: true, removed: true, bindingId: binding.binding_id };
  }

  async exportContextBundle({ bindingId }) {
    const binding = this.store.getBindingById(bindingId);
    if (binding == null) {
      throw new Error("binding_not_found");
    }
    const nativeThread = await this._readNativeThread(binding.local_thread_id);
    if (nativeThread != null) {
      const bundle = this._buildNativeContextBundle(binding, nativeThread);
      return bundle;
    }
    throw new Error("native_thread_unavailable_screenless_bridge");
  }

  async submitInboundFeishuMessage({
    bindingId,
    feishuOpenId,
    feishuChatId,
    providerMessageId,
    text,
    attachments,
    rawEvent,
  }) {
    const normalizedAttachments = Array.isArray(attachments)
      ? attachments.filter((attachment) => attachment != null && typeof attachment === "object")
      : [];
    const inboundRawPayload = {
      event: rawEvent ?? null,
      attachments: normalizedAttachments,
    };
    const existingLedger = this.store.getMessageLedger("feishu", providerMessageId);
    if (existingLedger?.status === "local_committed") {
      const existingBinding =
        this.store.getBindingById(existingLedger.binding_id) ??
        ((feishuOpenId && feishuChatId)
          ? this.store.getBindingByUser(feishuOpenId, feishuChatId)
          : null);
      return {
        ok: true,
        duplicate: true,
        binding: existingBinding ?? null,
        ledgerId: existingLedger.id,
        submission: {
          ok: true,
          deduped: true,
          localThreadId: existingBinding?.local_thread_id ?? null,
          localConversationId: existingBinding?.local_conversation_id ?? null,
          localTurnId: existingLedger.local_turn_id ?? null,
        },
      };
    }
    if (existingLedger != null) {
      const existingBinding =
        this.store.getBindingById(existingLedger.binding_id) ??
        ((feishuOpenId && feishuChatId)
          ? this.store.getBindingByUser(feishuOpenId, feishuChatId)
          : null);
      const terminalLedger =
        existingLedger.status === "failed"
          ? existingLedger
          : this.store.updateInboundLedgerStatus(providerMessageId, "failed", null) ?? {
              ...existingLedger,
              status: "failed",
              local_turn_id: null,
            };
      return {
        ok: true,
        duplicate: true,
        terminal: true,
        binding: existingBinding ?? null,
        ledgerId: terminalLedger.id,
        submission: {
          ok: true,
          deduped: true,
          localCommitSkipped: true,
          localThreadId: existingBinding?.local_thread_id ?? null,
          localConversationId: existingBinding?.local_conversation_id ?? null,
          localTurnId: terminalLedger.local_turn_id ?? null,
          ledgerStatus: terminalLedger.status ?? "failed",
        },
      };
    }

    let pendingAction = null;
    let binding =
      (bindingId ? this.store.getBindingById(bindingId) : null) ??
      (feishuOpenId && feishuChatId
        ? this.store.getBindingByUser(feishuOpenId, feishuChatId)
        : null);
    let ledger = null;
    try {
      const nativeClient = this._getNativeAppServerClient();
      if (nativeClient == null) {
        throw new Error("native_app_server_required_for_screenless_bridge");
      }
      // Follow-current rebinding is owned by desktop submit / native turn-start
      // signals. A Feishu inbound message must not retarget itself just because
      // the user is viewing an old desktop conversation.

      if (binding != null) {
        ledger =
          existingLedger ??
          this.store.insertInboundLedger({
            providerMessageId,
            bindingId: binding.binding_id,
            text,
            rawEvent: inboundRawPayload,
            status: "pending_local_commit",
          });
      } else {
        pendingAction = this.store.recordPendingAction(
          "pending_local_commit",
          null,
          {
            phase: "bootstrap_binding",
            providerMessageId,
            text,
            attachments: normalizedAttachments,
            rawEvent,
            feishuOpenId,
            feishuChatId,
          },
          null,
        );
      }

      const submission = await this._submitInboundViaNative({
        binding,
        text,
        attachments: normalizedAttachments,
      });
      if (!submission?.ok) {
        throw new Error(submission?.error ?? "local_submit_failed");
      }
      this.recentInboundActivityAtMs = Date.now();

      const resolvedThread =
        submission.localThreadId ??
        submission.localConversationId ??
        binding?.local_thread_id ??
        null;

      if (binding == null) {
        if (!resolvedThread) {
          throw new Error("local_thread_id_unresolved_after_submit");
        }
        binding = this.store.upsertBinding({
          feishuOpenId,
          feishuChatId,
          localThreadId: resolvedThread,
          localConversationId: submission.localConversationId ?? resolvedThread,
          contextVersion: 1,
          followCurrentThread: true,
        });
        ledger =
          existingLedger ??
          this.store.insertInboundLedger({
            providerMessageId,
            bindingId: binding.binding_id,
            text,
            rawEvent: inboundRawPayload,
            status: "pending_local_commit",
          });
      }

      this.store.updateInboundLedgerStatus(
        providerMessageId,
        "local_committed",
        submission.localTurnId ?? null,
      );
      if (pendingAction != null) {
        this.store.completePendingAction(pendingAction.id, {
          phase: "bootstrap_binding_completed",
          providerMessageId,
          bindingId: binding.binding_id,
          localThreadId: binding.local_thread_id,
        });
      }
      try {
        this._rememberInboundEcho(binding.binding_id, {
          text,
          attachments: normalizedAttachments,
          turnId: submission.localTurnId ?? null,
        });
      } catch (error) {
        this._recordError(error);
      }
      return {
        ok: true,
        binding,
        ledgerId: ledger?.id ?? this.store.getMessageLedger("feishu", providerMessageId)?.id ?? null,
        submission: {
          ...submission,
          localThreadId:
            submission.localThreadId ??
            binding?.local_thread_id ??
            resolvedThread ??
            null,
          localConversationId:
            submission.localConversationId ??
            binding?.local_conversation_id ??
            resolvedThread ??
            null,
        },
      };
    } catch (error) {
      const persistedBinding =
        binding ??
        (bindingId ? this.store.getBindingById(bindingId) : null) ??
        (feishuOpenId && feishuChatId
          ? this.store.getBindingByUser(feishuOpenId, feishuChatId)
          : null);
      if (ledger != null) {
        this.store.updateInboundLedgerStatus(
          providerMessageId,
          "failed",
          null,
        );
      }
      if (pendingAction != null) {
        this.store.completePendingAction(pendingAction.id, {
          ...pendingAction.payload_json,
          bindingId: persistedBinding?.binding_id ?? null,
          providerMessageId,
          reason: "local_commit_failed_no_replay",
          error: error.message,
        });
      }
      this._recordError(error);
      return {
        ok: false,
        binding: persistedBinding ?? null,
        error: error.message,
      };
    }
  }

  async debugSubmitProbe({
    text,
    expectedThreadId = null,
    waitForThreadTimeoutMs = 5000,
  }) {
    const activeThreadBefore = await this._getNavigationActiveThread({
      expectedConversationId: expectedThreadId,
    });
    const probe = await this.rendererAdapter.probeSubmitPath({
      text,
      expectedThreadId,
      waitForThreadTimeoutMs,
    });
    const activeThreadAfter = await this._getNavigationActiveThread({
      expectedConversationId: expectedThreadId,
    });
    return {
      ok: true,
      activeThreadBefore,
      probe,
      activeThreadAfter,
    };
  }

  async debugOpenNewThreadSurface({ waitForThreadTimeoutMs = 5000 } = {}) {
    const activeThreadBefore = await this.getActiveThread();
    const result = await this.rendererAdapter.openNewThreadSurface({
      waitForThreadTimeoutMs,
    });
    const activeThreadAfter = await this.getActiveThread();
    return {
      ok: true,
      activeThreadBefore,
      result,
      activeThreadAfter,
    };
  }

  async debugTriggerNewThreadShortcut({ settleMs = 2500 } = {}) {
    const window = this.windowAccess.getPreferredWindow();
    if (window == null || window.isDestroyed()) {
      throw new Error("no_window_available");
    }
    const activeThreadBefore = await this.getActiveThread();
    const webContents = window.webContents;
    webContents.focus();
    for (const type of ["keyDown", "char", "keyUp"]) {
      webContents.sendInputEvent({
        type,
        keyCode: "N",
        modifiers: ["control"],
      });
    }
    await new Promise((resolve) => setTimeout(resolve, Math.max(250, settleMs)));
    const activeThreadAfter = await this.getActiveThread();
    return {
      ok: true,
      activeThreadBefore,
      activeThreadAfter,
    };
  }

  async debugProbeUiAction({ action, label = null, settleMs = 1500 } = {}) {
    const activeThreadBefore = await this.getActiveThread();
    const probe = await this.rendererAdapter.probeUiAction({
      action,
      label,
      settleMs,
    });
    const activeThreadAfter = await this.getActiveThread();
    return {
      ok: true,
      activeThreadBefore,
      probe,
      activeThreadAfter,
    };
  }

  async debugInvokeElectronBridgeMessage({ message, settleMs = 1500 } = {}) {
    const activeThreadBefore = await this.getActiveThread();
    const probe = await this.rendererAdapter.invokeElectronBridgeMessage({
      message,
      settleMs,
    });
    const activeThreadAfter = await this.getActiveThread();
    return {
      ok: true,
      activeThreadBefore,
      probe,
      activeThreadAfter,
    };
  }

  async debugInspectProcessHandles() {
    const bootstrapContext = global.__codexBootstrapContext ?? null;
    const mainModule = global.__codexMainModule ?? null;
    const runtimeHandles = global.__codexRuntimeHandles ?? null;
    const messageHandler =
      runtimeHandles?.getMessageHandler instanceof Function
        ? runtimeHandles.getMessageHandler()
        : null;
    const localHostContext = runtimeHandles?.localHostContext ?? null;
    const applicationMenuManager = runtimeHandles?.applicationMenuManager ?? null;
    const windowServices = runtimeHandles?.windowServices ?? null;
    return {
      ok: true,
      bootstrapContext: this._describeDebugValue(bootstrapContext),
      bootstrapContextEntries: this._describeObjectEntries(bootstrapContext),
      mainModule: this._describeDebugValue(mainModule),
      mainModuleEntries: this._describeObjectEntries(mainModule, 96),
      runtimeHandles: this._describeDebugValue(runtimeHandles),
      runtimeHandleEntries: this._describeObjectEntries(runtimeHandles, 96),
      runtimeHandlePrototypeMethods: this._describePrototypeMethods(runtimeHandles),
      localHostContext: this._describeDebugValue(localHostContext),
      localHostContextEntries: this._describeObjectEntries(localHostContext, 96),
      localHostContextPrototypeMethods: this._describePrototypeMethods(
        localHostContext,
        128,
      ),
      applicationMenuManager: this._describeDebugValue(applicationMenuManager),
      applicationMenuManagerEntries: this._describeObjectEntries(
        applicationMenuManager,
        96,
      ),
      applicationMenuManagerPrototypeMethods: this._describePrototypeMethods(
        applicationMenuManager,
        128,
      ),
      windowServices: this._describeDebugValue(windowServices),
      windowServicesEntries: this._describeObjectEntries(windowServices, 96),
      windowServicesPrototypeMethods: this._describePrototypeMethods(
        windowServices,
        128,
      ),
      messageHandler: this._describeDebugValue(messageHandler),
      messageHandlerEntries: this._describeObjectEntries(messageHandler, 128),
      messageHandlerPrototypeMethods: this._describePrototypeMethods(
        messageHandler,
        192,
      ),
    };
  }

  async debugInspectObjectPath({ path, limit = 96 } = {}) {
    const resolved = this._resolveDebugPath(path);
    return {
      ok: true,
      path: resolved.path,
      resolvedSegments: resolved.segments,
      value: this._describeDebugValue(resolved.value),
      entries: this._describeObjectEntries(resolved.value, limit),
      prototypeMethods: this._describePrototypeMethods(resolved.value, 192),
      sanitized: this._sanitizeForRpc(resolved.value, 2),
    };
  }

  async debugListInvokeHandlers() {
    const channels = Array.from(this.handlerRegistry.invokeHandlers.keys()).sort();
    return {
      ok: true,
      count: channels.length,
      channels,
    };
  }

  async debugSendMessageForView({ message, settleMs = 1500 } = {}) {
    const window = this.windowAccess.getPreferredWindow();
    if (window == null || window.isDestroyed()) {
      throw new Error("no_window_available");
    }
    const activeThreadBefore = await this.getActiveThread();
    window.webContents.send("codex_desktop:message-for-view", message);
    await new Promise((resolve) => setTimeout(resolve, Math.max(250, settleMs)));
    const activeThreadAfter = await this.getActiveThread();
    return {
      ok: true,
      activeThreadBefore,
      activeThreadAfter,
      message,
    };
  }

  async debugCopyCurrentSessionId({ settleMs = 500 } = {}) {
    const activeThreadBefore = await this._getRendererActiveThread().catch(() => null);
    const copiedSessionId = await this._copyCurrentSessionId(settleMs);
    const activeThreadAfter = await this._getRendererActiveThread().catch(() => null);
    return {
      ok: copiedSessionId != null,
      copiedSessionId,
      activeThreadBefore: this._decorateResolvedThread(
        activeThreadBefore,
        copiedSessionId,
        "clipboard_copy_session_id",
      ),
      activeThreadAfter: this._decorateResolvedThread(
        activeThreadAfter,
        copiedSessionId,
        "clipboard_copy_session_id",
      ),
    };
  }

  async debugGetThreadRole({
    conversationId = null,
    settleMs = 500,
  } = {}) {
    const window = this._getPreferredWindowOrThrow();
    const resolvedConversationId = await this._resolveConversationId(
      conversationId,
      settleMs,
    );
    if (resolvedConversationId == null) {
      throw new Error("conversation_id_unavailable");
    }
    const messageHandler = global.__codexRuntimeHandles?.getMessageHandler?.() ?? null;
    if (messageHandler == null) {
      throw new Error("message_handler_unavailable");
    }
    const role = await messageHandler.getThreadRole(
      window.webContents,
      resolvedConversationId,
    );
    return {
      ok: true,
      conversationId: resolvedConversationId,
      role,
    };
  }

  async debugNavigateToRoute({
    route,
    settleMs = 1500,
    focusWindow = true,
  } = {}) {
    if (route == null) {
      throw new Error("route_required");
    }
    const window = this._getPreferredWindowOrThrow();
    const applicationMenuManager =
      global.__codexRuntimeHandles?.applicationMenuManager ?? null;
    const navigateToRoute =
      applicationMenuManager?.navigateToRoute instanceof Function
        ? applicationMenuManager.navigateToRoute.bind(applicationMenuManager)
        : null;
    if (navigateToRoute == null) {
      throw new Error("application_menu_manager_unavailable");
    }
    if (focusWindow) {
      window.isMinimized?.() && window.restore?.();
      window.show?.();
      window.focus?.();
    }
    const normalizedRoute = this._normalizeRoute(route);
    const expectedConversationId =
      typeof normalizedRoute === "object" &&
      normalizedRoute?.kind === "localConversation"
        ? normalizeConversationId(normalizedRoute.conversationId)
        : null;
    const activeThreadBefore = await this._getNavigationActiveThread({
      expectedConversationId,
    });
    const candidates = [normalizedRoute];
    if (
      normalizedRoute != null &&
      typeof normalizedRoute === "object" &&
      normalizedRoute.kind === "localConversation" &&
      normalizedRoute.conversationId
    ) {
      candidates.push(`/local/${normalizedRoute.conversationId}`);
    }
    const errors = [];
    let usedCandidate = null;
    let activeThreadAfter = null;
    for (const candidate of candidates) {
      try {
        await Promise.resolve(navigateToRoute(window, candidate));
      } catch (error) {
        errors.push(
          error instanceof Error ? error.message : String(error),
        );
        continue;
      }
      await sleep(Math.max(250, settleMs));
      activeThreadAfter = await this._getNavigationActiveThread({
        expectedConversationId,
      });
      if (
        expectedConversationId != null &&
        !this._isRendererOnThread(activeThreadAfter, expectedConversationId)
      ) {
        const candidateDescription =
          typeof candidate === "string" ? candidate : JSON.stringify(candidate);
        errors.push(`route_candidate_mismatch:${candidateDescription}`);
        continue;
      }
      usedCandidate = candidate;
      break;
    }
    if (usedCandidate == null) {
      throw new Error(
        `navigate_to_route_failed:${errors.join(" | ") || "unknown_error"}`,
      );
    }
    const localConversationId =
      typeof normalizedRoute === "object" &&
      normalizedRoute?.kind === "localConversation"
        ? normalizedRoute.conversationId
        : normalizeConversationId(activeThreadAfter?.localConversationId);
    let roleAfter = null;
    if (localConversationId) {
      try {
        roleAfter = await this.debugGetThreadRole({
          conversationId: localConversationId,
          settleMs: Math.min(500, settleMs),
        });
      } catch (error) {
        roleAfter = {
          ok: false,
          error: error instanceof Error ? error.message : String(error),
        };
      }
    }
    return {
      ok: true,
      route: normalizedRoute,
      usedCandidate,
      activeThreadBefore,
      activeThreadAfter,
      roleAfter,
    };
  }

  async debugNavigateToLocalConversation({
    conversationId = null,
    settleMs = 1500,
  } = {}) {
    const resolvedConversationId = await this._resolveConversationId(
      conversationId,
      settleMs,
    );
    if (resolvedConversationId == null) {
      throw new Error("conversation_id_unavailable");
    }
    return this.debugNavigateToRoute({
      route: {
        kind: "localConversation",
        conversationId: resolvedConversationId,
      },
      settleMs,
    });
  }

  async _getNavigationActiveThread({ expectedConversationId = null } = {}) {
    const normalizedExpectedConversationId =
      normalizeConversationId(expectedConversationId);
    const rendererActive = await this._getRendererActiveThread().catch(() => null);
    if (rendererActive != null) {
      return rendererActive;
    }
    if (normalizedExpectedConversationId != null) {
      return null;
    }
    return this.getActiveThread({ publishSharedState: false }).catch(() => null);
  }

  async debugNavigateToNewThread({
    prompt = null,
    path = null,
    originUrl = null,
    settleMs = 1500,
  } = {}) {
    return this.debugNavigateToRoute({
      route: {
        kind: "newThread",
        ...(prompt == null ? {} : { prompt: String(prompt) }),
        ...(path == null ? {} : { path: String(path) }),
        ...(originUrl == null ? {} : { originUrl: String(originUrl) }),
      },
      settleMs,
    });
  }

  async debugCallObjectMethod({
    path,
    method = null,
    args = [],
    settleMs = 250,
  } = {}) {
    const resolved = this._resolveDebugPath(path);
    const target = resolved.value;
    const callable =
      method == null ? target : target?.[String(method)];
    if (!(callable instanceof Function)) {
      throw new Error(
        `debug_method_unavailable:${resolved.path}${
          method == null ? "" : `.${String(method)}`
        }`,
      );
    }
    const boundThis = method == null ? null : target;
    const resolvedArgs = this._resolveDebugArgs(args);
    const activeThreadBefore = await this.getActiveThread().catch(() => null);
    const result = await Promise.resolve(
      callable.apply(boundThis, resolvedArgs),
    );
    if (settleMs > 0) {
      await sleep(Math.max(0, settleMs));
    }
    const activeThreadAfter = await this.getActiveThread().catch(() => null);
    return {
      ok: true,
      path: resolved.path,
      method: method == null ? null : String(method),
      argsSummary: resolvedArgs.map((entry) => this._describeDebugValue(entry)),
      result: this._sanitizeForRpc(result, 3),
      resultSummary: this._describeDebugValue(result),
      activeThreadBefore,
      activeThreadAfter,
    };
  }

  async listPendingTurns() {
    return this.store.listPendingActions();
  }

  _getPreferredWindowOrThrow() {
    const window = this.windowAccess.getPreferredWindow();
    if (window == null || window.isDestroyed()) {
      throw new Error("no_window_available");
    }
    return window;
  }

  async _resolveConversationId(conversationId = null, settleMs = 500) {
    void settleMs;
    const direct = normalizeConversationId(conversationId);
    if (direct) {
      return direct;
    }
    return null;
  }

  async _getRendererActiveThread() {
    const active = await this.rendererAdapter.getActiveThread();
    if (active == null || typeof active !== "object") {
      return active;
    }
    return { ...active };
  }

  async _copyCurrentSessionId(settleMs = 500) {
    const window = this._getPreferredWindowOrThrow();
    const clipboard = this.electron.clipboard;
    const previousText = clipboard.readText();
    try {
      window.webContents.send("codex_desktop:message-for-view", {
        type: "copy-session-id",
      });
      await new Promise((resolve) =>
        setTimeout(resolve, Math.max(250, settleMs)),
      );
      return normalizeConversationId(clipboard.readText().trim() || null);
    } finally {
      clipboard.writeText(previousText ?? "");
    }
  }

  _decorateResolvedThread(activeThread, threadId, source) {
    if (activeThread == null || typeof activeThread !== "object") {
      return activeThread;
    }
    const normalizedThreadId = normalizeConversationId(threadId);
    if (normalizedThreadId == null) {
      return { ...activeThread };
    }
    return {
      ...activeThread,
      localThreadId:
        normalizeConversationId(activeThread.localThreadId) ?? normalizedThreadId,
      localConversationId:
        normalizeConversationId(activeThread.localConversationId) ??
        normalizedThreadId,
      resolutionSource: source,
    };
  }

  _normalizeRoute(route) {
    if (typeof route === "string") {
      return route;
    }
    if (route == null || typeof route !== "object") {
      throw new Error("invalid_route_payload");
    }
    if (route.kind === "localConversation") {
      const conversationId = normalizeConversationId(route.conversationId);
      if (conversationId == null) {
        throw new Error("conversation_id_unavailable");
      }
      return {
        kind: "localConversation",
        conversationId,
      };
    }
    if (route.kind === "newThread") {
      return {
        kind: "newThread",
        ...(route.prompt == null ? {} : { prompt: String(route.prompt) }),
        ...(route.path == null ? {} : { path: String(route.path) }),
        ...(route.originUrl == null
          ? {}
          : { originUrl: String(route.originUrl) }),
      };
    }
    return { ...route };
  }

  _getNativeAppServerClient() {
    const client = global.__codexRuntimeHandles?.localHostContext?.appServerClient ?? null;
    if (
      client != null &&
      client.startThread instanceof Function &&
      client.startTurn instanceof Function &&
      client.readThread instanceof Function
    ) {
      return client;
    }
    return null;
  }

  _getDefaultNativeCwd() {
    return (
      this._getNativeAppServerClient()?.options?.repoRoot ??
      this.paths?.bridgeRoot ??
      process.cwd()
    );
  }

  async _readNativeThread(threadId) {
    const normalizedThreadId = normalizeConversationId(threadId);
    if (normalizedThreadId == null) {
      return null;
    }
    const client = this._getNativeAppServerClient();
    if (client == null) {
      return null;
    }
    try {
      return await client.readThread(normalizedThreadId, {
        includeTurns: true,
      });
    } catch {
      return null;
    }
  }

  async _readNativeThreadMetadata(threadId) {
    const normalizedThreadId = normalizeConversationId(threadId);
    if (normalizedThreadId == null) {
      return null;
    }
    const client = this._getNativeAppServerClient();
    if (client == null) {
      return null;
    }
    try {
      return await client.readThread(normalizedThreadId, {
        includeTurns: false,
      });
    } catch {
      return null;
    }
  }

  _isRendererOnThread(activeThread, targetThreadId) {
    const normalizedTarget = normalizeConversationId(targetThreadId);
    if (normalizedTarget == null || activeThread == null || typeof activeThread !== "object") {
      return false;
    }
    const activeThreadId =
      normalizeConversationId(activeThread.localThreadId) ??
      normalizeConversationId(activeThread.localConversationId);
    if (activeThreadId === normalizedTarget) {
      return true;
    }
    const urlText = `${String(activeThread.pathname ?? "")} ${String(activeThread.url ?? "")}`;
    return (
      urlText.includes(`/local/${normalizedTarget}`) ||
      urlText.includes(`/thread/${normalizedTarget}`) ||
      urlText.includes(`conversationId=${encodeURIComponent(normalizedTarget)}`) ||
      urlText.includes(`chat=${encodeURIComponent(normalizedTarget)}`)
    );
  }

  _parseDataUrlMetadata(value) {
    const raw = String(value ?? "").trim();
    const match = raw.match(/^data:([^;,]+)?(?:;charset=[^;,]+)?(?:;base64)?,/i);
    if (!match) {
      return null;
    }
    return {
      mimeType: String(match[1] ?? "").trim() || null,
    };
  }

  _looksLikeAbsoluteLocalPath(value) {
    const raw = String(value ?? "").trim();
    if (!raw) {
      return false;
    }
    return /^[A-Za-z]:[\\/]/.test(raw) || /^\\\\[^\\]/.test(raw) || /^file:/i.test(raw);
  }

  _isLikelyImagePath(value) {
    const extension = path.extname(String(value ?? "").trim()).toLowerCase();
    return [
      ".png",
      ".jpg",
      ".jpeg",
      ".gif",
      ".webp",
      ".bmp",
      ".svg",
      ".avif",
      ".heic",
      ".heif",
      ".tif",
      ".tiff",
    ].includes(extension);
  }

  _normalizeNativeAttachment(content, context) {
    if (content == null || typeof content !== "object") {
      return null;
    }
    const contentType = String(content.type ?? content.kind ?? "").trim().toLowerCase();
    const sourcePath =
      String(
        content.path ??
          content.fs_path ??
          content.fsPath ??
          content.file_path ??
          content.filePath ??
          content.local_path ??
          content.localPath ??
          content.source_path ??
          content.sourcePath ??
          "",
      ).trim() || null;
    const rawUri = String(content.uri ?? "").trim() || null;
    const uriIsUrl = rawUri != null && /^(?:file|https?):/i.test(rawUri);
    const normalizedSourcePath = sourcePath ?? (rawUri && !uriIsUrl ? rawUri : null);
    const sourceUrl =
      String(
        content.url ??
          content.file_url ??
          content.fileUrl ??
          content.source_url ??
          content.sourceUrl ??
          "",
      ).trim() ||
      (uriIsUrl ? rawUri : null);
    const dataUrl =
      String(
        content.image_url ??
          content.data_url ??
          content.dataUrl ??
          content.src ??
          "",
      ).trim() ||
      null;
    const dataUrlMeta = dataUrl ? this._parseDataUrlMetadata(dataUrl) : null;
    const mimeType =
      String(
        content.mime_type ??
          content.mimeType ??
          content.mimetype ??
          dataUrlMeta?.mimeType ??
          "",
      ).trim() ||
      null;
    const imageLikePath = this._isLikelyImagePath(
      normalizedSourcePath ?? sourceUrl ?? content.name ?? content.label,
    );
    const inferredKind =
      contentType.includes("image") ||
      String(mimeType ?? "").startsWith("image/") ||
      imageLikePath
        ? "image"
        : normalizedSourcePath != null ||
            sourceUrl != null ||
            dataUrl != null ||
            contentType.includes("file")
          ? "file"
          : null;
    if (inferredKind == null) {
      return null;
    }
    const name =
      String(
        content.file_name ??
          content.fileName ??
          content.filename ??
          content.name ??
          content.label ??
          (normalizedSourcePath ? path.basename(normalizedSourcePath) : ""),
      ).trim() || null;
    return {
      kind: inferredKind,
      contentType: contentType || null,
      name,
      mimeType,
      sourceType: normalizedSourcePath
        ? "path"
        : dataUrl
          ? "data_url"
          : sourceUrl
            ? "url"
            : "opaque",
      sourcePath: normalizedSourcePath,
      sourceUrl,
      dataUrl,
      order: context?.contentIndex ?? null,
      turnId: context?.turnId ?? null,
      turnIndex: context?.turnIndex ?? null,
      itemIndex: context?.itemIndex ?? null,
    };
  }

  _buildNativeAttachmentDedupKey(attachment) {
    if (attachment == null || typeof attachment !== "object") {
      return null;
    }
    const kind = String(attachment.kind ?? "").trim().toLowerCase() || "unknown";
    const sourcePath = String(attachment.sourcePath ?? "").trim();
    if (sourcePath) {
      return `path:${kind}:${sourcePath.toLowerCase()}`;
    }
    const sourceUrl = String(attachment.sourceUrl ?? "").trim();
    if (sourceUrl) {
      return `url:${kind}:${sourceUrl}`;
    }
    const dataUrl = String(attachment.dataUrl ?? "").trim();
    if (dataUrl) {
      return `data:${kind}:${String(attachment.mimeType ?? "").trim()}:${dataUrl.slice(0, 256)}`;
    }
    const name = String(attachment.name ?? "").trim();
    if (name) {
      return `name:${kind}:${name.toLowerCase()}:${String(attachment.mimeType ?? "").trim()}`;
    }
    return `fallback:${kind}:${attachment.turnId ?? ""}:${attachment.itemIndex ?? ""}:${attachment.order ?? ""}`;
  }

  _dedupeNativeAttachments(attachments) {
    const deduped = [];
    const seen = new Set();
    for (const attachment of Array.isArray(attachments) ? attachments : []) {
      const key = this._buildNativeAttachmentDedupKey(attachment);
      if (key == null || seen.has(key)) {
        continue;
      }
      seen.add(key);
      deduped.push(attachment);
    }
    return deduped;
  }

  _extractNativeMessageAttachments(contentList, context) {
    if (!Array.isArray(contentList)) {
      return [];
    }
    return contentList
      .map((content, contentIndex) =>
        this._normalizeNativeAttachment(content, {
          ...context,
          contentIndex,
        }),
      )
      .filter(Boolean);
  }

  _parseNativeMentionedFilesFromText(text, context) {
    const raw = String(text ?? "");
    if (!raw) {
      return [];
    }
    const filesHeaderMatch = raw.match(
      /(?:^|\r?\n)#\s+Files mentioned by the user:\s*(?:\r?\n|$)/i,
    );
    if (!filesHeaderMatch) {
      return [];
    }
    const filesSectionStart = (filesHeaderMatch.index ?? 0) + filesHeaderMatch[0].length;
    const requestMarkerIndex = raw.indexOf("## My request for Codex:", filesSectionStart);
    const filesSection =
      requestMarkerIndex >= 0
        ? raw.slice(filesSectionStart, requestMarkerIndex)
        : raw.slice(filesSectionStart);
    const attachments = [];
    for (const line of filesSection.split(/\r?\n/)) {
      const match = line.match(
        /^##\s+(.+?):\s+(.+?)\s*(?:\((?:lines?\s+\d+(?:-\d+)?)\))?\s*$/i,
      );
      if (!match?.[2]) {
        continue;
      }
      const sourcePath = String(match[2]).trim();
      if (!this._looksLikeAbsoluteLocalPath(sourcePath)) {
        continue;
      }
      const label = String(match[1] ?? "").trim() || path.basename(sourcePath);
      attachments.push(
        this._normalizeNativeAttachment(
          {
            type: this._isLikelyImagePath(sourcePath) ? "image" : "file",
            path: sourcePath,
            file_name: label,
          },
          context,
        ),
      );
    }
    return attachments.filter(Boolean);
  }

  _extractNativeUserMessageAttachments({ item, rawContent, formattedText, context }) {
    const extracted = [
      ...this._extractNativeMessageAttachments(rawContent, context),
      ...this._extractNativeMessageAttachments(
        Array.isArray(item?.attachments) ? item.attachments : [],
        context,
      ),
      ...this._parseNativeMentionedFilesFromText(formattedText, context),
    ];
    return this._dedupeNativeAttachments(extracted);
  }

  _extractNativeRequestBody(text) {
    const raw = String(text ?? "").trim();
    if (!raw) {
      return raw;
    }
    const marker = "## My request for Codex:";
    const markerIndex = raw.lastIndexOf(marker);
    if (markerIndex === -1) {
      return raw;
    }
    return raw.slice(markerIndex + marker.length).trim();
  }

  _stripNativeAttachmentPlaceholders(text, attachments) {
    let normalized = String(text ?? "").trim();
    if (!normalized) {
      return normalized;
    }
    if (Array.isArray(attachments) && attachments.length > 0) {
      normalized = normalized.replace(
        /(?:^|\r?\n)#\s+Files mentioned by the user:\s*[\s\S]*?(?=\r?\n##\s+My request for Codex:|$)/i,
        "",
      );
      normalized = this._extractNativeRequestBody(normalized);
    }
    if (!Array.isArray(attachments) || attachments.length === 0) {
      return normalized;
    }
    normalized = normalized
      .replace(/(?:\r?\n)*\[[^\]\r\n]*附件已省略\]/g, "")
      .replace(
        /(?:^|\r?\n)(?:localimage|image|localfile|file|attachment|mention)\s*:\s*[^\r\n]+/gi,
        "",
      )
      .replace(/\n{3,}/g, "\n\n")
      .trim();
    return normalized;
  }

  _readRecentRolloutRows(
    rolloutPath,
    {
      maxBytes = 1024 * 1024,
      maxLines = 2000,
    } = {},
  ) {
    const normalizedPath = String(rolloutPath ?? "").trim();
    if (!normalizedPath) {
      return [];
    }
    try {
      const stat = fs.statSync(normalizedPath);
      if (!stat.isFile()) {
        return [];
      }
      const cacheKey = normalizedPath;
      const cached = this.rolloutEventCache.get(cacheKey) ?? null;
      if (
        cached != null &&
        cached.size === stat.size &&
        cached.mtimeMs === stat.mtimeMs &&
        Array.isArray(cached.rows)
      ) {
        return cached.rows;
      }
      const bytesToRead = Math.min(
        stat.size,
        Math.max(64 * 1024, Number(maxBytes) || 1024 * 1024),
      );
      const start = Math.max(0, stat.size - bytesToRead);
      const buffer = Buffer.alloc(bytesToRead);
      const fileDescriptor = fs.openSync(normalizedPath, "r");
      let bytesRead = 0;
      try {
        bytesRead = fs.readSync(fileDescriptor, buffer, 0, bytesToRead, start);
      } finally {
        fs.closeSync(fileDescriptor);
      }
      let text = buffer.toString("utf8", 0, bytesRead);
      if (start > 0) {
        const firstNewlineIndex = text.indexOf("\n");
        if (firstNewlineIndex === -1) {
          return [];
        }
        text = text.slice(firstNewlineIndex + 1);
      }
      const rows = [];
      const lines = text
        .split(/\r?\n/)
        .filter(Boolean)
        .slice(-Math.max(128, Number(maxLines) || 2000));
      for (const line of lines) {
        try {
          rows.push(JSON.parse(line));
        } catch {
          continue;
        }
      }
      this.rolloutEventCache.set(cacheKey, {
        size: stat.size,
        mtimeMs: stat.mtimeMs,
        rows,
      });
      if (this.rolloutEventCache.size > 12) {
        const oldestKey = this.rolloutEventCache.keys().next().value;
        if (oldestKey) {
          this.rolloutEventCache.delete(oldestKey);
        }
      }
      return rows;
    } catch {
      return [];
    }
  }

  _extractNativeUserMessageForTurn(thread, localTurnId) {
    const normalizedTurnId =
      normalizeConversationId(localTurnId) ?? (String(localTurnId ?? "").trim() || null);
    if (normalizedTurnId == null) {
      return null;
    }
    const messages = this._extractVisibleMessagesFromNativeThread(thread);
    for (let index = messages.length - 1; index >= 0; index -= 1) {
      const message = messages[index];
      const messageTurnId =
        normalizeConversationId(message?.turnId) ??
        (String(message?.turnId ?? "").trim() || null);
      if (message?.role !== "user" || messageTurnId !== normalizedTurnId) {
        continue;
      }
      const attachments = Array.isArray(message.attachments) ? message.attachments : [];
      if (!message.text && attachments.length === 0) {
        continue;
      }
      return {
        text: String(message.text ?? "").trim(),
        attachments,
        localTurnId: normalizedTurnId,
        generatedAt: this._getNativeThreadUpdatedAt(thread) ?? nowIso(),
        turnStatus: message.turnStatus ?? "inProgress",
        turnIndex: message.turnIndex ?? 0,
        itemIndex: message.itemIndex ?? 0,
      };
    }
    return null;
  }

  _getDesktopLocalUserMirrorTurnStateKey(binding, localThreadId, localTurnId) {
    const bindingId = String(binding?.binding_id ?? "").trim() || "binding";
    return `runtime:desktopLocalUserMirrorTurn:${bindingId}:${localThreadId}:${localTurnId}`;
  }

  _emitNativeUserMessageForTurn(binding, localThreadId, nativeThread, localTurnId) {
    const latest = this._extractNativeUserMessageForTurn(nativeThread, localTurnId);
    if (latest == null || !(this.pipeServer?.notify instanceof Function)) {
      return false;
    }
    const normalizedThreadId =
      normalizeConversationId(localThreadId) ?? (String(localThreadId ?? "").trim() || null);
    if (normalizedThreadId == null) {
      return false;
    }
    const stateKey = this._getDesktopLocalUserMirrorTurnStateKey(
      binding,
      normalizedThreadId,
      latest.localTurnId,
    );
    if (this.store?.getRuntimeState?.(stateKey)?.emitted) {
      return false;
    }
    const text = /^\s*PLEASE IMPLEMENT THIS PLAN:\s*\r?\n/i.test(latest.text)
      ? "实施计划"
      : latest.text;
    this.pipeServer.notify("bridge.turnEvent", {
      bindingId: binding?.binding_id,
      feishuOpenId: binding?.feishu_open_id,
      feishuChatId: binding?.feishu_chat_id,
      eventType: "desktop_local_user_message",
      message: {
        role: "user",
        text,
        attachments: latest.attachments,
        localThreadId: normalizedThreadId,
        localConversationId: normalizedThreadId,
        turnId: latest.localTurnId,
        itemIndex: latest.itemIndex,
        turnIndex: latest.turnIndex,
        turnStatus: latest.turnStatus,
      },
      generatedAt: latest.generatedAt,
    });
    this.store?.setRuntimeState?.(stateKey, {
      emitted: true,
      emittedAt: nowIso(),
      localThreadId: normalizedThreadId,
      localTurnId: latest.localTurnId,
    });
    return true;
  }

  _rolloutHasContextCompactedForTurn(rolloutPath, localTurnId) {
    const normalizedTurnId =
      normalizeConversationId(localTurnId) ?? (String(localTurnId ?? "").trim() || null);
    if (normalizedTurnId == null) {
      return false;
    }
    const rows = this._readRecentRolloutRows(rolloutPath, {
      maxBytes: 32 * 1024 * 1024,
      maxLines: 60000,
    });
    let activeTurnId = null;
    for (const row of rows) {
      const payload = row?.payload ?? {};
      const payloadType = String(payload?.type ?? "").trim();
      const rawTurnId = payload?.turn_id ?? payload?.turnId;
      const explicitTurnId =
        normalizeConversationId(rawTurnId) ?? (String(rawTurnId ?? "").trim() || null);
      if (
        row?.type === "turn_context" ||
        (row?.type === "event_msg" && payloadType === "task_started")
      ) {
        activeTurnId = explicitTurnId ?? activeTurnId;
      }
      const rowTurnId = explicitTurnId ?? activeTurnId;
      if (
        rowTurnId === normalizedTurnId &&
        (row?.type === "compacted" ||
          (row?.type === "event_msg" && payloadType === "context_compacted"))
      ) {
        return true;
      }
      if (
        row?.type === "event_msg" &&
        ["task_complete", "turn_aborted"].includes(payloadType) &&
        rowTurnId === activeTurnId
      ) {
        activeTurnId = null;
      }
    }
    return false;
  }

  _refreshInboundCompactedTurnRoute(binding, localThreadId, localTurnId, rolloutPath) {
    const bindingId = String(binding?.binding_id ?? "").trim();
    const normalizedThreadId = normalizeConversationId(localThreadId) ?? null;
    const normalizedTurnId =
      normalizeConversationId(localTurnId) ?? (String(localTurnId ?? "").trim() || null);
    if (!bindingId || normalizedThreadId == null || normalizedTurnId == null) {
      return false;
    }
    const inboundLedger =
      this.store?.getInboundLedgerByBindingAndLocalTurnId?.(bindingId, normalizedTurnId) ??
      null;
    if (inboundLedger == null || inboundLedger.origin !== "feishu_inbound") {
      return false;
    }
    const stateKey = `runtime:inboundCompactionRefresh:${bindingId}:${normalizedThreadId}:${normalizedTurnId}`;
    if (this.store?.getRuntimeState?.(stateKey)?.refreshed) {
      return false;
    }
    if (!this._rolloutHasContextCompactedForTurn(rolloutPath, normalizedTurnId)) {
      return false;
    }
    this.store?.setRuntimeState?.(stateKey, {
      refreshed: true,
      refreshedAt: nowIso(),
      localThreadId: normalizedThreadId,
      localTurnId: normalizedTurnId,
    });
    void this.debugNavigateToRoute({
      route: { kind: "localConversation", conversationId: normalizedThreadId },
      settleMs: 250,
      focusWindow: false,
    }).catch(() => {});
    return true;
  }

  async _emitNativeUserMessageForNativeNotification(notification) {
    const localThreadId = this._getNativeNotificationThreadId(notification);
    const localTurnId = this._getNativeNotificationTurnId(notification);
    if (localThreadId == null || localTurnId == null) {
      return false;
    }
    let bindings = this._getBindingsForNativeThread(localThreadId);
    let nativeThread = null;
    if (bindings.length === 0) {
      if (!this._hasFollowCurrentBindings()) {
        return false;
      }
      nativeThread = await this._readNativeThread(localThreadId);
      if (this._extractNativeUserMessageForTurn(nativeThread, localTurnId) == null) {
        return false;
      }
      bindings = this._getBindingsForNativeThread(localThreadId);
      if (bindings.length === 0) {
        let reboundAny = false;
        for (const binding of this.store?.listBindings?.() ?? []) {
          if (!binding?.follow_current_thread || this._isBindingResumeRebindLocked(binding.binding_id)) {
            continue;
          }
          const rebound = this._rebindFollowCurrentThread(binding, localThreadId);
          if (rebound != null) {
            bindings.push(rebound);
            reboundAny = true;
          }
        }
        if (reboundAny) {
          this._publishSharedState();
        }
      }
    }
    const pendingBindings = bindings.filter(
      (binding) =>
        !this.store?.getRuntimeState?.(
          this._getDesktopLocalUserMirrorTurnStateKey(binding, localThreadId, localTurnId),
        )?.emitted,
    );
    if (pendingBindings.length === 0) {
      return false;
    }
    if (nativeThread == null) {
      nativeThread = await this._readNativeThread(localThreadId);
    }
    if (nativeThread == null) {
      return false;
    }
    let emitted = false;
    for (const binding of pendingBindings) {
      this._rememberNativeBindingMetadata(binding, nativeThread);
      emitted =
        this._emitNativeUserMessageForTurn(
          binding,
          localThreadId,
          nativeThread,
          localTurnId,
        ) || emitted;
    }
    if (emitted) {
      this._startRolloutAssistantEventPolling(localThreadId, localTurnId);
    }
    return emitted;
  }

  _getNativeTurnKey(localThreadId, localTurnId) {
    const normalizedThreadId = normalizeConversationId(localThreadId) ?? null;
    const normalizedTurnId = normalizeConversationId(localTurnId) ?? null;
    if (normalizedThreadId == null || normalizedTurnId == null) {
      return null;
    }
    return `${normalizedThreadId}:${normalizedTurnId}`;
  }

  _markNativeTurnCompleted(localThreadId, localTurnId) {
    const key = this._getNativeTurnKey(localThreadId, localTurnId);
    if (key == null) {
      return false;
    }
    if (!(this.completedNativeTurns instanceof Set)) {
      this.completedNativeTurns = new Set();
    }
    this.completedNativeTurns.add(key);
    if (this.completedNativeTurns.size > 128) {
      this.completedNativeTurns.delete(this.completedNativeTurns.values().next().value);
    }
    return true;
  }

  _isNativeTurnCompleted(localThreadId, localTurnId) {
    const key = this._getNativeTurnKey(localThreadId, localTurnId);
    return key != null && this.completedNativeTurns instanceof Set && this.completedNativeTurns.has(key);
  }

  _scheduleRolloutAssistantEventsForNativeNotification(notification, delayMs = 180) {
    const localThreadId = this._getNativeNotificationThreadId(notification);
    const localTurnId = this._getNativeNotificationTurnId(notification);
    const key = this._getNativeTurnKey(localThreadId, localTurnId);
    if (key == null) {
      return false;
    }
    if (!(this.rolloutAssistantEventTimers instanceof Map)) {
      this.rolloutAssistantEventTimers = new Map();
    }
    const previous = this.rolloutAssistantEventTimers.get(key);
    if (previous != null) {
      clearTimeout(previous);
    }
    const timer = setTimeout(() => {
      this.rolloutAssistantEventTimers.delete(key);
      void this._emitRolloutAssistantEventsForNativeTurn(localThreadId, localTurnId).catch(
        (error) => this._recordError(error),
      );
    }, Math.max(50, Number(delayMs) || 180));
    timer.unref?.();
    this.rolloutAssistantEventTimers.set(key, timer);
    return true;
  }

  _startRolloutAssistantEventPolling(localThreadId, localTurnId) {
    const key = this._getNativeTurnKey(localThreadId, localTurnId);
    if (key == null) {
      return false;
    }
    if (!(this.rolloutAssistantPollTimers instanceof Map)) {
      this.rolloutAssistantPollTimers = new Map();
    }
    if (this.rolloutAssistantPollTimers.has(key)) {
      return true;
    }
    const startedAtMs = Date.now();
    const poll = () => {
      void this._emitRolloutAssistantEventsForNativeTurn(localThreadId, localTurnId)
        .catch((error) => this._recordError(error))
        .finally(() => {
          if (
            this._isNativeTurnCompleted(localThreadId, localTurnId) ||
            Date.now() - startedAtMs > 10 * 60 * 1000
          ) {
            this.rolloutAssistantPollTimers.delete(key);
            return;
          }
          const timer = setTimeout(poll, 800);
          timer.unref?.();
          this.rolloutAssistantPollTimers.set(key, timer);
        });
    };
    const timer = setTimeout(poll, 250);
    timer.unref?.();
    this.rolloutAssistantPollTimers.set(key, timer);
    return true;
  }

  _extractRolloutAssistantText(payload) {
    if (Array.isArray(payload?.content)) {
      return payload.content
        .map((part) => {
          if (typeof part === "string") {
            return part;
          }
          return String(part?.text ?? part?.content ?? "").trim();
        })
        .filter(Boolean)
        .join("");
    }
    return String(payload?.text ?? payload?.message ?? "").trim();
  }

  _getRolloutAssistantSection(payload) {
    const phase = String(payload?.phase ?? "").trim().toLowerCase();
    if (
      phase === "commentary" ||
      phase === "progress" ||
      phase === "status" ||
      phase === "thinking" ||
      phase === "analysis"
    ) {
      return "progress";
    }
    if (phase === "final_answer" || phase === "final" || phase === "assistant_final") {
      return "final";
    }
    return null;
  }

  _parseRolloutToolArguments(payload) {
    const raw = payload?.arguments ?? payload?.input ?? null;
    if (raw != null && typeof raw === "object") {
      return raw;
    }
    const text = String(raw ?? "").trim();
    if (!text) {
      return {};
    }
    try {
      const parsed = JSON.parse(text);
      return parsed != null && typeof parsed === "object" ? parsed : { input: text };
    } catch {
      return { input: text };
    }
  }

  _truncateRolloutToolSummary(value, maxLength = 80) {
    const text = String(value ?? "").replace(/\s+/g, " ").trim();
    const limit = Math.max(16, Number(maxLength) || 80);
    return text.length > limit ? `${text.slice(0, limit - 1).trimEnd()}…` : text;
  }

  _extractRolloutToolPathLabel(text, { loose = true } = {}) {
    const source = String(text ?? "");
    const patterns = [
      /-(?:LiteralPath|Path|FilePath|Destination)\s+['"]([^'"\r\n]+)['"]/i,
      /\b(?:Get-Content|Select-String|Set-Content|Add-Content|Out-File|Copy-Item|Test-Path|Get-ChildItem)\s+['"]([^'"\r\n]+)['"]/i,
    ];
    if (loose) {
      patterns.push(/([A-Za-z]:\\[^'"\r\n|<>]+)/);
    }
    for (const pattern of patterns) {
      const match = pattern.exec(source);
      const value = String(match?.[1] ?? "").trim();
      if (!value) {
        continue;
      }
      const cleaned = value.replace(/[),;]+$/g, "").replace(/[\\\/]+$/g, "");
      const label = path.basename(cleaned) || cleaned;
      return this._truncateRolloutToolSummary(label, 48);
    }
    return "";
  }

  _extractRolloutPatchTarget(input) {
    const text = String(input ?? "");
    const match = /^\*\*\* (?:Add|Update|Delete) File:\s+(.+)$/m.exec(text);
    if (!match) {
      return "";
    }
    const label = path.basename(String(match[1] ?? "").trim());
    return this._truncateRolloutToolSummary(label, 48);
  }

  _buildRolloutShellToolSummary(args) {
    const command = Array.isArray(args?.command)
      ? args.command.join(" ")
      : String(args?.command ?? args?.cmd ?? args?.input ?? "");
    const lower = command.toLowerCase();
    const pathLabel = this._extractRolloutToolPathLabel(command);
    if (/\|\s*python(?:\.exe)?\s+-\b|\bpython(?:\.exe)?\s+(?:-|-[cm]\b)/i.test(command)) {
      return "- 代码执行：运行 Python 代码";
    }
    if (/\|\s*node(?:\.exe)?\s+-\b|\bnode(?:\.exe)?\s+(?:-|-[e]\b)/i.test(command)) {
      return "- 代码执行：运行 Node.js 代码";
    }
    if (/\b(Get-Content|Select-String|Get-ChildItem|Test-Path|Get-Item|Get-Command)\b/i.test(command)) {
      return pathLabel ? `- 读取文件：读取 ${pathLabel}` : "- 读取文件：读取文件";
    }
    if (/\b(Set-Content|Add-Content|Out-File|Copy-Item|New-Item|Move-Item|Rename-Item)\b/i.test(command)) {
      const writePathLabel = this._extractRolloutToolPathLabel(command, { loose: false });
      return writePathLabel ? `- 编写文件：编辑 ${writePathLabel}` : "- 编写文件：编辑文件";
    }
    if (lower.includes("powershell")) {
      return "- 运行命令：执行 PowerShell 脚本";
    }
    return "- 运行命令：执行 PowerShell 脚本";
  }

  _buildRolloutToolCallText(row, toolName) {
    const payload = row?.payload ?? {};
    const args = this._parseRolloutToolArguments(payload);
    const normalizedName = String(toolName ?? "").trim();
    if (normalizedName === "shell_command") {
      return this._buildRolloutShellToolSummary(args);
    }
    if (normalizedName === "apply_patch") {
      const target = this._extractRolloutPatchTarget(args?.input ?? payload?.input);
      return target ? `- 应用补丁：应用代码补丁（${target}）` : "- 应用补丁：应用代码补丁";
    }
    if (/^(web_search|search_query|web\.run)$/i.test(normalizedName)) {
      const query = String(args?.query ?? args?.q ?? args?.search_query ?? "").trim();
      return query
        ? `- 网页搜索：搜索 ${this._truncateRolloutToolSummary(query, 60)}`
        : "- 网页搜索：搜索关键词";
    }
    return `- 其他工具：调用 ${this._buildToolDisplayName(normalizedName) || normalizedName || "工具"}`;
  }

  _buildRolloutToolEventText(row, toolCallNamesById) {
    const payload = row?.payload ?? {};
    const rowType = String(row?.type ?? "").trim();
    const payloadType = String(payload?.type ?? "").trim();
    const callId = String(payload?.call_id ?? payload?.callId ?? "").trim();
    const rawName =
      String(payload?.name ?? "").trim() ||
      (callId ? String(toolCallNamesById.get(callId) ?? "").trim() : "");
    const toolName = this._buildToolDisplayName(rawName) || rawName;
    if (
      rowType === "response_item" &&
      ["function_call", "custom_tool_call"].includes(payloadType)
    ) {
      return toolName ? this._buildRolloutToolCallText(row, rawName) : "";
    }
    if (rowType !== "event_msg") {
      return "";
    }
    if (callId && toolCallNamesById.has(callId)) {
      return "";
    }
    const status = String(payload?.status ?? "").trim().toLowerCase();
    const ok =
      status === "completed" ||
      status === "success" ||
      Number(payload?.exit_code ?? payload?.exitCode) === 0;
    const statusLabel = ok ? "\u6210\u529f" : "\u5931\u8d25";
    if (payloadType === "exec_command_end") {
      return `- \u5de5\u5177\u5b8c\u6210\uff1a${toolName || "shell_command"}（${statusLabel}）`;
    }
    if (payloadType === "patch_apply_end") {
      return `- \u5de5\u5177\u5b8c\u6210\uff1aapply_patch（${statusLabel}）`;
    }
    if (payloadType === "mcp_tool_call_end") {
      const server = String(payload?.invocation?.server ?? "").trim();
      const tool = String(payload?.invocation?.tool ?? "").trim();
      const label = server && tool ? `${server}.${tool}` : server || tool || toolName;
      return label ? `- \u5de5\u5177\u5b8c\u6210\uff1a${label}（${statusLabel}）` : "";
    }
    if (payloadType === "web_search_end") {
      const query = String(payload?.action?.query ?? payload?.query ?? "").trim();
      return query
        ? `- \u641c\u7d22\u5b8c\u6210\uff1a${query}`
        : "- \u641c\u7d22\u5b8c\u6210";
    }
    if (payloadType === "view_image_tool_call") {
      return "- \u8c03\u7528\u5de5\u5177\uff1aview_image";
    }
    return "";
  }

  _collectRolloutAssistantEvents(rolloutPath, expectedTurnId, { sourceCompleted = false } = {}) {
    const normalizedTurnId =
      normalizeConversationId(expectedTurnId) ?? (String(expectedTurnId ?? "").trim() || null);
    if (normalizedTurnId == null) {
      return { events: [], completed: Boolean(sourceCompleted) };
    }
    const rows = this._readRecentRolloutRows(rolloutPath, {
      maxBytes: 32 * 1024 * 1024,
      maxLines: 60000,
    });
    const targetRows = [];
    let activeTurnId = null;
    let completed = Boolean(sourceCompleted);
    let fallbackFinalText = "";
    for (const [index, row] of rows.entries()) {
      const payload = row?.payload ?? {};
      const payloadType = String(payload?.type ?? "").trim();
      const rawTurnId = payload?.turn_id ?? payload?.turnId;
      const explicitTurnId =
        normalizeConversationId(rawTurnId) ?? (String(rawTurnId ?? "").trim() || null);
      if (
        row?.type === "turn_context" ||
        (row?.type === "event_msg" && payloadType === "task_started")
      ) {
        activeTurnId = explicitTurnId ?? activeTurnId;
      }
      const rowTurnId = explicitTurnId ?? activeTurnId;
      if (rowTurnId === normalizedTurnId) {
        targetRows.push({ row, index });
        if (row?.type === "event_msg" && payloadType === "task_complete") {
          completed = true;
          fallbackFinalText = String(payload?.last_agent_message ?? "").trim() || fallbackFinalText;
        }
      }
      if (
        row?.type === "event_msg" &&
        ["task_complete", "turn_aborted"].includes(payloadType) &&
        rowTurnId === activeTurnId
      ) {
        activeTurnId = null;
      }
    }
    const toolCallNamesById = new Map();
    for (const { row } of targetRows) {
      const payload = row?.payload ?? {};
      const payloadType = String(payload?.type ?? "").trim();
      const callId = String(payload?.call_id ?? payload?.callId ?? "").trim();
      const name = String(payload?.name ?? "").trim();
      if (
        row?.type === "response_item" &&
        ["function_call", "custom_tool_call"].includes(payloadType) &&
        callId &&
        name
      ) {
        toolCallNamesById.set(callId, name);
      }
    }
    const events = [];
    let hasFinal = false;
    for (const { row, index } of targetRows) {
      const payload = row?.payload ?? {};
      const payloadType = String(payload?.type ?? "").trim();
      const rowHash = createHash("sha1").update(JSON.stringify(row), "utf8").digest("hex");
      if (row?.type === "response_item" && payloadType === "message") {
        if (String(payload?.role ?? "").trim().toLowerCase() !== "assistant") {
          continue;
        }
        const section = this._getRolloutAssistantSection(payload);
        const text = this._extractRolloutAssistantText(payload);
        if (!section || !text) {
          continue;
        }
        hasFinal = hasFinal || section === "final";
        events.push({
          section,
          text,
          itemId: `rollout:${rowHash}`,
          itemType: "rolloutMessage",
          itemIndex: index,
          eventSubtype: `rollout_${String(payload?.phase ?? section).trim() || section}`,
          generatedAt: String(row?.timestamp ?? "").trim() || nowIso(),
        });
        continue;
      }
      const toolText = this._buildRolloutToolEventText(row, toolCallNamesById);
      if (toolText) {
        events.push({
          section: "tool",
          text: toolText,
          itemId: `rollout:${rowHash}`,
          itemType: "rolloutTool",
          itemIndex: index,
          eventSubtype: `rollout_${payloadType || "tool"}`,
          generatedAt: String(row?.timestamp ?? "").trim() || nowIso(),
        });
      }
    }
    if (!hasFinal && fallbackFinalText) {
      const rowHash = createHash("sha1")
        .update(`${normalizedTurnId}:${fallbackFinalText}`, "utf8")
        .digest("hex");
      events.push({
        section: "final",
        text: fallbackFinalText,
        itemId: `rollout:${rowHash}`,
        itemType: "rolloutTaskComplete",
        itemIndex: targetRows.length,
        eventSubtype: "rollout_task_complete_final",
        generatedAt: nowIso(),
      });
    }
    return { events, completed };
  }

  _emitRolloutAssistantEvents(binding, localThreadId, rolloutPath, localTurnId, options = {}) {
    const normalizedThreadId = normalizeConversationId(localThreadId) ?? null;
    const normalizedTurnId =
      normalizeConversationId(localTurnId) ?? (String(localTurnId ?? "").trim() || null);
    if (normalizedThreadId == null || normalizedTurnId == null) {
      return false;
    }
    const { events, completed } = this._collectRolloutAssistantEvents(
      rolloutPath,
      normalizedTurnId,
      {
        sourceCompleted: Boolean(options?.sourceCompleted) ||
          this._isNativeTurnCompleted(normalizedThreadId, normalizedTurnId),
      },
    );
    if (completed) {
      this._markNativeTurnCompleted(normalizedThreadId, normalizedTurnId);
    }
    let emitted = false;
    for (const event of events) {
      const identity = createHash("sha1")
        .update(
          JSON.stringify({
            bindingId: binding?.binding_id ?? null,
            localThreadId: normalizedThreadId,
            localTurnId: normalizedTurnId,
            section: event.section,
            itemId: event.itemId,
            text: event.text,
          }),
          "utf8",
        )
        .digest("hex");
      const stateKey = `runtime:rolloutAssistantMirror:${identity}`;
      if (this.store?.getRuntimeState?.(stateKey)?.emitted) {
        continue;
      }
      const sent = this._emitNativeAssistantSectionEvent({
        binding,
        localThreadId: normalizedThreadId,
        localTurnId: normalizedTurnId,
        section: event.section,
        text: event.text,
        turnStatus: completed ? "completed" : "inProgress",
        itemId: event.itemId,
        itemType: event.itemType,
        itemIndex: event.itemIndex,
        eventSubtype: event.eventSubtype,
        sourceCompleted: completed,
      });
      if (!sent) {
        continue;
      }
      this.store?.setRuntimeState?.(stateKey, {
        emitted: true,
        emittedAt: nowIso(),
        localThreadId: normalizedThreadId,
        localTurnId: normalizedTurnId,
        section: event.section,
      });
      emitted = true;
    }
    if (completed && events.length > 0) {
      const completionStateKey = `runtime:rolloutAssistantMirrorCompletion:${
        binding?.binding_id ?? ""
      }:${normalizedThreadId}:${normalizedTurnId}`;
      if (!this.store?.getRuntimeState?.(completionStateKey)?.emitted) {
        const sent = this._emitNativeAssistantSectionEvent({
          binding,
          localThreadId: normalizedThreadId,
          localTurnId: normalizedTurnId,
          section: "final",
          text: "",
          turnStatus: "completed",
          eventSubtype: "turn_completed",
          sourceCompleted: true,
          allowEmpty: true,
        });
        if (sent) {
          this.store?.setRuntimeState?.(completionStateKey, {
            emitted: true,
            emittedAt: nowIso(),
            localThreadId: normalizedThreadId,
            localTurnId: normalizedTurnId,
            section: "final",
          });
          emitted = true;
        }
      }
    }
    return emitted;
  }

  async _emitRolloutAssistantEventsForNativeTurn(
    localThreadId,
    localTurnId,
    { sourceCompleted = false } = {},
  ) {
    const normalizedThreadId = normalizeConversationId(localThreadId) ?? null;
    const normalizedTurnId =
      normalizeConversationId(localTurnId) ?? (String(localTurnId ?? "").trim() || null);
    if (normalizedThreadId == null || normalizedTurnId == null) {
      return false;
    }
    if (sourceCompleted) {
      this._markNativeTurnCompleted(normalizedThreadId, normalizedTurnId);
    }
    const bindings = this._getBindingsForNativeThread(normalizedThreadId);
    if (bindings.length === 0) {
      return false;
    }
    const nativeThreadMetadata = await this._readNativeThreadMetadata(normalizedThreadId);
    if (nativeThreadMetadata?.path == null) {
      return false;
    }
    let emitted = false;
    for (const binding of bindings) {
      this._rememberNativeBindingMetadata(binding, nativeThreadMetadata);
      emitted =
        this._emitRolloutAssistantEvents(
          binding,
          normalizedThreadId,
          nativeThreadMetadata.path,
          normalizedTurnId,
          { sourceCompleted },
        ) || emitted;
      this._refreshInboundCompactedTurnRoute(
        binding,
        normalizedThreadId,
        normalizedTurnId,
        nativeThreadMetadata.path,
      );
    }
    return emitted;
  }

  async _emitRolloutAssistantEventsForNativeNotification(notification, options = {}) {
    const localThreadId = this._getNativeNotificationThreadId(notification);
    const localTurnId = this._getNativeNotificationTurnId(notification);
    return this._emitRolloutAssistantEventsForNativeTurn(localThreadId, localTurnId, options);
  }

  _extractFilePathsFromCommandText(commandText) {
    const source = String(commandText ?? "").trim();
    if (!source) {
      return [];
    }
    const matches = [];
    const patterns = [
      /-(?:Path|LiteralPath)\s+['"]?([A-Za-z]:\\[^'"`\r\n|]+?)['"]?(?=\s|$)/gi,
      /(?:Get-Content|Select-String)\s+([A-Za-z]:\\[^\s'"`\r\n|]+)(?=\s|$)/gi,
    ];
    for (const pattern of patterns) {
      let match = null;
      while ((match = pattern.exec(source)) != null) {
        const candidate = String(match[1] ?? "").trim();
        if (!candidate || !/^[A-Za-z]:\\/.test(candidate)) {
          continue;
        }
        matches.push(candidate);
      }
    }
    const unique = [];
    const seen = new Set();
    for (const candidate of matches) {
      const key = path.normalize(candidate).toLowerCase();
      if (seen.has(key)) {
        continue;
      }
      seen.add(key);
      unique.push(candidate);
    }
    return unique;
  }

  _extractSkillNamesFromCommandText(commandText) {
    const source = String(commandText ?? "").trim();
    if (!source) {
      return [];
    }
    const matches = [];
    const pattern = /(?:\.codex|\.agents)[\\/]+skills[\\/]+([^\\/:\r\n'"\s]+)[\\/]+SKILL\.md/gi;
    let match = null;
    while ((match = pattern.exec(source)) != null) {
      const candidate = String(match[1] ?? "").trim();
      if (!candidate) {
        continue;
      }
      matches.push(candidate);
    }
    return [...new Set(matches)];
  }

  _extractHostnameFromUrl(rawUrl) {
    const source = String(rawUrl ?? "").trim();
    if (!source) {
      return null;
    }
    try {
      return new URL(source).hostname || null;
    } catch {
      return null;
    }
  }

  _buildToolDisplayName(name) {
    const rawName = String(name ?? "").trim();
    const normalizedName = rawName.toLowerCase();
    if (!normalizedName) {
      return "";
    }
    if (normalizedName === "shell_command") {
      return "终端命令（shell_command）";
    }
    if (normalizedName === "apply_patch") {
      return "补丁编辑（apply_patch）";
    }
    if (normalizedName === "update_plan") {
      return "更新计划（update_plan）";
    }
    if (normalizedName === "view_image") {
      return "查看图片（view_image）";
    }
    if (normalizedName === "request_user_input") {
      return "请求用户输入（request_user_input）";
    }
    if (normalizedName.startsWith("mcp__")) {
      const segments = rawName.split("__").filter(Boolean);
      if (segments.length >= 3) {
        return `插件工具（${segments.slice(1).join(".")}）`;
      }
    }
    return `工具（${rawName}）`;
  }

  _buildHumanReadableToolLabel(name, count) {
    const normalizedName = String(name ?? "").trim().toLowerCase();
    const normalizedCount = Math.max(0, Number(count) || 0);
    if (!normalizedName || normalizedCount <= 0) {
      return "";
    }
    if (normalizedName === "shell_command" || normalizedName === "apply_patch") {
      return "";
    }
    if (normalizedName.includes("search_query") || normalizedName.includes("web.search")) {
      return `搜索了网页 ${normalizedCount} 次`;
    }
    if (normalizedName.includes("image_query")) {
      return `搜索了图片 ${normalizedCount} 次`;
    }
    if (normalizedName.includes("view_image")) {
      return `查看了图片 ${normalizedCount} 次`;
    }
    if (normalizedName.includes("spawn_agent")) {
      return `启动了子任务 ${normalizedCount} 次`;
    }
    if (normalizedName.includes("wait_agent")) {
      return "";
    }
    return `调用了 ${normalizedName} 工具 ${normalizedCount} 次`;
  }

  _buildRolloutTurnToolSummaries(thread, visibleMessages) {
    const assistantTurnIds = [];
    for (const message of Array.isArray(visibleMessages) ? visibleMessages : []) {
      if (String(message?.role ?? "").trim().toLowerCase() !== "assistant") {
        continue;
      }
      const turnId = String(message?.turnId ?? "").trim();
      if (!turnId || assistantTurnIds.includes(turnId)) {
        continue;
      }
      assistantTurnIds.push(turnId);
    }
    if (assistantTurnIds.length === 0) {
      return {
        latestToolSummary: null,
        turnToolSummaries: {},
      };
    }
    const relevantTurnIds = new Set(assistantTurnIds.slice(-8));
    const annotateRows = (candidateRows) => {
      const annotated = [];
      let activeTurnId = null;
      for (const row of candidateRows) {
        const payload = row?.payload;
        const explicitTurnId = String(payload?.turn_id ?? "").trim() || null;
        if (
          (row?.type === "event_msg" && String(payload?.type ?? "").trim() === "task_started") ||
          row?.type === "turn_context"
        ) {
          if (explicitTurnId) {
            activeTurnId = explicitTurnId;
          }
        }
        annotated.push({
          ...row,
          inferredTurnId: explicitTurnId ?? activeTurnId,
        });
        if (
          row?.type === "event_msg" &&
          ["task_complete", "turn_aborted"].includes(String(payload?.type ?? "").trim()) &&
          explicitTurnId &&
          explicitTurnId === activeTurnId
        ) {
          activeTurnId = null;
        }
      }
      return annotated;
    };
    const hasRelevantTurnStart = (candidateRows) =>
      candidateRows.some((row) => {
        const payload = row?.payload;
        const turnId = String(payload?.turn_id ?? "").trim();
        if (!turnId || !relevantTurnIds.has(turnId)) {
          return false;
        }
        return (
          row?.type === "turn_context" ||
          (row?.type === "event_msg" && String(payload?.type ?? "").trim() === "task_started")
        );
      });
    const isRelevantTurnBoundaryRow = (row) => {
      const payload = row?.payload;
      const turnId = String(row?.inferredTurnId ?? payload?.turn_id ?? "").trim();
      if (!turnId || !relevantTurnIds.has(turnId)) {
        return false;
      }
      return (
        row?.type === "turn_context" ||
        (row?.type === "event_msg" && String(payload?.type ?? "").trim() === "task_started")
      );
    };
    const hasTruncatedRelevantTurnPrefix = (candidateRows) => {
      if (!Array.isArray(candidateRows) || candidateRows.length === 0) {
        return false;
      }
      const annotatedCandidateRows = annotateRows(candidateRows);
      const firstRelevantRowByTurnId = new Map();
      for (const row of annotatedCandidateRows) {
        const turnId = String(row?.inferredTurnId ?? row?.payload?.turn_id ?? "").trim();
        if (!turnId || !relevantTurnIds.has(turnId) || firstRelevantRowByTurnId.has(turnId)) {
          continue;
        }
        firstRelevantRowByTurnId.set(turnId, row);
      }
      for (const turnId of relevantTurnIds) {
        const firstRelevantRow = firstRelevantRowByTurnId.get(turnId);
        if (!firstRelevantRow) {
          continue;
        }
        if (!isRelevantTurnBoundaryRow(firstRelevantRow)) {
          return true;
        }
      }
      return false;
    };
    const readAttempts = [
      undefined,
      { maxBytes: 8 * 1024 * 1024, maxLines: 12000 },
      { maxBytes: 32 * 1024 * 1024, maxLines: 40000 },
    ];
    let rows = [];
    for (const options of readAttempts) {
      const candidateRows = this._readRecentRolloutRows(thread?.path, options);
      if (candidateRows.length === 0) {
        rows = candidateRows;
        break;
      }
      rows = candidateRows;
      if (
        hasRelevantTurnStart(candidateRows) &&
        !hasTruncatedRelevantTurnPrefix(candidateRows)
      ) {
        break;
      }
    }
    if (rows.length === 0) {
      return {
        latestToolSummary: null,
        turnToolSummaries: {},
      };
    }
    const annotatedRows = annotateRows(rows);
    const toolCallNamesById = new Map();
    for (const row of annotatedRows) {
      const payload = row?.payload;
      if (
        row?.type === "response_item" &&
        ["function_call", "custom_tool_call"].includes(String(payload?.type ?? "").trim()) &&
        String(payload?.call_id ?? "").trim() &&
        String(payload?.name ?? "").trim()
      ) {
        toolCallNamesById.set(String(payload.call_id), String(payload.name));
      }
    }
    const summaryByTurnId = new Map();
    const getOrCreateSummaryForTurn = (turnId) => {
      if (!summaryByTurnId.has(turnId)) {
        summaryByTurnId.set(turnId, {
          startedAt: null,
          completedAt: null,
          firstObservedAt: null,
          lastObservedAt: null,
          commandCount: 0,
          patchApplyCount: 0,
          readFilePaths: new Set(),
          editedFilePaths: new Set(),
          toolCounts: new Map(),
          skillNames: new Set(),
          toolNames: new Set(),
          pluginNames: new Set(),
          searchQueries: new Set(),
          openedWebsites: new Set(),
          flowSteps: [],
          flowStepKeys: new Set(),
          finalText: null,
        });
      }
      return summaryByTurnId.get(turnId);
    };
    for (const row of annotatedRows) {
      const payload = row?.payload;
      const turnId = String(row?.inferredTurnId ?? "").trim();
      if (!turnId || !relevantTurnIds.has(turnId)) {
        continue;
      }
      const rowType = String(row?.type ?? "").trim();
      const payloadType = String(payload?.type ?? "").trim();
      const isToolCallResponseItem =
        rowType === "response_item" &&
        ["function_call", "custom_tool_call"].includes(payloadType) &&
        String(payload?.call_id ?? "").trim() &&
        String(payload?.name ?? "").trim();
      if (rowType !== "event_msg" && !isToolCallResponseItem) {
        continue;
      }
      const eventType = rowType === "event_msg" ? payloadType : "";
      const summary = getOrCreateSummaryForTurn(turnId);
      const rowTimestamp = String(row?.timestamp ?? payload?.timestamp ?? "").trim() || null;
      if (rowTimestamp) {
        summary.firstObservedAt = summary.firstObservedAt ?? rowTimestamp;
        summary.lastObservedAt = rowTimestamp;
      }
      if (row?.type === "turn_context" || eventType === "task_started") {
        summary.startedAt = summary.startedAt ?? rowTimestamp;
      }
      if (["task_complete", "turn_aborted"].includes(eventType)) {
        summary.completedAt = rowTimestamp ?? summary.completedAt;
        if (eventType === "task_complete") {
          const finalText = String(payload?.last_agent_message ?? "").trim();
          if (finalText) {
            summary.finalText = finalText;
          }
        }
      }
      const callId = String(payload?.call_id ?? "").trim();
      const toolName = callId
        ? toolCallNamesById.get(callId) ??
          (isToolCallResponseItem ? String(payload?.name ?? "").trim() : null)
        : null;
      const pushFlowStep = (stepText, stepKey = null) => {
        const normalizedStep = String(stepText ?? "").trim();
        const normalizedKey = String(
          stepKey ?? `${eventType}:${callId || row?.timestamp || turnId}:${normalizedStep}`,
        ).trim();
        if (!normalizedStep || !normalizedKey || summary.flowStepKeys.has(normalizedKey)) {
          return;
        }
        summary.flowStepKeys.add(normalizedKey);
        summary.flowSteps.push(normalizedStep);
      };
      const toolFlowStepKey = callId && toolName ? `tool:${callId}:${toolName}` : null;
      if (isToolCallResponseItem) {
        const displayName = this._buildToolDisplayName(toolName);
        if (displayName) {
          summary.toolNames.add(displayName);
          pushFlowStep(`调用工具：${displayName}`, toolFlowStepKey);
        }
        continue;
      }
      if (!eventType) {
        continue;
      }
      if (toolName) {
        summary.toolCounts.set(toolName, (summary.toolCounts.get(toolName) ?? 0) + 1);
        const displayName = this._buildToolDisplayName(toolName);
        if (displayName) {
          summary.toolNames.add(displayName);
        }
      }
      if (eventType === "exec_command_end") {
        summary.commandCount += 1;
        const commandText = Array.isArray(payload?.command)
          ? payload.command.join(" ")
          : Array.isArray(payload?.parsed_cmd)
            ? payload.parsed_cmd
                .map((entry) => String(entry?.cmd ?? "").trim())
                .filter(Boolean)
                .join(" ")
            : "";
        for (const filePath of this._extractFilePathsFromCommandText(commandText)) {
          summary.readFilePaths.add(path.normalize(filePath));
        }
        for (const skillName of this._extractSkillNamesFromCommandText(commandText)) {
          summary.skillNames.add(skillName);
          pushFlowStep(`使用技能：${skillName}`);
        }
        if (toolName) {
          pushFlowStep(`调用工具：${this._buildToolDisplayName(toolName)}`, toolFlowStepKey);
        }
        continue;
      }
      if (eventType === "patch_apply_end") {
        summary.patchApplyCount += 1;
        const changes =
          payload?.changes != null && typeof payload.changes === "object"
            ? payload.changes
            : {};
        for (const filePath of Object.keys(changes)) {
          if (!filePath) {
            continue;
          }
          summary.editedFilePaths.add(path.normalize(String(filePath)));
        }
        if (toolName) {
          pushFlowStep(`调用工具：${this._buildToolDisplayName(toolName)}`, toolFlowStepKey);
        }
        continue;
      }
      if (eventType === "web_search_end") {
        const query = String(payload?.action?.query ?? payload?.query ?? "").trim();
        if (query) {
          summary.searchQueries.add(query);
          pushFlowStep(`搜索关键词：${query}`);
        }
        const openedUrl =
          String(payload?.action?.url ?? "").trim() ||
          (String(payload?.query ?? "").trim().startsWith("http")
            ? String(payload.query).trim()
            : "");
        const hostname = this._extractHostnameFromUrl(openedUrl);
        if (hostname) {
          summary.openedWebsites.add(hostname);
          pushFlowStep(`打开网页：${hostname}`);
        }
        continue;
      }
      if (eventType === "mcp_tool_call_end") {
        const serverName = String(payload?.invocation?.server ?? "").trim();
        const serverToolName = String(payload?.invocation?.tool ?? "").trim();
        if (serverName) {
          summary.pluginNames.add(serverName);
        }
        if (serverName || serverToolName) {
          const toolLabel = serverName && serverToolName
            ? `${serverName}.${serverToolName}`
            : serverName || serverToolName;
          summary.toolNames.add(toolLabel);
          pushFlowStep(`调用工具：${toolLabel}`);
        }
        const hostname = this._extractHostnameFromUrl(payload?.invocation?.arguments?.url);
        if (hostname) {
          summary.openedWebsites.add(hostname);
          pushFlowStep(`打开网页：${hostname}`);
        }
        continue;
      }
      if (eventType === "view_image_tool_call") {
        summary.toolNames.add("查看图片（view_image）");
        pushFlowStep("调用工具：查看图片（view_image）");
      }
    }
    const turnToolSummaries = {};
    for (const turnId of relevantTurnIds) {
      const summary = summaryByTurnId.get(turnId);
      if (!summary) {
        continue;
      }
      const labels = [];
      if (summary.readFilePaths.size > 0) {
        labels.push(`查看了 ${summary.readFilePaths.size} 个文件`);
      }
      if (summary.commandCount > 0) {
        labels.push(`运行了 ${summary.commandCount} 条命令`);
      }
      if (summary.editedFilePaths.size > 0) {
        labels.push(`编辑了 ${summary.editedFilePaths.size} 个文件`);
      }
      if (summary.searchQueries.size > 0) {
        labels.push(`搜索了关键词：${[...summary.searchQueries].join("；")}`);
      }
      if (summary.openedWebsites.size > 0) {
        labels.push(`打开了网页：${[...summary.openedWebsites].join("、")}`);
      }
      if (summary.skillNames.size > 0) {
        labels.push(`使用了技能：${[...summary.skillNames].join("、")}`);
      }
      if (summary.pluginNames.size > 0) {
        labels.push(`调用了插件：${[...summary.pluginNames].join("、")}`);
      }
      if (summary.toolNames.size > 0) {
        labels.push(`调用了工具：${[...summary.toolNames].join("、")}`);
      }
      for (const [toolName, count] of [...summary.toolCounts.entries()].sort(([left], [right]) =>
        String(left).localeCompare(String(right)),
      )) {
        const label = this._buildHumanReadableToolLabel(toolName, count);
        if (label) {
          labels.push(label);
        }
      }
      for (const [index, flowStep] of summary.flowSteps.entries()) {
        labels.push(`步骤 ${index + 1}：${flowStep}`);
      }
      if (labels.length === 0 && !summary.finalText) {
        continue;
      }
      turnToolSummaries[turnId] = {
        source: "app_server_native",
        dataSource: "thread_rollout",
        startedAt: summary.startedAt ?? summary.firstObservedAt ?? null,
        completedAt: summary.completedAt ?? summary.lastObservedAt ?? null,
        visibleToolSummaryLabels: sanitizeToolSummaryLabels(labels),
        commandCount: summary.commandCount,
        patchApplyCount: summary.patchApplyCount,
        readFileCount: summary.readFilePaths.size,
        editedFileCount: summary.editedFilePaths.size,
        searchQueries: [...summary.searchQueries],
        openedWebsites: [...summary.openedWebsites],
        skillNames: [...summary.skillNames],
        toolNames: [...summary.toolNames],
        pluginNames: [...summary.pluginNames],
        toolFlowSteps: [...summary.flowSteps],
        ...(summary.finalText
          ? {
              finalText: summary.finalText,
              finalTextSource: "task_complete_last_agent_message",
            }
          : {}),
      };
    }
    const latestAssistantTurnId = [...assistantTurnIds].reverse().find((turnId) =>
      Object.prototype.hasOwnProperty.call(turnToolSummaries, turnId),
    );
    return {
      latestToolSummary:
        latestAssistantTurnId != null ? turnToolSummaries[latestAssistantTurnId] : null,
      turnToolSummaries,
    };
  }

  _extractVisibleMessagesFromNativeThread(thread) {
    const client = this._getNativeAppServerClient();
    const messages = [];
    if (thread == null || !Array.isArray(thread.turns)) {
      return messages;
    }
    for (const [turnIndex, turn] of thread.turns.entries()) {
      if (!Array.isArray(turn?.items)) {
        continue;
      }
      for (const [itemIndex, item] of turn.items.entries()) {
        if (item?.type === "userMessage") {
          const rawContent = Array.isArray(item.content) ? item.content : [];
          const text =
            client?.formatUserInput instanceof Function
              ? client.formatUserInput(rawContent)
              : "";
          const attachments = this._extractNativeUserMessageAttachments({
            item,
            rawContent,
            formattedText: text,
            context: {
              turnId: turn.id ?? null,
              turnIndex,
              itemIndex,
            },
          });
          const normalizedText = this._stripNativeAttachmentPlaceholders(text, attachments);
          if (normalizedText || attachments.length > 0) {
            messages.push({
              role: "user",
              text: normalizedText,
              attachments,
              turnId: turn.id ?? null,
              turnStatus: normalizeNativeTurnStatus(turn.status),
              turnIndex,
              itemIndex,
            });
          }
          continue;
        }
        if (item?.type === "agentMessage") {
          const text = String(item.text ?? "").trim();
          if (text) {
            messages.push({
              role: "assistant",
              text,
              turnId: turn.id ?? null,
              turnStatus: normalizeNativeTurnStatus(turn.status),
              attachments: [],
              turnIndex,
              itemIndex,
            });
          }
        }
      }
    }
    return messages;
  }

  _extractAttachmentSummaryFromNativeThread(thread) {
    const client = this._getNativeAppServerClient();
    const counts = {};
    if (thread == null || !Array.isArray(thread.turns)) {
      return {
        source: "app_server_native",
        totalItems: 0,
        byType: counts,
      };
    }
    for (const [turnIndex, turn] of thread.turns.entries()) {
      if (!Array.isArray(turn?.items)) {
        continue;
      }
      for (const [itemIndex, item] of turn.items.entries()) {
        if (item?.type !== "userMessage") {
          continue;
        }
        const rawContent = Array.isArray(item.content) ? item.content : [];
        const text =
          client?.formatUserInput instanceof Function
            ? client.formatUserInput(rawContent)
            : "";
        const attachments = this._extractNativeUserMessageAttachments({
          item,
          rawContent,
          formattedText: text,
          context: {
            turnId: turn.id ?? null,
            turnIndex,
            itemIndex,
          },
        });
        for (const attachment of attachments) {
          const key = String(attachment?.contentType ?? attachment?.kind ?? "unknown");
          counts[key] = (counts[key] ?? 0) + 1;
        }
      }
    }
    return {
      source: "app_server_native",
      totalItems: Object.values(counts).reduce((sum, value) => sum + value, 0),
      byType: counts,
    };
  }

  _buildNativeContextBundle(
    binding,
    thread,
    {
      localThreadId = binding?.local_thread_id ?? null,
      localConversationId =
        binding?.local_conversation_id ?? binding?.local_thread_id ?? null,
    } = {},
  ) {
    const visibleMessages = this._extractVisibleMessagesFromNativeThread(thread);
    const rolloutToolSummaries = this._buildRolloutTurnToolSummaries(thread, visibleMessages);
    return {
      bindingId: binding.binding_id,
      localThreadId,
      localConversationId,
      contextVersion: binding.context_version,
      systemPrompt: "needs_desktop_refresh",
      visibleMessages,
      toolStateSummary: {
        source: "app_server_native",
        ...(rolloutToolSummaries.latestToolSummary != null
          ? rolloutToolSummaries.latestToolSummary
          : {}),
        threadStatus: thread?.status?.type ?? null,
        turnCount: Array.isArray(thread?.turns) ? thread.turns.length : 0,
        visibleMessageCount: visibleMessages.length,
      },
      turnToolSummaries: rolloutToolSummaries.turnToolSummaries,
      attachmentSummary: this._extractAttachmentSummaryFromNativeThread(thread),
      memorySummary: {
        note: "Native app-server export exposes visible user and assistant messages only.",
        threadName: thread?.name ?? null,
        preview: thread?.preview ?? null,
        path: thread?.path ?? null,
      },
      reasoningSummary: {
        type: "summary_only",
        text: "Bridge exports visible messages and thread status from the native app-server path. Raw hidden chain is not exported.",
      },
      generatedAt: nowIso(),
    };
  }

  _buildNativeInboundText(text, attachments) {
    const requestText = String(text ?? "").trim();
    const attachmentList = Array.isArray(attachments) ? attachments : [];
    const hasImageAttachment = attachmentList.some(
      (attachment) => String(attachment?.kind ?? "").trim().toLowerCase() === "image",
    );
    const fileAttachments = attachmentList
      .map((attachment) => {
        const sourcePath =
          String(attachment?.sourcePath ?? attachment?.path ?? "").trim() || null;
        if (!sourcePath) {
          return null;
        }
        const kind = String(attachment?.kind ?? "").trim().toLowerCase();
        if (kind === "image") {
          return null;
        }
        return {
          label:
            String(attachment?.name ?? path.basename(sourcePath) ?? "").trim() ||
            path.basename(sourcePath),
          path: sourcePath,
        };
      })
      .filter(Boolean);
    if (fileAttachments.length === 0) {
      return requestText || (hasImageAttachment ? "# Files mentioned by the user:\n\n## My request for Codex:" : "");
    }
    const lines = ["# Files mentioned by the user:", ""];
    for (const attachment of fileAttachments) {
      lines.push(`## ${attachment.label}: ${attachment.path}`);
    }
    lines.push("## My request for Codex:");
    if (requestText) {
      lines.push(requestText);
    }
    return lines.join("\n").trimEnd();
  }

  _buildNativeInboundInput(text, attachments) {
    const input = [];
    const normalizedText = this._buildNativeInboundText(text, attachments);
    if (normalizedText) {
      input.push({
        type: "text",
        text: normalizedText,
        text_elements: [],
      });
    }
    for (const attachment of Array.isArray(attachments) ? attachments : []) {
      const sourcePath =
        String(attachment?.sourcePath ?? attachment?.path ?? "").trim() || null;
      if (!sourcePath) {
        continue;
      }
      const kind = String(attachment?.kind ?? "").trim().toLowerCase();
      if (kind === "image") {
        input.push({
          type: "localImage",
          path: sourcePath,
        });
      }
    }
    return input;
  }

  _buildNativeInboundAttachments(attachments) {
    return (Array.isArray(attachments) ? attachments : [])
      .map((attachment) => {
        const sourcePath =
          String(attachment?.sourcePath ?? attachment?.path ?? "").trim() || null;
        if (!sourcePath) {
          return null;
        }
        return {
          localPath: sourcePath,
          filename:
            String(attachment?.name ?? path.basename(sourcePath) ?? "").trim() ||
            path.basename(sourcePath),
        };
      })
      .filter(Boolean);
  }

  async _submitInboundViaNativeAppServerTurn({
    client,
    threadId,
    input,
    attachments,
    threadStart = null,
  }) {
    const turn = await client.startTurn({
      threadId,
      input,
      attachments,
    });
    try {
      await this.debugNavigateToRoute({
        route: `/local/${threadId}`,
        settleMs: Math.min(1500, this.config?.runtime?.submitTimeoutMs ?? 1500),
      });
    } catch {
      // Keep the native submission result authoritative even if the packaged UI route does not refresh.
    }
    return {
      ok: true,
      path: "native_app_server_client",
      localThreadId: threadId,
      localConversationId: threadId,
      localTurnId: turn?.turn?.id ?? null,
      turnStatus: turn?.turn?.status ?? null,
      createdThread: threadStart != null,
      threadStart,
    };
  }

  async _submitInboundViaNative({ binding, text, attachments }) {
    const client = this._getNativeAppServerClient();
    if (client == null) {
      throw new Error("native_app_server_client_unavailable");
    }
    let threadId =
      normalizeConversationId(binding?.local_thread_id) ??
      normalizeConversationId(binding?.local_conversation_id);
    let threadStart = null;
    if (threadId == null) {
      const created = await client.startThread({
        cwd: this._getDefaultNativeCwd(),
      });
      threadId = normalizeConversationId(created?.thread?.id);
      if (threadId == null) {
        throw new Error("native_thread_start_failed");
      }
      threadStart = this._sanitizeForRpc(created, 2);
    }
    const nativeInput = this._buildNativeInboundInput(text, attachments);
    const nativeAttachments = this._buildNativeInboundAttachments(attachments);
    if (nativeInput.length === 0 && nativeAttachments.length === 0) {
      throw new Error("native_inbound_input_empty");
    }
    return await this._submitInboundViaNativeAppServerTurn({
      client,
      threadId,
      input: nativeInput,
      attachments: nativeAttachments,
      threadStart,
    });
  }

  _describeDebugValue(value) {
    if (value == null) return { type: "null" };
    if (typeof value === "function") {
      return {
        type: "function",
        name: value.name || null,
      };
    }
    if (Array.isArray(value)) {
      return {
        type: "array",
        length: value.length,
      };
    }
    if (typeof value === "object") {
      return {
        type: "object",
        constructorName: value.constructor?.name ?? null,
        keys: Object.keys(value).slice(0, 64),
      };
    }
    return { type: typeof value, value };
  }

  _describeObjectEntries(value, limit = 64) {
    if (value == null || typeof value !== "object") {
      return {};
    }
    return Object.fromEntries(
      Object.keys(value)
        .slice(0, limit)
        .map((key) => [key, this._describeDebugValue(value[key])]),
    );
  }

  _describePrototypeMethods(value, limit = 96) {
    if (value == null || (typeof value !== "object" && typeof value !== "function")) {
      return [];
    }
    const prototype = Object.getPrototypeOf(value);
    if (prototype == null) {
      return [];
    }
    return Object.getOwnPropertyNames(prototype)
      .filter((name) => name !== "constructor")
      .slice(0, limit);
  }

  _resolveDebugRoot(root) {
    switch (root) {
      case "bootstrapContext":
        return global.__codexBootstrapContext ?? null;
      case "mainModule":
        return global.__codexMainModule ?? null;
      case "runtimeHandles":
        return global.__codexRuntimeHandles ?? null;
      case "localHostContext":
        return global.__codexRuntimeHandles?.localHostContext ?? null;
      case "messageHandler":
        return global.__codexRuntimeHandles?.getMessageHandler?.() ?? null;
      case "applicationMenuManager":
        return global.__codexRuntimeHandles?.applicationMenuManager ?? null;
      case "windowServices":
        return global.__codexRuntimeHandles?.windowServices ?? null;
      case "preferredWindow":
        return this._getPreferredWindowOrThrow();
      case "preferredWebContents":
        return this._getPreferredWindowOrThrow().webContents ?? null;
      case "electron":
        return this.electron ?? null;
      case "app":
        return this.app ?? null;
      default:
        throw new Error(`unknown_debug_root:${root}`);
    }
  }

  _resolveDebugPath(path) {
    if (typeof path !== "string" || !path.trim()) {
      throw new Error("debug_path_required");
    }
    const segments = path
      .split(".")
      .map((segment) => segment.trim())
      .filter(Boolean);
    if (segments.length === 0) {
      throw new Error("debug_path_required");
    }
    const [root, ...rest] = segments;
    let value = this._resolveDebugRoot(root);
    for (const segment of rest) {
      if (value == null) {
        throw new Error(`debug_path_unresolved:${path}`);
      }
      value = value[segment];
    }
    return {
      path,
      segments,
      value,
    };
  }

  _resolveDebugArgs(value) {
    if (Array.isArray(value)) {
      return value.map((entry) => this._resolveDebugArgs(entry));
    }
    if (value == null || typeof value !== "object") {
      return value;
    }
    if (
      Object.keys(value).length === 1 &&
      typeof value.$ref === "string"
    ) {
      return this._resolveDebugPath(value.$ref).value;
    }
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [
        key,
        this._resolveDebugArgs(entry),
      ]),
    );
  }

  _sanitizeForRpc(value, depth = 2, seen = new WeakSet()) {
    if (value == null) {
      return null;
    }
    if (
      typeof value === "string" ||
      typeof value === "number" ||
      typeof value === "boolean"
    ) {
      return value;
    }
    if (typeof value === "bigint") {
      return String(value);
    }
    if (typeof value === "function") {
      return {
        type: "function",
        name: value.name || null,
      };
    }
    if (typeof value !== "object") {
      return {
        type: typeof value,
      };
    }
    if (seen.has(value)) {
      return { type: "circular" };
    }
    seen.add(value);
    if (Array.isArray(value)) {
      if (depth <= 0) {
        return {
          type: "array",
          length: value.length,
        };
      }
      return value
        .slice(0, 16)
        .map((entry) => this._sanitizeForRpc(entry, depth - 1, seen));
    }
    if (depth <= 0) {
      return {
        type: "object",
        constructorName: value.constructor?.name ?? null,
        keys: Object.keys(value).slice(0, 24),
      };
    }
    return Object.fromEntries(
      Object.keys(value)
        .slice(0, 32)
        .map((key) => [
          key,
          this._sanitizeForRpc(value[key], depth - 1, seen),
        ]),
    );
  }

  async _pollBindings() {
    // 极简修复：确保 Codex 原生通知监听已安装
    if (!this._hasNativeTurnNotificationHook()) {
      this._refreshNativeTurnNotificationHook();
    }
    // Phase 3 极简绑定守卫：只允许用户真正发送消息时绑定
    if (!this.userJustSentMessage) return;
    if (!this.pendingUserMessageBindingPoll) {
      return;
    }
    this.pendingUserMessageBindingPoll = false;
    this.userJustSentMessage = false;
    const bindings = this.store.listBindings();
    if (bindings.length === 0) {
      return;
    }
    const nativeClient = this._getNativeAppServerClient();
    if (nativeClient == null) {
      this._recordError(new Error("native_app_server_required_for_screenless_bridge"));
      return;
    }
    const allowFollowActivation = false;
    for (const binding of bindings) {
      const targetThreadId = this._getNativePollTargetThreadId(
        binding,
        null,
        { allowFollowActivation },
      );
      if (targetThreadId == null) {
        continue;
      }
      const nativeThreadMetadata = await this._readNativeThreadMetadata(targetThreadId);
      if (nativeThreadMetadata != null) {
        this._rememberNativeBindingMetadata(binding, nativeThreadMetadata);
        continue;
      }
    }
  }

  _buildInboundEchoComparable(payload) {
    const attachments = Array.isArray(payload?.attachments)
      ? payload.attachments
      : [];
    const attachmentEntries = attachments
      .map((attachment) => {
        if (attachment == null || typeof attachment !== "object") {
          return null;
        }
        const sourcePath =
          String(
            attachment.sourcePath ??
              attachment.localPath ??
              attachment.filePath ??
              attachment.path ??
              "",
          )
            .trim()
            .toLowerCase() || null;
        const sourceUrl =
          String(attachment.sourceUrl ?? attachment.url ?? "").trim() || null;
        const dataUrl =
          String(attachment.dataUrl ?? attachment.image_url ?? "").trim() || null;
        const id =
          String(
            attachment.fileKey ??
              attachment.file_key ??
              attachment.token ??
              attachment.key ??
              "",
          ).trim() || null;
        const locator = sourcePath ?? sourceUrl ?? id;
        const dataHash = dataUrl
          ? createHash("sha1").update(dataUrl, "utf8").digest("hex")
          : null;
        if (!locator && !dataHash) {
          return null;
        }
        return {
          kind:
            String(
              attachment.kind ??
                attachment.type ??
                attachment.mimeType ??
                attachment.mime_type ??
                "",
            )
              .trim()
              .toLowerCase() || "file",
          locator,
          dataHash,
        };
      })
      .filter(Boolean)
      .sort((left, right) =>
        JSON.stringify(left).localeCompare(JSON.stringify(right)),
      );
    return {
      text: normalizeComparableText(payload?.text),
      attachmentFingerprint:
        attachmentEntries.length > 0
          ? createHash("sha1")
              .update(JSON.stringify(attachmentEntries), "utf8")
              .digest("hex")
              .slice(0, 16)
          : "",
    };
  }

  _rememberInboundEcho(bindingId, payload) {
    const key = `inboundEcho:${bindingId}`;
    const nowMs = Date.now();
    const rawTurnId = String(payload?.turnId ?? "").trim();
    const normalizedTurnId = normalizeConversationId(rawTurnId) ?? (rawTurnId || null);
    const state = (this.store.getRuntimeState(key) ?? []).filter((entry) => {
      const comparableDeadline = Number(entry?.comparableExpiresAt ?? 0);
      const turnDeadline = Number(entry?.turnIdExpiresAt ?? 0);
      return comparableDeadline > nowMs || turnDeadline > nowMs;
    });
    state.push({
      ...this._buildInboundEchoComparable(payload),
      turnId: normalizedTurnId,
      comparableExpiresAt: nowMs + INBOUND_ECHO_COMPARABLE_TTL_MS,
      turnIdExpiresAt: normalizedTurnId ? nowMs + INBOUND_ECHO_TURN_TTL_MS : 0,
    });
    this.store.setRuntimeState(key, state.slice(-16));
  }

  _consumeInboundEcho(bindingId, payload) {
    const key = `inboundEcho:${bindingId}`;
    const nowMs = Date.now();
    const state = (this.store.getRuntimeState(key) ?? []).filter(
      (entry) =>
        Number(entry?.comparableExpiresAt ?? 0) > nowMs ||
        Number(entry?.turnIdExpiresAt ?? 0) > nowMs,
    );
    const comparable = this._buildInboundEchoComparable(payload);
    const rawTurnId = String(payload?.turnId ?? "").trim();
    const normalizedTurnId = normalizeConversationId(rawTurnId) ?? (rawTurnId || null);
    let index = -1;
    if (normalizedTurnId) {
      index = state.findIndex(
        (entry) =>
          String(entry?.turnId ?? "").trim() === normalizedTurnId &&
          Number(entry?.turnIdExpiresAt ?? 0) > nowMs,
      );
    }
    if (index === -1) {
      const allowComparableMatchAgainstTurnEntries = normalizedTurnId == null;
      index = state.findIndex(
        (entry) =>
          Number(entry?.comparableExpiresAt ?? 0) > nowMs &&
          (allowComparableMatchAgainstTurnEntries ||
            !String(entry?.turnId ?? "").trim()) &&
          entry.text === comparable.text &&
          entry.attachmentFingerprint === comparable.attachmentFingerprint,
      );
    }
    if (index === -1) {
      this.store.setRuntimeState(key, state);
      return false;
    }
    state.splice(index, 1);
    this.store.setRuntimeState(key, state);
    return true;
  }

  _recomputeStatus() {
    const configured =
      Boolean(this.config?.appId?.trim()) && Boolean(this.config?.appSecret?.trim());
    this.status.status = !this.config?.enabled
      ? "offline"
      : configured && this.sidecarManager?.getState().running
        ? "online"
        : configured
          ? "recovering"
          : "degraded";
    this.status.sidecar = this.sidecarManager?.getState() ?? null;
    this.status.lastUpdatedAt = nowIso();
    this.store?.setRuntimeState("bridge_status", this._getPublicStatus());
    this._publishSharedState();
  }

  _recordError(error) {
    this.status.lastError = error instanceof Error ? error.message : String(error);
    this._recomputeStatus();
  }

  _publishSharedState() {
    const payload = {
      ...this._getPublicStatus(),
      pipeName: this.paths.pipeName,
      controlledRestart: this._buildControlledRestartSharedState(),
    };
    this.store?.setRuntimeState("shared_object:feishu_bridge_runtime", payload);
    for (const window of this.electron.BrowserWindow.getAllWindows()) {
      if (window.isDestroyed()) {
        continue;
      }
      window.webContents.send("codex_desktop:message-for-view", {
        type: "shared-object-updated",
        key: "feishu_bridge_runtime",
        value: payload,
      });
    }
  }
}

module.exports = {
  FeishuBridgeRuntime,
};

// Phase 1 清理完成 - 已移除快照 / window tracker / 复杂绑定逻辑
// 仅保留用户消息触发绑定 + 基础卡片更新
// Phase 4 Final - 所有无效冗余代码已删除，只保留核心功能
