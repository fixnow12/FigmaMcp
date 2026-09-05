import test from "node:test";
import assert from "node:assert/strict";
import { createFigmaMock, executeGenerated } from "./helpers/figma-mock.mjs";
import { buildCloneCode, buildMoveCode } from "../src/scene-operations.mjs";
import { buildFindAssetsCode } from "../src/asset-catalog.mjs";
import { buildBindVariablesCode } from "../src/variable-bindings.mjs";
import { cloneNodesSchema, moveNodesSchema, findAssetsSchema, bindVariablesSchema } from "../src/operation-schemas.mjs";

const clone = (mock, input) => executeGenerated(mock.figma, buildCloneCode(cloneNodesSchema.parse(input)));
const move = (mock, input) => executeGenerated(mock.figma, buildMoveCode(moveNodesSchema.parse(input)));
const find = (mock, input) => executeGenerated(mock.figma, buildFindAssetsCode(findAssetsSchema.parse(input)));
const bind = (mock, input) => executeGenerated(mock.figma, buildBindVariablesCode(bindVariablesSchema.parse(input)));
const solid = (r = 1) => ({ type: "SOLID", color: { r, g: 0, b: 0 }, opacity: 0.7 });

test("перенос контейнера с определением компонента отклоняется до записи", async () => {
  const mock = createFigmaMock();
  const source = mock.make("FRAME");
  mock.make("COMPONENT", {}, source);
  mock.writes.length = 0;
  await assert.rejects(move(mock, { moves: [{ id: source.id, index: 0 }] }), (error) => error.operationStatus === "not_applied");
  assert.equal(mock.writes.length, 0);
});

test("изменение порядка слоёв во время подготовки останавливает перенос", async () => {
  const mock = createFigmaMock();
  const frame = mock.make("FRAME");
  const first = mock.make("FRAME", {}, frame);
  const second = mock.make("FRAME", {}, frame);
  const lookup = mock.figma.getNodeByIdAsync;
  mock.figma.getNodeByIdAsync = async (id) => {
    if (id === second.id) frame.insertChild(0, second);
    return lookup(id);
  };
  await assert.rejects(move(mock, { moves: [{ id: first.id, index: 1 }, { id: second.id, index: 1 }] }), (error) => error.operationStatus === "not_applied");
  assert.deepEqual(frame.children, [second, first]);
});

test("смена привязки во время загрузки шрифта останавливает запись даже при том же значении", async () => {
  const mock = createFigmaMock();
  const node = mock.make("TEXT", { fontSize: 14 });
  const old = mock.addVariable({ id: "old", value: 14 });
  const external = mock.addVariable({ id: "external", value: 14 });
  mock.addVariable({ id: "next", value: 20 });
  node.setBoundVariable("fontSize", old);
  mock.figma.loadFontAsync = async () => { node.setBoundVariable("fontSize", external); };
  await assert.rejects(bind(mock, { bindings: [{ nodeId: node.id, field: "fontSize", variableId: "next" }] }), (error) => error.operationStatus === "not_applied");
  assert.equal(node.boundVariables.fontSize.id, "external");
  assert.equal(node.fontSize, 14);
});

test("клонирование сохраняет оформление и экземпляры, но заменяет все служебные ключи", async () => {
  const mock = createFigmaMock();
  const card = mock.key(mock.make("FRAME", { fills: [solid()] }), "card");
  const text = mock.key(mock.make("TEXT", { fontSize: 18, characters: "Оплата", boundVariables: { fontSize: { type: "VARIABLE_ALIAS", id: "size" } } }, card), "title");
  const instance = mock.key(mock.make("INSTANCE", { componentProperties: { State: { type: "VARIANT", value: "Default" } } }, card), "button");
  const result = await clone(mock, { copies: [{ sourceId: card.id, key: "card-copy", name: "Копия карточки" }] });
  const copy = mock.nodes.get(result.copies[0].id);
  assert.equal(copy.name, "Копия карточки");
  assert.deepEqual(copy.fills, card.fills);
  assert.equal(copy.children[0].characters, "Оплата");
  assert.deepEqual(copy.children[0].boundVariables, text.boundVariables);
  assert.equal(copy.children[1].type, "INSTANCE");
  assert.deepEqual(copy.children[1].componentProperties, instance.componentProperties);
  assert.deepEqual(result.copies[0].nodes.map((item) => item.sourceId), [card.id, text.id, instance.id]);
  assert.equal(new Set(mock.page.findAll().map((node) => node.getPluginData("codex-spec-key"))).size, 6);
  assert.equal(card.getPluginData("codex-spec-key"), "card");
  copy.children[0].characters = "Другой текст";
  assert.equal(text.characters, "Оплата");
});

