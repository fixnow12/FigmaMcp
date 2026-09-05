import { createMutationSafety } from "./mutation-safety.mjs";

const DATA_KEY = "codex-spec-key";

function literal(value) {
  const serialized = JSON.stringify(value);
  return serialized === undefined ? "undefined" : serialized.replaceAll("</", "<\\/");
}

const helpers = `
const DATA_KEY = ${JSON.stringify(DATA_KEY)};
const operationPage = figma.currentPage;
function checkOperation() {
  if (typeof executionControl !== "undefined" && executionControl.cancelled) {
    throw new Error("Время операции истекло; дальнейшие изменения остановлены");
  }
}

function rgba(hex) {
  const raw = hex.replace("#", "");
  const alpha = raw.length === 8 ? parseInt(raw.slice(6, 8), 16) / 255 : 1;
  return {
    color: {
      r: parseInt(raw.slice(0, 2), 16) / 255,
      g: parseInt(raw.slice(2, 4), 16) / 255,
      b: parseInt(raw.slice(4, 6), 16) / 255,
    },
    opacity: alpha,
  };
}

function paint(hex) {
  const value = rgba(hex);
  return { type: "SOLID", color: value.color, opacity: value.opacity };
}

function paddingValues(value) {
  if (typeof value === "number") {
    return { top: value, right: value, bottom: value, left: value };
  }
  return { top: 0, right: 0, bottom: 0, left: 0, ...(value || {}) };
}

function applyLayout(node, value) {
  if (!("layoutMode" in node)) return;
  const layout = value || { direction: "vertical", gap: 0, padding: 0 };
  node.layoutMode = layout.direction === "none"
    ? "NONE"
    : layout.direction === "horizontal" ? "HORIZONTAL" : "VERTICAL";
  if (node.layoutMode === "NONE") return;
  const padding = paddingValues(layout.padding || 0);
  node.paddingTop = padding.top;
  node.paddingRight = padding.right;
  node.paddingBottom = padding.bottom;
  node.paddingLeft = padding.left;
  node.itemSpacing = layout.gap || 0;
  node.primaryAxisAlignItems = {
    start: "MIN",
    center: "CENTER",
    end: "MAX",
    "space-between": "SPACE_BETWEEN",
  }[layout.primaryAlign || "start"];
  node.counterAxisAlignItems = {
    start: "MIN",
    center: "CENTER",
    end: "MAX",
    baseline: "BASELINE",
  }[layout.counterAlign || "start"];
  if ("layoutWrap" in node) node.layoutWrap = layout.wrap ? "WRAP" : "NO_WRAP";
}

function applyVisual(node, item) {
  if (item.opacity !== undefined) node.opacity = item.opacity;
  if (item.visible !== undefined) node.visible = item.visible;
  const fill = item.background || item.fill;
  if (fill && "fills" in node) node.fills = [paint(fill)];
  if (item.stroke && "strokes" in node) node.strokes = [paint(item.stroke)];
  if (item.strokeWidth !== undefined && "strokeWeight" in node) node.strokeWeight = item.strokeWidth;
  if (item.cornerRadius !== undefined && "cornerRadius" in node) node.cornerRadius = item.cornerRadius;
  if (item.clipContent !== undefined && "clipsContent" in node) node.clipsContent = item.clipContent;
}

function applyDimension(node, axis, value) {
  if (value === undefined) return;
  const field = axis === "width" ? "layoutSizingHorizontal" : "layoutSizingVertical";
  if (value === "fill") {
    if (field in node) node[field] = "FILL";
    return;
  }
  if (value === "hug") {
    if (field in node) node[field] = "HUG";
    return;
  }
  if (field in node) node[field] = "FIXED";
  if (axis === "width") node.resize(value, node.height);
  else node.resize(node.width, value);
}

function findByKey(key) {
  const matches = operationPage.findAll((node) => node.getPluginData?.(DATA_KEY) === key);
  if (matches.length > 1) throw new Error("Ключ неоднозначен, используйте id: " + key);
  return matches[0] || null;
}

function variantName(variant, fallback) {
  const entries = Object.entries(variant || {});
  return entries.length ? entries.map(([key, value]) => key + "=" + value).join(", ") : fallback;
}
`;

