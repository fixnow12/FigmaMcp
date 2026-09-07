import { WebSocket } from 'ws';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { remoteError } from './bridge-errors.mjs';
import channel from './secure-channel.cjs';
import { installationDirectory, loadInstallation, identityFor } from './installation.mjs';

export function connectSecure(port, identity, { timeout = 2000, onMessage = () => {}, onClose = () => {} } = {}) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}`, { maxPayload: 250 * 1024 * 1024 });
    let ready = false;
    const timer = setTimeout(() => { ws.terminate(); reject(new Error('Bridge authentication timeout')); }, timeout);
    const secure = channel.create({
      side: 'client', identity, port,
      send: message => ws.send(JSON.stringify(message)),
      onReady: () => { clearTimeout(timer); ready = true; resolve({ ws, secure }); },
      onMessage,
      onError: error => { reject(error); ws.close(4403, 'Secure connection rejected'); },
    });
    ws.on('message', raw => { try { secure.receive(JSON.parse(String(raw))); } catch { ws.close(4400, 'Invalid message'); } });
    ws.on('error', reject);
    ws.on('close', () => {
      clearTimeout(timer);
      secure.close();
      if (ready) onClose();
      else reject(new Error('Bridge connection closed'));
    });
  });
}

function interruptedRequest(message, code, method, args) {
  const uncertain = method === 'execute' && args.operation?.mutating !== false;
  return Object.assign(new Error(message), {
    code, operationStatus: uncertain ? 'unknown' : 'not_applied',
    ...(args.fileKey ? { fileKey: args.fileKey } : {}),
    nextStep: uncertain
      ? 'Запись могла выполниться. Восстановите подключение и прочитайте затронутые узлы перед повтором; не отправляйте запись автоматически.'
      : 'Восстановите подключение MCP и повторите чтение.',
  });
}

export class BrokerClient {
  constructor({ directory = installationDirectory(), ports = [9233], autoStart = true } = {}) {
    this.directory = directory;
    this.ports = ports;
    this.autoStart = autoStart;
    this.pending = new Map();
    this.connection = null;
    this.connecting = null;
    this.closed = false;
  }
  async start() { /* Defer local process creation until the first Figma tool call. */ }
  async connect() {
    if (this.closed) throw new Error('AI-сессия Bridge завершена. Перезапустите MCP для нового подключения.');
    if (this.connection) return this.connection;
    if (this.connecting) return this.connecting;
    this.connecting = this.discover().finally(() => { this.connecting = null; });
    return this.connecting;
  }
  async discover() {
    const identity = identityFor(await loadInstallation(this.directory), 'mcp');
    let started = false;
    let lastError;
    for (let attempt = 0; attempt < (this.autoStart ? 30 : 1); attempt++) {
      // Sequential attempts avoid accidentally opening multiple connections.
      for (const port of this.ports) {
        try {
          const connection = await connectSecure(port, identity, {
            onMessage: message => {
              const pending = this.pending.get(message?.id);
              if (!pending) return;
              clearTimeout(pending.timer);
              this.pending.delete(message.id);
              if (message.error) pending.reject(remoteError(message.error, message.errorDetails));
              else pending.resolve(message.result);
            },
            onClose: () => this.connectionLost(),
          });
          if (this.closed) { connection.ws.close(); throw new Error('Сессия закрыта'); }
          this.connection = connection;
          return connection;
        } catch (error) { lastError = error; }
      }
      if (this.autoStart && !started) {
        const child = spawn(process.execPath, [fileURLToPath(new URL('./broker.mjs', import.meta.url))], {
          detached: true, stdio: 'ignore', windowsHide: true,
          env: { ...process.env, FIGMA_LOCAL_STATE_DIR: this.directory },
        });
        child.on('error', error => { lastError = error; });
        child.unref();
        started = true;
      }
      if (this.autoStart) await new Promise(resolve => setTimeout(resolve, 200));
    }
    throw new Error(`Не удалось подключиться к доверенному Bridge. Проверьте установку и порт 9233. ${lastError?.message || ''}`);
  }
  connectionLost() {
    this.connection = null;
    this.closed = true;
    for (const pending of this.pending.values()) { clearTimeout(pending.timer); pending.reject(interruptedRequest('Bridge отключился; доступ этой AI-сессии завершён.', 'BRIDGE_DISCONNECTED', pending.method, pending.args)); }
    this.pending.clear();
  }
  async call(method, args = {}) {
    const { secure } = await this.connect();
    const id = randomUUID();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(interruptedRequest('Истекло время ожидания Bridge', 'BRIDGE_TIMEOUT', method, args)); }, 90000);
      this.pending.set(id, { resolve, reject, timer, method, args });
      try { secure.send({ id, method, args }); } catch (error) { clearTimeout(timer); this.pending.delete(id); reject(interruptedRequest(error.message, 'BRIDGE_SEND_FAILED', method, args)); }
    });
  }
  execute(code, options = {}) { return this.call('execute', { ...options, code }); }
  captureScreenshot(nodeId, options = {}) { return this.call('captureScreenshot', { ...options, nodeId }); }
  status() { return this.call('status'); }
  async runInFile(fileKey, operation, { requireExplicitFile = false } = {}) {
    const status = await this.status();
    const files = status.files || [];
    if (requireExplicitFile && !fileKey && files.length > 1) {
      throw new Error('Подключено несколько файлов. Укажите fileKey из get_status перед изменением макета.');
    }
    const target = fileKey
      ? files.find(file => file.fileKey === fileKey)
      : files.length === 1 ? files[0] : status.file;
    if (!target) throw new Error(fileKey ? `Целевой файл Figma не подключён: ${fileKey}` : 'Нет подключённого файла Figma.');
    return operation({ fileKey: target.fileKey, pageId: target.currentPageId });
  }
  async stop() {
    const connection = this.connection;
    this.connectionLost();
    connection?.ws.close();
  }
}
