import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, symlink, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { checkRenderResult } from '../src/render-result-check.mjs';

function fixture() {
  const renderArgs = { fileKey: 'target', spec: { key: 'screen', name: 'Экран', type: 'screen', width: 390, height: 844,
    layout: { direction: 'none' }, nodes: [{ key: 'title', name: 'Заголовок', type: 'text', x: 24, y: 40,
      width: 300, height: 32, textAutoResize: 'NONE', content: 'Перевод', fontFamily: 'Inter', fontStyle: 'Semi Bold', fontSize: 24, color: '#111111' }] } };
  const child = { id: '1:2', key: 'title', parentId: '1:1', name: 'Заголовок', type: 'TEXT', bounds: { x: 24, y: 40, width: 300, height: 32 }, content: 'Перевод', fontFamily: 'Inter', fontStyle: 'Semi Bold', fontSize: 24, textAutoResize: 'NONE' };
  const root = { id: '1:1', key: 'screen', name: 'Экран', type: 'FRAME', bounds: { x: 500, y: 0, width: 390, height: 844 }, children: [child] };
  const readback = { operationStatus: 'read', fileContext: { fileKey: 'target' }, result: { selection: [root], missing: [], coverage: { complete: true, unread: [] } } };
  return { renderArgs, readback, rootId: '1:1' };
}

test('reports exact checks separately from unverified appearance and never marks visual review passed', () => {
  const result = checkRenderResult(fixture());
  assert.equal(result.automated.status, 'matched');
  assert.deepEqual(result.automated.differences, []);
  assert.ok(result.unchecked.some(x => x.key === 'title' && x.field === 'color'));
  assert.equal(result.visual, 'not-tested');
  assert.equal(result.overallStatus, 'needs_review');
});

test('finds changed text, wrong font, misplaced node and changed parent', () => {
  const f = fixture(), n = f.readback.result.selection[0].children[0];
  Object.assign(n, { content: 'Ошибка', fontSize: 18, parentId: 'elsewhere' }); n.bounds.x = 30;
  const r = checkRenderResult(f);
  assert.equal(r.automated.status, 'mismatch');
  for (const field of ['content', 'fontSize', 'parentId', 'x']) assert.ok(r.automated.differences.some(x => x.field === field), field);
});

test('rejects incomplete, wrong-file and wrong-root evidence', () => {
  for (const mutate of [f => { f.readback.result.coverage.complete = false; },
    f => { f.readback.result.coverage.unread = [{ nodeId: '1:1' }]; },
    f => { f.readback.fileContext.fileKey = 'other'; },
    f => { f.rootId = 'other'; }, f => { f.readback.operationStatus = 'unknown'; }]) {
    const f = fixture(); mutate(f); assert.throws(() => checkRenderResult(f));
  }
});

test('does not silently reuse duplicate keys or omit extra keyed nodes', () => {
  const f = fixture(), root = f.readback.result.selection[0];
  root.children.push({ ...root.children[0], id: '1:3' });
  assert.throws(() => checkRenderResult(f), /duplicate/i);
  root.children[1].key = 'extra';
  assert.equal(checkRenderResult(f).automated.status, 'mismatch');
});

test('does not compare Auto Layout positions or auto-resized text height to authored coordinates', () => {
  const f = fixture(); f.renderArgs.spec.layout.direction = 'vertical';
  f.renderArgs.spec.nodes[0].textAutoResize = 'HEIGHT';
  const n = f.readback.result.selection[0].children[0]; n.textAutoResize = 'HEIGHT'; n.bounds.x = 0; n.bounds.y = 0; n.bounds.height = 64;
  const r = checkRenderResult(f);
  assert.equal(r.automated.status, 'matched');
  for (const field of ['x', 'y', 'height']) assert.ok(r.unchecked.some(x => x.key === 'title' && x.field === field));
});

test('missing actual numeric properties never compare equal through NaN', () => {
  const f = fixture(); delete f.readback.result.selection[0].children[0].bounds.width;
  assert.equal(checkRenderResult(f).automated.status, 'mismatch');
});

test('resolves public tokens and preserves compound IDs', () => {
  const f = fixture(); f.renderArgs.spec.tokens = { numbers: [{ name: 'title', value: 24 }] };
  f.renderArgs.spec.nodes[0].fontSize = '$numbers.title';
  f.readback.result.selection[0].children[0].id = 'I1:2;3:4';
  assert.equal(checkRenderResult(f).automated.status, 'matched');
});

