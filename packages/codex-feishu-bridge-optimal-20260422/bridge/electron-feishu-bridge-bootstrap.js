"use strict";

const path = require("node:path");
const { FeishuBridgeRuntime } = require("./runtime");
const { IpcHookRegistry } = require("./ipc-hook-registry");

let installedState = null;

function beforeMainStartup({ electron, app, buildFlavor }) {
  if (installedState != null) {
    return installedState;
  }
  const registry = new IpcHookRegistry();
  registry.install(electron.ipcMain);
  installedState = {
    electron,
    app,
    buildFlavor,
    registry,
    runtime: null,
  };
  app.once("will-quit", () => {
    Promise.resolve(installedState?.runtime?.stop?.()).catch(() => void 0);
    registry.uninstall();
  });
  return installedState;
}

async function afterMainStartup({ electron, app, buildFlavor }) {
  const state =
    installedState ?? beforeMainStartup({ electron, app, buildFlavor });
  if (state.runtime != null) {
    return state.runtime;
  }
  const runtime = new FeishuBridgeRuntime({
    electron,
    app,
    buildFlavor,
    handlerRegistry: state.registry,
    bridgeRoot: path.resolve(__dirname),
  });
  state.runtime = runtime;
  await runtime.start();
  return runtime;
}

module.exports = {
  beforeMainStartup,
  afterMainStartup,
};
