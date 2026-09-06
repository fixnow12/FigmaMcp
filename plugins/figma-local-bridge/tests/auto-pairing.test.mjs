import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, stat, rm, chmod } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import vm from 'node:vm';
import { prepareInstallation } from '../scripts/prepare-install.mjs';
import { loadInstallation, identityFor } from '../src/installation.mjs';
import { startBroker } from '../src/broker.mjs';
import { BrokerClient, connectSecure } from '../src/broker-client.mjs';
import channel from '../src/secure-channel.cjs';

async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'figma-auto-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const manifest = await prepareInstallation(directory);
  const installation = await loadInstallation(directory);
  return { directory, manifest, installation };
}
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(check) {
  for (let i = 0; i < 100; i++) { if (check()) return; await pause(10); }
  throw new Error('Timed out waiting for bridge');
}

test('установка создаёт персональный плагин без ручного кода и сохраняет ключи при обновлении', async t => {
  const { directory, manifest, installation } = await fixture(t);
  const firstUi = await readFile(join(directory, 'figma-plugin/ui.html'), 'utf8');
  const config = JSON.parse(await readFile(manifest, 'utf8'));
  assert.equal(config.name, 'Figma Desktop Bridge — Auto');
  const sourceManifest = JSON.parse(await readFile(new URL('../figma-plugin/manifest.json', import.meta.url), 'utf8'));
  assert.equal(config.id, sourceManifest.id, 'обновление должно сохранить namespace pluginData');
  assert.ok(firstUi.includes(installation.plugin));
  assert.equal(firstUi.includes(installation.server), false);
  assert.equal(firstUi.includes(installation.mcp), false);
  assert.doesNotMatch(firstUi, /local-pairing-code/);
  for (const script of firstUi.matchAll(/<script>([\s\S]*?)<\/script>/g)) assert.doesNotThrow(() => new vm.Script(script[1]));
  await prepareInstallation(directory);
  assert.deepEqual(await loadInstallation(directory), installation);
  assert.equal(await readFile(join(directory, 'figma-plugin/ui.html'), 'utf8'), firstUi);
  if (process.platform !== 'win32') {
    for (const file of ['identity.json', 'figma-plugin/ui.html']) assert.equal((await stat(join(directory, file))).mode & 0o077, 0);
    await chmod(join(directory, 'identity.json'), 0o644);
    await assert.rejects(loadInstallation(directory), /права только текущего пользователя/);
  }
});

test('единый broker: автосопряжение, общий доступ без захвата файлов, явный выбор и переподключение плагина', async t => {
  const { directory, installation } = await fixture(t);
  const broker = await startBroker({ directory, port: 0 });
  t.after(() => broker.stop());
  const received = [];
  async function plugin(fileKey) {
    let connection;
    connection = await connectSecure(broker.bridge.port, identityFor(installation, 'plugin'), {
      onMessage: message => {
        received.push({ fileKey, method: message.method });
        connection.secure.send({ id: message.id, result: { success: true, result: { fileKey }, fileContext: { fileKey } } });
      },
    });
    connection.secure.send({ type: 'FILE_INFO', data: { fileKey, fileName: fileKey } });
    t.after(() => connection.ws.terminate());
    return connection;
  }
  const firstPlugin = await plugin('file-a');
  await plugin('file-b');
  await until(() => broker.bridge.status().files.length === 2);
  const first = new BrokerClient({ directory, ports: [broker.bridge.port], autoStart: false });
  const second = new BrokerClient({ directory, ports: [broker.bridge.port], autoStart: false });
  t.after(() => first.stop()); t.after(() => second.stop());
  await assert.rejects(first.execute('return 1'), /Укажите fileKey/);
  assert.equal((await first.execute('return 1', { fileKey: 'file-a' })).result.fileKey, 'file-a');
  assert.equal((await second.execute('return 2', { fileKey: 'file-a' })).result.fileKey, 'file-a');
  await assert.rejects(second.execute('return 2'), /Укажите fileKey/);
  assert.equal((await second.execute('return 2', { fileKey: 'file-b' })).result.fileKey, 'file-b');
  await assert.rejects(first.execute('return 3'), /Укажите fileKey/);
  assert.equal((await second.status()).files.some(file => file.fileKey === 'file-a'), true);
  firstPlugin.ws.close();
  await until(() => broker.bridge.status().files.length === 1);
  await plugin('file-a');
  await until(() => broker.bridge.status().files.length === 2);
  assert.equal((await first.execute('return 4', { fileKey: 'file-a' })).result.fileKey, 'file-a');
  await first.stop();
  await pause(30);
  assert.equal((await second.execute('return 5', { fileKey: 'file-a' })).result.fileKey, 'file-a');
  assert.equal(received.length, 5);
});

test('broker отклоняет чужую установку и подмену роли до регистрации файла', async t => {
  const { directory, installation } = await fixture(t);
  const broker = await startBroker({ directory, port: 0 }); t.after(() => broker.stop());
  for (const identity of [
    { ...identityFor(installation, 'plugin'), seed: channel.newSeed() },
    { ...identityFor(installation, 'plugin'), role: 'mcp' },
    { ...identityFor(installation, 'mcp'), role: 'plugin' },
    { ...identityFor(installation, 'plugin'), serverKey: channel.publicKey(channel.newSeed()) },
  ]) await assert.rejects(connectSecure(broker.bridge.port, identity));
  assert.equal(broker.bridge.status().connected, false);
});

test('роль MCP не может зарегистрировать файл, роль plugin не может вызвать broker execute', async t => {
  const { directory, installation } = await fixture(t);
  const broker = await startBroker({ directory, port: 0 }); t.after(() => broker.stop());
  const responses = [];
  const mcp = await connectSecure(broker.bridge.port, identityFor(installation, 'mcp'), { onMessage: message => responses.push(message) });
  t.after(() => mcp.ws.terminate());
  mcp.secure.send({ id: 'forgery', method: 'FILE_INFO', args: { fileKey: 'fake' } });
  await until(() => responses.length > 0);
  assert.match(responses[0].error, /Неизвестная операция/);
  const plugin = await connectSecure(broker.bridge.port, identityFor(installation, 'plugin'));
  t.after(() => plugin.ws.terminate());
  plugin.secure.send({ id: 'forgery', method: 'execute', args: { code: 'return 1' } });
  await pause(20);
  assert.equal(broker.bridge.status().connected, false);
});
