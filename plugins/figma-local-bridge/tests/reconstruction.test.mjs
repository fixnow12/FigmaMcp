import test from "node:test";
import assert from "node:assert/strict";
import { createFigmaMock, executeGenerated } from "./helpers/figma-mock.mjs";
import { buildReconstructionRead, compileReconstruction, buildReconstructionWrite, recreateScreen } from "../src/reconstruction.mjs";

function fixture() {
  const mock = createFigmaMock();
  mock.figma.createFrame = () => mock.make("FRAME", { effects: [] });
  mock.figma.createLine = () => mock.make("LINE", { height: 0, effects: [], strokeCap: "NONE", strokeJoin: "MITER" });
  mock.figma.createVector = () => mock.make("VECTOR", { effects: [], vectorPaths: [], cornerRadius: 0, strokeCap: "NONE", strokeJoin: "MITER" });
  const root = mock.make("FRAME", { name: "Исходник", width: 1440, height: 1032, layoutMode: "NONE", effects: [], opacity: 0.9, cornerRadius: 32 });
  const card = mock.make("FRAME", { x: 80, y: 90, width: 460, height: 88, layoutMode: "HORIZONTAL", itemSpacing: 16, effects: [{ type: "DROP_SHADOW", radius: 8, color: { r: 0, g: 0, b: 0, a: 0.15 }, offset: { x: 0, y: 2 } }] }, root);
  const text = mock.make("TEXT", { characters: "Близкие Другие", fontName: { family: "Factor IO", style: "Medium" }, fontSize: 32, fills: [{ type: "SOLID", color: { r: 0.0078, g: 0.0078, b: 0.1333 } }] }, card);
  for (const node of [root, card, text]) node.clone = () => assert.fail("clone запрещён");
  const bridge = {
    runInFile: async (key, fn) => { assert.equal(key, "file"); return fn({ fileKey: key, pageId: mock.page.id }); },
    execute: async code => ({ result: await executeGenerated(mock.figma, code) }),
    captureScreenshot: async () => { throw new Error("PNG failed"); },
  };
  return { ...mock, root, card, text, bridge };
}

test("полное чтение и новая сборка сохраняют текст, шрифты, тени, цвета и исходник", async () => {
  const f = fixture();
  const before = JSON.stringify(await executeGenerated(f.figma, buildReconstructionRead(f.root.id)));
  const read = JSON.parse(before);
  const compiled = compileReconstruction(read, { key: "rebuilt" });
  const result = await executeGenerated(f.figma, buildReconstructionWrite(compiled, { x: 1600, y: 0 }));
  const newRoot = f.nodes.get(result.rootId);
  assert.notEqual(newRoot.id, f.root.id);
  assert.equal(newRoot.opacity, 0.9);
  assert.deepEqual(newRoot.children[0].effects[0].color, f.card.effects[0].color);
  assert.equal(newRoot.children[0].itemSpacing, 16);
  assert.equal(newRoot.children[0].x, 80);
  assert.equal(newRoot.children[0].children[0].characters, f.text.characters);
  assert.deepEqual(newRoot.children[0].children[0].fontName, f.text.fontName);
  assert.deepEqual(newRoot.children[0].children[0].fills, f.text.fills);
  assert.equal(result.mapping.length, 3);
  assert.equal(result.verification.differenceCount, 0);
  assert.equal(JSON.stringify(await executeGenerated(f.figma, buildReconstructionRead(f.root.id))), before);
});

test("dryRun не создаёт слоёв; недоступные шрифты и Grid блокируют запись", async () => {
  const f = fixture();
  const count = f.nodes.size;
  const good = await recreateScreen(f.bridge, { fileKey: "file", sourceId: f.root.id, dryRun: true });
  assert.equal(good.structuredContent.ready, true);
  assert.equal(f.nodes.size, count);
  f.figma.loadFontAsync = async () => { throw new Error("Не загружен"); };
  const bad = await recreateScreen(f.bridge, { fileKey: "file", sourceId: f.root.id });
  assert.equal(bad.isError, true);
  assert.match(bad.structuredContent.error, /Factor IO.*Medium/);
  assert.equal(f.nodes.size, count);
  f.figma.loadFontAsync = async () => {};
  f.card.layoutMode = "GRID";
  const grid = await recreateScreen(f.bridge, { fileKey: "file", sourceId: f.root.id });
  assert.match(grid.structuredContent.error, /GRID/);
  assert.equal(f.nodes.size, count);
});

