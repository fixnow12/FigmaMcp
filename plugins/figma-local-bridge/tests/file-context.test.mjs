import test from "node:test";
import assert from "node:assert/strict";
import { createFigmaMock, executeGenerated } from "./helpers/figma-mock.mjs";
import { buildActivatePageCode, buildGetFileMetadataCode, buildSetFileMetadataCode } from "../src/file-context.mjs";
import { activatePageSchema, getFileMetadataSchema, setFileMetadataSchema } from "../src/operation-schemas.mjs";

function readonlyDocumentMock() {
  const mock = createFigmaMock();
  let name = mock.figma.root.name;
  Object.defineProperty(mock.figma.root, 'name', { configurable: true,
    get: () => name, set: () => { throw new Error('DocumentNode.name is read-only'); } });
  mock.renameExternally = value => { name = value; };
  return mock;
}

test("выбирает PAGE по точному ID и подтверждает read-back", async () => {
  const mock = createFigmaMock();
  const other = mock.make("PAGE", { name: "Master", async loadAsync() {} }, null);
  mock.figma.root.children.push(other);
  const result = await executeGenerated(mock.figma, buildActivatePageCode(activatePageSchema.parse({ pageId: other.id })));
  assert.deepEqual(result, { pageId: other.id, pageName: "Master" });
  assert.equal(mock.figma.currentPage, other);
});

test("не принимает FRAME или несуществующий pageId", async () => {
  const mock = createFigmaMock();
  for (const pageId of [mock.make("FRAME").id, "missing"]) {
    await assert.rejects(
      executeGenerated(mock.figma, buildActivatePageCode(activatePageSchema.parse({ pageId }))),
      error => error.operationStatus === "not_applied",
    );
  }
});

test("читает все PAGE документа по порядку, включая пустые и имена без нормализации", async () => {
  const mock = createFigmaMock();
  const cover = mock.make("PAGE", { name: " Cover " }, null);
  const empty = mock.make("PAGE", { name: "Пустая страница" }, null);
  const master = mock.make("PAGE", { name: "Master" }, null);
  mock.figma.root.children.push(cover, empty, master);

  const result = await executeGenerated(mock.figma, buildGetFileMetadataCode(getFileMetadataSchema.parse({})));

  assert.deepEqual(result.pages, [
    { id: mock.page.id, name: "Страница" },
    { id: cover.id, name: " Cover " },
    { id: empty.id, name: "Пустая страница" },
    { id: master.id, name: "Master" },
  ]);
});

test("совпадающее имя проверяется без setter, thumbnail записывается", async () => {
  const mock = readonlyDocumentMock();
  const cover = mock.make("FRAME", { name: "Cover" });
  const before = await executeGenerated(mock.figma, buildGetFileMetadataCode(getFileMetadataSchema.parse({})));
  assert.deepEqual(before, {
    name: "Тестовый файл",
    thumbnailNodeId: null,
    pages: [{ id: mock.page.id, name: "Страница" }],
  });

  const result = await executeGenerated(mock.figma, buildSetFileMetadataCode(setFileMetadataSchema.parse({
    name: "Тестовый файл",
    thumbnailNodeId: cover.id,
  })));

  assert.deepEqual(result, { name: "Тестовый файл", thumbnailNodeId: cover.id });
});

test("ошибка thumbnail восстанавливает только свой thumbnail при read-only имени", async () => {
  const mock = readonlyDocumentMock();
  const before = mock.make("FRAME", { name: "Old cover" });
  const next = mock.make("FRAME", { name: "New cover" });
  await mock.figma.setFileThumbnailNodeAsync(before);
  const realSet = mock.figma.setFileThumbnailNodeAsync.bind(mock.figma);
  mock.figma.setFileThumbnailNodeAsync = async node => {
    await realSet(node);
    if (node === next) throw new Error("Сбой после записи");
  };

  await assert.rejects(
    executeGenerated(mock.figma, buildSetFileMetadataCode(setFileMetadataSchema.parse({ thumbnailNodeId: next.id }))),
    error => error.operationStatus === "rolled_back" && error.rollbackErrors.length === 0,
  );
  assert.equal(mock.figma.root.name, "Тестовый файл");
  assert.equal((await mock.figma.getFileThumbnailNodeAsync()).id, before.id);
});

test("схемы принимают пустое чтение и требуют непустое изменение metadata", () => {
  assert.deepEqual(getFileMetadataSchema.parse({}), {});
  for (const input of [{}, { name: " " }, { name: "x".repeat(241) }]) {
    assert.equal(setFileMetadataSchema.safeParse(input).success, false);
  }
  assert.deepEqual(setFileMetadataSchema.parse({ name: "  Новый файл  " }), { name: "Новый файл" });
});

