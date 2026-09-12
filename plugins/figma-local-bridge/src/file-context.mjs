import { compileOperation } from "./scene-access.mjs";

async function activatePage(figma, input, access) {
  let page;
  try {
    page = await access.node(input.pageId);
    if (page.type !== "PAGE" || !figma.root.children.includes(page)) {
      throw new Error("Цель activate_page должна быть PAGE текущего файла");
    }
    await access.read(page.loadAsync(), "страница " + page.id);
  } catch (error) {
    error.operationStatus = "not_applied";
    throw error;
  }
  await figma.setCurrentPageAsync(page);
  access.check();
  if (figma.currentPage.id !== page.id) throw new Error("Текущая страница не совпала с pageId после записи");
  return { pageId: page.id, pageName: page.name };
}

async function fileMetadata(figma, input, access) {
  const read = async () => {
    const thumbnail = await access.read(figma.getFileThumbnailNodeAsync(), "thumbnail файла");
    return {
      value: { name: figma.root.name, thumbnailNodeId: thumbnail?.id || null },
      thumbnail,
    };
  };
  if (input.mode === "read") {
    const metadata = await read();
    return {
      ...metadata.value,
      pages: figma.root.children
        .filter((node) => node.type === "PAGE")
        .map((page) => ({ id: page.id, name: page.name })),
    };
  }

  let target = null;
  let before;
  const assertName = () => {
    if (input.name !== undefined && input.name !== figma.root.name) {
      throw Object.assign(new Error('FILE_RENAME_UNSUPPORTED: имя файла доступно Plugin API только для чтения; name проверяет уже установленное имя'), { code: 'FILE_RENAME_UNSUPPORTED', operationStatus: 'not_applied' });
    }
  };
  try {
    assertName();
    if (input.thumbnailNodeId !== undefined) {
      target = await access.node(input.thumbnailNodeId);
      if (!["FRAME", "COMPONENT", "COMPONENT_SET", "SECTION"].includes(target.type)) {
        throw new Error("thumbnailNodeId должен указывать на FRAME, COMPONENT, COMPONENT_SET или SECTION");
      }
    }
    before = await read();
    assertName();
  } catch (error) {
    error.operationStatus = "not_applied";
    throw error;
  }

  const rollback = [];
  try {
    if (target) {
      rollback.push(async () => {
        const current = await figma.getFileThumbnailNodeAsync();
        const currentId = current?.id || null;
        if (currentId === before.value.thumbnailNodeId) return;
        if (currentId !== target.id) throw new Error("Конфликт отката thumbnail");
        try {
          await figma.setFileThumbnailNodeAsync(before.thumbnail);
        } catch (error) {
          const restoredAfterError = await figma.getFileThumbnailNodeAsync();
          if ((restoredAfterError?.id || null) !== before.value.thumbnailNodeId) throw error;
        }
        const restored = await figma.getFileThumbnailNodeAsync();
        if ((restored?.id || null) !== before.value.thumbnailNodeId) throw new Error("Thumbnail файла не восстановился");
      });
      await figma.setFileThumbnailNodeAsync(target);
    }
    const after = await read();
    if (input.name !== undefined && after.value.name !== input.name) throw new Error("Имя файла изменилось до завершения");
    if (target && after.value.thumbnailNodeId !== target.id) throw new Error("Thumbnail изменился до завершения");
    return after.value;
  } catch (error) {
    return await access.failWithRollback(error, rollback);
  }
}

export const buildActivatePageCode = input => compileOperation(activatePage, input);
export const buildGetFileMetadataCode = input => compileOperation(fileMetadata, { ...input, mode: "read" }, { readOnly: true });
export const buildSetFileMetadataCode = input => compileOperation(fileMetadata, { ...input, mode: "write" });
