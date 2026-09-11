import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";
import { buildInspectCode, buildPatchCode, buildRenderCode } from "../src/figma-code.mjs";
import { buildFindAssetsCode } from "../src/asset-catalog.mjs";
import { normalizeScreenSpec } from "../src/schemas.mjs";
import { createFigmaMock } from "./helpers/figma-mock.mjs";

async function executionHandler(figma, globals = {}) {
  const source = await readFile(new URL("../src/figma-plugin/code.js", import.meta.url), "utf8");
  const start = source.indexOf("var executeCodeQueue = Promise.resolve();");
  const end = source.indexOf("\n  // ============================================================================\n  // UPDATE_VARIABLE", start);
  assert.ok(start > 0 && end > start);
  const messages = [];
  const listeners = new Map();
  figma.ui = { postMessage(message) {
    messages.push(message);
    if (message.type === "EXECUTE_CODE_RESULT") listeners.get(message.requestId)?.(message);
  } };
  vm.runInNewContext(source.slice(start, end) + "\n};", {
    figma, setTimeout, clearTimeout, console: { log() {}, warn() {}, error() {} }, ...globals,
  });
  return {
    messages,
    result(id) { return new Promise((resolve) => listeners.set(id, resolve)); },
    run(id, code, timeout = 1000, extra = {}) { return figma.ui.onmessage({ type: "EXECUTE_CODE", requestId: id, code, timeout, ...extra }); },
    async probe() {
      await figma.ui.onmessage({ type: 'GET_EXECUTION_STATUS', requestId: 'probe' });
      return messages.filter(msg => msg.type === 'GET_EXECUTION_STATUS_RESULT').at(-1);
    },
  };
}

test("тайм-аут не освобождает очередь до завершения выполняющегося кода", async () => {
  const mock = createFigmaMock();
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const events = [];
  const handler = await executionHandler(mock.figma, { gate, events });
  const timedOut = handler.result("first");
  const first = handler.run("first", 'events.push("first-start"); await gate; if (executionControl.cancelled) throw new Error("Cancelled"); events.push("late-write");', 5);
  const second = handler.run("second", 'events.push("second"); return 2;');
  try {
    assert.equal((await timedOut).operationStatus, "unknown");
    assert.equal((await handler.probe()).busy, true, 'probe не ждёт завершения зависшей операции');
    assert.deepEqual(events, ["first-start"]);
  } finally {
    release();
    await Promise.all([first, second]);
  }
  assert.deepEqual(events, ["first-start", "second"]);
  assert.equal((await handler.probe()).busy, false);
  assert.equal(handler.messages.find((message) => message.requestId === "second" && message.type === "EXECUTE_CODE_RESULT").success, true);
  assert.deepEqual(handler.messages.filter((message) => message.type === "OPERATION_PROGRESS").map((message) => [message.requestId, message.state]), [["first", "queued"], ["second", "queued"], ["first", "running"], ["second", "running"]]);
});

test('команда, задержавшаяся до приёма Plugin API, не выполняется после активации вкладки', async () => {
  const mock = createFigmaMock();
  const events = [];
  const handler = await executionHandler(mock.figma, { events, Date: { now: () => 2000 } });
  await handler.run('suspended', 'events.push("late-write"); return 1;', 1000, { expiresAt: 1999 });
  assert.deepEqual(events, []);
  const result = handler.messages.find(msg => msg.type === 'EXECUTE_CODE_RESULT');
  assert.equal(result.operationStatus, 'not_applied');
  assert.equal((await handler.probe()).busy, false);
});

test('ошибка preflight сохраняет структурированную причину и освобождает очередь', async () => {
  const mock = createFigmaMock();
  const details = { operationStatus: 'not_applied', code: 'FONT_LOAD_TIMEOUT',
    nextStep: 'Проверьте доступность шрифта', fileKey: 'guide',
    blockers: [{ type: 'font', family: 'Factor IO', style: 'Bold' }], rollbackErrors: [] };
  const handler = await executionHandler(mock.figma, { details });
  await handler.run('preflight', 'throw Object.assign(new Error("Шрифт недоступен"), details);');
  const result = handler.messages.find(message => message.type === 'EXECUTE_CODE_RESULT');
  for (const [key, value] of Object.entries(details)) assert.deepEqual(result[key], value);
  assert.equal(result.success, false);
  assert.equal((await handler.probe()).busy, false);
});

test("сгенерированный патч после тайм-аута на загрузке шрифта не пишет в макет", async () => {
  const mock = createFigmaMock();
  const text = mock.make("TEXT");
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  mock.figma.loadFontAsync = () => gate;
  mock.writes.length = 0;
  const handler = await executionHandler(mock.figma);
  const timedOut = handler.result("patch");
  const operation = handler.run("patch", buildPatchCode({ patches: [{ id: text.id, set: { content: "Новый текст" } }], ignoreMissing: false }), 5);
  try {
    assert.equal((await timedOut).operationStatus, "unknown");
  } finally {
    release();
    await operation;
  }
  assert.equal(text.characters, "Текст");
  assert.equal(mock.writes.length, 0);
});

