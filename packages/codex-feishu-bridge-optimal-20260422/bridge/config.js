"use strict";

const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");

const DEFAULT_PIPE_NAME = "\\\\.\\pipe\\codex-feishu-bridge";

function getLocalAppDataPath() {
  return (
    process.env.LOCALAPPDATA ??
    path.join(os.homedir(), "AppData", "Local")
  );
}

function resolveBridgePaths() {
  const rootDir = path.join(getLocalAppDataPath(), "Codex", "FeishuBridge");
  const storePath = path.join(rootDir, "bridge.sqlite");
  const configPath = path.join(rootDir, "bridge-config.json");
  const logDir = path.join(rootDir, "logs");
  return {
    rootDir,
    storePath,
    configPath,
    logDir,
    pipeName: DEFAULT_PIPE_NAME,
  };
}

function ensureBridgeDirectories(paths) {
  fs.mkdirSync(paths.rootDir, { recursive: true });
  fs.mkdirSync(paths.logDir, { recursive: true });
}

function getDefaultConfig(paths) {
  return {
    enabled: false,
    appId: "",
    appSecret: "",
    encryptKey: "",
    verificationToken: "",
    allowlistOpenIds: [],
    defaultOpenId: "",
    sidecarNodePath: "",
    sidecarMode: "long-connection",
    longConnection: {
      enabled: true,
      idleReconnectMs: 5000,
    },
    diagnosticsHttp: {
      enabled: false,
      host: "127.0.0.1",
      port: 47631,
    },
    userIdentitySend: {
      enabled: false,
      authHost: "127.0.0.1",
      authPort: 47631,
      startPath: "/oauth/start",
      callbackPath: "/oauth/callback",
      statusPath: "/oauth/status",
      prompt: "consent",
      scope: "im:message im:message.send_as_user im:resource offline_access",
    },
    assistantCard: {
      streamingBackend: "cardkit",
      patchPlaybackTickMs: 250,
      cardkit: {
        enabled: true,
        elementId: "main_md",
        progressElementId: "think_md",
        toolElementId: "tools_md",
        finalElementId: "final_md",
        printFrequencyMs: 30,
        printStep: 1,
        printStrategy: "delay",
      },
    },
    runtime: {
      pollIntervalMs: 2000,
      staleBindingMs: 15000,
      submitTimeoutMs: 5000,
      focusedIdleNativePollMs: 12000,
      activeNativePollMs: 1000,
      postSubmitFastWindowMs: 15000,
      inboundEventMaxAgeMs: 900000,
      sqliteMaintenanceIntervalMs: 60000,
      sqliteMaintenanceInitialDelayMs: 5000,
      sqliteMaintenanceBatchLimit: 5000,
      deliveredAttemptMaxAgeMs: 300000,
      failedAttemptMaxAgeMs: 86400000,
      completedPendingActionMaxAgeMs: 300000,
      completedFeishuCardSessionMaxAgeMs: 86400000,
      completedFeishuCardSessionKeepPerThread: 50,
      runtimeTransientStateMaxAgeMs: 900000,
      messageLedgerPayloadMaxAgeMs: 3600000,
      failedMessageLedgerPayloadMaxAgeMs: 86400000,
      sqliteMaintenanceArtifactMaxAgeMs: 86400000,
      sqliteMaintenanceArtifactKeepRecent: 1,
      sqlitePhysicalCompactionEnabled: true,
      sqlitePhysicalCompactionCooldownMs: 86400000,
      sqlitePhysicalCompactionMinFreelistBytes: 33554432,
      sqlitePhysicalCompactionMinFreeRatio: 0.25,
      sqlitePhysicalCompactionActiveWindowMs: 120000,
    },
    paths,
  };
}

function loadBridgeConfig(paths) {
  ensureBridgeDirectories(paths);
  const fallback = getDefaultConfig(paths);
  if (!fs.existsSync(paths.configPath)) {
    fs.writeFileSync(
      paths.configPath,
      JSON.stringify(fallback, null, 2),
      "utf8",
    );
    return fallback;
  }
  try {
    let raw = fs.readFileSync(paths.configPath, "utf8");
    // PowerShell's default UTF-8 writer may prepend a BOM; strip it so the
    // bridge never silently falls back to the disabled template.
    if (raw.charCodeAt(0) === 0xfeff) {
      raw = raw.slice(1);
    }
    const parsed = JSON.parse(raw);
    return {
      ...fallback,
      ...parsed,
      paths,
      longConnection: {
        ...fallback.longConnection,
        ...(parsed.longConnection ?? {}),
      },
      diagnosticsHttp: {
        ...fallback.diagnosticsHttp,
        ...(parsed.diagnosticsHttp ?? {}),
      },
      userIdentitySend: {
        ...fallback.userIdentitySend,
        ...(parsed.userIdentitySend ?? {}),
      },
      assistantCard: {
        ...fallback.assistantCard,
        ...(parsed.assistantCard ?? {}),
        cardkit: {
          ...fallback.assistantCard.cardkit,
          ...(parsed.assistantCard?.cardkit ?? {}),
        },
      },
      runtime: {
        ...fallback.runtime,
        ...(parsed.runtime ?? {}),
      },
    };
  } catch {
    return fallback;
  }
}

module.exports = {
  DEFAULT_PIPE_NAME,
  resolveBridgePaths,
  ensureBridgeDirectories,
  loadBridgeConfig,
  getDefaultConfig,
};
