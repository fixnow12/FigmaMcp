import test from "node:test";
import assert from "node:assert/strict";
import * as schemas from "../src/operation-schemas.mjs";
import { createFigmaMock, executeGenerated } from "./helpers/figma-mock.mjs";
import { buildInspectCode } from "../src/figma-code.mjs";

const url = { type: "URL", value: "https://example.com/help" };
const back = { trigger: { type: "ON_CLICK" }, actions: [{ type: "BACK" }] };
async function run(mock, kind, input) {
  const schema = schemas[kind === "links" ? "setTextLinksSchema" : "setReactionsSchema"];
  assert.ok(schema, "Типизированная операция должна быть опубликована");
  const builders = await import("../src/interactions.mjs");
  return executeGenerated(mock.figma, builders[kind === "links" ? "buildSetTextLinksCode" : "buildSetReactionsCode"](schema.parse(input)));
}
function textNode(mock, characters = "Помощь и условия") {
  const node = mock.make("TEXT", { characters });
  // Model actual per-character hyperlink ranges, keeping unrelated typography intact.
  let links = Array.from({ length: characters.length }, () => null);
  node.getStyledTextSegments = (fields) => {
    const segments = [];
    for (let start = 0; start < links.length;) {
      let end = start + 1;
      while (end < links.length && JSON.stringify(links[end]) === JSON.stringify(links[start])) end++;
      segments.push({ start, end, ...Object.fromEntries(fields.map(field => [field, field === "hyperlink" ? links[start] : node[field]])) });
      start = end;
    }
    return segments;
  };
  node.setRangeHyperlink = (start, end, value) => { node.hyperlink = value; for (let i = start; i < end; i++) links[i] = value; };
  node.linkAt = (index) => links[index];
  return node;
}
function hotspot(mock, parent = mock.make("FRAME")) {
  return mock.make("RECTANGLE", { reactions: [], async setReactionsAsync(value) { this.reactions = value; } }, parent);
}
const navigate = (id) => ({ trigger: { type: "ON_CLICK" }, actions: [{ type: "NODE", navigation: "NAVIGATE", destinationId: id, transition: null }] });

// Exact reaction shape from iomoney-figma.json, message 66, inspect node 16:26.
const exportedNavigate = [{
  action: { type: "NODE", destinationId: "16:72", navigation: "NAVIGATE", transition: null, resetVideoPosition: false },
  actions: [{ type: "NODE", destinationId: "16:72", navigation: "NAVIGATE", transition: null, resetVideoPosition: false }],
  trigger: { type: "ON_CLICK" },
}];
function exportedHotspot(mock) {
  mock.make("FRAME", { id: "16:72" });
  return mock.make("TEXT", {
    id: "16:26", reactions: [],
    async setReactionsAsync(value) {
      // External Plugin API materializes an omitted default and legacy action.
      this.reactions = value.map(reaction => {
        const actions = reaction.actions.map(action => action.type === "NODE"
          ? { resetVideoPosition: false, ...action } : { ...action });
        return { action: actions[0], actions, trigger: reaction.trigger };
      });
    },
  }, mock.make("FRAME"));
}
const exportedInput = { nodeId: "16:26", reactions: [{
  actions: [{ destinationId: "16:72", navigation: "NAVIGATE", type: "NODE" }], trigger: { type: "ON_CLICK" },
}] };

test("NAVIGATE из экспорта завершает пакет и повтор при добавленном Figma resetVideoPosition:false", async () => {
  const mock = createFigmaMock(); const first = exportedHotspot(mock); const second = hotspot(mock);
  const input = { updates: [exportedInput, { nodeId: second.id, reactions: [back] }] };
  for (let attempt = 0; attempt < 2; attempt++) {
    const result = await run(mock, "reactions", input);
    assert.deepEqual(result.mutatedNodeIds, ["16:26", second.id]);
    assert.deepEqual(result.updates[0].reactions, exportedNavigate);
    assert.deepEqual(first.reactions, exportedNavigate);
    assert.deepEqual(second.reactions, [back]);
  }
});

