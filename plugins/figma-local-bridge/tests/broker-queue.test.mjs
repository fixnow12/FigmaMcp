import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { prepareInstallation } from '../scripts/prepare-install.mjs';
import { startBroker } from '../src/broker.mjs';
import { BrokerClient } from '../src/broker-client.mjs';

const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(check) {
  for (let i = 0; i < 200; i++) { if (check()) return; await pause(5); }
  throw new Error('Timed out');
}

async function fixture(t, options = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'figma-queue-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await prepareInstallation(directory);
  const broker = await startBroker({ directory, port: 0, ...options });
  t.after(() => broker.stop());
  // Keep the real authenticated broker and clients, but hold Figma operations
  // deterministically to exercise races without touching a user's document.
  broker.bridge.waitForConnection = async () => {};
  broker.bridge.status = () => ({ connected: true, files: [{ fileKey: 'a' }, { fileKey: 'b' }] });
  const calls = [];
  broker.bridge.execute = (code, { fileKey }) => new Promise((resolve, reject) => calls.push({ code, fileKey, resolve, reject }));
  broker.bridge.captureScreenshot = (nodeId, { fileKey }) => new Promise((resolve, reject) => calls.push({ nodeId, fileKey, resolve, reject }));
  const clients = await Promise.all([0, 1, 2].map(async () => {
    const client = new BrokerClient({ directory, ports: [broker.bridge.port], autoStart: false });
    t.after(() => client.stop());
    await client.connect();
    return client;
  }));
  return { calls, clients, broker };
}

for (const kind of ['read', 'screenshot']) test(`ошибка ${kind} не удерживает broker как неизвестную запись`, async t => {
  let current = true;
  const { calls, clients: [client] } = await fixture(t, { isRuntimeCurrent: () => current });
  const request = kind === 'read'
    ? client.execute('inspect', { fileKey: 'a', operation: { mutating: false } })
    : client.captureScreenshot('1:2', { fileKey: 'a' });
  const rejected = assert.rejects(request, /timeout/);
  await until(() => calls.length === 1);
  calls[0].reject(Object.assign(new Error('timeout'), { operationStatus: 'unknown' }));
  await rejected;
  current = false;
  const status = await client.call('status');
  assert.deepEqual(status.maintenance.uncertainFiles, []);
  assert.equal(status.maintenance.state, 'restarting');
});

test('операции одного файла идут последовательно; другой файл и статус не блокируются', async t => {
  const { calls, clients: [first, second] } = await fixture(t);
  const a = first.execute('first', { fileKey: 'a' });
  await until(() => calls.length === 1);
  const next = second.execute('second', { fileKey: 'a' });
  const b = second.execute('other file', { fileKey: 'b' });
  await until(() => calls.length === 2);
  assert.deepEqual(calls.map(call => call.code), ['first', 'other file']);
  assert.equal((await second.status()).files.length, 2);
  calls[1].resolve('b');
  assert.equal(await b, 'b');
  calls[0].resolve('a');
  assert.equal(await a, 'a');
  await until(() => calls.length === 3);
  calls[2].reject(new Error('Figma failure'));
  await assert.rejects(next, /Figma failure/);
  const screenshot = first.captureScreenshot('1:2', { fileKey: 'a' });
  await until(() => calls.length === 4);
  const after = second.execute('after screenshot', { fileKey: 'a' });
  await pause(20);
  assert.equal(calls.length, 4);
  calls[3].resolve('png');
  assert.equal(await screenshot, 'png');
  await until(() => calls.length === 5);
  calls[4].resolve('done');
  assert.equal(await after, 'done');
});

test('истёкший запрос очереди не выполняется позже и не пропускает следующий мимо активного', async t => {
  const { calls, clients: [first, second] } = await fixture(t, { queueTimeoutMs: 50 });
  const active = first.execute('active', { fileKey: 'a' });
  await until(() => calls.length === 1);
  await assert.rejects(second.execute('expired', { fileKey: 'a' }), error => {
    assert.match(error.message, /Команда не отправлена/);
    assert.equal(error.operationStatus, 'not_applied');
    assert.equal(error.code, 'FILE_BUSY');
    assert.equal(error.fileKey, 'a');
    return true;
  });
  const next = second.execute('next', { fileKey: 'a' });
  await pause(10);
  assert.equal(calls.length, 1);
  calls[0].resolve('done');
  await active;
  await until(() => calls.length === 2);
  assert.equal(calls[1].code, 'next');
  calls[1].resolve('done');
  await next;
  assert.equal(calls.some(call => call.code === 'expired'), false);
});

test('broker сохраняет неизвестный результат и ошибки отката через защищённый канал', async t => {
  const { calls, clients: [client] } = await fixture(t);
  for (const operationStatus of ['unknown', 'partial', 'rolled_back', 'not_applied']) {
    const pending = client.execute('failing', { fileKey: 'a' });
    const rejected = assert.rejects(pending, error => {
      assert.equal(error.operationStatus, operationStatus);
      assert.deepEqual(error.rollbackErrors, ['Узел 1:2']);
      return true;
    });
    await until(() => calls.length > 0);
    calls.shift().reject(Object.assign(new Error('Ошибка Figma'), { operationStatus, rollbackErrors: ['Узел 1:2'] }));
    await rejected;
  }
});

