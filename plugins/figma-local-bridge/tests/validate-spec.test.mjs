import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const script = fileURLToPath(new URL('../scripts/validate-spec.mjs', import.meta.url));
const spec = { key: 'cover', name: 'Обложка', type: 'screen', width: 1440, height: 900,
  layout: { direction: 'none' }, nodes: [
    { key: 'content', name: 'Содержание', type: 'frame' },
    { key: 'title', parentKey: 'content', name: 'Название', type: 'text', content: 'Layouts & Grid', fontFamily: 'Factor IO', fontStyle: 'Bold' },
  ] };

for (const scenario of ['valid', 'nested', 'typo', 'cycle']) test(`offline validation: ${scenario}`, async t => {
  const directory = await mkdtemp(join(tmpdir(), 'figma-spec-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const input = structuredClone(spec);
  if (scenario === 'nested') input.nodes[0].nodes = [input.nodes.pop()];
  if (scenario === 'typo') input['fill\\s'] = [];
  if (scenario === 'cycle') input.nodes[0].parentKey = 'content';
  const path = join(directory, 'input.json');
  await writeFile(path, JSON.stringify(input));
  const result = spawnSync(process.execPath, [script, path], { encoding: 'utf8', timeout: 5000 });
  assert.equal(result.status, scenario === 'valid' ? 0 : 1, result.stderr);
  const report = JSON.parse(result.stdout);
  assert.equal(report.valid, scenario === 'valid');
  assert.equal(report.fonts, 'not_checked');
  if (scenario === 'nested') assert.match(report.nextStep, /parentKey/);
  if (scenario !== 'valid') assert.ok(report.errors.length);
});