test("сбой второй копии удаляет весь созданный пакет", async () => {
  const mock = createFigmaMock();
  const source = mock.make("FRAME");
  mock.make("TEXT", {}, source);
  const count = mock.nodes.size;
  mock.rejectWrites((_node, field, value) => field === "name" && value === "Ошибка");
  await assert.rejects(clone(mock, { copies: [
    { sourceId: source.id, key: "one" }, { sourceId: source.id, key: "two", name: "Ошибка" },
  ] }), (error) => { assert.equal(error.operationStatus, "rolled_back"); return true; });
  assert.equal(mock.nodes.size, count);
  assert.equal(source.children.length, 1);
});

test("лимиты и повторные ключи копий проверяются до клонирования", async () => {
  const mock = createFigmaMock();
  const source = mock.key(mock.make("FRAME"), "existing");
  mock.make("TEXT", {}, source);
  mock.writes.length = 0;
  await assert.rejects(clone(mock, { maxNodes: 1, copies: [{ sourceId: source.id, key: "copy" }] }), /maxNodes/);
  await assert.rejects(clone(mock, { copies: [{ sourceId: source.id, key: "existing" }] }), /Ключ уже существует/);
  assert.equal(mock.writes.length, 0);
});

test("клонирование не изменяет структуру оригиналов компонентов и экземпляров", async () => {
  const mock = createFigmaMock();
  const component = mock.make("COMPONENT");
  const child = mock.make("FRAME", {}, component);
  const instance = mock.make("INSTANCE");
  const nested = mock.make("FRAME", {}, instance);
  const source = mock.make("FRAME");
  for (const item of [{ sourceId: child.id, key: "a" }, { sourceId: nested.id, key: "b" }, { sourceId: source.id, parentId: component.id, key: "c" }]) {
    await assert.rejects(clone(mock, { copies: [item] }), (error) => { assert.equal(error.operationStatus, "not_applied"); return true; });
  }
});

test("перестановка нескольких узлов сохраняет ID и возвращает конечные индексы", async () => {
  const mock = createFigmaMock();
  const frame = mock.make("FRAME");
  const [a, b, c] = ["А", "Б", "В"].map((name) => mock.make("TEXT", { name }, frame));
  const result = await move(mock, { moves: [{ id: a.id, index: 2 }, { id: b.id, index: 1 }] });
  assert.deepEqual(frame.children, [c, b, a]);
  assert.deepEqual(result.moved.map((item) => item.index), [2, 1]);
  assert.equal(mock.nodes.get(a.id), a);
});

test("ошибка переноса восстанавливает порядок предыдущих перемещений", async () => {
  const mock = createFigmaMock();
  const frame = mock.make("FRAME");
  const target = mock.make("FRAME");
  const [a, b, c] = ["А", "Б", "В"].map((name) => mock.make("TEXT", { name }, frame));
  mock.rejectWrites((node, field, value) => node.id === target.id && field === "children" && value.includes(b));
  await assert.rejects(move(mock, { moves: [{ id: a.id, index: 2 }, { id: b.id, parentId: target.id }] }), (error) => { assert.equal(error.operationStatus, "rolled_back"); return true; });
  assert.deepEqual(frame.children, [a, b, c]);
  assert.equal(target.children.length, 0);
  assert.equal(b.parent, frame);
});

test("перенос отклоняет циклы, перемещение родителя с потомком и неправильный индекс", async () => {
  const mock = createFigmaMock();
  const parent = mock.make("FRAME");
  const child = mock.make("FRAME", {}, parent);
  const target = mock.make("FRAME");
  mock.writes.length = 0;
  for (const moves of [
    [{ id: parent.id, parentId: child.id }],
    [{ id: child.id, parentId: target.id }, { id: parent.id, parentId: target.id }],
    [{ id: child.id, index: 9 }],
  ]) await assert.rejects(move(mock, { moves }), (error) => { assert.equal(error.operationStatus, "not_applied"); return true; });
  assert.equal(mock.writes.length, 0);
});

test("Fill и координаты проверяются относительно нового Auto Layout родителя", async () => {
  const mock = createFigmaMock();
  const auto = mock.make("FRAME");
  const free = mock.make("FRAME", { layoutMode: "NONE" });
  const child = mock.make("FRAME", { layoutSizingHorizontal: "FILL" }, auto);
  await assert.rejects(move(mock, { moves: [{ id: child.id, parentId: free.id }] }), /Fill требует/);
  await assert.rejects(move(mock, { moves: [{ id: child.id, position: { x: 1, y: 2 } }] }), /через index/);
  const fixed = mock.make("FRAME", {}, auto);
  await move(mock, { moves: [{ id: fixed.id, parentId: free.id, position: { x: 12, y: 24 } }] });
  assert.equal(fixed.parent, free);
  assert.deepEqual([fixed.x, fixed.y], [12, 24]);
});

