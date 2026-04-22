"use strict";

const net = require("node:net");
const readline = require("node:readline");
const crypto = require("node:crypto");

class NamedPipeJsonRpcServer {
  constructor({ pipeName, runtime }) {
    this.pipeName = pipeName;
    this.runtime = runtime;
    this.server = null;
    this.clients = new Map();
  }

  async start() {
    await this.close();
    this.server = net.createServer((socket) => this._handleConnection(socket));
    return new Promise((resolve, reject) => {
      this.server.once("error", reject);
      this.server.listen(this.pipeName, () => {
        this.server.removeListener("error", reject);
        resolve();
      });
    });
  }

  async close() {
    for (const client of this.clients.values()) {
      client.readline.close();
      client.socket.destroy();
    }
    this.clients.clear();
    if (this.server == null) {
      return;
    }
    await new Promise((resolve) => this.server.close(resolve));
    this.server = null;
  }

  notify(method, params) {
    const payload = JSON.stringify({ jsonrpc: "2.0", method, params });
    for (const client of this.clients.values()) {
      if (!client.subscriptions.has(method)) {
        continue;
      }
      client.socket.write(`${payload}\n`);
    }
  }

  _handleConnection(socket) {
    const clientId = crypto.randomUUID();
    const readlineInterface = readline.createInterface({ input: socket });
    const client = {
      socket,
      readline: readlineInterface,
      subscriptions: new Set(),
    };
    this.clients.set(clientId, client);
    readlineInterface.on("line", (line) => {
      if (!line.trim()) {
        return;
      }
      this._handleLine(clientId, client, line).catch((error) => {
        socket.write(
          `${JSON.stringify({
            jsonrpc: "2.0",
            error: { code: -32000, message: String(error?.message ?? error) },
          })}\n`,
        );
      });
    });
    socket.on("close", () => {
      readlineInterface.close();
      this.clients.delete(clientId);
    });
    socket.on("error", () => {
      readlineInterface.close();
      this.clients.delete(clientId);
    });
  }

  async _handleLine(clientId, client, line) {
    const payload = JSON.parse(line);
    const { id, method, params } = payload;
    if (!method) {
      return;
    }
    if (method === "bridge.subscribeTurnEvents") {
      client.subscriptions.add("bridge.turnEvent");
      if (id != null) {
        client.socket.write(
          `${JSON.stringify({
            jsonrpc: "2.0",
            id,
            result: {
              ok: true,
              clientId,
              subscriptionId: crypto.randomUUID(),
            },
          })}\n`,
        );
      }
      return;
    }
    const result = await this.runtime.handleRpc(method, params ?? {});
    if (id != null) {
      client.socket.write(
        `${JSON.stringify({ jsonrpc: "2.0", id, result })}\n`,
      );
    }
  }
}

module.exports = {
  NamedPipeJsonRpcServer,
};