export function buildRenderCode({ spec, replace, sectionName, position }) {
  return `${helpers}
const spec = ${literal(spec)};
const options = ${literal({ replace, sectionName, position })};
let createdSection = null;
const created = [];
const loadedFonts = new Map();
const previousSelection = [...operationPage.selection];

async function loadFont(family, style) {
  const font = { family, style };
  const key = JSON.stringify(font);
  if (!loadedFonts.has(key)) loadedFonts.set(key, figma.loadFontAsync(font));
  await loadedFonts.get(key);
  checkOperation();
  return font;
}

async function prepareFonts(item) {
  if (item.type === "text") await loadFont(item.fontFamily || "Inter", item.fontWeight || "Regular");
  for (const child of item.children || []) await prepareFonts(child);
}

async function build(item, parent) {
  checkOperation();
  if (item.type === "componentSet") {
    const components = [];
    for (const child of item.children || []) {
      if (child.type !== "component") throw new Error("Component set может содержать только component-варианты");
      components.push(await build(child, parent));
    }
    if (components.length < 2) throw new Error("Component set требует минимум два варианта");
    const set = figma.combineAsVariants(components, parent);
    created.push(set);
    set.name = item.name;
    set.setPluginData(DATA_KEY, item.key);
    applyLayout(set, item.layout);
    applyVisual(set, item);
    if (typeof item.width === "number") set.resize(item.width, set.height);
    if (typeof item.height === "number") set.resize(set.width, item.height);
    applyDimension(set, "width", item.width);
    applyDimension(set, "height", item.height);
    return set;
  }

  let node;
  if (item.type === "text") {
    node = figma.createText();
    created.push(node);
    const font = await loadFont(item.fontFamily || "Inter", item.fontWeight || "Regular");
    node.fontName = font;
    node.characters = item.content;
    node.fontSize = item.fontSize || 14;
    node.fills = [paint(item.color || "#111827")];
    if (item.lineHeight) node.lineHeight = { unit: "PIXELS", value: item.lineHeight };
    if (item.letterSpacing !== undefined) node.letterSpacing = { unit: "PIXELS", value: item.letterSpacing };
    if (item.textAlign) node.textAlignHorizontal = item.textAlign.toUpperCase();
    if (typeof item.width === "number") node.textAutoResize = "HEIGHT";
    else node.textAutoResize = "WIDTH_AND_HEIGHT";
  } else if (item.type === "rectangle") {
    node = figma.createRectangle();
  } else if (item.type === "ellipse") {
    node = figma.createEllipse();
  } else if (item.type === "image") {
    node = figma.createRectangle();
    created.push(node);
    const bytes = figma.base64Decode(item.data);
    const image = figma.createImage(bytes);
    node.fills = [{
      type: "IMAGE",
      imageHash: image.hash,
      scaleMode: (item.scaleMode || "fill").toUpperCase(),
    }];
  } else if (item.type === "svg") {
    node = figma.createNodeFromSvg(item.svg);
  } else if (item.type === "component") {
    node = figma.createComponent();
    created.push(node);
    applyLayout(node, item.layout);
  } else {
    node = figma.createFrame();
    created.push(node);
    applyLayout(node, item.layout);
  }

  if (!created.includes(node)) created.push(node);
  node.name = item.type === "component" ? variantName(item.variant, item.name) : item.name;
  node.setPluginData(DATA_KEY, item.key);
  applyVisual(node, item);
  parent.appendChild(node);

  if (typeof item.width === "number") node.resize(item.width, node.height);
  if (typeof item.height === "number") node.resize(node.width, item.height);

  if ("children" in node && Array.isArray(item.children)) {
    for (const child of item.children) await build(child, node);
  }

  applyDimension(node, "width", item.width);
  applyDimension(node, "height", item.height);
  return node;
}

try {
  const existing = findByKey(spec.key);
  if (existing && !options.replace) {
    throw new Error("Узел с ключом " + spec.key + " уже существует");
  }
  await prepareFonts(spec);
  if (figma.currentPage !== operationPage) throw new Error("Страница изменилась во время проверки");

  createdSection = figma.createSection();
  created.push(createdSection);
  createdSection.name = options.sectionName || spec.name;
  createdSection.setPluginData(DATA_KEY, "section:" + spec.key);
  const existingSection = existing?.parent?.type === "SECTION" ? existing.parent : null;
  createdSection.x = options.position?.x ?? existingSection?.x ?? existing?.x ?? 0;
  createdSection.y = options.position?.y ?? existingSection?.y ?? existing?.y ?? 0;

  const root = figma.createFrame();
  created.push(root);
  root.name = spec.name;
  root.setPluginData(DATA_KEY, spec.key);
  root.resize(spec.width, spec.height);
  applyLayout(root, spec.layout);
  applyVisual(root, spec);
  createdSection.appendChild(root);

  for (const child of spec.children || []) await build(child, root);
  root.resize(spec.width, spec.height);

  checkOperation();
  const result = {
    rootId: root.id,
    sectionId: createdSection.id,
    key: spec.key,
    nodeCount: root.findAll().length + 1,
  };
  if (figma.currentPage === operationPage) {
    operationPage.selection = [root];
    figma.viewport.scrollAndZoomIntoView([createdSection]);
  }

  if (existing) {
    const oldParent = existing.parent;
    if (oldParent?.type === "SECTION" && oldParent.children.length === 1 && oldParent.getPluginData?.(DATA_KEY) === "section:" + spec.key) {
      oldParent.remove();
    } else {
      existing.remove();
    }
  }

  return result;
} catch (error) {
  const rollbackErrors = [];
  for (const node of created.reverse()) {
    try { if (!node.removed) node.remove(); } catch (rollbackError) { rollbackErrors.push(rollbackError.message); }
  }
  try { if (figma.currentPage === operationPage) operationPage.selection = previousSelection.filter((node) => !node.removed); } catch (rollbackError) { rollbackErrors.push(rollbackError.message); }
  error.operationStatus = rollbackErrors.length ? "partial" : created.length ? "rolled_back" : "not_applied";
  error.rollbackErrors = rollbackErrors;
  throw error;
}`;
}

