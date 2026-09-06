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
  broker.bridge.captureScreenshot = (nodeId, { fileKey }) => new Promise(resolve => calls.push({ nodeId, fileKey, resolve }));
  const clients = await Promise.all([0, 1, 2].map(async () => {
    const client = new BrokerClient({ directory, ports: [broker.bridge.port], autoStart: false });
    t.after(() => client.stop());
    await client.connect();
    return client;
  }));
  return { calls, clients, broker };
}

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
  await assert.rejects(second.execute('expired', { fileKey: 'a' }), /Команда не отправлена/);
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