test("неверный тип thumbnail отклоняется без изменения metadata", async () => {
  const mock = readonlyDocumentMock();
  const before = mock.make("FRAME", { name: "Old cover" });
  const rectangle = mock.make("RECTANGLE", { name: "Not a cover" });
  await mock.figma.setFileThumbnailNodeAsync(before);

  await assert.rejects(
    executeGenerated(mock.figma, buildSetFileMetadataCode(setFileMetadataSchema.parse({ name: "Тестовый файл", thumbnailNodeId: rectangle.id }))),
    error => error.operationStatus === "not_applied",
  );
  assert.equal(mock.figma.root.name, "Тестовый файл");
  assert.equal((await mock.figma.getFileThumbnailNodeAsync()).id, before.id);
});

test("переименование отклоняется FILE_RENAME_UNSUPPORTED до любого thumbnail setter", async () => {
  const mock = readonlyDocumentMock();
  const next = mock.make("FRAME", { name: "New cover" });
  let thumbnailCalls = 0;
  const realSet = mock.figma.setFileThumbnailNodeAsync.bind(mock.figma);
  mock.figma.setFileThumbnailNodeAsync = async node => { thumbnailCalls += 1; return realSet(node); };

  await assert.rejects(
    executeGenerated(mock.figma, buildSetFileMetadataCode(setFileMetadataSchema.parse({ name: "Новое", thumbnailNodeId: next.id }))),
    error => error.code === 'FILE_RENAME_UNSUPPORTED' && error.operationStatus === "not_applied",
  );
  assert.equal(mock.figma.root.name, "Тестовый файл");
  assert.equal(thumbnailCalls, 0);
});

test("конкурентное имя сохраняется, собственный thumbnail откатывается", async () => {
  const mock = readonlyDocumentMock();
  const before = mock.make("FRAME", { name: "Old cover" });
  const next = mock.make("FRAME", { name: "New cover" });
  await mock.figma.setFileThumbnailNodeAsync(before);
  const realSet = mock.figma.setFileThumbnailNodeAsync.bind(mock.figma);
  mock.figma.setFileThumbnailNodeAsync = async node => {
    await realSet(node);
    if (node === next) {
      mock.renameExternally("Конкурентное");
      throw new Error("Сбой после конкурентного изменения");
    }
  };

  await assert.rejects(
    executeGenerated(mock.figma, buildSetFileMetadataCode(setFileMetadataSchema.parse({ name: "Тестовый файл", thumbnailNodeId: next.id }))),
    error => error.operationStatus === "rolled_back" && error.rollbackErrors.length === 0,
  );
  assert.equal(mock.figma.root.name, "Конкурентное");
  assert.equal((await mock.figma.getFileThumbnailNodeAsync()).id, before.id);
});

test("повтор желаемого состояния возвращает точные metadata", async () => {
  const mock = readonlyDocumentMock();
  const cover = mock.make("SECTION", { name: "Cover" });
  const input = setFileMetadataSchema.parse({ name: "Тестовый файл", thumbnailNodeId: cover.id });
  await executeGenerated(mock.figma, buildSetFileMetadataCode(input));

  const repeated = await executeGenerated(mock.figma, buildSetFileMetadataCode(input));

  assert.deepEqual(repeated, { name: "Тестовый файл", thumbnailNodeId: cover.id });
});

test("name-only assertion does not invoke either readonly name or thumbnail setter", async () => {
  const mock = readonlyDocumentMock();
  mock.figma.setFileThumbnailNodeAsync = () => assert.fail('no thumbnail write');
  assert.deepEqual(await executeGenerated(mock.figma, buildSetFileMetadataCode({ name: 'Тестовый файл' })), { name: 'Тестовый файл', thumbnailNodeId: null });
});

test("thumbnail rollback preserves concurrent foreign thumbnail and reports partial", async () => {
  const mock = readonlyDocumentMock(),next = mock.make('FRAME'),foreign = mock.make('FRAME');
  const set = mock.figma.setFileThumbnailNodeAsync;
  mock.figma.setFileThumbnailNodeAsync = async node => { await set(node); if(node===next){await set(foreign);throw new Error('concurrent change');} };
  await assert.rejects(executeGenerated(mock.figma,buildSetFileMetadataCode({thumbnailNodeId:next.id})),e=>e.operationStatus==='partial'&&e.rollbackErrors.includes('Конфликт отката thumbnail'));
  assert.equal((await mock.figma.getFileThumbnailNodeAsync()).id,foreign.id);
});