test("поиск компонентов по всему файлу не меняет страницу или выделение", async () => {
  const mock = createFigmaMock();
  const other = mock.make("PAGE", { name: "Библиотека" }, null);
  mock.figma.root.children.push(other);
  const button = mock.make("COMPONENT", { name: "Кнопка основная", key: "library-button", componentPropertyDefinitions: { State: { type: "VARIANT", defaultValue: "Default" } } }, other);
  mock.page.selection = [mock.make("FRAME")];
  const selection = mock.page.selection;
  mock.writes.length = 0;
  assert.equal((await find(mock, { kind: "components", query: "КНОПКА" })).total, 0);
  const result = await find(mock, { kind: "components", query: "КНОПКА", scope: "file" });
  assert.equal(result.items[0].id, button.id);
  assert.equal(result.items[0].libraryKey, "library-button");
  assert.equal(result.items[0].pageId, other.id);
  assert.equal(mock.figma.currentPage, mock.page);
  assert.equal(mock.page.selection, selection);
  assert.equal(mock.writes.length, 0);
});

test("поиск узлов возвращает последовательные страницы результатов", async () => {
  const mock = createFigmaMock();
  for (const name of ["Г", "А", "В", "Б"]) mock.make("TEXT", { name });
  mock.make("FRAME", { name: "А" });
  const first = await find(mock, { kind: "nodes", types: ["TEXT"], limit: 2 });
  const second = await find(mock, { kind: "nodes", types: ["TEXT"], limit: 2, offset: first.nextOffset });
  assert.equal(first.total, 4);
  assert.deepEqual([...first.items, ...second.items].map((item) => item.name), ["А", "Б", "В", "Г"]);
  assert.equal(second.hasMore, false);
});

test("каталог различает локальные стили, переменные и библиотечные метаданные", async () => {
  const mock = createFigmaMock();
  mock.styles.push({ id: "style", name: "Основной текст", type: "TEXT", fontSize: 16 });
  mock.addVariable({ id: "gap", name: "Отступы/Основной", value: 16 });
  mock.collections.push({ id: "collection", name: "Система", modes: [{ modeId: "default", name: "Светлая" }] });
  mock.libraryCollections.push({ key: "remote", name: "Внешняя" });
  mock.libraryVariables.set("remote", [{ key: "remote-gap", name: "Отступ", resolvedType: "FLOAT" }]);
  assert.equal((await find(mock, { kind: "styles", query: "текст" })).items[0].fontSize, 16);
  const variables = await find(mock, { kind: "variables" });
  assert.equal(variables.items[0].id, "gap");
  assert.equal(variables.collections[0].modes[0].name, "Светлая");
  assert.equal((await find(mock, { kind: "library_collections" })).items[0].key, "remote");
  assert.equal((await find(mock, { kind: "library_variables", collectionKey: "remote" })).items[0].key, "remote-gap");
  assert.equal(mock.variables.size, 1);
});

test("привязка SOLID paint сохраняет другие заливки и значения самой переменной", async () => {
  const mock = createFigmaMock();
  const variable = mock.addVariable({ id: "color", type: "COLOR", value: { r: 0, g: 1, b: 0, a: 1 } });
  const original = JSON.stringify(variable.valuesByMode);
  const image = { type: "IMAGE", imageHash: "image", scaleMode: "FILL" };
  const frame = mock.make("FRAME", { fills: [image, solid()] });
  await bind(mock, { bindings: [{ nodeId: frame.id, field: "fills", paintIndex: 1, variableId: "color" }] });
  assert.deepEqual(frame.fills[0], image);
  assert.equal(frame.fills[1].opacity, 0.7);
  assert.equal(frame.fills[1].boundVariables.color.id, "color");
  assert.equal(JSON.stringify(variable.valuesByMode), original);
});

test("проверка типа последней переменной предотвращает весь пакет", async () => {
  const mock = createFigmaMock();
  mock.addVariable({ id: "gap", value: 16 });
  mock.addVariable({ id: "wrong", type: "STRING", value: "нет" });
  const frame = mock.make("FRAME");
  mock.writes.length = 0;
  await assert.rejects(bind(mock, { bindings: [{ nodeId: frame.id, field: "itemSpacing", variableId: "gap" }, { nodeId: frame.id, field: "opacity", variableId: "wrong" }] }), /требует переменную типа FLOAT/);
  assert.equal(mock.writes.length, 0);
});

