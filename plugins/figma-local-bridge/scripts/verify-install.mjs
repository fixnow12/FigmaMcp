import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { readFile } from 'node:fs/promises';
import { parseArgs } from 'node:util';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const sourceRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

export async function verifyInstallation({ pluginRoot = sourceRoot, live = false, screenshot = false, env = process.env } = {}) {
pluginRoot = resolve(pluginRoot);
const manifest = JSON.parse(await readFile(resolve(pluginRoot, '.mcp.json'), 'utf8'));
const config = manifest.mcpServers['figma-local'];
// Codex otherwise inherits the task directory, not the installed plugin directory.
assert.equal(config.cwd, '.', 'MCP должен запускаться из корня установленного плагина');
const serverCwd = resolve(pluginRoot, config.cwd);
const expectedTools = ['bind_variables', 'clone_nodes', 'export_assets', 'find_assets', 'get_status', 'inspect_selection', 'move_nodes', 'patch_nodes', 'render_screen', 'use_component'];

const transport = new StdioClientTransport({
  // Do not substitute process.execPath: that hides a broken command/PATH.
  command: config.command,
  args: config.args,
  cwd: serverCwd,
  env: { ...env, ...config.env },
  stderr: 'pipe'
});
const client = new Client({ name: 'figma-local-verifier', version: '1.0.0' });
// Drain diagnostics without exposing pairing references or private data.
transport.stderr?.on('data', () => {});
let stage = 'запуск MCP из .mcp.json';

try {
  await client.connect(transport, { timeout: 10000 });
  stage = 'список инструментов MCP';
  const response = await client.listTools();
  const actualTools = response.tools.map((tool) => tool.name).sort();
  assert.deepEqual(actualTools, [...expectedTools].sort());
  for (const tool of response.tools) {
    assert.equal(typeof tool.description, 'string');
    assert.ok(tool.description.length > 30, `${tool.name}: слишком короткое описание`);
    assert.equal(tool.inputSchema.type, 'object');
    function checkArrays(schema, path = tool.name) {
      if (!schema || typeof schema !== 'object') return;
      assert.ok(!Array.isArray(schema.items), `${path}: tuple items несовместимы с MCP-клиентом`);
      for (const [key, value] of Object.entries(schema)) checkArrays(value, `${path}.${key}`);
    }
    checkArrays(tool.inputSchema);
  }
  const report = { pluginRoot, command: config.command, tools: actualTools, liveChecked: false };
  if (!live && !screenshot) return report;
  async function call(name, args = {}) {
    const response = await client.callTool({ name, arguments: args }, undefined, { timeout: 20000 });
    const payload = response.structuredContent || JSON.parse(response.content.find(item => item.type === 'text').text);
    if (response.isError) throw new Error(payload.error || `${name}: MCP error`);
    return { payload, content: response.content };
  }
  stage = 'подключение Bridge к Figma';
  const { payload: status } = await call('get_status');
  assert.ok(status.connected && status.files?.length, 'MCP работает, но файл Figma не подключён. Откройте Bridge — Auto в целевом файле.');
  report.files = [];
  for (const file of status.files) {
    stage = `чтение Figma (${file.fileName || file.fileKey})`;
    const { payload } = await call('inspect_selection', { fileKey: file.fileKey, detail: 'full', depth: 1, maxNodes: 30 });
    const selection = payload.result?.selection;
    assert.ok(Array.isArray(selection), 'MCP не вернул выделение');
    const entry = { fileKey: file.fileKey, fileName: file.fileName, selection: selection.map(node => ({ id: node.id, name: node.name, type: node.type })) };
    if (screenshot && selection.length) {
      stage = `PNG Figma (${file.fileName || file.fileKey})`;
      const result = await call('inspect_selection', { fileKey: file.fileKey, nodeId: selection[0].id, depth: 0, maxNodes: 1, screenshot: true, screenshotScale: 0.5 });
      assert.equal(result.payload.screenshot?.status, 'captured', result.payload.screenshot?.error || 'PNG не получен');
      const png = result.content.find(item => item.type === 'image' && item.mimeType === 'image/png');
      assert.ok(png?.data, 'В ответе нет изображения PNG');
      entry.screenshotBytes = Buffer.from(png.data, 'base64').length;
    }
    report.files.push(entry);
  }
  if (screenshot) assert.ok(report.files.some(file => file.screenshotBytes > 0), 'Для проверки PNG выделите узел хотя бы в одном подключённом файле');
  report.liveChecked = true;
  return report;
} catch (error) {
  throw new Error(`Проверка не пройдена — ${stage}: ${error.message}`, { cause: error });
} finally {
  await client.close();
}
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const { values } = parseArgs({ options: { 'plugin-root': { type: 'string' }, live: { type: 'boolean' }, screenshot: { type: 'boolean' } } });
    const report = await verifyInstallation({ pluginRoot: values['plugin-root'], live: values.live, screenshot: values.screenshot });
    console.log(JSON.stringify(report, null, 2));
    if (!report.liveChecked) console.log('MCP-контракт проверен. Соединение с Figma не проверялось; для этого запустите verify -- --live --screenshot.');
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
