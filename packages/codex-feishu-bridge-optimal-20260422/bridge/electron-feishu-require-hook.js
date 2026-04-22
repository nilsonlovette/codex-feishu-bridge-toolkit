"use strict";

const fs = require("node:fs");
const path = require("node:path");
const Module = require("node:module");
const {
  beforeMainStartup,
  afterMainStartup,
} = require("./electron-feishu-bridge-bootstrap");

const buildFlavor = process.env.CODEX_FEISHU_BRIDGE_BUILD_FLAVOR || "prod";

function isBrokenPipeError(error) {
  const message = error instanceof Error ? error.message : String(error ?? "");
  const code = error?.code ?? "";
  return code === "EPIPE" || /broken pipe/i.test(message);
}

function appendHookLog(line) {
  try {
    const logDir =
      process.env.CODEX_FEISHU_BRIDGE_LOG_DIR ||
      path.join(
        process.env.LOCALAPPDATA || path.join(process.env.USERPROFILE || "", "AppData", "Local"),
        "Codex",
        "FeishuBridge",
        "logs",
      );
    fs.mkdirSync(logDir, { recursive: true });
    fs.appendFileSync(
      path.join(logDir, "require-hook.log"),
      `${new Date().toISOString()} ${line}\n`,
      "utf8",
    );
  } catch {
    // Avoid recursive logging failures.
  }
}

function installSafeConsolePipeGuards() {
  const guardStream = (stream, label) => {
    if (!stream || typeof stream.write !== "function" || stream.__codexFeishuPipeGuard) {
      return;
    }
    const originalWrite = stream.write.bind(stream);
    stream.write = (...args) => {
      try {
        return originalWrite(...args);
      } catch (error) {
        if (isBrokenPipeError(error)) {
          appendHookLog(`suppressed_${label}_write_epipe pid=${process.pid}`);
          return false;
        }
        throw error;
      }
    };
    if (typeof stream.on === "function") {
      stream.on("error", (error) => {
        if (isBrokenPipeError(error)) {
          appendHookLog(`suppressed_${label}_event_epipe pid=${process.pid}`);
        }
      });
    }
    Object.defineProperty(stream, "__codexFeishuPipeGuard", {
      value: true,
      configurable: false,
      enumerable: false,
      writable: false,
    });
  };

  const wrapConsoleMethod = (methodName) => {
    const original = console?.[methodName];
    if (typeof original !== "function" || original.__codexFeishuPipeGuard) {
      return;
    }
    const wrapped = (...args) => {
      try {
        return original.apply(console, args);
      } catch (error) {
        if (isBrokenPipeError(error)) {
          appendHookLog(`suppressed_console_${methodName}_epipe pid=${process.pid}`);
          return;
        }
        throw error;
      }
    };
    Object.defineProperty(wrapped, "__codexFeishuPipeGuard", {
      value: true,
      configurable: false,
      enumerable: false,
      writable: false,
    });
    console[methodName] = wrapped;
  };

  guardStream(process.stdout, "stdout");
  guardStream(process.stderr, "stderr");
  for (const methodName of ["log", "info", "warn", "error", "debug", "trace"]) {
    wrapConsoleMethod(methodName);
  }
}

installSafeConsolePipeGuards();

let bridgeInstalled = false;

function markProbeFile() {
  const probeFile = process.env.CODEX_FEISHU_BRIDGE_HOOK_PROBE_FILE;
  if (!probeFile) {
    return;
  }
  fs.mkdirSync(path.dirname(probeFile), { recursive: true });
  fs.writeFileSync(
    probeFile,
    `${new Date().toISOString()}\n${process.pid}\n`,
    "utf8",
  );
}

function installBridgeWithElectron(electron) {
  if (bridgeInstalled || !electron?.app) {
    return false;
  }
  bridgeInstalled = true;
  markProbeFile();
  beforeMainStartup({
    electron,
    app: electron.app,
    buildFlavor,
  });
  electron.app.whenReady().then(() => {
    afterMainStartup({
      electron,
      app: electron.app,
      buildFlavor,
    }).catch((error) => {
      appendHookLog(`afterMainStartup_failed pid=${process.pid} message=${String(error?.message ?? error)}`);
    });
  });
  appendHookLog(`hook_bootstrap_installed pid=${process.pid}`);
  return true;
}

function installDeferredElectronHook() {
  if (!process.versions?.electron) {
    appendHookLog(`skipped_non_electron_runtime pid=${process.pid}`);
    return;
  }

  if (process.type && process.type !== "browser") {
    appendHookLog(`skipped_non_browser_process pid=${process.pid} type=${process.type}`);
    return;
  }

  try {
    if (installBridgeWithElectron(require("electron"))) {
      return;
    }
    appendHookLog(`skipped_electron_without_app pid=${process.pid}`);
    return;
  } catch (error) {
    appendHookLog(`electron_require_deferred pid=${process.pid} message=${String(error?.message ?? error)}`);
  }

  const originalLoad = Module._load;
  if (originalLoad?.__codexFeishuElectronDeferredHook) {
    return;
  }

  const wrappedLoad = function wrappedLoad(request, parent, isMain) {
    const exported = originalLoad.apply(this, arguments);
    if (request === "electron") {
      try {
        installBridgeWithElectron(exported);
      } catch (error) {
        appendHookLog(`deferred_install_failed pid=${process.pid} message=${String(error?.message ?? error)}`);
      }
    }
    return exported;
  };

  Object.defineProperty(wrappedLoad, "__codexFeishuElectronDeferredHook", {
    value: true,
    configurable: false,
    enumerable: false,
    writable: false,
  });
  Module._load = wrappedLoad;
  appendHookLog(`electron_require_hook_deferred pid=${process.pid}`);
}

try {
  installDeferredElectronHook();
} catch (error) {
  appendHookLog(`hook_bootstrap_failed pid=${process.pid} message=${String(error?.message ?? error)}`);
}