export function buildPatchCode({ patches, ignoreMissing, screenshotKey }) {
  return `${helpers}
const safety = (${createMutationSafety.toString()})(figma);
const patches = ${literal(patches)};
const ignoreMissing = ${literal(ignoreMissing)};
const screenshotKey = ${literal(screenshotKey)};
let resolved;
const prepared = [];
const appendKeys = new Set();
let screenshotNodeId = null;
const targetLabel = (patch) => patch.key || patch.id;
try {
resolved = await Promise.all(patches.map(async (patch) => ({
  patch,
  node: patch.key ? findByKey(patch.key) : await figma.getNodeByIdAsync(patch.id),
})));
const missing = resolved.filter((item) => !item.node).map((item) => targetLabel(item.patch));
if (missing.length && !ignoreMissing) {
  throw new Error("Не найдены узлы: " + missing.join(", "));
}

// Resolve capabilities and fonts for the entire batch before the first write.
for (const { patch, node } of resolved) {
  if (!node) continue;
  let page = node;
  while (page && page.type !== "PAGE") page = page.parent;
  if (page !== operationPage) throw new Error("Узел находится на другой странице: " + node.id);
  prepared.push({ patch, node, snapshot: await safety.prepare(node, patch.set || {}, patch.append) });
  for (const item of patch.append || []) {
    if (appendKeys.has(item.key) || findByKey(item.key)) throw new Error("Узел с ключом уже существует: " + item.key);
    appendKeys.add(item.key);
    if (item.type === "text") await safety.loadFont({ family: item.fontFamily || "Inter", style: item.fontWeight || "Regular" });
  }
}
if (figma.currentPage !== operationPage) throw new Error("Страница изменилась во время проверки. Повторите чтение макета.");
if (screenshotKey && !appendKeys.has(screenshotKey)) screenshotNodeId = findByKey(screenshotKey)?.id || null;
} catch (error) {
  error.operationStatus = "not_applied";
  throw error;
}
const missing = resolved.filter((item) => !item.node).map((item) => targetLabel(item.patch));

async function setText(node, content) {
  if (node.type !== "TEXT") throw new Error("content поддерживается только для TEXT: " + node.name);
  if (node.fontName === figma.mixed) throw new Error("Смешанные шрифты нельзя патчить целиком: " + node.name);
  await safety.loadFont(node.fontName);
  checkOperation();
  node.characters = content;
}

async function loadAppendFont(family, style) {
  await safety.loadFont({ family, style });
  checkOperation();
  return { family, style };
}

function nestAppendItems(items) {
  const byKey = new Map(items.map((item) => [item.key, { ...item, children: [] }]));
  const roots = [];
  for (const item of items) {
    const copy = byKey.get(item.key);
    if (item.parentKey) {
      const parent = byKey.get(item.parentKey);
      if (!parent) throw new Error("Не найден append parentKey: " + item.parentKey);
      parent.children.push(copy);
    } else {
      roots.push(copy);
    }
  }
  return roots;
}

async function appendNode(item, parent, created) {
  checkOperation();
  if (findByKey(item.key)) throw new Error("Узел с ключом уже существует: " + item.key);
  if (item.type === "componentSet") {
    const components = [];
    for (const child of item.children || []) {
      if (child.type !== "component") throw new Error("Component set может содержать только component-варианты");
      components.push(await appendNode(child, parent, created));
    }
    if (components.length < 2) throw new Error("Component set требует минимум два варианта");
    const set = figma.combineAsVariants(components, parent);
    created.push(set);
    set.name = item.name;
    set.setPluginData(DATA_KEY, item.key);
    applyLayout(set, item.layout);
    applyVisual(set, item);
    if (typeof item.width === "number") set.resize(item.width, set.height);
    if (typeof item.height === "number") set.resize(set.width, item.height);
    applyDimension(set, "width", item.width);
    applyDimension(set, "height", item.height);
    return set;
  }

  let node;
  if (item.type === "text") {
    node = figma.createText();
    created.push(node);
    const font = await loadAppendFont(item.fontFamily || "Inter", item.fontWeight || "Regular");
    node.fontName = font;
    node.characters = item.content;
    node.fontSize = item.fontSize || 14;
    node.fills = [paint(item.color || "#111827")];
    if (item.lineHeight) node.lineHeight = { unit: "PIXELS", value: item.lineHeight };
    if (item.letterSpacing !== undefined) node.letterSpacing = { unit: "PIXELS", value: item.letterSpacing };
    if (item.textAlign) node.textAlignHorizontal = item.textAlign.toUpperCase();
    node.textAutoResize = typeof item.width === "number" ? "HEIGHT" : "WIDTH_AND_HEIGHT";
  } else if (item.type === "rectangle") {
    node = figma.createRectangle();
  } else if (item.type === "ellipse") {
    node = figma.createEllipse();
  } else if (item.type === "image") {
    node = figma.createRectangle();
    created.push(node);
    const bytes = figma.base64Decode(item.data);
    const image = figma.createImage(bytes);
    node.fills = [{ type: "IMAGE", imageHash: image.hash, scaleMode: (item.scaleMode || "fill").toUpperCase() }];
  } else if (item.type === "svg") {
    node = figma.createNodeFromSvg(item.svg);
  } else if (item.type === "component") {
    node = figma.createComponent();
    created.push(node);
    applyLayout(node, item.layout);
  } else {
    node = figma.createFrame();
    created.push(node);
    applyLayout(node, item.layout);
  }

  if (!created.includes(node)) created.push(node);
  node.name = item.type === "component" ? variantName(item.variant, item.name) : item.name;
  node.setPluginData(DATA_KEY, item.key);
  applyVisual(node, item);
  parent.appendChild(node);
  if (typeof item.width === "number") node.resize(item.width, node.height);
  if (typeof item.height === "number") node.resize(node.width, item.height);
  if ("children" in node) {
    for (const child of item.children || []) await appendNode(child, node, created);
  }
  applyDimension(node, "width", item.width);
  applyDimension(node, "height", item.height);
  return node;
}

const created = [];
const touched = [];
try {
for (const { patch, node, snapshot } of prepared) {
  checkOperation();
  touched.push(snapshot);
  const value = patch.set || {};
  if (value.name !== undefined) node.name = value.name;
  if (snapshot.nextFont) node.fontName = snapshot.nextFont;
  if (value.content !== undefined) await setText(node, value.content);
  if (value.fontSize !== undefined) node.fontSize = value.fontSize;
  if (value.lineHeight !== undefined) node.lineHeight = { unit: "PIXELS", value: value.lineHeight };
  if (value.letterSpacing !== undefined) node.letterSpacing = { unit: "PIXELS", value: value.letterSpacing };
  if (value.textAlign !== undefined) node.textAlignHorizontal = value.textAlign.toUpperCase();
  if (value.clipContent !== undefined) node.clipsContent = value.clipContent;
  if (value.layout !== undefined) {
    applyLayout(node, {
      direction: node.layoutMode === "NONE" ? "none" : node.layoutMode === "HORIZONTAL" ? "horizontal" : "vertical",
      gap: node.itemSpacing,
      padding: { top: node.paddingTop, right: node.paddingRight, bottom: node.paddingBottom, left: node.paddingLeft },
      primaryAlign: { MIN: "start", CENTER: "center", MAX: "end", SPACE_BETWEEN: "space-between" }[node.primaryAxisAlignItems],
      counterAlign: { MIN: "start", CENTER: "center", MAX: "end", BASELINE: "baseline" }[node.counterAxisAlignItems],
      wrap: node.layoutWrap === "WRAP",
      ...value.layout,
    });
  }
  if (value.visible !== undefined) node.visible = value.visible;
  if (value.opacity !== undefined) node.opacity = value.opacity;
  if (value.x !== undefined) node.x = value.x;
  if (value.y !== undefined) node.y = value.y;
  if (value.background !== undefined && "fills" in node) node.fills = [paint(value.background)];
  if (value.color !== undefined && node.type === "TEXT") node.fills = [paint(value.color)];
  if (value.stroke !== undefined && "strokes" in node) node.strokes = [paint(value.stroke)];
  if (value.strokeWidth !== undefined && "strokeWeight" in node) node.strokeWeight = value.strokeWidth;
  if (value.cornerRadius !== undefined && "cornerRadius" in node) node.cornerRadius = value.cornerRadius;
  if (value.gap !== undefined && "itemSpacing" in node) node.itemSpacing = value.gap;
  if (value.padding !== undefined && "paddingTop" in node) {
    const p = paddingValues(value.padding);
    node.paddingTop = p.top;
    node.paddingRight = p.right;
    node.paddingBottom = p.bottom;
    node.paddingLeft = p.left;
  }
  if (value.componentProperties !== undefined) {
    if (node.type !== "INSTANCE") throw new Error("componentProperties поддерживается только для INSTANCE: " + node.name);
    node.setProperties(value.componentProperties);
  }
  applyDimension(node, "width", value.width);
  applyDimension(node, "height", value.height);

  for (const root of nestAppendItems(patch.append || [])) {
    await appendNode(root, node, created);
  }
}
checkOperation();
} catch (error) {
  await safety.rollback(touched, created, error);
}

return {
  status: "applied",
  patched: prepared.map((item) => targetLabel(item.patch)),
  appended: created.filter((node) => !node.removed).map((node) => node.getPluginData(DATA_KEY)),
  missing,
  screenshotNodeId: screenshotNodeId || created.find((node) => !node.removed && node.getPluginData(DATA_KEY) === screenshotKey)?.id || null,
};`;
}

