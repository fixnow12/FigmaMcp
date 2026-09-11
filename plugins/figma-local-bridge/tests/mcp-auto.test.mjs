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
import { pluginRevision } from '../src/runtime-info.mjs';

test('stdio MCP: два чата читают один файл, includeFiles работает с нулём и несколькими файлами', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'figma-mcp-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await prepareInstallation(directory);
  const data = await loadInstallation(directory);
  const broker = await startBroker({ directory, port: 0 }); t.after(() => broker.stop());
  const commands = [];
  const probes = [];
  let busyFile = null;
  async function addPlugin(fileKey, pluginBuild = pluginRevision()) {
    let plugin;
    plugin = await connectSecure(broker.bridge.port, identityFor(data, 'plugin'), {
      onMessage: message => {
        if (message.method === 'GET_EXECUTION_STATUS') {
          probes.push(fileKey);
          plugin.secure.send({ id: message.id, result: { success: true, busy: fileKey === busyFile,
            activeOperation: fileKey === busyFile ? { name: 'find_assets', mutating: false, elapsedMs: 50000 } : null } });
          return;
        }
        commands.push({ fileKey, method: message.method });
        plugin.secure.send({ id: message.id, result: { success: true, result: { selection: [] }, fileContext: { fileKey } } });
      },
    });
    t.after(() => plugin.ws.terminate());
    plugin.secure.send({ type: 'FILE_INFO', data: { fileKey, fileName: fileKey, pluginBuild } });
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
  const disconnected = await call(first, { includeFiles: false });
  assert.equal(disconnected.isError, undefined);
  assert.equal(disconnected.structuredContent.selectionInspected, false);
  assert.equal(disconnected.structuredContent.requiresFileKey, false);
  assert.match(disconnected.structuredContent.nextStep, /Figma Desktop Bridge/);
  assert.equal(commands.length, 0);
  await addPlugin('stdio-file');
  const result = await call(first);
  assert.equal(result.isError, undefined);
  assert.equal(JSON.parse(result.content[0].text).connectedFiles[0].fileKey, 'stdio-file');
  assert.equal((await call(second)).isError, undefined);
  const single = await call(first, { includeFiles: false });
  assert.equal(single.isError, undefined);
  assert.equal(single.structuredContent.fileContext.fileKey, 'stdio-file');
  await addPlugin('second-file', 'older-plugin-build');
  const before = commands.length;
  const targetStatus = await first.callTool({ name: 'get_status', arguments: { fileKey: 'stdio-file' } });
  assert.equal(targetStatus.structuredContent.diagnostics.ready, true);
  assert.equal(targetStatus.structuredContent.diagnostics.state, 'READY');
  assert.deepEqual(probes, ['stdio-file'], 'адресный статус опрашивает только целевой Plugin API');
  busyFile = 'stdio-file';
  const busyStatus = await first.callTool({ name: 'get_status', arguments: { fileKey: 'stdio-file' } });
  assert.equal(busyStatus.structuredContent.diagnostics.ready, false);
  assert.equal(busyStatus.structuredContent.diagnostics.state, 'PLUGIN_BUSY');
  assert.equal(busyStatus.structuredContent.execution[0].activeOperation.name, 'find_assets');
  busyFile = null;
  const allStatus = await first.callTool({ name: 'get_status', arguments: {} });
  assert.equal(allStatus.structuredContent.diagnostics.ready, false);
  assert.equal(allStatus.structuredContent.diagnostics.state, 'PLUGIN_OUTDATED');
  const inventory = await call(second);
  assert.equal(inventory.isError, undefined);
  const payload = JSON.parse(inventory.content[0].text);
  assert.equal(payload.connectedFiles.length, 2);
  assert.equal(payload.requiresFileKey, true);
  assert.equal(payload.selectionInspected, false);
  assert.equal(commands.length, before, 'список файлов не должен отправлять команды на холст');
  for (const args of [{}, { includeFiles: false }, { nodeId: '1:2', screenshot: true }, { nodeIds: ['1:2'] }]) {
    const ordinary = await second.callTool({ name: 'inspect_selection', arguments: args });
    assert.equal(ordinary.isError, undefined);
    assert.equal(ordinary.structuredContent.requiresFileKey, true);
    assert.equal(ordinary.structuredContent.selectionInspected, false);
    assert.equal(ordinary.structuredContent.connectedFiles.length, 2);
    assert.match(ordinary.structuredContent.nextStep, /fileKey/);
  }
  assert.equal(commands.length, before, 'неоднозначное чтение и PNG не отправляются ни в один файл');
  const invalid = await call(second, { includeFiles: false, fileKey: 'missing-file' });
  assert.equal(invalid.isError, true);
  assert.equal(commands.length, before, 'несуществующий fileKey не заменяется другим файлом');
  const mutation = await second.callTool({ name: 'patch_nodes', arguments: { patches: [{ id: '1:2', set: { content: 'test' } }] } });
  assert.equal(mutation.isError, true);
  assert.equal(commands.length, before, 'изменения по-прежнему требуют явный fileKey');
  const explicit = await call(second, { includeFiles: false, fileKey: 'stdio-file' });
  assert.equal(explicit.isError, undefined);
  assert.equal(explicit.structuredContent.fileContext.fileKey, 'stdio-file');
  assert.equal(commands.at(-1).fileKey, 'stdio-file');
  assert.equal((await call(first, { fileKey: 'stdio-file' })).isError, undefined);
  assert.equal((await call(second, { fileKey: 'stdio-file' })).isError, undefined);
  assert.equal((await call(second, { fileKey: 'second-file' })).isError, undefined);
  assert.equal(commands.at(-1).fileKey, 'second-file');
  await first.close();
  await new Promise(resolve => setTimeout(resolve, 50));
  assert.equal((await call(second, { fileKey: 'stdio-file' })).isError, undefined);
});
