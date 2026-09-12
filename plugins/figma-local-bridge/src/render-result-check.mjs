// Offline comparison of a saved render spec and an explicit full read-back.
// No canvas access, writes, retries or inference about screenshot quality.
import assert from 'node:assert/strict';
import { isDeepStrictEqual } from 'node:util';
import { normalizeScreenSpec, parseRenderScreenInput } from './schemas.mjs';

export function checkRenderResult({ renderArgs, readback, rootId, tolerance = 0.5 }) {
  assert.ok(typeof rootId === 'string' && rootId, 'Expected rootId is required');
  assert.ok(Number.isFinite(tolerance) && tolerance >= 0 && tolerance <= 1, 'Tolerance must be between 0 and 1 px');
  const parsed = parseRenderScreenInput(renderArgs);
  assert.ok(parsed.fileKey, 'Explicit spec fileKey is required');
  assert.ok(!readback?.isError, 'Read-back returned an error');
  const payload = readback.structuredContent ?? readback;
  assert.equal(payload.operationStatus, 'read', 'Expected a successful read operation');
  assert.equal(payload.fileContext?.fileKey, parsed.fileKey, 'Read-back fileKey differs from spec');
  const result = payload.result;
  assert.equal(result?.coverage?.complete, true, 'Incomplete read-back');
  assert.deepEqual(result.coverage.unread, [], 'Unread branches remain');
  assert.ok(!result.truncated && !result.missing?.length, 'Missing or truncated nodes');
  assert.equal(result.selection?.length, 1, 'Read exactly one target root');
  const actualRoot = result.selection[0];
  assert.equal(actualRoot.id, rootId, 'Read-back rootId differs from target');

  const byKey = new Map(), byId = new Map(), treeParents = new Map();
  function index(node, parent) {
    assert.ok(node?.id && !byId.has(node.id), 'Missing or duplicate node ID');
    assert.ok(!(node.childCount > 0 && !node.children?.length), 'Missing children in read-back');
    byId.set(node.id, node); treeParents.set(node.id, parent?.id);
    if (node.key) {
      assert.ok(!byKey.has(node.key), `Duplicate key in read-back: ${node.key}`);
      byKey.set(node.key, node);
    }
    for (const child of node.children ?? []) index(child, node);
  }
  index(actualRoot);
  const spec = normalizeScreenSpec(parsed.spec);
  assert.equal(actualRoot.key, spec.key, 'Root key differs from spec');
  const checked = [], differences = [], unchecked = [];
  const expectedKeys = new Set(), svgKeys = new Set();
  function compare(key, field, expected, actual, numeric = false) {
    checked.push({ key, field });
    const equal = numeric ? Number.isFinite(actual) && Math.abs(actual - expected) <= tolerance
      : isDeepStrictEqual(actual, expected);
    if (!equal) differences.push({ key, field, expected, actual: actual ?? null });
  }
  const types = { screen: 'FRAME', frame: 'FRAME', component: 'COMPONENT', componentSet: 'COMPONENT_SET',
    text: 'TEXT', rectangle: 'RECTANGLE', ellipse: 'ELLIPSE', line: 'LINE', vector: 'VECTOR' };
  function visit(expected, parent) {
    expectedKeys.add(expected.key);
    if (expected.type === 'svg') svgKeys.add(expected.key);
    const actual = byKey.get(expected.key);
    if (!actual) {
      differences.push({ key: expected.key, field: 'node', expected: 'present', actual: 'missing' });
      for (const child of expected.children ?? []) visit(child, expected);
      return;
    }
    const handled = new Set(['key', 'children', 'tokens']);
    const mixedTypography = expected.textRuns?.length || actual.mixedTextProperties?.length;
    if (types[expected.type]) compare(expected.key, 'type', types[expected.type], actual.type);
    else unchecked.push({ key: expected.key, field: 'type', reason: 'Imported image/SVG representation is not compared' });
    handled.add('type');
    if (parent) {
      const parentId = byKey.get(parent.key)?.id;
      compare(expected.key, 'parentId', parentId ?? 'missing-parent', actual.parentId);
      compare(expected.key, 'treeParentId', parentId ?? 'missing-parent', treeParents.get(actual.id));
    }
    for (const field of ['name', 'visible', 'content', 'fontFamily', 'fontSize', 'textAutoResize', 'textAlign']) {
      if (expected[field] !== undefined) {
        if (field === 'name' && expected.type === 'component' && expected.variant) unchecked.push({ key: expected.key, field, reason: 'Variant name is generated; inspect variant properties separately' });
        else if (mixedTypography && ['fontFamily', 'fontSize'].includes(field)) unchecked.push({ key: expected.key, field, reason: 'Mixed typography needs textRuns comparison' });
        else compare(expected.key, field, expected[field], actual[field], field === 'fontSize');
      }
      handled.add(field);
    }
    if (expected.fontStyle !== undefined || expected.fontWeight !== undefined) {
      if (mixedTypography) unchecked.push({ key: expected.key, field: 'fontStyle', reason: 'Mixed typography needs textRuns comparison' });
      else compare(expected.key, 'fontStyle', expected.fontStyle ?? expected.fontWeight, actual.fontStyle);
    }
    handled.add('fontStyle'); handled.add('fontWeight');
    for (const field of ['x', 'y', 'width', 'height']) {
      handled.add(field);
      if (expected[field] === undefined) continue;
      const position = field === 'x' || field === 'y';
      const textResize = expected.type === 'text' && actual.textAutoResize !== 'NONE'
        && (field === 'height' || field === 'width' && actual.textAutoResize === 'WIDTH_AND_HEIGHT');
      let reason;
      if (position && !parent) reason = 'Root placement is outside the spec comparison';
      else if (position && parent.layout?.direction !== 'none' && expected.layoutPositioning !== 'ABSOLUTE') reason = 'Position is controlled by Auto Layout';
      else if (textResize) reason = 'Text size is controlled by textAutoResize';
      else if (expected.rotation || actual.rotation) reason = 'Rotated geometry needs a separate transform comparison';
      else if (typeof expected[field] !== 'number') reason = 'Fill/Hug sizing needs layout verification';
      if (reason) unchecked.push({ key: expected.key, field, reason });
      else compare(expected.key, field, expected[field], actual.bounds?.[field], true);
    }
    for (const field of Object.keys(expected)) {
      if (!handled.has(field) && expected[field] !== undefined) unchecked.push({ key: expected.key, field, reason: 'Not included in this checker; inspect separately' });
    }
    if (expected.children) compare(expected.key, 'childOrder', expected.children.map(n => n.key),
      (actual.children ?? []).map(n => n.key ?? `<unkeyed:${n.id}>`));
    for (const child of expected.children ?? []) visit(child, expected);
  }
  visit(spec);
  for (const key of byKey.keys()) if (!expectedKeys.has(key)) differences.push({ key, field: 'node', expected: 'absent', actual: 'unexpected-key' });
  for (const node of byId.values()) if (!node.key) {
    let parent = byId.get(treeParents.get(node.id));
    while (parent && !svgKeys.has(parent.key)) parent = byId.get(treeParents.get(parent.id));
    if (!parent) differences.push({ nodeId: node.id, field: 'node', expected: 'absent', actual: 'unexpected-unkeyed-node' });
  }
  return {
    fileKey: parsed.fileKey, rootId, snapshotOnly: true, numericTolerance: tolerance,
    scope: 'Explicit identity, hierarchy, text, font and directly comparable geometry fields',
    automated: { status: differences.length ? 'mismatch' : 'matched', checked, differences },
    unchecked, readNodes: byId.size, expectedNodes: expectedKeys.size,
    fidelityWarnings: result.fidelityWarnings ?? [],
    visual: 'not-tested', actualClicks: 'not-tested',
    overallStatus: differences.length ? 'mismatch' : 'needs_review',
    nextStep: 'Inspect unchecked properties and a fresh PNG. This report does not establish visual fidelity or freshness of the saved snapshot.',
  };
}