export function buildInspectCode({ nodeId, nodeIds, detail, depth, maxNodes }) {
  return `${helpers}
const nodeId = ${literal(nodeId)};
const nodeIds = ${literal(nodeIds)};
const detail = ${literal(detail)};
const maxDepth = ${literal(depth)};
const maxNodes = ${literal(maxNodes)};
let count = 0;
let truncated = false;

function inspect(node, level) {
  if (count >= maxNodes) {
    truncated = true;
    return null;
  }
  count += 1;
  const item = {
    id: node.id,
    key: node.getPluginData?.(DATA_KEY) || null,
    name: node.name,
    type: node.type,
    visible: node.visible,
    bounds: { x: node.x, y: node.y, width: node.width, height: node.height },
  };
  if (node.type === "TEXT") item.content = node.characters;
  if (node.type === "INSTANCE") item.componentProperties = node.componentProperties;
  if (node.type === "COMPONENT") item.variantProperties = node.variantProperties;
  if (node.type === "COMPONENT_SET") item.variantGroupProperties = node.variantGroupProperties;
  if (detail === "full") {
    const serializable = (value) => value === figma.mixed ? "MIXED" : value;
    item.parentId = node.parent?.id || null;
    for (const field of ["opacity", "fills", "strokes", "strokeWeight", "cornerRadius", "clipsContent", "effects", "fillStyleId", "strokeStyleId", "effectStyleId", "boundVariables", "explicitVariableModes", "layoutSizingHorizontal", "layoutSizingVertical", "layoutPositioning", "minWidth", "maxWidth", "minHeight", "maxHeight", "absoluteBoundingBox"]) {
      if (field in node) item[field] = serializable(node[field]);
    }
    if (node.type === "TEXT") {
      item.typography = {};
      for (const field of ["fontName", "fontSize", "lineHeight", "letterSpacing", "textAlignHorizontal", "textAutoResize", "textStyleId", "hasMissingFont"]) item.typography[field] = serializable(node[field]);
    }
  }
  if ("layoutMode" in node) {
    item.layout = {
      mode: node.layoutMode,
      gap: node.itemSpacing,
      padding: [node.paddingTop, node.paddingRight, node.paddingBottom, node.paddingLeft],
      ...(detail === "full" ? {
        primaryAlign: node.primaryAxisAlignItems,
        counterAlign: node.counterAxisAlignItems,
        wrap: node.layoutWrap,
      } : {}),
    };
  }
  if (level < maxDepth && "children" in node) {
    item.children = node.children.map((child) => inspect(child, level + 1)).filter(Boolean);
  } else if ("children" in node) {
    item.childCount = node.children.length;
  }
  return item;
}

const requested = nodeIds || (nodeId ? [nodeId] : null);
const roots = requested ? await Promise.all(requested.map((id) => figma.getNodeByIdAsync(id))) : operationPage.selection;
return {
  page: { id: operationPage.id, name: operationPage.name },
  selection: roots.filter(Boolean).map((node) => inspect(node, 0)).filter(Boolean),
  missing: requested ? requested.filter((_id, index) => !roots[index]) : [],
  inspectedNodes: count,
  truncated,
};`;
}

