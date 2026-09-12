import test from 'node:test';
import assert from 'node:assert/strict';
import { createFigmaMock, executeGenerated } from './helpers/figma-mock.mjs';
import { buildInspectCode } from '../src/figma-code.mjs';

test('full inspection preserves the exact library identity and overrides of nested instances', async () => {
  const mock = createFigmaMock();
  const root = mock.make('FRAME');
  const instance = mock.make('INSTANCE', {}, root);
  instance.getMainComponentAsync = async () => ({ id: 'remote:42', key: 'published-key', name: 'Type=Card', remote: true });
  instance.overrides = [{ id: 'nested:9', overriddenFields: ['characters'] }];
  const result = await executeGenerated(mock.figma, buildInspectCode({ nodeId: root.id, detail: 'full', depth: 2, maxNodes: 10 }));
  const item = result.selection[0].children[0];
  assert.deepEqual(item.mainComponent, { status: 'resolved', id: 'remote:42', key: 'published-key', name: 'Type=Card', remote: true });
  assert.deepEqual(item.overrides, [{ id: 'nested:9', overriddenFields: ['characters'] }]);
});

test('an unavailable main component is explicit, not a fabricated key or a failed structure read', async () => {
  const mock = createFigmaMock();
  const instance = mock.make('INSTANCE');
  instance.getMainComponentAsync = async () => { throw new Error('Library unavailable'); };
  const result = await executeGenerated(mock.figma, buildInspectCode({ nodeId: instance.id, detail: 'full', depth: 0, maxNodes: 10 }));
  assert.equal(result.selection[0].mainComponent.status, 'unavailable');
  assert.equal(result.selection[0].mainComponent.key, undefined);
  assert.equal(result.selection[0].mainComponent.message, 'Library unavailable');
  assert.equal(result.coverage.complete, true);
});

test('compact inspection does not resolve library components', async () => {
  const mock = createFigmaMock();
  const instance = mock.make('INSTANCE');
  let reads = 0;
  instance.getMainComponentAsync = async () => { reads++; return null; };
  const result = await executeGenerated(mock.figma, buildInspectCode({ nodeId: instance.id, detail: 'compact', depth: 0, maxNodes: 10 }));
  assert.equal(reads, 0);
  assert.equal(result.selection[0].mainComponent, undefined);
});