test("mixed fontName с одним диапазоном сохраняет фактический шрифт при воссоздании", async () => {
  const f = fixture();
  const font = { family: "Factor IO", style: "Medium" };
  const originalSegments = f.text.getStyledTextSegments.bind(f.text);
  const segments = originalSegments(["fontName", "fontSize", "lineHeight", "letterSpacing", "fills"]);
  f.text.fontName = f.figma.mixed;
  f.text.getStyledTextSegments = () => segments.map(segment => ({ ...segment, fontName: font }));
  const read = await executeGenerated(f.figma, buildReconstructionRead(f.root.id));
  const sourceText = read.snapshot.selection[0].children[0].children[0];
  assert.deepEqual(sourceText.mixedTextProperties, ["fontName"]);
  assert.equal(sourceText.textRuns.length, 1);
  assert.equal(sourceText.textRuns[0].fontFamily, font.family);
  assert.equal(sourceText.textRuns[0].fontStyle, font.style);
  const compiled = compileReconstruction(read, { key: "single-mixed-run" });
  const result = await executeGenerated(f.figma, buildReconstructionWrite(compiled, { x: 1600, y: 0 }));
  const rebuiltText = f.nodes.get(result.mapping.find(entry => entry.sourceId === f.text.id).id);
  assert.deepEqual(rebuiltText.fontName, font);
  assert.equal(rebuiltText.characters, f.text.characters);
});

test("глубокие ветки дочитываются без модели; лимит не превращается в неполную сборку", async () => {
  const f = fixture(); let parent = f.card;
  for (let i = 0; i < 12; i++) parent = f.make("FRAME", { layoutMode: "NONE" }, parent);
  const deep = f.make("TEXT", { characters: "Ссылка подвала" }, parent);
  const read = await executeGenerated(f.figma, buildReconstructionRead(f.root.id));
  const compiled = compileReconstruction(read, { key: "deep" });
  assert.ok(compiled.mappings.some(m => m.sourceId === deep.id));
  read.snapshot.coverage.complete = false;
  assert.throws(() => compileReconstruction(read, { key: "incomplete" }), /не полностью/);
});

test("оригинальный IMAGE сохраняет hash; SVG переносится без повторного применения opacity", async () => {
  const f = fixture();
  const photo = f.make("RECTANGLE", { fills: [{ type: "IMAGE", imageHash: "avatar", scaleMode: "CROP", imageTransform: [[1, 0, 0], [0, 1, 0]] }] }, f.root);
  const vector = f.make("VECTOR", { opacity: 0.5, exportAsync: async () => '<svg xmlns="http://www.w3.org/2000/svg"><path opacity="0.5" d="M0 0L10 10"/></svg>' }, f.root);
  const compiled = compileReconstruction(await executeGenerated(f.figma, buildReconstructionRead(f.root.id)), { key: "assets" });
  assert.deepEqual(compiled.spec.children.find(n => n.key === compiled.mappings.find(m => m.sourceId === photo.id).key).fills, photo.fills);
  const icon = compiled.spec.children.find(n => n.key === compiled.mappings.find(m => m.sourceId === vector.id).key);
  assert.equal(icon.type, "svg");
  assert.equal(icon.opacity, undefined);
  assert.match(icon.svg, /opacity="0.5"/);
});

test("ошибка PNG после сборки сохраняет applied; fileKey обязателен", async () => {
  const f = fixture();
  const response = await recreateScreen(f.bridge, { fileKey: "file", sourceId: f.root.id });
  assert.equal(response.isError, undefined);
  assert.equal(response.structuredContent.operationStatus, "applied");
  assert.equal(response.structuredContent.screenshot.status, "failed");
  const missing = await recreateScreen(f.bridge, { sourceId: f.root.id });
  assert.equal(missing.isError, true);
});

