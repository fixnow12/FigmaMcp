import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { verifyInstallation } from './verify-install.mjs';

const sourceRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

export async function verifyCodexInstallation({ codexHome = process.env.CODEX_HOME || join(homedir(), '.codex'), live = false, screenshot = false } = {}) {
  const manifest = JSON.parse(await readFile(join(sourceRoot, '.codex-plugin/plugin.json'), 'utf8'));
  assert.match(manifest.name, /^[A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+)*$/);
  assert.match(manifest.version, /^[A-Za-z0-9.+_-]+$/);
  const installedRoot = join(codexHome, 'plugins/cache/figma-mcp', manifest.name, manifest.version);
  // An old installed entry is not proof that this source version was copied.
  async function compare(relativePath) {
    const [source, installed] = await Promise.all([
      readFile(join(sourceRoot, relativePath)), readFile(join(installedRoot, relativePath)),
    ]);
    assert.ok(source.equals(installed), `Кэш Codex устарел: ${relativePath}. Обновите cachebuster и переустановите плагин.`);
  }
  async function compareTree(relativePath) {
    for (const entry of await readdir(join(sourceRoot, relativePath), { withFileTypes: true })) {
      const child = join(relativePath, entry.name);
      if (entry.isDirectory()) await compareTree(child);
      else if (entry.isFile()) await compare(child);
    }
  }
  for (const path of ['.mcp.json', '.codex-plugin/plugin.json', 'package.json', 'package-lock.json']) await compare(path);
  for (const path of ['src', 'skills', 'scripts']) await compareTree(path);
  return { ...(await verifyInstallation({ pluginRoot: installedRoot, live, screenshot })), cacheMatchesSource: true };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const { values } = parseArgs({ options: { 'codex-home': { type: 'string' }, live: { type: 'boolean' }, screenshot: { type: 'boolean' } } });
    console.log(JSON.stringify(await verifyCodexInstallation({ codexHome: values['codex-home'], live: values.live, screenshot: values.screenshot }), null, 2));
    if (!values.live && !values.screenshot) console.log('Установленная копия MCP проверена. Для проверки Figma добавьте --live --screenshot.');
  } catch (error) {
    console.error(`Установленная копия Codex не прошла проверку: ${error.message}`);
    process.exitCode = 1;
  }
}
