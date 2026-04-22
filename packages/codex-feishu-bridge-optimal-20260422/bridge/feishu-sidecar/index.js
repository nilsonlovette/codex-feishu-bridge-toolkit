"use strict";

const fs = require("node:fs");
const http = require("node:http");
const crypto = require("node:crypto");
const net = require("node:net");
const path = require("node:path");
const readline = require("node:readline");
const { fileURLToPath } = require("node:url");

const { BridgeStore } = require("../bridge-store");
const { loadBridgeConfig, resolveBridgePaths } = require("../config");
const {
  detectMermaidDiagramType,
  isSupportedMermaidDiagramType,
  renderMermaidDiagramToPng,
} = require("./mermaid-renderer");

let Lark = null;
try {
  Lark = require("@larksuiteoapi/node-sdk");
} catch {
  Lark = null;
}

const FEISHU_TEXT_REQUEST_MAX_BYTES = 29 * 1024;
const FEISHU_CARD_REQUEST_MAX_BYTES = 28 * 1024;
const FEISHU_TEXT_CHUNK_MAX_ITERATIONS = 12;
const FEISHU_MEASURE_PLACEHOLDER_RECEIVE_ID = "ou_feishu_measure_placeholder";
const FEISHU_CARD_MEASURE_PLACEHOLDER_MESSAGE_ID = "om_feishu_card_measure_placeholder";
const FEISHU_CARD_FILE_SUMMARY_MAX_CHARS = 800;
const ASSISTANT_CARD_STREAMING_TEXT_MAX_CHARS = 1400;
const ASSISTANT_CARD_STREAMING_MAX_PARAGRAPHS = 3;
const ASSISTANT_CARD_NATIVE_TABLE_MAX_COLUMNS = 8;
const ASSISTANT_CARD_NATIVE_TABLE_MAX_ROWS = 25;
const ASSISTANT_CARD_MARKDOWN_TABLE_MAX_COLUMNS = 10;
const ASSISTANT_CARD_MARKDOWN_TABLE_MAX_ROWS = 30;
const ASSISTANT_CARD_FILE_TABLE_MAX_COLUMNS = 15;
const ASSISTANT_CARD_FILE_TABLE_MAX_ROWS = 50;
const ASSISTANT_CARD_NATIVE_TABLE_MAX_CELL_CHARS = 160;
const ASSISTANT_CARD_NATIVE_TABLE_MAX_ROW_CHARS = 600;
const ASSISTANT_CARD_NATIVE_TABLE_COMPONENT_MAX_COUNT = 5;
const ASSISTANT_CARD_MERMAID_RENDER_TIMEOUT_MS = 12000;
const ASSISTANT_CARD_PLAYBACK_TICK_MS = 250;
const ASSISTANT_CARD_LIVE_MIN_SEGMENTS_PER_TICK = 1;
const ASSISTANT_CARD_LIVE_MAX_SEGMENTS_PER_TICK = 1;
const ASSISTANT_CARD_CATCH_UP_MIN_SEGMENTS_PER_TICK = 1;
const ASSISTANT_CARD_CATCH_UP_PROGRESS_MAX_SEGMENTS_PER_TICK = 1;
const ASSISTANT_CARD_CATCH_UP_FINAL_MAX_SEGMENTS_PER_TICK = 24;
const ASSISTANT_CARD_FAST_FINAL_ONLY_MAX_CHARS = 160;
const ASSISTANT_CARD_STREAMING_BACKEND_PATCH = "patch";
const ASSISTANT_CARD_STREAMING_BACKEND_CARDKIT = "cardkit";
const ASSISTANT_CARD_CARDKIT_DEFAULT_ELEMENT_ID = "main_md";
const ASSISTANT_CARD_CARDKIT_PROGRESS_ELEMENT_ID = "think_md";
const ASSISTANT_CARD_CARDKIT_TOOL_ELEMENT_ID = "tools_md";
const ASSISTANT_CARD_CARDKIT_FINAL_ELEMENT_ID = "final_md";
const ASSISTANT_CARD_CARDKIT_FOOTER_ELEMENT_ID = "footer_md";
const ASSISTANT_CARD_CARDKIT_DEFAULT_PRINT_FREQUENCY_MS = 30;
const ASSISTANT_CARD_CARDKIT_DEFAULT_PRINT_STEP = 1;
const ASSISTANT_CARD_CARDKIT_DEFAULT_PRINT_STRATEGY = "delay";
const ASSISTANT_CARD_CARDKIT_STREAM_RECOVERY_MAX_ATTEMPTS = 2;
const ASSISTANT_CARD_CARDKIT_STREAM_RECOVERY_MAX_PER_CARD = 3;
const ASSISTANT_CARD_CARDKIT_STREAM_PREOPEN_STALE_MS = 5 * 60 * 1000;
const ASSISTANT_CARD_CARDKIT_STREAM_PREOPEN_MAX_PER_CARD = 3;
const ASSISTANT_CARD_CARDKIT_STREAM_PREFIX = "\u200b";
const ASSISTANT_CARD_CARDKIT_LIST_STREAM_PREFIX = `- ${ASSISTANT_CARD_CARDKIT_STREAM_PREFIX}`;
const ASSISTANT_CARD_HEADER_TITLE = "\ud83d\udcac \u5f53\u524d\u5bf9\u8bdd";
const ASSISTANT_CARD_CONVERSATION_META_LABEL = "\ud83d\udccc \u5bf9\u8bddID";
const ASSISTANT_CARD_PROGRESS_PANEL_TITLE = "\ud83e\udded \u601d\u8003\u8fc7\u7a0b";
const ASSISTANT_CARD_TOOL_PANEL_TITLE = "\ud83d\udee0\ufe0f \u5de5\u5177\u6458\u8981";
const ASSISTANT_CARD_PROGRESS_PLACEHOLDER = "思考中...";
const ASSISTANT_CARD_TOOL_PLACEHOLDER = "工具执行中...";
const ASSISTANT_CARD_PROGRESS_EMPTY_FINAL = "本轮未输出思考过程";
const ASSISTANT_CARD_TOOL_EMPTY_FINAL = "本轮未调用工具";
const DEFAULT_USER_IDENTITY_SCOPE =
  "im:message im:message.send_as_user im:resource offline_access";
const REQUIRED_USER_ATTACHMENT_SCOPES = Object.freeze(["im:resource"]);
const LEGACY_USER_ATTACHMENT_SCOPES = Object.freeze(["im:resource:upload"]);
const DEFAULT_INBOUND_EVENT_MAX_AGE_MS = 15 * 60 * 1000;
const ASSISTANT_CARD_OUTBOUND_TELEMETRY_TIMESTAMP_FIELDS = Object.freeze([
  "firstEventAt",
  "lastEventAt",
  "firstCardSyncQueuedAt",
  "firstCardSyncStartedAt",
  "firstCardSyncCompletedAt",
  "cardkitEnsureStartedAt",
  "cardkitEnsureFinishedAt",
  "cardkitCreateStartedAt",
  "cardkitCreateFinishedAt",
  "cardkitSettingsStartedAt",
  "cardkitSettingsFinishedAt",
  "cardkitMessageSendStartedAt",
  "cardkitMessageSendFinishedAt",
  "cardkitFinalUpdateStartedAt",
  "cardkitFinalUpdateFinishedAt",
  "lastDispatchRequestedAt",
  "lastPendingActionQueuedAt",
  "lastSyncStartedAt",
  "lastCardUpdateStartedAt",
  "lastCardUpdateFinishedAt",
  "lastSyncFinishedAt",
  "lastPresentationCompletedAt",
  "finalCloseStartedAt",
  "finalCloseCompletedAt",
]);
const ASSISTANT_CARD_OUTBOUND_TELEMETRY_NUMBER_FIELDS = Object.freeze([
  "lastDispatchRevision",
  "lastSyncRevision",
  "lastAppliedRevision",
  "lastEventToDispatchMs",
  "firstEventToFirstCardSyncStartMs",
  "firstCardQueueToSyncStartMs",
  "firstCardSyncMs",
  "firstCardQueueToCompleteMs",
  "cardkitEnsureMs",
  "cardkitCreateMs",
  "cardkitSettingsMs",
  "cardkitMessageSendMs",
  "cardkitFinalUpdateMs",
  "lastDispatchToSyncStartMs",
  "lastCardUpdateMs",
  "lastSyncMs",
  "lastEventToSyncFinishedMs",
  "sourceToPresentationCompleteMs",
  "finalCloseMs",
]);
const ASSISTANT_CARD_OUTBOUND_TELEMETRY_STRING_FIELDS = Object.freeze([
  "lastDispatchMode",
  "lastRenderMode",
  "lastSyncStatus",
  "lastCardMessageId",
  "lastSyncError",
]);
const ASSISTANT_CARD_OUTBOUND_TELEMETRY_FIRST_TIMESTAMP_FIELDS = Object.freeze([
  "firstCardSyncQueuedAt",
  "firstCardSyncStartedAt",
  "firstCardSyncCompletedAt",
  "cardkitEnsureStartedAt",
  "cardkitEnsureFinishedAt",
]);
const MESSAGE_LEDGER_DELIVERY_TELEMETRY_TIMESTAMP_FIELDS = Object.freeze([
  "desktopDetectedAt",
  "ledgerCreatedAt",
  "deliveryStartedAt",
  "deliveryCompletedAt",
]);
const MESSAGE_LEDGER_DELIVERY_TELEMETRY_NUMBER_FIELDS = Object.freeze([
  "detectedToLedgerMs",
  "ledgerToDeliveryStartMs",
  "deliveryMs",
  "detectedToDeliveryCompletedMs",
]);
const MESSAGE_LEDGER_DELIVERY_TELEMETRY_STRING_FIELDS = Object.freeze([
  "deliveryStatus",
  "deliveryDestination",
  "deliveryIdentity",
  "deliveryError",
]);

function getFileMtimeIso(filePath) {
  try {
    return fs.statSync(filePath).mtime.toISOString();
  } catch {
    return null;
  }
}

function buildFeishuTextChunkingPolicy() {
  return {
    algorithm: "request_json_bytes",
    maxRequestBytes: FEISHU_TEXT_REQUEST_MAX_BYTES,
    maxIterations: FEISHU_TEXT_CHUNK_MAX_ITERATIONS,
    splitLabelMode: "on_split_only",
    sourceFileMtime: getFileMtimeIso(__filename),
  };
}

function nowIso() {
  return new Date().toISOString();
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function parseMessageText(rawContent) {
  const source = rawContent ?? "{}";
  try {
    const parsed = JSON.parse(source);
    const richText = extractRichTextPlainText(parsed);
    if (richText) {
      return richText;
    }
    return String(parsed?.text ?? "").trim();
  } catch {
    return String(source ?? "").trim();
  }
}

function normalizeAllowlist(value) {
  if (Array.isArray(value)) {
    return new Set(
      value
        .map((entry) => String(entry ?? "").trim())
        .filter(Boolean),
    );
  }
  if (typeof value === "string") {
    return new Set(
      value
        .split(/[,\s]+/)
        .map((entry) => entry.trim())
        .filter(Boolean),
    );
  }
  return new Set();
}

function safeErrorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

function summarizeObjectShape(value, depth = 0) {
  if (value == null || typeof value !== "object") {
    return { type: value == null ? "null" : typeof value };
  }
  if (Array.isArray(value)) {
    return {
      type: "array",
      length: value.length,
      sample: depth > 0 ? undefined : summarizeObjectShape(value[0], depth + 1),
    };
  }
  const keys = Object.keys(value).slice(0, 20);
  const summary = {
    type: "object",
    keys,
  };
  if (depth === 0) {
    for (const key of ["code", "msg", "message", "data"]) {
      if (Object.prototype.hasOwnProperty.call(value, key)) {
        summary[key] = summarizeObjectShape(value[key], depth + 1);
      }
    }
  }
  return summary;
}

function extractFeishuUploadKey(payload, keyName) {
  if (!payload || typeof payload !== "object") {
    return null;
  }
  const directKey = String(payload?.[keyName] ?? "").trim() || null;
  if (directKey) {
    return directKey;
  }
  const data = payload?.data;
  if (!data || typeof data !== "object") {
    return null;
  }
  return String(data?.[keyName] ?? "").trim() || null;
}

function createAttachmentUploadKeyMissingError(msgType, response) {
  const error = new Error(`attachment_upload_key_missing:${msgType}`);
  error.permanentDelivery = true;
  error.uploadMsgType = msgType;
  error.uploadResponseShape = summarizeObjectShape(response);
  return error;
}

function isAttachmentUploadKeyMissingError(error) {
  return safeErrorMessage(error).startsWith("attachment_upload_key_missing:");
}

function isPermanentDeliveryError(error) {
  const status =
    Number(error?.response?.status ?? error?.status ?? error?.statusCode ?? NaN);
  if (Number.isFinite(status)) {
    return status >= 400 && status < 500 && status !== 429;
  }
  const message = safeErrorMessage(error).toLowerCase();
  return (
    /status code 40\d/.test(message) ||
    /status code 41\d/.test(message) ||
    /status code 42\d/.test(message) ||
    /status code 43\d/.test(message) ||
    /status code 44\d/.test(message)
  ) && !message.includes("429");
}

function isPermanentAssistantCardSyncError(error) {
  const message = safeErrorMessage(error).toLowerCase();
  if (message.startsWith("assistant_card_render_too_large")) {
    return true;
  }
  if (isPermanentDeliveryError(error)) {
    return true;
  }
  if (!message.includes("feishu_cardkit")) {
    return false;
  }
  return (
    message.includes(":200850:") ||
    message.includes(":300309:") ||
    message.includes(":300317:") ||
    message.includes("card streaming timeout") ||
    message.includes("streaming mode is closed") ||
    message.includes("sequence number compare failed")
  );
}

function isRecoverableAssistantCardKitStreamingError(error) {
  const message = safeErrorMessage(error).toLowerCase();
  if (!message.includes("feishu_cardkit")) {
    return false;
  }
  return (
    message.includes(":200850:") ||
    message.includes(":300309:") ||
    message.includes("card streaming timeout") ||
    message.includes("streaming mode is closed")
  );
}

function getFeishuDeliveryStatusPriority(status) {
  return String(status ?? "").trim() === "pending_feishu_delivery" ? 0 : 1;
}

function sortFeishuDeliveryLedgers(ledgers) {
  return [...(Array.isArray(ledgers) ? ledgers : [])].sort((left, right) => {
    const statusDelta =
      getFeishuDeliveryStatusPriority(left?.status) -
      getFeishuDeliveryStatusPriority(right?.status);
    if (statusDelta !== 0) {
      return statusDelta;
    }
    const createdAtDelta = String(left?.created_at ?? "").localeCompare(
      String(right?.created_at ?? ""),
    );
    if (createdAtDelta !== 0) {
      return createdAtDelta;
    }
    return Number(left?.id ?? 0) - Number(right?.id ?? 0);
  });
}

function parseScopeTokens(scopeValue) {
  return new Set(
    String(scopeValue ?? "")
      .split(/[\s,]+/)
      .map((token) => token.trim())
      .filter(Boolean),
  );
}

function getMissingAttachmentScopes(scopeValue) {
  const scopes = parseScopeTokens(scopeValue);
  return REQUIRED_USER_ATTACHMENT_SCOPES.filter((scope) => {
    if (scopes.has(scope)) {
      return false;
    }
    // Older Feishu apps may still hold the legacy upload-only scope.
    if (
      scope === "im:resource" &&
      LEGACY_USER_ATTACHMENT_SCOPES.some((legacyScope) => scopes.has(legacyScope))
    ) {
      return false;
    }
    return true;
  });
}

function buildQueuedInboundKey(providerMessageId) {
  return `sidecar:queuedInbound:${providerMessageId}`;
}

function normalizeFeishuTimestampMs(value) {
  if (value == null) {
    return null;
  }
  const raw = String(value).trim();
  if (!raw) {
    return null;
  }
  const numeric = Number(raw);
  if (Number.isFinite(numeric) && numeric > 0) {
    if (numeric < 10_000_000_000) {
      return Math.trunc(numeric * 1000);
    }
    if (numeric > 10_000_000_000_000) {
      return Math.trunc(numeric / 1000);
    }
    return Math.trunc(numeric);
  }
  const parsed = Date.parse(raw);
  return Number.isFinite(parsed) ? parsed : null;
}

function getInboundRawEventTimestamps(data) {
  const message = data?.message ?? data?.event?.message ?? null;
  const messageCreatedAtMs = normalizeFeishuTimestampMs(message?.create_time);
  const eventCreatedAtMs = normalizeFeishuTimestampMs(
    data?.event?.create_time ?? data?.create_time ?? data?.header?.create_time,
  );
  return {
    messageCreatedAtMs,
    eventCreatedAtMs,
    createdAtMs: messageCreatedAtMs ?? eventCreatedAtMs,
  };
}

function getInboundEventMaxAgeMs(config) {
  const raw = config?.runtime?.inboundEventMaxAgeMs;
  if (raw == null) {
    return DEFAULT_INBOUND_EVENT_MAX_AGE_MS;
  }
  const value = Number(raw);
  if (!Number.isFinite(value)) {
    return DEFAULT_INBOUND_EVENT_MAX_AGE_MS;
  }
  return Math.max(0, Math.trunc(value));
}

function evaluateInboundEventFreshness({
  createdAtMs,
  nowMs = Date.now(),
  maxAgeMs = DEFAULT_INBOUND_EVENT_MAX_AGE_MS,
} = {}) {
  const normalizedCreatedAtMs = Number(createdAtMs);
  const normalizedMaxAgeMs = Number(maxAgeMs);
  if (!Number.isFinite(normalizedMaxAgeMs) || normalizedMaxAgeMs <= 0) {
    return {
      stale: false,
      reason: "disabled",
      createdAtMs: Number.isFinite(normalizedCreatedAtMs) ? normalizedCreatedAtMs : null,
      ageMs: null,
      maxAgeMs: 0,
    };
  }
  if (!Number.isFinite(normalizedCreatedAtMs) || normalizedCreatedAtMs <= 0) {
    return {
      stale: false,
      reason: "missing_timestamp",
      createdAtMs: null,
      ageMs: null,
      maxAgeMs: normalizedMaxAgeMs,
    };
  }
  const ageMs = Number(nowMs) - normalizedCreatedAtMs;
  return {
    stale: ageMs > normalizedMaxAgeMs,
    reason: ageMs > normalizedMaxAgeMs ? "stale_inbound_event" : "fresh",
    createdAtMs: normalizedCreatedAtMs,
    ageMs,
    maxAgeMs: normalizedMaxAgeMs,
  };
}

function parseDataUrlToBuffer(dataUrl) {
  const source = String(dataUrl ?? "").trim();
  const match = source.match(/^data:([^;,]+)?(?:;charset=[^;,]+)?(?:;(base64))?,(.*)$/is);
  if (!match) {
    return null;
  }
  const mimeType = String(match[1] ?? "").trim() || null;
  const isBase64 = String(match[2] ?? "").toLowerCase() === "base64";
  const body = String(match[3] ?? "");
  try {
    return {
      mimeType,
      buffer: isBase64
        ? Buffer.from(body.replace(/\s+/g, ""), "base64")
        : Buffer.from(decodeURIComponent(body), "utf8"),
    };
  } catch {
    return null;
  }
}

function inferAttachmentKind(attachment) {
  const kind = String(attachment?.kind ?? "").trim().toLowerCase();
  if (kind === "image" || kind === "file") {
    return kind;
  }
  const mimeType = String(attachment?.mimeType ?? "").trim().toLowerCase();
  if (mimeType.startsWith("image/")) {
    return "image";
  }
  return "file";
}

function normalizeMirroredAttachments(value) {
  if (!Array.isArray(value)) {
    return [];
  }
  return value
    .map((attachment, index) => {
      if (attachment == null || typeof attachment !== "object") {
        return null;
      }
      const sourcePath =
        String(attachment.sourcePath ?? attachment.path ?? "").trim() || null;
      const sourceUrl =
        String(attachment.sourceUrl ?? attachment.url ?? "").trim() || null;
      const dataUrl =
        String(attachment.dataUrl ?? attachment.image_url ?? "").trim() || null;
      if (!sourcePath && !sourceUrl && !dataUrl) {
        return null;
      }
      const normalized = {
        kind: inferAttachmentKind(attachment),
        name:
          String(
            attachment.name ??
              attachment.fileName ??
              attachment.file_name ??
              (sourcePath ? path.basename(sourcePath) : ""),
          ).trim() || null,
        mimeType: String(attachment.mimeType ?? "").trim() || null,
        sourceType: String(attachment.sourceType ?? "").trim() || null,
        sourcePath,
        sourceUrl,
        dataUrl,
        order: Number.isFinite(attachment.order) ? Number(attachment.order) : index,
      };
      const fingerprint = crypto
        .createHash("sha1")
        .update(
          JSON.stringify({
            kind: normalized.kind,
            name: normalized.name,
            mimeType: normalized.mimeType,
            sourceType: normalized.sourceType,
            sourcePath: normalized.sourcePath,
            sourceUrl: normalized.sourceUrl,
            dataHash:
              normalized.dataUrl != null
                ? crypto
                    .createHash("sha1")
                    .update(String(normalized.dataUrl), "utf8")
                    .digest("hex")
                : null,
            order: normalized.order,
          }),
          "utf8",
        )
        .digest("hex")
        .slice(0, 16);
      return {
        ...normalized,
        fingerprint,
      };
    })
    .filter(Boolean)
    .sort((left, right) => left.order - right.order);
}

function buildComparableAttachmentFingerprint(value) {
  if (!Array.isArray(value) || value.length === 0) {
    return "";
  }
  const comparableEntries = value
    .map((attachment) => {
      if (attachment == null || typeof attachment !== "object") {
        return null;
      }
      const sourcePath =
        String(attachment.sourcePath ?? attachment.path ?? "")
          .trim()
          .toLowerCase() || null;
      const sourceUrl =
        String(attachment.sourceUrl ?? attachment.url ?? "").trim() || null;
      const dataUrl =
        String(attachment.dataUrl ?? attachment.image_url ?? "").trim() || null;
      const canonicalLocator = sourcePath ?? sourceUrl ?? null;
      const dataHash =
        dataUrl != null
          ? crypto.createHash("sha1").update(dataUrl, "utf8").digest("hex")
          : null;
      if (!canonicalLocator && !dataHash) {
        return null;
      }
      return {
        kind: inferAttachmentKind(attachment),
        locator: canonicalLocator,
        dataHash,
      };
    })
    .filter(Boolean)
    .sort((left, right) =>
      JSON.stringify(left).localeCompare(JSON.stringify(right)),
    );
  if (comparableEntries.length === 0) {
    return "";
  }
  return crypto
    .createHash("sha1")
    .update(
      JSON.stringify(comparableEntries),
      "utf8",
    )
    .digest("hex")
    .slice(0, 16);
}

function normalizeMessageContentObject(rawContent) {
  if (rawContent == null) {
    return {};
  }
  if (typeof rawContent === "object") {
    return rawContent;
  }
  const source = String(rawContent ?? "").trim();
  if (!source) {
    return {};
  }
  try {
    const parsed = JSON.parse(source);
    return parsed != null && typeof parsed === "object"
      ? parsed
      : { text: String(parsed ?? "") };
  } catch {
    return { text: source };
  }
}

function extractRichTextLocaleBlock(content) {
  if (content == null || typeof content !== "object") {
    return null;
  }
  if (Array.isArray(content.content)) {
    return content;
  }
  const preferredLocales = ["zh_cn", "en_us"];
  for (const locale of preferredLocales) {
    const candidate = content[locale];
    if (candidate != null && typeof candidate === "object" && Array.isArray(candidate.content)) {
      return candidate;
    }
  }
  for (const candidate of Object.values(content)) {
    if (candidate != null && typeof candidate === "object" && Array.isArray(candidate.content)) {
      return candidate;
    }
  }
  return null;
}

function normalizeRichTextNodeText(node) {
  if (node == null || typeof node !== "object") {
    return "";
  }
  const tag = String(node.tag ?? "").trim().toLowerCase();
  if (!tag) {
    return "";
  }
  if (tag === "text" || tag === "a" || tag === "link") {
    return String(node.text ?? node.href ?? "").trim();
  }
  if (tag === "at") {
    return String(
      node.user_name ??
        node.userName ??
        node.name ??
        node.text ??
        node.open_id ??
        node.user_id ??
        "",
    ).trim();
  }
  if (tag === "code_block") {
    return String(node.text ?? node.content ?? "").trim();
  }
  if (tag === "emotion") {
    return String(node.emoji_type ?? node.name ?? "").trim();
  }
  return "";
}

function extractRichTextPlainText(rawContent) {
  const content = normalizeMessageContentObject(rawContent);
  const localeBlock = extractRichTextLocaleBlock(content);
  if (localeBlock == null) {
    return "";
  }
  const title = String(localeBlock.title ?? "").trim();
  const rowTexts = [];
  for (const row of localeBlock.content) {
    if (!Array.isArray(row)) {
      continue;
    }
    const rowText = row.map((node) => normalizeRichTextNodeText(node)).join("").trim();
    if (rowText) {
      rowTexts.push(rowText);
    }
  }
  const segments = [];
  if (title) {
    segments.push(title);
  }
  segments.push(...rowTexts);
  return segments.join("\n").trim();
}

function extractRichTextAttachments(rawContent) {
  const content = normalizeMessageContentObject(rawContent);
  const localeBlock = extractRichTextLocaleBlock(content);
  if (localeBlock == null) {
    return [];
  }
  const attachments = [];
  for (const row of localeBlock.content) {
    if (!Array.isArray(row)) {
      continue;
    }
    for (const node of row) {
      if (node == null || typeof node !== "object") {
        continue;
      }
      const tag = String(node.tag ?? "").trim().toLowerCase();
      if (tag === "img" || tag === "image") {
        const imageKey =
          String(node.image_key ?? node.imageKey ?? node.key ?? "").trim() || null;
        if (imageKey) {
          attachments.push({
            kind: "image",
            imageKey,
            name: null,
          });
        }
        continue;
      }
      if (tag === "file" || tag === "media") {
        const fileKey =
          String(node.file_key ?? node.fileKey ?? node.media_key ?? node.mediaKey ?? "").trim() ||
          null;
        const imageKey =
          String(node.image_key ?? node.imageKey ?? "").trim() || null;
        if (fileKey) {
          attachments.push({
            kind: "file",
            fileKey,
            name:
              String(
                node.file_name ??
                  node.fileName ??
                  node.name ??
                  node.title ??
                  "",
              ).trim() || null,
          });
          continue;
        }
        if (imageKey) {
          attachments.push({
            kind: "image",
            imageKey,
            name: null,
          });
        }
      }
    }
  }
  return attachments;
}

function inferExtensionFromMimeType(mimeType) {
  const normalized = String(mimeType ?? "").trim().toLowerCase();
  switch (normalized) {
    case "image/png":
      return ".png";
    case "image/jpeg":
      return ".jpg";
    case "image/webp":
      return ".webp";
    case "image/gif":
      return ".gif";
    case "application/pdf":
      return ".pdf";
    case "application/msword":
      return ".doc";
    case "application/vnd.openxmlformats-officedocument.wordprocessingml.document":
      return ".docx";
    case "application/vnd.ms-excel":
      return ".xls";
    case "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet":
      return ".xlsx";
    case "application/vnd.ms-powerpoint":
      return ".ppt";
    case "application/vnd.openxmlformats-officedocument.presentationml.presentation":
      return ".pptx";
    case "video/mp4":
      return ".mp4";
    case "audio/ogg":
    case "audio/opus":
      return ".opus";
    default:
      return "";
  }
}

function guessMimeTypeFromName(name) {
  const extension = path.extname(String(name ?? "").trim()).toLowerCase();
  switch (extension) {
    case ".png":
      return "image/png";
    case ".jpg":
    case ".jpeg":
      return "image/jpeg";
    case ".webp":
      return "image/webp";
    case ".gif":
      return "image/gif";
    case ".pdf":
      return "application/pdf";
    case ".doc":
      return "application/msword";
    case ".docx":
      return "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
    case ".xls":
      return "application/vnd.ms-excel";
    case ".xlsx":
      return "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
    case ".ppt":
      return "application/vnd.ms-powerpoint";
    case ".pptx":
      return "application/vnd.openxmlformats-officedocument.presentationml.presentation";
    case ".mp4":
      return "video/mp4";
    case ".ogg":
    case ".opus":
      return "audio/opus";
    default:
      return null;
  }
}

function sanitizeFileName(value, fallbackBase = "attachment") {
  const normalized =
    String(value ?? "")
      .replace(/[<>:"/\\|?*\u0000-\u001f]/g, "_")
      .replace(/\s+/g, " ")
      .trim() || fallbackBase;
  return normalized.slice(0, 180);
}

function parseContentDispositionFileName(headerValue) {
  const source = String(headerValue ?? "").trim();
  if (!source) {
    return null;
  }
  const encodedMatch = source.match(/filename\*\s*=\s*UTF-8''([^;]+)/i);
  if (encodedMatch?.[1]) {
    try {
      return decodeURIComponent(encodedMatch[1].trim()).trim() || null;
    } catch {
      return encodedMatch[1].trim() || null;
    }
  }
  const plainMatch = source.match(/filename\s*=\s*\"?([^\";]+)\"?/i);
  return plainMatch?.[1] ? plainMatch[1].trim() || null : null;
}

function inferFeishuFileType({ name = null, mimeType = null } = {}) {
  const normalizedMimeType = String(mimeType ?? "").trim().toLowerCase();
  const extension = path.extname(String(name ?? "").trim()).toLowerCase();
  if (normalizedMimeType === "application/pdf" || extension === ".pdf") {
    return "pdf";
  }
  if (
    normalizedMimeType === "application/msword" ||
    normalizedMimeType ===
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document" ||
    extension === ".doc" ||
    extension === ".docx"
  ) {
    return "doc";
  }
  if (
    normalizedMimeType === "application/vnd.ms-excel" ||
    normalizedMimeType ===
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" ||
    extension === ".xls" ||
    extension === ".xlsx" ||
    extension === ".csv"
  ) {
    return "xls";
  }
  if (
    normalizedMimeType === "application/vnd.ms-powerpoint" ||
    normalizedMimeType ===
      "application/vnd.openxmlformats-officedocument.presentationml.presentation" ||
    extension === ".ppt" ||
    extension === ".pptx"
  ) {
    return "ppt";
  }
  if (normalizedMimeType === "video/mp4" || extension === ".mp4") {
    return "mp4";
  }
  if (
    normalizedMimeType === "audio/opus" ||
    normalizedMimeType === "audio/ogg" ||
    extension === ".opus" ||
    extension === ".ogg"
  ) {
    return "opus";
  }
  return "stream";
}

function normalizeInboundMessageAttachments(messageType, content) {
  const normalizedType = String(messageType ?? "text").trim().toLowerCase();
  const normalizedContent = normalizeMessageContentObject(content);
  if (normalizedType === "post" || normalizedType === "rich_text") {
    return extractRichTextAttachments(normalizedContent);
  }
  if (normalizedType === "image") {
    const imageKey = String(normalizedContent.image_key ?? "").trim() || null;
    if (!imageKey) {
      return [];
    }
    return [
      {
        kind: "image",
        imageKey,
        name: null,
      },
    ];
  }
  if (normalizedType === "file") {
    const fileKey = String(normalizedContent.file_key ?? "").trim() || null;
    if (!fileKey) {
      return [];
    }
    return [
      {
        kind: "file",
        fileKey,
        name:
          String(
            normalizedContent.file_name ??
              normalizedContent.name ??
              normalizedContent.title ??
              "",
          ).trim() || null,
      },
    ];
  }
  return [];
}

function buildInboundAttachmentFallbackText(messageType, attachments) {
  if (!Array.isArray(attachments) || attachments.length === 0) {
    return "";
  }
  return "";
}

function buildOutboundMessageId(event) {
  const turnId = String(event?.message?.turnId ?? "no-turn");
  const role = String(event?.message?.role ?? "unknown");
  const eventType = String(event?.eventType ?? "unknown");
  const bindingId = String(event?.bindingId ?? "unknown-binding");
  const attachments = normalizeMirroredAttachments(event?.message?.attachments);
  const hash = crypto
    .createHash("sha1")
    .update(
      JSON.stringify({
        text: String(event?.message?.text ?? ""),
        attachments: attachments.map((attachment) => attachment.fingerprint),
      }),
      "utf8",
    )
    .digest("hex")
    .slice(0, 16);
  return `${bindingId}:${eventType}:${role}:${turnId}:${hash}`;
}

function buildAssistantCardSessionId({ bindingId, localTurnId, sendIdentity = "bot" } = {}) {
  const seed = [
    String(bindingId ?? "").trim(),
    String(localTurnId ?? "").trim(),
    String(sendIdentity ?? "bot").trim() || "bot",
  ].join(":");
  return `card_${crypto.createHash("sha1").update(seed, "utf8").digest("hex").slice(0, 24)}`;
}

function buildAssistantCardFileProviderMessageId(sessionId) {
  return `assistant_card_file:${String(sessionId ?? "").trim()}`;
}

function buildAssistantCardFallbackTextProviderMessageId(sessionId) {
  return `assistant_card_text:${String(sessionId ?? "").trim()}`;
}

function buildAssistantCardMermaidProviderMessageId(sessionId, hash) {
  return `assistant_card_mermaid:${String(sessionId ?? "").trim()}:${String(hash ?? "").trim()}`;
}

function createEmptyAssistantCardSessionState({
  startedAt = nowIso(),
  localThreadId = null,
  localTurnId = null,
} = {}) {
  return {
    startedAt,
    sourceCompletedAt: null,
    completedAt: null,
    presentationCompletedAt: null,
    finalItemKey: null,
    localThreadId,
    localTurnId,
    items: [],
    sectionStreams: null,
    toolSummary: null,
    presentation: {
      phase: "streaming",
      progressCursorByKey: {},
      renderedProgressKeys: [],
      renderedFinalChars: 0,
      lastPlaybackAt: null,
    },
    artifactPath: null,
    artifactFileName: null,
    fileLedgerProviderMessageId: null,
    mermaidAttachmentProviderMessageIds: [],
    textFallbackProviderMessageId: null,
    degradationEmitted: false,
  };
}

function sanitizeToolSummaryLabels(labels) {
  const values = Array.isArray(labels) ? labels : [];
  const unique = [];
  for (const value of values) {
    const normalized = String(value ?? "")
      .replace(/\u00a0/g, " ")
      .replace(/\s+/g, " ")
      .trim();
    if (!normalized || unique.includes(normalized)) {
      continue;
    }
    unique.push(normalized);
  }
  return unique.slice(0, 20);
}

function normalizeAssistantCardTimestamp(value) {
  const normalized = String(value ?? "").trim();
  if (!normalized) {
    return null;
  }
  const ms = new Date(normalized).getTime();
  if (!Number.isFinite(ms)) {
    return null;
  }
  return normalized;
}

function chooseEarlierAssistantCardTimestamp(...values) {
  const normalized = values
    .map((value) => normalizeAssistantCardTimestamp(value))
    .filter(Boolean);
  if (normalized.length === 0) {
    return null;
  }
  return normalized.reduce((earliest, candidate) =>
    new Date(candidate).getTime() < new Date(earliest).getTime() ? candidate : earliest,
  );
}

function normalizeAssistantCardItemKey(value) {
  const normalized = String(value ?? "").trim();
  return normalized || null;
}

function normalizeAssistantCardPresentationState(presentation) {
  const next =
    presentation != null && typeof presentation === "object"
      ? {
          ...presentation,
        }
      : {};
  const renderedProgressKeys = Array.isArray(next.renderedProgressKeys)
    ? next.renderedProgressKeys
        .map((value) => normalizeAssistantCardItemKey(value))
        .filter(Boolean)
    : [];
  const progressCursorByKey =
    next.progressCursorByKey != null && typeof next.progressCursorByKey === "object"
      ? Object.fromEntries(
          Object.entries(next.progressCursorByKey)
            .map(([key, value]) => [
              normalizeAssistantCardItemKey(key),
              Math.max(0, Number(value) || 0),
            ])
            .filter(([key]) => Boolean(key)),
        )
      : {};
  return {
    phase: String(next.phase ?? "streaming").trim() || "streaming",
    progressCursorByKey,
    renderedProgressKeys: [...new Set(renderedProgressKeys)],
    renderedFinalChars: Math.max(0, Number(next.renderedFinalChars ?? 0) || 0),
    lastPlaybackAt: normalizeAssistantCardTimestamp(next.lastPlaybackAt),
  };
}

function normalizeAssistantCardSectionName(value) {
  const normalized = String(value ?? "").trim().toLowerCase();
  return ["progress", "tool", "final"].includes(normalized) ? normalized : null;
}

function createEmptyAssistantCardSectionStream() {
  return {
    order: [],
    chunksByKey: {},
    completedKeys: [],
  };
}

function normalizeAssistantCardSectionStream(section) {
  const raw = section != null && typeof section === "object" ? section : {};
  const chunksByKey =
    raw.chunksByKey != null && typeof raw.chunksByKey === "object"
      ? Object.fromEntries(
          Object.entries(raw.chunksByKey)
            .map(([key, entry]) => {
              const normalizedKey = normalizeAssistantCardItemKey(key);
              if (!normalizedKey) {
                return null;
              }
              const normalizedEntry =
                entry != null && typeof entry === "object" ? entry : {};
              const text = String(normalizedEntry.text ?? "").trim();
              if (!text) {
                return null;
              }
              return [
                normalizedKey,
                {
                  key: normalizedKey,
                  text,
                  observedAt:
                    normalizeAssistantCardTimestamp(normalizedEntry.observedAt) ??
                    nowIso(),
                  turnStatus: String(normalizedEntry.turnStatus ?? "").trim() || null,
                },
              ];
            })
            .filter(Boolean),
        )
      : {};
  const order = Array.isArray(raw.order)
    ? raw.order.map((key) => normalizeAssistantCardItemKey(key)).filter(Boolean)
    : [];
  for (const key of Object.keys(chunksByKey)) {
    if (!order.includes(key)) {
      order.push(key);
    }
  }
  const completedKeys = Array.isArray(raw.completedKeys)
    ? raw.completedKeys.map((key) => normalizeAssistantCardItemKey(key)).filter(Boolean)
    : [];
  return {
    order: [...new Set(order)],
    chunksByKey,
    completedKeys: [...new Set(completedKeys)],
  };
}

function normalizeAssistantCardSectionStreams(sectionStreams) {
  const raw =
    sectionStreams != null && typeof sectionStreams === "object" ? sectionStreams : {};
  return {
    progress: normalizeAssistantCardSectionStream(raw.progress),
    tool: normalizeAssistantCardSectionStream(raw.tool),
    final: normalizeAssistantCardSectionStream(raw.final),
  };
}

function hasAssistantCardSectionStreamContent(sectionStreams) {
  if (sectionStreams == null || typeof sectionStreams !== "object") {
    return false;
  }
  return ["progress", "tool", "final"].some((section) => {
    const stream = sectionStreams[section];
    return Object.values(stream?.chunksByKey ?? {}).some((entry) =>
      String(entry?.text ?? "").trim(),
    );
  });
}

function buildAssistantCardSectionStreamText(sectionStream) {
  const normalized = normalizeAssistantCardSectionStream(sectionStream);
  return normalized.order
    .map((key) => String(normalized.chunksByKey[key]?.text ?? "").trim())
    .filter(Boolean)
    .join("\n\n");
}

function upsertAssistantCardSectionStreamChunk(sectionStreams, section, chunk) {
  const normalizedSection = normalizeAssistantCardSectionName(section);
  if (!normalizedSection) {
    return normalizeAssistantCardSectionStreams(sectionStreams);
  }
  const next = normalizeAssistantCardSectionStreams(sectionStreams);
  const stream = next[normalizedSection] ?? createEmptyAssistantCardSectionStream();
  const key =
    normalizeAssistantCardItemKey(chunk?.key) ??
    `${normalizedSection}:${stream.order.length + 1}`;
  const text = String(chunk?.text ?? "").trim();
  if (text) {
    const previousChunk = stream.chunksByKey[key];
    const previousText = String(previousChunk?.text ?? "").trim();
    const nextText =
      previousText && !text.startsWith(previousText)
        ? `${previousText}\n\n${text}`
        : text;
    const turnStatus = String(chunk?.turnStatus ?? "").trim() || null;
    if (
      !previousChunk ||
      previousText !== nextText ||
      String(previousChunk?.turnStatus ?? "") !== String(turnStatus ?? "")
    ) {
      stream.chunksByKey[key] = {
        key,
        text: nextText,
        observedAt: normalizeAssistantCardTimestamp(chunk?.observedAt) ?? nowIso(),
        turnStatus,
      };
    }
    if (!stream.order.includes(key)) {
      stream.order.push(key);
    }
  }
  if (String(chunk?.turnStatus ?? "").trim().toLowerCase() === "completed") {
    stream.completedKeys = [...new Set([...(stream.completedKeys ?? []), key])];
  }
  next[normalizedSection] = stream;
  return next;
}

function mergeAssistantCardSectionStreams(left, right) {
  const leftStreams = normalizeAssistantCardSectionStreams(left);
  const rightStreams = normalizeAssistantCardSectionStreams(right);
  return Object.fromEntries(
    ["progress", "tool", "final"].map((section) => {
      const merged = createEmptyAssistantCardSectionStream();
      for (const stream of [leftStreams[section], rightStreams[section]]) {
        for (const key of stream?.order ?? []) {
          if (!merged.order.includes(key)) merged.order.push(key);
        }
        Object.assign(merged.chunksByKey, stream?.chunksByKey ?? {});
        merged.completedKeys = [
          ...new Set([...(merged.completedKeys ?? []), ...(stream?.completedKeys ?? [])]),
        ];
      }
      return [section, merged];
    }),
  );
}

let assistantCardGraphemeSegmenter = null;

function segmentAssistantPlaybackText(text) {
  const normalizedText = String(text ?? "");
  if (!normalizedText) {
    return [];
  }
  if (typeof Intl !== "undefined" && Intl?.Segmenter instanceof Function) {
    try {
      assistantCardGraphemeSegmenter =
        assistantCardGraphemeSegmenter ??
        new Intl.Segmenter("zh-Hans", {
          granularity: "grapheme",
        });
      return Array.from(assistantCardGraphemeSegmenter.segment(normalizedText), (entry) =>
        String(entry?.segment ?? ""),
      ).filter((segment) => segment.length > 0);
    } catch {
      // Fall through to Array.from when Intl.Segmenter is unavailable or fails.
    }
  }
  return Array.from(normalizedText);
}

function countAssistantCardTextChars(text) {
  return segmentAssistantPlaybackText(text).length;
}

function sliceAssistantCardTextChars(text, charCount) {
  const normalizedText = String(text ?? "");
  const limit = Math.max(0, Number(charCount) || 0);
  if (!normalizedText || limit <= 0) {
    return "";
  }
  return segmentAssistantPlaybackText(normalizedText).slice(0, limit).join("");
}

function getAssistantCardPlaybackSegmentsPerTick({
  remainingSegments,
  sourceCompleted = false,
  streamKind = "progress",
} = {}) {
  const remaining = Math.max(0, Number(remainingSegments) || 0);
  if (remaining <= 0) {
    return 0;
  }
  if (!sourceCompleted) {
    return Math.min(
      remaining,
      Math.max(
        ASSISTANT_CARD_LIVE_MIN_SEGMENTS_PER_TICK,
        ASSISTANT_CARD_LIVE_MAX_SEGMENTS_PER_TICK,
      ),
    );
  }
  const maxSegments =
    streamKind === "final"
      ? ASSISTANT_CARD_CATCH_UP_FINAL_MAX_SEGMENTS_PER_TICK
      : ASSISTANT_CARD_CATCH_UP_PROGRESS_MAX_SEGMENTS_PER_TICK;
  return Math.min(
    remaining,
    Math.max(ASSISTANT_CARD_CATCH_UP_MIN_SEGMENTS_PER_TICK, maxSegments),
  );
}

function normalizeAssistantCardStateShape(state, defaults = {}) {
  const rawState = state != null && typeof state === "object" ? state : {};
  const deferCompletedPresentation = defaults.deferCompletedPresentation === true;
  const next = {
    ...createEmptyAssistantCardSessionState(defaults),
    ...rawState,
  };
  next.localThreadId =
    String(next.localThreadId ?? defaults.localThreadId ?? "").trim() || null;
  next.localTurnId = String(next.localTurnId ?? defaults.localTurnId ?? "").trim() || null;
  next.startedAt =
    chooseEarlierAssistantCardTimestamp(next.startedAt, defaults.startedAt) ??
    defaults.startedAt ??
    nowIso();
  next.sourceCompletedAt = normalizeAssistantCardTimestamp(
    next.sourceCompletedAt ?? next.completedAt,
  );
  next.completedAt = next.sourceCompletedAt;
  next.presentationCompletedAt = normalizeAssistantCardTimestamp(next.presentationCompletedAt);
  next.finalItemKey = normalizeAssistantCardItemKey(next.finalItemKey);
  next.presentation = normalizeAssistantCardPresentationState(next.presentation);
  next.sectionStreams =
    next.sectionStreams == null && rawState.sectionMode !== "typed"
      ? null
      : normalizeAssistantCardSectionStreams(next.sectionStreams);
  next.sectionMode =
    next.sectionStreams != null || rawState.sectionMode === "typed" ? "typed" : null;
  next.items = Array.isArray(next.items) ? next.items : [];
  if (next.items.length > 0) {
    if (!next.finalItemKey && next.sourceCompletedAt) {
      next.finalItemKey = normalizeAssistantCardItemKey(
        next.items[next.items.length - 1]?.key,
      );
    }
    const hasExplicitPresentation = rawState.presentation != null;
    const hasExplicitPresentationCompletedAt =
      normalizeAssistantCardTimestamp(rawState.presentationCompletedAt) != null;
    const progressCharMap = buildAssistantCardProgressCharMap(next.items, next);
    if (
      Object.keys(next.presentation.progressCursorByKey).length === 0 &&
      next.presentation.renderedProgressKeys.length > 0
    ) {
      next.presentation.progressCursorByKey = Object.fromEntries(
        next.presentation.renderedProgressKeys
          .filter((key) => Object.prototype.hasOwnProperty.call(progressCharMap, key))
          .map((key) => [key, progressCharMap[key]]),
      );
    }
    if (next.presentationCompletedAt && next.sourceCompletedAt) {
      next.presentation.progressCursorByKey = { ...progressCharMap };
      next.presentation.renderedProgressKeys = listRenderedAssistantCardProgressKeys(
        progressCharMap,
        next.presentation.progressCursorByKey,
      );
      next.presentation.renderedFinalChars = countAssistantCardTextChars(
        getAssistantCardFinalItem(next.items, next)?.text,
      );
      next.presentation.phase = "completed";
    }
    if (
      !hasExplicitPresentation &&
      !hasExplicitPresentationCompletedAt &&
      Object.keys(next.presentation.progressCursorByKey).length === 0
    ) {
      next.presentation.progressCursorByKey = { ...progressCharMap };
      next.presentation.renderedProgressKeys = listRenderedAssistantCardProgressKeys(
        progressCharMap,
        next.presentation.progressCursorByKey,
      );
      if (next.sourceCompletedAt && !deferCompletedPresentation) {
        next.presentation.renderedFinalChars = countAssistantCardTextChars(
          getAssistantCardFinalItem(next.items, next)?.text,
        );
        next.presentationCompletedAt = next.presentationCompletedAt ?? next.sourceCompletedAt;
        next.presentation.phase = "completed";
      }
    }
  }
  return next;
}

function getAssistantCardSourceCompletedAt(state) {
  return normalizeAssistantCardTimestamp(state?.sourceCompletedAt ?? state?.completedAt);
}

function normalizeAssistantCardTelemetryNumber(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) {
    return null;
  }
  return Math.max(0, Math.round(number));
}

function normalizeAssistantCardTelemetryText(value) {
  const normalized = String(value ?? "").trim();
  return normalized || null;
}

function diffAssistantCardTelemetryMs(start, end) {
  const normalizedStart = normalizeAssistantCardTimestamp(start);
  const normalizedEnd = normalizeAssistantCardTimestamp(end);
  if (!normalizedStart || !normalizedEnd) {
    return null;
  }
  const startMs = new Date(normalizedStart).getTime();
  const endMs = new Date(normalizedEnd).getTime();
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs < startMs) {
    return null;
  }
  return Math.max(0, Math.round(endMs - startMs));
}

function normalizeAssistantCardOutboundTelemetry(value) {
  const raw = value != null && typeof value === "object" ? value : {};
  const next = {};
  for (const field of ASSISTANT_CARD_OUTBOUND_TELEMETRY_TIMESTAMP_FIELDS) {
    const normalized = normalizeAssistantCardTimestamp(raw[field]);
    if (normalized) {
      next[field] = normalized;
    }
  }
  for (const field of ASSISTANT_CARD_OUTBOUND_TELEMETRY_NUMBER_FIELDS) {
    const normalized = normalizeAssistantCardTelemetryNumber(raw[field]);
    if (normalized != null) {
      next[field] = normalized;
    }
  }
  for (const field of ASSISTANT_CARD_OUTBOUND_TELEMETRY_STRING_FIELDS) {
    const normalized = normalizeAssistantCardTelemetryText(raw[field]);
    if (normalized) {
      next[field] = normalized;
    }
  }
  return next;
}

function setAssistantCardTelemetryMetric(target, field, value) {
  delete target[field];
  if (value != null) {
    target[field] = value;
  }
}

function normalizeMessageLedgerDeliveryTelemetry(value) {
  const raw = value != null && typeof value === "object" ? value : {};
  const next = {};
  for (const field of MESSAGE_LEDGER_DELIVERY_TELEMETRY_TIMESTAMP_FIELDS) {
    const normalized = normalizeAssistantCardTimestamp(raw[field]);
    if (normalized) {
      next[field] = normalized;
    }
  }
  for (const field of MESSAGE_LEDGER_DELIVERY_TELEMETRY_NUMBER_FIELDS) {
    const normalized = normalizeAssistantCardTelemetryNumber(raw[field]);
    if (normalized != null) {
      next[field] = normalized;
    }
  }
  for (const field of MESSAGE_LEDGER_DELIVERY_TELEMETRY_STRING_FIELDS) {
    const normalized = normalizeAssistantCardTelemetryText(raw[field]);
    if (normalized) {
      next[field] = normalized;
    }
  }
  return next;
}

function mergeMessageLedgerDeliveryTelemetry(currentValue, patch = {}) {
  const current = normalizeMessageLedgerDeliveryTelemetry(currentValue);
  const incoming = normalizeMessageLedgerDeliveryTelemetry(patch);
  const next = {
    ...current,
    ...incoming,
  };
  setAssistantCardTelemetryMetric(
    next,
    "detectedToLedgerMs",
    diffAssistantCardTelemetryMs(next.desktopDetectedAt, next.ledgerCreatedAt),
  );
  setAssistantCardTelemetryMetric(
    next,
    "ledgerToDeliveryStartMs",
    diffAssistantCardTelemetryMs(next.ledgerCreatedAt, next.deliveryStartedAt),
  );
  setAssistantCardTelemetryMetric(
    next,
    "deliveryMs",
    diffAssistantCardTelemetryMs(next.deliveryStartedAt, next.deliveryCompletedAt),
  );
  setAssistantCardTelemetryMetric(
    next,
    "detectedToDeliveryCompletedMs",
    diffAssistantCardTelemetryMs(next.desktopDetectedAt, next.deliveryCompletedAt),
  );
  return next;
}

function mergeAssistantCardOutboundTelemetry(state, patch = {}) {
  const baseState = state != null && typeof state === "object" ? state : {};
  const current = normalizeAssistantCardOutboundTelemetry(baseState.outboundTelemetry);
  const incoming = normalizeAssistantCardOutboundTelemetry(patch);
  const next = {
    ...current,
    ...incoming,
  };
  for (const field of ASSISTANT_CARD_OUTBOUND_TELEMETRY_FIRST_TIMESTAMP_FIELDS) {
    if (incoming[field] || current[field]) {
      next[field] =
        chooseEarlierAssistantCardTimestamp(current[field], incoming[field]) ??
        incoming[field] ??
        current[field];
    }
  }
  if (incoming.firstEventAt || incoming.lastEventAt) {
    next.firstEventAt =
      chooseEarlierAssistantCardTimestamp(
        current.firstEventAt,
        incoming.firstEventAt,
        incoming.lastEventAt,
      ) ??
      incoming.firstEventAt ??
      incoming.lastEventAt;
  } else if (!next.firstEventAt && next.lastEventAt) {
    next.firstEventAt = next.lastEventAt;
  }
  const presentationCompletedAt = normalizeAssistantCardTimestamp(
    baseState.presentationCompletedAt,
  );
  if (presentationCompletedAt) {
    next.lastPresentationCompletedAt = presentationCompletedAt;
  }

  const lastEventAt = next.lastEventAt ?? next.firstEventAt;
  setAssistantCardTelemetryMetric(
    next,
    "lastEventToDispatchMs",
    diffAssistantCardTelemetryMs(lastEventAt, next.lastDispatchRequestedAt),
  );
  setAssistantCardTelemetryMetric(
    next,
    "firstEventToFirstCardSyncStartMs",
    diffAssistantCardTelemetryMs(next.firstEventAt, next.firstCardSyncStartedAt),
  );
  setAssistantCardTelemetryMetric(
    next,
    "firstCardQueueToSyncStartMs",
    diffAssistantCardTelemetryMs(next.firstCardSyncQueuedAt, next.firstCardSyncStartedAt),
  );
  setAssistantCardTelemetryMetric(
    next,
    "firstCardSyncMs",
    diffAssistantCardTelemetryMs(next.firstCardSyncStartedAt, next.firstCardSyncCompletedAt),
  );
  setAssistantCardTelemetryMetric(
    next,
    "firstCardQueueToCompleteMs",
    diffAssistantCardTelemetryMs(next.firstCardSyncQueuedAt, next.firstCardSyncCompletedAt),
  );
  setAssistantCardTelemetryMetric(
    next,
    "cardkitEnsureMs",
    diffAssistantCardTelemetryMs(next.cardkitEnsureStartedAt, next.cardkitEnsureFinishedAt),
  );
  setAssistantCardTelemetryMetric(
    next,
    "cardkitCreateMs",
    diffAssistantCardTelemetryMs(next.cardkitCreateStartedAt, next.cardkitCreateFinishedAt),
  );
  setAssistantCardTelemetryMetric(
    next,
    "cardkitSettingsMs",
    diffAssistantCardTelemetryMs(next.cardkitSettingsStartedAt, next.cardkitSettingsFinishedAt),
  );
  setAssistantCardTelemetryMetric(
    next,
    "cardkitMessageSendMs",
    diffAssistantCardTelemetryMs(
      next.cardkitMessageSendStartedAt,
      next.cardkitMessageSendFinishedAt,
    ),
  );
  setAssistantCardTelemetryMetric(
    next,
    "cardkitFinalUpdateMs",
    diffAssistantCardTelemetryMs(
      next.cardkitFinalUpdateStartedAt,
      next.cardkitFinalUpdateFinishedAt,
    ),
  );
  setAssistantCardTelemetryMetric(
    next,
    "lastDispatchToSyncStartMs",
    diffAssistantCardTelemetryMs(next.lastDispatchRequestedAt, next.lastSyncStartedAt),
  );
  setAssistantCardTelemetryMetric(
    next,
    "lastCardUpdateMs",
    diffAssistantCardTelemetryMs(next.lastCardUpdateStartedAt, next.lastCardUpdateFinishedAt),
  );
  setAssistantCardTelemetryMetric(
    next,
    "lastSyncMs",
    diffAssistantCardTelemetryMs(next.lastSyncStartedAt, next.lastSyncFinishedAt),
  );
  setAssistantCardTelemetryMetric(
    next,
    "lastEventToSyncFinishedMs",
    diffAssistantCardTelemetryMs(lastEventAt, next.lastSyncFinishedAt),
  );
  setAssistantCardTelemetryMetric(
    next,
    "sourceToPresentationCompleteMs",
    diffAssistantCardTelemetryMs(
      getAssistantCardSourceCompletedAt(baseState),
      next.lastPresentationCompletedAt,
    ),
  );
  setAssistantCardTelemetryMetric(
    next,
    "finalCloseMs",
    diffAssistantCardTelemetryMs(next.finalCloseStartedAt, next.finalCloseCompletedAt),
  );

  return {
    ...baseState,
    outboundTelemetry: next,
  };
}

function getAssistantCardFinalItem(items, state) {
  const normalizedItems = Array.isArray(items) ? items : [];
  if (normalizedItems.length === 0) {
    return null;
  }
  const finalItemKey = normalizeAssistantCardItemKey(state?.finalItemKey);
  if (finalItemKey) {
    return normalizedItems.find((item) => normalizeAssistantCardItemKey(item?.key) === finalItemKey) ?? null;
  }
  return normalizedItems[normalizedItems.length - 1] ?? null;
}

function stripAssistantCardInternalFinalText(text) {
  return String(text ?? "")
    .replace(/(^|\n)<oai-mem-citation>[\s\S]*?(?:<\/oai-mem-citation>|$)/g, "$1")
    .trim();
}

function normalizeAssistantCardFinalComparableText(text) {
  return stripAssistantCardInternalFinalText(text)
    .replace(/\s+/g, " ")
    .trim();
}

function areAssistantCardFinalTextsEquivalent(left, right) {
  const normalizedLeft = normalizeAssistantCardFinalComparableText(left);
  const normalizedRight = normalizeAssistantCardFinalComparableText(right);
  if (!normalizedLeft || !normalizedRight) {
    return false;
  }
  if (normalizedLeft === normalizedRight) {
    return true;
  }
  const shorter =
    normalizedLeft.length <= normalizedRight.length ? normalizedLeft : normalizedRight;
  const longer =
    normalizedLeft.length > normalizedRight.length ? normalizedLeft : normalizedRight;
  if (shorter.length < 120) {
    return false;
  }
  return longer.includes(shorter) && shorter.length / longer.length >= 0.8;
}

function isAssistantCardProgressItemFinalPrefix(item, finalItem) {
  const itemText = normalizeAssistantCardFinalComparableText(item?.text);
  const finalText = normalizeAssistantCardFinalComparableText(finalItem?.text);
  if (!itemText || !finalText) {
    return false;
  }
  if (
    normalizeAssistantCardItemKey(item?.key) === normalizeAssistantCardItemKey(finalItem?.key)
  ) {
    return false;
  }
  if (sanitizeToolSummaryLabels(item?.toolSummaryLabels).length > 0) {
    return false;
  }
  const source = String(item?.source ?? "").trim().toLowerCase();
  if (source === "thread_rollout_task_complete") {
    return false;
  }
  return itemText === finalText || finalText.startsWith(itemText);
}

function listAssistantCardProgressItems(items, state) {
  const normalizedItems = Array.isArray(items) ? items : [];
  const sourceCompletedAt = getAssistantCardSourceCompletedAt(state);
  if (!sourceCompletedAt) {
    return normalizedItems;
  }
  const finalItem = getAssistantCardFinalItem(normalizedItems, state);
  const finalKey = normalizeAssistantCardItemKey(finalItem?.key);
  if (!finalKey) {
    return normalizedItems;
  }
  return normalizedItems.filter(
    (item) =>
      normalizeAssistantCardItemKey(item?.key) !== finalKey &&
      !isAssistantCardProgressItemFinalPrefix(item, finalItem),
  );
}

function buildAssistantCardProgressCharMap(items, state) {
  const map = {};
  for (const item of listAssistantCardProgressItems(items, state)) {
    const key = normalizeAssistantCardItemKey(item?.key);
    if (!key) {
      continue;
    }
    map[key] = countAssistantCardTextChars(String(item?.text ?? "").trim());
  }
  return map;
}

function listRenderedAssistantCardProgressKeys(progressCharMap, progressCursorByKey) {
  const rendered = [];
  for (const [key, charCount] of Object.entries(progressCharMap)) {
    if ((progressCursorByKey?.[key] ?? 0) >= charCount) {
      rendered.push(key);
    }
  }
  return rendered;
}

function clampAssistantCardPresentationState(state) {
  const next = normalizeAssistantCardStateShape(state);
  const progressCharMap = buildAssistantCardProgressCharMap(next.items, next);
  next.presentation.progressCursorByKey = Object.fromEntries(
    Object.entries(progressCharMap).map(([key, charCount]) => [
      key,
      Math.min(
        Math.max(0, Number(next.presentation.progressCursorByKey?.[key] ?? 0) || 0),
        charCount,
      ),
    ]),
  );
  next.presentation.renderedProgressKeys = listRenderedAssistantCardProgressKeys(
    progressCharMap,
    next.presentation.progressCursorByKey,
  );
  const sourceCompletedAt = getAssistantCardSourceCompletedAt(next);
  if (!sourceCompletedAt) {
    next.presentationCompletedAt = null;
    next.presentation.phase = "streaming";
    next.presentation.renderedFinalChars = 0;
    return next;
  }
  const finalItem = getAssistantCardFinalItem(next.items, next);
  const finalText = String(finalItem?.text ?? "").trim();
  const finalTextChars = countAssistantCardTextChars(finalText);
  next.presentation.renderedFinalChars = Math.min(
    next.presentation.renderedFinalChars,
    finalTextChars,
  );
  if (Object.keys(progressCharMap).length === 0 && finalTextChars === 0) {
    next.presentationCompletedAt = next.presentationCompletedAt ?? sourceCompletedAt;
    next.presentation.phase = "completed";
    return next;
  }
  const progressCompleted = Object.entries(progressCharMap).every(
    ([key, charCount]) => (next.presentation.progressCursorByKey?.[key] ?? 0) >= charCount,
  );
  const finalCompleted = next.presentation.renderedFinalChars >= finalTextChars;
  if (progressCompleted && finalCompleted) {
    next.presentationCompletedAt = next.presentationCompletedAt ?? nowIso();
    next.presentation.phase = "completed";
    return next;
  }
  next.presentationCompletedAt = null;
  next.presentation.phase = "catch_up";
  return next;
}

function revealNextAssistantCardProgressItem(state, observedAt = nowIso()) {
  const next = clampAssistantCardPresentationState(state);
  if (next.presentationCompletedAt) {
    return {
      state: next,
      advanced: false,
    };
  }
  const pendingItem = listAssistantCardProgressItems(next.items, next).find((item) => {
    const key = normalizeAssistantCardItemKey(item?.key);
    if (!key) {
      return false;
    }
    const renderedChars = Math.max(
      0,
      Number(next.presentation.progressCursorByKey?.[key] ?? 0) || 0,
    );
    return renderedChars < countAssistantCardTextChars(String(item?.text ?? "").trim());
  });
  if (pendingItem) {
    const pendingKey = normalizeAssistantCardItemKey(pendingItem?.key);
    const pendingText = String(pendingItem?.text ?? "").trim();
    const pendingTextChars = countAssistantCardTextChars(pendingText);
    const renderedChars = Math.max(
      0,
      Number(next.presentation.progressCursorByKey?.[pendingKey] ?? 0) || 0,
    );
    const remainingChars = pendingTextChars - renderedChars;
    const charsPerTick = getAssistantCardPlaybackSegmentsPerTick({
      remainingSegments: remainingChars,
      sourceCompleted: Boolean(getAssistantCardSourceCompletedAt(next)),
      streamKind: "progress",
    });
    const advancedState = clampAssistantCardPresentationState({
      ...next,
      presentation: {
        ...next.presentation,
        progressCursorByKey: {
          ...next.presentation.progressCursorByKey,
          [pendingKey]: Math.min(
            pendingTextChars,
            renderedChars + charsPerTick,
          ),
        },
        lastPlaybackAt: normalizeAssistantCardTimestamp(observedAt) ?? nowIso(),
      },
    });
    return {
      state: advancedState,
      advanced: true,
      revealedKey: pendingKey,
    };
  }
  const finalItem = getAssistantCardFinalItem(next.items, next);
  const finalText = String(finalItem?.text ?? "").trim();
  const finalTextChars = countAssistantCardTextChars(finalText);
  if (
    finalTextChars > 0 &&
    next.presentation.renderedFinalChars < finalTextChars
  ) {
    const remainingFinalChars = finalTextChars - next.presentation.renderedFinalChars;
    const charsPerTick = getAssistantCardPlaybackSegmentsPerTick({
      remainingSegments: remainingFinalChars,
      sourceCompleted: true,
      streamKind: "final",
    });
    return {
      state: clampAssistantCardPresentationState({
        ...next,
        presentation: {
          ...next.presentation,
          renderedFinalChars: Math.min(
            finalTextChars,
            next.presentation.renderedFinalChars + charsPerTick,
          ),
          lastPlaybackAt: normalizeAssistantCardTimestamp(observedAt) ?? nowIso(),
        },
      }),
      advanced: true,
      revealedKey: normalizeAssistantCardItemKey(finalItem?.key),
    };
  }
  return {
    state: clampAssistantCardPresentationState({
      ...next,
      presentation: {
        ...next.presentation,
        lastPlaybackAt: normalizeAssistantCardTimestamp(observedAt) ?? nowIso(),
      },
    }),
    advanced: false,
  };
}

function shouldPrimeAssistantCardProgress(state) {
  const normalized = clampAssistantCardPresentationState(state);
  return (
    listAssistantCardProgressItems(normalized.items, normalized).length > 0 &&
    !listAssistantCardProgressItems(normalized.items, normalized).some((item) => {
      const key = normalizeAssistantCardItemKey(item?.key);
      return (
        key != null &&
        Math.max(0, Number(normalized.presentation.progressCursorByKey?.[key] ?? 0) || 0) > 0
      );
    })
  );
}

function hasPendingAssistantCardPlayback(state) {
  const normalized = clampAssistantCardPresentationState(state);
  if (normalized.presentationCompletedAt) {
    return false;
  }
  const pendingProgress = listAssistantCardProgressItems(normalized.items, normalized).some(
    (item) => {
      const key = normalizeAssistantCardItemKey(item?.key);
      if (!key) {
        return false;
      }
      return (
        Math.max(0, Number(normalized.presentation.progressCursorByKey?.[key] ?? 0) || 0) <
        countAssistantCardTextChars(String(item?.text ?? "").trim())
      );
    },
  );
  if (pendingProgress) {
    return true;
  }
  const finalItem = getAssistantCardFinalItem(normalized.items, normalized);
  const finalTextChars = countAssistantCardTextChars(String(finalItem?.text ?? "").trim());
  return finalTextChars > normalized.presentation.renderedFinalChars;
}

function shouldFastCompleteAssistantCardFinalOnlyPresentation(state) {
  const normalized = clampAssistantCardPresentationState(state);
  if (normalized.presentationCompletedAt || !getAssistantCardSourceCompletedAt(normalized)) {
    return false;
  }
  if (listAssistantCardProgressItems(normalized.items, normalized).length > 0) {
    return false;
  }
  if (buildAssistantCardToolSummaryText(normalized.items, normalized.toolSummary)) {
    return false;
  }
  if (
    normalized.items.some(
      (item) => sanitizeToolSummaryLabels(item?.toolSummaryLabels).length > 0,
    )
  ) {
    return false;
  }
  const finalItem = getAssistantCardFinalItem(normalized.items, normalized);
  const finalTextChars = countAssistantCardTextChars(String(finalItem?.text ?? "").trim());
  return (
    finalTextChars > 0 &&
    finalTextChars <= ASSISTANT_CARD_FAST_FINAL_ONLY_MAX_CHARS
  );
}

function fastCompleteAssistantCardFinalOnlyPresentation(state, observedAt = nowIso()) {
  const normalized = clampAssistantCardPresentationState(state);
  if (!shouldFastCompleteAssistantCardFinalOnlyPresentation(normalized)) {
    return normalized;
  }
  const progressCharMap = buildAssistantCardProgressCharMap(normalized.items, normalized);
  const finalItem = getAssistantCardFinalItem(normalized.items, normalized);
  const completedAt =
    normalizeAssistantCardTimestamp(observedAt) ??
    getAssistantCardSourceCompletedAt(normalized) ??
    nowIso();
  return clampAssistantCardPresentationState({
    ...normalized,
    presentationCompletedAt: completedAt,
    presentation: {
      ...normalized.presentation,
      phase: "completed",
      progressCursorByKey: { ...progressCharMap },
      renderedProgressKeys: listRenderedAssistantCardProgressKeys(
        progressCharMap,
        progressCharMap,
      ),
      renderedFinalChars: countAssistantCardTextChars(String(finalItem?.text ?? "").trim()),
      lastPlaybackAt: completedAt,
    },
  });
}

function areAssistantCardItemsCompleted(items) {
  return (
    Array.isArray(items) &&
    items.length > 0 &&
    items.every((item) => String(item?.turnStatus ?? "").trim().toLowerCase() === "completed")
  );
}

function maybeApplyRolloutCardTimingToState(state, toolSummary, options = {}) {
  if (state == null || typeof state !== "object") {
    return state;
  }
  if (toolSummary == null || typeof toolSummary !== "object") {
    return state;
  }
  const nextState = normalizeAssistantCardStateShape(state);
  const allowCompletedAt = options.allowCompletedAt !== false;
  const summaryStartedAt = normalizeAssistantCardTimestamp(toolSummary.startedAt);
  const summaryCompletedAt = normalizeAssistantCardTimestamp(toolSummary.completedAt);
  if (!summaryStartedAt && !summaryCompletedAt) {
    return nextState;
  }
  if (summaryStartedAt) {
    nextState.startedAt =
      chooseEarlierAssistantCardTimestamp(nextState.startedAt, summaryStartedAt) ??
      nextState.startedAt ??
      summaryStartedAt;
  }
  if (
    allowCompletedAt &&
    summaryCompletedAt &&
    !getAssistantCardSourceCompletedAt(nextState)
  ) {
    nextState.sourceCompletedAt = summaryCompletedAt;
    nextState.completedAt = summaryCompletedAt;
  }
  const finalText = String(toolSummary?.finalText ?? "").trim();
  if (summaryCompletedAt && finalText) {
    let completedItems = (Array.isArray(nextState.items) ? nextState.items : [])
      .filter((item) => String(item?.text ?? "").trim())
      .map((item) => ({
        ...item,
        turnStatus: "completed",
      }));
    let finalItemIndex = completedItems.findIndex(
      (item) => String(item?.text ?? "").trim() === finalText,
    );
    if (finalItemIndex < 0) {
      finalItemIndex = completedItems.findIndex((item) =>
        areAssistantCardFinalTextsEquivalent(item?.text, finalText),
      );
    }
    let finalItem = finalItemIndex >= 0 ? completedItems[finalItemIndex] : null;
    if (finalItem != null) {
      finalItem = {
        ...finalItem,
        text: finalText,
        turnStatus: "completed",
        source: finalItem.source ?? "thread_rollout_task_complete",
      };
      completedItems = completedItems.map((item, index) =>
        index === finalItemIndex ? finalItem : item,
      );
    } else {
      const finalKey = normalizeAssistantCardItemKey(
        `rollout-final:${nextState.localTurnId ?? summaryCompletedAt}`,
      );
      finalItem = {
        key: finalKey,
        itemIndex: null,
        turnIndex: Number.MAX_SAFE_INTEGER,
        text: finalText,
        turnStatus: "completed",
        observedAt: summaryCompletedAt,
        source: "thread_rollout_task_complete",
      };
      completedItems.push(finalItem);
    }
    nextState.items = completedItems;
    nextState.sourceCompletedAt = summaryCompletedAt;
    nextState.completedAt = summaryCompletedAt;
    nextState.finalItemKey = normalizeAssistantCardItemKey(finalItem?.key);
  }
  return clampAssistantCardPresentationState(nextState);
}

function humanizeToolSummaryClause(label) {
  const raw = String(label ?? "")
    .replace(/\u00a0/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!raw) {
    return "";
  }
  let match = raw.match(/^edited\s+(\d+)\s+files?$/i);
  if (match) {
    return `编辑了 ${match[1]} 个文件`;
  }
  match = raw.match(/^ran\s+(\d+)\s+commands?$/i);
  if (match) {
    return `运行了 ${match[1]} 条命令`;
  }
  match = raw.match(/^read\s+(\d+)\s+files?$/i);
  if (match) {
    return `查看了 ${match[1]} 个文件`;
  }
  match = raw.match(/^viewed\s+(\d+)\s+files?$/i);
  if (match) {
    return `查看了 ${match[1]} 个文件`;
  }
  match = raw.match(/^opened\s+(\d+)\s+files?$/i);
  if (match) {
    return `打开了 ${match[1]} 个文件`;
  }
  match = raw.match(/^searched(?:\s+the)?\s+web(?:\s+(\d+)\s+times?)?$/i);
  if (match) {
    return match[1] ? `搜索了网页 ${match[1]} 次` : "搜索了网页";
  }
  match = raw.match(/^used\s+(.+?)\s+skills?$/i);
  if (match) {
    return `使用了 ${match[1].trim()} 技能`;
  }
  match = raw.match(/^called\s+(.+?)\s+tools?$/i);
  if (match) {
    return `调用了 ${match[1].trim()} 工具`;
  }
  match = raw.match(/^applied\s+(\d+)\s+patch(?:es)?$/i);
  if (match) {
    return `应用了 ${match[1]} 个补丁`;
  }
  if (/[\u4e00-\u9fff]/.test(raw)) {
    return raw;
  }
  return raw;
}

function shouldDisplayDetailedToolSummaryClause(clause) {
  const normalized = String(clause ?? "")
    .replace(/\u00a0/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!normalized) {
    return false;
  }
  if (/^步骤\s*\d+\s*[：:]/.test(normalized)) {
    return true;
  }
  return [
    "搜索了关键词：",
    "搜索关键词：",
    "打开了网页：",
    "打开网页：",
    "使用了技能：",
    "使用技能：",
    "调用了插件：",
    "调用插件：",
    "调用了工具：",
    "调用工具：",
    "搜索了图片：",
    "搜索图片：",
    "查看了图片：",
    "查看图片：",
  ].some((prefix) => normalized.startsWith(prefix));
}

function isToolSummaryStepClause(clause) {
  const normalized = String(clause ?? "")
    .replace(/\u00a0/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!normalized) {
    return false;
  }
  return /^步骤\s*\d+\s*[：:]/.test(normalized) || /^姝ラ\s*\d+\s*[锛?]/.test(normalized);
}

function humanizeToolSummaryLabels(labels) {
  const steps = [];
  for (const label of sanitizeToolSummaryLabels(labels)) {
    const clauses = String(label)
      .split(/\s*,\s*/)
      .map((value) => humanizeToolSummaryClause(value))
      .filter((value) => shouldDisplayDetailedToolSummaryClause(value));
    for (const clause of clauses) {
      if (!steps.includes(clause)) {
        steps.push(clause);
      }
    }
  }
  const flowSteps = steps.filter((clause) => isToolSummaryStepClause(clause));
  return flowSteps.length > 0 ? flowSteps : steps;
}

function buildToolSummaryFlowLines(toolSummary) {
  const rawSteps = Array.isArray(toolSummary?.toolFlowSteps) ? toolSummary.toolFlowSteps : [];
  const lines = [];
  for (const [index, rawStep] of rawSteps.entries()) {
    const clause = humanizeToolSummaryClause(rawStep);
    if (!clause || !shouldDisplayDetailedToolSummaryClause(clause)) {
      continue;
    }
    lines.push(
      isToolSummaryStepClause(clause)
        ? clause
        : `步骤 ${index + 1}：${clause}`,
    );
  }
  return lines;
}

function formatLegacyToolSummary(toolSummary) {
  if (toolSummary == null || typeof toolSummary !== "object") {
    return "";
  }
  const hiddenKeys = new Set([
    "threadStatus",
    "turnCount",
    "visibleMessageCount",
    "toolCount",
    "totalDurationMs",
    "commandCount",
    "readFileCount",
    "editedFileCount",
    "patchApplyCount",
    "searchQueries",
    "openedWebsites",
    "skillNames",
    "toolNames",
    "pluginNames",
    "toolFlowSteps",
    "dataSource",
    "startedAt",
    "completedAt",
    "finalText",
    "finalTextSource",
  ]);
  const keyLabels = {
    threadStatus: "线程状态",
    turnCount: "当前对话轮数",
    visibleMessageCount: "当前可见消息数",
    toolCount: "工具调用数",
    totalDurationMs: "工具耗时",
    commandCount: "运行命令数",
    readFileCount: "查看文件数",
    editedFileCount: "编辑文件数",
    patchApplyCount: "应用补丁数",
  };
  return Object.entries(toolSummary)
    .filter(
      ([key, value]) =>
        !hiddenKeys.has(key) &&
        key !== "source" &&
        key !== "visibleToolSummaryLabels" &&
        key !== "rendererDiagnostics" &&
        value != null &&
        String(value).trim(),
    )
    .map(([key, value]) => {
      const label = keyLabels[key] ?? key;
      if (key === "totalDurationMs") {
        return `- ${label}: ${String(value).trim()} ms`;
      }
      return `- ${label}: ${String(value).trim()}`;
    })
    .join("\n");
}

function buildAssistantCardToolSummaryText(items, toolSummary) {
  const normalizedItems = Array.isArray(items) ? items : [];
  const itemToolSummaryLines = humanizeToolSummaryLabels(
    normalizedItems.flatMap((item) => sanitizeToolSummaryLabels(item?.toolSummaryLabels)),
  );
  const flowToolSummaryLines = buildToolSummaryFlowLines(toolSummary);
  const fallbackToolSummaryLines =
    flowToolSummaryLines.length > 0
      ? flowToolSummaryLines
      : itemToolSummaryLines.length > 0
      ? itemToolSummaryLines
      : humanizeToolSummaryLabels(toolSummary?.visibleToolSummaryLabels);
  return fallbackToolSummaryLines.length > 0
    ? fallbackToolSummaryLines.map((line) => `- ${line}`).join("\n")
    : formatLegacyToolSummary(toolSummary);
}

function upsertAssistantCardStateFromEvent(state, event) {
  const toolSummaryStartedAt = normalizeAssistantCardTimestamp(
    event?.message?.toolStateSummary?.startedAt,
  );
  const next = normalizeAssistantCardStateShape(
    {
      ...(state != null && typeof state === "object" ? state : {}),
    },
    {
      startedAt: toolSummaryStartedAt ?? event?.generatedAt ?? nowIso(),
      localThreadId: event?.message?.localThreadId ?? null,
      localTurnId: event?.message?.turnId ?? null,
    },
  );
  next.localThreadId =
    String(event?.message?.localThreadId ?? next.localThreadId ?? "").trim() || null;
  next.localTurnId =
    String(event?.message?.turnId ?? next.localTurnId ?? "").trim() || null;
  next.startedAt =
    chooseEarlierAssistantCardTimestamp(next.startedAt, toolSummaryStartedAt) ??
    event?.generatedAt ??
    nowIso();
  const explicitSection = normalizeAssistantCardSectionName(
    event?.message?.assistantSection ??
      event?.message?.bridgeSection ??
      event?.message?.streamKind,
  );
  if (explicitSection) {
    const itemIndex = Number(event?.message?.itemIndex);
    const turnIndex = Number(event?.message?.turnIndex);
    const rawItemId = String(event?.message?.itemId ?? "").trim();
    const rawSubtype = String(event?.message?.eventSubtype ?? "").trim();
    const entryKey = [
      explicitSection,
      String(event?.message?.turnId ?? "no-turn").trim() || "no-turn",
      rawItemId ||
        rawSubtype ||
        [
          Number.isFinite(turnIndex) ? turnIndex : "no-turn-index",
          Number.isFinite(itemIndex) ? itemIndex : "no-item-index",
        ].join(":"),
    ].join(":");
    next.sectionStreams = upsertAssistantCardSectionStreamChunk(
      next.sectionStreams,
      explicitSection,
      {
        key: entryKey,
        text: event?.message?.text,
        observedAt: event?.generatedAt ?? nowIso(),
        turnStatus: event?.message?.turnStatus,
      },
    );
    next.sectionMode = "typed";
    const toolSummary = event?.message?.toolStateSummary;
    if (
      toolSummary != null &&
      typeof toolSummary === "object" &&
      String(toolSummary.source ?? "").trim().toLowerCase() === "app_server_native"
    ) {
      next.toolSummary = { ...toolSummary };
      Object.assign(next, maybeApplyRolloutCardTimingToState(next, next.toolSummary));
    }
    const turnStatus = String(event?.message?.turnStatus ?? "").trim().toLowerCase();
    const sourceCompleted =
      event?.message?.sourceCompleted === true || turnStatus === "completed";
    if (sourceCompleted) {
      next.sourceCompletedAt =
        getAssistantCardSourceCompletedAt(next) ?? String(event?.generatedAt ?? nowIso());
      next.completedAt = next.sourceCompletedAt;
      next.presentationCompletedAt = next.presentationCompletedAt ?? next.sourceCompletedAt;
      next.presentation = {
        ...normalizeAssistantCardPresentationState(next.presentation),
        phase: "completed",
        renderedFinalChars: countAssistantCardTextChars(
          buildAssistantCardSectionStreamText(next.sectionStreams.final),
        ),
        lastPlaybackAt: next.presentationCompletedAt,
      };
    } else {
      next.sourceCompletedAt = null;
      next.completedAt = null;
      next.presentationCompletedAt = null;
      next.presentation = {
        ...normalizeAssistantCardPresentationState(next.presentation),
        phase: "streaming",
      };
    }
    return normalizeAssistantCardStateShape(next);
  }
  const itemIndex = Number(event?.message?.itemIndex);
  const turnIndex = Number(event?.message?.turnIndex);
  const entryKey = [
    Number.isFinite(turnIndex) ? turnIndex : "no-turn-index",
    Number.isFinite(itemIndex) ? itemIndex : "no-item-index",
  ].join(":");
  const entry = {
    key: entryKey,
    itemIndex: Number.isFinite(itemIndex) ? itemIndex : null,
    turnIndex: Number.isFinite(turnIndex) ? turnIndex : null,
    text: String(event?.message?.text ?? "").trim(),
    turnStatus: String(event?.message?.turnStatus ?? "").trim() || null,
    observedAt: String(event?.generatedAt ?? nowIso()),
    ...(sanitizeToolSummaryLabels(event?.message?.toolSummaryLabels).length > 0
      ? {
          toolSummaryLabels: sanitizeToolSummaryLabels(event?.message?.toolSummaryLabels),
        }
      : {}),
  };
  const items = Array.isArray(next.items) ? [...next.items] : [];
  const existingIndex = items.findIndex((candidate) => candidate?.key === entry.key);
  if (existingIndex >= 0) {
    items[existingIndex] = {
      ...items[existingIndex],
      ...entry,
    };
  } else {
    items.push(entry);
  }
  next.items = items
    .filter((candidate) => String(candidate?.text ?? "").trim())
    .sort((left, right) => {
      const turnDelta = Number(left?.turnIndex ?? 0) - Number(right?.turnIndex ?? 0);
      if (turnDelta !== 0) {
        return turnDelta;
      }
      const itemDelta = Number(left?.itemIndex ?? 0) - Number(right?.itemIndex ?? 0);
      if (itemDelta !== 0) {
        return itemDelta;
      }
      return String(left?.observedAt ?? "").localeCompare(String(right?.observedAt ?? ""));
    });
  const toolSummary = event?.message?.toolStateSummary;
  if (
    toolSummary != null &&
    typeof toolSummary === "object" &&
    String(toolSummary.source ?? "").trim().toLowerCase() === "app_server_native"
  ) {
    next.toolSummary = { ...toolSummary };
    Object.assign(next, maybeApplyRolloutCardTimingToState(next, next.toolSummary));
  }
  const allCompleted = areAssistantCardItemsCompleted(next.items);
  if (allCompleted) {
    next.sourceCompletedAt =
      getAssistantCardSourceCompletedAt(next) ?? String(event?.generatedAt ?? nowIso());
    next.completedAt = next.sourceCompletedAt;
    next.finalItemKey = normalizeAssistantCardItemKey(next.items[next.items.length - 1]?.key);
  } else {
    next.sourceCompletedAt = null;
    next.completedAt = null;
    next.finalItemKey = null;
    next.presentationCompletedAt = null;
  }
  let normalizedNext = clampAssistantCardPresentationState(next);
  normalizedNext = fastCompleteAssistantCardFinalOnlyPresentation(
    normalizedNext,
    event?.generatedAt ?? nowIso(),
  );
  if (shouldPrimeAssistantCardProgress(normalizedNext)) {
    normalizedNext = revealNextAssistantCardProgressItem(
      normalizedNext,
      event?.generatedAt ?? nowIso(),
    ).state;
  }
  return normalizedNext;
}

function deriveAssistantCardSectionsFromState(state) {
  const normalizedState = clampAssistantCardPresentationState(state);
  if (
    normalizedState?.sectionMode === "typed" ||
    hasAssistantCardSectionStreamContent(normalizedState?.sectionStreams)
  ) {
    const sourceCompleted = Boolean(getAssistantCardSourceCompletedAt(normalizedState));
    const progressText = buildAssistantCardSectionStreamText(
      normalizedState?.sectionStreams?.progress,
    );
    const streamedToolText = buildAssistantCardSectionStreamText(
      normalizedState?.sectionStreams?.tool,
    );
    const toolSummaryText =
      streamedToolText ||
      buildAssistantCardToolSummaryText([], normalizedState?.toolSummary);
    const finalText = stripAssistantCardInternalFinalText(
      buildAssistantCardSectionStreamText(normalizedState?.sectionStreams?.final),
    );
    return {
      progressText,
      toolSummaryText,
      finalText,
      fullFinalText: finalText,
      completed: sourceCompleted,
      sourceCompleted,
      presentationCompleted: Boolean(normalizedState?.presentationCompletedAt),
      progressPlaceholder:
        sourceCompleted && !progressText
          ? ASSISTANT_CARD_PROGRESS_EMPTY_FINAL
          : ASSISTANT_CARD_PROGRESS_PLACEHOLDER,
      toolPlaceholder:
        sourceCompleted && !toolSummaryText
          ? ASSISTANT_CARD_TOOL_EMPTY_FINAL
          : ASSISTANT_CARD_TOOL_PLACEHOLDER,
    };
  }
  const items = Array.isArray(normalizedState?.items) ? normalizedState.items : [];
  const sourceCompleted = Boolean(getAssistantCardSourceCompletedAt(normalizedState));
  const presentationCompleted = Boolean(normalizedState?.presentationCompletedAt);
  const progressItems = listAssistantCardProgressItems(items, normalizedState);
  const finalItem = sourceCompleted ? getAssistantCardFinalItem(items, normalizedState) : null;
  const fullFinalText = stripAssistantCardInternalFinalText(finalItem?.text);
  const progressText = progressItems
    .map((item) => {
      const key = normalizeAssistantCardItemKey(item?.key);
      const renderedChars = Math.max(
        0,
        Number(normalizedState?.presentation?.progressCursorByKey?.[key] ?? 0) || 0,
      );
      return sliceAssistantCardTextChars(String(item?.text ?? "").trim(), renderedChars).trim();
    })
    .filter(Boolean)
    .join("\n\n");
  const finalText = sourceCompleted
    ? sliceAssistantCardTextChars(
        fullFinalText,
        presentationCompleted
          ? countAssistantCardTextChars(fullFinalText)
          : normalizedState?.presentation?.renderedFinalChars ?? 0,
      ).trim()
    : "";
  const toolSummaryText = buildAssistantCardToolSummaryText(
    items,
    normalizedState?.toolSummary,
  );
  return {
    progressText,
    toolSummaryText,
    finalText,
    fullFinalText,
    completed: sourceCompleted,
    sourceCompleted,
    presentationCompleted,
    progressPlaceholder:
      sourceCompleted && !progressText
        ? ASSISTANT_CARD_PROGRESS_EMPTY_FINAL
        : ASSISTANT_CARD_PROGRESS_PLACEHOLDER,
    toolPlaceholder:
      sourceCompleted && !toolSummaryText
        ? ASSISTANT_CARD_TOOL_EMPTY_FINAL
        : ASSISTANT_CARD_TOOL_PLACEHOLDER,
  };
}

function buildFeishuDeliveryUuid(value) {
  const hex = crypto
    .createHash("sha256")
    .update(String(value ?? ""), "utf8")
    .digest("hex")
    .slice(0, 32);
  if (hex.length !== 32) {
    return null;
  }
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

function measureUtf8Bytes(value) {
  return Buffer.byteLength(String(value ?? ""), "utf8");
}

function buildFeishuTextRequestBody({ receiveId, text, uuid = null } = {}) {
  const normalizedReceiveId =
    String(receiveId ?? "").trim() || FEISHU_MEASURE_PLACEHOLDER_RECEIVE_ID;
  return JSON.stringify({
    receive_id: normalizedReceiveId,
    msg_type: "text",
    content: JSON.stringify({ text: String(text ?? "") }),
    ...(uuid ? { uuid: String(uuid) } : {}),
  });
}

function measureFeishuTextRequestBytes({ receiveId, text, uuid = null } = {}) {
  return measureUtf8Bytes(
    buildFeishuTextRequestBody({
      receiveId,
      text,
      uuid,
    }),
  );
}

function buildFeishuInteractiveRequestBody({ receiveId, card, uuid = null } = {}) {
  return JSON.stringify({
    receive_id: String(receiveId ?? FEISHU_MEASURE_PLACEHOLDER_RECEIVE_ID),
    msg_type: "interactive",
    content: JSON.stringify(card ?? {}),
    ...(uuid ? { uuid: String(uuid) } : {}),
  });
}

function measureFeishuInteractiveRequestBytes({ receiveId, card, uuid = null } = {}) {
  return measureUtf8Bytes(
    buildFeishuInteractiveRequestBody({
      receiveId,
      card,
      uuid,
    }),
  );
}

function buildFeishuCardPatchRequestBody({ messageId, card } = {}) {
  return JSON.stringify({
    message_id: String(messageId ?? FEISHU_CARD_MEASURE_PLACEHOLDER_MESSAGE_ID),
    content: JSON.stringify(card ?? {}),
  });
}

function measureFeishuCardPatchRequestBytes({ messageId, card } = {}) {
  return measureUtf8Bytes(
    buildFeishuCardPatchRequestBody({
      messageId,
      card,
    }),
  );
}

function hashStableJson(value) {
  return crypto.createHash("sha1").update(JSON.stringify(value ?? null), "utf8").digest("hex");
}

function formatFeishuElapsedLabel(startedAt, endedAt = nowIso()) {
  const startedMs = new Date(String(startedAt ?? "")).getTime();
  const endedMs = new Date(String(endedAt ?? "")).getTime();
  if (!Number.isFinite(startedMs) || !Number.isFinite(endedMs)) {
    return "0分00秒";
  }
  const totalSeconds = Math.max(0, Math.floor((endedMs - startedMs) / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}分${String(seconds).padStart(2, "0")}秒`;
}

function truncateForCardSummary(text, maxChars = FEISHU_CARD_FILE_SUMMARY_MAX_CHARS) {
  const source = String(text ?? "").trim();
  const normalizedMaxChars = Math.max(64, Number(maxChars) || FEISHU_CARD_FILE_SUMMARY_MAX_CHARS);
  if (!source || source.length <= normalizedMaxChars) {
    return source;
  }
  return `${source.slice(0, normalizedMaxChars).trimEnd()}\n\n（内容较长，完整正式回复见下方附件 Markdown 文件）`;
}

function buildAssistantCardMarkdownSection(title, content) {
  const body = String(content ?? "").trim();
  if (!body) {
    return null;
  }
  return {
    tag: "markdown",
    content: `### ${title}\n\n${body}`,
  };
}

function buildAssistantCardMarkdownBlock(content) {
  const body = String(content ?? "").trim();
  if (!body) {
    return null;
  }
  return {
    tag: "markdown",
    content: body,
  };
}

function buildAssistantCardCodeFence(language, content) {
  const body = String(content ?? "").trim();
  if (!body) {
    return "";
  }
  return `\`\`\`${String(language ?? "").trim()}\n${body}\n\`\`\``.trim();
}

function truncateAssistantCardPlainText(text, maxChars = 240) {
  const source = String(text ?? "").trim();
  const normalizedMaxChars = Math.max(32, Number(maxChars) || 240);
  if (!source || source.length <= normalizedMaxChars) {
    return source;
  }
  return `${source.slice(0, normalizedMaxChars - 3).trimEnd()}...`;
}

function truncateAssistantCardStreamingText(
  text,
  maxChars = ASSISTANT_CARD_STREAMING_TEXT_MAX_CHARS,
) {
  const source = String(text ?? "").trim();
  const normalizedMaxChars = Math.max(256, Number(maxChars) || ASSISTANT_CARD_STREAMING_TEXT_MAX_CHARS);
  if (!source) {
    return source;
  }
  const segments = splitAssistantCardStreamingSegments(source);
  if (
    segments.length <= ASSISTANT_CARD_STREAMING_MAX_PARAGRAPHS &&
    source.length <= normalizedMaxChars
  ) {
    return source;
  }
  const selectedSegments = [];
  let selectedLength = 0;
  for (let index = segments.length - 1; index >= 0; index -= 1) {
    if (selectedSegments.length >= ASSISTANT_CARD_STREAMING_MAX_PARAGRAPHS) {
      break;
    }
    const segment = String(segments[index] ?? "").trim();
    if (!segment) {
      continue;
    }
    const separatorLength = selectedSegments.length > 0 ? 2 : 0;
    if (selectedSegments.length > 0 && selectedLength + separatorLength + segment.length > normalizedMaxChars) {
      break;
    }
    selectedSegments.unshift(segment);
    selectedLength += segment.length + separatorLength;
  }
  const condensed = selectedSegments.join("\n\n").trim();
  if (!condensed) {
    return `...\n${source.slice(source.length - normalizedMaxChars).trimStart()}`;
  }
  if (condensed.length > normalizedMaxChars) {
    return `...\n${condensed.slice(condensed.length - normalizedMaxChars).trimStart()}`;
  }
  return selectedSegments.length < segments.length ? `...\n${condensed}` : condensed;
}

function splitAssistantCardStreamingSegments(text) {
  const source = String(text ?? "").replace(/\r\n/g, "\n").trim();
  if (!source) {
    return [];
  }
  const paragraphSegments = source
    .split(/\n{2,}/)
    .map((segment) => String(segment ?? "").trim())
    .filter(Boolean);
  if (paragraphSegments.length > 1) {
    return paragraphSegments;
  }
  const lineSegments = source
    .split(/\n+/)
    .map((segment) => String(segment ?? "").trim())
    .filter(Boolean);
  if (lineSegments.length > 1) {
    return lineSegments;
  }
  const sentenceSegments =
    source
      .match(/[^。！？!?]+(?:[。！？!?]+|$)/g)
      ?.map((segment) => String(segment ?? "").trim())
      .filter(Boolean) ?? [];
  if (sentenceSegments.length > 1) {
    return sentenceSegments;
  }
  return [source];
}

function matchMarkdownFenceStart(line) {
  const source = String(line ?? "").trim();
  const match = source.match(/^([`~]{3,})(.*)$/);
  if (!match) {
    return null;
  }
  return {
    markerCharacter: String(match[1] ?? "")[0],
    markerLength: String(match[1] ?? "").length,
    info: String(match[2] ?? "")
      .trim()
      .split(/\s+/)[0]
      .trim()
      .toLowerCase(),
  };
}

function isMatchingMarkdownFenceEnd(line, fenceStart) {
  if (fenceStart == null || typeof fenceStart !== "object") {
    return false;
  }
  const source = String(line ?? "").trim();
  const match = source.match(/^([`~]{3,})\s*$/);
  return Boolean(
    match &&
      String(match[1] ?? "")[0] === String(fenceStart.markerCharacter ?? "") &&
      String(match[1] ?? "").length >= Number(fenceStart.markerLength ?? 0),
  );
}

function splitMarkdownTableRow(line) {
  const source = String(line ?? "").trim();
  if (!source || !source.includes("|")) {
    return null;
  }
  let working = source;
  if (working.startsWith("|")) {
    working = working.slice(1);
  }
  if (working.endsWith("|")) {
    working = working.slice(0, -1);
  }
  const cells = [];
  let current = "";
  let escaped = false;
  for (const character of working) {
    if (character === "|" && !escaped) {
      cells.push(current.trim().replace(/\\\|/g, "|"));
      current = "";
      continue;
    }
    current += character;
    if (character === "\\" && !escaped) {
      escaped = true;
    } else {
      escaped = false;
    }
  }
  cells.push(current.trim().replace(/\\\|/g, "|"));
  return cells;
}

function isMarkdownTableSeparatorCell(cell) {
  return /^:?-{3,}:?$/.test(String(cell ?? "").trim());
}

function containsMarkdownTableMergedCellMarkup(value) {
  const source = String(value ?? "");
  return /<\s*\/?\s*(table|tr|td|th)\b/i.test(source) || /\b(?:rowspan|colspan)\s*=/i.test(source);
}

function parseMarkdownTableBlock(lines, startIndex = 0) {
  if (!Array.isArray(lines) || startIndex < 0 || startIndex + 1 >= lines.length) {
    return null;
  }
  const headerLine = String(lines[startIndex] ?? "");
  const separatorLine = String(lines[startIndex + 1] ?? "");
  const headerCells = splitMarkdownTableRow(headerLine);
  const separatorCells = splitMarkdownTableRow(separatorLine);
  if (
    !headerCells ||
    !separatorCells ||
    headerCells.length < 2 ||
    headerCells.length !== separatorCells.length ||
    !separatorCells.every((cell) => isMarkdownTableSeparatorCell(cell))
  ) {
    return null;
  }
  const rawLines = [headerLine, separatorLine];
  const rows = [];
  let irregular = false;
  let index = startIndex + 2;
  while (index < lines.length) {
    const line = String(lines[index] ?? "");
    if (!line.trim() || matchMarkdownFenceStart(line)) {
      break;
    }
    const rowCells = splitMarkdownTableRow(line);
    if (!rowCells || rowCells.length < 2) {
      break;
    }
    rawLines.push(line);
    if (rowCells.length !== headerCells.length) {
      irregular = true;
    }
    rows.push(rowCells);
    index += 1;
  }
  const columnCount = headerCells.length;
  const rowCount = rows.length;
  const mergedCellsLikeMarkup = rawLines.some((line) => containsMarkdownTableMergedCellMarkup(line));
  const overwide =
    [headerCells, ...rows].some((row) =>
      row.some((cell) => String(cell ?? "").trim().length > ASSISTANT_CARD_NATIVE_TABLE_MAX_CELL_CHARS),
    ) ||
    rawLines.some(
      (line) => String(line ?? "").trim().length > ASSISTANT_CARD_NATIVE_TABLE_MAX_ROW_CHARS,
    );
  let renderMode = "markdown";
  if (
    columnCount > ASSISTANT_CARD_FILE_TABLE_MAX_COLUMNS ||
    rowCount > ASSISTANT_CARD_FILE_TABLE_MAX_ROWS
  ) {
    renderMode = "file";
  } else if (
    irregular ||
    mergedCellsLikeMarkup ||
    overwide ||
    columnCount > ASSISTANT_CARD_MARKDOWN_TABLE_MAX_COLUMNS ||
    rowCount > ASSISTANT_CARD_MARKDOWN_TABLE_MAX_ROWS
  ) {
    renderMode = "markdown";
  } else if (
    rowCount > 0 &&
    columnCount <= ASSISTANT_CARD_NATIVE_TABLE_MAX_COLUMNS &&
    rowCount <= ASSISTANT_CARD_NATIVE_TABLE_MAX_ROWS
  ) {
    renderMode = "native";
  }
  return {
    nextIndex: index,
    block: {
      type: "table",
      rawText: rawLines.join("\n").trim(),
      headerCells,
      rows,
      columnCount,
      rowCount,
      irregular,
      mergedCellsLikeMarkup,
      overwide,
      renderMode,
    },
  };
}

function buildAssistantCardRichContentPlan(finalText) {
  const source = String(finalText ?? "").replace(/\r\n/g, "\n");
  if (!source.trim()) {
    return {
      blocks: [],
      requiresFileFallback: false,
      requiresMermaidResolution: false,
    };
  }
  const lines = source.split("\n");
  const blocks = [];
  let markdownBuffer = [];
  let nativeTableCount = 0;
  const flushMarkdownBuffer = () => {
    const content = markdownBuffer.join("\n").trim();
    markdownBuffer = [];
    if (!content) {
      return;
    }
    blocks.push({
      type: "markdown",
      text: content,
    });
  };
  for (let index = 0; index < lines.length; ) {
    const line = String(lines[index] ?? "");
    const fenceStart = matchMarkdownFenceStart(line);
    if (fenceStart) {
      flushMarkdownBuffer();
      const rawLines = [line];
      let cursor = index + 1;
      let fenceClosed = false;
      while (cursor < lines.length) {
        rawLines.push(String(lines[cursor] ?? ""));
        if (isMatchingMarkdownFenceEnd(lines[cursor], fenceStart)) {
          fenceClosed = true;
          cursor += 1;
          break;
        }
        cursor += 1;
      }
      const codeLines = fenceClosed ? rawLines.slice(1, -1) : rawLines.slice(1);
      const rawText = rawLines.join("\n").trim();
      if (fenceStart.info === "mermaid") {
        const sourceText = codeLines.join("\n").trim();
        blocks.push({
          type: "mermaid",
          source: sourceText,
          rawText,
          diagramType: detectMermaidDiagramType(sourceText) || null,
          renderMode: "pending",
        });
      } else if (rawText) {
        blocks.push({
          type: "markdown",
          text: rawText,
        });
      }
      index = cursor;
      continue;
    }
    const tableBlock = parseMarkdownTableBlock(lines, index);
    if (tableBlock) {
      flushMarkdownBuffer();
      const normalizedBlock = {
        ...tableBlock.block,
      };
      if (normalizedBlock.renderMode === "native") {
        nativeTableCount += 1;
        if (nativeTableCount > ASSISTANT_CARD_NATIVE_TABLE_COMPONENT_MAX_COUNT) {
          normalizedBlock.renderMode = "markdown";
          normalizedBlock.downgradeReason = "native_table_component_limit";
        }
      }
      blocks.push(normalizedBlock);
      index = tableBlock.nextIndex;
      continue;
    }
    markdownBuffer.push(line);
    index += 1;
  }
  flushMarkdownBuffer();
  return {
    blocks,
    requiresFileFallback: blocks.some(
      (block) => block?.type === "table" && block?.renderMode === "file",
    ),
    requiresMermaidResolution: blocks.some((block) => block?.type === "mermaid"),
  };
}

function formatAssistantCardListContent(text) {
  const source = String(text ?? "").trim();
  if (!source) {
    return "";
  }
  const items = source
    .split(/\n{2,}/)
    .map((item) => String(item ?? "").trim())
    .filter(Boolean);
  if (items.length === 0) {
    return "";
  }
  return items
    .map((item) => {
      const lines = item.split(/\r?\n/);
      const [firstLine, ...restLines] = lines;
      const normalizedFirstLine = String(firstLine ?? "").trim();
      const normalizedRest = restLines
        .map((line) => String(line ?? "").trim())
        .filter(Boolean);
      if (normalizedRest.length === 0) {
        return `- ${normalizedFirstLine}`;
      }
      return [`- ${normalizedFirstLine}`, ...normalizedRest.map((line) => `  ${line}`)].join("\n");
    })
    .join("\n");
}

function resolveAssistantCardPanelContent(primaryContent, placeholder) {
  const body = String(primaryContent ?? "").trim();
  if (body) {
    return body;
  }
  return String(placeholder ?? "").trim();
}

function buildAssistantCardPanelElement({
  elementId,
  contentElementId = null,
  title,
  content,
  expanded = false,
  backgroundColor = "grey",
} = {}) {
  const body = String(content ?? "").trim();
  const normalizedContentElementId = String(contentElementId ?? "").trim();
  if (!body && !normalizedContentElementId) {
    return null;
  }
  return {
    tag: "collapsible_panel",
    element_id: String(elementId ?? "").trim() || undefined,
    expanded: Boolean(expanded),
    vertical_spacing: "8px",
    padding: "8px 8px 8px 8px",
    background_color: backgroundColor,
    header: {
      title: {
        tag: "plain_text",
        content: String(title ?? "").trim() || "未命名区块",
      },
      vertical_align: "center",
      icon: {
        tag: "standard_icon",
        token: "down-small-ccm_outlined",
        color: "",
        size: "16px 16px",
      },
      icon_position: "right",
      icon_expanded_angle: -180,
    },
    border: {
      color: "grey",
      corner_radius: "5px",
    },
    elements: [
      {
        tag: "markdown",
        content: body,
        ...(normalizedContentElementId
          ? {
              element_id: normalizedContentElementId,
            }
          : {}),
      },
    ],
  };
}

function buildAssistantCardFooterContent({
  status = "\u5904\u7406\u4e2d",
  durationLabel = "0\u520600\u79d2",
} = {}) {
  return `---\nAgent: \u9f99\u5934 \u2022 ${String(
    status ?? "\u5904\u7406\u4e2d",
  )} \u2022 \u7528\u65f6: ${String(durationLabel ?? "0\u520600\u79d2")}`;
}

function buildAssistantCardFooterKey({
  status = "\u5904\u7406\u4e2d",
  durationLabel = "0\u520600\u79d2",
} = {}) {
  return `${String(status ?? "\u5904\u7406\u4e2d")}|${String(
    durationLabel ?? "0\u520600\u79d2",
  )}`;
}

function buildAssistantCard({
  localThreadId,
  progressText = "",
  toolSummaryText = "",
  finalText = "",
  finalContentBlocks = [],
  completed = false,
  presentationCompleted = false,
  status = "处理中",
  durationLabel = "0分00秒",
  mode = "card",
  degraded = false,
  progressPlaceholder = ASSISTANT_CARD_PROGRESS_PLACEHOLDER,
  toolPlaceholder = ASSISTANT_CARD_TOOL_PLACEHOLDER,
} = {}) {
  const normalizedProgress = String(progressText ?? "").trim();
  const normalizedToolSummary = String(toolSummaryText ?? "").trim();
  const normalizedFinal = String(finalText ?? "").trim();
  const elements = [];
  if (String(localThreadId ?? "").trim()) {
    elements.push({
      tag: "markdown",
      content: `${ASSISTANT_CARD_CONVERSATION_META_LABEL}: \`${String(localThreadId).trim()}\``,
    });
  }
  const progressPanel = buildAssistantCardPanelElement({
    elementId: "progress_panel",
    title: ASSISTANT_CARD_PROGRESS_PANEL_TITLE,
    content: resolveAssistantCardPanelContent(
      formatAssistantCardListContent(normalizedProgress),
      progressPlaceholder,
    ),
    expanded: false,
    backgroundColor: "grey",
  });
  if (progressPanel) {
    elements.push(progressPanel);
  }
  const toolPanel = buildAssistantCardPanelElement({
    elementId: "tool_panel",
    title: ASSISTANT_CARD_TOOL_PANEL_TITLE,
    content: resolveAssistantCardPanelContent(normalizedToolSummary, toolPlaceholder),
    expanded: false,
    backgroundColor: "grey",
  });
  if (toolPanel) {
    elements.push(toolPanel);
  }
  if (normalizedFinal) {
    const finalElements = buildAssistantCardFinalContentElements(
      normalizedFinal,
      finalContentBlocks,
    );
    if (finalElements.length > 0) {
      elements.push(...finalElements);
    } else {
      const finalBlock = buildAssistantCardMarkdownBlock(normalizedFinal);
      if (finalBlock) {
        elements.push(finalBlock);
      }
    }
  }
  elements.push({
    tag: "markdown",
    content: buildAssistantCardFooterContent({ status, durationLabel }),
  });
  return {
    schema: "2.0",
    config: {
      update_multi: true,
      width_mode: "fill",
      enable_forward: true,
      summary: {
        content:
          mode === "card_plus_file"
            ? "完整正式回复已附加 Markdown 文件"
            : presentationCompleted
              ? String(status ?? "已完成")
              : String(status ?? "处理中"),
      },
    },
    header: {
      template: degraded ? "orange" : mode === "card_plus_file" ? "purple" : "blue",
      title: {
        tag: "plain_text",
        content: ASSISTANT_CARD_HEADER_TITLE,
      },
      padding: "12px 12px 12px 12px",
    },
    body: {
      direction: "vertical",
      padding: "12px 12px 12px 12px",
      vertical_spacing: "8px",
      elements,
    },
  };
}

function buildAssistantCardFileSummaryText(finalText) {
  return `${truncateForCardSummary(finalText)}`.replace(/\s+$/g, "").concat("\n\n完整内容见附件 Markdown 文件。");
}

function buildMeasuredAssistantCardRenderPayload({
  session,
  sections,
  statusLabel,
  durationLabel,
  finalContentBlocks = [],
  forceMode = null,
  degraded = false,
} = {}) {
  const buildCardForMode = (mode) =>
    buildAssistantCard({
      localThreadId: session?.local_thread_id,
      progressText: sections?.progressText,
      toolSummaryText: sections?.toolSummaryText,
      finalText:
        mode === "card_plus_file"
          ? buildAssistantCardFileSummaryText(sections?.finalText)
          : sections?.finalText,
      finalContentBlocks: mode === "card" ? finalContentBlocks : [],
      completed: Boolean(sections?.completed),
      presentationCompleted: Boolean(sections?.presentationCompleted),
      status: statusLabel,
      durationLabel,
      mode,
      degraded,
      progressPlaceholder: sections?.progressPlaceholder,
      toolPlaceholder: sections?.toolPlaceholder,
    });
  let mode = forceMode ?? (session?.mode === "card_plus_file" ? "card_plus_file" : "card");
  let card = buildCardForMode(mode);
  let measuredBytes = Math.max(
    measureFeishuInteractiveRequestBytes({
      receiveId: session?.feishu_open_id,
      card,
    }),
    measureFeishuCardPatchRequestBytes({
      messageId: session?.card_message_id ?? FEISHU_CARD_MEASURE_PLACEHOLDER_MESSAGE_ID,
      card,
    }),
  );
  if (
    sections?.completed &&
    sections?.finalText &&
    mode !== "card_plus_file" &&
    measuredBytes > FEISHU_CARD_REQUEST_MAX_BYTES
  ) {
    mode = "card_plus_file";
    card = buildCardForMode(mode);
    measuredBytes = Math.max(
      measureFeishuInteractiveRequestBytes({
        receiveId: session?.feishu_open_id,
        card,
      }),
      measureFeishuCardPatchRequestBytes({
        messageId: session?.card_message_id ?? FEISHU_CARD_MEASURE_PLACEHOLDER_MESSAGE_ID,
        card,
      }),
    );
  }
  if (measuredBytes > FEISHU_CARD_REQUEST_MAX_BYTES) {
    const error = new Error("assistant_card_render_too_large");
    error.status = 400;
    throw error;
  }
  return {
    mode,
    card,
    renderHash: hashStableJson(card),
  };
}

function buildAssistantCardFileArtifactName(at = new Date()) {
  const year = String(at.getFullYear());
  const month = String(at.getMonth() + 1).padStart(2, "0");
  const day = String(at.getDate()).padStart(2, "0");
  const hour = String(at.getHours()).padStart(2, "0");
  const minute = String(at.getMinutes()).padStart(2, "0");
  const second = String(at.getSeconds()).padStart(2, "0");
  return `正式回复-详细报告-${year}${month}${day}-${hour}${minute}${second}.md`;
}

function buildAssistantCardTableElement(tableBlock, index = 0) {
  if (
    tableBlock == null ||
    typeof tableBlock !== "object" ||
    !Array.isArray(tableBlock.headerCells) ||
    !Array.isArray(tableBlock.rows)
  ) {
    return null;
  }
  const columns = tableBlock.headerCells.map((cell, cellIndex) => ({
    name: `c${cellIndex + 1}`,
    display_name: String(cell ?? "").trim() || `列 ${cellIndex + 1}`,
    data_type: "markdown",
    horizontal_align: "left",
    vertical_align: "top",
    width: "auto",
  }));
  const rows = tableBlock.rows.map((row) =>
    Object.fromEntries(
      row.map((cell, cellIndex) => [`c${cellIndex + 1}`, String(cell ?? "").trim()]),
    ),
  );
  return {
    tag: "table",
    element_id: `table_${index + 1}`,
    page_size: Math.max(1, Math.min(10, rows.length || 1)),
    row_height: "auto",
    header_style: {
      text_align: "left",
      text_size: "normal",
      background_style: "grey",
      text_color: "default",
      bold: true,
      lines: 2,
    },
    columns,
    rows,
  };
}

function buildAssistantCardMermaidImageElement(block, index = 0) {
  const imageKey = String(block?.imageKey ?? "").trim();
  if (!imageKey) {
    return null;
  }
  const diagramType = String(block?.diagramType ?? "").trim() || "mermaid";
  return {
    tag: "img",
    element_id: `mimg_${index + 1}`,
    img_key: imageKey,
    scale_type: "fit_horizontal",
    preview: true,
    alt: {
      tag: "plain_text",
      content: `Mermaid ${diagramType}`,
    },
    title: {
      tag: "plain_text",
      content: `Mermaid 图 ${index + 1} · ${diagramType}`,
    },
    margin: "4px 0px 4px 0px",
  };
}

function buildAssistantCardFinalContentElements(finalText, finalContentBlocks = []) {
  const normalizedFinal = String(finalText ?? "").trim();
  const blocks =
    Array.isArray(finalContentBlocks) && finalContentBlocks.length > 0
      ? finalContentBlocks
      : normalizedFinal
        ? [
            {
              type: "markdown",
              text: normalizedFinal,
            },
          ]
        : [];
  if (blocks.length === 0) {
    return [];
  }
  const elements = [];
  let mermaidDisplayIndex = 0;
  let tableDisplayIndex = 0;
  for (const block of blocks) {
    if (block?.type === "markdown") {
      const markdownElement = buildAssistantCardMarkdownBlock(block?.text);
      if (markdownElement) {
        elements.push(markdownElement);
      }
      continue;
    }
    if (block?.type === "table") {
      if (block?.renderMode === "native") {
        const tableElement = buildAssistantCardTableElement(block, tableDisplayIndex);
        if (tableElement) {
          elements.push(tableElement);
          tableDisplayIndex += 1;
          continue;
        }
      }
      const markdownElement = buildAssistantCardMarkdownBlock(block?.rawText);
      if (markdownElement) {
        elements.push(markdownElement);
      }
      continue;
    }
    if (block?.type === "mermaid") {
      mermaidDisplayIndex += 1;
      const imageElement = buildAssistantCardMermaidImageElement(block, mermaidDisplayIndex - 1);
      if (imageElement) {
        elements.push(imageElement);
      } else {
        elements.push({
          tag: "markdown",
          content: `> Mermaid 图 ${mermaidDisplayIndex} 未生成预览，已保留源码。`,
        });
      }
      const diagnostics = [];
      if (String(block?.renderError ?? "").trim()) {
        diagnostics.push(`> 渲染失败：${truncateAssistantCardPlainText(block.renderError, 180)}`);
      }
      if (String(block?.artifactFileName ?? "").trim()) {
        diagnostics.push(`> 已附源文件：${String(block.artifactFileName).trim()}`);
      }
      const sourcePanel = buildAssistantCardPanelElement({
        elementId: `msrc_${mermaidDisplayIndex}`,
        title:
          imageElement != null
            ? `Mermaid 源码 ${mermaidDisplayIndex}`
            : `Mermaid 源码 ${mermaidDisplayIndex}（兜底）`,
        content: [diagnostics.join("\n"), buildAssistantCardCodeFence("mermaid", block?.source)]
          .filter(Boolean)
          .join("\n\n"),
        expanded: false,
        backgroundColor: "grey",
      });
      if (sourcePanel) {
        elements.push(sourcePanel);
      }
    }
  }
  return elements;
}

function isNaturalTextBoundary(character) {
  return /\s/.test(character) || /[，。！？,.!?;；:：]/.test(character);
}

function splitTextByMeasuredBytes(
  text,
  measureChunkBytes,
  maxBytes = FEISHU_TEXT_REQUEST_MAX_BYTES,
) {
  const source = String(text ?? "").trim();
  const normalizedMaxBytes = Math.max(256, Number(maxBytes) || FEISHU_TEXT_REQUEST_MAX_BYTES);
  if (!source) {
    return [];
  }
  if (!(measureChunkBytes instanceof Function)) {
    throw new TypeError("measureChunkBytes must be a function");
  }
  if (measureChunkBytes(source, 0) <= normalizedMaxBytes) {
    return [source];
  }
  const characters = Array.from(source);
  const chunks = [];
  let start = 0;
  while (start < characters.length) {
    while (start < characters.length && /\s/.test(characters[start])) {
      start += 1;
    }
    if (start >= characters.length) {
      break;
    }
    let end = start;
    let lastBreak = -1;
    let lastGood = -1;
    while (end < characters.length) {
      const candidate = characters.slice(start, end + 1).join("").trim();
      if (!candidate) {
        end += 1;
        continue;
      }
      const candidateBytes = Number(measureChunkBytes(candidate, chunks.length));
      if (!Number.isFinite(candidateBytes) || candidateBytes > normalizedMaxBytes) {
        break;
      }
      lastGood = end + 1;
      if (isNaturalTextBoundary(characters[end])) {
        lastBreak = end + 1;
      }
      end += 1;
    }
    let splitEnd = lastBreak > start ? lastBreak : lastGood;
    if (!Number.isFinite(splitEnd) || splitEnd <= start) {
      splitEnd = Math.min(characters.length, start + 1);
    }
    let chunk = characters.slice(start, splitEnd).join("").trim();
    if (!chunk) {
      splitEnd = Math.max(start + 1, splitEnd);
      chunk = characters.slice(start, splitEnd).join("").trim();
    }
    if (!chunk) {
      break;
    }
    chunks.push(chunk);
    start = splitEnd;
    while (start < characters.length && /\s/.test(characters[start])) {
      start += 1;
    }
  }
  return chunks.filter(Boolean);
}

function splitTextByUtf8Bytes(text, maxBytes = FEISHU_TEXT_REQUEST_MAX_BYTES) {
  return splitTextByMeasuredBytes(text, (candidate) => measureUtf8Bytes(candidate), maxBytes);
}

function normalizeFeishuTextPayloadOptions(optionsOrMaxBytes) {
  if (
    optionsOrMaxBytes == null ||
    typeof optionsOrMaxBytes === "number" ||
    typeof optionsOrMaxBytes === "string"
  ) {
    return {
      maxRequestBytes: optionsOrMaxBytes,
      receiveId: FEISHU_MEASURE_PLACEHOLDER_RECEIVE_ID,
      uuid: null,
    };
  }
  return {
    maxRequestBytes: optionsOrMaxBytes.maxRequestBytes,
    receiveId: optionsOrMaxBytes.receiveId,
    uuid: optionsOrMaxBytes.uuid ?? null,
  };
}

function buildFeishuTextPayloads(text, optionsOrMaxBytes = FEISHU_TEXT_REQUEST_MAX_BYTES) {
  const source = String(text ?? "").trim();
  const options = normalizeFeishuTextPayloadOptions(optionsOrMaxBytes);
  const normalizedMaxBytes = Math.max(
    256,
    Number(options.maxRequestBytes) || FEISHU_TEXT_REQUEST_MAX_BYTES,
  );
  if (!source) {
    return [];
  }
  const measurePayload = ({ text: candidateText, uuid = options.uuid } = {}) =>
    measureFeishuTextRequestBytes({
      receiveId: options.receiveId,
      text: candidateText,
      uuid,
    });
  if (measurePayload({ text: source }) <= normalizedMaxBytes) {
    return [source];
  }
  let totalEstimate = 2;
  let chunks = [];
  for (let attempt = 0; attempt < FEISHU_TEXT_CHUNK_MAX_ITERATIONS; attempt += 1) {
    chunks = splitTextByMeasuredBytes(
      source,
      (candidateText, index) =>
        measurePayload({
          text: `(${index + 1}/${totalEstimate}) ${candidateText}`.trim(),
        }),
      normalizedMaxBytes,
    );
    if (chunks.length === 0) {
      return [];
    }
    const chunkCount = chunks.length;
    const payloads = chunks.map((chunk, index) => `(${index + 1}/${chunkCount}) ${chunk}`.trim());
    const allFit = payloads.every(
      (payload) => measurePayload({ text: payload }) <= normalizedMaxBytes,
    );
    if (allFit && chunkCount === totalEstimate) {
      return payloads;
    }
    totalEstimate = Math.max(2, chunkCount);
  }
  return chunks.map((chunk, index) => `(${index + 1}/${chunks.length}) ${chunk}`.trim());
}

function createFeishuHttpError(prefix, response) {
  const status = Number(response?.status ?? response?.response?.status ?? NaN);
  const code = response?.data?.code ?? response?.code ?? "no_code";
  const detail = response?.data?.msg ?? response?.msg ?? response?.text ?? "";
  const error = new Error(`${prefix}:${Number.isFinite(status) ? status : "no_status"}:${code}:${detail}`);
  if (Number.isFinite(status)) {
    error.status = status;
    error.statusCode = status;
    error.response = {
      status,
      data: response?.data ?? null,
    };
  }
  return error;
}

function assertFeishuSdkSuccess(prefix, response) {
  if (response?.code != null && Number(response.code) !== 0) {
    throw createFeishuHttpError(prefix, response);
  }
  return response;
}

function clampInteger(value, min, max, fallback) {
  const normalized = Math.round(Number(value));
  if (!Number.isFinite(normalized)) {
    return fallback;
  }
  return Math.max(min, Math.min(max, normalized));
}

function normalizeAssistantCardKitElementId(value) {
  const normalized = String(value ?? "")
    .trim()
    .replace(/[^A-Za-z0-9_-]+/g, "_")
    .slice(0, 20);
  return normalized || ASSISTANT_CARD_CARDKIT_DEFAULT_ELEMENT_ID;
}

function normalizeAssistantCardKitSettings(settings = {}) {
  const printStrategy = String(
    settings.printStrategy ?? ASSISTANT_CARD_CARDKIT_DEFAULT_PRINT_STRATEGY,
  ).trim();
  return {
    enabled: Boolean(settings.enabled),
    elementId: normalizeAssistantCardKitElementId(settings.elementId),
    printFrequencyMs: clampInteger(
      settings.printFrequencyMs,
      10,
      1000,
      ASSISTANT_CARD_CARDKIT_DEFAULT_PRINT_FREQUENCY_MS,
    ),
    printStep: clampInteger(
      settings.printStep,
      1,
      20,
      ASSISTANT_CARD_CARDKIT_DEFAULT_PRINT_STEP,
    ),
    printStrategy:
      printStrategy === "fast" || printStrategy === "delay"
        ? printStrategy
        : ASSISTANT_CARD_CARDKIT_DEFAULT_PRINT_STRATEGY,
  };
}

function buildAssistantCardKitStreamingCard({
  localThreadId = null,
  content = "",
  elements = null,
  cardkit = {},
} = {}) {
  const settings = normalizeAssistantCardKitSettings({
    enabled: true,
    ...cardkit,
  });
  const title = ASSISTANT_CARD_HEADER_TITLE;
  const normalizedElements =
    Array.isArray(elements) && elements.length > 0
      ? elements
          .map((element) => {
            if (element?.tag) {
              return element;
            }
            return {
              tag: "markdown",
              content: String(element?.content ?? ""),
              element_id: normalizeAssistantCardKitElementId(element?.elementId),
            };
          })
          .filter((element) => element?.tag)
      : [
          {
            tag: "markdown",
            content: String(content ?? ""),
            element_id: settings.elementId,
          },
        ];
  return {
    schema: "2.0",
    config: {
      update_multi: true,
      width_mode: "fill",
      enable_forward: true,
      streaming_mode: true,
      summary: {
        content: "",
      },
      streaming_config: {
        print_frequency_ms: {
          default: settings.printFrequencyMs,
          android: settings.printFrequencyMs,
          ios: settings.printFrequencyMs,
          pc: settings.printFrequencyMs,
        },
        print_step: {
          default: settings.printStep,
          android: settings.printStep,
          ios: settings.printStep,
          pc: settings.printStep,
        },
        print_strategy: settings.printStrategy,
      },
    },
    header: {
      template: "blue",
      title: {
        tag: "plain_text",
        content: title,
      },
      padding: "12px 12px 12px 12px",
    },
    body: {
      direction: "vertical",
      padding: "12px 12px 12px 12px",
      vertical_spacing: "8px",
      elements: normalizedElements,
    },
  };
}

function getAssistantCardKitAssistantElementIds(cardkit = {}) {
  return {
    progress: normalizeAssistantCardKitElementId(
      cardkit.progressElementId ?? ASSISTANT_CARD_CARDKIT_PROGRESS_ELEMENT_ID,
    ),
    tool: normalizeAssistantCardKitElementId(
      cardkit.toolElementId ?? ASSISTANT_CARD_CARDKIT_TOOL_ELEMENT_ID,
    ),
    final: normalizeAssistantCardKitElementId(
      cardkit.finalElementId ?? ASSISTANT_CARD_CARDKIT_FINAL_ELEMENT_ID,
    ),
    footer: normalizeAssistantCardKitElementId(
      cardkit.footerElementId ?? ASSISTANT_CARD_CARDKIT_FOOTER_ELEMENT_ID,
    ),
  };
}

function buildAssistantCardKitStreamingContent(body) {
  const normalized = String(body ?? "").trim();
  return normalized
    ? `${ASSISTANT_CARD_CARDKIT_STREAM_PREFIX}${normalized}`
    : "";
}

function buildAssistantCardKitListStreamingContent(body) {
  const normalized = String(body ?? "").trim();
  if (!normalized) {
    return "";
  }
  if (/^-\s+/.test(normalized)) {
    return normalized.replace(/^-+\s*/, ASSISTANT_CARD_CARDKIT_LIST_STREAM_PREFIX);
  }
  return `${ASSISTANT_CARD_CARDKIT_LIST_STREAM_PREFIX}${normalized}`;
}

function buildAssistantCardKitAssistantElementContents(sections = {}) {
  const sourceCompleted = Boolean(sections?.sourceCompleted ?? sections?.completed);
  const progressText = String(sections.progressText ?? "").trim();
  const toolSummaryText = String(sections.toolSummaryText ?? "").trim();
  const progressBody = formatAssistantCardListContent(
    progressText || (sourceCompleted ? sections.progressPlaceholder : ""),
  );
  const toolBody =
    toolSummaryText || (sourceCompleted ? String(sections.toolPlaceholder ?? "").trim() : "");
  const finalBody = String(sections.finalText ?? "").trim();
  return {
    progress: buildAssistantCardKitListStreamingContent(progressBody),
    tool: buildAssistantCardKitListStreamingContent(toolBody),
    final: buildAssistantCardKitStreamingContent(finalBody),
  };
}

function deriveAssistantCardKitStreamingSectionsFromState(state) {
  const normalizedState = clampAssistantCardPresentationState(state);
  const baseSections = deriveAssistantCardSectionsFromState(normalizedState);
  if (
    normalizedState?.sectionMode === "typed" ||
    hasAssistantCardSectionStreamContent(normalizedState?.sectionStreams)
  ) {
    return {
      ...baseSections,
      progressText: buildAssistantCardSectionStreamText(
        normalizedState?.sectionStreams?.progress,
      ),
      toolSummaryText:
        buildAssistantCardSectionStreamText(normalizedState?.sectionStreams?.tool) ||
        baseSections.toolSummaryText,
      finalText: stripAssistantCardInternalFinalText(
        buildAssistantCardSectionStreamText(normalizedState?.sectionStreams?.final),
      ),
      fullFinalText: stripAssistantCardInternalFinalText(
        buildAssistantCardSectionStreamText(normalizedState?.sectionStreams?.final),
      ),
    };
  }
  const items = Array.isArray(normalizedState?.items) ? normalizedState.items : [];
  const sourceCompleted = Boolean(getAssistantCardSourceCompletedAt(normalizedState));
  const progressText = listAssistantCardProgressItems(items, normalizedState)
    .map((item) => String(item?.text ?? "").trim())
    .filter(Boolean)
    .join("\n\n");
  const finalItem = sourceCompleted
    ? getAssistantCardFinalItem(items, normalizedState)
    : null;
  const fullFinalText = stripAssistantCardInternalFinalText(finalItem?.text);
  return {
    ...baseSections,
    progressText,
    finalText: sourceCompleted ? fullFinalText : "",
    fullFinalText,
  };
}

function buildAssistantCardKitAssistantStreamingCard({
  localThreadId = null,
  cardkit = {},
  elementContents = null,
  footerStatus = "\u5904\u7406\u4e2d",
  durationLabel = "0\u520600\u79d2",
} = {}) {
  const normalizedLocalThreadId = String(localThreadId ?? "").trim();
  const elementIds = getAssistantCardKitAssistantElementIds(cardkit);
  const initialContents =
    elementContents != null && typeof elementContents === "object"
      ? {
          progress: String(elementContents.progress ?? ""),
          tool: String(elementContents.tool ?? ""),
          final: String(elementContents.final ?? ""),
        }
      : buildAssistantCardKitAssistantElementContents({});
  const progressPanel = buildAssistantCardPanelElement({
    elementId: "progress_panel",
    contentElementId: elementIds.progress,
    title: ASSISTANT_CARD_PROGRESS_PANEL_TITLE,
    content: initialContents.progress,
    expanded: false,
    backgroundColor: "grey",
  });
  const toolPanel = buildAssistantCardPanelElement({
    elementId: "tool_panel",
    contentElementId: elementIds.tool,
    title: ASSISTANT_CARD_TOOL_PANEL_TITLE,
    content: initialContents.tool,
    expanded: false,
    backgroundColor: "grey",
  });
  const conversationMetaElement = normalizedLocalThreadId
    ? {
        tag: "markdown",
        content: `${ASSISTANT_CARD_CONVERSATION_META_LABEL}: \`${normalizedLocalThreadId}\``,
      }
    : null;
  return buildAssistantCardKitStreamingCard({
    localThreadId,
    cardkit: {
      ...cardkit,
      elementId: elementIds.progress,
    },
    elements: [
      conversationMetaElement,
      progressPanel,
      toolPanel,
      {
        elementId: elementIds.final,
        content: initialContents.final,
      },
      {
        tag: "markdown",
        element_id: elementIds.footer,
        content: buildAssistantCardFooterContent({
          status: footerStatus,
          durationLabel,
        }),
      },
    ].filter(Boolean),
  });
}

function buildAssistantCardKitMessageContent(cardId) {
  const normalizedCardId = String(cardId ?? "").trim();
  if (!normalizedCardId) {
    throw new Error("assistant_card_cardkit_card_id_missing");
  }
  return {
    type: "card",
    data: {
      card_id: normalizedCardId,
    },
  };
}

function extractAssistantCardKitCardId(response) {
  return String(response?.data?.card_id ?? response?.card_id ?? "").trim() || null;
}

function extractFeishuMessageId(response) {
  return String(response?.data?.message_id ?? response?.message_id ?? "").trim() || null;
}

function normalizeAssistantCardKitSequence(sequence) {
  const normalized = Math.trunc(Number(sequence));
  if (!Number.isFinite(normalized) || normalized < 1) {
    throw new Error("assistant_card_cardkit_sequence_invalid");
  }
  return normalized;
}

function stripInlineBinaryPayloads(text) {
  let attachmentCount = 0;
  const sanitized = String(text ?? "").replace(
    /data:(?:image|audio|video|application)\/[^;,\s]+;base64,[A-Za-z0-9+/=\r\n]+/gi,
    () => {
      attachmentCount += 1;
      return "[本地附件已省略]";
    },
  );
  return {
    text: sanitized,
    attachmentCount,
  };
}

function sanitizeFeishuMirrorText(text) {
  const strippedBinary = stripInlineBinaryPayloads(text);
  let sanitized = strippedBinary.text;
  if (!sanitized) {
    return "";
  }
  sanitized = sanitized.replace(
    /【[^】]*(?:[A-Za-z]:[\\/]|\/[A-Za-z]:\/|F:\/[A-Za-z]:\/)[^】]*】/g,
    "",
  );
  sanitized = sanitized.replace(
    /【[^】]*?(?:[A-Za-z]:[\\/]|F:\/[A-Za-z]:\/)[^】]*】/g,
    "",
  );
  sanitized = sanitized.replace(
    /\[([^\]]+)\]\(((?:file:\/\/)?(?:\/)?(?:[A-Za-z]:[\\/]|F:\/[A-Za-z]:\/)[^)]+)\)/g,
    "$1",
  );
  sanitized = sanitized.replace(
    /\[([^\]]+)\]\(<\/?[A-Za-z]:[\\/][^>]+>\)/g,
    "$1",
  );
  sanitized = sanitized.replace(
    /\[([^\]]+)\]\(<\/?[A-Za-z]:\/[^>]+>\)/g,
    "$1",
  );
  sanitized = sanitized.replace(
    /(?:^|[\s(])((?:[A-Za-z]:[\\/]|F:\/[A-Za-z]:\/)[^\s)\]}】>,;，。！？]+)(?=$|[\s)\]}】>,;，。！？])/g,
    " ",
  );
  sanitized = sanitized
    .replace(/\b(?:image|attachment|file)\s*:\s*\[本地附件已省略\]/gi, "[本地附件已省略]")
    .replace(/\[本地附件已省略\](?:\s*\[本地附件已省略\])+/g, "[本地附件已省略]")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  if (strippedBinary.attachmentCount > 0 && !sanitized.includes("[本地附件已省略]")) {
    sanitized = `${sanitized}\n\n[本地附件已省略：${strippedBinary.attachmentCount} 项]`.trim();
  }
  return sanitized;
}

function sanitizeDesktopLocalMirrorText(text) {
  return sanitizeFeishuMirrorText(text);
}

function sanitizeLedgerTextForFeishu(ledger) {
  const origin = String(ledger?.origin ?? "").trim().toLowerCase();
  const role = String(ledger?.role ?? "").trim().toLowerCase();
  const text = String(ledger?.text ?? "");
  if (!text) {
    return "";
  }
  if (origin === "desktop_local" && role === "user") {
    return sanitizeDesktopLocalMirrorText(text);
  }
  return sanitizeFeishuMirrorText(text);
}

function formatMirroredText(event) {
  const text = String(event?.message?.text ?? "").trim();
  if (!text) {
    return "";
  }
  if (event?.eventType === "desktop_local_user_message") {
    return sanitizeDesktopLocalMirrorText(text);
  }
  return sanitizeFeishuMirrorText(text);
}

function normalizeComparableUserText(text) {
  return String(text ?? "")
    .trim()
    .replace(/^\[[^\]]+\]\s*/, "")
    .trim();
}

function getBackoffDelayMs(attempts) {
  return Math.min(60000, 1000 * (2 ** Math.min(6, attempts)));
}

function base64Url(buffer) {
  return Buffer.from(buffer)
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}

function randomBase64Url(size = 32) {
  return base64Url(crypto.randomBytes(size));
}

function sha256Base64Url(value) {
  return base64Url(crypto.createHash("sha256").update(String(value ?? ""), "utf8").digest());
}

function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/\"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function buildUserSendAuthStateKey(state) {
  return `sidecar:userSendAuthPending:${state}`;
}

function buildUserSendTokenKey(openId) {
  return `sidecar:userSendAccessToken:${openId}`;
}

function buildSelfUserMirrorMessageKey(messageId) {
  return `sidecar:selfUserMirrorMessage:${messageId}`;
}

const SELF_USER_MIRROR_TTL_MS = 15000;

async function httpJsonRequest(url, { method = "GET", headers = {}, body = null } = {}) {
  const response = await fetch(url, {
    method,
    headers,
    body,
  });
  const text = await response.text();
  let payload = null;
  try {
    payload = text ? JSON.parse(text) : null;
  } catch {
    payload = text;
  }
  return {
    ok: response.ok,
    status: response.status,
    headers: response.headers,
    text,
    data: payload,
  };
}

class PipeClient {
  constructor(pipeName) {
    this.pipeName = pipeName;
    this.socket = null;
    this.readline = null;
    this.nextId = 1;
    this.pending = new Map();
    this.notificationHandlers = new Map();
    this.onConnectHandlers = new Set();
    this.connected = false;
    this.connectPromise = null;
  }

  on(method, handler) {
    this.notificationHandlers.set(method, handler);
  }

  registerOnConnect(handler) {
    this.onConnectHandlers.add(handler);
  }

  async ensureConnected() {
    if (this.connected) {
      return;
    }
    await this.connect();
  }

  async connect() {
    if (this.connected) {
      return;
    }
    if (this.connectPromise != null) {
      return this.connectPromise;
    }
    this.connectPromise = new Promise((resolve, reject) => {
      const socket = net.createConnection(this.pipeName);
      const cleanup = () => {
        socket.removeListener("connect", handleConnect);
        socket.removeListener("error", handleInitialError);
      };
      const handleInitialError = (error) => {
        cleanup();
        this.connectPromise = null;
        reject(error);
      };
      const handleConnect = () => {
        cleanup();
        this.socket = socket;
        this.connected = true;
        this.readline = readline.createInterface({ input: socket });
        this.readline.on("line", (line) => this._handleLine(line));
        socket.on("close", () => this._handleDisconnect(new Error("pipe_closed")));
        socket.on("error", (error) => this._handleDisconnect(error));
        this.connectPromise = null;
        Promise.allSettled(
          Array.from(this.onConnectHandlers).map((handler) => handler()),
        ).finally(resolve);
      };
      socket.once("connect", handleConnect);
      socket.once("error", handleInitialError);
    });
    return this.connectPromise;
  }

  async request(method, params = {}) {
    await this.ensureConnected();
    const id = this.nextId++;
    const payload = { jsonrpc: "2.0", id, method, params };
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      try {
        this.socket.write(`${JSON.stringify(payload)}\n`);
      } catch (error) {
        this.pending.delete(id);
        reject(error);
      }
    });
  }

  close() {
    this._handleDisconnect(new Error("pipe_closed_by_client"));
  }

  _handleLine(line) {
    if (!line.trim()) {
      return;
    }
    let message = null;
    try {
      message = JSON.parse(line);
    } catch {
      return;
    }
    if (message.id != null) {
      const pending = this.pending.get(message.id);
      if (!pending) {
        return;
      }
      this.pending.delete(message.id);
      if (message.error) {
        pending.reject(new Error(message.error.message));
      } else {
        pending.resolve(message.result);
      }
      return;
    }
    const handler = this.notificationHandlers.get(message.method);
    if (handler instanceof Function) {
      handler(message.params);
    }
  }

  _handleDisconnect(error) {
    if (!this.connected && this.socket == null && this.readline == null) {
      return;
    }
    this.connected = false;
    const pendingError = error instanceof Error ? error : new Error(String(error));
    for (const pending of this.pending.values()) {
      pending.reject(pendingError);
    }
    this.pending.clear();
    try {
      this.readline?.close();
    } catch {
      // Ignore cleanup errors.
    }
    try {
      this.socket?.destroy();
    } catch {
      // Ignore cleanup errors.
    }
    this.readline = null;
    this.socket = null;
    this.connectPromise = null;
  }
}

class FeishuBridgeSidecar {
  constructor({ config, pipeClient, store, paths, logFilePath }) {
    this.config = config;
    this.pipeClient = pipeClient;
    this.store = store;
    this.paths = paths;
    this.logFilePath = logFilePath;
    this.allowlist = normalizeAllowlist(config?.allowlistOpenIds);
    this.defaultOpenId = String(config?.defaultOpenId ?? "").trim() || null;
    this.client = null;
    this.wsClient = null;
    this.wsStarted = false;
    this.turnSubscriptionActive = false;
    this.diagnosticsServer = null;
    this.healthTimer = null;
    this.queueTimer = null;
    this.keepAliveTimer = null;
    this.assistantCardPlaybackTimers = new Map();
    this.assistantCardSyncLocks = new Map();
    this.deliveryLocks = new Set();
    this.deliveryDrainPromise = Promise.resolve();
    this.queueDrainPromise = Promise.resolve();
    this.tenantAccessTokenState = null;
    this.state = {
      status: "offline",
      startedAt: nowIso(),
      lastError: null,
      pipeConnected: false,
      bridgeStatus: "unknown",
      activeThreadId: null,
      credentialsValid: false,
      wsStarted: false,
      lastEventAt: null,
      lastInboundAt: null,
      lastOutboundAt: null,
      lastTokenCheckAt: null,
      pendingLocalCommitCount: 0,
      pendingFeishuDeliveryCount: 0,
      allowlistCount: this.allowlist.size,
      defaultOpenIdPresent: this.defaultOpenId != null,
      userIdentitySendEnabled: Boolean(config?.userIdentitySend?.enabled),
      userIdentitySendReady: false,
      userIdentitySendOpenId: null,
      userIdentitySendAuthUrl: null,
      textChunkingPolicy: buildFeishuTextChunkingPolicy(),
      diagnosticsHttp: {
        enabled: Boolean(
          config?.diagnosticsHttp?.enabled || config?.userIdentitySend?.enabled,
        ),
        listening: false,
        host:
          config?.diagnosticsHttp?.host ??
          config?.userIdentitySend?.authHost ??
          "127.0.0.1",
        port: Number(
          config?.diagnosticsHttp?.port ??
            config?.userIdentitySend?.authPort ??
            47631,
        ),
      },
      wsReconnectInfo: null,
      updatedAt: nowIso(),
    };
  }

  _getUserIdentitySettings() {
    const config = this.config?.userIdentitySend ?? {};
    return {
      enabled: Boolean(config.enabled),
      authHost: String(config.authHost ?? "127.0.0.1").trim() || "127.0.0.1",
      authPort: Number(config.authPort ?? this.config?.diagnosticsHttp?.port ?? 47631),
      startPath: String(config.startPath ?? "/oauth/start").trim() || "/oauth/start",
      callbackPath:
        String(config.callbackPath ?? "/oauth/callback").trim() || "/oauth/callback",
      statusPath: String(config.statusPath ?? "/oauth/status").trim() || "/oauth/status",
      prompt: String(config.prompt ?? "consent").trim() || "consent",
      scope:
        String(
          config.scope ?? DEFAULT_USER_IDENTITY_SCOPE,
        ).trim() || DEFAULT_USER_IDENTITY_SCOPE,
    };
  }

  _buildUserIdentityRedirectUri() {
    const settings = this._getUserIdentitySettings();
    return `http://${settings.authHost}:${settings.authPort}${settings.callbackPath}`;
  }

  _buildUserIdentityAuthorizationUrl(openId = null) {
    const settings = this._getUserIdentitySettings();
    const targetOpenId = String(openId ?? this.defaultOpenId ?? "").trim();
    const url = new URL(`http://${settings.authHost}:${settings.authPort}${settings.startPath}`);
    if (targetOpenId) {
      url.searchParams.set("open_id", targetOpenId);
    }
    return url.toString();
  }

  _getStoredUserSendToken(openId) {
    const normalized = String(openId ?? "").trim();
    if (!normalized) {
      return null;
    }
    return this.store.getRuntimeState(buildUserSendTokenKey(normalized));
  }

  _setStoredUserSendToken(openId, tokenState) {
    const normalized = String(openId ?? "").trim();
    if (!normalized) {
      return;
    }
    this.store.setRuntimeState(buildUserSendTokenKey(normalized), tokenState);
  }

  async _getTenantAccessToken() {
    const cached = this.tenantAccessTokenState;
    if (cached?.accessToken && Number(cached.expiresAtMs ?? 0) > Date.now() + 60 * 1000) {
      return cached.accessToken;
    }
    if (!this.client) {
      throw new Error("feishu_client_unavailable");
    }
    const response = await this.client.auth.v3.tenantAccessToken.internal({
      data: {
        app_id: this.config.appId,
        app_secret: this.config.appSecret,
      },
    });
    if (response?.code != null && Number(response.code) !== 0) {
      throw new Error(`tenant_access_token_failed:${response.code}:${response.msg ?? ""}`);
    }
    const accessToken =
      String(
        response?.tenant_access_token ??
          response?.data?.tenant_access_token ??
          "",
      ).trim() || null;
    if (!accessToken) {
      throw new Error("tenant_access_token_missing");
    }
    const expireSeconds = Math.max(
      300,
      Number(response?.expire ?? response?.data?.expire ?? 7200) || 7200,
    );
    this.tenantAccessTokenState = {
      accessToken,
      expiresAtMs: Date.now() + expireSeconds * 1000,
    };
    return accessToken;
  }

  _getAssistantCardSettings() {
    const config = this.config?.assistantCard ?? {};
    const requestedBackend = String(
      config.streamingBackend ?? ASSISTANT_CARD_STREAMING_BACKEND_PATCH,
    )
      .trim()
      .toLowerCase();
    const streamingBackend =
      requestedBackend === ASSISTANT_CARD_STREAMING_BACKEND_CARDKIT
        ? ASSISTANT_CARD_STREAMING_BACKEND_CARDKIT
        : ASSISTANT_CARD_STREAMING_BACKEND_PATCH;
    return {
      streamingBackend,
      patchPlaybackTickMs: clampInteger(
        config.patchPlaybackTickMs,
        100,
        5000,
        ASSISTANT_CARD_PLAYBACK_TICK_MS,
      ),
      cardkit: normalizeAssistantCardKitSettings(config.cardkit ?? {}),
    };
  }

  _getAssistantCardPlaybackTickMs() {
    return this._getAssistantCardSettings().patchPlaybackTickMs;
  }

  _getAssistantCardPlaybackBurstCount(session) {
    const settings = this._getAssistantCardSettings();
    const usesCardKit =
      Boolean(session?.state_json?.cardkit?.cardId) ||
      (String(session?.send_identity ?? "bot").trim() === "bot" &&
        settings.streamingBackend === ASSISTANT_CARD_STREAMING_BACKEND_CARDKIT &&
        settings.cardkit.enabled);
    if (!usesCardKit) {
      return 1;
    }
    const tickMs = settings.patchPlaybackTickMs;
    const printFrequencyMs = Math.max(
      1,
      Number(settings.cardkit.printFrequencyMs) ||
        ASSISTANT_CARD_CARDKIT_DEFAULT_PRINT_FREQUENCY_MS,
    );
    const printStep = Math.max(
      1,
      Number(settings.cardkit.printStep) || ASSISTANT_CARD_CARDKIT_DEFAULT_PRINT_STEP,
    );
    return clampInteger(
      Math.ceil(tickMs / printFrequencyMs) * printStep,
      1,
      120,
      1,
    );
  }

  _isAssistantCardKitStreamingEnabled() {
    const settings = this._getAssistantCardSettings();
    return (
      settings.streamingBackend === ASSISTANT_CARD_STREAMING_BACKEND_CARDKIT &&
      settings.cardkit.enabled
    );
  }

  _getAssistantCardKitClient() {
    const card = this.client?.cardkit?.v1?.card;
    const cardElement = this.client?.cardkit?.v1?.cardElement;
    if (!card || !cardElement) {
      throw new Error("feishu_cardkit_client_unavailable");
    }
    return {
      card,
      cardElement,
    };
  }

  async _probeAssistantCardKitStreamingCapability({ remote = false } = {}) {
    const settings = this._getAssistantCardSettings();
    const sdkAvailable = Boolean(
      this.client?.cardkit?.v1?.card?.create &&
        this.client?.cardkit?.v1?.card?.settings &&
        this.client?.cardkit?.v1?.card?.update &&
        this.client?.cardkit?.v1?.cardElement?.content,
    );
    const result = {
      ok: false,
      enabled: this._isAssistantCardKitStreamingEnabled(),
      streamingBackend: settings.streamingBackend,
      sdkAvailable,
      remoteChecked: Boolean(remote),
      tokenReady: false,
      cardkit: settings.cardkit,
    };
    if (!result.enabled || !sdkAvailable) {
      return result;
    }
    if (!remote) {
      return {
        ...result,
        ok: true,
      };
    }
    await this._getTenantAccessToken();
    return {
      ...result,
      ok: true,
      tokenReady: true,
    };
  }

  async _createAssistantCardKitCardEntity({ card } = {}) {
    const { card: cardClient } = this._getAssistantCardKitClient();
    const response = await cardClient.create({
      data: {
        type: "card_json",
        data: JSON.stringify(card ?? {}),
      },
    });
    assertFeishuSdkSuccess("feishu_cardkit_card_create_failed", response);
    const cardId = extractAssistantCardKitCardId(response);
    if (!cardId) {
      throw new Error("feishu_cardkit_card_id_missing");
    }
    return {
      cardId,
      response,
    };
  }

  async _sendAssistantCardKitCardMessage({
    openId,
    chatId = null,
    cardId,
    uuid = null,
  } = {}) {
    return this.sendPrivateMessage(openId, {
      chatId,
      msgType: "interactive",
      content: buildAssistantCardKitMessageContent(cardId),
      uuid,
    });
  }

  async _setAssistantCardKitStreamingMode({
    cardId,
    streamingMode = true,
    sequence,
    uuid = crypto.randomUUID(),
    cardkit = null,
  } = {}) {
    const { card } = this._getAssistantCardKitClient();
    const settings = normalizeAssistantCardKitSettings({
      enabled: true,
      ...(cardkit ?? this._getAssistantCardSettings().cardkit),
    });
    const response = await card.settings({
      path: {
        card_id: String(cardId ?? "").trim(),
      },
      data: {
        settings: JSON.stringify({
          config: {
            update_multi: true,
            streaming_mode: Boolean(streamingMode),
            streaming_config: {
              print_frequency_ms: {
                default: settings.printFrequencyMs,
                android: settings.printFrequencyMs,
                ios: settings.printFrequencyMs,
                pc: settings.printFrequencyMs,
              },
              print_step: {
                default: settings.printStep,
                android: settings.printStep,
                ios: settings.printStep,
                pc: settings.printStep,
              },
              print_strategy: settings.printStrategy,
            },
          },
        }),
        uuid,
        sequence: normalizeAssistantCardKitSequence(sequence),
      },
    });
    assertFeishuSdkSuccess("feishu_cardkit_settings_failed", response);
    return response;
  }

  async _streamAssistantCardKitElementContent({
    cardId,
    elementId = null,
    content,
    sequence,
    uuid = crypto.randomUUID(),
  } = {}) {
    const { cardElement } = this._getAssistantCardKitClient();
    const settings = this._getAssistantCardSettings();
    const response = await cardElement.content({
      path: {
        card_id: String(cardId ?? "").trim(),
        element_id: normalizeAssistantCardKitElementId(
          elementId ?? settings.cardkit.elementId,
        ),
      },
      data: {
        uuid,
        content: String(content ?? ""),
        sequence: normalizeAssistantCardKitSequence(sequence),
      },
    });
    assertFeishuSdkSuccess("feishu_cardkit_element_content_failed", response);
    return response;
  }

  _persistAssistantCardKitProgress(session, cardkit, baseState = null) {
    if (!session?.session_id || !cardkit?.cardId) {
      return session;
    }
    return this._persistAssistantCardKitSessionState(
      session,
      {
        ...(baseState ?? session.state_json ?? {}),
        cardkit,
      },
      {
        cardMessageId: session.card_message_id ?? cardkit.messageId ?? null,
      },
    );
  }

  async _streamAssistantCardKitElementContentWithRecovery({
    cardkit,
    session = null,
    state = null,
    elementId = null,
    content,
    sequence,
    uuid = crypto.randomUUID(),
  } = {}) {
    let currentCardkit = {
      ...(cardkit ?? {}),
    };
    let currentSession = session;
    let currentSequence = normalizeAssistantCardKitSequence(sequence);
    let attempt = 0;
    while (true) {
      try {
        await this._streamAssistantCardKitElementContent({
          cardId: currentCardkit.cardId,
          elementId,
          content,
          sequence: currentSequence,
          uuid:
            attempt === 0
              ? uuid
              : buildFeishuDeliveryUuid(
                  `assistant-card-cardkit-content-retry:${currentCardkit.cardId}:${elementId}:${currentSequence}:${attempt}`,
                ),
        });
        currentCardkit = {
          ...currentCardkit,
          sequence: currentSequence,
        };
        return {
          cardkit: currentCardkit,
          session: currentSession,
          sequence: currentSequence,
          recovered: attempt > 0,
        };
      } catch (error) {
        if (!isRecoverableAssistantCardKitStreamingError(error)) {
          throw error;
        }
        const cardRecoveryCount = Math.max(
          0,
          Number(currentCardkit.streamingRecoveryCount ?? 0) || 0,
        );
        if (
          attempt >= ASSISTANT_CARD_CARDKIT_STREAM_RECOVERY_MAX_ATTEMPTS ||
          cardRecoveryCount >= ASSISTANT_CARD_CARDKIT_STREAM_RECOVERY_MAX_PER_CARD
        ) {
          throw error;
        }
        attempt += 1;
        const reopenSequence = currentSequence + 1;
        await this._setAssistantCardKitStreamingMode({
          cardId: currentCardkit.cardId,
          streamingMode: true,
          sequence: reopenSequence,
          uuid: buildFeishuDeliveryUuid(
            `assistant-card-cardkit-reopen:${currentCardkit.cardId}:${elementId}:${reopenSequence}:${attempt}`,
          ),
          cardkit: currentCardkit,
        });
        currentCardkit = {
          ...currentCardkit,
          sequence: reopenSequence,
          streamingRecoveryCount: cardRecoveryCount + 1,
          lastStreamingRecoveryAt: nowIso(),
          lastStreamingRecoveryReason: safeErrorMessage(error),
        };
        currentSession =
          this._persistAssistantCardKitProgress(currentSession, currentCardkit, state) ??
          currentSession;
        this._log?.("info", "Reopened CardKit streaming mode after recoverable error", {
          cardSessionId: currentSession?.session_id ?? null,
          cardTurnId: currentSession?.local_turn_id ?? null,
          cardId: currentCardkit.cardId,
          elementId,
          sequence: reopenSequence,
          attempt,
          recoveryCount: currentCardkit.streamingRecoveryCount,
          reason: safeErrorMessage(error),
        });
        currentSequence = reopenSequence + 1;
      }
    }
  }

  async _updateAssistantCardKitCardEntity({
    cardId,
    card,
    sequence,
    uuid = crypto.randomUUID(),
  } = {}) {
    const { card: cardClient } = this._getAssistantCardKitClient();
    const response = await cardClient.update({
      path: {
        card_id: String(cardId ?? "").trim(),
      },
      data: {
        card: {
          type: "card_json",
          data: JSON.stringify(card ?? {}),
        },
        uuid,
        sequence: normalizeAssistantCardKitSequence(sequence),
      },
    });
    assertFeishuSdkSuccess("feishu_cardkit_card_update_failed", response);
    return response;
  }

  _hasAssistantCardKitSdk() {
    return Boolean(
      this.client?.cardkit?.v1?.card?.create &&
        this.client?.cardkit?.v1?.card?.settings &&
        this.client?.cardkit?.v1?.card?.update &&
        this.client?.cardkit?.v1?.cardElement?.content,
    );
  }

  _shouldUseAssistantCardKitForSession(session) {
    if (session?.state_json?.cardkit?.cardId) {
      return true;
    }
    return (
      String(session?.send_identity ?? "bot").trim() === "bot" &&
      this._isAssistantCardKitStreamingEnabled() &&
      this._hasAssistantCardKitSdk()
    );
  }

  _persistAssistantCardKitSessionState(session, nextState, { cardMessageId = null } = {}) {
    const liveSession = this.store.getFeishuCardSessionById?.(session.session_id);
    const liveState = liveSession?.state_json;
    const state =
      liveState != null &&
      Number(liveSession?.last_revision ?? 0) > Number(session?.last_revision ?? 0)
        ? {
            ...nextState,
            sectionStreams: mergeAssistantCardSectionStreams(
              nextState?.sectionStreams,
              liveState.sectionStreams,
            ),
            items: liveState.items ?? nextState?.items,
            toolSummary: liveState.toolSummary ?? nextState?.toolSummary,
            sectionMode: liveState.sectionMode ?? nextState?.sectionMode,
            sourceCompletedAt: liveState.sourceCompletedAt ?? nextState?.sourceCompletedAt,
            completedAt: liveState.completedAt ?? nextState?.completedAt,
            presentationCompletedAt:
              liveState.presentationCompletedAt ?? nextState?.presentationCompletedAt,
            finalItemKey: liveState.finalItemKey ?? nextState?.finalItemKey,
            presentation: liveState.presentation ?? nextState?.presentation,
          }
        : nextState;
    return this.store.upsertFeishuCardSession({
      sessionId: session.session_id,
      bindingId: session.binding_id,
      localThreadId: session.local_thread_id,
      localTurnId: session.local_turn_id,
      sendIdentity: session.send_identity,
      feishuOpenId: session.feishu_open_id,
      feishuChatId: session.feishu_chat_id,
      cardMessageId: cardMessageId ?? session.card_message_id ?? null,
      mode: session.mode ?? "card",
      status: session.status ?? "processing",
      lastRevision: session.last_revision,
      lastAppliedRevision: session.last_applied_revision,
      lastRenderHash: session.last_render_hash ?? null,
      degradedReason: session.degraded_reason ?? null,
      state,
    });
  }

  _nextAssistantCardKitSequence(cardkitState) {
    return Math.max(0, Number(cardkitState?.sequence ?? 0) || 0) + 1;
  }

  _getAssistantCardKitLatestStreamingActivityAt(cardkitState) {
    const timestamps = [
      cardkitState?.lastStreamedAt,
      cardkitState?.footerUpdatedAt,
      cardkitState?.lastStreamingRecoveryAt,
      cardkitState?.lastStreamingPreopenAt,
      cardkitState?.sentAt,
      cardkitState?.createdAt,
    ]
      .map((value) => normalizeAssistantCardTimestamp(value))
      .filter(Boolean);
    if (timestamps.length === 0) {
      return null;
    }
    return timestamps.reduce((latest, candidate) =>
      new Date(candidate).getTime() > new Date(latest).getTime() ? candidate : latest,
    );
  }

  _getAssistantCardKitStreamingActivityAgeMs(cardkitState) {
    const latestAt = this._getAssistantCardKitLatestStreamingActivityAt(cardkitState);
    if (!latestAt) {
      return null;
    }
    const ageMs = Date.now() - new Date(latestAt).getTime();
    if (!Number.isFinite(ageMs)) {
      return null;
    }
    return Math.max(0, ageMs);
  }

  async _preopenAssistantCardKitStreamingModeIfStale({
    cardkit,
    session = null,
    state = null,
    elementId = null,
    sequence,
    staleMs = ASSISTANT_CARD_CARDKIT_STREAM_PREOPEN_STALE_MS,
    reason = "stale_streaming_before_content",
  } = {}) {
    if (!cardkit?.cardId) {
      return {
        cardkit,
        session,
        sequence: normalizeAssistantCardKitSequence(sequence),
        preopened: false,
      };
    }
    const currentSequence = normalizeAssistantCardKitSequence(sequence);
    const preopenCount = Math.max(
      0,
      Number(cardkit?.streamingPreopenCount ?? 0) || 0,
    );
    const ageMs = this._getAssistantCardKitStreamingActivityAgeMs(cardkit);
    if (
      ageMs == null ||
      ageMs < staleMs ||
      preopenCount >= ASSISTANT_CARD_CARDKIT_STREAM_PREOPEN_MAX_PER_CARD
    ) {
      return {
        cardkit,
        session,
        sequence: currentSequence,
        preopened: false,
      };
    }
    try {
      await this._setAssistantCardKitStreamingMode({
        cardId: cardkit.cardId,
        streamingMode: true,
        sequence: currentSequence,
        uuid: buildFeishuDeliveryUuid(
          `assistant-card-cardkit-preopen:${session?.session_id ?? cardkit.cardId}:${elementId ?? "element"}:${currentSequence}`,
        ),
        cardkit,
      });
    } catch (error) {
      this._log?.("warn", "Skipped CardKit stale streaming preopen after failure", {
        cardSessionId: session?.session_id ?? null,
        cardTurnId: session?.local_turn_id ?? null,
        cardId: cardkit.cardId,
        elementId,
        sequence: currentSequence,
        ageMs,
        reason: safeErrorMessage(error),
      });
      return {
        cardkit,
        session,
        sequence: currentSequence,
        preopened: false,
        preopenError: safeErrorMessage(error),
      };
    }
    const nextCardkit = {
      ...cardkit,
      sequence: currentSequence,
      streamingPreopenCount: preopenCount + 1,
      lastStreamingPreopenAt: nowIso(),
      lastStreamingPreopenReason: reason,
      lastStreamingPreopenAgeMs: ageMs,
    };
    const nextSession =
      this._persistAssistantCardKitProgress(session, nextCardkit, state) ?? session;
    this._log?.("info", "Preopened CardKit streaming mode before stale content update", {
      cardSessionId: nextSession?.session_id ?? null,
      cardTurnId: nextSession?.local_turn_id ?? null,
      cardId: nextCardkit.cardId,
      elementId,
      sequence: currentSequence,
      ageMs,
      preopenCount: nextCardkit.streamingPreopenCount,
    });
    return {
      cardkit: nextCardkit,
      session: nextSession,
      sequence: currentSequence + 1,
      preopened: true,
    };
  }

  _buildAssistantCardKitStreamingCardForState({
    session,
    cardkit,
    statusLabel = "\u5904\u7406\u4e2d",
    durationLabel = "0\u520600\u79d2",
  } = {}) {
    const settings = this._getAssistantCardSettings();
    const elementIds =
      cardkit?.elementIds != null && typeof cardkit.elementIds === "object"
        ? {
            ...getAssistantCardKitAssistantElementIds(settings.cardkit),
            ...cardkit.elementIds,
          }
        : getAssistantCardKitAssistantElementIds(settings.cardkit);
    const streamedContentByElementId =
      cardkit?.streamedContentByElementId != null &&
      typeof cardkit.streamedContentByElementId === "object"
        ? cardkit.streamedContentByElementId
        : {};
    const fallbackContents = buildAssistantCardKitAssistantElementContents({});
    return buildAssistantCardKitAssistantStreamingCard({
      localThreadId: session?.local_thread_id ?? null,
      cardkit: {
        ...settings.cardkit,
        progressElementId: elementIds.progress,
        toolElementId: elementIds.tool,
        finalElementId: elementIds.final,
        footerElementId: elementIds.footer,
      },
      elementContents: {
        progress: String(streamedContentByElementId[elementIds.progress] ?? fallbackContents.progress),
        tool: String(streamedContentByElementId[elementIds.tool] ?? fallbackContents.tool),
        final: String(streamedContentByElementId[elementIds.final] ?? fallbackContents.final),
      },
      footerStatus: statusLabel,
      durationLabel,
    });
  }

  _shouldSendAssistantCardKitFinalFirst(session, renderPlan) {
    return false;
  }

  async _sendAssistantCardKitFinalFirstCardMessage(session, renderPlan, nextState) {
    let currentSession = session;
    let state = {
      ...(nextState ?? {}),
    };
    const settings = this._getAssistantCardSettings();
    const elementIds =
      state?.cardkit?.elementIds != null && typeof state.cardkit.elementIds === "object"
        ? {
            ...getAssistantCardKitAssistantElementIds(settings.cardkit),
            ...state.cardkit.elementIds,
          }
        : getAssistantCardKitAssistantElementIds(settings.cardkit);
    const cardkitEnsureStartedAt = nowIso();
    const cardkitCreateStartedAt = cardkitEnsureStartedAt;
    state = mergeAssistantCardOutboundTelemetry(state, {
      cardkitEnsureStartedAt,
      cardkitCreateStartedAt,
    });
    let created;
    try {
      created = await this._createAssistantCardKitCardEntity({
        card: renderPlan.card,
      });
    } catch (error) {
      error.assistantCardKitFinalFirstStage = "create";
      throw error;
    }
    const cardkitCreateFinishedAt = nowIso();
    let cardkitState = {
      ...(state.cardkit != null && typeof state.cardkit === "object"
        ? state.cardkit
        : {}),
      backend: ASSISTANT_CARD_STREAMING_BACKEND_CARDKIT,
      cardId: created.cardId,
      sequence: Math.max(1, Number(state?.cardkit?.sequence ?? 0) || 0),
      elementIds,
      createdAt: state?.cardkit?.createdAt ?? nowIso(),
    };
    state = mergeAssistantCardOutboundTelemetry(
      {
        ...state,
        cardkit: cardkitState,
      },
      {
        cardkitCreateFinishedAt,
      },
    );
    currentSession = this._persistAssistantCardKitSessionState(currentSession, state);

    const cardkitMessageSendStartedAt = nowIso();
    const response = await this._sendAssistantCardKitCardMessage({
      openId: currentSession.feishu_open_id,
      chatId: currentSession.feishu_chat_id ?? null,
      cardId: cardkitState.cardId,
      uuid: buildFeishuDeliveryUuid(
        `assistant-card-cardkit-final-first:${currentSession.session_id}`,
      ),
    });
    const cardkitMessageSendFinishedAt = nowIso();
    const cardMessageId = extractFeishuMessageId(response);
    const completedFooterKey = buildAssistantCardFooterKey({
      status: renderPlan?.statusLabel ?? "\u5df2\u5b8c\u6210",
      durationLabel: renderPlan?.durationLabel ?? "0\u520600\u79d2",
    });
    cardkitState = {
      ...cardkitState,
      ...(cardMessageId ? { messageId: cardMessageId } : {}),
      sentAt: cardkitState.sentAt ?? cardkitMessageSendFinishedAt,
      footerKey: completedFooterKey,
      finalizedAt: cardkitState.finalizedAt ?? cardkitMessageSendFinishedAt,
      finalFirstSentAt: cardkitMessageSendFinishedAt,
    };
    state = mergeAssistantCardOutboundTelemetry(
      {
        ...state,
        cardkit: cardkitState,
      },
      {
        cardkitMessageSendStartedAt,
        cardkitMessageSendFinishedAt,
        cardkitEnsureFinishedAt: cardkitMessageSendFinishedAt,
      },
    );
    currentSession = this._persistAssistantCardKitSessionState(currentSession, state, {
      cardMessageId,
    });
    return {
      session: currentSession,
      state,
      cardMessageId,
      cardkit: cardkitState,
      renderMode: "cardkit_final_first",
    };
  }

  async _refreshAssistantCardKitFooter({
    session,
    state = null,
    cardkit,
    statusLabel = "\u5904\u7406\u4e2d",
    durationLabel = "0\u520600\u79d2",
  } = {}) {
    if (!cardkit?.cardId) {
      return {
        cardkit,
        updated: false,
      };
    }
    const footerKey = buildAssistantCardFooterKey({
      status: statusLabel,
      durationLabel,
    });
    if (String(cardkit?.footerKey ?? "") === footerKey) {
      return {
        cardkit,
        updated: false,
      };
    }
    const elementIds =
      cardkit?.elementIds != null && typeof cardkit.elementIds === "object"
        ? {
            ...getAssistantCardKitAssistantElementIds(this._getAssistantCardSettings().cardkit),
            ...cardkit.elementIds,
          }
        : getAssistantCardKitAssistantElementIds(this._getAssistantCardSettings().cardkit);
    let currentSession = session;
    let currentCardkit = cardkit;
    let sequence = this._nextAssistantCardKitSequence(currentCardkit);
    const preopenResult = await this._preopenAssistantCardKitStreamingModeIfStale({
      cardkit: currentCardkit,
      session: currentSession,
      state,
      elementId: elementIds.footer,
      sequence,
      reason: "stale_footer_content",
    });
    currentCardkit = preopenResult.cardkit;
    currentSession = preopenResult.session ?? currentSession;
    sequence = preopenResult.sequence;
    const contentResult = await this._streamAssistantCardKitElementContentWithRecovery({
      cardkit: currentCardkit,
      session: currentSession,
      state,
      elementId: elementIds.footer,
      content: buildAssistantCardFooterContent({
        status: statusLabel,
        durationLabel,
      }),
      sequence,
      uuid: buildFeishuDeliveryUuid(
        `assistant-card-cardkit-footer:${session?.session_id ?? cardkit.cardId}:${sequence}`,
      ),
    });
    return {
      cardkit: {
        ...contentResult.cardkit,
        footerKey,
        footerUpdatedAt: nowIso(),
      },
      session: contentResult.session ?? currentSession,
      updated: true,
      preopened: Boolean(preopenResult.preopened),
    };
  }

  async _ensureAssistantCardKitCardMessage(session, nextState) {
    const settings = this._getAssistantCardSettings();
    let currentSession = session;
    let state = {
      ...(nextState ?? {}),
    };
    const cardkitEnsureStartedAt = nowIso();
    state = mergeAssistantCardOutboundTelemetry(state, {
      cardkitEnsureStartedAt,
    });
    let cardkitState =
      state.cardkit != null && typeof state.cardkit === "object"
        ? { ...state.cardkit }
        : {};
    const elementIds =
      cardkitState.elementIds != null && typeof cardkitState.elementIds === "object"
        ? {
          ...getAssistantCardKitAssistantElementIds(settings.cardkit),
          ...cardkitState.elementIds,
        }
        : getAssistantCardKitAssistantElementIds(settings.cardkit);
    if (!cardkitState.cardId) {
      const initialContents = buildAssistantCardKitAssistantElementContents({});
      const initialFooterKey = buildAssistantCardFooterKey({
        status: "\u5904\u7406\u4e2d",
        durationLabel: "0\u520600\u79d2",
      });
      const streamedContentByElementId = {
        [elementIds.progress]: initialContents.progress,
        [elementIds.tool]: initialContents.tool,
        [elementIds.final]: initialContents.final,
      };
      const card = buildAssistantCardKitAssistantStreamingCard({
        localThreadId: currentSession.local_thread_id,
        cardkit: settings.cardkit,
      });
      const cardkitCreateStartedAt = nowIso();
      const created = await this._createAssistantCardKitCardEntity({ card });
      const cardkitCreateFinishedAt = nowIso();
      state = mergeAssistantCardOutboundTelemetry(state, {
        cardkitCreateStartedAt,
        cardkitCreateFinishedAt,
      });
      const sequence = this._nextAssistantCardKitSequence(cardkitState);
      const cardkitSettingsStartedAt = nowIso();
      await this._setAssistantCardKitStreamingMode({
        cardId: created.cardId,
        sequence,
        uuid: buildFeishuDeliveryUuid(
          `assistant-card-cardkit-settings:${currentSession.session_id}:${sequence}`,
        ),
        cardkit: settings.cardkit,
      });
      const cardkitSettingsFinishedAt = nowIso();
      state = mergeAssistantCardOutboundTelemetry(state, {
        cardkitSettingsStartedAt,
        cardkitSettingsFinishedAt,
      });
      cardkitState = {
        ...cardkitState,
        backend: ASSISTANT_CARD_STREAMING_BACKEND_CARDKIT,
        cardId: created.cardId,
        sequence,
        elementIds,
        streamedContentByElementId,
        footerKey: cardkitState.footerKey ?? initialFooterKey,
        footerUpdatedAt: cardkitState.footerUpdatedAt ?? nowIso(),
        createdAt: cardkitState.createdAt ?? nowIso(),
      };
      state = {
        ...state,
        cardkit: cardkitState,
      };
      currentSession = this._persistAssistantCardKitSessionState(currentSession, state);
    }

    let cardMessageId = currentSession.card_message_id ?? null;
    if (!cardMessageId) {
      const cardkitMessageSendStartedAt = nowIso();
      const response = await this._sendAssistantCardKitCardMessage({
        openId: currentSession.feishu_open_id,
        chatId: currentSession.feishu_chat_id ?? null,
        cardId: cardkitState.cardId,
        uuid: buildFeishuDeliveryUuid(
          `assistant-card-cardkit:${currentSession.session_id}`,
        ),
      });
      const cardkitMessageSendFinishedAt = nowIso();
      state = mergeAssistantCardOutboundTelemetry(state, {
        cardkitMessageSendStartedAt,
        cardkitMessageSendFinishedAt,
      });
      cardMessageId = extractFeishuMessageId(response);
      if (cardMessageId) {
        cardkitState = {
          ...cardkitState,
          messageId: cardMessageId,
          sentAt: cardkitState.sentAt ?? nowIso(),
        };
        state = {
          ...state,
          cardkit: cardkitState,
        };
        currentSession = this._persistAssistantCardKitSessionState(currentSession, state, {
          cardMessageId,
        });
      }
    }

    state = mergeAssistantCardOutboundTelemetry(state, {
      cardkitEnsureStartedAt,
      cardkitEnsureFinishedAt: nowIso(),
    });
    return {
      session: currentSession,
      state,
      cardMessageId,
      cardkit: cardkitState,
    };
  }

  async _rebaseAssistantCardKitFinalFirstToStreaming({
    session,
    state = null,
    cardkit,
    sections,
    statusLabel = "\u5904\u7406\u4e2d",
    durationLabel = "0\u520600\u79d2",
  } = {}) {
    if (!cardkit?.cardId || !cardkit?.finalFirstSentAt) {
      return {
        session,
        state,
        cardkit,
        rebased: false,
      };
    }
    const settings = this._getAssistantCardSettings();
    const elementIds =
      cardkit.elementIds != null && typeof cardkit.elementIds === "object"
        ? {
            ...getAssistantCardKitAssistantElementIds(settings.cardkit),
            ...cardkit.elementIds,
          }
        : getAssistantCardKitAssistantElementIds(settings.cardkit);
    const targetContents = buildAssistantCardKitAssistantElementContents(sections ?? {});
    const streamedContentByElementId = {
      ...(cardkit.streamedContentByElementId != null &&
      typeof cardkit.streamedContentByElementId === "object"
        ? cardkit.streamedContentByElementId
        : {}),
      [elementIds.progress]: targetContents.progress,
      [elementIds.tool]: targetContents.tool,
      [elementIds.final]: targetContents.final,
    };
    let sequence = this._nextAssistantCardKitSequence(cardkit);
    await this._setAssistantCardKitStreamingMode({
      cardId: cardkit.cardId,
      streamingMode: true,
      sequence,
      uuid: buildFeishuDeliveryUuid(
        `assistant-card-cardkit-final-first-rebase-settings:${session?.session_id ?? cardkit.cardId}:${sequence}`,
      ),
      cardkit: settings.cardkit,
    });
    sequence += 1;
    const nextCardkit = {
      ...cardkit,
      backend: ASSISTANT_CARD_STREAMING_BACKEND_CARDKIT,
      sequence,
      elementIds,
      streamedContentByElementId,
      finalFirstSentAt: null,
      finalFirstRebasedAt: nowIso(),
    };
    await this._updateAssistantCardKitCardEntity({
      cardId: cardkit.cardId,
      card: this._buildAssistantCardKitStreamingCardForState({
        session,
        cardkit: nextCardkit,
        statusLabel,
        durationLabel,
      }),
      sequence,
      uuid: buildFeishuDeliveryUuid(
        `assistant-card-cardkit-final-first-rebase:${session?.session_id ?? cardkit.cardId}:${sequence}`,
      ),
    });
    return {
      session,
      state: {
        ...(state ?? {}),
        cardkit: nextCardkit,
      },
      cardkit: nextCardkit,
      rebased: true,
    };
  }

  async _streamAssistantCardKitSections({
    cardkit,
    sections,
    session = null,
    state = null,
    statusLabel = "\u5904\u7406\u4e2d",
    durationLabel = "0\u520600\u79d2",
  } = {}) {
    const elementIds =
      cardkit?.elementIds != null && typeof cardkit.elementIds === "object"
        ? cardkit.elementIds
        : getAssistantCardKitAssistantElementIds(this._getAssistantCardSettings().cardkit);
    const targetBySlot = buildAssistantCardKitAssistantElementContents(sections ?? {});
    const previousByElement =
      cardkit?.streamedContentByElementId != null &&
      typeof cardkit.streamedContentByElementId === "object"
        ? { ...cardkit.streamedContentByElementId }
        : {};
    const nextStreamedContentByElementId = { ...previousByElement };
    let sequence = Math.max(0, Number(cardkit?.sequence ?? 0) || 0);
    let streamed = 0;
    for (const slot of ["progress", "tool", "final"]) {
      const elementId = normalizeAssistantCardKitElementId(elementIds[slot]);
      const targetContent = String(targetBySlot[slot] ?? "");
      const previousContent = String(previousByElement[elementId] ?? "");
      if (targetContent === previousContent) {
        continue;
      }
      const shouldResetListElement =
        (slot === "progress" || slot === "tool") &&
        previousContent === ASSISTANT_CARD_CARDKIT_STREAM_PREFIX &&
        targetContent.startsWith(ASSISTANT_CARD_CARDKIT_LIST_STREAM_PREFIX);
      if (shouldResetListElement) {
        const resetContent = "";
        sequence += 1;
        nextStreamedContentByElementId[elementId] = resetContent;
        await this._updateAssistantCardKitCardEntity({
          cardId: cardkit.cardId,
          card: this._buildAssistantCardKitStreamingCardForState({
            session,
            cardkit: {
              ...cardkit,
              sequence,
              streamedContentByElementId: nextStreamedContentByElementId,
            },
            statusLabel,
            durationLabel,
          }),
          sequence,
          uuid: buildFeishuDeliveryUuid(
            `assistant-card-cardkit-list-reset:${cardkit.cardId}:${elementId}:${sequence}`,
          ),
        });
        streamed += 1;
        sequence += 1;
        const contentResult = await this._streamAssistantCardKitElementContentWithRecovery({
          cardkit: {
            ...cardkit,
            sequence: sequence - 1,
            streamedContentByElementId: nextStreamedContentByElementId,
          },
          session,
          state,
          elementId,
          content: targetContent,
          sequence,
          uuid: buildFeishuDeliveryUuid(
            `assistant-card-cardkit-content:${cardkit.cardId}:${elementId}:${sequence}`,
          ),
        });
        sequence = contentResult.sequence;
        cardkit = contentResult.cardkit;
        session = contentResult.session ?? session;
        nextStreamedContentByElementId[elementId] = targetContent;
        streamed += 1;
        continue;
      }
      if (previousContent && !targetContent.startsWith(previousContent)) {
        this._log?.("warn", "Skipped non-prefix CardKit streaming update", {
          elementId,
          slot,
          previousLength: previousContent.length,
          targetLength: targetContent.length,
        });
        continue;
      }
      sequence += 1;
      const contentResult = await this._streamAssistantCardKitElementContentWithRecovery({
        cardkit: {
          ...cardkit,
          sequence: sequence - 1,
          streamedContentByElementId: nextStreamedContentByElementId,
        },
        session,
        state,
        elementId,
        content: targetContent,
        sequence,
        uuid: buildFeishuDeliveryUuid(
          `assistant-card-cardkit-content:${cardkit.cardId}:${elementId}:${sequence}`,
        ),
      });
      sequence = contentResult.sequence;
      cardkit = contentResult.cardkit;
      session = contentResult.session ?? session;
      nextStreamedContentByElementId[elementId] = targetContent;
      streamed += 1;
    }
    return {
      cardkit: {
        ...cardkit,
        sequence,
        streamedContentByElementId: nextStreamedContentByElementId,
        lastStreamedAt: streamed > 0 ? nowIso() : cardkit?.lastStreamedAt ?? null,
      },
      streamed,
    };
  }

  async _syncAssistantCardKitRenderPlan(session, renderPlan, nextState) {
    if (this._shouldSendAssistantCardKitFinalFirst(session, renderPlan)) {
      try {
        return await this._sendAssistantCardKitFinalFirstCardMessage(
          session,
          renderPlan,
          nextState,
        );
      } catch (error) {
        if (error?.assistantCardKitFinalFirstStage !== "create") {
          throw error;
        }
        this._log?.("warn", "Falling back after CardKit final-first create failed", {
          cardSessionId: session?.session_id ?? null,
          cardTurnId: session?.local_turn_id ?? null,
          reason: safeErrorMessage(error),
        });
      }
    }
    let ensured = await this._ensureAssistantCardKitCardMessage(session, nextState);
    let cardkitState = ensured.cardkit;
    let state = {
      ...(ensured.state ?? nextState ?? {}),
    };
    let currentSession = ensured.session;
    let cardMessageId = ensured.cardMessageId ?? currentSession.card_message_id ?? null;
    const renderHash = String(renderPlan?.renderHash ?? "").trim();
    let renderMode = "cardkit";

    const interrupted = Boolean(
      state?.interruptedAt || currentSession?.status === "interrupted",
    );
    if (interrupted) {
      const interruptedStatusLabel = renderPlan?.statusLabel ?? "\u5df2\u4e2d\u65ad";
      const interruptedDurationLabel = renderPlan?.durationLabel ?? "0\u520600\u79d2";
      const interruptedFooterKey = buildAssistantCardFooterKey({
        status: interruptedStatusLabel,
        durationLabel: interruptedDurationLabel,
      });
      if (
        cardkitState?.interruptedAt &&
        String(cardkitState.footerKey ?? "") === interruptedFooterKey
      ) {
        return {
          session: currentSession,
          state,
          cardMessageId,
          cardkit: cardkitState,
          renderMode: "cardkit_skipped_interrupted",
        };
      }
      const refreshed = await this._refreshAssistantCardKitFooter({
        session: currentSession,
        state,
        cardkit: cardkitState,
        statusLabel: interruptedStatusLabel,
        durationLabel: interruptedDurationLabel,
      });
      currentSession = refreshed.session ?? currentSession;
      cardkitState = {
        ...refreshed.cardkit,
        interruptedAt:
          refreshed.cardkit?.interruptedAt ?? cardkitState.interruptedAt ?? nowIso(),
      };
      renderMode = "cardkit_interrupted_footer";
    } else if (renderPlan?.sections?.presentationCompleted) {
      if (
        cardkitState?.finalizedAt &&
        cardMessageId &&
        renderHash &&
        String(currentSession?.last_render_hash ?? "") === renderHash
      ) {
        return {
          session: currentSession,
          state,
          cardMessageId,
          cardkit: cardkitState,
          renderMode: "cardkit_skipped_hash",
        };
      }
      const completedFooterKey = buildAssistantCardFooterKey({
        status: renderPlan?.statusLabel ?? "\u5df2\u5b8c\u6210",
        durationLabel: renderPlan?.durationLabel ?? "0\u520600\u79d2",
      });
      const sequence = this._nextAssistantCardKitSequence(cardkitState);
      const cardkitFinalUpdateStartedAt = nowIso();
      const finalCloseStartedAt = cardkitState?.finalizedAt
        ? null
        : cardkitFinalUpdateStartedAt;
      await this._updateAssistantCardKitCardEntity({
        cardId: cardkitState.cardId,
        card: renderPlan.card,
        sequence,
        uuid: buildFeishuDeliveryUuid(
          `assistant-card-cardkit-final:${currentSession.session_id}:${sequence}`,
        ),
      });
      const cardkitFinalUpdateFinishedAt = nowIso();
      const finalCloseCompletedAt = finalCloseStartedAt
        ? cardkitFinalUpdateFinishedAt
        : null;
      cardkitState = {
        ...cardkitState,
        sequence,
        footerKey: completedFooterKey,
        finalizedAt: cardkitState.finalizedAt ?? finalCloseCompletedAt ?? nowIso(),
      };
      if (finalCloseStartedAt) {
        state = mergeAssistantCardOutboundTelemetry(state, {
          finalCloseStartedAt,
          finalCloseCompletedAt: cardkitState.finalizedAt,
        });
      }
      state = mergeAssistantCardOutboundTelemetry(state, {
        cardkitFinalUpdateStartedAt,
        cardkitFinalUpdateFinishedAt,
      });
    } else {
      const streamingSections = deriveAssistantCardKitStreamingSectionsFromState(state);
      const rebased = await this._rebaseAssistantCardKitFinalFirstToStreaming({
        session: currentSession,
        state,
        cardkit: cardkitState,
        sections: streamingSections,
        statusLabel: renderPlan?.statusLabel ?? "\u5904\u7406\u4e2d",
        durationLabel: renderPlan?.durationLabel ?? "0\u520600\u79d2",
      });
      currentSession = rebased.session ?? currentSession;
      state = rebased.state ?? state;
      cardkitState = rebased.cardkit ?? cardkitState;
      if (rebased.rebased) {
        renderMode = "cardkit_rebased_final_first";
      }
      const streamed = await this._streamAssistantCardKitSections({
        cardkit: cardkitState,
        sections: streamingSections,
        session: currentSession,
        state,
        statusLabel: renderPlan?.statusLabel ?? "\u5904\u7406\u4e2d",
        durationLabel: renderPlan?.durationLabel ?? "0\u520600\u79d2",
      });
      cardkitState = streamed.cardkit;
    }

    state = {
      ...state,
      cardkit: cardkitState,
    };
    currentSession = this._persistAssistantCardKitSessionState(currentSession, state, {
      cardMessageId,
    });
    return {
      session: currentSession,
      state,
      cardMessageId,
      cardkit: cardkitState,
      renderMode,
    };
  }

  _getInboundAttachmentRootDir() {
    return path.join(this.paths.rootDir, "inbound-attachments");
  }

  _resolveInboundAttachmentKey(attachment) {
    return (
      String(
        attachment?.fileKey ??
          attachment?.imageKey ??
          attachment?.resourceKey ??
          attachment?.key ??
          "",
      ).trim() || null
    );
  }

  _resolveInboundResourceType(attachment) {
    const kind = inferAttachmentKind(attachment);
    return kind === "image" ? "image" : "file";
  }

  _buildInboundAttachmentFileName(attachment, mimeType, contentDisposition, index = 0) {
    const explicitName = String(attachment?.name ?? "").trim() || null;
    const dispositionName = parseContentDispositionFileName(contentDisposition);
    const extension = inferExtensionFromMimeType(mimeType);
    const keySuffix = this._resolveInboundAttachmentKey(attachment)?.slice(0, 12) || `${index + 1}`;
    const fallbackBase = `${inferAttachmentKind(attachment)}-${keySuffix}`;
    let fileName = explicitName || dispositionName || fallbackBase;
    if (!path.extname(fileName) && extension) {
      fileName = `${fileName}${extension}`;
    }
    return sanitizeFileName(fileName, `${fallbackBase}${extension}`);
  }

  async _downloadInboundMessageResource(messageId, attachment) {
    const resourceKey = this._resolveInboundAttachmentKey(attachment);
    if (!messageId || !resourceKey) {
      throw new Error("inbound_attachment_resource_missing");
    }
    const resourceType = this._resolveInboundResourceType(attachment);
    const accessToken = await this._getTenantAccessToken();
    const resourceUrl = new URL(
      `https://open.feishu.cn/open-apis/im/v1/messages/${encodeURIComponent(String(messageId))}/resources/${encodeURIComponent(resourceKey)}`,
    );
    resourceUrl.searchParams.set("type", resourceType);
    const response = await fetch(
      resourceUrl,
      {
        headers: {
          authorization: `Bearer ${accessToken}`,
          "content-type": "application/json",
        },
      },
    );
    const contentTypeHeader = String(response.headers.get("content-type") ?? "");
    const normalizedContentType = contentTypeHeader.split(";")[0].trim().toLowerCase();
    if (!response.ok || normalizedContentType.includes("json")) {
      const text = await response.text();
      let payload = null;
      try {
        payload = text ? JSON.parse(text) : null;
      } catch {
        payload = text;
      }
      if (!response.ok || Number(payload?.code ?? 0) !== 0) {
        throw createFeishuHttpError("feishu_message_resource_get_failed", {
          status: response.status,
          data: payload,
          text,
        });
      }
      throw new Error("feishu_message_resource_unexpected_json");
    }
    const buffer = Buffer.from(await response.arrayBuffer());
    if (buffer.length === 0) {
      throw new Error("feishu_message_resource_empty");
    }
    return {
      buffer,
      mimeType: normalizedContentType || null,
      contentDisposition: response.headers.get("content-disposition") ?? null,
    };
  }

  async _materializeInboundAttachment(messageId, attachment, index = 0) {
    const existingSourcePath =
      String(attachment?.sourcePath ?? attachment?.path ?? "").trim() || null;
    if (existingSourcePath && fs.existsSync(existingSourcePath)) {
      return {
        ...attachment,
        kind: inferAttachmentKind(attachment),
        sourceType: "path",
        sourcePath: existingSourcePath,
        order: Number.isFinite(attachment?.order) ? Number(attachment.order) : index,
      };
    }
    const downloaded = await this._downloadInboundMessageResource(messageId, attachment);
    const attachmentDir = path.join(
      this._getInboundAttachmentRootDir(),
      sanitizeFileName(String(messageId ?? "message"), "message"),
    );
    await fs.promises.mkdir(attachmentDir, { recursive: true });
    const fileName = this._buildInboundAttachmentFileName(
      attachment,
      downloaded.mimeType,
      downloaded.contentDisposition,
      index,
    );
    const filePath = path.join(
      attachmentDir,
      `${String(index + 1).padStart(2, "0")}-${fileName}`,
    );
    await fs.promises.writeFile(filePath, downloaded.buffer);
    return {
      ...attachment,
      kind: inferAttachmentKind({
        ...attachment,
        mimeType: downloaded.mimeType ?? attachment?.mimeType ?? null,
      }),
      name: fileName,
      mimeType: downloaded.mimeType ?? attachment?.mimeType ?? null,
      sourceType: "path",
      sourcePath: filePath,
      order: Number.isFinite(attachment?.order) ? Number(attachment.order) : index,
    };
  }

  async _materializeInboundAttachments(attachments, { messageId } = {}) {
    if (!Array.isArray(attachments) || attachments.length === 0) {
      return [];
    }
    const materialized = [];
    for (const [index, attachment] of attachments.entries()) {
      if (attachment == null || typeof attachment !== "object") {
        continue;
      }
      materialized.push(
        await this._materializeInboundAttachment(messageId, attachment, index),
      );
    }
    return materialized;
  }

  _refreshUserIdentityStatus() {
    const tokenState = this._getStoredUserSendToken(this.defaultOpenId);
    const ready =
      Boolean(tokenState?.accessToken) &&
      Boolean(tokenState?.expiresAt) &&
      new Date(tokenState.expiresAt).getTime() > Date.now();
    this._setState({
      userIdentitySendEnabled: this._getUserIdentitySettings().enabled,
      userIdentitySendReady: ready,
      userIdentitySendOpenId: tokenState?.openId ?? null,
      userIdentitySendAuthUrl: ready
        ? null
        : this._buildUserIdentityAuthorizationUrl(this.defaultOpenId),
    });
  }

  async start() {
    this._attachPipeNotifications();
    await this._startDiagnosticsServer();
    await this._connectPipe().catch((error) => {
      this._setError(error, { bridgeStatus: "recovering" });
    });
    this._startMaintenanceLoops();
    if (this.keepAliveTimer == null) {
      this.keepAliveTimer = setInterval(() => void 0, 60_000);
    }
    this._refreshUserIdentityStatus();

    if (!this.config?.enabled) {
      this._setState({ status: "offline", bridgeStatus: "offline" });
      this._log("info", "sidecar disabled in bridge-config.json");
      return;
    }
    if (Lark == null) {
      this._setState({
        status: "degraded",
        lastError: "lark_sdk_unavailable",
      });
      this._log("error", "Feishu SDK unavailable in sidecar process");
      return;
    }
    if (!this.config.appId?.trim() || !this.config.appSecret?.trim()) {
      this._setState({
        status: "degraded",
        lastError: "missing_app_credentials",
      });
      this._log("warning", "Feishu bridge enabled but appId/appSecret missing");
      return;
    }

    this._log("info", "Loaded Feishu text chunking policy", this.state.textChunkingPolicy);

    this.client = new Lark.Client({
      appId: this.config.appId,
      appSecret: this.config.appSecret,
      appType: Lark.AppType?.SelfBuild,
      loggerLevel: Lark.LoggerLevel?.info,
    });

    await this._validateCredentials();
    await this._startLongConnection();
    await this._refreshBridgeHealth();
    await this._drainQueues();
    await this._interruptSupersededAssistantCardSessions();
    this._resumePendingAssistantCardPlaybackSessions();
    await this._syncCompletedUnfinalizedAssistantCardSessions();
    this._deriveOverallStatus();
    this._log("info", "Feishu sidecar started", {
      allowlistCount: this.allowlist.size,
      defaultOpenIdPresent: this.defaultOpenId != null,
      diagnosticsHttp: this.state.diagnosticsHttp,
    });
  }

  async stop() {
    if (this.healthTimer != null) {
      clearInterval(this.healthTimer);
      this.healthTimer = null;
    }
    if (this.queueTimer != null) {
      clearInterval(this.queueTimer);
      this.queueTimer = null;
    }
    if (this.keepAliveTimer != null) {
      clearInterval(this.keepAliveTimer);
      this.keepAliveTimer = null;
    }
    for (const timer of this.assistantCardPlaybackTimers.values()) {
      clearTimeout(timer);
    }
    this.assistantCardPlaybackTimers.clear();
    this.assistantCardSyncLocks.clear();
    this.pipeClient.close();
    this.wsStarted = false;
    if (this.wsClient?.close instanceof Function) {
      await Promise.resolve(this.wsClient.close({ force: true })).catch(() => void 0);
    }
    if (this.diagnosticsServer != null) {
      await new Promise((resolve) => this.diagnosticsServer.close(resolve));
      this.diagnosticsServer = null;
    }
    this.store.close();
  }

  _evaluateInboundFreshness(envelope) {
    return evaluateInboundEventFreshness({
      createdAtMs: envelope?.createdAtMs,
      nowMs: Date.now(),
      maxAgeMs: getInboundEventMaxAgeMs(this.config),
    });
  }

  _markInboundStale(envelope, freshness, source) {
    const providerMessageId = String(
      envelope?.messageId ?? envelope?.providerMessageId ?? "",
    ).trim();
    if (!providerMessageId) {
      return;
    }
    const marker = {
      status: "stale_ignored",
      reason: freshness?.reason ?? "stale_inbound_event",
      source: source ?? null,
      ignoredAt: nowIso(),
      providerMessageId,
      senderOpenId: envelope?.senderOpenId ?? envelope?.feishuOpenId ?? null,
      chatId: envelope?.chatId ?? envelope?.feishuChatId ?? null,
      messageCreatedAtMs: envelope?.messageCreatedAtMs ?? null,
      eventCreatedAtMs: envelope?.eventCreatedAtMs ?? null,
      createdAtMs: freshness?.createdAtMs ?? envelope?.createdAtMs ?? null,
      ageMs: freshness?.ageMs ?? null,
      maxAgeMs: freshness?.maxAgeMs ?? getInboundEventMaxAgeMs(this.config),
      textPreview: String(envelope?.text ?? "").slice(0, 120),
    };
    this.store.setRuntimeState(buildQueuedInboundKey(providerMessageId), marker);
    this._setState({
      lastStaleInboundAt: marker.ignoredAt,
      lastStaleInboundMessageId: providerMessageId,
      lastStaleInboundAgeMs: marker.ageMs,
    });
    this._log("warn", "Ignored stale inbound Feishu message", {
      providerMessageId,
      source: marker.source,
      ageMs: marker.ageMs,
      maxAgeMs: marker.maxAgeMs,
      messageCreatedAtMs: marker.messageCreatedAtMs,
      eventCreatedAtMs: marker.eventCreatedAtMs,
      textPreview: marker.textPreview,
    });
  }

  async handleReceiveMessage(data) {
    const envelope = this._normalizeInboundEnvelope(data);
    if (envelope == null) {
      const message = data?.message ?? data?.event?.message ?? null;
      this._log("info", "Ignored unsupported or empty inbound Feishu message", {
        messageId: message?.message_id ?? null,
        messageType:
          String(
            message?.message_type ?? data?.message_type ?? data?.event?.message?.message_type ?? "",
          ).trim() || null,
        chatType: String(message?.chat_type ?? data?.chat_type ?? "").trim() || null,
        contentPreview: String(message?.content ?? "").slice(0, 400),
      });
      return;
    }

    this._setState({
      lastEventAt: nowIso(),
      lastInboundAt: nowIso(),
    });

    const freshness = this._evaluateInboundFreshness(envelope);
    if (freshness.stale) {
      this._markInboundStale(envelope, freshness, "receive_event");
      return;
    }

    const inboundMarker = this._getQueuedInboundMarker(envelope.messageId);
    if (this._isTerminalQueuedInboundMarker(inboundMarker)) {
      this._log("info", "Ignored duplicate terminal inbound Feishu message", {
        providerMessageId: envelope.messageId,
        markerStatus: inboundMarker?.status ?? null,
        markerReason: inboundMarker?.reason ?? null,
      });
      return;
    }

    if (this._shouldSuppressInboundSelfMirror(envelope)) {
      return;
    }

    if (!this._isAllowedOpenId(envelope.senderOpenId)) {
      await this._safeSendPrivateText(
        envelope.senderOpenId,
        "当前账号不在桥接白名单中，已拒绝这条私聊消息。",
      );
      return;
    }

    const command = envelope.text.toLowerCase();
    if (command === "/status") {
      await this._sendStatusReply(envelope.senderOpenId);
      return;
    }
    if (
      command === "/use-current" ||
      command === "/follow-current" ||
      command === "/use-current-follow"
    ) {
      await this._handleUseCurrent(envelope, { followCurrentThread: true });
      return;
    }
    if (command === "/pin-current" || command === "/use-current-fixed") {
      await this._handleUseCurrent(envelope, { followCurrentThread: false });
      return;
    }
    if (command === "/unbind") {
      await this._handleUnbind(envelope);
      return;
    }

    let inboundAttachments = envelope.attachments;
    try {
      inboundAttachments = await this._materializeInboundAttachments(envelope.attachments, {
        messageId: envelope.messageId,
      });
      const result = await this.pipeClient.request("bridge.submitInboundFeishuMessage", {
        feishuOpenId: envelope.senderOpenId,
        feishuChatId: envelope.chatId,
        providerMessageId: envelope.messageId,
        text: envelope.text,
        attachments: inboundAttachments,
        rawEvent: data,
      });
      if (result?.ok) {
        this._clearQueuedInboundMarker(envelope.messageId);
        this._deriveOverallStatus();
        return;
      }
      this._markInboundQueued(
        envelope.messageId,
        result?.error ?? "local_submit_failed",
        null,
      );
      await this._safeSendPrivateText(
        envelope.senderOpenId,
        "桌面端暂时不可用，这条消息不会补投；恢复后请重新发送。",
      );
    } catch (error) {
      await this._queueInboundForRecovery(
        {
          ...envelope,
          attachments: inboundAttachments,
          rawEvent: data,
        },
        safeErrorMessage(error),
      );
      await this._safeSendPrivateText(
        envelope.senderOpenId,
        "桌面端当前离线或桥接未就绪，这条消息不会补投；恢复后请重新发送。",
      );
      this._setError(error, { bridgeStatus: "recovering" });
    }
  }

  async handleTurnEvent(event) {
    const openId = String(event?.feishuOpenId ?? this.defaultOpenId ?? "").trim() || null;
    const text = formatMirroredText(event);
    const attachments = normalizeMirroredAttachments(event?.message?.attachments);
    const turnStatus = String(event?.message?.turnStatus ?? "").trim().toLowerCase();
    const isAssistantMirror =
      event?.eventType === "assistant_reply_completed" &&
      String(event?.message?.role ?? "").trim().toLowerCase() === "assistant";
    const isAssistantCompletion =
      isAssistantMirror &&
      (turnStatus === "completed" || event?.message?.sourceCompleted === true);
    if (!openId || (!text && attachments.length === 0 && !isAssistantCompletion)) {
      return;
    }
    if (isAssistantMirror) {
      await this._handleAssistantTurnEvent(event, {
        openId,
        text,
        attachments,
        turnStatus,
      });
      return;
    }
    if (this._shouldSuppressDesktopEcho(event)) {
      return;
    }
    await this._interruptProcessingAssistantCardForUserEvent(event);
    await this._queueMirroredOutboundLedger(event, {
      openId,
      text,
      attachments,
    });
  }

  async _queueMirroredOutboundLedger(
    event,
    {
      providerMessageId = buildOutboundMessageId(event),
      openId = null,
      text = "",
      attachments = [],
      origin = null,
      role = null,
    } = {},
  ) {
    if (!providerMessageId) {
      return null;
    }
    let ledger = this.store.getMessageLedger("codex_local", providerMessageId);
    if (ledger == null) {
      const generatedAt = normalizeAssistantCardTimestamp(event?.generatedAt) ?? nowIso();
      const ledgerCreatedAt = nowIso();
      ledger = this.store.insertOutboundLedger({
        providerMessageId,
        bindingId: event?.bindingId ?? null,
        origin:
          origin ??
          (event?.eventType === "assistant_reply_completed" ? "assistant_local" : "desktop_local"),
        role: role ?? String(event?.message?.role ?? "assistant"),
        text,
        rawPayload: {
          feishuOpenId:
            openId ?? (String(event?.feishuOpenId ?? this.defaultOpenId ?? "").trim() || null),
          feishuChatId: event?.feishuChatId ?? null,
          eventType: event?.eventType ?? null,
          generatedAt,
          deliveryTelemetry: mergeMessageLedgerDeliveryTelemetry(null, {
            desktopDetectedAt: generatedAt,
            ledgerCreatedAt,
          }),
          turnId: event?.message?.turnId ?? null,
          turnStatus: event?.message?.turnStatus ?? null,
          turnIndex: event?.message?.turnIndex ?? null,
          itemIndex: event?.message?.itemIndex ?? null,
          attachments,
          localThreadId: event?.message?.localThreadId ?? null,
          localConversationId: event?.message?.localConversationId ?? null,
          toolStateSummary:
            event?.message?.toolStateSummary != null &&
            typeof event.message.toolStateSummary === "object"
              ? { ...event.message.toolStateSummary }
              : null,
          message:
            event?.message != null && typeof event.message === "object"
              ? {
                  ...event.message,
                  attachments,
                }
              : null,
        },
        status: "pending_feishu_delivery",
        localTurnId: event?.message?.turnId ?? null,
      });
    }
    if (ledger?.status === "delivered") {
      return ledger;
    }
    await this._enqueueFeishuDeliveryDrain();
    return ledger;
  }

  _assistantEventHasReliableCardMetadata(event) {
    const turnId = String(event?.message?.turnId ?? "").trim();
    const localThreadId = String(
      event?.message?.localThreadId ?? event?.message?.localConversationId ?? "",
    ).trim();
    return Boolean(turnId) && Boolean(localThreadId) && Number.isFinite(event?.message?.itemIndex);
  }

  _clearAssistantCardPlaybackTimer(sessionId) {
    const normalizedSessionId = String(sessionId ?? "").trim();
    if (!normalizedSessionId || !(this.assistantCardPlaybackTimers instanceof Map)) {
      return;
    }
    const timer = this.assistantCardPlaybackTimers.get(normalizedSessionId);
    if (timer != null) {
      clearTimeout(timer);
      this.assistantCardPlaybackTimers.delete(normalizedSessionId);
    }
  }

  _scheduleAssistantCardPlayback(sessionId, delayMs = null) {
    const normalizedSessionId = String(sessionId ?? "").trim();
    if (!normalizedSessionId) {
      return;
    }
    if (!(this.assistantCardPlaybackTimers instanceof Map)) {
      this.assistantCardPlaybackTimers = new Map();
    }
    this._clearAssistantCardPlaybackTimer(normalizedSessionId);
    const fallbackDelayMs = this._getAssistantCardPlaybackTickMs();
    const requestedDelayMs = delayMs == null ? fallbackDelayMs : Number(delayMs);
    const resolvedDelayMs = Number.isFinite(requestedDelayMs)
      ? Math.max(0, requestedDelayMs)
      : fallbackDelayMs;
    const timer = setTimeout(() => {
      this.assistantCardPlaybackTimers.delete(normalizedSessionId);
      void this._runAssistantCardPlaybackTick(normalizedSessionId);
    }, resolvedDelayMs);
    timer.unref?.();
    this.assistantCardPlaybackTimers.set(normalizedSessionId, timer);
  }

  _runAssistantCardSessionSyncExclusive(sessionId, work) {
    const normalizedSessionId = String(sessionId ?? "").trim();
    if (!normalizedSessionId) {
      return Promise.resolve(work());
    }
    if (!(this.assistantCardSyncLocks instanceof Map)) {
      this.assistantCardSyncLocks = new Map();
    }
    const previous = this.assistantCardSyncLocks.get(normalizedSessionId) ?? Promise.resolve();
    const next = previous.catch(() => void 0).then(() => work());
    const chained = next.finally(() => {
      if (this.assistantCardSyncLocks.get(normalizedSessionId) === chained) {
        this.assistantCardSyncLocks.delete(normalizedSessionId);
      }
    });
    this.assistantCardSyncLocks.set(normalizedSessionId, chained);
    return next;
  }

  _isAssistantCardSessionSyncActive(sessionId) {
    const normalizedSessionId = String(sessionId ?? "").trim();
    return (
      normalizedSessionId.length > 0 &&
      this.assistantCardSyncLocks instanceof Map &&
      this.assistantCardSyncLocks.has(normalizedSessionId)
    );
  }

  _syncAssistantCardSessionImmediately(sessionId, targetRevision, { telemetry = null } = {}) {
    const normalizedSessionId = String(sessionId ?? "").trim();
    if (!normalizedSessionId) {
      return Promise.resolve({
        skipped: true,
        reason: "missing_session_id",
      });
    }
    const normalizedTargetRevision = Math.max(0, Number(targetRevision ?? 0) || 0);
    return this._runAssistantCardSessionSyncExclusive(normalizedSessionId, () =>
      this._syncAssistantCardSessionRevision(normalizedSessionId, normalizedTargetRevision, {
        telemetry,
      }),
    );
  }

  _isAssistantCardSessionInterrupted(session) {
    const state = clampAssistantCardPresentationState(session?.state_json ?? {});
    return Boolean(state?.interruptedAt || state?.interruptedReason);
  }

  _isAssistantCardSessionCompletedAndFinalized(session) {
    if (session?.status !== "completed") {
      return false;
    }
    const state = clampAssistantCardPresentationState(session?.state_json ?? {});
    return Boolean(
      normalizeAssistantCardTimestamp(state?.presentationCompletedAt) &&
        normalizeAssistantCardTimestamp(state?.cardkit?.finalizedAt) &&
        String(session?.last_render_hash ?? "").trim(),
    );
  }

  _assistantCardSessionNeedsFinalizedSync(session) {
    if (session?.status !== "completed") {
      return false;
    }
    const rawState =
      session?.state_json != null && typeof session.state_json === "object"
        ? session.state_json
        : {};
    const state = clampAssistantCardPresentationState(rawState);
    const presentationCompletedAt =
      normalizeAssistantCardTimestamp(rawState?.presentationCompletedAt) ??
      normalizeAssistantCardTimestamp(state?.presentationCompletedAt);
    if (!presentationCompletedAt) {
      return false;
    }
    const cardkit =
      rawState?.cardkit != null && typeof rawState.cardkit === "object"
        ? rawState.cardkit
        : state?.cardkit;
    if (!cardkit?.cardId) {
      return false;
    }
    if (normalizeAssistantCardTimestamp(cardkit?.finalizedAt)) {
      return false;
    }
    return this._shouldUseAssistantCardKitForSession(session);
  }

  _isAssistantCardFinalizedRenderDuplicate(session, nextState) {
    if (!this._isAssistantCardSessionCompletedAndFinalized(session)) {
      return false;
    }
    try {
      const renderPlan = this._buildAssistantCardRenderPlan({
        ...session,
        status: "completed",
        state_json: nextState,
      });
      const nextRenderHash = String(renderPlan?.renderHash ?? "").trim();
      const appliedRenderHash = String(session?.last_render_hash ?? "").trim();
      return Boolean(
        renderPlan?.sections?.presentationCompleted &&
          nextRenderHash &&
          appliedRenderHash &&
          nextRenderHash === appliedRenderHash,
      );
    } catch {
      return false;
    }
  }

  _getLatestAssistantCardSessionForThread(session) {
    const bindingId = String(session?.binding_id ?? "").trim();
    const localThreadId = String(session?.local_thread_id ?? "").trim();
    const sendIdentity = String(session?.send_identity ?? "bot").trim() || "bot";
    if (!bindingId || !localThreadId) {
      return null;
    }
    if (!(this.store?.getLatestFeishuCardSessionByThread instanceof Function)) {
      return null;
    }
    return this.store.getLatestFeishuCardSessionByThread(bindingId, localThreadId, sendIdentity);
  }

  _isAssistantCardSessionSuperseded(session) {
    const latest = this._getLatestAssistantCardSessionForThread(session);
    if (latest == null) {
      return false;
    }
    return String(latest.session_id ?? "").trim() !== String(session?.session_id ?? "").trim();
  }

  _isAssistantCardSessionStrictlyOlderThan(session, currentSession) {
    if (session == null || currentSession == null) {
      return false;
    }
    if (
      String(session?.session_id ?? "").trim() ===
      String(currentSession?.session_id ?? "").trim()
    ) {
      return false;
    }
    const sessionCreatedMs = Date.parse(String(session?.created_at ?? ""));
    const currentCreatedMs = Date.parse(String(currentSession?.created_at ?? ""));
    if (Number.isFinite(sessionCreatedMs) && Number.isFinite(currentCreatedMs)) {
      return sessionCreatedMs < currentCreatedMs;
    }
    const sessionCreatedAt = String(session?.created_at ?? "").trim();
    const currentCreatedAt = String(currentSession?.created_at ?? "").trim();
    if (sessionCreatedAt && currentCreatedAt && sessionCreatedAt !== currentCreatedAt) {
      return sessionCreatedAt < currentCreatedAt;
    }
    return false;
  }

  _shouldResumeAssistantCardPlaybackSession(session) {
    if (session == null) {
      return false;
    }
    const normalizedState = clampAssistantCardPresentationState(session?.state_json ?? {});
    if (!hasPendingAssistantCardPlayback(normalizedState)) {
      return false;
    }
    if (this._isAssistantCardSessionInterrupted(session)) {
      return false;
    }
    if (this._isAssistantCardSessionSuperseded(session)) {
      return false;
    }
    return true;
  }

  _markAssistantCardSessionInterrupted(
    session,
    { reason = "superseded_session", interruptedAt = nowIso(), interruptedByTurnId = null } = {},
  ) {
    if (session == null) {
      return null;
    }
    const currentState = clampAssistantCardPresentationState(session?.state_json ?? {});
    if (
      session?.status === "completed" ||
      session?.status === "degraded" ||
      currentState.presentationCompletedAt
    ) {
      return null;
    }
    if (currentState.interruptedAt || currentState.interruptedReason) {
      if (session?.status === "interrupted") {
        return null;
      }
      const interrupted = this.store.upsertFeishuCardSession({
        sessionId: session.session_id,
        bindingId: session.binding_id,
        localThreadId: session.local_thread_id,
        localTurnId: session.local_turn_id,
        sendIdentity: session.send_identity,
        feishuOpenId: session.feishu_open_id,
        feishuChatId: session.feishu_chat_id,
        cardMessageId: session.card_message_id,
        mode: session.mode,
        status: "interrupted",
        lastRevision: Math.max(0, Number(session.last_revision ?? 0) || 0) + 1,
        lastAppliedRevision: session.last_applied_revision ?? 0,
        lastRenderHash: session.last_render_hash ?? null,
        degradedReason: session.degraded_reason ?? null,
        state: {
          ...currentState,
          interruptedAt:
            normalizeAssistantCardTimestamp(currentState.interruptedAt) ?? nowIso(),
          interruptedReason:
            String(currentState.interruptedReason ?? reason ?? "superseded_session").trim() ||
            "superseded_session",
          ...(interruptedByTurnId && !currentState.interruptedByTurnId
            ? {
                interruptedByTurnId,
              }
            : {}),
        },
      });
      this._clearAssistantCardPlaybackTimer(interrupted.session_id);
      return interrupted;
    }
    const nextState = {
      ...currentState,
      interruptedAt: normalizeAssistantCardTimestamp(interruptedAt) ?? nowIso(),
      interruptedReason: String(reason ?? "superseded_session").trim() || "superseded_session",
      ...(interruptedByTurnId
        ? {
            interruptedByTurnId,
          }
        : {}),
    };
    const interrupted = this.store.upsertFeishuCardSession({
      sessionId: session.session_id,
      bindingId: session.binding_id,
      localThreadId: session.local_thread_id,
      localTurnId: session.local_turn_id,
      sendIdentity: session.send_identity,
      feishuOpenId: session.feishu_open_id,
      feishuChatId: session.feishu_chat_id,
      cardMessageId: session.card_message_id,
      mode: session.mode,
      status: "interrupted",
      lastRevision: Math.max(0, Number(session.last_revision ?? 0) || 0) + 1,
      lastAppliedRevision: session.last_applied_revision ?? 0,
      lastRenderHash: session.last_render_hash ?? null,
      degradedReason: session.degraded_reason ?? null,
      state: nextState,
    });
    this._clearAssistantCardPlaybackTimer(interrupted.session_id);
    return interrupted;
  }

  async _syncInterruptedAssistantCardSession(interrupted, reason) {
    if (interrupted == null) {
      return null;
    }
    return this._syncAssistantCardSessionImmediately(
      interrupted.session_id,
      interrupted.last_revision,
    ).catch((error) => {
      this._setError(error, {
        cardSessionId: interrupted.session_id,
        cardTurnId: interrupted.local_turn_id,
        cardInterruptReason: reason,
      });
      return null;
    });
  }

  async _interruptSupersededAssistantCardSessionsForThread(
    bindingId,
    localThreadId,
    sendIdentity = "bot",
    currentSessionId = null,
    options = {},
  ) {
    if (!(this.store?.listFeishuCardSessionsByThreadAndStatus instanceof Function)) {
      return 0;
    }
    const awaitInterruptedSync = options?.awaitInterruptedSync !== false;
    const sessions = this.store.listFeishuCardSessionsByThreadAndStatus(
      bindingId,
      localThreadId,
      sendIdentity,
      "processing",
    );
    const currentSessionIdText = String(currentSessionId ?? "").trim();
    const currentSession =
      currentSessionIdText && Array.isArray(sessions)
        ? sessions.find(
            (candidate) =>
              String(candidate?.session_id ?? "").trim() === currentSessionIdText,
          ) ??
          (this.store?.getFeishuCardSessionById instanceof Function
            ? this.store.getFeishuCardSessionById(currentSessionIdText)
            : null)
        : null;
    let interruptedCount = 0;
    for (const session of Array.isArray(sessions) ? sessions : []) {
      if (
        currentSessionIdText &&
        String(session?.session_id ?? "").trim() === currentSessionIdText
      ) {
        continue;
      }
      if (
        currentSessionIdText &&
        !this._isAssistantCardSessionStrictlyOlderThan(session, currentSession)
      ) {
        continue;
      }
      const interrupted = this._markAssistantCardSessionInterrupted(session, {
        reason: "superseded_session",
      });
      if (interrupted == null) {
        continue;
      }
      interruptedCount += 1;
      const syncPromise = this._syncInterruptedAssistantCardSession(
        interrupted,
        "superseded_session",
      );
      if (awaitInterruptedSync) {
        await syncPromise;
      } else {
        void syncPromise.catch((error) => {
          this._setError(error, {
            cardSessionId: interrupted.session_id,
            cardTurnId: interrupted.local_turn_id,
            cardInterruptReason: "superseded_session",
            backgroundInterruptedCardSync: true,
          });
        });
      }
    }
    return interruptedCount;
  }

  async _interruptSupersededAssistantCardSessions() {
    if (!(this.store?.listFeishuCardSessionsByStatus instanceof Function)) {
      return 0;
    }
    let interruptedCount = 0;
    const sessions = this.store.listFeishuCardSessionsByStatus("processing", "bot");
    for (const session of Array.isArray(sessions) ? sessions : []) {
      if (!this._isAssistantCardSessionSuperseded(session)) {
        continue;
      }
      const interrupted = this._markAssistantCardSessionInterrupted(session, {
        reason: "superseded_session",
      });
      if (interrupted == null) {
        continue;
      }
      interruptedCount += 1;
      await this._syncInterruptedAssistantCardSession(interrupted, "superseded_session");
    }
    if (interruptedCount > 0) {
      this._log?.("info", "Interrupted superseded assistant card sessions", {
        interruptedSessions: interruptedCount,
      });
    }
    return interruptedCount;
  }

  _resumePendingAssistantCardPlaybackSessions() {
    this._log?.("debug", "Skipped startup assistant card playback resume");
    return 0;
  }

  async _syncCompletedUnfinalizedAssistantCardSessions() {
    if (!(this.store?.listFeishuCardSessionsByStatus instanceof Function)) {
      return 0;
    }
    const sessions = this.store.listFeishuCardSessionsByStatus("completed", "bot");
    let syncCount = 0;
    for (const session of Array.isArray(sessions) ? sessions : []) {
      if (!this._assistantCardSessionNeedsFinalizedSync(session)) {
        continue;
      }
      syncCount += 1;
      const targetRevision = Math.max(
        0,
        Number(session?.last_revision ?? 0) || 0,
        Number(session?.last_applied_revision ?? 0) || 0,
      );
      await this._syncAssistantCardSessionImmediately(
        session.session_id,
        targetRevision,
        {
          telemetry: {
            dispatchRequestedAt: nowIso(),
            dispatchMode: "startup_finalization_recovery",
          },
        },
      ).catch((error) => {
        this._setError(error, {
          cardSessionId: session?.session_id ?? null,
          cardTurnId: session?.local_turn_id ?? null,
          cardFinalizationRecovery: true,
        });
      });
    }
    if (syncCount > 0) {
      this._log?.("info", "Synced completed unfinalized assistant card sessions", {
        cardSessions: syncCount,
      });
    }
    return syncCount;
  }

  async _runAssistantCardPlaybackTick(sessionId) {
    const current = this.store.getFeishuCardSessionById(sessionId);
    if (current == null) {
      this._clearAssistantCardPlaybackTimer(sessionId);
      return;
    }
    if (!this._shouldResumeAssistantCardPlaybackSession(current)) {
      this._clearAssistantCardPlaybackTimer(sessionId);
      return;
    }
    let nextState = clampAssistantCardPresentationState(current.state_json ?? {});
    const observedAt = nowIso();
    const burstCount = this._getAssistantCardPlaybackBurstCount(current);
    let advanced = false;
    for (let index = 0; index < burstCount; index += 1) {
      const revealed = revealNextAssistantCardProgressItem(nextState, observedAt);
      nextState = clampAssistantCardPresentationState(revealed.state);
      if (!revealed.advanced) {
        break;
      }
      advanced = true;
      if (!hasPendingAssistantCardPlayback(nextState)) {
        break;
      }
    }
    if (!advanced) {
      this._clearAssistantCardPlaybackTimer(sessionId);
      return;
    }
    const nextRevision = Math.max(0, Number(current.last_revision ?? 0)) + 1;
    const dispatchRequestedAt = nowIso();
    nextState = mergeAssistantCardOutboundTelemetry(nextState, {
      lastDispatchRequestedAt: dispatchRequestedAt,
      lastDispatchRevision: nextRevision,
      lastDispatchMode: "direct_playback",
    });
    const updated = this.store.upsertFeishuCardSession({
      sessionId: current.session_id,
      bindingId: current.binding_id,
      localThreadId: current.local_thread_id,
      localTurnId: current.local_turn_id,
      sendIdentity: current.send_identity,
      feishuOpenId: current.feishu_open_id,
      feishuChatId: current.feishu_chat_id,
      cardMessageId: current.card_message_id,
      mode: current.mode,
      status: nextState.presentationCompletedAt ? "completed" : "processing",
      lastRevision: nextRevision,
      lastAppliedRevision: current.last_applied_revision ?? 0,
      lastRenderHash: current.last_render_hash ?? null,
      degradedReason: current.degraded_reason ?? null,
      state: nextState,
    });
    await this._syncAssistantCardSessionImmediately(
      updated.session_id,
      updated.last_revision,
      {
        telemetry: {
          dispatchRequestedAt,
          dispatchMode: "direct_playback",
        },
      },
    ).catch((error) => {
      this._setError(error, {
        cardSessionId: updated.session_id,
        cardTurnId: updated.local_turn_id,
        cardPlayback: true,
      });
    });
    const refreshed = this.store.getFeishuCardSessionById(updated.session_id) ?? updated;
    if (this._shouldResumeAssistantCardPlaybackSession(refreshed)) {
      this._scheduleAssistantCardPlayback(refreshed.session_id);
    }
  }

  async _handleAssistantTurnEvent(
    event,
    { openId, text, attachments, turnStatus } = {},
  ) {
    if (!this._assistantEventHasReliableCardMetadata(event)) {
      if (turnStatus === "completed") {
        await this._queueMirroredOutboundLedger(event, {
          openId,
          text,
          attachments,
        });
      }
      return;
    }
    const localTurnId = String(event?.message?.turnId ?? "").trim();
    const localThreadId =
      String(event?.message?.localThreadId ?? event?.message?.localConversationId ?? "").trim() ||
      null;
    const sendIdentity = "bot";
    const existing = this.store.getFeishuCardSessionByTurn(
      event?.bindingId,
      localTurnId,
      sendIdentity,
    );
    if (existing?.status === "interrupted" && this._isAssistantCardSessionInterrupted(existing)) {
      this._clearAssistantCardPlaybackTimer(existing.session_id);
      return;
    }
    if (
      this._isAssistantCardSessionCompletedAndFinalized(existing) &&
      this._isAssistantCardSessionSuperseded(existing)
    ) {
      this._clearAssistantCardPlaybackTimer(existing.session_id);
      return;
    }
    let nextState = upsertAssistantCardStateFromEvent(
      existing?.state_json,
      {
        ...event,
        message: {
          ...(event?.message ?? {}),
          text,
          attachments,
        },
      },
    );
    if (
      existing?.state_json != null &&
      JSON.stringify(normalizeAssistantCardStateShape(existing.state_json)) ===
        JSON.stringify(nextState)
    ) {
      this._clearAssistantCardPlaybackTimer(existing.session_id);
      return;
    }
    if (this._isAssistantCardFinalizedRenderDuplicate(existing, nextState)) {
      this._clearAssistantCardPlaybackTimer(existing.session_id);
      return;
    }
    const nextRevision = Math.max(0, Number(existing?.last_revision ?? 0)) + 1;
    const eventObservedAt = normalizeAssistantCardTimestamp(event?.generatedAt) ?? nowIso();
    const dispatchRequestedAt = nowIso();
    nextState = mergeAssistantCardOutboundTelemetry(nextState, {
      firstEventAt: eventObservedAt,
      lastEventAt: eventObservedAt,
      lastDispatchRequestedAt: dispatchRequestedAt,
      lastDispatchRevision: nextRevision,
      lastDispatchMode: "pending_action",
    });
    const nextStatus = nextState.presentationCompletedAt ? "completed" : "processing";
    const session = this.store.upsertFeishuCardSession({
      sessionId:
        existing?.session_id ??
        buildAssistantCardSessionId({
          bindingId: event?.bindingId,
          localTurnId,
          sendIdentity,
        }),
      bindingId: event?.bindingId,
      localThreadId,
      localTurnId,
      sendIdentity,
      feishuOpenId: openId,
      feishuChatId: event?.feishuChatId ?? "",
      cardMessageId: existing?.card_message_id ?? null,
      mode: existing?.mode ?? "card",
      status: existing?.mode === "degraded_text" ? "degraded" : nextStatus,
      lastRevision: nextRevision,
      lastAppliedRevision: existing?.last_applied_revision ?? 0,
      lastRenderHash: existing?.last_render_hash ?? null,
      degradedReason: existing?.degraded_reason ?? null,
      state: nextState,
    });
    const syncAction = this.store.recordPendingAction("feishu_card_sync", event?.bindingId ?? null, {
      sessionId: session.session_id,
      targetRevision: session.last_revision,
      telemetry: {
        eventAt: eventObservedAt,
        dispatchRequestedAt,
        dispatchMode: "pending_action",
      },
    });
    await this._interruptSupersededAssistantCardSessionsForThread(
      event?.bindingId,
      localThreadId,
      sendIdentity,
      session.session_id,
      {
        awaitInterruptedSync: false,
      },
    );
    if (hasPendingAssistantCardPlayback(nextState)) {
      this._scheduleAssistantCardPlayback(session.session_id);
    } else {
      this._clearAssistantCardPlaybackTimer(session.session_id);
    }
    if (this._isAssistantCardSessionSyncActive(session.session_id)) {
      void this._drainQueues().catch(() => void 0);
      return;
    }
    await this._syncAssistantCardSessionAction(syncAction).catch((error) => {
      this._setError(error, {
        cardSessionId: session.session_id,
        cardTurnId: session.local_turn_id,
        cardDirectEventSync: true,
      });
    });
    void this._drainQueues().catch(() => void 0);
  }

  async _interruptProcessingAssistantCardForUserEvent(event) {
    if (event?.eventType !== "desktop_local_user_message") {
      return null;
    }
    const bindingId = String(event?.bindingId ?? "").trim();
    const localThreadId =
      String(event?.message?.localThreadId ?? event?.message?.localConversationId ?? "").trim() ||
      null;
    if (!bindingId || !localThreadId) {
      return null;
    }
    const processingSessions =
      this.store?.listFeishuCardSessionsByThreadAndStatus instanceof Function
        ? this.store.listFeishuCardSessionsByThreadAndStatus(
            bindingId,
            localThreadId,
            "bot",
            "processing",
          )
        : [
            this.store.getLatestFeishuCardSessionByThreadAndStatus(
              bindingId,
              localThreadId,
              "bot",
              "processing",
            ),
          ].filter(Boolean);
    if (!Array.isArray(processingSessions) || processingSessions.length === 0) {
      return null;
    }
    const currentUserTurnId = String(event?.message?.turnId ?? "").trim() || null;
    let interruptedAny = null;
    for (const processing of processingSessions) {
      if (
        currentUserTurnId != null &&
        String(processing?.local_turn_id ?? "").trim() === currentUserTurnId
      ) {
        continue;
      }
      const interrupted = this._markAssistantCardSessionInterrupted(processing, {
        reason: "user_message",
        interruptedAt: event?.generatedAt ?? nowIso(),
        interruptedByTurnId: currentUserTurnId,
      });
      if (interrupted == null) {
        continue;
      }
      await this._syncInterruptedAssistantCardSession(interrupted, "user_message");
      interruptedAny = interrupted;
    }
    if (interruptedAny == null) {
      return null;
    }
    return interruptedAny;
  }

  _normalizeAssistantCardStateForRender(session, state) {
    const nextState = normalizeAssistantCardStateShape(state, {
      localThreadId: session?.local_thread_id ?? null,
      localTurnId: session?.local_turn_id ?? null,
      deferCompletedPresentation:
        String(session?.status ?? "").trim().toLowerCase() === "processing",
    });
    if (
      nextState.toolSummary != null &&
      typeof nextState.toolSummary === "object" &&
      String(nextState.toolSummary.source ?? "").trim().toLowerCase() === "app_server_native"
    ) {
      Object.assign(
        nextState,
        maybeApplyRolloutCardTimingToState(nextState, nextState.toolSummary, {
          allowCompletedAt:
            !Array.isArray(nextState.items) ||
            nextState.items.length === 0 ||
            areAssistantCardItemsCompleted(nextState.items),
        }),
      );
    }
    if (Array.isArray(nextState.items) && nextState.items.length > 0) {
      const allCompleted = areAssistantCardItemsCompleted(nextState.items);
      if (!allCompleted) {
        nextState.sourceCompletedAt = null;
        nextState.completedAt = null;
        nextState.finalItemKey = null;
        nextState.presentationCompletedAt = null;
      }
    }
    let normalizedNextState = clampAssistantCardPresentationState(nextState);
    if (shouldPrimeAssistantCardProgress(normalizedNextState)) {
      normalizedNextState = revealNextAssistantCardProgressItem(
        normalizedNextState,
        nowIso(),
      ).state;
    }
    return normalizedNextState;
  }

  _buildAssistantCardRenderPlan(session) {
    const state = this._normalizeAssistantCardStateForRender(
      session,
      session?.state_json ?? {},
    );
    const sections = deriveAssistantCardSectionsFromState(state);
    const durationLabel = formatFeishuElapsedLabel(
      state?.startedAt ?? session?.created_at ?? nowIso(),
      state?.presentationCompletedAt ??
        state?.completedAt ??
        state?.interruptedAt ??
        nowIso(),
    );
    const statusLabel =
      session?.mode === "degraded_text"
        ? "已降级"
        : sections.presentationCompleted
          ? "已完成"
          : sections.sourceCompleted
            ? "回放中"
          : "处理中";
    const effectiveStatusLabel =
      state?.interruptedAt || session?.status === "interrupted" ? "已中断" : statusLabel;
    if (session?.mode === "degraded_text") {
      return {
        state,
        sections,
        durationLabel,
        statusLabel: effectiveStatusLabel,
        mode: "degraded_text",
        card: null,
        renderHash: null,
        contentPlan: {
          blocks: [],
          requiresFileFallback: false,
          requiresMermaidResolution: false,
        },
      };
    }
    const contentPlan =
      sections.sourceCompleted && sections.presentationCompleted
        ? buildAssistantCardRichContentPlan(sections.fullFinalText)
        : {
            blocks: [],
            requiresFileFallback: false,
            requiresMermaidResolution: false,
          };
    const measurementBlocks = contentPlan.requiresMermaidResolution
      ? contentPlan.blocks.map((block, index) =>
          block?.type === "mermaid"
            ? {
                type: "markdown",
                text: `> Mermaid 图 ${index + 1} 正在渲染...`,
              }
            : block,
        )
      : contentPlan.blocks;
    const measured = buildMeasuredAssistantCardRenderPayload({
      session,
      sections,
      statusLabel: effectiveStatusLabel,
      durationLabel,
      finalContentBlocks: measurementBlocks,
      forceMode: contentPlan.requiresFileFallback ? "card_plus_file" : null,
      degraded: false,
    });
    return {
      state,
      sections,
      durationLabel,
      statusLabel: effectiveStatusLabel,
      mode: measured.mode,
      card: measured.card,
      renderHash: measured.renderHash,
      contentPlan,
    };
  }

  _getAssistantCardSessionIfCurrent(sessionId, targetRevision) {
    const current = this.store.getFeishuCardSessionById(sessionId);
    if (current == null) {
      return {
        session: null,
        stale: true,
        reason: "session_missing",
      };
    }
    const normalizedTargetRevision = Math.max(0, Number(targetRevision ?? 0) || 0);
    const currentRevision = Math.max(0, Number(current?.last_revision ?? 0) || 0);
    const appliedRevision = Math.max(0, Number(current?.last_applied_revision ?? 0) || 0);
    const needsFinalizedSync = this._assistantCardSessionNeedsFinalizedSync(current);
    if (normalizedTargetRevision <= appliedRevision) {
      if (
        normalizedTargetRevision > 0 &&
        normalizedTargetRevision >= currentRevision &&
        needsFinalizedSync
      ) {
        return {
          session: current,
          stale: false,
          reason: null,
        };
      }
      return {
        session: current,
        stale: true,
        reason: "covered_by_applied_revision",
      };
    }
    if (currentRevision > normalizedTargetRevision) {
      return {
        session: current,
        stale: true,
        reason: "stale_revision",
      };
    }
    if (
      this._isAssistantCardSessionSuperseded(current) &&
      !this._isAssistantCardSessionInterrupted(current) &&
      !needsFinalizedSync
    ) {
      return {
        session: current,
        stale: true,
        reason: "superseded_session",
      };
    }
    return {
      session: current,
      stale: false,
      reason: null,
    };
  }

  _buildAssistantCardMermaidArtifactName(block, index = 0) {
    const diagramType = String(block?.diagramType ?? "mermaid").trim() || "mermaid";
    const sourceHash = crypto
      .createHash("sha1")
      .update(String(block?.source ?? ""), "utf8")
      .digest("hex")
      .slice(0, 10);
    return `mermaid-diagram-${String(index + 1).padStart(2, "0")}-${diagramType}-${sourceHash}.mmd`;
  }

  async _writeAssistantCardMermaidArtifact(session, block, index = 0) {
    const outboxDir = path.join(this.paths.rootDir, "outbox", "assistant-card-mermaid");
    await fs.promises.mkdir(outboxDir, { recursive: true });
    const fileName = this._buildAssistantCardMermaidArtifactName(block, index);
    const filePath = path.join(outboxDir, fileName);
    await fs.promises.writeFile(filePath, String(block?.source ?? "").trim(), "utf8");
    return {
      hash:
        crypto.createHash("sha1").update(String(block?.source ?? ""), "utf8").digest("hex"),
      fileName,
      filePath,
      diagramType: String(block?.diagramType ?? "").trim() || "mermaid",
    };
  }

  async _ensureAssistantCardMermaidArtifactDeliveries(session, artifacts, state) {
    const providerMessageIds = new Set(
      Array.isArray(state?.mermaidAttachmentProviderMessageIds)
        ? state.mermaidAttachmentProviderMessageIds
            .map((value) => String(value ?? "").trim())
            .filter(Boolean)
        : [],
    );
    const deliveries = [];
    for (const artifact of Array.isArray(artifacts) ? artifacts : []) {
      const providerMessageId = buildAssistantCardMermaidProviderMessageId(
        session?.session_id,
        artifact?.hash,
      );
      providerMessageIds.add(providerMessageId);
      let ledger = this.store.getMessageLedger("codex_local", providerMessageId);
      if (ledger == null) {
        ledger = this.store.insertOutboundLedger({
          providerMessageId,
          bindingId: session?.binding_id,
          origin: "assistant_local",
          role: "assistant",
          text: `Mermaid 源码见附件：${artifact?.fileName ?? "diagram.mmd"}`,
          rawPayload: {
            feishuOpenId: session?.feishu_open_id ?? null,
            feishuChatId: session?.feishu_chat_id ?? null,
            eventType: "assistant_card_mermaid_source",
            generatedAt: nowIso(),
            turnId: session?.local_turn_id ?? null,
            turnStatus: "completed",
            attachments: [
              {
                kind: "file",
                name: artifact?.fileName ?? "diagram.mmd",
                mimeType: "text/plain",
                sourceType: "path",
                sourcePath: artifact?.filePath ?? null,
                order: 0,
              },
            ],
            localThreadId: session?.local_thread_id ?? null,
            localConversationId: session?.local_thread_id ?? null,
          },
          status: "pending_feishu_delivery",
          localTurnId: session?.local_turn_id ?? null,
        });
      }
      if (ledger?.status !== "delivered") {
        await this._enqueueFeishuDeliveryDrain();
        ledger = this.store.getMessageLedger("codex_local", providerMessageId);
      }
      deliveries.push({
        ...artifact,
        providerMessageId,
        ledger,
      });
    }
    return {
      deliveries,
      providerMessageIds: Array.from(providerMessageIds),
    };
  }

  async _resolveAssistantCardRichContent(session, renderPlan, targetRevision) {
    if (
      !renderPlan?.sections?.completed ||
      renderPlan?.mode === "card_plus_file" ||
      !renderPlan?.contentPlan?.requiresMermaidResolution
    ) {
      return {
        ...renderPlan,
        statePatch: {},
        mermaidArtifacts: [],
      };
    }
    const blocks = JSON.parse(JSON.stringify(renderPlan.contentPlan.blocks ?? []));
    const mermaidArtifacts = [];
    for (let index = 0; index < blocks.length; index += 1) {
      const block = blocks[index];
      if (block?.type !== "mermaid") {
        continue;
      }
      const sourceExcerpt = truncateAssistantCardPlainText(block?.source ?? "", 220);
      const freshness = this._getAssistantCardSessionIfCurrent(session.session_id, targetRevision);
      if (freshness.stale) {
        return {
          stale: true,
          staleReason: freshness.reason,
          session: freshness.session,
        };
      }
      block.diagramType = String(
        block?.diagramType ?? detectMermaidDiagramType(block?.source ?? ""),
      ).trim() || null;
      if (!isSupportedMermaidDiagramType(block.diagramType)) {
        block.renderError = `当前仅支持 flowchart/graph、sequenceDiagram、classDiagram，收到 ${block.diagramType || "unknown"}`;
        this._log("warn", "assistant_card_mermaid_render_skipped_unsupported", {
          sessionId: session?.session_id ?? null,
          turnId: session?.local_turn_id ?? null,
          targetRevision,
          blockIndex: index,
          diagramType: block.diagramType,
          sourceExcerpt,
        });
        const artifact = await this._writeAssistantCardMermaidArtifact(session, block, index);
        block.artifactFileName = artifact.fileName;
        mermaidArtifacts.push(artifact);
        continue;
      }
      try {
        this._log("info", "assistant_card_mermaid_render_started", {
          sessionId: session?.session_id ?? null,
          turnId: session?.local_turn_id ?? null,
          targetRevision,
          blockIndex: index,
          diagramType: block.diagramType,
          timeoutMs: ASSISTANT_CARD_MERMAID_RENDER_TIMEOUT_MS,
          sourceExcerpt,
        });
        const rendered = await renderMermaidDiagramToPng({
          source: block.source,
          outputDir: path.join(this.paths.rootDir, "outbox", "assistant-card-mermaid"),
          timeoutMs: ASSISTANT_CARD_MERMAID_RENDER_TIMEOUT_MS,
        });
        const refreshed = this._getAssistantCardSessionIfCurrent(session.session_id, targetRevision);
        if (refreshed.stale) {
          return {
            stale: true,
            staleReason: refreshed.reason,
            session: refreshed.session,
          };
        }
        const prepared = await this._prepareMirroredAttachmentMessage(
          session?.feishu_open_id,
          {
            kind: "image",
            name: path.basename(rendered.pngPath),
            mimeType: "image/png",
            sourceType: "path",
            sourcePath: rendered.pngPath,
          },
          {
            asUser: session?.send_identity === "user",
          },
        );
        block.imageKey = String(prepared?.content?.image_key ?? "").trim() || null;
        block.diagramType = rendered.diagramType;
        this._log("info", "assistant_card_mermaid_render_succeeded", {
          sessionId: session?.session_id ?? null,
          turnId: session?.local_turn_id ?? null,
          targetRevision,
          blockIndex: index,
          diagramType: rendered.diagramType,
          browserPath: rendered.browserPath ?? null,
          elapsedMs: rendered.elapsedMs ?? null,
          width: rendered.width ?? null,
          height: rendered.height ?? null,
          pixelWidth: rendered.pixelWidth ?? null,
          pixelHeight: rendered.pixelHeight ?? null,
          screenshotScaleFactor: rendered.screenshotScaleFactor ?? null,
          layoutStrategy: rendered.layoutStrategy ?? "original",
          sourceExcerpt,
        });
      } catch (error) {
        block.renderError = safeErrorMessage(error);
        this._log("warn", "assistant_card_mermaid_render_failed", {
          sessionId: session?.session_id ?? null,
          turnId: session?.local_turn_id ?? null,
          targetRevision,
          blockIndex: index,
          diagramType: block.diagramType,
          error: safeErrorMessage(error),
          browserPath: error?.mermaidMeta?.browserPath ?? null,
          elapsedMs: error?.mermaidMeta?.elapsedMs ?? null,
          timeoutMs: error?.mermaidMeta?.timeoutMs ?? ASSISTANT_CARD_MERMAID_RENDER_TIMEOUT_MS,
          sourceExcerpt: error?.mermaidMeta?.sourceExcerpt ?? sourceExcerpt,
        });
        const artifact = await this._writeAssistantCardMermaidArtifact(session, block, index);
        block.artifactFileName = artifact.fileName;
        mermaidArtifacts.push(artifact);
      }
    }
    const measured = buildMeasuredAssistantCardRenderPayload({
      session,
      sections: renderPlan.sections,
      statusLabel: renderPlan.statusLabel,
      durationLabel: renderPlan.durationLabel,
      finalContentBlocks: blocks,
      forceMode: renderPlan.contentPlan.requiresFileFallback ? "card_plus_file" : null,
      degraded: false,
    });
    return {
      ...renderPlan,
      contentPlan: {
        ...renderPlan.contentPlan,
        blocks,
      },
      mode: measured.mode,
      card: measured.card,
      renderHash: measured.renderHash,
      statePatch: {},
      mermaidArtifacts,
    };
  }

  async _writeAssistantCardArtifact(session, finalText) {
    const existingPath =
      String(session?.state_json?.artifactPath ?? "").trim() || null;
    if (existingPath && fs.existsSync(existingPath)) {
      return {
        filePath: existingPath,
        fileName:
          String(session?.state_json?.artifactFileName ?? path.basename(existingPath)).trim() ||
          path.basename(existingPath),
      };
    }
    const outboxDir = path.join(this.paths.rootDir, "outbox");
    await fs.promises.mkdir(outboxDir, { recursive: true });
    const fileName = buildAssistantCardFileArtifactName(new Date());
    const filePath = path.join(outboxDir, fileName);
    const content = [
      `# 正式回复详细报告`,
      ``,
      `- 对话ID: ${session?.local_thread_id ?? "unknown_thread"}`,
      `- Turn ID: ${session?.local_turn_id ?? "unknown_turn"}`,
      `- 生成时间: ${nowIso()}`,
      ``,
      String(finalText ?? "").trim(),
    ].join("\n");
    await fs.promises.writeFile(filePath, content, "utf8");
    return {
      filePath,
      fileName,
    };
  }

  async _ensureAssistantCardFileDelivery(session, artifact, state) {
    const providerMessageId =
      String(
        state?.fileLedgerProviderMessageId ??
          buildAssistantCardFileProviderMessageId(session?.session_id),
      ).trim() || buildAssistantCardFileProviderMessageId(session?.session_id);
    let ledger = this.store.getMessageLedger("codex_local", providerMessageId);
    if (ledger == null) {
      ledger = this.store.insertOutboundLedger({
        providerMessageId,
        bindingId: session?.binding_id,
        origin: "assistant_local",
        role: "assistant",
        text: "完整正式回复见附件 Markdown 文件。",
        rawPayload: {
          feishuOpenId: session?.feishu_open_id ?? null,
          feishuChatId: session?.feishu_chat_id ?? null,
          eventType: "assistant_card_file",
          generatedAt: nowIso(),
          turnId: session?.local_turn_id ?? null,
          turnStatus: "completed",
          attachments: [
            {
              kind: "file",
              name: artifact.fileName,
              mimeType: "text/markdown",
              sourceType: "path",
              sourcePath: artifact.filePath,
              order: 0,
            },
          ],
          localThreadId: session?.local_thread_id ?? null,
          localConversationId: session?.local_thread_id ?? null,
        },
        status: "pending_feishu_delivery",
        localTurnId: session?.local_turn_id ?? null,
      });
    }
    if (ledger?.status !== "delivered") {
      await this._enqueueFeishuDeliveryDrain();
      ledger = this.store.getMessageLedger("codex_local", providerMessageId);
    }
    return {
      ledger,
      providerMessageId,
    };
  }

  async _emitAssistantCardTextFallback(session, sections, state) {
    const text = [
      sections.progressText ? `【思考过程】\n${sections.progressText}` : "",
      sections.toolSummaryText ? `【工具摘要】\n${sections.toolSummaryText}` : "",
      sections.finalText ? `【正式回复】\n${sections.finalText}` : "",
    ]
      .filter(Boolean)
      .join("\n\n")
      .trim();
    if (!text) {
      return {
        ledger: null,
        providerMessageId:
          state?.textFallbackProviderMessageId ??
          buildAssistantCardFallbackTextProviderMessageId(session?.session_id),
      };
    }
    const providerMessageId =
      String(
        state?.textFallbackProviderMessageId ??
          buildAssistantCardFallbackTextProviderMessageId(session?.session_id),
      ).trim() || buildAssistantCardFallbackTextProviderMessageId(session?.session_id);
    let ledger = this.store.getMessageLedger("codex_local", providerMessageId);
    if (ledger == null) {
      ledger = this.store.insertOutboundLedger({
        providerMessageId,
        bindingId: session?.binding_id,
        origin: "assistant_local",
        role: "assistant",
        text,
        rawPayload: {
          feishuOpenId: session?.feishu_open_id ?? null,
          feishuChatId: session?.feishu_chat_id ?? null,
          eventType: "assistant_card_fallback_text",
          generatedAt: nowIso(),
          turnId: session?.local_turn_id ?? null,
          turnStatus: "completed",
          attachments: [],
          localThreadId: session?.local_thread_id ?? null,
          localConversationId: session?.local_thread_id ?? null,
        },
        status: "pending_feishu_delivery",
        localTurnId: session?.local_turn_id ?? null,
      });
    }
    if (ledger?.status !== "delivered") {
      await this._enqueueFeishuDeliveryDrain();
      ledger = this.store.getMessageLedger("codex_local", providerMessageId);
    }
    return {
      ledger,
      providerMessageId,
    };
  }

  async _patchPrivateMessageCard({
    openId,
    messageId,
    card,
    asUser = false,
  } = {}) {
    const accessToken = asUser
      ? (await this._ensureUserSendToken(openId)).accessToken
      : await this._getTenantAccessToken();
    const response = await httpJsonRequest(
      `https://open.feishu.cn/open-apis/im/v1/messages/${encodeURIComponent(String(messageId ?? "").trim())}`,
      {
        method: "PATCH",
        headers: {
          authorization: `Bearer ${accessToken}`,
          "content-type": "application/json; charset=utf-8",
        },
        body: JSON.stringify({
          content: JSON.stringify(card ?? {}),
        }),
      },
    );
    if (!response.ok || Number(response.data?.code ?? 0) !== 0) {
      throw createFeishuHttpError(
        asUser ? "feishu_user_card_patch_failed" : "feishu_card_patch_failed",
        response,
      );
    }
    this._setState({
      lastOutboundAt: nowIso(),
      lastError: null,
    });
    return response.data;
  }

  async _createOrPatchAssistantCardMessage(session, card) {
    if (session?.card_message_id) {
      await this._patchPrivateMessageCard({
        openId: session?.feishu_open_id,
        messageId: session.card_message_id,
        card,
        asUser: session?.send_identity === "user",
      });
      return {
        messageId: session.card_message_id,
        created: false,
      };
    }
    const response = await this.sendPrivateMessage(session?.feishu_open_id, {
      asUser: session?.send_identity === "user",
      chatId: session?.feishu_chat_id ?? null,
      msgType: "interactive",
      content: card,
      uuid: buildFeishuDeliveryUuid(
        `assistant-card:${session?.session_id ?? "unknown"}:${session?.last_revision ?? 0}`,
      ),
    });
    return {
      messageId: extractFeishuMessageId(response),
      created: true,
    };
  }

  async _syncAssistantCardSessionRevision(
    sessionId,
    targetRevision,
    { action = null, telemetry = null } = {},
  ) {
    const payload = action?.payload_json ?? {
      sessionId,
      targetRevision,
    };
    const payloadTelemetry =
      payload?.telemetry != null && typeof payload.telemetry === "object"
        ? payload.telemetry
        : {};
    const callTelemetry =
      telemetry != null && typeof telemetry === "object" ? telemetry : {};
    const normalizedTargetRevision = Math.max(0, Number(targetRevision ?? 0) || 0);
    const syncStartedAt = nowIso();
    const dispatchRequestedAt =
      normalizeAssistantCardTimestamp(callTelemetry.dispatchRequestedAt) ??
      normalizeAssistantCardTimestamp(payloadTelemetry.dispatchRequestedAt) ??
      normalizeAssistantCardTimestamp(action?.created_at) ??
      syncStartedAt;
    const pendingActionQueuedAt =
      normalizeAssistantCardTimestamp(action?.created_at) ??
      normalizeAssistantCardTimestamp(payloadTelemetry.pendingActionQueuedAt);
    const dispatchMode =
      action?.id != null
        ? "pending_action"
        : normalizeAssistantCardTelemetryText(
            callTelemetry.dispatchMode ?? payloadTelemetry.dispatchMode,
          ) ?? "direct_sync";
    const completeAction = (result) => {
      const completedPayload =
        action?.id != null && payload != null && typeof payload === "object"
          ? {
              ...payload,
              ...(result != null && typeof result === "object" ? result : {}),
            }
          : result;
      if (action?.id != null) {
        this.store.completePendingAction(action.id, completedPayload);
      }
      return completedPayload;
    };
    const retryAction = (error, retryPayload) => {
      if (action?.id != null) {
        this.store.retryPendingAction(
          action.id,
          safeErrorMessage(error),
          retryPayload,
          getBackoffDelayMs(action.attempts),
        );
      }
    };
    const initialFreshness = this._getAssistantCardSessionIfCurrent(
      sessionId,
      normalizedTargetRevision,
    );
    const session = initialFreshness.session;
    if (session == null) {
      return completeAction({
        skipped: true,
        reason: "session_missing",
      });
    }
    if (initialFreshness.stale) {
      return completeAction({
        skipped: true,
        reason: initialFreshness.reason ?? "stale_revision",
      });
    }
    try {
      let renderPlan = this._buildAssistantCardRenderPlan(session);
      let nextState = mergeAssistantCardOutboundTelemetry(
        {
          ...(renderPlan.state ?? {}),
        },
        {
          lastDispatchRequestedAt: dispatchRequestedAt,
          lastPendingActionQueuedAt: pendingActionQueuedAt,
          firstCardSyncQueuedAt: pendingActionQueuedAt ?? dispatchRequestedAt,
          firstCardSyncStartedAt: syncStartedAt,
          lastSyncStartedAt: syncStartedAt,
          lastDispatchMode: dispatchMode,
          lastSyncRevision: normalizedTargetRevision,
        },
      );
      if (renderPlan.mode === "degraded_text") {
        if (renderPlan.sections.completed && !nextState.degradationEmitted) {
          const fallback = await this._emitAssistantCardTextFallback(
            session,
            renderPlan.sections,
            nextState,
          );
          nextState = {
            ...nextState,
            degradationEmitted: true,
            textFallbackProviderMessageId: fallback.providerMessageId,
          };
        }
        const syncFinishedAt = nowIso();
        nextState = mergeAssistantCardOutboundTelemetry(nextState, {
          lastSyncFinishedAt: syncFinishedAt,
          firstCardSyncCompletedAt: syncFinishedAt,
          lastSyncStatus: "degraded",
          lastRenderMode: "degraded_text",
          lastAppliedRevision: normalizedTargetRevision,
          lastCardMessageId: session.card_message_id,
        });
        this.store.upsertFeishuCardSession({
          sessionId: session.session_id,
          bindingId: session.binding_id,
          localThreadId: session.local_thread_id,
          localTurnId: session.local_turn_id,
          sendIdentity: session.send_identity,
          feishuOpenId: session.feishu_open_id,
          feishuChatId: session.feishu_chat_id,
          cardMessageId: session.card_message_id,
          mode: "degraded_text",
          status: "degraded",
          lastRevision: session.last_revision,
          lastAppliedRevision: normalizedTargetRevision,
          lastRenderHash: session.last_render_hash,
          degradedReason: session.degraded_reason ?? "assistant_card_degraded",
          state: nextState,
        });
        return completeAction({
          ...payload,
          syncedAt: syncFinishedAt,
          mode: "degraded_text",
        });
      }

      const resolvedPlan = await this._resolveAssistantCardRichContent(
        session,
        renderPlan,
        normalizedTargetRevision,
      );
      if (resolvedPlan?.stale) {
        return completeAction({
          skipped: true,
          reason: resolvedPlan.staleReason ?? "stale_revision",
        });
      }
      renderPlan = resolvedPlan;
      nextState = {
        ...nextState,
        ...(renderPlan.statePatch ?? {}),
      };

      const beforePatch = this._getAssistantCardSessionIfCurrent(
        session.session_id,
        normalizedTargetRevision,
      );
      if (beforePatch.stale) {
        return completeAction({
          skipped: true,
          reason: beforePatch.reason ?? "stale_revision",
        });
      }
      let currentSession = beforePatch.session;
      const renderHash = renderPlan.renderHash;
      let cardMessageId = currentSession.card_message_id ?? null;
      const cardUpdateStartedAt = nowIso();
      let renderMode = "skipped_hash";
      if (this._shouldUseAssistantCardKitForSession(currentSession)) {
        renderMode = "cardkit";
        const cardkitResult = await this._syncAssistantCardKitRenderPlan(
          currentSession,
          renderPlan,
          nextState,
        );
        currentSession = cardkitResult.session ?? currentSession;
        nextState = cardkitResult.state ?? nextState;
        cardMessageId = cardkitResult.cardMessageId ?? cardMessageId;
        renderMode = cardkitResult.renderMode ?? renderMode;
      } else if (!(cardMessageId && String(currentSession.last_render_hash ?? "") === String(renderHash))) {
        renderMode = cardMessageId ? "patch" : "create";
        const result = await this._createOrPatchAssistantCardMessage(
          currentSession,
          renderPlan.card,
        );
        cardMessageId = result.messageId ?? cardMessageId;
        if (result?.created && cardMessageId && !currentSession.card_message_id) {
          currentSession =
            this.store.updateFeishuCardSessionCardMessageId?.(
              currentSession.session_id,
              cardMessageId,
            ) ?? currentSession;
        }
      }
      nextState = mergeAssistantCardOutboundTelemetry(nextState, {
        lastCardUpdateStartedAt: cardUpdateStartedAt,
        lastCardUpdateFinishedAt: nowIso(),
        lastRenderMode: renderMode,
        lastCardMessageId: cardMessageId,
      });

      if (Array.isArray(renderPlan.mermaidArtifacts) && renderPlan.mermaidArtifacts.length > 0) {
        const mermaidDelivery = await this._ensureAssistantCardMermaidArtifactDeliveries(
          {
            ...currentSession,
            card_message_id: cardMessageId,
          },
          renderPlan.mermaidArtifacts,
          nextState,
        );
        nextState.mermaidAttachmentProviderMessageIds = mermaidDelivery.providerMessageIds;
        if (mermaidDelivery.deliveries.some((entry) => entry?.ledger?.status === "failed")) {
          throw new Error("assistant_card_mermaid_file_delivery_failed");
        }
      }

      if (renderPlan.mode === "card_plus_file" && renderPlan.sections.completed) {
        const artifact = await this._writeAssistantCardArtifact(
          currentSession,
          renderPlan.sections.finalText,
        );
        nextState = {
          ...nextState,
          artifactPath: artifact.filePath,
          artifactFileName: artifact.fileName,
        };
        const fileDelivery = await this._ensureAssistantCardFileDelivery(
          {
            ...currentSession,
            card_message_id: cardMessageId,
          },
          artifact,
          nextState,
        );
        nextState.fileLedgerProviderMessageId = fileDelivery.providerMessageId;
        if (fileDelivery.ledger?.status === "failed") {
          throw new Error("assistant_card_file_delivery_failed");
        }
      }

      const beforeCommit = this._getAssistantCardSessionIfCurrent(
        session.session_id,
        normalizedTargetRevision,
      );
      if (beforeCommit.stale) {
        return completeAction({
          skipped: true,
          reason: beforeCommit.reason ?? "stale_revision",
        });
      }
      const finalSession = beforeCommit.session;
      const syncFinishedAt = nowIso();
      nextState = mergeAssistantCardOutboundTelemetry(nextState, {
        lastSyncFinishedAt: syncFinishedAt,
        firstCardSyncCompletedAt: syncFinishedAt,
        lastSyncStatus:
          nextState?.interruptedAt || finalSession.status === "interrupted"
            ? "interrupted"
            : "synced",
        lastAppliedRevision: normalizedTargetRevision,
        lastCardMessageId: cardMessageId,
      });
      this.store.upsertFeishuCardSession({
        sessionId: finalSession.session_id,
        bindingId: finalSession.binding_id,
        localThreadId: finalSession.local_thread_id,
        localTurnId: finalSession.local_turn_id,
        sendIdentity: finalSession.send_identity,
        feishuOpenId: finalSession.feishu_open_id,
        feishuChatId: finalSession.feishu_chat_id,
        cardMessageId,
        mode: renderPlan.mode,
        status:
          nextState?.interruptedAt || finalSession.status === "interrupted"
            ? "interrupted"
            : renderPlan.sections.presentationCompleted
              ? "completed"
              : "processing",
        lastRevision: finalSession.last_revision,
        lastAppliedRevision: normalizedTargetRevision,
        lastRenderHash: renderHash,
        degradedReason: null,
        state: nextState,
      });
      this._completeCoveredPendingCardSyncActions(
        finalSession.session_id,
        normalizedTargetRevision,
        {
          excludeActionId: action?.id ?? null,
        },
      );
      return completeAction({
        ...payload,
        syncedAt: syncFinishedAt,
        cardMessageId,
        mode: renderPlan.mode,
      });
    } catch (error) {
      const permanent = isPermanentAssistantCardSyncError(error);
      if (!permanent) {
        retryAction(error, payload);
        this._setError(error, {
          cardSessionId: session.session_id,
          cardTurnId: session.local_turn_id,
        });
        return {
          retried: action?.id != null,
          retryable: true,
          error: safeErrorMessage(error),
        };
      }
      const degradedAt = nowIso();
      const degradedReason = safeErrorMessage(error);
      const latestSession =
        this.store.getFeishuCardSessionById?.(session.session_id) ?? session;
      this._log?.("warn", "Degraded assistant card session after permanent sync error", {
        cardSessionId: latestSession.session_id,
        cardTurnId: latestSession.local_turn_id,
        reason: degradedReason,
      });
      const degraded = this.store.upsertFeishuCardSession({
        sessionId: latestSession.session_id,
        bindingId: latestSession.binding_id,
        localThreadId: latestSession.local_thread_id,
        localTurnId: latestSession.local_turn_id,
        sendIdentity: latestSession.send_identity,
        feishuOpenId: latestSession.feishu_open_id,
        feishuChatId: latestSession.feishu_chat_id,
        cardMessageId: latestSession.card_message_id,
        mode: "degraded_text",
        status: "degraded",
        lastRevision: latestSession.last_revision,
          lastAppliedRevision: latestSession.last_applied_revision,
          lastRenderHash: latestSession.last_render_hash,
          degradedReason,
          state: mergeAssistantCardOutboundTelemetry(
            {
              ...(latestSession.state_json ?? {}),
              degradedAt,
              degradedReason,
              cardkit:
                latestSession.state_json?.cardkit != null &&
                typeof latestSession.state_json.cardkit === "object"
                  ? {
                      ...latestSession.state_json.cardkit,
                      degradedAt,
                      degradedReason,
                    }
                  : latestSession.state_json?.cardkit,
            },
            {
              lastSyncFinishedAt: degradedAt,
              firstCardSyncCompletedAt: degradedAt,
              lastSyncStatus: "degraded",
              lastRenderMode: "degraded_text",
              lastSyncRevision: normalizedTargetRevision,
              lastSyncError: degradedReason,
              lastCardMessageId: latestSession.card_message_id,
            },
          ),
        });
      const degradedSections = deriveAssistantCardSectionsFromState(degraded.state_json);
      if (degradedSections.completed && !degraded.state_json?.degradationEmitted) {
        const fallback = await this._emitAssistantCardTextFallback(
          degraded,
          degradedSections,
          degraded.state_json,
        ).catch(() => null);
        this.store.upsertFeishuCardSession({
          sessionId: degraded.session_id,
          bindingId: degraded.binding_id,
          localThreadId: degraded.local_thread_id,
          localTurnId: degraded.local_turn_id,
          sendIdentity: degraded.send_identity,
          feishuOpenId: degraded.feishu_open_id,
          feishuChatId: degraded.feishu_chat_id,
          cardMessageId: degraded.card_message_id,
          mode: "degraded_text",
          status: "degraded",
          lastRevision: degraded.last_revision,
          lastAppliedRevision: degraded.last_revision,
          lastRenderHash: degraded.last_render_hash,
          degradedReason: degraded.degraded_reason,
          state: {
            ...(degraded.state_json ?? {}),
            degradationEmitted: true,
            textFallbackProviderMessageId:
              fallback?.providerMessageId ??
              degraded.state_json?.textFallbackProviderMessageId ??
              null,
          },
        });
      }
      completeAction({
        ...payload,
        degradedAt,
        mode: "degraded_text",
        error: degradedReason,
      });
      this._setError(error, {
        cardSessionId: latestSession.session_id,
        cardTurnId: latestSession.local_turn_id,
        cardDegraded: true,
      });
      return {
        degraded: true,
        error: degradedReason,
      };
    }
  }

  async _syncAssistantCardSessionAction(action) {
    let currentAction = action;
    if (action?.id != null && this.store?.getPendingActionById instanceof Function) {
      currentAction = this.store.getPendingActionById(action.id);
      if (currentAction == null || currentAction.status === "completed") {
        return;
      }
    }
    const payload = currentAction?.payload_json ?? {};
    const sessionId = String(payload?.sessionId ?? "").trim();
    if (!sessionId) {
      this.store.completePendingAction(currentAction.id, {
        skipped: true,
        reason: "missing_session_id",
      });
      return;
    }
    const targetRevision = Math.max(0, Number(payload?.targetRevision ?? 0) || 0);
    if (
      targetRevision > 0 &&
      currentAction?.id != null &&
      this.store?.getFeishuCardSessionById instanceof Function &&
      this.store?.completePendingAction instanceof Function
    ) {
      const currentSession = this.store.getFeishuCardSessionById(sessionId);
      const appliedRevision = Math.max(
        0,
        Number(currentSession?.last_applied_revision ?? 0) || 0,
      );
      const currentRevision = Math.max(
        0,
        Number(currentSession?.last_revision ?? 0) || 0,
      );
      const needsFinalizedSync = this._assistantCardSessionNeedsFinalizedSync(currentSession);
      if (appliedRevision >= targetRevision) {
        if (
          !(
            targetRevision > 0 &&
            targetRevision >= currentRevision &&
            needsFinalizedSync
          )
        ) {
          this.store.completePendingAction(currentAction.id, {
            ...payload,
            skipped: true,
            reason: "covered_by_applied_revision",
            coveredByRevision: appliedRevision,
            coveredAt: nowIso(),
          });
          return;
        }
      }
    }
    await this._runAssistantCardSessionSyncExclusive(sessionId, () =>
      this._syncAssistantCardSessionRevision(sessionId, targetRevision, {
        action: currentAction,
      }),
    );
  }

  _shouldSuppressDesktopEcho(event) {
    if (event?.eventType !== "desktop_local_user_message") {
      return false;
    }
    const bindingId = String(event?.bindingId ?? "").trim();
    const eventTurnId = String(event?.message?.turnId ?? "").trim() || null;
    const comparableText = normalizeComparableUserText(
      event?.message?.text ?? formatMirroredText(event),
    );
    const attachmentFingerprint = buildComparableAttachmentFingerprint(
      event?.message?.attachments,
    );
    if (!bindingId || (!eventTurnId && !comparableText && !attachmentFingerprint)) {
      return false;
    }
    let recentInbound =
      eventTurnId != null
        ? this.store.getInboundLedgerByBindingAndLocalTurnId(bindingId, eventTurnId)
        : null;
    let suppressionMode = recentInbound != null ? "turn_id" : null;
    if (recentInbound == null && comparableText.length > 0) {
      recentInbound = this.store.getRecentCommittedInboundByBindingAndText(
        bindingId,
        comparableText,
        15000,
      );
      if (recentInbound != null) {
        suppressionMode = "text";
      }
    }
    if (recentInbound == null && attachmentFingerprint) {
      recentInbound =
        this.store
          .getRecentCommittedInboundByBinding(bindingId, 15000, 8)
          .find(
            (candidate) =>
              buildComparableAttachmentFingerprint(candidate?.raw_json?.attachments) ===
              attachmentFingerprint,
          ) ?? null;
      if (recentInbound != null) {
        suppressionMode = "attachment";
      }
    }
    if (recentInbound == null) {
      return false;
    }
    const exactTurnMatch =
      eventTurnId != null &&
      String(recentInbound.local_turn_id ?? "").trim() === eventTurnId;
    const suppressionKey = `sidecar:suppressedDesktopEcho:${recentInbound.id}`;
    const existing = this.store.getRuntimeState(suppressionKey);
    if (existing?.suppressed === true) {
      return exactTurnMatch;
    }
    this.store.setRuntimeState(suppressionKey, {
      suppressed: true,
      suppressedAt: nowIso(),
      bindingId,
      sourceLedgerId: recentInbound.id,
      providerMessageId: recentInbound.provider_message_id,
      localTurnId: String(recentInbound.local_turn_id ?? "").trim() || null,
      eventTurnId,
      suppressionMode,
      text: comparableText,
      attachmentFingerprint: attachmentFingerprint || null,
    });
    this._log("info", "Suppressed mirrored desktop echo for recent Feishu inbound", {
      bindingId,
      sourceLedgerId: recentInbound.id,
      providerMessageId: recentInbound.provider_message_id,
      localTurnId: String(recentInbound.local_turn_id ?? "").trim() || null,
      eventTurnId,
      suppressionMode,
      text: comparableText,
      attachmentFingerprint: attachmentFingerprint || null,
    });
    return true;
  }

  _getFreshSelfUserMirrorState(key) {
    const state = this.store.getRuntimeState(key);
    if (state == null) {
      return null;
    }
    const seenAtMs = Number(state.seenAtMs ?? 0);
    if (!Number.isFinite(seenAtMs)) {
      return null;
    }
    if (Date.now() - seenAtMs > SELF_USER_MIRROR_TTL_MS) {
      return null;
    }
    return state;
  }

  _markSelfUserMirrorConsumed(key, state, envelope) {
    if (!key || state == null) {
      return;
    }
    this.store.setRuntimeState(key, {
      ...state,
      consumed: true,
      consumedAt: nowIso(),
      consumedInboundMessageId: envelope.messageId,
    });
  }

  _rememberUserIdentityMirror({ bindingId, openId, chatId, text, ledgerId, feishuMessageId }) {
    const normalizedMessageId = String(feishuMessageId ?? "").trim();
    if (!normalizedMessageId) {
      return;
    }
    const comparableText = normalizeComparableUserText(text);
    const payload = {
      bindingId: String(bindingId ?? "").trim() || null,
      openId: String(openId ?? "").trim() || null,
      chatId: String(chatId ?? "").trim() || null,
      ledgerId: ledgerId ?? null,
      comparableText,
      feishuMessageId: normalizedMessageId,
      seenAt: nowIso(),
      seenAtMs: Date.now(),
      consumed: false,
    };
    this.store.setRuntimeState(buildSelfUserMirrorMessageKey(normalizedMessageId), payload);
    this._log("info", "Remembered user-identity outbound mirror for inbound suppression", {
      bindingId: payload.bindingId,
      openId: payload.openId,
      chatId: payload.chatId,
      ledgerId: payload.ledgerId,
      feishuMessageId: payload.feishuMessageId,
      comparableText,
    });
  }

  _shouldSuppressInboundSelfMirror(envelope) {
    const exactKey = buildSelfUserMirrorMessageKey(envelope.messageId);
    const exactState = this._getFreshSelfUserMirrorState(exactKey);
    if (exactState != null) {
      this._markSelfUserMirrorConsumed(exactKey, exactState, envelope);
      this._log("info", "Suppressed inbound self-mirror by exact Feishu message_id", {
        inboundMessageId: envelope.messageId,
        sourceLedgerId: exactState.ledgerId ?? null,
        bindingId: exactState.bindingId ?? null,
      });
      return true;
    }
    return false;
  }

  _attachPipeNotifications() {
    this.pipeClient.on("bridge.turnEvent", (event) =>
      this.handleTurnEvent(event).catch((error) =>
        this._setError(error, { bridgeStatus: "recovering" }),
      ),
    );
    this.pipeClient.registerOnConnect(async () => {
      this.state.pipeConnected = true;
      const subscription = await this.pipeClient.request("bridge.subscribeTurnEvents", {});
      this.turnSubscriptionActive = Boolean(subscription?.ok);
      this._deriveOverallStatus();
    });
  }

  async _connectPipe() {
    await this.pipeClient.ensureConnected();
    this.state.pipeConnected = true;
    this._deriveOverallStatus();
  }

  async _validateCredentials() {
    const response = await this.client.auth.v3.tenantAccessToken.internal({
      data: {
        app_id: this.config.appId,
        app_secret: this.config.appSecret,
      },
    });
    if (response?.code != null && Number(response.code) !== 0) {
      throw new Error(`tenant_access_token_failed:${response.code}:${response.msg ?? ""}`);
    }
    this._setState({
      credentialsValid: true,
      lastTokenCheckAt: nowIso(),
      lastError: null,
    });
  }

  async _startLongConnection() {
    const dispatcher = new Lark.EventDispatcher({
      verificationToken: this.config.verificationToken || undefined,
      encryptKey: this.config.encryptKey || undefined,
      loggerLevel: Lark.LoggerLevel?.info,
    }).register({
      "im.message.receive_v1": async (data) => this.handleReceiveMessage(data),
    });
    this.wsClient = new Lark.WSClient({
      appId: this.config.appId,
      appSecret: this.config.appSecret,
      loggerLevel: Lark.LoggerLevel?.info,
    });
    await this.wsClient.start({ eventDispatcher: dispatcher });
    this.wsStarted = true;
    this._setState({
      wsStarted: true,
      lastError: null,
      wsReconnectInfo: this.wsClient.getReconnectInfo?.() ?? null,
    });
  }

  async _startDiagnosticsServer() {
    const diagnosticsEnabled = Boolean(this.config?.diagnosticsHttp?.enabled);
    const userIdentitySettings = this._getUserIdentitySettings();
    const authEnabled = userIdentitySettings.enabled;
    if (!diagnosticsEnabled && !authEnabled) {
      return;
    }
    const listenHost = diagnosticsEnabled
      ? this.config.diagnosticsHttp.host
      : userIdentitySettings.authHost;
    const listenPort = diagnosticsEnabled
      ? this.config.diagnosticsHttp.port
      : userIdentitySettings.authPort;
    this.diagnosticsServer = http.createServer((request, response) => {
      const requestUrl = new URL(
        request.url ?? "/",
        `http://${listenHost}:${listenPort}`,
      );
      const route = requestUrl.pathname;
      if (route === "/health") {
        this._respondJson(response, 200, this._buildHealthPayload());
        return;
      }
      if (route === "/metrics") {
        response.writeHead(200, { "content-type": "text/plain; charset=utf-8" });
        response.end(this._buildMetricsText());
        return;
      }
      if (route === "/last-error") {
        this._respondJson(response, 200, {
          lastError: this.state.lastError,
          updatedAt: this.state.updatedAt,
        });
        return;
      }
      if (authEnabled && route === userIdentitySettings.statusPath) {
        this._respondJson(response, 200, this._buildUserIdentityStatusPayload());
        return;
      }
      if (authEnabled && route === userIdentitySettings.startPath) {
        void this._handleUserIdentityAuthStart(requestUrl, response);
        return;
      }
      if (authEnabled && route === userIdentitySettings.callbackPath) {
        void this._handleUserIdentityAuthCallback(requestUrl, response);
        return;
      }
      this._respondJson(response, 404, { error: "not_found" });
    });
    await new Promise((resolve, reject) => {
      this.diagnosticsServer.listen(
        listenPort,
        listenHost,
        () => resolve(),
      );
      this.diagnosticsServer.once("error", reject);
    });
    this._setState({
      diagnosticsHttp: {
        ...this.state.diagnosticsHttp,
        listening: true,
        host: listenHost,
        port: listenPort,
      },
    });
  }

  _buildUserIdentityStatusPayload() {
    const settings = this._getUserIdentitySettings();
    const tokenState = this._getStoredUserSendToken(this.defaultOpenId);
    const ready =
      Boolean(tokenState?.accessToken) &&
      Boolean(tokenState?.expiresAt) &&
      new Date(tokenState.expiresAt).getTime() > Date.now();
    const missingAttachmentScopes = getMissingAttachmentScopes(tokenState?.scope);
    const attachmentUserReady = ready && missingAttachmentScopes.length === 0;
    return {
      enabled: settings.enabled,
      defaultOpenId: this.defaultOpenId,
      redirectUri: this._buildUserIdentityRedirectUri(),
      authorizationUrl: this._buildUserIdentityAuthorizationUrl(this.defaultOpenId),
      requestedScope: settings.scope,
      ready,
      tokenOwnerOpenId: tokenState?.openId ?? null,
      tokenScope: tokenState?.scope ?? null,
      requiredAttachmentScopes: [...REQUIRED_USER_ATTACHMENT_SCOPES],
      missingAttachmentScopes,
      attachmentUserReady,
      attachmentDeliveryMode: settings.enabled
        ? attachmentUserReady
          ? "user"
          : "blocked_until_user_scope_granted"
        : "disabled",
      accessTokenExpiresAt: tokenState?.expiresAt ?? null,
      refreshTokenExpiresAt: tokenState?.refreshTokenExpiresAt ?? null,
      lastAuthorizedAt: tokenState?.authorizedAt ?? null,
    };
  }

  async _handleUserIdentityAuthStart(requestUrl, response) {
    const settings = this._getUserIdentitySettings();
    if (!settings.enabled) {
      this._respondJson(response, 404, { error: "user_identity_send_disabled" });
      return;
    }
    const openId =
      String(
        requestUrl.searchParams.get("open_id") ??
          this.defaultOpenId ??
          "",
      ).trim() || null;
    if (!openId) {
      this._respondJson(response, 400, { error: "missing_open_id" });
      return;
    }
    const state = randomBase64Url(24);
    const codeVerifier = randomBase64Url(48);
    const pendingState = {
      openId,
      state,
      createdAt: nowIso(),
      expiresAt: new Date(Date.now() + 10 * 60 * 1000).toISOString(),
      redirectUri: this._buildUserIdentityRedirectUri(),
      codeVerifier,
      scope: settings.scope,
      prompt: settings.prompt,
    };
    this.store.setRuntimeState(buildUserSendAuthStateKey(state), pendingState);

    const authUrl = new URL("https://accounts.feishu.cn/open-apis/authen/v1/authorize");
    authUrl.searchParams.set("client_id", this.config.appId);
    authUrl.searchParams.set("response_type", "code");
    authUrl.searchParams.set("redirect_uri", pendingState.redirectUri);
    authUrl.searchParams.set("scope", pendingState.scope);
    authUrl.searchParams.set("state", state);
    authUrl.searchParams.set("prompt", settings.prompt);
    authUrl.searchParams.set("code_challenge", sha256Base64Url(codeVerifier));
    authUrl.searchParams.set("code_challenge_method", "S256");

    response.writeHead(302, {
      location: authUrl.toString(),
      "cache-control": "no-store",
    });
    response.end();
  }

  async _handleUserIdentityAuthCallback(requestUrl, response) {
    const state = String(requestUrl.searchParams.get("state") ?? "").trim();
    const code = String(requestUrl.searchParams.get("code") ?? "").trim();
    const error = String(requestUrl.searchParams.get("error") ?? "").trim();
    const pending = state ? this.store.getRuntimeState(buildUserSendAuthStateKey(state)) : null;
    if (!pending || !state) {
      this._respondOAuthHtml(
        response,
        400,
        "授权状态无效",
        "本次 OAuth 状态已丢失或已过期，请重新发起授权。",
      );
      return;
    }
    if (new Date(pending.expiresAt).getTime() <= Date.now()) {
      this._respondOAuthHtml(
        response,
        400,
        "授权状态已过期",
        "请重新发起授权，旧的 state 已失效。",
      );
      return;
    }
    if (error) {
      this._respondOAuthHtml(
        response,
        400,
        "用户未授权",
        `飞书返回：${escapeHtml(error)}`,
      );
      return;
    }
    if (!code) {
      this._respondOAuthHtml(
        response,
        400,
        "缺少授权码",
        "回调中没有收到 code，无法换取 user_access_token。",
      );
      return;
    }

    try {
      const tokenPayload = await this._exchangeUserAccessToken({
        code,
        redirectUri: pending.redirectUri,
        codeVerifier: pending.codeVerifier,
      });
      const userInfo = await this._fetchUserInfo(tokenPayload.access_token);
      const tokenOpenId = String(userInfo?.data?.open_id ?? "").trim();
      if (!tokenOpenId) {
        throw new Error("user_info_missing_open_id");
      }
      this._setStoredUserSendToken(tokenOpenId, {
        openId: tokenOpenId,
        requestedOpenId: pending.openId,
        accessToken: tokenPayload.access_token,
        expiresAt: new Date(Date.now() + Number(tokenPayload.expires_in ?? 0) * 1000).toISOString(),
        refreshToken: tokenPayload.refresh_token ?? null,
        refreshTokenExpiresAt:
          tokenPayload.refresh_token_expires_in != null
            ? new Date(
                Date.now() + Number(tokenPayload.refresh_token_expires_in) * 1000,
              ).toISOString()
            : null,
        scope: tokenPayload.scope ?? pending.scope,
        tokenType: tokenPayload.token_type ?? "Bearer",
        authorizedAt: nowIso(),
        userInfo: userInfo?.data ?? null,
      });
      this.store.setRuntimeState(buildUserSendAuthStateKey(state), {
        ...pending,
        status: "completed",
        completedAt: nowIso(),
        tokenOpenId,
      });
      this._refreshUserIdentityStatus();
      this._respondOAuthHtml(
        response,
        200,
        "飞书用户身份授权成功",
        tokenOpenId === pending.openId
          ? `已为 ${escapeHtml(tokenOpenId)} 写入 user_access_token，可用于桌面端用户消息的“以用户身份发送”。`
          : `授权成功，但 token 属于 ${escapeHtml(tokenOpenId)}，与请求的 ${escapeHtml(pending.openId)} 不一致；已按真实 token 所属 open_id 保存。`,
      );
    } catch (authError) {
      this.store.setRuntimeState(buildUserSendAuthStateKey(state), {
        ...pending,
        status: "failed",
        failedAt: nowIso(),
        error: safeErrorMessage(authError),
      });
      this._setError(authError, {});
      this._respondOAuthHtml(
        response,
        500,
        "飞书用户身份授权失败",
        escapeHtml(safeErrorMessage(authError)),
      );
    }
  }

  _respondOAuthHtml(response, statusCode, title, detail) {
    response.writeHead(statusCode, {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
    });
    response.end(`<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><title>${escapeHtml(title)}</title><style>body{font-family:'Microsoft YaHei',sans-serif;background:#f7f9fc;color:#17324d;padding:32px;}main{max-width:720px;margin:0 auto;background:#fff;border-radius:16px;padding:28px 32px;box-shadow:0 12px 32px rgba(15,23,42,.08)}h1{font-size:24px;margin:0 0 12px}p{line-height:1.7;margin:0}</style></head><body><main><h1>${escapeHtml(title)}</h1><p>${detail}</p></main></body></html>`);
  }

  async _exchangeUserAccessToken({ code, redirectUri, codeVerifier }) {
    const response = await httpJsonRequest(
      "https://open.feishu.cn/open-apis/authen/v2/oauth/token",
      {
        method: "POST",
        headers: {
          "content-type": "application/json; charset=utf-8",
        },
        body: JSON.stringify({
          grant_type: "authorization_code",
          client_id: this.config.appId,
          client_secret: this.config.appSecret,
          code,
          redirect_uri: redirectUri,
          code_verifier: codeVerifier,
        }),
      },
    );
    if (!response.ok || Number(response.data?.code ?? 0) !== 0) {
      throw new Error(
        `user_access_token_exchange_failed:${response.status}:${response.data?.code ?? "no_code"}:${response.data?.error_description ?? response.data?.msg ?? response.text}`,
      );
    }
    return response.data;
  }

  async _refreshUserAccessToken(tokenState) {
    if (!tokenState?.refreshToken) {
      throw new Error("user_refresh_token_missing");
    }
    const response = await httpJsonRequest(
      "https://open.feishu.cn/open-apis/authen/v2/oauth/token",
      {
        method: "POST",
        headers: {
          "content-type": "application/json; charset=utf-8",
        },
        body: JSON.stringify({
          grant_type: "refresh_token",
          client_id: this.config.appId,
          client_secret: this.config.appSecret,
          refresh_token: tokenState.refreshToken,
        }),
      },
    );
    if (!response.ok || Number(response.data?.code ?? 0) !== 0) {
      throw new Error(
        `user_access_token_refresh_failed:${response.status}:${response.data?.code ?? "no_code"}:${response.data?.error_description ?? response.data?.msg ?? response.text}`,
      );
    }
    const merged = {
      ...tokenState,
      accessToken: response.data.access_token,
      expiresAt: new Date(Date.now() + Number(response.data.expires_in ?? 0) * 1000).toISOString(),
      refreshToken: response.data.refresh_token ?? tokenState.refreshToken ?? null,
      refreshTokenExpiresAt:
        response.data.refresh_token_expires_in != null
          ? new Date(
              Date.now() + Number(response.data.refresh_token_expires_in) * 1000,
            ).toISOString()
          : tokenState.refreshTokenExpiresAt ?? null,
      scope: response.data.scope ?? tokenState.scope ?? null,
      tokenType: response.data.token_type ?? tokenState.tokenType ?? "Bearer",
      refreshedAt: nowIso(),
    };
    this._setStoredUserSendToken(merged.openId, merged);
    this._refreshUserIdentityStatus();
    return merged;
  }

  async _fetchUserInfo(accessToken) {
    const response = await httpJsonRequest("https://open.feishu.cn/open-apis/authen/v1/user_info", {
      method: "GET",
      headers: {
        authorization: `Bearer ${accessToken}`,
      },
    });
    if (!response.ok || Number(response.data?.code ?? 0) !== 0) {
      throw new Error(
        `user_info_fetch_failed:${response.status}:${response.data?.code ?? "no_code"}:${response.data?.msg ?? response.text}`,
      );
    }
    return response.data;
  }

  async _ensureUserSendToken(openId) {
    let tokenState = this._getStoredUserSendToken(openId);
    if (tokenState == null) {
      const authorizationUrl = this._buildUserIdentityAuthorizationUrl(openId);
      throw new Error(`user_send_auth_required:${authorizationUrl}`);
    }
    const expiresAtMs = new Date(tokenState.expiresAt ?? 0).getTime();
    if (!Number.isFinite(expiresAtMs) || expiresAtMs <= Date.now() + 60 * 1000) {
      tokenState = await this._refreshUserAccessToken(tokenState);
    }
    return tokenState;
  }

  _buildAttachmentUserReauthError(openId, missingScopes) {
    const authorizationUrl = this._buildUserIdentityAuthorizationUrl(openId);
    const scopeList = Array.isArray(missingScopes) ? missingScopes.filter(Boolean) : [];
    return new Error(
      `user_send_auth_required:${authorizationUrl}|reason=attachment_scope_missing|missing_scopes=${scopeList.join(",")}`,
    );
  }

  _assertUserAttachmentScopes(openId, tokenState) {
    const missingScopes = getMissingAttachmentScopes(tokenState?.scope);
    if (missingScopes.length === 0) {
      return;
    }
    this._log("warn", "user_identity_attachment_scope_missing", {
      openId,
      missingScopes,
      configuredScope: this._getUserIdentitySettings().scope,
      tokenScope: tokenState?.scope ?? null,
    });
    throw this._buildAttachmentUserReauthError(openId, missingScopes);
  }

  _normalizeAttachmentUserUploadError(openId, tokenState, error) {
    const code = String(error?.response?.data?.code ?? error?.code ?? "").trim();
    if (code === "99991679") {
      const missingScopes = getMissingAttachmentScopes(tokenState?.scope);
      const requiredScopes =
        missingScopes.length > 0 ? missingScopes : [...REQUIRED_USER_ATTACHMENT_SCOPES];
      this._log("warn", "user_identity_attachment_upload_scope_rejected", {
        openId,
        requiredScopes,
        configuredScope: this._getUserIdentitySettings().scope,
        tokenScope: tokenState?.scope ?? null,
        error: safeErrorMessage(error),
      });
      return this._buildAttachmentUserReauthError(openId, requiredScopes);
    }
    return error;
  }

  _startMaintenanceLoops() {
    this.healthTimer = setInterval(() => {
      void this._refreshBridgeHealth();
      if (this.wsClient?.getReconnectInfo instanceof Function) {
        this._setState({
          wsReconnectInfo: this.wsClient.getReconnectInfo(),
        });
      }
    }, 5000);
    this.healthTimer.unref?.();

    this.queueTimer = setInterval(() => {
      void this._drainQueues();
    }, Math.max(1500, Number(this.config?.runtime?.pollIntervalMs ?? 2000)));
    this.queueTimer.unref?.();
  }

  async _refreshBridgeHealth() {
    try {
      const health = await this.pipeClient.request("bridge.health", {});
      this.state.pipeConnected = true;
      this._setState({
        bridgeStatus: health?.status ?? "unknown",
        activeThreadId:
          health?.activeThread?.localThreadId ??
          health?.activeThread?.localConversationId ??
          null,
        lastError: null,
      });
    } catch (error) {
      this.state.pipeConnected = false;
      this._setError(error, { bridgeStatus: "recovering" });
      await this._connectPipe().catch(() => void 0);
    }
  }

  async _drainQueues() {
    this.queueDrainPromise = this.queueDrainPromise
      .catch(() => void 0)
      .then(async () => {
        await this._drainPendingLocalCommits();
        await this._drainPendingFeishuDeliveries();
        await this._drainPendingCardSyncActions();
        await this._drainPendingFeishuDeliveries();
        this._updatePendingCounts();
        this._deriveOverallStatus();
      });
    return this.queueDrainPromise;
  }

  async _drainPendingLocalCommits() {
    const pending = this.store
      .listReadyPendingActions()
      .filter((action) => action.action_type === "pending_local_commit");
    for (const action of pending.slice(0, 20)) {
      this.store.completePendingAction(action.id, {
        ...(action.payload_json ?? {}),
        skipped: true,
        reason: "recovery_replay_disabled",
        skippedAt: nowIso(),
      });
    }
  }

  async _drainPendingFeishuDeliveries() {
    await this._enqueueFeishuDeliveryDrain();
  }

  _getPendingCardSyncActionSessionId(action) {
    return String(action?.payload_json?.sessionId ?? "").trim();
  }

  _getPendingCardSyncActionTargetRevision(action) {
    return Math.max(0, Number(action?.payload_json?.targetRevision ?? 0) || 0);
  }

  _coalescePendingCardSyncActions(actions) {
    const selected = [];
    const selectedBySessionId = new Map();
    const skipped = [];
    for (const action of Array.isArray(actions) ? actions : []) {
      const sessionId = this._getPendingCardSyncActionSessionId(action);
      if (!sessionId) {
        selected.push(action);
        continue;
      }
      const existing = selectedBySessionId.get(sessionId);
      if (existing == null) {
        selectedBySessionId.set(sessionId, action);
        selected.push(action);
        continue;
      }
      const actionRevision = this._getPendingCardSyncActionTargetRevision(action);
      const existingRevision = this._getPendingCardSyncActionTargetRevision(existing);
      const actionId = Number(action?.id ?? 0) || 0;
      const existingId = Number(existing?.id ?? 0) || 0;
      const actionIsNewer =
        actionRevision > existingRevision ||
        (actionRevision === existingRevision && actionId > existingId);
      if (actionIsNewer) {
        const existingIndex = selected.indexOf(existing);
        if (existingIndex >= 0) {
          selected[existingIndex] = action;
        } else {
          selected.push(action);
        }
        selectedBySessionId.set(sessionId, action);
        skipped.push({ action: existing, supersededBy: action });
      } else {
        skipped.push({ action, supersededBy: existing });
      }
    }
    return { selected, skipped };
  }

  _completeCoveredPendingCardSyncActions(
    sessionId,
    appliedRevision,
    { excludeActionId = null } = {},
  ) {
    const normalizedSessionId = String(sessionId ?? "").trim();
    const normalizedAppliedRevision = Math.max(0, Number(appliedRevision ?? 0) || 0);
    if (
      !normalizedSessionId ||
      normalizedAppliedRevision <= 0 ||
      !(this.store?.listPendingActions instanceof Function) ||
      !(this.store?.completePendingAction instanceof Function)
    ) {
      return 0;
    }
    const excludedId = Number(excludeActionId ?? 0) || null;
    const coveredAt = nowIso();
    let completed = 0;
    for (const action of this.store.listPendingActions()) {
      if (action?.action_type !== "feishu_card_sync") {
        continue;
      }
      if (excludedId != null && Number(action?.id ?? 0) === excludedId) {
        continue;
      }
      if (this._getPendingCardSyncActionSessionId(action) !== normalizedSessionId) {
        continue;
      }
      const targetRevision = this._getPendingCardSyncActionTargetRevision(action);
      if (targetRevision > normalizedAppliedRevision) {
        continue;
      }
      this.store.completePendingAction(action.id, {
        ...(action.payload_json ?? {}),
        skipped: true,
        reason: "covered_by_applied_revision",
        coveredByRevision: normalizedAppliedRevision,
        coveredAt,
      });
      completed += 1;
    }
    return completed;
  }

  async _drainPendingCardSyncActions() {
    const allPending = this.store
      .listReadyPendingActions()
      .filter((action) => action.action_type === "feishu_card_sync");
    const pending = [];
    for (const action of allPending) {
      if (this._isLedgerFromCurrentSidecarRun(action)) {
        pending.push(action);
        continue;
      }
      this.store.completePendingAction(action.id, {
        ...(action.payload_json ?? {}),
        skipped: true,
        reason: "recovery_replay_disabled",
        skippedAt: nowIso(),
      });
    }
    const { selected, skipped } = this._coalescePendingCardSyncActions(pending);
    for (const { action, supersededBy } of skipped) {
      this.store.completePendingAction(action.id, {
        ...(action.payload_json ?? {}),
        skipped: true,
        reason: "superseded_card_sync_action",
        supersededByActionId: supersededBy?.id ?? null,
        supersededByTargetRevision:
          supersededBy == null
            ? null
            : this._getPendingCardSyncActionTargetRevision(supersededBy),
        skippedAt: nowIso(),
      });
    }
    for (const action of selected.slice(0, 20)) {
      await this._syncAssistantCardSessionAction(action);
    }
  }

  _isLedgerFromCurrentSidecarRun(ledger) {
    const createdMs = Date.parse(String(ledger?.created_at ?? ""));
    const startedMs = Date.parse(String(this.state?.startedAt ?? ""));
    if (!Number.isFinite(createdMs) || !Number.isFinite(startedMs)) {
      return true;
    }
    return createdMs >= startedMs;
  }

  _enqueueFeishuDeliveryDrain() {
    this.deliveryDrainPromise = this.deliveryDrainPromise
      .catch(() => void 0)
      .then(async () => {
        const allLedgers = sortFeishuDeliveryLedgers(
          this.store.listMessageLedgerByStatus(
            ["pending_feishu_delivery", "delivery_retry"],
            "outbound",
          ),
        );
        const ledgers = [];
        for (const ledger of allLedgers) {
          if (this._isLedgerFromCurrentSidecarRun(ledger)) {
            ledgers.push(ledger);
            continue;
          }
          this.store.updateMessageLedgerStatusById(ledger.id, "failed");
          this.store.recordDeliveryAttempt(
            ledger.id,
            "feishu:recovery_replay_disabled",
            "failed",
            "recovery_replay_disabled",
          );
        }
        for (const ledger of ledgers.slice(0, 20)) {
          await this._deliverLedgerToFeishu(ledger);
        }
      });
    return this.deliveryDrainPromise;
  }

  _getMirroredAttachmentsFromLedger(ledger) {
    return normalizeMirroredAttachments(ledger?.raw_json?.attachments);
  }

  _buildAttachmentFileName(attachment, mimeType = null) {
    const explicitName = String(attachment?.name ?? "").trim();
    if (explicitName) {
      return explicitName;
    }
    const sourcePath = String(attachment?.sourcePath ?? "").trim();
    if (sourcePath) {
      return path.basename(sourcePath);
    }
    const sourceUrl = String(attachment?.sourceUrl ?? "").trim();
    if (sourceUrl) {
      try {
        const parsedUrl = new URL(sourceUrl);
        const basename = path.basename(decodeURIComponent(parsedUrl.pathname));
        if (basename) {
          return basename;
        }
      } catch {
        // Ignore malformed URLs and fall back below.
      }
    }
    const kind = inferAttachmentKind(attachment);
    const extension = inferExtensionFromMimeType(mimeType ?? attachment?.mimeType ?? null);
    return `${kind}${extension}`;
  }

  async _resolveMirroredAttachmentPayload(attachment) {
    const sourcePath = String(attachment?.sourcePath ?? "").trim();
    const sourceUrl = String(attachment?.sourceUrl ?? "").trim();
    const dataUrl = String(attachment?.dataUrl ?? "").trim();
    let buffer = null;
    let mimeType = String(attachment?.mimeType ?? "").trim() || null;
    let sourceLabel = null;
    if (sourcePath) {
      buffer = await fs.promises.readFile(sourcePath);
      sourceLabel = sourcePath;
      mimeType = mimeType ?? guessMimeTypeFromName(sourcePath);
    } else if (dataUrl) {
      const parsed = parseDataUrlToBuffer(dataUrl);
      if (parsed == null) {
        throw new Error("attachment_data_url_invalid");
      }
      buffer = parsed.buffer;
      sourceLabel = "data_url";
      mimeType = mimeType ?? parsed.mimeType ?? null;
    } else if (sourceUrl) {
      if (/^file:/i.test(sourceUrl)) {
        const filePath = fileURLToPath(sourceUrl);
        buffer = await fs.promises.readFile(filePath);
        sourceLabel = filePath;
        mimeType = mimeType ?? guessMimeTypeFromName(filePath);
      } else {
        const response = await fetch(sourceUrl);
        if (!response.ok) {
          throw new Error(`attachment_fetch_failed:${response.status}`);
        }
        buffer = Buffer.from(await response.arrayBuffer());
        sourceLabel = sourceUrl;
        mimeType = mimeType ?? response.headers.get("content-type") ?? null;
      }
    } else {
      throw new Error("attachment_source_unavailable");
    }
    if (!Buffer.isBuffer(buffer) || buffer.length === 0) {
      throw new Error("attachment_payload_empty");
    }
    const resolvedMimeType =
      String(mimeType ?? "").trim() ||
      guessMimeTypeFromName(this._buildAttachmentFileName(attachment, mimeType)) ||
      "application/octet-stream";
    const fileName = this._buildAttachmentFileName(attachment, resolvedMimeType);
    return {
      ...attachment,
      kind: inferAttachmentKind({ ...attachment, mimeType: resolvedMimeType }),
      buffer,
      mimeType: resolvedMimeType,
      fileName,
      fileType: inferFeishuFileType({
        name: fileName,
        mimeType: resolvedMimeType,
      }),
      sourceLabel,
    };
  }

  async _parseFetchJsonResponse(prefix, response) {
    const text = await response.text();
    let payload = null;
    try {
      payload = text ? JSON.parse(text) : null;
    } catch {
      payload = text;
    }
    if (!response.ok || Number(payload?.code ?? 0) !== 0) {
      throw createFeishuHttpError(prefix, {
        status: response.status,
        data: payload,
        text,
      });
    }
    return payload;
  }

  async _uploadAttachmentAsBot(resolvedAttachment) {
    if (!this.client) {
      throw new Error("feishu_client_unavailable");
    }
    if (resolvedAttachment.kind === "image") {
      const response = await this.client.im.v1.image.create({
        data: {
          image_type: "message",
          image: resolvedAttachment.buffer,
        },
      });
      if (response?.code != null && Number(response.code) !== 0) {
        throw createFeishuHttpError("feishu_image_upload_failed", response);
      }
      return {
        msgType: "image",
        content: {
          image_key: extractFeishuUploadKey(response, "image_key"),
        },
        response,
      };
    }
    const response = await this.client.im.v1.file.create({
      data: {
        file_type: resolvedAttachment.fileType,
        file_name: resolvedAttachment.fileName,
        file: resolvedAttachment.buffer,
      },
    });
    if (response?.code != null && Number(response.code) !== 0) {
      throw createFeishuHttpError("feishu_file_upload_failed", response);
    }
    return {
      msgType: "file",
      content: {
        file_key: extractFeishuUploadKey(response, "file_key"),
      },
      response,
    };
  }

  async _uploadAttachmentAsUser(openId, resolvedAttachment) {
    const tokenState = await this._ensureUserSendToken(openId);
    this._assertUserAttachmentScopes(openId, tokenState);
    const form = new FormData();
    if (resolvedAttachment.kind === "image") {
      form.append("image_type", "message");
      form.append(
        "image",
        new Blob([resolvedAttachment.buffer], {
          type: resolvedAttachment.mimeType || "application/octet-stream",
        }),
        resolvedAttachment.fileName,
      );
      const response = await fetch("https://open.feishu.cn/open-apis/im/v1/images", {
        method: "POST",
        headers: {
          authorization: `Bearer ${tokenState.accessToken}`,
        },
        body: form,
      });
      let payload;
      try {
        payload = await this._parseFetchJsonResponse(
          "feishu_user_image_upload_failed",
          response,
        );
      } catch (error) {
        throw this._normalizeAttachmentUserUploadError(openId, tokenState, error);
      }
      return {
        msgType: "image",
        content: {
          image_key: extractFeishuUploadKey(payload, "image_key"),
        },
        response: payload,
      };
    }
    form.append("file_type", resolvedAttachment.fileType);
    form.append("file_name", resolvedAttachment.fileName);
    form.append(
      "file",
      new Blob([resolvedAttachment.buffer], {
        type: resolvedAttachment.mimeType || "application/octet-stream",
      }),
      resolvedAttachment.fileName,
    );
    const response = await fetch("https://open.feishu.cn/open-apis/im/v1/files", {
      method: "POST",
      headers: {
        authorization: `Bearer ${tokenState.accessToken}`,
      },
      body: form,
    });
    let payload;
    try {
      payload = await this._parseFetchJsonResponse(
        "feishu_user_file_upload_failed",
        response,
      );
    } catch (error) {
      throw this._normalizeAttachmentUserUploadError(openId, tokenState, error);
    }
    return {
      msgType: "file",
      content: {
        file_key: extractFeishuUploadKey(payload, "file_key"),
      },
      response: payload,
    };
  }

  async _prepareMirroredAttachmentMessage(openId, attachment, { asUser = false } = {}) {
    const resolvedAttachment = await this._resolveMirroredAttachmentPayload(attachment);
    const uploaded = asUser
      ? await this._uploadAttachmentAsUser(openId, resolvedAttachment)
      : await this._uploadAttachmentAsBot(resolvedAttachment);
    const key =
      uploaded.msgType === "image"
        ? String(uploaded?.content?.image_key ?? "").trim() || null
        : String(uploaded?.content?.file_key ?? "").trim() || null;
    if (!key) {
      throw createAttachmentUploadKeyMissingError(uploaded.msgType, uploaded.response);
    }
    return {
      ...uploaded,
      resolvedAttachment,
    };
  }

  _buildAttachmentUploadFallbackText({ sanitizedText, attachments, error }) {
    const names = (Array.isArray(attachments) ? attachments : [])
      .map((attachment) =>
        String(
          attachment?.name ??
            attachment?.sourcePath ??
            attachment?.sourceUrl ??
            attachment?.kind ??
            "",
        ).trim(),
      )
      .filter(Boolean)
      .slice(0, 5);
    const reason = safeErrorMessage(error);
    const note = [
      "[attachment sync degraded]",
      `reason: ${reason}`,
      "action: stopped attachment retry; delivered text only",
      names.length > 0 ? `attachments: ${names.join(", ")}` : null,
    ]
      .filter(Boolean)
      .join("; ");
    const text = String(sanitizedText ?? "").trim();
    return text ? `${text}\n\n${note}` : note;
  }

  async _deliverLedgerAttachmentUploadFallback({
    ledger,
    sanitizedText,
    attachments,
    receiveOpenId,
    receiveChatId,
    useUserIdentity,
    deliveryUuid,
    measurementReceiveId,
    deliveryKey,
    error,
  }) {
    const fallbackText = this._buildAttachmentUploadFallbackText({
      sanitizedText,
      attachments,
      error,
    });
    const fallbackPayloads = buildFeishuTextPayloads(fallbackText, {
      receiveId: measurementReceiveId,
      uuid: deliveryUuid,
      maxRequestBytes: FEISHU_TEXT_REQUEST_MAX_BYTES,
    });
    for (let index = 0; index < fallbackPayloads.length; index += 1) {
      const chunkText = fallbackPayloads[index];
      const chunkUuid =
        fallbackPayloads.length === 1
          ? buildFeishuDeliveryUuid(
              `${String(ledger.provider_message_id ?? ledger.id ?? deliveryKey)}#attachment-fallback`,
            ) || deliveryUuid
          : buildFeishuDeliveryUuid(
              `${String(ledger.provider_message_id ?? ledger.id ?? deliveryKey)}#attachment-fallback#${index + 1}`,
            ) || deliveryUuid;
      const response = await this.sendPrivateText(receiveOpenId, chunkText, {
        asUser: useUserIdentity,
        chatId: receiveChatId,
        uuid: chunkUuid,
      });
      if (useUserIdentity) {
        const deliveredMessageId =
          String(response?.data?.message_id ?? response?.message_id ?? "").trim() || null;
        this._rememberUserIdentityMirror({
          bindingId: ledger.binding_id,
          openId: receiveOpenId,
          chatId: receiveChatId,
          text: chunkText,
          ledgerId: ledger.id,
          feishuMessageId: deliveredMessageId,
        });
      }
    }
    return fallbackPayloads.length > 0;
  }

  _patchMessageLedgerDeliveryTelemetry(ledger, patch) {
    if (ledger == null || !(this.store?.updateMessageLedgerRawPayloadById instanceof Function)) {
      return ledger;
    }
    const raw =
      ledger.raw_json != null && typeof ledger.raw_json === "object" && !Array.isArray(ledger.raw_json)
        ? ledger.raw_json
        : {};
    const nextRaw = {
      ...raw,
      deliveryTelemetry: mergeMessageLedgerDeliveryTelemetry(raw.deliveryTelemetry, patch),
    };
    try {
      return this.store.updateMessageLedgerRawPayloadById(ledger.id, nextRaw) ?? {
        ...ledger,
        raw_json: nextRaw,
      };
    } catch (error) {
      this._log?.("warn", "Failed to update outbound delivery telemetry", {
        ledgerId: ledger.id,
        error: safeErrorMessage(error),
      });
      return {
        ...ledger,
        raw_json: nextRaw,
      };
    }
  }

  async _deliverLedgerToFeishu(ledger) {
    if (ledger == null) {
      return;
    }
    const deliveryKey = String(ledger.id ?? "").trim();
    if (!deliveryKey) {
      return;
    }
    if (this.deliveryLocks.has(deliveryKey)) {
      return;
    }
    if (ledger.status === "delivered" || ledger.status === "failed") {
      return;
    }
    const raw = ledger.raw_json ?? {};
    const receiveOpenId =
      String(raw?.feishuOpenId ?? this.defaultOpenId ?? "").trim() || null;
    const receiveChatId = String(raw?.feishuChatId ?? "").trim() || null;
    const deliveryUuid =
      buildFeishuDeliveryUuid(String(ledger.provider_message_id ?? ledger.id ?? "").trim()) ||
      null;
    const useUserIdentity =
      this._getUserIdentitySettings().enabled &&
      ledger.origin === "desktop_local" &&
      ledger.role === "user";
    if (!receiveOpenId) {
      const failedAt = nowIso();
      this._patchMessageLedgerDeliveryTelemetry(ledger, {
        deliveryStartedAt: failedAt,
        deliveryCompletedAt: failedAt,
        deliveryStatus: "failed",
        deliveryDestination: "feishu:open_id:missing",
        deliveryError: "receive_open_id_unavailable",
      });
      this.store.updateMessageLedgerStatusById(ledger.id, "failed");
      this.store.recordDeliveryAttempt(
        ledger.id,
        "feishu:open_id:missing",
        "failed",
        "receive_open_id_unavailable",
      );
      return;
    }
    const deliveryDestination = useUserIdentity
      ? `feishu:user:${receiveChatId || receiveOpenId}`
      : `feishu:open_id:${receiveOpenId}`;
    let activeLedger = ledger;
    let sanitizedText = "";
    let textPayloads = [];
    let attachments = [];
    let measurementReceiveId = receiveOpenId;
    this.deliveryLocks.add(deliveryKey);
    try {
      activeLedger = this._patchMessageLedgerDeliveryTelemetry(activeLedger, {
        deliveryStartedAt: nowIso(),
        deliveryStatus: "started",
        deliveryDestination,
        deliveryIdentity: useUserIdentity ? "user" : "bot",
      });
      sanitizedText = sanitizeLedgerTextForFeishu(activeLedger);
      measurementReceiveId = useUserIdentity && receiveChatId ? receiveChatId : receiveOpenId;
      const originalTextRequestBytes = measureFeishuTextRequestBytes({
        receiveId: measurementReceiveId,
        text: sanitizedText,
        uuid: deliveryUuid,
      });
      textPayloads = buildFeishuTextPayloads(sanitizedText, {
        receiveId: measurementReceiveId,
        uuid: deliveryUuid,
        maxRequestBytes: FEISHU_TEXT_REQUEST_MAX_BYTES,
      });
      if (textPayloads.length > 1) {
        this._log("info", "Split outbound Feishu text message into chunks", {
          ledgerId: ledger.id,
          bindingId: ledger.binding_id,
          providerMessageId: ledger.provider_message_id,
          originalUtf8Bytes: measureUtf8Bytes(sanitizedText),
          originalRequestBytes: originalTextRequestBytes,
          chunkCount: textPayloads.length,
        });
      }
      attachments = this._getMirroredAttachmentsFromLedger(activeLedger);
      if (textPayloads.length === 0 && attachments.length === 0) {
        activeLedger = this._patchMessageLedgerDeliveryTelemetry(activeLedger, {
          deliveryCompletedAt: nowIso(),
          deliveryStatus: "delivered",
          deliveryDestination,
          deliveryIdentity: useUserIdentity ? "user" : "bot",
        });
        this.store.updateMessageLedgerStatusById(ledger.id, "delivered");
        return;
      }
      const preparedAttachments = [];
      for (let index = 0; index < attachments.length; index += 1) {
        preparedAttachments.push(
          await this._prepareMirroredAttachmentMessage(
            receiveOpenId,
            attachments[index],
            {
              asUser: useUserIdentity,
            },
          ),
        );
      }
      for (let index = 0; index < textPayloads.length; index += 1) {
        const chunkText = textPayloads[index];
        const chunkUuid =
          textPayloads.length === 1
            ? deliveryUuid
            : buildFeishuDeliveryUuid(
                `${String(ledger.provider_message_id ?? ledger.id ?? deliveryKey)}#${index + 1}`,
              ) || deliveryUuid;
        const response = await this.sendPrivateText(receiveOpenId, chunkText, {
          asUser: useUserIdentity,
          chatId: receiveChatId,
          uuid: chunkUuid,
        });
        if (useUserIdentity) {
          const deliveredMessageId =
            String(response?.data?.message_id ?? response?.message_id ?? "").trim() || null;
          this._rememberUserIdentityMirror({
            bindingId: ledger.binding_id,
            openId: receiveOpenId,
            chatId: receiveChatId,
            text: chunkText,
            ledgerId: ledger.id,
            feishuMessageId: deliveredMessageId,
          });
        }
      }
      for (let index = 0; index < preparedAttachments.length; index += 1) {
        const prepared = preparedAttachments[index];
        const attachmentUuid =
          buildFeishuDeliveryUuid(
            `${String(ledger.provider_message_id ?? ledger.id ?? deliveryKey)}#attachment#${index + 1}`,
          ) || deliveryUuid;
        const response = await this.sendPrivateMessage(receiveOpenId, {
          asUser: useUserIdentity,
          chatId: receiveChatId,
          msgType: prepared.msgType,
          content: prepared.content,
          uuid: attachmentUuid,
        });
        if (useUserIdentity) {
          const deliveredMessageId =
            String(response?.data?.message_id ?? response?.message_id ?? "").trim() || null;
          this._rememberUserIdentityMirror({
            bindingId: ledger.binding_id,
            openId: receiveOpenId,
            chatId: receiveChatId,
            text: "",
            ledgerId: ledger.id,
            feishuMessageId: deliveredMessageId,
          });
        }
      }
      activeLedger = this._patchMessageLedgerDeliveryTelemetry(activeLedger, {
        deliveryCompletedAt: nowIso(),
        deliveryStatus: "delivered",
        deliveryDestination,
        deliveryIdentity: useUserIdentity ? "user" : "bot",
      });
      this.store.updateMessageLedgerStatusById(ledger.id, "delivered");
      this.store.recordDeliveryAttempt(
        ledger.id,
        deliveryDestination,
        "delivered",
        null,
      );
    } catch (error) {
      const uploadKeyMissing = isAttachmentUploadKeyMissingError(error);
      if (uploadKeyMissing) {
        let fallbackDelivered = false;
        try {
          fallbackDelivered = await this._deliverLedgerAttachmentUploadFallback({
            ledger,
            sanitizedText,
            attachments,
            receiveOpenId,
            receiveChatId,
            useUserIdentity,
            deliveryUuid,
            measurementReceiveId,
            deliveryKey,
            error,
          });
        } catch (fallbackError) {
          this._log?.("warn", "Attachment upload fallback delivery failed", {
            ledgerId: ledger.id,
            error: safeErrorMessage(fallbackError),
          });
        }
        this._log?.("warn", "Degraded mirrored attachment delivery after missing upload key", {
          ledgerId: ledger.id,
          bindingId: ledger.binding_id,
          providerMessageId: ledger.provider_message_id,
          uploadMsgType: error?.uploadMsgType ?? null,
          uploadResponseShape: error?.uploadResponseShape ?? null,
          fallbackDelivered,
        });
        if (fallbackDelivered) {
          activeLedger = this._patchMessageLedgerDeliveryTelemetry(activeLedger, {
            deliveryCompletedAt: nowIso(),
            deliveryStatus: "delivered",
            deliveryDestination,
            deliveryIdentity: useUserIdentity ? "user" : "bot",
            deliveryError: `attachment_degraded:${safeErrorMessage(error)}`,
          });
          this.store.updateMessageLedgerStatusById(ledger.id, "delivered");
          this.store.recordDeliveryAttempt(
            ledger.id,
            deliveryDestination,
            "delivered",
            `attachment_degraded:${safeErrorMessage(error)}`,
          );
          return;
        }
      }
      const permanent = true;
      const deliveryStatus = "failed";
      activeLedger = this._patchMessageLedgerDeliveryTelemetry(activeLedger, {
        deliveryCompletedAt: nowIso(),
        deliveryStatus,
        deliveryDestination,
        deliveryIdentity: useUserIdentity ? "user" : "bot",
        deliveryError: safeErrorMessage(error),
      });
      this.store.updateMessageLedgerStatusById(
        ledger.id,
        deliveryStatus,
      );
      this.store.recordDeliveryAttempt(
        ledger.id,
        deliveryDestination,
        "failed",
        safeErrorMessage(error),
      );
      this._setError(error, {
        deliveryOpenId: receiveOpenId,
        deliveryChatId: receiveChatId,
        deliveryLedgerId: ledger.id,
        deliveryPermanent: permanent,
        deliveryAsUser: useUserIdentity,
      });
    } finally {
      this.deliveryLocks.delete(deliveryKey);
    }
  }

  async sendPrivateMessage(
    openId,
    { msgType, content, asUser = false, chatId = null, uuid = null } = {},
  ) {
    const normalizedType = String(msgType ?? "").trim() || "text";
    const normalizedContent =
      content != null && typeof content === "object" ? content : { text: String(content ?? "") };
    if (asUser) {
      return this._sendPrivateMessageAsUser({
        openId,
        chatId,
        msgType: normalizedType,
        content: normalizedContent,
        uuid,
      });
    }
    if (!this.client) {
      throw new Error("feishu_client_unavailable");
    }
    const response = await this.client.im.v1.message.create({
      params: { receive_id_type: "open_id" },
      data: {
        receive_id: openId,
        msg_type: normalizedType,
        content: JSON.stringify(normalizedContent),
        ...(uuid ? { uuid } : {}),
      },
    });
    if (response?.code != null && Number(response.code) !== 0) {
      throw createFeishuHttpError("feishu_send_failed", response);
    }
    this._setState({
      lastOutboundAt: nowIso(),
      lastError: null,
    });
    return response;
  }

  async sendPrivateText(openId, text, { asUser = false, chatId = null, uuid = null } = {}) {
    return this.sendPrivateMessage(openId, {
      asUser,
      chatId,
      msgType: "text",
      content: { text },
      uuid,
    });
  }

  async _sendPrivateMessageAsUser({
    openId,
    chatId = null,
    msgType = "text",
    content,
    uuid = null,
  }) {
    const tokenState = await this._ensureUserSendToken(openId);
    const receiveIdType = chatId ? "chat_id" : "open_id";
    const receiveId = chatId || openId;
    const response = await httpJsonRequest(
      `https://open.feishu.cn/open-apis/im/v1/messages?receive_id_type=${encodeURIComponent(receiveIdType)}`,
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${tokenState.accessToken}`,
          "content-type": "application/json; charset=utf-8",
        },
        body: JSON.stringify({
          receive_id: receiveId,
          msg_type: String(msgType ?? "text"),
          content: JSON.stringify(content ?? {}),
          ...(uuid ? { uuid } : {}),
        }),
      },
    );
    if (!response.ok || Number(response.data?.code ?? 0) !== 0) {
      throw createFeishuHttpError("feishu_user_send_failed", response);
    }
    this._setState({
      lastOutboundAt: nowIso(),
      lastError: null,
    });
    return response.data;
  }

  async _safeSendPrivateText(openId, text) {
    try {
      await this.sendPrivateText(openId, text);
    } catch (error) {
      this._setError(error, {});
    }
  }

  async _sendStatusReply(openId) {
    await this._refreshBridgeHealth().catch(() => void 0);
    await this._drainQueues().catch(() => void 0);
    const message = [
      `桥接状态：${this.state.status}`,
      `桌面端状态：${this.state.bridgeStatus}`,
      `Pipe：${this.state.pipeConnected ? "connected" : "disconnected"}`,
      `长连接：${this.wsStarted ? "started" : "stopped"}`,
      `当前线程：${this.state.activeThreadId ?? "none"}`,
      `待补投本地：${this.state.pendingLocalCommitCount}`,
      `待补发飞书：${this.state.pendingFeishuDeliveryCount}`,
      `最后错误：${this.state.lastError ?? "none"}`,
    ].join("\n");
    await this._safeSendPrivateText(openId, message);
  }

  async _handleUseCurrent(envelope, { followCurrentThread = true } = {}) {
    try {
      const result = await this.pipeClient.request("bridge.bindCurrentThread", {
        feishuOpenId: envelope.senderOpenId,
        feishuChatId: envelope.chatId,
        followCurrentThread,
      });
      await this._safeSendPrivateText(
        envelope.senderOpenId,
        `已绑定当前桌面对话：${result?.activeThread?.localThreadId ?? "unknown_thread"}`,
      );
    } catch (error) {
      await this._safeSendPrivateText(
        envelope.senderOpenId,
        `当前桌面对话还不可见，无法绑定：${safeErrorMessage(error)}`,
      );
      this._setError(error, { bridgeStatus: "recovering" });
    }
  }

  async _handleUnbind(envelope) {
    try {
      await this.pipeClient.request("bridge.unbind", {
        feishuOpenId: envelope.senderOpenId,
        feishuChatId: envelope.chatId,
      });
      await this._safeSendPrivateText(
        envelope.senderOpenId,
        "已解除当前飞书私聊与桌面对话的绑定。",
      );
    } catch (error) {
      await this._safeSendPrivateText(
        envelope.senderOpenId,
        `解绑失败：${safeErrorMessage(error)}`,
      );
      this._setError(error, { bridgeStatus: "recovering" });
    }
  }

  _normalizeInboundEnvelope(data) {
    const senderOpenId =
      data?.sender?.sender_id?.open_id ??
      data?.event?.sender?.sender_id?.open_id ??
      null;
    const message =
      data?.message ??
      data?.event?.message ??
      null;
    const timestamps = getInboundRawEventTimestamps(data);
    const chatId = message?.chat_id ?? null;
    const messageId = message?.message_id ?? null;
    const chatType = String(message?.chat_type ?? data?.chat_type ?? "p2p").toLowerCase();
    const messageType = String(
      message?.message_type ?? data?.message_type ?? data?.event?.message?.message_type ?? "text",
    )
      .trim()
      .toLowerCase();
    const content = normalizeMessageContentObject(message?.content ?? "{}");
    const attachments = normalizeInboundMessageAttachments(messageType, content);
    const text =
      parseMessageText(message?.content ?? "{}") ||
      buildInboundAttachmentFallbackText(messageType, attachments);
    if (!senderOpenId || !chatId || !messageId || (!text && attachments.length === 0)) {
      return null;
    }
    if (chatType && chatType !== "p2p") {
      return null;
    }
    return {
      senderOpenId,
      chatId,
      messageId,
      chatType,
      messageType,
      text,
      attachments,
      content,
      ...timestamps,
    };
  }

  _isAllowedOpenId(openId) {
    if (this.allowlist.size === 0) {
      return true;
    }
    return this.allowlist.has(String(openId ?? "").trim());
  }

  async _queueInboundForRecovery(envelope, reason) {
    const key = buildQueuedInboundKey(envelope.messageId);
    const existing = this.store.getRuntimeState(key);
    if (this._isTerminalQueuedInboundMarker(existing)) {
      return existing;
    }
    const marker = {
      status: "not_queued",
      skippedAt: nowIso(),
      reason,
      actionId: null,
      feishuOpenId: envelope.senderOpenId,
      feishuChatId: envelope.chatId,
    };
    this.store.setRuntimeState(key, marker);
    this._updatePendingCounts();
    return marker;
  }

  _getQueuedInboundMarker(providerMessageId) {
    const normalizedMessageId = String(providerMessageId ?? "").trim();
    if (!normalizedMessageId || !(this.store?.getRuntimeState instanceof Function)) {
      return null;
    }
    return this.store.getRuntimeState(buildQueuedInboundKey(normalizedMessageId));
  }

  _isTerminalQueuedInboundMarker(marker) {
    const status = String(marker?.status ?? "").trim().toLowerCase();
    return status === "not_queued" || status === "stale_ignored" || status === "processed";
  }

  _markInboundQueued(providerMessageId, reason, actionId = null) {
    this.store.setRuntimeState(buildQueuedInboundKey(providerMessageId), {
      status: "not_queued",
      skippedAt: nowIso(),
      reason,
      actionId,
    });
  }

  _clearQueuedInboundMarker(providerMessageId) {
    this.store.setRuntimeState(buildQueuedInboundKey(providerMessageId), {
      status: "processed",
      processedAt: nowIso(),
    });
  }

  _updatePendingCounts() {
    const pendingLocalCommitCount = this.store
      .listPendingActions()
      .filter((action) => action.action_type === "pending_local_commit").length;
    const pendingFeishuDeliveryCount = this.store.listMessageLedgerByStatus(
      ["pending_feishu_delivery", "delivery_retry"],
      "outbound",
    ).length;
    this._setState({
      pendingLocalCommitCount,
      pendingFeishuDeliveryCount,
    });
  }

  _deriveOverallStatus() {
    let status = "offline";
    if (!this.config?.enabled) {
      status = "offline";
    } else if (Lark == null || !this.config.appId?.trim() || !this.config.appSecret?.trim()) {
      status = "degraded";
    } else if (!this.state.credentialsValid) {
      status = "degraded";
    } else if (!this.wsStarted || !this.state.pipeConnected) {
      status = "recovering";
    } else {
      status = "online";
    }
    this._setState({
      status,
      wsStarted: this.wsStarted,
      pipeConnected: this.state.pipeConnected,
    });
  }

  _setError(error, extraState = {}) {
    this._setState({
      ...extraState,
      lastError: safeErrorMessage(error),
    });
    this._log("error", safeErrorMessage(error), extraState);
  }

  _setState(patch) {
    this.state = {
      ...this.state,
      ...patch,
      updatedAt: nowIso(),
    };
    this.store.setRuntimeState("feishu_sidecar_status", this.state);
  }

  _buildHealthPayload() {
    return {
      ok: true,
      ...this.state,
      pipeName: this.pipeClient.pipeName,
      storePath: this.paths.storePath,
      allowlist: Array.from(this.allowlist.values()),
      defaultOpenId: this.defaultOpenId,
    };
  }

  _buildMetricsText() {
    return [
      `feishu_bridge_status ${JSON.stringify(this.state.status)}`,
      `feishu_bridge_pipe_connected ${this.state.pipeConnected ? 1 : 0}`,
      `feishu_bridge_ws_started ${this.wsStarted ? 1 : 0}`,
      `feishu_bridge_pending_local_commit ${this.state.pendingLocalCommitCount}`,
      `feishu_bridge_pending_feishu_delivery ${this.state.pendingFeishuDeliveryCount}`,
    ].join("\n");
  }

  _respondJson(response, statusCode, payload) {
    response.writeHead(statusCode, {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
    });
    response.end(JSON.stringify(payload, null, 2));
  }

  _log(level, message, meta = null) {
    const line = JSON.stringify({
      at: nowIso(),
      level,
      message,
      meta,
    });
    try {
      fs.appendFileSync(this.logFilePath, `${line}\n`, "utf8");
    } catch {
      // Best-effort logging only.
    }
  }
}

function loadConfig() {
  const paths = resolveBridgePaths();
  const baseConfig = loadBridgeConfig(paths);
  const configFile = process.env.CODEX_FEISHU_BRIDGE_CONFIG_FILE;
  if (configFile && fs.existsSync(configFile)) {
    try {
      let raw = fs.readFileSync(configFile, "utf8");
      if (raw.charCodeAt(0) === 0xfeff) {
        raw = raw.slice(1);
      }
      const parsed = JSON.parse(raw);
      return {
        paths,
        config: {
          ...baseConfig,
          ...parsed,
          paths,
          longConnection: {
            ...baseConfig.longConnection,
            ...(parsed.longConnection ?? {}),
          },
          diagnosticsHttp: {
            ...baseConfig.diagnosticsHttp,
            ...(parsed.diagnosticsHttp ?? {}),
          },
          userIdentitySend: {
            ...baseConfig.userIdentitySend,
            ...(parsed.userIdentitySend ?? {}),
          },
          assistantCard: {
            ...baseConfig.assistantCard,
            ...(parsed.assistantCard ?? {}),
            cardkit: {
              ...baseConfig.assistantCard?.cardkit,
              ...(parsed.assistantCard?.cardkit ?? {}),
            },
          },
          runtime: {
            ...baseConfig.runtime,
            ...(parsed.runtime ?? {}),
          },
        },
      };
    } catch {
      return {
        paths,
        config: baseConfig,
      };
    }
  }
  return {
    paths,
    config: baseConfig,
  };
}

async function main() {
  const { paths, config } = loadConfig();
  const pipeName =
    process.env.CODEX_FEISHU_BRIDGE_PIPE ?? "\\\\.\\pipe\\codex-feishu-bridge";
  const logDir = process.env.CODEX_FEISHU_BRIDGE_LOG_DIR ?? paths.logDir;
  fs.mkdirSync(logDir, { recursive: true });
  const store = new BridgeStore(paths.storePath);
  const sidecar = new FeishuBridgeSidecar({
    config,
    pipeClient: new PipeClient(pipeName),
    store,
    paths,
    logFilePath: path.join(logDir, "feishu-sidecar.log"),
  });

  const shutdown = async () => {
    await sidecar.stop().catch(() => void 0);
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown());
  process.on("SIGTERM", () => void shutdown());

  await sidecar.start();
}

if (require.main === module) {
  main().catch((error) => {
    const { paths } = loadConfig();
    const logDir = process.env.CODEX_FEISHU_BRIDGE_LOG_DIR ?? paths.logDir;
    fs.mkdirSync(logDir, { recursive: true });
    const message = error instanceof Error ? error.stack ?? error.message : String(error);
    fs.writeFileSync(
      path.join(logDir, "sidecar-last-error.log"),
      `${nowIso()}\n${message}\n`,
      "utf8",
    );
    process.exitCode = 1;
  });
}

module.exports = {
  FeishuBridgeSidecar,
  PipeClient,
  buildAssistantCardKitAssistantElementContents,
  buildAssistantCardKitAssistantStreamingCard,
  buildAssistantCardKitMessageContent,
  buildAssistantCardKitStreamingCard,
  buildOutboundMessageId,
  buildAssistantCard,
  buildAssistantCardRichContentPlan,
  buildFeishuTextPayloads,
  deriveAssistantCardSectionsFromState,
  measureFeishuTextRequestBytes,
  measureFeishuInteractiveRequestBytes,
  measureFeishuCardPatchRequestBytes,
  formatMirroredText,
  parseMessageText,
  normalizeAllowlist,
  sortFeishuDeliveryLedgers,
  splitTextByUtf8Bytes,
  upsertAssistantCardStateFromEvent,
};
