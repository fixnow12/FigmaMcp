import { compileOperation } from "./scene-access.mjs";

async function findAssets(figma, input, access) {
  const query = (input.query || "").toLowerCase();
  const matches = (item) => item.name.toLowerCase().includes(query);
  let items = [];
  let collections = [];
  const limitations = [];
  if (input.kind === "nodes" || input.kind === "components") {
    const pages = input.scope === "file" ? figma.root.children.filter((node) => node.type === "PAGE") : [access.page];
    const types = input.kind === "components" ? ["COMPONENT", "COMPONENT_SET"] : input.types;
    for (const page of pages) {
      await page.loadAsync();
      access.check();
      const nodes = types ? page.findAllWithCriteria({ types }) : page.findAll();
      for (const node of nodes) {
        if (!matches(node)) continue;
        items.push({
          id: node.id, key: node.getPluginData(access.dataKey) || null, name: node.name, type: node.type,
          pageId: page.id, pageName: page.name, parentId: node.parent?.id || null,
          ...(input.kind === "components" ? {
            libraryKey: node.key, remote: node.remote, description: node.description,
            componentPropertyDefinitions: node.componentPropertyDefinitions,
            ...(node.type === "COMPONENT_SET" ? { variantGroupProperties: node.variantGroupProperties } : { variantProperties: node.variantProperties }),
          } : {}),
        });
      }
    }
    if (input.kind === "components") limitations.push("Поиск включает определения компонентов на выбранных страницах, а не полный каталог внешних библиотек. Для известного библиотечного ключа используйте use_component.");
  } else if (input.kind === "styles") {
    const groups = await Promise.all([
      figma.getLocalPaintStylesAsync(), figma.getLocalTextStylesAsync(), figma.getLocalEffectStylesAsync(), figma.getLocalGridStylesAsync(),
    ]);
    access.check();
    items = groups.flat().filter(matches).map((style) => ({
      id: style.id, key: style.key, name: style.name, type: style.type, description: style.description, remote: style.remote,
      ...(style.type === "TEXT" ? { fontName: style.fontName, fontSize: style.fontSize, lineHeight: style.lineHeight, letterSpacing: style.letterSpacing } : {}),
      ...(style.type === "PAINT" ? { paints: style.paints } : {}),
    }));
    limitations.push("Показаны локальные стили файла; внешний каталог стилей Plugin API не предоставляет.");
  } else if (input.kind === "variables") {
    const [variables, localCollections] = await Promise.all([figma.variables.getLocalVariablesAsync(), figma.variables.getLocalVariableCollectionsAsync()]);
    access.check();
    collections = localCollections.map((collection) => ({ id: collection.id, key: collection.key, name: collection.name, modes: collection.modes, defaultModeId: collection.defaultModeId }));
    items = variables.filter(matches).map((variable) => ({
      id: variable.id, key: variable.key, name: variable.name, type: variable.resolvedType,
      collectionId: variable.variableCollectionId, valuesByMode: variable.valuesByMode,
      description: variable.description, remote: variable.remote,
    }));
  } else if (input.kind === "library_collections") {
    items = (await figma.teamLibrary.getAvailableLibraryVariableCollectionsAsync()).filter(matches);
    access.check();
  } else if (input.kind === "library_variables") {
    items = (await figma.teamLibrary.getVariablesInLibraryCollectionAsync(input.collectionKey)).filter(matches);
    access.check();
    limitations.push("Это метаданные библиотечных переменных. bind_variables принимает variableId уже доступной в файле переменной; поиск не импортирует ресурсы.");
  }
  items.sort((a, b) => a.name.localeCompare(b.name) || String(a.id || a.key).localeCompare(String(b.id || b.key)));
  const offset = input.offset ?? 0;
  const limit = input.limit ?? 50;
  const page = items.slice(offset, offset + limit);
  const hasMore = offset + limit < items.length;
  return {
    kind: input.kind, items: page, total: items.length, offset, hasMore, nextOffset: hasMore ? offset + limit : null,
    ...(collections.length ? { collections: collections.filter((collection) => page.some((item) => item.collectionId === collection.id)) } : {}),
    limitations,
  };
}

export const buildFindAssetsCode = (input) => compileOperation(findAssets, input);
