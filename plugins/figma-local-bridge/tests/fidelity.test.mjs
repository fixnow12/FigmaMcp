import test from "node:test";
import assert from "node:assert/strict";
import { createFigmaMock, executeGenerated } from "./helpers/figma-mock.mjs";
import { buildInspectCode, buildPatchCode, buildRenderCode } from "../src/figma-code.mjs";
import { normalizeScreenSpec, parseRenderScreenInput, patchNodesSchema } from "../src/schemas.mjs";
import { exportAssetsSchema, buildExportAssetsCode } from "../src/export-assets.mjs";

const solid = { type: "SOLID", color: { r: 0.0078, g: 0.0078, b: 0.1333 }, opacity: 0.7, visible: true };
const gradient = { type: "GRADIENT_LINEAR", gradientTransform: [[1, 0, 0], [0, 1, 0]], gradientStops: [{ position: 0, color: { r: 1, g: 0, b: 0, a: 0.2 } }, { position: 1, color: { r: 0, g: 0, b: 1, a: 1 } }] };
const input = nodes => ({ spec: { key: "fidelity-test", name: "Проверка точности", type: "screen", width: 500, height: 400, nodes } });
async function render(mock, value) {
  const parsed = parseRenderScreenInput(value);
  return executeGenerated(mock.figma, buildRenderCode({ ...parsed, spec: normalizeScreenSpec(parsed.spec) }));
}
const inspect = (mock, nodeId, options = {}) => executeGenerated(mock.figma, buildInspectCode({ nodeId, depth: 8, maxNodes: 100, detail: "full", ...options }));
const patch = (mock, patches) => executeGenerated(mock.figma, buildPatchCode(patchNodesSchema.parse({ patches })));

test("матрицы paints принимают только числовые массивы 2×3", () => {
  const parse = matrix => patchNodesSchema.parse({ patches: [{ id: "matrix", set: { fills: [{ ...gradient, gradientTransform: matrix }] } }] });
  assert.doesNotThrow(() => parse([[1, 0, 0], [0, 1, 0]]));
  for (const invalid of [[[1, 0, 0]], [[1, 0], [0, 1]], [[1, 0, 0, 0], [0, 1, 0]], [[1, 0, "0"], [0, 1, 0]]]) {
    assert.throws(() => parse(invalid));
  }
});

test("ограничение глубины и бюджета возвращает непрочитанные ветки, missing не считается complete", async () => {
  const mock = createFigmaMock(); const root = mock.make("FRAME");
  mock.make("TEXT", { characters: "Пропущенная ссылка подвала" }, root);
  const shallow = await inspect(mock, root.id, { depth: 0 });
  assert.equal(shallow.truncated, true); assert.equal(shallow.coverage.complete, false);
  assert.deepEqual(shallow.coverage.unread, [{ nodeId: root.id, reason: "depth", childCount: 1 }]);
  const limited = await inspect(mock, root.id, { maxNodes: 1 });
  assert.equal(limited.coverage.unread[0].reason, "maxNodes");
  assert.equal((await inspect(mock, root.id)).coverage.complete, true);
  assert.equal((await inspect(mock, "missing")).coverage.complete, false);
});

test("read → render сохраняет RGB без округления, alpha и градиент; контейнеры прозрачны", async () => {
  const mock = createFigmaMock();
  const source = mock.make("RECTANGLE", { fills: [solid, gradient] });
  const read = (await inspect(mock, source.id)).selection[0];
  const out = await render(mock, input([{ type: "frame", key: "wrapper", name: "Обёртка" }, { type: "rectangle", key: "paint", parentKey: "wrapper", name: "Цвет", fills: read.fills }]));
  const root = mock.nodes.get(out.rootId);
  assert.deepEqual(root.children[0].fills, []);
  assert.deepEqual(root.children[0].children[0].fills, [solid, gradient]);
});

test("радиусы углов, stroke alignment и min/max проходят render и patch с откатом", async () => {
  const mock = createFigmaMock(); const create = mock.figma.createFrame;
  mock.figma.createFrame = () => Object.assign(create(), { topLeftRadius: 0, topRightRadius: 0, bottomLeftRadius: 0, bottomRightRadius: 0, cornerSmoothing: 0, strokeAlign: "INSIDE", minWidth: null, maxWidth: null });
  const props = { topLeftRadius: 32, topRightRadius: 12, bottomLeftRadius: 8, bottomRightRadius: 0, cornerSmoothing: 0.6, strokeAlign: "OUTSIDE", minWidth: 100, maxWidth: 700 };
  const out = await render(mock, input([{ type: "frame", key: "rounded", name: "Скругления", ...props }]));
  const node = mock.nodes.get(out.rootId).children[0];
  for (const [k, v] of Object.entries(props)) assert.equal(node[k], v);
  await patch(mock, [{ id: node.id, set: { topLeftRadius: 24, fills: [solid] } }]);
  assert.equal(node.topLeftRadius, 24);
  const other = mock.make("FRAME");
  mock.rejectWrites((target, field, value) => target.id === other.id && field === "opacity" && value === 0.25);
  await assert.rejects(patch(mock, [{ id: node.id, set: { topLeftRadius: 4, fills: [] } }, { id: other.id, set: { opacity: 0.25 } }]), /отменены/);
  assert.equal(node.topLeftRadius, 24); assert.deepEqual(node.fills, [solid]);
});

