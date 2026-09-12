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
  if (scenario === 'valid') {
    assert.deepEqual(report.geometryWarnings, []);
    assert.equal(report.geometryWarningCount, 0);
    assert.equal(report.geometryWarningsTruncated, false);
  }
  if (scenario === 'nested') assert.match(report.nextStep, /parentKey/);
  if (scenario !== 'valid') assert.ok(report.errors.length);
});

test('offline validation warns about overlapping free-layout text, including wrapped text', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'figma-spec-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const input = {
    key: 'overlap', name: 'Перекрытие', type: 'screen', width: 400, height: 300,
    layout: { direction: 'none' }, nodes: [
      { key: 'scheme', name: 'Схема', type: 'frame', width: 300, height: 200, layout: { direction: 'none' } },
      { key: 'first', parentKey: 'scheme', name: 'Первая подпись', type: 'text', content: 'Страница получает внешний ритм',
        x: 10, y: 10, width: 100, fontSize: 16, lineHeight: 24 },
      { key: 'second', parentKey: 'scheme', name: 'Вторая подпись', type: 'text', content: 'Следующая подпись',
        x: 10, y: 40, width: 120, fontSize: 16, lineHeight: 24 },
    ],
  };
  const path = join(directory, 'input.json');
  await writeFile(path, JSON.stringify(input));
  const result = spawnSync(process.execPath, [script, path], { encoding: 'utf8', timeout: 5000 });
  assert.equal(result.status, 0, result.stderr);
  const report = JSON.parse(result.stdout);
  assert.deepEqual(report.geometryWarnings, [{
    code: 'TEXT_OVERLAP', parentKey: 'scheme', keys: ['first', 'second'],
    message: 'Текстовые узлы first и second могут перекрываться в свободной раскладке scheme.',
  }]);
  assert.equal(report.geometryWarningCount, 1);
  assert.equal(report.geometryWarningsTruncated, false);
  assert.match(report.nextStep, /геометр/i);
});

test('offline validation treats omitted layout as the renderer default auto layout', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'figma-spec-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const input = {
    key: 'auto', name: 'Автораскладка', type: 'screen', width: 400, height: 300,
    nodes: [
      { key: 'stack', name: 'Стек', type: 'frame', width: 300, height: 200 },
      { key: 'first', parentKey: 'stack', name: 'Первая подпись', type: 'text', content: 'Первая', width: 100, fontSize: 16 },
      { key: 'second', parentKey: 'stack', name: 'Вторая подпись', type: 'text', content: 'Вторая', width: 100, fontSize: 16 },
    ],
  };
  const path = join(directory, 'input.json');
  await writeFile(path, JSON.stringify(input));
  const result = spawnSync(process.execPath, [script, path], { encoding: 'utf8', timeout: 5000 });
  assert.equal(result.status, 0, result.stderr);
  const report = JSON.parse(result.stdout);
  assert.deepEqual(report.geometryWarnings, []);
});

test('offline validation warns when wrapped text may be clipped by its container', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'figma-spec-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const input = {
    key: 'clip', name: 'Обрезание', type: 'screen', width: 600, height: 400,
    nodes: [
      { key: 'scheme', name: 'Схема', type: 'frame', width: 520, height: 380, clipContent: true, layout: { direction: 'none' } },
      { key: 'note', parentKey: 'scheme', name: 'Примечание', type: 'text',
        content: 'Пустые колонки допустимы — заполнять все 12 не обязательно',
        x: 0, y: 350, width: 520, fontSize: 15, lineHeight: { unit: 'PIXELS', value: 24 } },
    ],
  };
  const path = join(directory, 'input.json');
  await writeFile(path, JSON.stringify(input));
  const result = spawnSync(process.execPath, [script, path], { encoding: 'utf8', timeout: 5000 });
  assert.equal(result.status, 0, result.stderr);
  const report = JSON.parse(result.stdout);
  assert.deepEqual(report.geometryWarnings, [{
    code: 'TEXT_CLIPPED', parentKey: 'scheme', keys: ['note'], overflow: ['bottom'],
    message: 'Текстовый узел note может обрезаться контейнером scheme: bottom.',
  }]);
});