test("линия высотой 0 остаётся LINE; скрытые шрифты и векторы не блокируют видимый экран", async () => {
  const f = fixture();
  const divider = f.make("LINE", { width: 1200, height: 0, strokeWeight: 1, strokeCap: "NONE", strokes: [{ type: "SOLID", color: { r: 0.1, g: 0.2, b: 0.3 }, opacity: 0.1 }] }, f.root);
  const hidden = f.make("FRAME", { visible: false }, f.root);
  f.make("TEXT", { fontName: { family: "Missing", style: "Bold" } }, hidden);
  f.make("VECTOR", { exportAsync: () => assert.fail("Скрытый SVG не экспортируется") }, hidden);
  const read = await executeGenerated(f.figma, buildReconstructionRead(f.root.id));
  assert.equal(read.fontErrors.length, 0);
  const compiled = compileReconstruction(read, { key: "lines" });
  assert.equal(compiled.skippedHidden, 3);
  const output = await executeGenerated(f.figma, buildReconstructionWrite(compiled));
  const line = f.nodes.get(output.mapping.find(m => m.sourceId === divider.id).id);
  assert.equal(line.type, "LINE");
  assert.equal(line.height, 0);
  assert.deepEqual(line.strokes, divider.strokes);
});

test("координаты детей GROUP пересчитываются относительно нового фрейма", async () => {
  const f = fixture();
  const group = f.make("FRAME", { layoutMode: "NONE", x: 10, y: 20, width: 42, height: 42 }, f.root);
  group.type = "GROUP";
  delete group.layoutMode;
  const icon = f.make("RECTANGLE", { x: 11, y: 21, width: 40, height: 40 }, group);
  const compiled = compileReconstruction(await executeGenerated(f.figma, buildReconstructionRead(f.root.id)), { key: "group" });
  const output = await executeGenerated(f.figma, buildReconstructionWrite(compiled));
  const rebuilt = f.nodes.get(output.mapping.find(m => m.sourceId === icon.id).id);
  assert.equal(rebuilt.x, 1);
  assert.equal(rebuilt.y, 1);
  assert.equal(rebuilt.parent.x + rebuilt.x, 11);
  assert.equal(output.verification.differenceCount, 0);
});

test("VECTOR воссоздаётся из точных контуров без SVG или clone", async () => {
  const f = fixture();
  const paths = [{ windingRule: "EVENODD", data: "M 0 0 L 40 0 L 20 40 Z" }];
  const original = f.make("VECTOR", { width: 40, height: 40, vectorPaths: paths, exportAsync: () => assert.fail("Нативный контур не требует SVG"), clone: () => assert.fail("Не копируем узел") }, f.root);
  const compiled = compileReconstruction(await executeGenerated(f.figma, buildReconstructionRead(f.root.id)), { key: "vector" });
  const output = await executeGenerated(f.figma, buildReconstructionWrite(compiled));
  const vector = f.nodes.get(output.mapping.find(m => m.sourceId === original.id).id);
  assert.equal(vector.type, "VECTOR");
  assert.deepEqual(vector.vectorPaths, paths);
});

test("похожий экран: меняет текст и оформление, добавляет блок; исходник не меняется", async () => {
  const f = fixture();
  const response = await recreateScreen(f.bridge, { fileKey: "file", sourceId: f.root.id, screenshot: false, changes: [
    { sourceId: f.text.id, action: "update", set: { content: "Помочь фонду", color: "#0077ff", fontSize: 24 } },
    { sourceId: f.card.id, action: "update", set: { layout: { gap: 24 }, cornerRadius: 16 } },
    { sourceId: f.root.id, action: "append", nodes: [
      { key: "button", type: "frame", name: "Продолжить", width: 240, height: 48, layout: { direction: "horizontal", padding: 12 } },
      { key: "label", parentKey: "button", type: "text", name: "Текст", content: "Продолжить", fontFamily: "Factor IO", fontStyle: "Medium" },
    ] },
  ] });
  assert.equal(response.isError, undefined, JSON.stringify(response));
  const result = response.structuredContent.result;
  const root = f.nodes.get(result.rootId);
  assert.equal(root.children.length, 2);
  assert.equal(root.children[0].children[0].characters, "Помочь фонду");
  assert.deepEqual(root.children[0].children[0].fills[0].color, { r: 0, g: 119 / 255, b: 1 });
  assert.equal(root.children[0].itemSpacing, 24);
  assert.equal(root.children[0].layoutMode, "HORIZONTAL");
  assert.equal(root.children[1].children[0].characters, "Продолжить");
  assert.equal(f.text.characters, "Близкие Другие");
  assert.equal(f.root.children.length, 1);
  assert.equal(result.verification.differenceCount, 0);
  assert.equal(result.verification.scope, "retained-nodes-text-and-fonts");
});

