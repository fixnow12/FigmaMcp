import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, copyFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

test('обновление файлов на диске не маскирует ревизию уже работающего процесса', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'figma-revision-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await mkdir(join(directory, 'figma-plugin'));
  await copyFile(new URL('../src/runtime-info.mjs', import.meta.url), join(directory, 'runtime-info.mjs'));
  for (const file of ['schemas.mjs', 'secure-channel.cjs', 'figma-plugin/code.js', 'figma-plugin/ui.html']) {
    await writeFile(join(directory, file), 'old');
  }
  const runtime = await import(pathToFileURL(join(directory, 'runtime-info.mjs')));
  const status = { runtime: runtime.runtimeInfo, files: [{ fileName: 'Макет', pluginBuild: runtime.pluginRevision() }] };
  assert.deepEqual(runtime.runtimeDiagnostics(status).warnings, []);
  await writeFile(join(directory, 'schemas.mjs'), 'new schema');
  await writeFile(join(directory, 'figma-plugin/code.js'), 'new plugin');
  const diagnosis = runtime.runtimeDiagnostics(status);
  assert.notEqual(diagnosis.mcp.revision, diagnosis.sourceRevision);
  assert.ok(diagnosis.warnings.some(message => message.includes('каталога инструментов')));
  assert.ok(diagnosis.warnings.some(message => message.includes('broker')));
  assert.ok(diagnosis.warnings.some(message => message.includes('Макет')));
});
