import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createFigmaMock, executeGenerated } from './helpers/figma-mock.mjs';
import { buildInspectCode } from '../src/figma-code.mjs';

test('bounded inspect exposes exact missing sibling topology including hidden nodes', async () => {
  const mock = createFigmaMock();
  const root = mock.make('FRAME');
  const first = mock.make('FRAME', {}, root);
  const second = mock.make('FRAME', { visible: false }, root);
  const result = await executeGenerated(mock.figma, buildInspectCode({ nodeId: root.id, detail: 'full', depth: 5, maxNodes: 2 }));
  assert.deepEqual(result.selection[0].childIds, [first.id, second.id]);
  assert.deepEqual(result.coverage.unread[0], { nodeId: second.id, reason: 'maxNodes', parentId: root.id, childIndex: 1 });
  const followup = await executeGenerated(mock.figma, buildInspectCode({ nodeId: second.id, detail: 'full', depth: 5, maxNodes: 20 }));
  assert.equal(followup.selection[0].parentId, root.id);
  assert.equal(followup.selection[0].childIndex, 1);
  assert.deepEqual(followup.selection[0].parentChildIds, [first.id, second.id]);
  assert.equal(followup.selection[0].visible, false);
});

test('depth truncated root retains ordered child identity', async () => {
  const mock = createFigmaMock();
  const root = mock.make('FRAME');
  const child = mock.make('FRAME', {}, root);
  const result = await executeGenerated(mock.figma, buildInspectCode({ nodeId: root.id, detail: 'full', depth: 0, maxNodes: 10 }));
  assert.deepEqual(result.selection[0].childIds, [child.id]);
});

test('render_screen never advertises safe automatic replay', async () => {
  const source = await readFile(new URL('../src/server.mjs', import.meta.url), 'utf8');
  assert.match(source.slice(source.indexOf('"render_screen",'), source.indexOf('"render_screen",') + 1800), /idempotentHint: false/);
});

test('wide truncated trees keep topology payload linear in siblings', async () => {
  const mock = createFigmaMock();
  const root = mock.make('FRAME');
  for (let i=0;i<500;i++) mock.make('FRAME', {}, root);
  const result = await executeGenerated(mock.figma, buildInspectCode({ nodeId: root.id, detail: 'full', depth: 5, maxNodes: 1 }));
  assert.equal(result.coverage.unread.length, 500);
  assert.ok(JSON.stringify(result).length < 65000);
});