test("замена и удаление работают внутри новой сборки, порядок блоков сохраняется", async () => {
  const f = fixture();
  const second = f.make("FRAME", { name: "Второй", layoutMode: "NONE" }, f.root);
  const last = f.make("FRAME", { name: "Последний", layoutMode: "NONE" }, f.root);
  const response = await recreateScreen(f.bridge, { fileKey: "file", sourceId: f.root.id, screenshot: false, changes: [
    { sourceId: f.card.id, action: "replace", nodes: [
      { key: "a", type: "text", name: "Новый первый", content: "Первый", fontFamily: "Factor IO", fontStyle: "Regular" },
      { key: "b", type: "text", name: "Новый второй", content: "Второй", fontFamily: "Factor IO", fontStyle: "Regular" },
    ] },
    { sourceId: second.id, action: "remove" },
  ] });
  assert.equal(response.isError, undefined, JSON.stringify(response));
  const result = response.structuredContent.result;
  assert.deepEqual(f.nodes.get(result.rootId).children.map(n => n.name), ["Новый первый", "Новый второй", "Последний"]);
  assert.deepEqual(result.mapping.map(m => m.sourceId), [f.root.id, last.id]);
  assert.equal(f.card.removed, false);
  assert.equal(second.removed, false);
});

test("ошибочная замена, чужой ID и невалидная вложенность отклоняются без записи", async () => {
  for (const makeChanges of [
    f => [{ sourceId: f.text.id, action: "update", set: { content: "Новый", layout: { direction: "vertical" } } }],
    f => [{ sourceId: "outside", action: "remove" }],
    f => [{ sourceId: f.root.id, action: "remove" }],
    f => [{ sourceId: f.card.id, action: "replace", nodes: [{ type: "frame", key: "bad", parentKey: "outside", name: "Ошибка" }] }],
    f => [{ sourceId: f.card.id, action: "append", nodes: [{ type: "frame", key: "bad", name: "Ошибка" }, { type: "frame", key: "a", parentKey: "b", name: "A" }, { type: "frame", key: "b", parentKey: "a", name: "B" }] }],
    f => [{ sourceId: f.card.id, action: "remove" }, { sourceId: f.text.id, action: "update", set: { content: "Новый" } }],
  ]) {
    const f = fixture(), count = f.nodes.size;
    const response = await recreateScreen(f.bridge, { fileKey: "file", sourceId: f.root.id, changes: makeChanges(f) });
    assert.equal(response.isError, true);
    assert.equal(f.nodes.size, count);
    assert.equal(f.text.characters, "Близкие Другие");
  }
});

test("dryRun проверяет шрифты новых элементов до создания", async () => {
  const f = fixture(), count = f.nodes.size;
  f.figma.loadFontAsync = async font => { if (font.family === "Unavailable") throw new Error("Missing font"); };
  const changes = [{ sourceId: f.root.id, action: "append", nodes: [{ key: "label", type: "text", name: "Новый", content: "Текст", fontFamily: "Unavailable", fontStyle: "Regular" }] }];
  for (const dryRun of [true, false]) {
    const response = await recreateScreen(f.bridge, { fileKey: "file", sourceId: f.root.id, changes, dryRun });
    assert.equal(response.isError, true);
    assert.match(response.structuredContent.error, /Unavailable/);
    assert.equal(f.nodes.size, count);
  }
});
