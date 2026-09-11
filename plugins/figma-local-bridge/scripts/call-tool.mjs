// A typed MCP client for local diagnostics and clients with a stale tool catalog.
// It connects to the same server as the plugin; no direct canvas execution.
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const { values, positionals } = parseArgs({ allowPositionals: true, options: {
  'plugin-root': { type: 'string' }, args: { type: 'string' }, output: { type: 'string' },
} });
const pluginRoot = resolve(values['plugin-root'] || resolve(dirname(fileURLToPath(import.meta.url)), '..'));
const config = JSON.parse(await readFile(resolve(pluginRoot, '.mcp.json'), 'utf8')).mcpServers['figma-local'];
const client = new Client({ name: 'figma-local-tool-client', version: '1.0.0' });
const transport = new StdioClientTransport({ command: config.command, args: config.args,
  cwd: resolve(pluginRoot, config.cwd || '.'), env: { ...process.env, ...config.env }, stderr: 'pipe' });
transport.stderr?.on('data', () => {});
try {
  await client.connect(transport, { timeout: 10000 });
  const { tools } = await client.listTools();
  const name = positionals[0];
  if (!name || name === 'list') {
    const selected = positionals[1] ? tools.filter(tool => tool.name === positionals[1]) : tools;
    if (!selected.length) throw new Error(`Инструмент ${positionals[1]} отсутствует в ${pluginRoot}`);
    console.log(JSON.stringify(selected, null, 2));
  } else {
    if (!tools.some(tool => tool.name === name)) throw new Error(`Инструмент ${name} отсутствует в ${pluginRoot}`);
    const args = values.args ? JSON.parse(await readFile(resolve(values.args), 'utf8')) : {};
    // Never retry calls: a timeout does not prove that a mutation was not applied.
    const response = await client.callTool({ name, arguments: args }, undefined, { timeout: 150000 });
    const payload = response.structuredContent || response.content.filter(item => item.type === 'text').map(item => item.text);
    if (values.output) {
      const output = resolve(values.output);
      await mkdir(output, { recursive: true });
      await writeFile(resolve(output, 'result.json'), JSON.stringify(payload, null, 2));
      let index = 0;
      for (const item of response.content) if (item.type === 'image' && item.mimeType === 'image/png') {
        const path = resolve(output, `preview-${index++}.png`);
        await writeFile(path, Buffer.from(item.data, 'base64'));
        console.log(JSON.stringify({ image: path }));
      }
      console.log(JSON.stringify({ result: resolve(output, 'result.json'), isError: !!response.isError,
        operationStatus: payload.operationStatus, rootId: payload.result?.rootId,
        verification: payload.result?.verification, error: payload.error, ready: payload.ready }));
    } else console.log(JSON.stringify(payload, null, 2));
    if (response.isError) process.exitCode = 1;
  }
} finally { await client.close(); }