test("нормализованный NAVIGATE откатывается после отказа setter или следующего узла", async () => {
  for (const failureAt of ["first", "second"]) {
    const mock = createFigmaMock(); const first = exportedHotspot(mock); const second = hotspot(mock);
    const setter = first.setReactionsAsync;
    first.setReactionsAsync = async function(value) {
      await setter.call(this, value);
      if (failureAt === "first" && value.length) throw new Error("Отказ после записи");
    };
    second.setReactionsAsync = async function() { throw new Error("Следующий узел не записан"); };
    await assert.rejects(run(mock, "reactions", { updates: [exportedInput, { nodeId: second.id, reactions: [back] }] }),
      error => error.operationStatus === "rolled_back" && error.rollbackErrors.length === 0);
    assert.deepEqual(first.reactions, []);
    assert.deepEqual(second.reactions, []);
  }
});

test("нормализация default не скрывает конкурентные изменения действия NAVIGATE", async () => {
  for (const change of [{ resetVideoPosition: true }, { destinationId: "other" }, { unknownOption: false }]) {
    const mock = createFigmaMock(); const node = exportedHotspot(mock);
    const external = structuredClone(exportedNavigate);
    Object.assign(external[0].actions[0], change);
    Object.assign(external[0].action, change);
    node.setReactionsAsync = async function() { await Promise.resolve(); this.reactions = external; };
    await assert.rejects(run(mock, "reactions", { updates: [exportedInput] }),
      error => error.operationStatus === "partial" && error.rollbackErrors.length === 1);
    assert.deepEqual(node.reactions, external);
  }
});

test("ручная правка во время ожидания setter не становится значением для отката", async () => {
  const mock = createFigmaMock(); const a = hotspot(mock); const b = hotspot(mock);
  const external = [{ trigger: { type: "ON_HOVER" }, actions: [{ type: "CLOSE" }] }];
  a.setReactionsAsync = async function(value) {
    this.reactions = value;
    if (value.length) { await Promise.resolve(); this.reactions = external; }
  };
  b.setReactionsAsync = async function() { throw new Error("Второй переход не записан"); };
  await assert.rejects(run(mock, "reactions", { updates: [a, b].map(node => ({ nodeId: node.id, reactions: [back] })) }), e => e.operationStatus === "partial");
  assert.deepEqual(a.reactions, external);
});

test("пакет проверяет ранние переходы после ожидания последнего setter", async () => {
  const mock = createFigmaMock(); const a = hotspot(mock); const b = hotspot(mock);
  const external = [{ trigger: { type: "ON_HOVER" }, actions: [{ type: "CLOSE" }] }];
  b.setReactionsAsync = async function(value) {
    this.reactions = value;
    if (value.length) { await Promise.resolve(); a.reactions = external; }
  };
  await assert.rejects(run(mock, "reactions", { updates: [a, b].map(node => ({ nodeId: node.id, reactions: [back] })) }), e => e.operationStatus === "partial");
  assert.deepEqual(a.reactions, external);
  assert.deepEqual(b.reactions, []);
});

test("откат учитывает устаревшее поле action и порядок полей в ответе Figma", async () => {
  const mock = createFigmaMock(); const node = hotspot(mock);
  node.setReactionsAsync = async function(value) {
    this.reactions = value.map(r => ({ actions: r.actions, action: r.actions[0], trigger: r.trigger }));
    if (value.length) throw new Error("Сбой после записи");
  };
  await assert.rejects(run(mock, "reactions", { updates: [{ nodeId: node.id, reactions: [back] }] }), e => e.operationStatus === "rolled_back");
  assert.deepEqual(node.reactions, []);
});

test("откат сообщает partial, если внешний переход появился во время восстановления", async () => {
  const mock = createFigmaMock(); const a = hotspot(mock); const b = hotspot(mock);
  const external = [{ trigger: { type: "ON_HOVER" }, actions: [{ type: "CLOSE" }] }];
  a.setReactionsAsync = async function(value) {
    this.reactions = value;
    if (!value.length) { await Promise.resolve(); this.reactions = external; }
  };
  b.setReactionsAsync = async function() { throw new Error("Не удалось записать второй узел"); };
  await assert.rejects(run(mock, "reactions", { updates: [a, b].map(node => ({ nodeId: node.id, reactions: [back] })) }), e => e.operationStatus === "partial" && e.rollbackErrors.length === 1);
  assert.deepEqual(a.reactions, external);
});

