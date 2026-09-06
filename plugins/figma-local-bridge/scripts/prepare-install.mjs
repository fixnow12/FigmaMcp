import { readFile, open, unlink } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import channel from '../src/secure-channel.cjs';
import { pluginRevision } from '../src/runtime-info.mjs';
import { installationDirectory, privateDirectory, privateWrite, loadInstallation, identityFor } from '../src/installation.mjs';

const pluginRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);

export async function prepareInstallation(directory = installationDirectory()) {
  await privateDirectory(directory);
  const lockPath = join(directory, 'install.lock');
  const lock = await open(lockPath, 'wx', 0o600).catch(error => { throw new Error(error.code === 'EEXIST' ? 'Установка уже выполняется. Если она была прервана, удалите install.lock в каталоге установки.' : error.message); });
  try {
    const identityPath = join(directory, 'identity.json');
    try { await readFile(identityPath); } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      await privateWrite(identityPath, JSON.stringify({ version: 2, server: channel.newSeed(), plugin: channel.newSeed(), mcp: channel.newSeed() }));
    }
    const data = await loadInstallation(directory);
    const target = join(directory, 'figma-plugin');
    await privateDirectory(target);
    const source = join(pluginRoot, 'src', 'figma-plugin');
    let ui = await readFile(join(source, 'ui.html'), 'utf8');
    const cryptoSource = await readFile(require.resolve('tweetnacl/nacl-fast.min.js'), 'utf8');
    const channelSource = await readFile(join(pluginRoot, 'src/secure-channel.cjs'), 'utf8');
    const bootstrap = `window.__FIGMA_LOCAL_IDENTITY__ = ${JSON.stringify(identityFor(data, 'plugin'))};\nwindow.__FIGMA_LOCAL_BUILD__ = ${JSON.stringify(pluginRevision())};`;
    ui = ui.replace('<!-- LOCAL_SECURE_BOOTSTRAP -->', `<script>${cryptoSource}\n${channelSource}\n${bootstrap}</script>`);
    if (!ui.includes(bootstrap)) throw new Error('В UI отсутствует точка установки ключей');
    await privateWrite(join(target, 'ui.html'), ui);
    for (const name of ['code.js', 'icon.png', 'LICENSE.upstream']) await privateWrite(join(target, name), await readFile(join(source, name)));
    await privateWrite(join(target, 'LICENSE.tweetnacl'), await readFile(require.resolve('tweetnacl/LICENSE'), 'utf8'));
    const manifest = JSON.parse(await readFile(join(source, 'manifest.template.json'), 'utf8'));
    manifest.name = 'Figma Desktop Bridge — Auto';
    // Preserve the namespace of existing node.getPluginData/setPluginData keys.
    // Installation identity is cryptographic and must not change the plugin ID.
    await privateWrite(join(target, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
    return join(target, 'manifest.json');
  } finally { await lock.close(); await unlink(lockPath); }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  console.log(await prepareInstallation());
}
