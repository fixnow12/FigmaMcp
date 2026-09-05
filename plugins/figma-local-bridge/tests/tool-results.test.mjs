import test from "node:test";
import assert from "node:assert/strict";
import { runToolOperation } from "../src/tool-results.mjs";

test("ошибка снимка не превращает успешную запись в ошибку инструмента", async () => {
  let writes = 0;
  const target = { fileKey: "file-a", pageId: "page-a" };
  const bridge = {
    runInFile: async (_key, operation) => operation(target),
    execute: async (_code, options) => { writes++; assert.equal(options.fileKey, "file-a"); return { result: { rootId: "1:2" } }; },
    captureScreenshot: async (_id, options) => { assert.equal(options.fileKey, "file-a"); throw new Error("Экспорт не удался"); },
  };
  const response = await runToolOperation(bridge, {}, "code", { screenshotRequested: true, screenshotNode: (payload) => payload.result.rootId });
  assert.equal(response.isError, undefined);
  assert.equal(response.structuredContent.operationStatus, "applied");
  assert.equal(response.structuredContent.screenshot.status, "failed");
  assert.equal(writes, 1);
});

test("ошибка записи сохраняет статус отката и не запускает экспорт", async () => {
  const bridge = {
    runInFile: async (_key, operation) => operation({ fileKey: "a" }),
    execute: async () => { throw Object.assign(new Error("Ошибка"), { operationStatus: "partial", rollbackErrors: ["Не восстановлен узел"] }); },
    captureScreenshot: async () => assert.fail("Экспорт после неудачной записи"),
  };
  const response = await runToolOperation(bridge, {}, "code", { screenshotRequested: true });
  assert.equal(response.isError, true);
  assert.equal(response.structuredContent.operationStatus, "partial");
  assert.deepEqual(response.structuredContent.rollbackErrors, ["Не восстановлен узел"]);
});

test("PNG и одинаковые метаданные доступны в обоих форматах ответа", async () => {
  const bridge = {
    runInFile: async (_key, operation) => operation({ fileKey: "a" }),
    execute: async () => ({ result: { id: "1" } }),
    captureScreenshot: async () => ({ base64: "AA==", format: "PNG", scale: 1, byteLength: 1 }),
  };
  const response = await runToolOperation(bridge, {}, "code", { screenshotRequested: true, screenshotNode: (payload) => payload.result.id });
  assert.deepEqual(JSON.parse(response.content[0].text), response.structuredContent);
  assert.equal(response.content[1].type, "image");
  assert.equal(response.structuredContent.screenshot.base64, undefined);
});
