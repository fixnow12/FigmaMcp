import test from "node:test";
import assert from "node:assert/strict";
import { buildPatchCode, buildInspectCode, buildRenderCode, buildUseComponentCode } from "../src/figma-code.mjs";
import { patchNodesSchema } from "../src/schemas.mjs";
import { createFigmaMock, executeGenerated } from "./helpers/figma-mock.mjs";

const run = (mock, input) => executeGenerated(mock.figma, buildPatchCode({ ignoreMissing: false, ...patchNodesSchema.parse(input) }));

test("неверный тип второго патча отклоняется до изменения первого узла", async () => {
  const mock = createFigmaMock();
  const first = mock.make("FRAME", { name: "До" });
  const second = mock.make("FRAME");
  mock.writes.length = 0;
  await assert.rejects(run(mock, { patches: [{ id: first.id, set: { name: "После" } }, { id: second.id, set: { content: "Текст" } }] }), /только для TEXT/);
  assert.equal(first.name, "До");
  assert.equal(mock.writes.length, 0);
});

test("сбой записи откатывает весь пакет с сохранением id", async () => {
  const mock = createFigmaMock();
  const first = mock.make("FRAME", { name: "До" });
  const second = mock.make("FRAME");
  mock.rejectWrites((node, field, value) => node.id === second.id && field === "opacity" && value === 0.5);
  await assert.rejects(run(mock, { patches: [{ id: first.id, set: { name: "После" } }, { id: second.id, set: { opacity: 0.5 } }] }), (error) => {
    assert.equal(error.operationStatus, "rolled_back");
    return true;
  });
  assert.equal(first.name, "До");
  assert.equal(second.opacity, 1);
  assert.equal(mock.nodes.get(first.id), first);
});

test("неполный откат явно сообщает partial и ошибки восстановления", async () => {
  const mock = createFigmaMock();
  const first = mock.make("FRAME", { name: "До" });
  const second = mock.make("FRAME");
  mock.rejectWrites((node, field, value) => (node.id === second.id && field === "opacity" && value === 0.5) || (node.id === first.id && field === "name" && value === "До"));
  await assert.rejects(run(mock, { patches: [{ id: first.id, set: { name: "После" } }, { id: second.id, set: { opacity: 0.5 } }] }), (error) => {
    assert.equal(error.operationStatus, "partial");
    assert.ok(error.rollbackErrors.length);
    return true;
  });
});

test("ошибка изображения удаляет даже узел, ещё не добавленный в родителя", async () => {
  const mock = createFigmaMock();
  const parent = mock.make("FRAME", { name: "До" });
  const count = mock.nodes.size;
  await assert.rejects(run(mock, { patches: [{ id: parent.id, set: { name: "После" }, append: [{ key: "image", name: "Фото", type: "image", data: "AA==", mimeType: "image/png" }] }] }), /Изменения пакета отменены/);
  assert.equal(parent.name, "До");
  assert.equal(mock.nodes.size, count);
  assert.equal(parent.children.length, 0);
});

test("ошибка позднего append удаляет элементы предыдущего патча", async () => {
  const mock = createFigmaMock();
  const parent = mock.make("FRAME");
  const count = mock.nodes.size;
  await assert.rejects(run(mock, { patches: [
    { id: parent.id, append: [{ key: "good", name: "Блок", type: "frame" }] },
    { id: parent.id, append: [{ key: "bad", name: "Иконка", type: "svg", svg: "<svg/>" }] },
  ] }), /Изменения пакета отменены/);
  assert.equal(mock.nodes.size, count);
});

test("ignoreMissing не сообщает создание пропущенных узлов", async () => {
  const mock = createFigmaMock();
  const parent = mock.make("FRAME");
  const result = await run(mock, { ignoreMissing: true, patches: [
    { id: "missing", append: [{ key: "skipped", name: "Пропущен", type: "frame" }] },
    { id: parent.id, append: [{ key: "added", name: "Добавлен", type: "frame" }] },
  ] });
  assert.deepEqual(result.appended, ["added"]);
  assert.deepEqual(result.missing, ["missing"]);
});

