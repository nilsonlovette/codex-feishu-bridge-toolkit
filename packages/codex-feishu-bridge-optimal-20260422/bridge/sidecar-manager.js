"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { spawn } = require("node:child_process");

class SidecarManager {
  constructor({ bridgeRoot, config, onStateChange }) {
    this.bridgeRoot = bridgeRoot;
    this.config = config;
    this.onStateChange = onStateChange;
    this.child = null;
    this.state = {
      running: false,
      pid: null,
      lastExitCode: null,
      lastError: null,
      restartScheduled: false,
    };
    this.stopping = false;
    this.restartTimer = null;
  }

  getState() {
    return { ...this.state };
  }

  resolveEmbeddedNodePath() {
    const candidates = [
      path.join(path.dirname(process.execPath), "electron.exe"),
      path.join(path.dirname(process.execPath), "..", "electron.exe"),
      path.join(
        path.dirname(path.dirname(this.bridgeRoot)),
        "codex-electron-runner",
        "node_modules",
        "electron",
        "dist",
        "electron.exe",
      ),
    ];
    return candidates.find((candidate) => fs.existsSync(candidate)) ?? process.execPath;
  }

  async start() {
    if (this.child != null || !this.config.enabled) {
      return this.getState();
    }
    this.stopping = false;
    const sidecarEntry = path.join(this.bridgeRoot, "feishu-sidecar", "index.js");
    const configuredNodePath = this.config.sidecarNodePath?.trim() || "";
    const useEmbeddedElectronNode = configuredNodePath.length === 0;
    const nodePath = useEmbeddedElectronNode
      ? this.resolveEmbeddedNodePath()
      : configuredNodePath;
    const env = {
      ...process.env,
      CODEX_FEISHU_BRIDGE_CONFIG_FILE: this.config.paths.configPath,
      CODEX_FEISHU_BRIDGE_PIPE: this.config.paths.pipeName,
      CODEX_FEISHU_BRIDGE_LOG_DIR: this.config.paths.logDir,
      ...(useEmbeddedElectronNode
        ? {
            ELECTRON_RUN_AS_NODE: "1",
          }
        : {}),
    };
    this.child = spawn(nodePath, [sidecarEntry], {
      cwd: path.dirname(sidecarEntry),
      env,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    this.state.running = true;
    this.state.pid = this.child.pid ?? null;
    this.onStateChange?.(this.getState());
    this.child.stdout.on("data", () => void 0);
    this.child.stderr.on("data", () => void 0);
    this.child.on("exit", (code) => {
      this.state.running = false;
      this.state.lastExitCode = code;
      this.state.pid = null;
      this.child = null;
      if (!this.stopping && this.config.enabled) {
        this.state.restartScheduled = true;
        this.onStateChange?.(this.getState());
        this.restartTimer = setTimeout(() => {
          this.state.restartScheduled = false;
          this.start().catch((error) => {
            this.state.lastError = error.message;
            this.onStateChange?.(this.getState());
          });
        }, 3000);
      }
      this.onStateChange?.(this.getState());
    });
    this.child.on("error", (error) => {
      this.state.lastError = error.message;
      this.onStateChange?.(this.getState());
    });
    return this.getState();
  }

  async stop() {
    this.stopping = true;
    if (this.restartTimer != null) {
      clearTimeout(this.restartTimer);
      this.restartTimer = null;
      this.state.restartScheduled = false;
    }
    if (this.child == null) {
      return;
    }
    this.child.kill();
    this.child = null;
    this.state.running = false;
    this.state.pid = null;
    this.onStateChange?.(this.getState());
  }
}

module.exports = {
  SidecarManager,
};