test("откат привязки восстанавливает старый alias и снимает новый при его отсутствии", async () => {
  const mock = createFigmaMock();
  mock.addVariable({ id: "old", value: 8 });
  mock.addVariable({ id: "new", value: 24 });
  mock.addVariable({ id: "width", value: 200 });
  mock.addVariable({ id: "opacity", value: 0.5 });
  const frame = mock.make("FRAME", { itemSpacing: 8, boundVariables: { itemSpacing: { type: "VARIABLE_ALIAS", id: "old" } } });
  const bad = mock.make("FRAME");
  mock.rejectWrites((node, field, value) => node.id === bad.id && field === "opacity" && value === 0.5);
  await assert.rejects(bind(mock, { bindings: [
    { nodeId: frame.id, field: "itemSpacing", variableId: "new" },
    { nodeId: frame.id, field: "width", variableId: "width" },
    { nodeId: bad.id, field: "opacity", variableId: "opacity" },
  ] }), (error) => { assert.equal(error.operationStatus, "rolled_back"); return true; });
  assert.equal(frame.itemSpacing, 8);
  assert.equal(frame.boundVariables.itemSpacing.id, "old");
  assert.equal(frame.boundVariables.width, undefined);
  assert.equal(frame.width, 100);
  assert.equal(bad.boundVariables.opacity, undefined);
});

test("откат цветовой привязки восстанавливает весь массив paint и стиль", async () => {
  const mock = createFigmaMock();
  mock.addVariable({ id: "color", type: "COLOR", value: { r: 0, g: 1, b: 0, a: 1 } });
  mock.addVariable({ id: "opacity", value: 0.5 });
  const paints = [solid(), { ...solid(0), boundVariables: { color: { type: "VARIABLE_ALIAS", id: "old-color" } } }];
  const frame = mock.make("FRAME", { fills: paints, fillStyleId: "old-style" });
  mock.rejectWrites((_node, field, value) => field === "opacity" && value === 0.5);
  await assert.rejects(bind(mock, { bindings: [{ nodeId: frame.id, field: "fills", variableId: "color", paintIndex: 1 }, { nodeId: frame.id, field: "opacity", variableId: "opacity" }] }), /Injected write failure/);
  assert.deepEqual(frame.fills, paints);
  assert.equal(frame.fillStyleId, "old-style");
});

test("снятие привязки оставляет текущее значение", async () => {
  const mock = createFigmaMock();
  mock.addVariable({ id: "gap", value: 16 });
  const frame = mock.make("FRAME", { itemSpacing: 16, boundVariables: { itemSpacing: { type: "VARIABLE_ALIAS", id: "gap" } } });
  await bind(mock, { bindings: [{ nodeId: frame.id, field: "itemSpacing", variableId: null }] });
  assert.equal(frame.boundVariables.itemSpacing, undefined);
  assert.equal(frame.itemSpacing, 16);
});

test("числовые значения проверяются в режиме целевого узла", async () => {
  const mock = createFigmaMock();
  mock.addVariable({ id: "size", valuesByMode: { light: 100, dark: -1 } });
  const frame = mock.make("FRAME", { explicitVariableModes: { collection: "dark" } });
  await assert.rejects(bind(mock, { bindings: [{ nodeId: frame.id, field: "width", variableId: "size" }] }), /несовместимо/);
});

test("привязка к оригиналу компонента требует явного флага подтверждения", async () => {
  const mock = createFigmaMock();
  mock.addVariable({ id: "size", value: 20 });
  const component = mock.make("COMPONENT");
  const text = mock.make("TEXT", {}, component);
  const input = { bindings: [{ nodeId: text.id, field: "fontSize", variableId: "size" }] };
  await assert.rejects(bind(mock, input), /allowComponentChanges/);
  assert.equal(text.fontSize, 14);
  await bind(mock, { ...input, allowComponentChanges: true });
  assert.equal(text.fontSize, 20);
});

test("схемы запрещают неоднозначные действия и повторяющиеся цели", () => {
  assert.equal(cloneNodesSchema.safeParse({ copies: [{ sourceId: "a", key: "same" }, { sourceId: "b", key: "same" }] }).success, false);
  assert.equal(moveNodesSchema.safeParse({ moves: [{ id: "a", index: 1 }, { id: "a", index: 0 }] }).success, false);
  assert.equal(findAssetsSchema.safeParse({ kind: "library_variables" }).success, false);
  assert.equal(bindVariablesSchema.safeParse({ bindings: [{ nodeId: "a", field: "opacity", variableId: "v", paintIndex: 0 }] }).success, false);
  const item = { nodeId: "a", field: "fills", variableId: "v" };
  assert.equal(bindVariablesSchema.safeParse({ bindings: [item, { ...item, paintIndex: 0 }] }).success, false);
});
