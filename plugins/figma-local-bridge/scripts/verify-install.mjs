import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const pluginRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const serverPath = resolve(pluginRoot, 'src', 'server.mjs');
const expectedTools = ['get_status', 'inspect_selection', 'patch_nodes', 'render_screen', 'use_component'];

const transport = new StdioClientTransport({
  command: process.execPath,
  args: [serverPath],
  env: { ...process.env, FIGMA_WS_HOST: '127.0.0.1' },
  stderr: 'pipe'
});
const client = new Client({ name: 'figma-local-verifier', version: '1.0.0' });

try {
  await client.connect(transport);
  const response = await client.listTools();
  const actualTools = response.tools.map((tool) => tool.name).sort();
  assert.deepEqual(actualTools, [...expectedTools].sort());
  for (const tool of response.tools) {
    assert.equal(typeof tool.description, 'string');
    assert.ok(tool.description.length > 30, `${tool.name}: слишком короткое описание`);
    assert.equal(tool.inputSchema.type, 'object');
  }
  console.log(`MCP-контракт проверен: ${actualTools.join(', ')}`);
} finally {
  await client.close();
}
