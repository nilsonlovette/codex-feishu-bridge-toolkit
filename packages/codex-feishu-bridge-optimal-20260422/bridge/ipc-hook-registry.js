"use strict";

class IpcHookRegistry {
  constructor() {
    this.ipcMain = null;
    this.originalHandle = null;
    this.originalRemoveHandler = null;
    this.rawInvokeHandlers = new Map();
    this.invokeHandlers = new Map();
    this.invokeWrappers = new Map();
  }

  install(ipcMain) {
    if (this.originalHandle != null) {
      return;
    }
    this.ipcMain = ipcMain;
    this.originalHandle = ipcMain.handle.bind(ipcMain);
    this.originalRemoveHandler = ipcMain.removeHandler.bind(ipcMain);
    ipcMain.handle = (channel, listener) => {
      this.rawInvokeHandlers.set(channel, listener);
      const wrapped = this._applyInvokeWrappers(channel, listener);
      this.invokeHandlers.set(channel, wrapped);
      return this.originalHandle(channel, wrapped);
    };
    ipcMain.removeHandler = (channel) => {
      this.rawInvokeHandlers.delete(channel);
      this.invokeHandlers.delete(channel);
      return this.originalRemoveHandler(channel);
    };
  }

  uninstall() {
    this.rawInvokeHandlers.clear();
    this.invokeHandlers.clear();
    this.invokeWrappers.clear();
  }

  getInvokeHandler(channel) {
    return this.invokeHandlers.get(channel) ?? null;
  }

  registerInvokeWrapper(channel, wrapperFactory) {
    if (!channel || typeof wrapperFactory !== "function") {
      return false;
    }
    const existing = this.invokeWrappers.get(channel) ?? [];
    existing.push(wrapperFactory);
    this.invokeWrappers.set(channel, existing);
    this._rehydrateInvokeHandler(channel);
    return true;
  }

  _applyInvokeWrappers(channel, listener) {
    let wrapped = listener;
    const wrappers = this.invokeWrappers.get(channel) ?? [];
    for (const wrapperFactory of wrappers) {
      const candidate = wrapperFactory(wrapped);
      if (typeof candidate === "function") {
        wrapped = candidate;
      }
    }
    return wrapped;
  }

  _rehydrateInvokeHandler(channel) {
    const raw = this.rawInvokeHandlers.get(channel);
    if (raw == null || this.ipcMain == null) {
      return false;
    }
    const wrapped = this._applyInvokeWrappers(channel, raw);
    this.originalRemoveHandler(channel);
    this.invokeHandlers.set(channel, wrapped);
    this.originalHandle(channel, wrapped);
    return true;
  }
}

module.exports = {
  IpcHookRegistry,
};
