import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { webcrypto } from 'node:crypto';
import vm from 'node:vm';
import channel from '../src/secure-channel.cjs';

function pair({ clientChannel = channel, clientSeed, role = 'plugin', port = 9232 } = {}) {
  const serverSeed = channel.newSeed(), pluginSeed = channel.newSeed();
  const errors = [], messages = [], queue = [], wire = [];
  let ready = 0, server, client;
  const transmit = (target, message) => { wire.push({ target, message: structuredClone(message) }); queue.push({ target, message }); };
  server = channel.create({ side: 'server', port: 9232, identity: { seed: serverSeed, peers: { plugin: channel.publicKey(pluginSeed) } }, send: message => transmit('client', message), onReady: () => ready++, onMessage: message => messages.push(message), onError: error => errors.push(error) });
  client = clientChannel.create({ side: 'client', port, identity: { seed: clientSeed || pluginSeed, role, serverKey: channel.publicKey(serverSeed) }, send: message => transmit('server', message), onReady: () => ready++, onMessage: message => messages.push(message), onError: error => errors.push(error) });
  const deliver = packet => (packet.target === 'client' ? client : server).receive(packet.message);
  const flush = () => { for (let i = 0; queue.length && i < 20; i++) deliver(queue.shift()); };
  server.start();
  return { server, client, queue, wire, errors, messages, deliver, flush, get ready() { return ready; } };
}

test('автосопряжение: обе стороны подтверждены, команды зашифрованы', () => {
  const p = pair(); p.flush();
  assert.equal(p.ready, 2);
  p.client.send({ method: 'EXECUTE_CODE', text: 'Привет 👋' }); p.flush();
  p.server.send({ result: 'Готово' }); p.flush();
  assert.deepEqual(p.messages, [{ method: 'EXECUTE_CODE', text: 'Привет 👋' }, { result: 'Готово' }]);
  assert.equal(JSON.stringify(p.wire).includes('EXECUTE_CODE'), false);
});

test('чужой ключ, неверная роль и другой порт не получают доступ', () => {
  for (const options of [{ clientSeed: channel.newSeed() }, { role: 'mcp' }, { port: 9231 }]) {
    const p = pair(options); p.flush();
    assert.equal(p.ready, 0);
    assert.ok(p.errors.length);
    assert.throws(() => p.client.send({ method: 'EXECUTE_CODE' }));
  }
});

test('подмена сервера или подписанного эфемерного ключа отклоняется до передачи данных', () => {
  for (const field of [2, 4]) {
    const p = pair();
    p.queue[0].message.data[field] = channel.newSeed();
    p.flush();
    assert.equal(p.ready, 0);
    assert.ok(p.errors.length);
    assert.equal(p.wire.length, 1);
  }
});

test('повтор handshake из другого соединения не проходит', () => {
  const first = pair(); first.flush();
  const second = pair();
  const response = first.wire.find(packet => packet.message.type === 'SECURE_RESPONSE');
  second.server.receive(response.message);
  assert.equal(second.server.ready, false);
  assert.ok(second.errors.length);
});

test('подмена, повтор, отражение и незашифрованная команда закрывают канал', () => {
  for (const attack of ['tamper', 'replay', 'reflect', 'plaintext']) {
    const p = pair(); p.flush();
    p.client.send({ method: 'EXECUTE_CODE' });
    const packet = structuredClone(p.queue.shift());
    if (attack === 'tamper') packet.message.box = (packet.message.box[0] === 'a' ? 'b' : 'a') + packet.message.box.slice(1);
    if (attack === 'replay') p.deliver(packet);
    if (attack === 'reflect') packet.target = 'client';
    if (attack === 'plaintext') packet.message = { method: 'EXECUTE_CODE' };
    p.deliver(packet);
    assert.ok(p.errors.length, attack);
    assert.equal(p.messages.length, attack === 'replay' ? 1 : 0, attack);
  }
});

test('браузерная реализация работает без crypto.subtle и совместима с Node', async () => {
  const require = createRequire(import.meta.url);
  const context = { TextEncoder, TextDecoder, Uint8Array, DataView, crypto: { getRandomValues: array => webcrypto.getRandomValues(array) } };
  context.self = context;
  vm.createContext(context);
  vm.runInContext(await readFile(require.resolve('tweetnacl/nacl-fast.min.js'), 'utf8'), context);
  vm.runInContext(await readFile(new URL('../src/secure-channel.cjs', import.meta.url), 'utf8'), context);
  const p = pair({ clientChannel: context.FigmaSecureChannel }); p.flush();
  assert.equal(p.ready, 2);
  p.client.send({ text: 'Figma sandbox' }); p.flush();
  assert.deepEqual(p.messages, [{ text: 'Figma sandbox' }]);
});