test('offline validation ignores hidden text subtrees', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'figma-spec-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const input = {
    key: 'hidden', name: 'Скрытое', type: 'screen', width: 400, height: 300,
    nodes: [
      { key: 'scheme', name: 'Скрытая схема', type: 'frame', width: 200, height: 100,
        visible: false, layout: { direction: 'none' } },
      { key: 'first', parentKey: 'scheme', name: 'Первая', type: 'text', content: 'Первая', x: 0, y: 0, width: 100 },
      { key: 'second', parentKey: 'scheme', name: 'Вторая', type: 'text', content: 'Вторая', x: 0, y: 0, width: 100 },
    ],
  };
  const path = join(directory, 'input.json');
  await writeFile(path, JSON.stringify(input));
  const result = spawnSync(process.execPath, [script, path], { encoding: 'utf8', timeout: 5000 });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout).geometryWarnings, []);
});

test('offline validation checks text against clipping ancestors in a free-layout chain', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'figma-spec-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const input = {
    key: 'nested', name: 'Вложенное обрезание', type: 'screen', width: 400, height: 300,
    nodes: [
      { key: 'outer', name: 'Внешний контейнер', type: 'frame', width: 100, height: 100,
        clipContent: true, layout: { direction: 'none' } },
      { key: 'inner', parentKey: 'outer', name: 'Внутренний контейнер', type: 'frame',
        x: 80, y: 0, width: 50, height: 50, layout: { direction: 'none' } },
      { key: 'note', parentKey: 'inner', name: 'Подпись', type: 'text', content: 'Текст',
        x: 0, y: 0, width: 40, height: 20 },
    ],
  };
  const path = join(directory, 'input.json');
  await writeFile(path, JSON.stringify(input));
  const result = spawnSync(process.execPath, [script, path], { encoding: 'utf8', timeout: 5000 });
  assert.equal(result.status, 0, result.stderr);
  const report = JSON.parse(result.stdout);
  assert.deepEqual(report.geometryWarnings, [{
    code: 'TEXT_CLIPPED', parentKey: 'outer', keys: ['note'], overflow: ['right'],
    message: 'Текстовый узел note может обрезаться контейнером outer: right.',
  }]);
});

test('offline validation caps reported overlaps without losing the total count', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'figma-spec-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const nodes = [
    { key: 'scheme', name: 'Схема', type: 'frame', width: 300, height: 200, layout: { direction: 'none' } },
    ...Array.from({ length: 30 }, (_, index) => ({
      key: `text-${index}`, parentKey: 'scheme', name: `Текст ${index}`, type: 'text',
      content: 'Текст', x: 0, y: 0, width: 100, height: 20,
    })),
  ];
  const path = join(directory, 'input.json');
  await writeFile(path, JSON.stringify({ key: 'many', name: 'Много', type: 'screen', width: 400, height: 300, nodes }));
  const result = spawnSync(process.execPath, [script, path], { encoding: 'utf8', timeout: 5000 });
  assert.equal(result.status, 0, result.stderr);
  const report = JSON.parse(result.stdout);
  assert.equal(report.geometryWarnings.length, 200);
  assert.equal(report.geometryWarningCount, 435);
  assert.equal(report.geometryWarningsTruncated, true);
});

test('offline validation checks absolute text inside a clipped auto-layout container', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'figma-spec-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const input = {
    key: 'absolute', name: 'Абсолютный текст', type: 'screen', width: 400, height: 300,
    nodes: [
      { key: 'stack', name: 'Стек', type: 'frame', width: 100, height: 100,
        clipContent: true, layout: { direction: 'vertical' } },
      { key: 'regular', parentKey: 'stack', name: 'Обычный текст', type: 'text', content: 'Обычный', width: 80, height: 20 },
      { key: 'absolute-note', parentKey: 'stack', name: 'Абсолютный текст', type: 'text', content: 'Абсолютный',
        layoutPositioning: 'ABSOLUTE', x: 90, y: 0, width: 30, height: 20 },
    ],
  };
  const path = join(directory, 'input.json');
  await writeFile(path, JSON.stringify(input));
  const result = spawnSync(process.execPath, [script, path], { encoding: 'utf8', timeout: 5000 });
  assert.equal(result.status, 0, result.stderr);
  const report = JSON.parse(result.stdout);
  assert.deepEqual(report.geometryWarnings, [{
    code: 'TEXT_CLIPPED', parentKey: 'stack', keys: ['absolute-note'], overflow: ['right'],
    message: 'Текстовый узел absolute-note может обрезаться контейнером stack: right.',
  }]);
});
