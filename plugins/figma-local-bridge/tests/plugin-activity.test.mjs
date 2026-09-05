import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";

// Exercise the real sender, activity wrapper and response relay, without network or Figma writes.
async function activityUI() {
  const source = await readFile(new URL("../figma-plugin/ui.html", import.meta.url), "utf8");
  class Element {
    children = []; dataset = {}; style = {}; textContent = ""; fields = new Map();
    get lastElementChild() { return this.children.at(-1); }
    set innerHTML(value) { this.html = value; for (const match of value.matchAll(/class="([^"]+)"/g)) this.fields.set("." + match[1], new Element()); }
    querySelector(key) { return this.fields.get(key); }
    appendChild(child) { this.children.push(child); }
    removeChild(child) { this.children.splice(this.children.indexOf(child), 1); }
    select() {}
  }
  const elements = new Map(["log-entries", "cta-btn", "operation-summary", "operation-context", "operation-queue"].map((id) => [id, new Element()]));
  const sent = [], timers = new Map();
  let counter = 0, now = 1000, clipboard = "";
  class Clock extends Date { constructor() { super(now); } static now() { return now; } }
  const document = {
    getElementById: (id) => elements.get(id), createElement: () => new Element(), body: new Element(),
    execCommand: () => { clipboard = document.body.lastElementChild.value; return true; },
  };
  const context = vm.createContext({ window: { __figmaPendingRequests: new Map() }, document,
    parent: { postMessage: (message) => sent.push(message.pluginMessage) }, console: { log() {} }, Date: Clock,
    setTimeout(fn) { timers.set(++counter, fn); return counter; }, clearTimeout: (id) => timers.delete(id),
    setInterval() { return 1; }, clearInterval() {}, deriveAndRenderStatus() {},
  });
  const sender = source.slice(source.indexOf("    window.sendPluginCommand ="), source.indexOf("    // VARIABLE OPERATIONS"));
  const activity = source.slice(source.indexOf("    var PLUGIN_VERSION ="), source.indexOf("    // Plugin update banner —"));
  const handler = source.slice(source.indexOf("    window.onmessage ="), source.indexOf("  </script>"));
  const connection = source.slice(source.indexOf("    // Real Pause / Resume:"), source.indexOf("    // Periodic reconcile of CTA"));
  vm.runInContext("var requestIdCounter = 0;\n" + sender + activity + connection + handler, context);
  return {
    context, elements, sent,
    call: (name = "patch_nodes", mutating = true) => context.window.sendPluginCommand("EXECUTE_CODE", { code: "figma.createFrame(); node.remove();", operation: { name, mutating, fileName: "Файл", pageName: "Страница" } }),
    message: (msg) => context.window.onmessage({ data: { pluginMessage: msg } }),
    advance(ms) { now += ms; },
    timeout() { for (const callback of [...timers.values()]) callback(); },
    clipboard: () => clipboard,
  };
}

test("название приходит из метаданных; одинаковые параллельные команды имеют независимые строки", async () => {
  const ui = await activityUI();
  const first = ui.call(), second = ui.call();
  assert.equal(ui.elements.get("log-entries").children.length, 2);
  assert.match(ui.elements.get("operation-queue").textContent, /2/);
  assert.equal(ui.context.logHistory[0].message, "Изменение слоёв — В очереди");
  ui.message({ type: "OPERATION_PROGRESS", requestId: ui.sent[0].requestId, state: "running" });
  assert.equal(ui.elements.get("operation-summary").textContent, "Изменение слоёв — Выполняется");
  ui.advance(1500);
  ui.message({ type: "EXECUTE_CODE_RESULT", requestId: ui.sent[0].requestId, success: true, result: {} });
  await first;
  assert.equal(ui.context.logHistory[0].message, "Изменение слоёв — Готово");
  assert.equal(ui.context.logHistory[1].message, "Изменение слоёв — В очереди");
  ui.message({ type: "EXECUTE_CODE_RESULT", requestId: ui.sent[1].requestId, success: false, operationStatus: "rolled_back", error: "SVG" });
  await second;
  assert.equal(ui.context.logHistory[1].message, "Изменение слоёв — Изменения отменены");
  ui.context.copyLogToClipboard();
  assert.match(ui.clipboard(), /Готово.*Файл · Страница.*1500 мс/);
  assert.match(ui.clipboard(), /Изменения отменены/);
});

test("неполный откат и неизвестный результат не показываются как успех", async () => {
  for (const status of ["partial", "unknown", "not_applied"]) {
    const ui = await activityUI();
    const pending = ui.call();
    ui.message({ type: "EXECUTE_CODE_RESULT", requestId: ui.sent[0].requestId, success: false, operationStatus: status });
    await pending;
    assert.notEqual(ui.context.logHistory[0].level, "success");
    assert.equal(ui.elements.get("operation-summary").dataset.state, status);
  }
  const ui = await activityUI();
  const pending = ui.call();
  const rejected = assert.rejects(pending, (error) => error.operationStatus === "unknown");
  ui.timeout();
  await rejected;
  assert.match(ui.context.logHistory[0].message, /Результат неизвестен/);
  assert.equal(ui.context.activeOperations.size, 0);
  ui.message({ type: "EXECUTE_CODE_RESULT", requestId: ui.sent[0].requestId, success: true });
  assert.match(ui.context.logHistory[0].message, /Результат неизвестен/);
});

test("ошибка экспорта остаётся отдельной от успешной правки; чтение помечено как чтение", async () => {
  const ui = await activityUI();
  const write = ui.call();
  ui.message({ type: "EXECUTE_CODE_RESULT", requestId: ui.sent[0].requestId, success: true });
  await write;
  const screenshot = ui.context.window.sendPluginCommand("CAPTURE_SCREENSHOT", { nodeId: "1:2" });
  ui.message({ type: "CAPTURE_SCREENSHOT_RESULT", requestId: ui.sent[1].requestId, success: false, error: "PNG" });
  await screenshot;
  assert.equal(ui.context.logHistory[0].level, "success");
  assert.equal(ui.context.logHistory[1].message, "Снимок макета — Ошибка");
  const read = ui.call("find_assets", false);
  ui.message({ type: "EXECUTE_CODE_RESULT", requestId: ui.sent[2].requestId, success: true });
  await read;
  assert.equal(ui.context.logHistory[2].message, "Поиск ресурсов — Прочитано");
});

test("смена страницы обновляет текущий контекст, но сохраняет контекст операции в журнале", async () => {
  const ui = await activityUI();
  const fileName = '<img src=x onerror="alert(1)">';
  ui.message({ type: "GET_FILE_INFO_RESULT", fileInfo: { fileName, currentPage: "Начало" }, success: true });
  assert.equal(ui.elements.get("operation-context").textContent, fileName + " · Начало");
  const op = ui.call();
  ui.message({ type: "OPERATION_PROGRESS", requestId: ui.sent[0].requestId, state: "running", fileContext: { fileName, pageName: "Начало" } });
  ui.message({ type: "PAGE_CHANGE", data: { pageName: "Другая" } });
  ui.message({ type: "EXECUTE_CODE_RESULT", requestId: ui.sent[0].requestId, success: true });
  await op;
  assert.equal(ui.elements.get("operation-context").textContent, fileName + " · Другая");
  assert.equal(ui.context.logHistory[0].context, fileName + " · Начало");
  assert.doesNotMatch(ui.context.escHtml(fileName), /<img|="/);
  for (let i = 0; i < 550; i++) ui.context.logWithHistory("Событие " + i);
  assert.equal(ui.context.logHistory.length, 500);
  assert.equal(ui.elements.get("log-entries").children.length, 50);
});

test("локализованные кнопки паузы и возобновления управляют соединением через состояние", async () => {
  const ui = await activityUI();
  let paused = false, scans = 0;
  Object.assign(ui.context.window, {
    __wsDisconnectAll() { paused = true; }, __wsIsPaused: () => paused,
    __wsGetAuthenticatedCount: () => paused ? 0 : 1,
    __wsManualScan() { paused = false; scans++; },
  });
  ui.context.reconcileCta();
  assert.equal(ui.elements.get("cta-btn").textContent, "Пауза");
  ui.context.toggleLocalConnection();
  assert.equal(paused, true);
  assert.equal(ui.elements.get("cta-btn").textContent, "Продолжить");
  ui.context.toggleLocalConnection();
  assert.equal(scans, 1);
  assert.equal(ui.elements.get("cta-btn").disabled, true);
});
