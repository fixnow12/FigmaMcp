import assert from 'node:assert/strict';
import { readFile, readdir, stat } from 'node:fs/promises';
import { dirname, extname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const jsonFiles = [
  'opencode.json',
  '.agents/plugins/marketplace.json',
  'plugins/figma-local-bridge/.codex-plugin/plugin.json',
  'plugins/figma-local-bridge/.mcp.json',
  'plugins/figma-local-bridge/package.json',
  'plugins/figma-local-bridge/figma-plugin/manifest.json'
];

for (const relativePath of jsonFiles) {
  JSON.parse(await readFile(resolve(root, relativePath), 'utf8'));
}

const marketplace = JSON.parse(await readFile(resolve(root, '.agents/plugins/marketplace.json'), 'utf8'));
assert.equal(marketplace.name, 'figma-mcp');
assert.equal(marketplace.plugins[0].name, 'figma-local-bridge');
await stat(resolve(root, marketplace.plugins[0].source.path));

const plugin = JSON.parse(await readFile(resolve(root, 'plugins/figma-local-bridge/.codex-plugin/plugin.json'), 'utf8'));
assert.equal(plugin.name, 'figma-local-bridge');
assert.equal(plugin.mcpServers, './.mcp.json');

const packageJson = JSON.parse(await readFile(resolve(root, 'plugins/figma-local-bridge/package.json'), 'utf8'));
assert.equal(plugin.version, packageJson.version);

const figmaManifest = JSON.parse(await readFile(resolve(root, 'plugins/figma-local-bridge/figma-plugin/manifest.json'), 'utf8'));
for (const domain of [
  ...(figmaManifest.networkAccess?.allowedDomains || []),
  ...(figmaManifest.networkAccess?.devAllowedDomains || []),
]) {
  assert.match(domain, /^(?:http|ws):\/\/localhost(?::\d+)?$/, `Внешний домен запрещён: ${domain}`);
}

const mcp = JSON.parse(await readFile(resolve(root, 'plugins/figma-local-bridge/.mcp.json'), 'utf8'));
assert.deepEqual(Object.keys(mcp.mcpServers), ['figma-local']);

const skip = new Set(['.git', 'node_modules', 'migration-backup', 'dist']);
const binaryExtensions = new Set(['.png', '.jpg', '.jpeg', '.gif', '.ico', '.zip']);
const findings = [];
const secretPatterns = [
  /github_pat_[A-Za-z0-9_]{20,}/,
  /ghp_[A-Za-z0-9]{30,}/,
  /sk-[A-Za-z0-9_-]{20,}/,
  /figd_[A-Za-z0-9_-]{20,}/,
  /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/
];

async function scan(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (skip.has(entry.name)) continue;
    const path = resolve(directory, entry.name);
    if (entry.isDirectory()) {
      await scan(path);
      continue;
    }
    if (binaryExtensions.has(extname(entry.name).toLowerCase())) continue;
    const content = await readFile(path, 'utf8');
    if (content.includes('C:\\Codex\\Figma')) findings.push(`${path}: абсолютный путь рабочей машины`);
    if (content.includes('[TO' + 'DO')) findings.push(`${path}: незаполненный TODO`);
    for (const pattern of secretPatterns) {
      if (pattern.test(content)) findings.push(`${path}: возможный секрет (${pattern.source})`);
    }
  }
}

await scan(root);
assert.deepEqual(findings, [], `Проверка репозитория не пройдена:\n${findings.join('\n')}`);
console.log('Структура, переносимость и базовая проверка секретов: OK');