test("ссылки диапазонов добавляются, читаются и удаляются без изменения текста и шрифта", async () => {
  const mock = createFigmaMock(); const node = textNode(mock);
  const result = await run(mock, "links", { links: [{ nodeId: node.id, start: 0, end: 6, target: url }] });
  assert.deepEqual(node.linkAt(0), url); assert.equal(node.linkAt(7), null);
  assert.equal(node.characters, "Помощь и условия"); assert.equal(node.fontSize, 14);
  assert.deepEqual(result.links[0].hyperlinks[0], { start: 0, end: 6, hyperlink: url });
  const inspected = await executeGenerated(mock.figma, buildInspectCode({ nodeId: node.id, depth: 0, maxNodes: 1, detail: "full" }));
  assert.deepEqual(inspected.selection[0].hyperlinks, result.links[0].hyperlinks);
  await run(mock, "links", { links: [{ nodeId: node.id, target: null }] });
  assert.equal(node.linkAt(0), null);
});

test("некорректный диапазон последнего элемента предотвращает весь пакет", async () => {
  const mock = createFigmaMock(); const a = textNode(mock); const b = textNode(mock);
  mock.writes.length = 0;
  await assert.rejects(run(mock, "links", { links: [{ nodeId: a.id, target: url }, { nodeId: b.id, start: 0, end: 999, target: url }] }), e => e.operationStatus === "not_applied");
  assert.equal(mock.writes.length, 0);
});

test("ошибка записи восстанавливает все исходные смешанные ссылки", async () => {
  const mock = createFigmaMock(); const a = textNode(mock); const b = textNode(mock);
  a.setRangeHyperlink(2, 4, url);
  const before = a.getStyledTextSegments(["hyperlink"]);
  mock.rejectWrites((node, field, value) => node.id === b.id && field === "hyperlink" && value?.value === "https://new.example");
  await assert.rejects(run(mock, "links", { links: [a, b].map(node => ({ nodeId: node.id, target: { type: "URL", value: "https://new.example" } })) }), e => e.operationStatus === "rolled_back");
  assert.deepEqual(a.getStyledTextSegments(["hyperlink"]), before);
});

test("ссылки на узлы проверяют существование и запрещают цель внутри экземпляра", async () => {
  const mock = createFigmaMock(); const text = textNode(mock);
  const nested = mock.make("FRAME", {}, mock.make("INSTANCE"));
  for (const value of ["missing", nested.id]) await assert.rejects(run(mock, "links", { links: [{ nodeId: text.id, target: { type: "NODE", value } }] }), e => e.operationStatus === "not_applied");
  const destination = mock.make("FRAME");
  await run(mock, "links", { links: [{ nodeId: text.id, target: { type: "NODE", value: destination.id } }] });
  assert.equal(text.linkAt(0).value, destination.id);
});

test("переходы добавляются без потери других триггеров; повторный вызов не создаёт дубли", async () => {
  const mock = createFigmaMock(); const node = hotspot(mock); const dest = mock.make("FRAME");
  const hover = { trigger: { type: "ON_HOVER" }, actions: [{ type: "URL", url: "https://example.com" }] };
  node.reactions = [hover, back];
  const input = { updates: [{ nodeId: node.id, reactions: [navigate(dest.id)] }] };
  await run(mock, "reactions", input); await run(mock, "reactions", input);
  assert.deepEqual(node.reactions, [hover, navigate(dest.id)]);
  const inspected = await executeGenerated(mock.figma, buildInspectCode({ nodeId: node.id, depth: 0, maxNodes: 1, detail: "full" }));
  assert.deepEqual(inspected.selection[0].reactions, node.reactions);
  await run(mock, "reactions", { updates: [{ nodeId: node.id, mode: "replace", reactions: [] }] });
  assert.deepEqual(node.reactions, []);
});

