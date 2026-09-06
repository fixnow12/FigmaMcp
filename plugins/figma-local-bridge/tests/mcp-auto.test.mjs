import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { prepareInstallation } from '../scripts/prepare-install.mjs';
import { loadInstallation, identityFor } from '../src/installation.mjs';
import { startBroker } from '../src/broker.mjs';
import { connectSecure } from '../src/broker-client.mjs';

test('stdio MCP: два чата читают один файл, includeFiles работает с нулём и несколькими файлами', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'figma-mcp-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await prepareInstallation(directory);
  const data = await loadInstallation(directory);
  const broker = await startBroker({ directory, port: 0 }); t.after(() => broker.stop());
  const commands = [];
  async function addPlugin(fileKey) {
    let plugin;
    plugin = await connectSecure(broker.bridge.port, identityFor(data, 'plugin'), {
      onMessage: message => {
        commands.push({ fileKey, method: message.method });
        plugin.secure.send({ id: message.id, result: { success: true, result: { selection: [] }, fileContext: { fileKey } } });
      },
    });
    t.after(() => plugin.ws.terminate());
    plugin.secure.send({ type: 'FILE_INFO', data: { fileKey, fileName: fileKey } });
    for (let i = 0; i < 100 && !broker.bridge.status().files.some(file => file.fileKey === fileKey); i++) await new Promise(resolve => setTimeout(resolve, 10));
    assert.ok(broker.bridge.status().files.some(file => file.fileKey === fileKey));
  }
  async function mcp() {
    // Use an ephemeral test port so updating an already running installation
    // does not require stopping the user's broker to run the installer tests.
    const entry = `
      import { BrokerClient } from ${JSON.stringify(new URL('../src/broker-client.mjs', import.meta.url).href)};
      const discover = BrokerClient.prototype.discover;
      BrokerClient.prototype.discover = function () { this.ports = [${broker.bridge.port}]; this.autoStart = false; return discover.call(this); };
      await import(${JSON.stringify(new URL('../src/server.mjs', import.meta.url).href)});
    `;
    const transport = new StdioClientTransport({ command: process.execPath, args: ['--input-type=module', '--eval', entry], env: { ...process.env, FIGMA_LOCAL_STATE_DIR: directory }, stderr: 'pipe' });
    const client = new Client({ name: 'auto-test', version: '1' });
    t.after(() => client.close());
    await client.connect(transport);
    return client;
  }
  const first = await mcp(), second = await mcp();
  const call = (client, args = {}) => client.callTool({ name: 'inspect_selection', arguments: { includeFiles: true, ...args } });
  const empty = await call(first);
  assert.equal(empty.isError, undefined);
  assert.deepEqual(JSON.parse(empty.content[0].text).connectedFiles, []);
  assert.equal(JSON.parse(empty.content[0].text).selectionInspected, false);
  assert.equal(commands.length, 0);
  await addPlugin('stdio-file');
  const result = await call(first);
  assert.equal(result.isError, undefined);
  assert.equal(JSON.parse(result.content[0].text).connectedFiles[0].fileKey, 'stdio-file');
  assert.equal((await call(second)).isError, undefined);
  await addPlugin('second-file');
  const before = commands.length;
  const inventory = await call(second);
  assert.equal(inventory.isError, undefined);
  const payload = JSON.parse(inventory.content[0].text);
  assert.equal(payload.connectedFiles.length, 2);
  assert.equal(payload.requiresFileKey, true);
  assert.equal(payload.selectionInspected, false);
  assert.equal(commands.length, before, 'список файлов не должен отправлять команды на холст');
  assert.equal((await call(first, { fileKey: 'stdio-file' })).isError, undefined);
  assert.equal((await call(second, { fileKey: 'stdio-file' })).isError, undefined);
  assert.equal((await call(second, { fileKey: 'second-file' })).isError, undefined);
  assert.equal(commands.at(-1).fileKey, 'second-file');
  await first.close();
  await new Promise(resolve => setTimeout(resolve, 50));
  assert.equal((await call(second, { fileKey: 'stdio-file' })).isError, undefined);
});
