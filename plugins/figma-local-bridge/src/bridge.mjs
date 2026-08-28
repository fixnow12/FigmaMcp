import { createServer as createHttpServer } from "node:http";
import { WebSocket, WebSocketServer } from "ws";

const DEFAULT_HOST = process.env.FIGMA_WS_HOST || "127.0.0.1";
const DEFAULT_PORT = Number(process.env.FIGMA_WS_PORT || 9223);
const SERVER_VERSION = "0.2.2";

function isAllowedOrigin(origin) {
  return !origin || origin === "null" || origin === "https://www.figma.com" || origin === "https://figma.com";
}

export class LocalFigmaWebSocketServer {
  constructor({ host = DEFAULT_HOST, port = DEFAULT_PORT } = {}) {
    this.host = host;
    this.requestedPort = port;
    this.port = null;
    this.httpServer = null;
    this.wss = null;
    this.clients = new Map();
    this.socketKeys = new Map();
    this.pendingRequests = new Map();
    this.activeFileKey = null;
    this.requestCounter = 0;
    this.startedAt = Date.now();
    this.heartbeat = null;
  }

  handleHttpRequest(request, response) {
    response.setHeader("Access-Control-Allow-Origin", "*");
    response.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
    response.setHeader("Access-Control-Allow-Headers", "Content-Type");
    if (request.method === "OPTIONS") {
      response.writeHead(204);
      response.end();
      return;
    }
    if (request.url === "/" || request.url === "/health") {
      const connectedClients = [...this.clients.values()].filter((client) => client.ws.readyState === WebSocket.OPEN).length;
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end(JSON.stringify({
        status: "ok",
        version: SERVER_VERSION,
        clients: this.clients.size,
        connectedClients,
        uptime: Math.floor((Date.now() - this.startedAt) / 1000),
      }));
      return;
    }
    response.writeHead(404, { "Content-Type": "text/plain" });
    response.end("Not Found");
  }

  async start() {
    if (this.httpServer) return;
    this.startedAt = Date.now();
    this.httpServer = createHttpServer((request, response) => this.handleHttpRequest(request, response));
    this.wss = new WebSocketServer({
      server: this.httpServer,
      maxPayload: 100 * 1024 * 1024,
      verifyClient: ({ origin }, accept) => isAllowedOrigin(origin) ? accept(true) : accept(false, 403, "Unauthorized Origin"),
    });
    // ws повторно публикует ошибки общего HTTP-сервера. Постоянный обработчик
    // не даёт второму событию EADDRINUSE завершить процесс после отклонения start().
    this.wss.on("error", () => {});
    this.wss.on("connection", (ws) => this.handleConnection(ws));
    await new Promise((resolve, reject) => {
      let settled = false;
      const cleanup = () => {
        this.httpServer?.off("error", onError);
        this.httpServer?.off("listening", onListening);
        this.wss?.off("error", onError);
      };
      const onError = (error) => {
        if (settled) return;
        settled = true;
        cleanup();
        reject(error);
      };
      const onListening = () => {
        if (settled) return;
        settled = true;
        cleanup();
        resolve();
      };
      this.httpServer.on("error", onError);
      this.httpServer.on("listening", onListening);
      this.wss.on("error", onError);
      this.httpServer.listen(this.requestedPort, this.host);
    });
    const address = this.httpServer.address();
    this.port = typeof address === "object" && address ? address.port : this.requestedPort;
    this.heartbeat = setInterval(() => {
      for (const ws of this.wss?.clients || []) {
        if (ws.isAlive === false) {
          ws.terminate();
          continue;
        }
        ws.isAlive = false;
        ws.ping();
      }
    }, 30000);
    this.heartbeat.unref?.();
  }

  handleConnection(ws) {
    ws.isAlive = true;
    ws.on("pong", () => {
      ws.isAlive = true;
      const fileKey = this.socketKeys.get(ws);
      const client = fileKey ? this.clients.get(fileKey) : null;
      if (client) client.lastPongAt = Date.now();
    });
    ws.on("message", (data) => {
      try {
        this.handleMessage(JSON.parse(Buffer.from(data).toString("utf8")), ws);
      } catch {
        // Некорректное сообщение не должно завершать сервер или другие соединения.
      }
    });
    ws.on("close", () => this.handleDisconnect(ws));
    ws.send(JSON.stringify({
      type: "SERVER_HELLO",
      data: { port: this.port, pid: process.pid, serverVersion: SERVER_VERSION, startedAt: this.startedAt },
    }));
  }