test("все шрифты проверяются до первой записи без молчаливой подмены", async () => {
  const mock = createFigmaMock();
  const parent = mock.make("FRAME", { name: "До" });
  mock.writes.length = 0;
  await assert.rejects(run(mock, { patches: [{ id: parent.id, set: { name: "После" }, append: [{ key: "text", name: "Текст", type: "text", content: "Привет", fontFamily: "Missing" }] }] }), /Шрифт недоступен/);
  assert.equal(mock.writes.length, 0);
});

test("патч не выбирает случайный узел при дублированном key", async () => {
  const mock = createFigmaMock();
  mock.key(mock.make("FRAME"), "same");
  mock.key(mock.make("FRAME"), "same");
  await assert.rejects(run(mock, { patches: [{ key: "same", set: { name: "Нет" } }] }), /Ключ неоднозначен/);
});

test("padding с одной стороной не присваивает undefined остальным", async () => {
  const mock = createFigmaMock();
  const parent = mock.make("FRAME");
  await run(mock, { patches: [{ id: parent.id, set: { padding: { top: 12 } } }] });
  assert.deepEqual([parent.paddingTop, parent.paddingRight, parent.paddingBottom, parent.paddingLeft], [12, 0, 0, 0]);
});

test("append отклоняет циклы, листья-родители и ключи-дубликаты во всём пакете", () => {
  for (const append of [
    [{ key: "a", parentKey: "a", type: "frame", name: "А" }],
    [{ key: "a", parentKey: "b", type: "frame", name: "А" }, { key: "b", parentKey: "a", type: "frame", name: "Б" }],
    [{ key: "a", type: "text", name: "А", content: "А" }, { key: "b", parentKey: "a", type: "frame", name: "Б" }],
    [{ key: "set", type: "componentSet", name: "Набор" }],
    [{ key: "a", type: "frame", name: "А", background: { token: "colors.a" } }],
  ]) assert.equal(patchNodesSchema.safeParse({ patches: [{ id: "1", append }] }).success, false);
  const append = [{ key: "same", type: "frame", name: "Блок" }];
  assert.equal(patchNodesSchema.safeParse({ patches: [{ id: "1", append }, { id: "2", append }] }).success, false);
});

test("типографика меняется на существующем TEXT без пересоздания", async () => {
  const mock = createFigmaMock();
  const text = mock.make("TEXT");
  await run(mock, { patches: [{ id: text.id, set: { content: "Продолжить", fontFamily: "Factor IO", fontWeight: "Medium", fontSize: 18, lineHeight: 24, letterSpacing: -0.2, textAlign: "center" } }] });
  assert.equal(mock.nodes.get(text.id), text);
  assert.deepEqual(text.fontName, { family: "Factor IO", style: "Medium" });
  assert.equal(text.characters, "Продолжить");
  assert.equal(text.fontSize, 18);
  assert.deepEqual(text.lineHeight, { unit: "PIXELS", value: 24 });
  assert.equal(text.textAlignHorizontal, "CENTER");
});

test("ошибка после правки текста восстанавливает типографику, размеры и привязки", async () => {
  const mock = createFigmaMock();
  const text = mock.make("TEXT", { boundVariables: { fontSize: { type: "VARIABLE_ALIAS", id: "size" } }, fillStyleId: "text-color", textStyleId: "body" });
  const before = { characters: text.characters, fontName: text.fontName, fontSize: text.fontSize, width: text.width, height: text.height };
  const parent = mock.make("FRAME");
  await assert.rejects(run(mock, { patches: [
    { id: text.id, set: { content: "Длинный новый текст", fontWeight: "Bold", fontSize: 22, color: "#FF0000", width: 200 } },
    { id: parent.id, append: [{ key: "bad", name: "Ошибка", type: "svg", svg: "<svg/>" }] },
  ] }), (error) => { assert.equal(error.operationStatus, "rolled_back"); return true; });
  for (const [field, value] of Object.entries(before)) assert.deepEqual(text[field], value);
  assert.equal(text.fillStyleId, "text-color");
  assert.equal(text.textStyleId, "body");
  assert.equal(text.boundVariables.fontSize.id, "size");
});

test("частичная правка Auto Layout сохраняет непереданные настройки", async () => {
  const mock = createFigmaMock();
  const frame = mock.make("FRAME", { paddingTop: 12, paddingLeft: 20, itemSpacing: 8 });
  await run(mock, { patches: [{ id: frame.id, set: { layout: { direction: "horizontal", counterAlign: "center" } } }] });
  assert.equal(frame.layoutMode, "HORIZONTAL");
  assert.equal(frame.counterAxisAlignItems, "CENTER");
  assert.equal(frame.paddingTop, 12);
  assert.equal(frame.paddingLeft, 20);
  assert.equal(frame.itemSpacing, 8);
});