test("переход в тот же экран, вложенный фрейм или другую страницу отклоняется до записи", async () => {
  const mock = createFigmaMock(); const node = hotspot(mock);
  const nested = mock.make("FRAME", {}, node.parent);
  const other = mock.make("FRAME", {}, mock.make("PAGE", {}, null));
  for (const id of [node.parent.id, nested.id, other.id, "missing"]) {
    await assert.rejects(run(mock, "reactions", { updates: [{ nodeId: node.id, reactions: [navigate(id)] }] }), e => e.operationStatus === "not_applied");
  }
  assert.deepEqual(node.reactions, []);
});

test("сбой второго перехода откатывает первый; сбой отката возвращает partial", async () => {
  for (const partial of [false, true]) {
    const mock = createFigmaMock(); const a = hotspot(mock); const b = hotspot(mock);
    mock.rejectWrites((node, field, value) => field === "reactions" && ((node.id === b.id && value.length) || (partial && node.id === a.id && !value.length)));
    await assert.rejects(run(mock, "reactions", { updates: [a, b].map(node => ({ nodeId: node.id, reactions: [back] })) }), e => e.operationStatus === (partial ? "partial" : "rolled_back"));
    if (!partial) assert.deepEqual(a.reactions, []);
  }
});

test("dryRun и защита компонентов действуют для обеих команд", async () => {
  const mock = createFigmaMock(); const text = textNode(mock); const node = hotspot(mock, mock.make("COMPONENT"));
  const updates = [{ nodeId: node.id, reactions: [back] }];
  await assert.rejects(run(mock, "reactions", { updates }), /allowComponentChanges/);
  mock.writes.length = 0;
  assert.equal((await run(mock, "reactions", { updates, allowComponentChanges: true, dryRun: true })).dryRun, true);
  assert.equal((await run(mock, "links", { links: [{ nodeId: text.id, target: url }], dryRun: true })).dryRun, true);
  assert.equal(mock.writes.length, 0);
});

test("изменение текста во время проверки не перезаписывается", async () => {
  const mock = createFigmaMock(); const node = textNode(mock); const dest = mock.make("FRAME");
  const lookup = mock.figma.getNodeByIdAsync;
  mock.figma.getNodeByIdAsync = async id => { if (id === dest.id) node.characters = "Изменено"; return lookup(id); };
  await assert.rejects(run(mock, "links", { links: [{ nodeId: node.id, target: { type: "NODE", value: dest.id } }] }), e => e.operationStatus === "not_applied");
  assert.equal(node.characters, "Изменено"); assert.equal(node.linkAt(0), null);
});

test("схемы отклоняют неизвестные действия, опасные URL и неоднозначные диапазоны", () => {
  assert.ok(schemas.setTextLinksSchema); assert.ok(schemas.setReactionsSchema);
  for (const links of [
    [{ nodeId: "x", target: { type: "URL", value: "javascript:alert(1)" } }],
    [{ nodeId: "x", start: 0, target: url }],
    [{ nodeId: "x", start: 1, end: 1, target: url }],
    [{ nodeId: "x", target: url }, { nodeId: "x", target: null }],
  ]) assert.equal(schemas.setTextLinksSchema.safeParse({ links }).success, false);
  assert.equal(schemas.setReactionsSchema.safeParse({ updates: [{ nodeId: "x", reactions: [{ ...back, actions: [{ type: "EVAL", code: "1" }] }] }] }).success, false);
  assert.equal(schemas.setReactionsSchema.safeParse({ updates: [{ nodeId: "x", reactions: [] }] }).success, false);
});