  handleMessage(message, ws) {
    if (message.id && this.pendingRequests.has(message.id)) {
      const pending = this.pendingRequests.get(message.id);
      const senderFileKey = this.socketKeys.get(ws);
      const unambiguousPendingSocket = !senderFileKey && this.wss?.clients.size === 1;
      if (senderFileKey === pending.fileKey || unambiguousPendingSocket) {
        clearTimeout(pending.timeoutId);
        this.pendingRequests.delete(message.id);
        if (message.error) pending.reject(new Error(message.error));
        else pending.resolve(message.result);
        return;
      }
    }
    if (message.type === "FILE_INFO" && message.data) {
      this.registerFile(message.data, ws);
      return;
    }
    const fileKey = this.socketKeys.get(ws);
    const client = fileKey ? this.clients.get(fileKey) : null;
    if (!client) return;
    client.lastActivity = Date.now();
    if (message.type === "SELECTION_CHANGE") {
      client.selection = message.data || null;
      this.activeFileKey = fileKey;
    } else if (message.type === "PAGE_CHANGE" && message.data) {
      client.fileInfo.currentPage = message.data.pageName;
      client.fileInfo.currentPageId = message.data.pageId || null;
      this.activeFileKey = fileKey;
    }
  }

  registerFile(data, ws) {
    const fileKey = typeof data.fileKey === "string" && data.fileKey ? data.fileKey : null;
    if (!fileKey) return;
    const previousKey = this.socketKeys.get(ws);
    if (previousKey && previousKey !== fileKey) this.clients.delete(previousKey);
    const existing = this.clients.get(fileKey);
    if (existing && existing.ws !== ws) {
      this.rejectPendingForFile(fileKey, "Соединение с файлом Figma было заменено");
      existing.ws.terminate();
    }
    this.socketKeys.set(ws, fileKey);
    this.clients.set(fileKey, {
      ws,
      fileInfo: {
        fileName: data.fileName || "Без названия",
        fileKey,
        currentPage: data.currentPage || null,
        currentPageId: data.currentPageId || null,
        editorType: data.editorType || "figma",
        connectedAt: Date.now(),
        pluginVersion: data.pluginVersion || null,
      },
      selection: existing?.selection || null,
      lastActivity: Date.now(),
      lastPongAt: Date.now(),
    });
    this.activeFileKey = fileKey;
  }

  handleDisconnect(ws) {
    const fileKey = this.socketKeys.get(ws);
    this.socketKeys.delete(ws);
    if (!fileKey) return;
    const client = this.clients.get(fileKey);
    if (client?.ws !== ws) return;
    this.clients.delete(fileKey);
    this.rejectPendingForFile(fileKey, "Плагин Figma отключился");
    if (this.activeFileKey === fileKey) {
      this.activeFileKey = [...this.clients.entries()].find(([, value]) => value.ws.readyState === WebSocket.OPEN)?.[0] || null;
    }
  }

  sendCommand(method, params = {}, timeoutMs = 15000, targetFileKey) {
    const fileKey = targetFileKey || this.activeFileKey;
    if (!fileKey) return Promise.reject(new Error("Нет активного файла. Откройте Desktop Bridge в нужном файле Figma."));
    const client = this.clients.get(fileKey);
    if (!client || client.ws.readyState !== WebSocket.OPEN) return Promise.reject(new Error(`Файл Figma не подключён: ${fileKey}`));
    const id = `codex_${++this.requestCounter}_${Date.now()}`;
    return new Promise((resolve, reject) => {
      const timeoutId = setTimeout(() => {
        this.pendingRequests.delete(id);
        reject(new Error(`Команда ${method} не завершилась за ${timeoutMs} мс`));
      }, timeoutMs);
      this.pendingRequests.set(id, { resolve, reject, timeoutId, fileKey, method });
      try {
        client.ws.send(JSON.stringify({ id, method, params }));
        client.lastActivity = Date.now();
      } catch (error) {
        clearTimeout(timeoutId);
        this.pendingRequests.delete(id);
        reject(error);
      }
    });
  }