export function buildUseComponentCode(input) {
  return `${helpers}
const input = ${literal(input)};
let component = null;

if (input.sourceKey || input.sourceId) {
  component = input.sourceId ? await figma.getNodeByIdAsync(input.sourceId) : findByKey(input.sourceKey);
  if (!component) throw new Error("Локальный компонент не найден: " + (input.sourceKey || input.sourceId));
} else {
  component = await figma.importComponentByKeyAsync(input.libraryKey);
}

if (component?.type === "COMPONENT_SET") {
  const candidates = component.children.filter((node) => node.type === "COMPONENT");
  if (input.variant && Object.keys(input.variant).length) {
    component = candidates.find((candidate) =>
      Object.entries(input.variant).every(([key, value]) => candidate.variantProperties?.[key] === value)
    );
    if (!component) throw new Error("Вариант component set не найден: " + JSON.stringify(input.variant));
  } else {
    component = candidates[0] || null;
  }
}

if (!component || component.type !== "COMPONENT") {
  throw new Error("Источник должен быть COMPONENT или COMPONENT_SET");
}

const parent = input.parentId ? await figma.getNodeByIdAsync(input.parentId) : input.parentKey ? findByKey(input.parentKey) : operationPage;
if (!parent || !["PAGE", "FRAME", "SECTION", "COMPONENT"].includes(parent.type) || !("appendChild" in parent)) {
  throw new Error("Родитель не найден или не поддерживает дочерние узлы: " + input.parentKey);
}

let parentPage = parent;
while (parentPage && parentPage.type !== "PAGE") parentPage = parentPage.parent;
if (parentPage !== operationPage) throw new Error("Родитель находится на другой странице");
if (figma.currentPage !== operationPage) throw new Error("Страница изменилась во время проверки");
checkOperation();
const existing = findByKey(input.key);
if (existing) throw new Error("Узел с ключом " + input.key + " уже существует");

const instance = component.createInstance();
try {
instance.name = input.name || component.name;
instance.setPluginData(DATA_KEY, input.key);
parent.appendChild(instance);
if (input.componentProperties) instance.setProperties(input.componentProperties);
if (input.position) {
  instance.x = input.position.x;
  instance.y = input.position.y;
}
if (figma.currentPage === operationPage) {
  operationPage.selection = [instance];
  figma.viewport.scrollAndZoomIntoView([instance]);
}
return {
  id: instance.id,
  key: input.key,
  name: instance.name,
  sourceId: component.id,
  parentId: parent.id,
  variantProperties: component.variantProperties,
  componentProperties: instance.componentProperties,
};
} catch (error) {
  try {
    if (!instance.removed) instance.remove();
    error.operationStatus = "rolled_back";
  } catch (rollbackError) {
    error.operationStatus = "partial";
    error.rollbackErrors = [rollbackError.message];
  }
  throw error;
}`;
}

export { DATA_KEY };