test("оверлей с анимацией и прокрутка сохраняют параметры; блок другой страницы запрещён", async () => {
  const mock = createFigmaMock(); const node = hotspot(mock); const dest = mock.make("FRAME", {}, mock.make("SECTION"));
  const overlay = navigate(dest.id); overlay.actions[0].navigation = "OVERLAY";
  overlay.actions[0].transition = { type: "DISSOLVE", duration: 0.3, easing: { type: "EASE_OUT" } };
  await run(mock, "reactions", { updates: [{ nodeId: node.id, reactions: [overlay] }] });
  assert.deepEqual(node.reactions, [overlay]);
  const target = mock.make("RECTANGLE", {}, node.parent);
  const scroll = navigate(target.id); scroll.actions[0].navigation = "SCROLL_TO";
  await run(mock, "reactions", { updates: [{ nodeId: node.id, reactions: [scroll] }] });
  assert.deepEqual(node.reactions, [scroll]);
  scroll.actions[0].destinationId = dest.id;
  await assert.rejects(run(mock, "reactions", { updates: [{ nodeId: node.id, reactions: [scroll] }] }), e => e.operationStatus === "not_applied");
});

test("два диапазона одного текста, UTF-16 и защита текстов компонента", async () => {
  const mock = createFigmaMock(); const node = textNode(mock, "А😀БВ");
  await assert.rejects(run(mock, "links", { links: [{ nodeId: node.id, start: 1, end: 2, target: url }] }), /UTF-16/);
  await run(mock, "links", { links: [{ nodeId: node.id, start: 1, end: 3, target: url }, { nodeId: node.id, start: 4, end: 5, target: url }] });
  assert.deepEqual(node.linkAt(1), url); assert.equal(node.linkAt(3), null); assert.deepEqual(node.linkAt(4), url);
  mock.make("COMPONENT").appendChild(node);
  await assert.rejects(run(mock, "links", { links: [{ nodeId: node.id, target: null }] }), /allowComponentChanges/);
});

test("удаление цели и смена переходов во время подготовки предотвращают запись", async () => {
  for (const change of ["target", "source"]) {
    const mock = createFigmaMock(); const node = hotspot(mock); const first = mock.make("FRAME"); const second = mock.make("FRAME");
    const lookup = mock.figma.getNodeByIdAsync;
    mock.figma.getNodeByIdAsync = async id => {
      if (id === second.id) { if (change === "target") first.remove(); else node.reactions = [back]; }
      return lookup(id);
    };
    const hover = navigate(second.id); hover.trigger.type = "ON_HOVER";
    await assert.rejects(run(mock, "reactions", { updates: [{ nodeId: node.id, reactions: [navigate(first.id), hover] }] }), e => e.operationStatus === "not_applied");
    assert.deepEqual(node.reactions, change === "source" ? [back] : []);
  }
});

test("откат не стирает конкурентные реакции и не пишет узел, перенесённый в компонент", async () => {
  for (const change of ["reactions", "component"]) {
    const mock = createFigmaMock(); const a = hotspot(mock); const b = hotspot(mock);
    const external = [{ trigger: { type: "ON_HOVER" }, actions: [{ type: "URL", url: "https://external.example" }] }];
    b.setReactionsAsync = async function(value) {
      if (value.length) {
        if (change === "reactions") a.reactions = external;
        else mock.make("COMPONENT").appendChild(a);
        throw new Error("Второй узел не записан");
      }
      this.reactions = value;
    };
    await assert.rejects(run(mock, "reactions", { updates: [a, b].map(node => ({ nodeId: node.id, reactions: [back] })) }), e => e.operationStatus === "partial" && e.rollbackErrors.length === 1);
    assert.deepEqual(a.reactions, change === "reactions" ? external : [back]);
  }
});

test("отмена после записи запускает откат несмотря на истёкший executionControl", async () => {
  const mock = createFigmaMock(); const node = hotspot(mock);
  mock.figma.executionControl = { cancelled: false };
  node.setReactionsAsync = async function(value) { this.reactions = value; mock.figma.executionControl.cancelled = true; };
  const { buildSetReactionsCode } = await import("../src/interactions.mjs");
  const code = buildSetReactionsCode(schemas.setReactionsSchema.parse({ updates: [{ nodeId: node.id, reactions: [back] }] }));
  await assert.rejects(executeGenerated(mock.figma, "const executionControl = figma.executionControl;\n" + code), e => e.operationStatus === "rolled_back");
  assert.deepEqual(node.reactions, []);
});
