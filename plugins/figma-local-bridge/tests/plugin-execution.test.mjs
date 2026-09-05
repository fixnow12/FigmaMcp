import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";
import { buildPatchCode } from "../src/figma-code.mjs";
import { createFigmaMock } from "./helpers/figma-mock.mjs";

async function executionHandler(figma, globals = {}) {
  const source = await readFile(new URL("../figma-plugin/code.js", import.meta.url), "utf8");
  const start = source.indexOf("var executeCodeQueue = Promise.resolve();");
  const end = source.indexOf("\n  // ============================================================================\n  // UPDATE_VARIABLE", start);
  assert.ok(start > 0 && end > start);
  const messages = [];
  const listeners = new Map();
  figma.ui = { postMessage(message) {
    messages.push(message);
    listeners.get(message.requestId)?.(message);
  } };
  vm.runInNewContext(source.slice(start, end) + "\n};", {
    figma, setTimeout, clearTimeout, console: { log() {}, warn() {}, error() {} }, ...globals,
  });
  return {
    messages,
    result(id) { return new Promise((resolve) => listeners.set(id, resolve)); },
    run(id, code, timeout = 1000) { return figma.ui.onmessage({ type: "EXECUTE_CODE", requestId: id, code, timeout }); },
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
    assert.deepEqual(events, ["first-start"]);
  } finally {
    release();
    await Promise.all([first, second]);
  }
  assert.deepEqual(events, ["first-start", "second"]);
  assert.equal(handler.messages.find((message) => message.requestId === "second").success, true);
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
  assert.equal(handler.messages.find((message) => message.requestId === "expired").operationStatus, "not_applied");
});