test('закрытие сессии отменяет её очередь, но не освобождает уже выполняющуюся операцию', async t => {
  const { calls, clients: [first, second, third] } = await fixture(t);
  const active = first.execute('active', { fileKey: 'a' });
  const activeRejected = assert.rejects(active, /отключился/);
  await until(() => calls.length === 1);
  const cancelled = second.execute('cancelled', { fileKey: 'a' });
  const cancelledRejected = assert.rejects(cancelled, /отключился/);
  // Status is handled after the execute packet has registered its waiter.
  await second.status();
  await second.stop();
  await first.stop();
  await Promise.all([activeRejected, cancelledRejected]);
  await pause(20);
  const next = third.execute('next', { fileKey: 'a' });
  await pause(20);
  assert.equal(calls.length, 1);
  calls[0].resolve('done');
  await until(() => calls.length === 2);
  assert.equal(calls[1].code, 'next');
  calls[1].resolve('done');
  await next;
});

test('устаревший broker откладывает обновление до завершения всех операций', async t => {
  let current = true;
  const { calls, clients: [client], broker } = await fixture(t, { isRuntimeCurrent: () => current });
  const active = client.execute('active', { fileKey: 'a' });
  await until(() => calls.length === 1);
  current = false;
  assert.equal((await client.call('status')).maintenance?.state, 'deferred');
  assert.ok(broker.bridge.port);
  calls[0].resolve('done');
  await active;
  assert.equal((await client.call('status')).maintenance?.state, 'restarting');
  await assert.rejects(client.execute('too late', { fileKey: 'a' }), error => {
    assert.equal(error.code, 'BRIDGE_RESTARTING');
    assert.equal(error.operationStatus, 'not_applied');
    return true;
  });
  await until(() => client.connection === null);
  assert.equal(calls.length, 1);
});

test('тот же MCP восстанавливает защищённое соединение после перезапуска broker', async t => {
  const { clients: [client], broker } = await fixture(t);
  const port = broker.bridge.port;
  await broker.stop();
  await until(() => client.connection === null);
  const replacement = await startBroker({ directory: client.directory, port });
  t.after(() => replacement.stop());
  assert.equal((await client.status()).port, port);
  assert.equal(client.closed, false);
});

test('неизвестный результат удерживает обновление до успешного чтения файла', async t => {
  let current = true;
  const { calls, clients: [client] } = await fixture(t, { isRuntimeCurrent: () => current });
  const write = client.execute('write', { fileKey: 'a', operation: { mutating: true } });
  const rejected = assert.rejects(write, { operationStatus: 'unknown' });
  await until(() => calls.length === 1);
  calls[0].reject(Object.assign(new Error('timeout'), { operationStatus: 'unknown' }));
  await rejected;
  current = false;
  const status = await client.status();
  assert.equal(status.maintenance.state, 'deferred');
  assert.deepEqual(status.maintenance.uncertainFiles, ['a']);
  const read = client.execute('inspect', { fileKey: 'a', operation: { mutating: false } });
  await until(() => calls.length === 2);
  calls[1].resolve('read-back');
  await read;
  assert.equal((await client.call('status')).maintenance.state, 'restarting');
});

test('idle shutdown не теряет неизвестный результат после закрытия MCP', async t => {
  const { calls, clients, broker } = await fixture(t, { idleMs: 300 });
  let stopped = false;
  broker.onStop = () => { stopped = true; };
  const write = clients[0].execute('write', { fileKey: 'a' });
  const rejected = assert.rejects(write, { operationStatus: 'unknown' });
  await until(() => calls.length === 1);
  calls[0].reject(Object.assign(new Error('timeout'), { operationStatus: 'unknown' }));
  await rejected;
  await Promise.all(clients.map(client => client.stop()));
  await pause(450);
  assert.equal(stopped, false);
});

test('один status автоматически восстанавливается через обновление broker', async t => {
  let current = true;
  const { clients: [client], broker } = await fixture(t, { isRuntimeCurrent: () => current });
  const port = broker.bridge.port;
  let resolveReplacement;
  const replacementReady = new Promise(resolve => { resolveReplacement = resolve; });
  broker.onStop = async () => {
    const replacement = await startBroker({ directory: client.directory, port });
    t.after(() => replacement.stop());
    resolveReplacement();
  };
  // Production discover starts a child broker; this fixture supplies the new
  // real authenticated broker in-process on the same ephemeral port instead.
  const discover = client.discover.bind(client);
  client.discover = async () => { await replacementReady; return discover(); };
  current = false;
  const status = await client.status();
  assert.equal(status.port, port);
  assert.equal(status.maintenance, undefined);
});