test("imageHash проверяется до записи и сохраняет crop, фильтры и прозрачность", async () => {
  const mock = createFigmaMock(); mock.figma.getImageByHash = h => h === "known" ? {} : null;
  const paint = { type: "IMAGE", imageHash: "known", scaleMode: "CROP", imageTransform: [[0.91, 0, 0.02], [0, 0.70, 0]], filters: { contrast: 0.25 }, opacity: 0.75 };
  const out = await render(mock, input([{ type: "rectangle", key: "photo", name: "Фото", fills: [paint] }]));
  const node = mock.nodes.get(out.rootId).children[0]; assert.deepEqual(node.fills, [paint]);
  const before = mock.writes.length;
  await assert.rejects(patch(mock, [{ id: node.id, set: { name: "Нельзя", fills: [{ ...paint, imageHash: "missing" }] } }]), /Изображение недоступно/);
  assert.equal(mock.writes.length, before);
});

test("export_assets возвращает реальные SVG/байты, дедуплицирует hash и явно сообщает лимиты", async () => {
  const mock = createFigmaMock();
  const node = mock.make("VECTOR", { exportAsync: async settings => { assert.equal(settings.format, "SVG_STRING"); return '<svg><path d="M0 0L1 1"/></svg>'; } });
  const call = args => executeGenerated(mock.figma, buildExportAssetsCode(exportAssetsSchema.parse(args)));
  assert.equal((await call({ nodeIds: [node.id] })).assets[0].type, "svg");
  const a = mock.make("RECTANGLE", { fills: [{ type: "IMAGE", imageHash: "png" }] });
  const b = mock.make("RECTANGLE", { fills: [{ type: "IMAGE", imageHash: "png" }] });
  mock.figma.getImageByHash = () => ({ getBytesAsync: async () => new Uint8Array([137, 80, 78, 71]) });
  mock.figma.base64Encode = b => Buffer.from(b).toString("base64");
  const result = await call({ nodeIds: [a.id, b.id], format: "images" });
  assert.equal(result.assets.length, 1); assert.equal(result.assets[0].data, "iVBORw==");
  assert.equal(result.complete, true);
  node.exportAsync = async () => "x".repeat(1024);
  const limited = await call({ nodeIds: [node.id, "missing"], maxBytes: 1024 });
  assert.equal(limited.assets.length, 0); assert.equal(limited.complete, false);
  assert.deepEqual(limited.warnings.map(x => x.reason), ["maxBytes", "missing"]);
});

test("schema отклоняет некорректные paints и не принимает свойства всего текста в textRuns", () => {
  assert.throws(() => parseRenderScreenInput(input([{ type: "rectangle", key: "x", name: "X", fills: [{ type: "SOLID" }] }])));
  assert.throws(() => parseRenderScreenInput(input([{ type: "rectangle", key: "x", name: "X", fills: [{ ...solid, imageHash: "oops" }] }])));
  assert.throws(() => parseRenderScreenInput(input([{ type: "text", key: "x", name: "X", content: "123", textRuns: [{ start: 0, end: 1, textAutoResize: "NONE" }] }])));
});

test("SVG rescale меняет масштаб содержимого, непропорциональный размер откатывает создание", async () => {
  const mock = createFigmaMock(); let contentScale = 1;
  mock.figma.createNodeFromSvg = () => mock.make("FRAME", { width: 24, height: 16, rescale(ratio) { contentScale *= ratio; this.width *= ratio; this.height *= ratio; } });
  const out = await render(mock, input([{ type: "svg", key: "icon", name: "Значок", svg: "<svg/>", width: 48, height: 32 }]));
  assert.equal(contentScale, 2); assert.equal(mock.nodes.get(out.rootId).children[0].width, 48);
  const before = mock.nodes.size;
  const invalid = input([{ type: "svg", key: "icon", name: "Значок", svg: "<svg/>", width: 48, height: 40 }]);
  invalid.spec.key = "bad-svg";
  await assert.rejects(render(mock, invalid), /пропорциональные/);
  assert.equal(mock.nodes.size, before);
});

test("append сохраняет paints, absolute position и textAutoResize; инспектор помечает скрытые слои", async () => {
  const mock = createFigmaMock();
  const create = mock.figma.createFrame;
  mock.figma.createFrame = () => Object.assign(create(), { layoutPositioning: "AUTO" });
  const parent = mock.make("FRAME", { visible: false });
  await patch(mock, [{ id: parent.id, append: [{ type: "frame", key: "absolute", name: "Абсолютный", fills: [solid], layoutPositioning: "ABSOLUTE", x: 12, y: 15 }] }]);
  const child = parent.children[0]; assert.equal(child.x, 12); assert.equal(child.y, 15); assert.deepEqual(child.fills, [solid]);
  const read = await inspect(mock, child.id); assert.equal(read.selection[0].effectiveVisible, false);
  const text = mock.make("TEXT");
  await patch(mock, [{ id: text.id, set: { textAutoResize: "NONE", width: 100, height: 40 } }]);
  assert.equal(text.textAutoResize, "NONE");
});

test("patch маски откатывает isMask и maskType при ошибке следующего узла", async () => {
  const mock = createFigmaMock();
  const mask = mock.make("RECTANGLE", { isMask: true, maskType: "LUMINANCE" });
  const other = mock.make("FRAME");
  mock.rejectWrites((target, field, value) => target.id === other.id && field === "opacity" && value === 0.25);
  await assert.rejects(patch(mock, [{ id: mask.id, set: { isMask: false, maskType: "VECTOR" } }, { id: other.id, set: { opacity: 0.25 } }]), /отменены/);
  assert.equal(mask.isMask, true);
  assert.equal(mask.maskType, "LUMINANCE");
  assert.throws(() => parseRenderScreenInput(input([{ type: "rectangle", key: "x", name: "X", maskType: "UNKNOWN" }])));
});
