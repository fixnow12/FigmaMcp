import test from 'node:test';
import assert from 'node:assert/strict';
import { BrokerClient } from '../src/broker-client.mjs';
import { toolFailure } from '../src/tool-results.mjs';

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
  await assert.rejects(client.status(), /завершена/);
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