  rejectPendingForFile(fileKey, reason) {
    for (const [id, pending] of this.pendingRequests) {
      if (pending.fileKey !== fileKey) continue;
      clearTimeout(pending.timeoutId);
      pending.reject(new Error(reason));
      this.pendingRequests.delete(id);
    }
  }

  isClientConnected() {
    return [...this.clients.values()].some((client) => client.ws.readyState === WebSocket.OPEN);
  }

  getConnectedFileInfo() {
    return this.activeFileKey ? this.clients.get(this.activeFileKey)?.fileInfo || null : null;
  }

  getConnectedFiles() {
    return [...this.clients.entries()]
      .filter(([, client]) => client.ws.readyState === WebSocket.OPEN)
      .map(([fileKey, client]) => ({ ...client.fileInfo, isActive: fileKey === this.activeFileKey }));
  }

  async stop() {
    if (this.heartbeat) clearInterval(this.heartbeat);
    this.heartbeat = null;
    for (const [, pending] of this.pendingRequests) {
      clearTimeout(pending.timeoutId);
      pending.reject(new Error("WebSocket-сервер остановлен"));
    }
    this.pendingRequests.clear();
    for (const ws of this.wss?.clients || []) ws.terminate();
    if (this.wss) await new Promise((resolve) => this.wss.close(() => resolve()));
    if (this.httpServer) await new Promise((resolve) => this.httpServer.close(() => resolve()));
    this.clients.clear();
    this.socketKeys.clear();
    this.activeFileKey = null;
    this.wss = null;
    this.httpServer = null;
    this.port = null;
  }
}

export class FigmaBridge {
  constructor({ host = DEFAULT_HOST, port = DEFAULT_PORT } = {}) {
    this.host = host;
    this.preferredPort = port;
    this.wsServer = null;
    this.port = null;
  }

  async start() {
    let lastError;
    const attempts = this.preferredPort === 0 ? [0] : Array.from({ length: 10 }, (_, index) => this.preferredPort + index);
    for (const port of attempts) {
      const candidate = new LocalFigmaWebSocketServer({ port, host: this.host });
      try {
        await candidate.start();
        this.wsServer = candidate;
        this.port = candidate.port;
        return { host: this.host, port: this.port };
      } catch (error) {
        lastError = error;
        await candidate.stop().catch(() => {});
        if (!["EADDRINUSE", "EACCES"].includes(error?.code)) throw error;
      }
    }
    throw lastError || new Error("Не удалось открыть WebSocket-порты 9223–9232");
  }

  async waitForConnection(timeoutMs = 25000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (this.wsServer?.isClientConnected()) return this.wsServer.getConnectedFileInfo();
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    throw new Error(`Desktop Bridge не подключён к ws://${this.host}:${this.port}. Откройте плагин в целевом файле Figma.`);
  }

  async execute(code, { timeout = 30000, fileKey } = {}) {
    await this.waitForConnection();
    const response = await this.wsServer.sendCommand("EXECUTE_CODE", { code, timeout }, timeout + 2000, fileKey);
    if (!response?.success) throw new Error(response?.error || "Figma Plugin API вернул ошибку");
    return {
      result: response.result,
      resultAnalysis: response.resultAnalysis,
      fileContext: response.fileContext || this.wsServer.getConnectedFileInfo(),
    };
  }

  status() {
    return {
      version: SERVER_VERSION,
      host: this.host,
      port: this.port,
      connected: this.wsServer?.isClientConnected() || false,
      file: this.wsServer?.getConnectedFileInfo() || null,
      files: this.wsServer?.getConnectedFiles() || [],
    };
  }

  async captureScreenshot(nodeId, { scale = 1, fileKey } = {}) {
    await this.waitForConnection();
    const response = await this.wsServer.sendCommand("CAPTURE_SCREENSHOT", { nodeId, format: "PNG", scale }, 30000, fileKey);
    if (!response?.success) throw new Error(response?.error || "Не удалось получить снимок Figma");
    return response.image;
  }

  async stop() {
    await this.wsServer?.stop();
  }
}
