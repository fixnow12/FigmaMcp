import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { errorDetails } from './bridge-errors.mjs';
import { FigmaBridge } from './bridge.mjs';
import { installationDirectory, loadInstallation, identityFor } from './installation.mjs';
import { brokerRevision, runtimeInfo } from './runtime-info.mjs';

export async function startBroker({ directory = installationDirectory(), port = 9233, idleMs = 60000, queueTimeoutMs = 5000,
  isRuntimeCurrent = () => brokerRevision() === runtimeInfo.brokerRevision } = {}) {
  const installation = await loadInstallation(directory);
  const queues = new Map();
  const sessions = new Set();
  let idleTimer;
  let restartTimer;
  let restarting = false;
  let activeOperations = 0;
  const uncertainFiles = new Set();
  const bridge = new FigmaBridge({ host: '127.0.0.1', port, portFallback: false, identity: identityFor(installation, 'server'), onMcpConnection });

  function scheduleIdle() {
    clearTimeout(idleTimer);
    if (!sessions.size && !uncertainFiles.size) idleTimer = setTimeout(() => void stop(), idleMs);
    idleTimer?.unref?.();
  }
  function status() {
    const full = bridge.status();
    return { ...full, file: full.files.length === 1 ? full.files[0] : null };
  }
  function maintenanceStatus() {
    const full = status();
    if (isRuntimeCurrent()) return full;
    const busy = activeOperations > 0 || queues.size > 0 || uncertainFiles.size > 0;
    if (!busy && !restarting) {
      restarting = true;
      // Let the encrypted status response flush before closing sockets. The
      // restart flag synchronously prevents any later canvas request entering.
      restartTimer = setTimeout(() => void stop(), 50);
    }
    return { ...full, maintenance: { state: restarting ? 'restarting' : 'deferred',
      activeOperations, uncertainFiles: [...uncertainFiles] } };
  }
  async function resolveFile(session, requested) {
    await bridge.waitForConnection(10000);
    if (session.closed) throw new Error('AI-сессия закрыта');
    let target = requested;
    if (!target) {
      const available = status().files;
      if (available.length !== 1) {
        throw new Error(available.length ? `Открыто несколько файлов. Укажите fileKey: ${available.map(file => `${file.fileName} (${file.fileKey})`).join(', ')}` : 'Нет подключённых файлов Figma.');
      }
      target = available[0].fileKey;
    }
    if (typeof target !== 'string' || !bridge.status().files.some(file => file.fileKey === target)) throw new Error('Указанный файл не подключён');
    return target;
  }
  async function runForFile(session, fileKey, operation) {
    const previous = queues.get(fileKey) || Promise.resolve();
    let unlock;
    const current = new Promise(resolve => { unlock = resolve; });
    // Keep the whole chain: cancelling a waiter must not let a later command
    // overtake the operation that is still running in Figma.
    const tail = previous.then(() => current);
    queues.set(fileKey, tail);
    let timer;
    try {
      await Promise.race([
        previous,
        new Promise((_, reject) => {
          timer = setTimeout(() => reject(Object.assign(new Error('Файл выполняет другую операцию. Команда не отправлена в Figma.'), {
            operationStatus: 'not_applied', code: 'FILE_BUSY', fileKey,
            nextStep: 'Дождитесь завершения текущей операции в Bridge. Не запускайте цикл повторов с sleep.',
          })), queueTimeoutMs);
        }),
      ]);
      clearTimeout(timer);
      if (session.closed) throw new Error('AI-сессия закрыта; команда не отправлена в Figma.');
      if (!bridge.status().files.some(file => file.fileKey === fileKey)) throw new Error('Указанный файл не подключён');
      return await operation();
    } finally {
      clearTimeout(timer);
      unlock();
      void tail.then(() => { if (queues.get(fileKey) === tail) queues.delete(fileKey); });
    }
  }
  function release(session) {
    if (!session.closed || session.pending) return;
    sessions.delete(session);
    scheduleIdle();
  }
  function onMcpConnection(ws) {
    const session = { id: randomUUID(), closed: false, pending: 0, requests: new Set() };
    sessions.add(session);
    scheduleIdle();
    return {
      receive(message) {
        if (!message || typeof message.id !== 'string' || message.id.length > 100 || session.requests.has(message.id) || session.pending >= 32) { ws.close(4400, 'Invalid request'); return; }
        session.requests.add(message.id);
        session.pending++;
        void (async () => {
          let fileOperation = false;
          let targetFile;
          try {
            let result;
            if (message.method === 'status') result = maintenanceStatus();
            else if (message.method === 'executionStatus') {
              const fileKey = message.args?.fileKey;
              if (typeof fileKey !== 'string' || !status().files.some(file => file.fileKey === fileKey)) throw new Error('Указанный файл не подключён');
              // Readiness bypasses the canvas queue, including a stuck operation.
              result = await bridge.executionStatus(fileKey);
            }
            else if (['execute', 'captureScreenshot'].includes(message.method)) {
              if (restarting) throw Object.assign(new Error('Broker обновляется; команда не отправлена в Figma.'), {
                code: 'BRIDGE_RESTARTING', operationStatus: 'not_applied', nextStep: 'Вызовите get_status для восстановления подключения.',
              });
              fileOperation = true;
              activeOperations++;
              const args = message.args || {};
              const fileKey = await resolveFile(session, args.fileKey);
              targetFile = fileKey;
              if (message.method === 'execute') {
                if (typeof args.code !== 'string' || args.code.length > 8 * 1024 * 1024) throw new Error('Неверная команда');
                const timeout = Math.min(60000, Math.max(1000, Number(args.timeout) || 30000));
                result = await runForFile(session, fileKey, () => bridge.execute(args.code, {
                  timeout,
                  fileKey,
                  pageId: args.pageId,
                  operation: args.operation,
                }));
                if (args.operation?.mutating === false) uncertainFiles.delete(fileKey);
              } else result = await runForFile(session, fileKey, () => bridge.captureScreenshot(args.nodeId, { scale: args.scale, fileKey }));
            } else throw new Error('Неизвестная операция Bridge');
            if (!session.closed) ws.send(JSON.stringify({ id: message.id, result }));
          } catch (error) {
            // A failed read/export cannot leave an unconfirmed canvas write.
            // Preserve any earlier uncertain write until a successful read-back.
            const mutating = message.method === 'execute' && message.args?.operation?.mutating !== false;
            if (targetFile && mutating && error.operationStatus === 'unknown') uncertainFiles.add(targetFile);
            if (!session.closed && ws.readyState === 1) ws.send(JSON.stringify({ id: message.id, error: error.message, errorDetails: errorDetails(error) }));
          } finally {
            if (fileOperation) activeOperations--;
            session.pending--;
            session.requests.delete(message.id);
            release(session);
          }
        })();
      },
      close() { session.closed = true; release(session); },
    };
  }
  let stopped = false;
  let onStop;
  async function stop() {
    if (stopped) return;
    stopped = true;
    clearTimeout(restartTimer);
    clearTimeout(idleTimer);
    await bridge.stop();
    clearTimeout(idleTimer);
    await onStop?.();
  }
  await bridge.start();
  scheduleIdle();
  return { bridge, stop, set onStop(callback) { onStop = callback; } };
}

async function run() {
  let broker;
  try { broker = await startBroker(); }
  catch (error) { if (error.code === 'EADDRINUSE') return; throw error; }
  for (const signal of ['SIGTERM', 'SIGINT']) process.once(signal, () => void broker.stop());
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  run().catch(error => { process.stderr.write(`Bridge: ${error.message}\n`); process.exitCode = 1; });
}