test("просроченная команда в очереди не выполняется позднее", async () => {
  const mock = createFigmaMock();
  let now = 0;
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const events = [];
  const handler = await executionHandler(mock.figma, { gate, events, Date: { now: () => now } });
  const first = handler.run("first", "await gate; return 1;", 1000);
  const second = handler.run("expired", 'events.push("late-write"); return 2;', 5);
  await Promise.resolve();
  now = 10;
  release();
  await Promise.all([first, second]);
  assert.deepEqual(events, []);
  assert.equal(handler.messages.find((message) => message.requestId === "expired" && message.type === "EXECUTE_CODE_RESULT").operationStatus, "not_applied");
  assert.equal(handler.messages.some((message) => message.requestId === "expired" && message.state === "running"), false);
});

for (const stage of ['load', 'list']) test(`зависание службы шрифтов (${stage}) завершается до записи и освобождает очередь`, async () => {
  const mock = createFigmaMock();
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  mock.figma.loadFontAsync = stage === 'load' ? () => gate : async () => { throw new Error('font service failed'); };
  mock.figma.listAvailableFontsAsync = () => gate;
  const handler = await executionHandler(mock.figma, {
    // Compress only the font service budget; retain the outer execution watchdog.
    setTimeout: (fn, ms) => setTimeout(fn, ms === 8000 ? 5 : ms),
  });
  const spec = normalizeScreenSpec({ key: 'cover', name: 'Обложка', type: 'screen', width: 1440, height: 900,
    nodes: [{ type: 'text', key: 'title', name: 'Название', content: 'Layouts & Grid', fontFamily: 'Factor IO', fontStyle: 'Bold' }] });
  const result = handler.result('font');
  const operation = handler.run('font', buildRenderCode({ spec }), 1000);
  try {
    const response = await result;
    assert.equal(response.operationStatus, 'not_applied');
    assert.match(response.error, /Factor IO.*Bold/);
    await new Promise(resolve => setImmediate(resolve));
    assert.equal((await handler.probe()).busy, false);
    assert.equal(mock.figma.currentPage.children.length, 0);
  } finally {
    release([]);
    await operation;
  }
  assert.equal(mock.figma.currentPage.children.length, 0, 'late font completion cannot resume the abandoned render');
});

for (const kind of ['library_collections', 'library_variables', 'variables', 'styles', 'node']) {
  test(`${kind}: зависшее чтение освобождает очередь без позднего продолжения`, async () => {
    const mock = createFigmaMock();
    let release;
    const gate = new Promise(resolve => { release = resolve; });
    mock.figma.teamLibrary = {
      getAvailableLibraryVariableCollectionsAsync: () => gate,
      getVariablesInLibraryCollectionAsync: () => gate,
    };
    mock.figma.variables.getLocalVariablesAsync = () => gate;
    mock.figma.getLocalPaintStylesAsync = () => gate;
    mock.figma.getNodeByIdAsync = () => gate;
    const handler = await executionHandler(mock.figma, {
      setTimeout: (fn, ms) => setTimeout(fn, ms === 6000 ? 5 : ms),
    });
    const code = kind === 'node'
      ? buildInspectCode({ nodeId: '1:99', depth: 1, maxNodes: 20 })
      : buildFindAssetsCode({ kind, collectionKey: 'collection' });
    const response = handler.result('read');
    const running = handler.run('read', code, 200);
    try {
      const result = await response;
      assert.equal(result.code, 'FIGMA_READ_TIMEOUT');
      assert.equal(result.operationStatus, 'not_applied');
      await new Promise(resolve => setImmediate(resolve));
      assert.equal((await handler.probe()).busy, false);
      await handler.run('next', 'return 42;');
      assert.equal(handler.messages.find(m => m.requestId === 'next' && m.success).result, 42);
    } finally {
      release([]);
      await running;
    }
    assert.equal(mock.figma.currentPage.children.length, 0);
    assert.equal(handler.messages.filter(m => m.type === 'EXECUTE_CODE_RESULT' && m.requestId === 'read').length, 1);
  });
}

test('probe сообщает имя и возраст выполняющейся операции только своего файла', async () => {
  const mock = createFigmaMock();
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const handler = await executionHandler(mock.figma, { gate });
  const running = handler.run('library', 'await gate;', 1000, { operation: { name: 'find_assets', mutating: false } });
  try {
    await new Promise(resolve => setImmediate(resolve));
    const status = await handler.probe();
    assert.equal(status.activeOperation.name, 'find_assets');
    assert.equal(status.activeOperation.mutating, false);
    assert.ok(status.activeOperation.elapsedMs >= 0);
  } finally { release(); await running; }
  assert.equal((await handler.probe()).activeOperation, null);
});
