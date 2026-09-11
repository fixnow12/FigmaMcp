import test from 'node:test';
import assert from 'node:assert/strict';
import { BrokerClient } from '../src/broker-client.mjs';
import { FigmaBridge } from '../src/bridge.mjs';
import { toolFailure } from '../src/tool-results.mjs';

test('статус отсчитывает окно подключения от запуска конкретного Bridge', async t => {
  await new Promise(resolve => setTimeout(resolve, 20));
  const notBefore = Date.now();
  const bridge = new FigmaBridge({ host: '127.0.0.1', port: 0, authToken: 'test-token-for-local-status-only' });
  await bridge.start();
  t.after(() => bridge.stop());
  assert.ok(Date.parse(bridge.status().runtime.startedAt) >= notBefore);
});

// Model the broker being available before the plugin's discovery/authentication
// finishes, without opening Figma or waiting five real seconds in every test.
async function startupStatus(t, { age = 117, attachAfter = Infinity, maintenance, otherFile = false, fileKey } = {}) {
  const now = Date.now();
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now });
  const client = new BrokerClient({ autoStart: false });
  client.call = async method => {
    assert.equal(method, 'status', 'startup must never send canvas commands');
    const files = Date.now() - now >= attachAfter ? [{ fileKey: 'guide' }] : [];
    if (otherFile) files.push({ fileKey: 'other' });
    return { connected: files.length > 0, files,
      runtime: { startedAt: new Date(now - age).toISOString() },
      ...(maintenance ? { maintenance } : {}) };
  };
  let settled = false;
  const request = client.status({ fileKey }).finally(() => { settled = true; });
  for (let step = 0; step < 41; step++) {
    await new Promise(resolve => setImmediate(resolve));
    if (settled) break;
    t.mock.timers.tick(250);
  }
  assert.ok(settled, 'status must finish within a bounded startup window');
  return { status: await request, elapsed: Date.now() - now };
}

test('первый статус ждёт файл, который автоматически подключается после старта broker', async t => {
  const { status, elapsed } = await startupStatus(t, { attachAfter: 4000 });
  assert.equal(status.connected, true);
  assert.equal(status.files[0].fileKey, 'guide');
  assert.ok(elapsed >= 4000 && elapsed <= 5000);
});

test('ожидание файла ограничено первыми пятью секундами жизни broker', async t => {
  const { status, elapsed } = await startupStatus(t);
  assert.equal(status.connected, false);
  assert.ok(elapsed >= 4750 && elapsed <= 5000);
});

test('давно запущенный broker без файлов отвечает без задержки', async t => {
  const { status, elapsed } = await startupStatus(t, { age: 60000 });
  assert.equal(status.connected, false);
  assert.equal(elapsed, 0);
});

test('явно запрошенный подключённый файл не задерживает статус даже нового broker', async t => {
  const { status, elapsed } = await startupStatus(t, { attachAfter: 0, fileKey: 'guide' });
  assert.equal(status.connected, true);
  assert.equal(elapsed, 0);
});

test('старт нового broker ждёт целевой файл, даже если другой уже подключился', async t => {
  const { status, elapsed } = await startupStatus(t, { otherFile: true, fileKey: 'guide', attachAfter: 4000 });
  assert.equal(status.files.some(file => file.fileKey === 'guide'), true);
  assert.ok(elapsed >= 4000 && elapsed <= 5000);
});

test('выбор операции передаёт целевой файл в проверку подключения', async () => {
  const client = new BrokerClient({ autoStart: false });
  client.status = async options => ({ files: options?.fileKey === 'guide' ? [{ fileKey: 'guide', currentPageId: 'page' }] : [{ fileKey: 'other' }] });
  const target = await client.runInFile('guide', async target => target);
  assert.deepEqual(target, { fileKey: 'guide', pageId: 'page' });
});

test('отложенное обслуживание сразу возвращается клиенту', async t => {
  const { status, elapsed } = await startupStatus(t, { maintenance: { state: 'deferred' } });
  assert.equal(status.maintenance.state, 'deferred');
  assert.equal(elapsed, 0);
});

for (const mutating of [true, false, undefined]) test(`обрыв broker сохраняет статус отправленной операции: mutating=${mutating}`, async () => {
  const client = new BrokerClient({ autoStart: false });
  const sent = [];
  client.connection = { secure: { send: message => sent.push(message) } };
  const request = client.execute('return 1', { fileKey: 'target', operation: { mutating } });
  const check = assert.rejects(request, error => {
    const payload = toolFailure(error).structuredContent;
    assert.equal(payload.operationStatus, mutating === false ? 'not_applied' : 'unknown');
    assert.equal(payload.code, 'BRIDGE_DISCONNECTED');
    assert.equal(payload.fileKey, 'target');
    assert.ok(payload.nextStep);
    return true;
  });
  await Promise.resolve();
  client.connectionLost();
  await check;
  assert.equal(sent.length, 1);
  assert.equal(client.pending.size, 0);
  let discoveries = 0;
  client.discover = async () => {
    discoveries++;
    return { secure: { send() {} } };
  };
  await client.connect();
  assert.equal(discoveries, 1);
  assert.equal(sent.length, 1, 'отправленная операция не повторяется');
});

test('явное закрытие MCP остаётся окончательным', async () => {
  const client = new BrokerClient({ autoStart: false });
  await client.stop();
  await assert.rejects(client.connect(), /завершена/);
});

test('отказ аутентификации не восстанавливается автоматически', async () => {
  const client = new BrokerClient({ autoStart: false });
  client.connectionLost(4403);
  await assert.rejects(client.connect(), /завершена/);
});

test('ошибка отправки не маскирует неопределённый результат записи', async () => {
  const client = new BrokerClient({ autoStart: false });
  client.connection = { secure: { send: () => { throw new Error('socket closed'); } } };
  await assert.rejects(client.execute('return 1', { operation: { mutating: true } }), error => {
    assert.equal(error.operationStatus, 'unknown');
    assert.equal(error.code, 'BRIDGE_SEND_FAILED');
    return true;
  });
  assert.equal(client.pending.size, 0);
  client.connectionLost();
});


test('общий статус не завершает сбор списка на первом чужом файле нового broker', async t => {
  const { status, elapsed } = await startupStatus(t, { otherFile: true, attachAfter: 4000 });
  assert.deepEqual(status.files.map(file => file.fileKey).sort(), ['guide', 'other']);
  assert.ok(elapsed >= 4750 && elapsed <= 5000);
});

test('общий статус зрелого broker с файлами отвечает сразу', async t => {
  const { status, elapsed } = await startupStatus(t, { age: 60000, otherFile: true });
  assert.equal(status.connected, true);
  assert.equal(elapsed, 0);
});
