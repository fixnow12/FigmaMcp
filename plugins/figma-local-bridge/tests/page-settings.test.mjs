import test from 'node:test';
import assert from 'node:assert/strict';
import { createFigmaMock, executeGenerated } from './helpers/figma-mock.mjs';
import { buildGetPageSettingsCode, buildSetPageSettingsCode, setPageSettingsSchema } from '../src/page-settings.mjs';

function fixture() {
  const m = createFigmaMock();
  const collection = { id: 'size-id', key: 'size-key', name: 'IO Size', modes: [{ modeId: 'mode-default', name: 'default' }] };
  m.figma.variables.importVariableByKeyAsync = async () => ({ key: 'anchor', variableCollectionId: collection.id });
  m.figma.variables.getVariableCollectionByIdAsync = async id => id === collection.id ? collection : null;
  const pages = [m.figma.currentPage, m.make('PAGE', { name: 'Cover' }, null)];
  m.figma.root.children.push(pages[1]);
  for (const page of pages) {
    page.backgrounds = [{ type: 'SOLID', color: { r: 1, g: 1, b: 1 }, opacity: 1 }];
    page.explicitVariableModes = {};
    page.setExplicitVariableModeForCollection = (c, mode) => { page.explicitVariableModes = { ...page.explicitVariableModes, [c.id]: mode }; };
    page.clearExplicitVariableModeForCollection = c => { const modes = { ...page.explicitVariableModes }; delete modes[c.id]; page.explicitVariableModes = modes; };
  }
  const input = { fileKey: 'working', pageIds: pages.map(p => p.id), background: { color: '#1E1E1E', opacity: 1 }, variableModes: [{ collectionKey: 'size-key', anchorVariableKey: 'anchor', modeName: 'default' }] };
  return { ...m, pages, collection, input };
}

test('sets and independently reads canvas backgrounds and explicit modes on every requested page', async () => {
  const m = fixture(); const before = JSON.stringify(m.collection);
  const result = await executeGenerated(m.figma, buildSetPageSettingsCode(setPageSettingsSchema.parse(m.input)));
  const read = await executeGenerated(m.figma, buildGetPageSettingsCode({ fileKey: 'working' }));
  assert.deepEqual(read.pages, result.pages);
  assert.equal(read.pages.length, 2);
  for (const p of read.pages) {
    assert.equal(p.backgrounds[0].opacity, 1);
    assert.ok(Math.abs(p.backgrounds[0].color.r - 30 / 255) < 1e-7);
    assert.equal(p.explicitVariableModes[0].collectionKey, 'size-key');
    assert.equal(p.explicitVariableModes[0].modeName, 'default');
  }
  assert.equal(JSON.stringify(m.collection), before);
});

test('missing mode and foreign node reject the whole batch before page writes', async () => {
  for (const kind of ['mode', 'node', 'collection']) {
    const m = fixture(); const before = m.pages.map(p => JSON.stringify([p.backgrounds, p.explicitVariableModes]));
    if (kind === 'mode') m.input.variableModes[0].modeName = 'missing';
    if (kind === 'node') m.input.pageIds[1] = m.make('FRAME').id;
    if (kind === 'collection') m.input.variableModes[0].collectionKey = 'wrong';
    await assert.rejects(executeGenerated(m.figma, buildSetPageSettingsCode(m.input)), e => e.operationStatus === 'not_applied');
    assert.deepEqual(m.pages.map(p => JSON.stringify([p.backgrounds, p.explicitVariableModes])), before);
  }
});

test('rolls back page writes when a later mode setter fails', async () => {
  const m = fixture(); const before = m.pages.map(p => JSON.stringify([p.backgrounds, p.explicitVariableModes]));
  m.pages[1].setExplicitVariableModeForCollection = () => { throw new Error('setter failed'); };
  await assert.rejects(executeGenerated(m.figma, buildSetPageSettingsCode(m.input)), e => e.operationStatus === 'rolled_back');
  assert.deepEqual(m.pages.map(p => JSON.stringify([p.backgrounds, p.explicitVariableModes])), before);
});

test('schema rejects duplicate pages, invalid colors, unknown fields and implicit file selection', () => {
  const { input } = fixture();
  for (const value of [{ ...input, fileKey: undefined }, { ...input, pageIds: ['p', 'p'] }, { ...input, background: { color: 'red', opacity: 2 } }, { ...input, allowComponentChanges: true }]) {
    assert.equal(setPageSettingsSchema.safeParse(value).success, false);
  }
});