test('allows internal SVG nodes but detects unkeyed extra layers outside SVG', () => {
  const f = fixture(), root = f.readback.result.selection[0];
  f.renderArgs.spec.nodes.push({ key: 'icon', name: 'Иконка', type: 'svg', width: 24, height: 24, svg: '<svg width="24" height="24"/>' });
  root.children.push({ id: '2:1', key: 'icon', name: 'Иконка', type: 'FRAME', parentId: root.id,
    bounds: { width: 24, height: 24 }, children: [{ id: '2:2', type: 'VECTOR', parentId: '2:1' }] });
  const r = checkRenderResult(f);
  assert.equal(r.automated.status, 'matched');
  assert.ok(r.unchecked.some(x => x.key === 'icon' && x.field === 'svg'));
  root.children.push({ id: '3:1', type: 'TEXT', parentId: root.id });
  assert.equal(checkRenderResult(f).automated.status, 'mismatch');
});

test('detects sibling order changes', () => {
  const f = fixture(), e = f.renderArgs.spec.nodes[0], root = f.readback.result.selection[0];
  e.order = 0; f.renderArgs.spec.nodes.push({ ...e, key: 'second', order: 1 });
  root.children.unshift({ ...root.children[0], key: 'second', id: '1:3' });
  const r = checkRenderResult(f);
  assert.ok(r.automated.differences.some(x => x.field === 'childOrder'));
});

test('leaves mixed typography for explicit range review instead of comparing missing aggregate fonts', () => {
  const f = fixture(), e = f.renderArgs.spec.nodes[0], n = f.readback.result.selection[0].children[0];
  e.textRuns = [{ start: 1, end: 3, fontStyle: 'Bold' }];
  delete n.fontFamily; delete n.fontStyle; n.mixedTextProperties = ['fontName'];
  const r = checkRenderResult(f);
  assert.equal(r.automated.status, 'matched');
  assert.ok(r.unchecked.some(x => x.key === 'title' && x.field === 'fontStyle'));
  assert.ok(r.unchecked.some(x => x.key === 'title' && x.field === 'textRuns'));
});

test('does not compare authored name to generated component variant name', () => {
  const f = fixture(), root = f.readback.result.selection[0];
  f.renderArgs.spec.nodes = [{ key: 'variant', name: 'Вариант', type: 'component', variant: [{ property: 'State', value: 'Default' }] }];
  root.children = [{ id: '1:2', key: 'variant', name: 'State=Default', type: 'COMPONENT', parentId: root.id, children: [] }];
  const r = checkRenderResult(f);
  assert.equal(r.automated.status, 'matched');
  assert.ok(r.unchecked.some(x => x.key === 'variant' && x.field === 'name'));
});

test('CLI never overwrites spec, read-back, symlinks or an existing report', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'figma-result-check-')); t.after(() => rm(dir, { recursive: true, force: true }));
  const f = fixture(), spec = join(dir, 'spec.json'), read = join(dir, 'read.json'), alias = join(dir, 'alias.json'), report = join(dir, 'report.json');
  const specText = JSON.stringify(f.renderArgs), readText = JSON.stringify(f.readback);
  await writeFile(spec, specText); await writeFile(read, readText); await symlink(spec, alias); await writeFile(report, 'existing');
  const cli = fileURLToPath(new URL('../scripts/check-render-result.mjs', import.meta.url));
  for (const output of [spec, read, alias, report]) {
    const r = spawnSync(process.execPath, [cli, '--spec', spec, '--read', read, '--root-id', f.rootId, '--output', output], { encoding: 'utf8' });
    assert.equal(r.status, 1);
    assert.equal(await readFile(spec, 'utf8'), specText); assert.equal(await readFile(read, 'utf8'), readText);
    assert.equal(await readFile(report, 'utf8'), 'existing');
  }
  const output = join(dir, 'new-report.json');
  const r = spawnSync(process.execPath, [cli, '--spec', spec, '--read', read, '--root-id', f.rootId, '--output', output], { encoding: 'utf8' });
  assert.equal(r.status, 0); assert.equal(JSON.parse(await readFile(output, 'utf8')).automated.status, 'matched');
});