test("ошибка после изменения Auto Layout восстанавливает направление и отступы", async () => {
  const mock = createFigmaMock();
  const frame = mock.make("FRAME", { itemSpacing: 8, paddingTop: 12 });
  await assert.rejects(run(mock, { patches: [{ id: frame.id, set: { layout: { direction: "horizontal", gap: 24, padding: 16 } }, append: [{ key: "bad", name: "Ошибка", type: "svg", svg: "<svg/>" }] }] }), (error) => { assert.equal(error.operationStatus, "rolled_back"); return true; });
  assert.equal(frame.layoutMode, "VERTICAL");
  assert.equal(frame.itemSpacing, 8);
  assert.equal(frame.paddingTop, 12);
});

test("подробное чтение возвращает свойства, смешанные значения и отсутствующие id", async () => {
  const mock = createFigmaMock();
  const text = mock.make("TEXT", { fontName: mock.figma.mixed, boundVariables: { fontSize: { type: "VARIABLE_ALIAS", id: "size" } } });
  const result = await executeGenerated(mock.figma, buildInspectCode({ nodeIds: [text.id, "missing"], detail: "full", depth: 1, maxNodes: 20 }));
  assert.equal(result.selection[0].typography.fontName, "MIXED");
  assert.equal(result.selection[0].typography.fontSize, 14);
  assert.equal(result.selection[0].boundVariables.fontSize.id, "size");
  assert.deepEqual(result.missing, ["missing"]);
  const compact = await executeGenerated(mock.figma, buildInspectCode({ nodeId: text.id, depth: 1, maxNodes: 20 }));
  assert.equal(compact.selection[0].typography, undefined);
});

test("render при ошибке ресурса сохраняет старый экран и не оставляет новых узлов", async () => {
  const mock = createFigmaMock();
  const old = mock.key(mock.make("FRAME", { name: "Старый экран" }), "screen");
  mock.page.selection = [old];
  const count = mock.nodes.size;
  await assert.rejects(executeGenerated(mock.figma, buildRenderCode({ replace: true, spec: {
    key: "screen", name: "Новый экран", width: 320, height: 240,
    children: [{ type: "image", key: "image", name: "Фото", data: "AA==" }],
  } })), (error) => { assert.equal(error.operationStatus, "rolled_back"); return true; });
  assert.equal(mock.nodes.size, count);
  assert.equal(old.removed, false);
  assert.deepEqual(mock.page.selection, [old]);
});

test("render не удаляет добавленные пользователем элементы старой секции", async () => {
  const mock = createFigmaMock();
  const section = mock.key(mock.make("SECTION"), "section:screen");
  const old = mock.key(mock.make("FRAME", {}, section), "screen");
  const note = mock.make("TEXT", {}, section);
  const result = await executeGenerated(mock.figma, buildRenderCode({ replace: true, spec: { key: "screen", name: "Новый экран", width: 320, height: 240, children: [] } }));
  assert.equal(old.removed, true);
  assert.equal(section.removed, false);
  assert.equal(note.removed, false);
  assert.ok(mock.nodes.has(result.rootId));
});

test("use_component работает по ID и удаляет экземпляр при ошибке свойств", async () => {
  const mock = createFigmaMock();
  const component = mock.make("COMPONENT");
  const parent = mock.make("FRAME");
  component.createInstance = () => mock.make("INSTANCE", {
    componentProperties: {},
    setProperties() { throw new Error("Несуществующее свойство"); },
  });
  const count = mock.nodes.size;
  await assert.rejects(executeGenerated(mock.figma, buildUseComponentCode({ sourceId: component.id, parentId: parent.id, key: "instance", componentProperties: { missing: true } })), (error) => { assert.equal(error.operationStatus, "rolled_back"); return true; });
  assert.equal(mock.nodes.size, count);
  const result = await executeGenerated(mock.figma, buildUseComponentCode({ sourceId: component.id, parentId: parent.id, key: "instance" }));
  assert.equal(result.sourceId, component.id);
  assert.equal(mock.nodes.get(result.id).parent, parent);
});
