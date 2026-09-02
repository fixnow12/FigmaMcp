const DATA_KEY = "codex-spec-key";

function literal(value) {
  const serialized = JSON.stringify(value);
  return serialized === undefined ? "undefined" : serialized.replaceAll("</", "<\\/");
}

const helpers = `
const DATA_KEY = ${JSON.stringify(DATA_KEY)};

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
  return value || { top: 0, right: 0, bottom: 0, left: 0 };
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
  return figma.currentPage.findOne((node) => node.getPluginData?.(DATA_KEY) === key);
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

async function loadFont(family, style) {
  try {
    await figma.loadFontAsync({ family, style });
    return { family, style };
  } catch {
    await figma.loadFontAsync({ family, style: "Regular" });
    return { family, style: "Regular" };
  }
}

async function build(item, parent) {
  if (item.type === "componentSet") {
    const components = [];
    for (const child of item.children || []) {
      if (child.type !== "component") throw new Error("Component set может содержать только component-варианты");
      components.push(await build(child, parent));
    }
    if (components.length < 2) throw new Error("Component set требует минимум два варианта");
    const set = figma.combineAsVariants(components, parent);
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
    applyLayout(node, item.layout);
  } else {
    node = figma.createFrame();
    applyLayout(node, item.layout);
  }

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

  createdSection = figma.createSection();
  createdSection.name = options.sectionName || spec.name;
  createdSection.setPluginData(DATA_KEY, "section:" + spec.key);
  const existingSection = existing?.parent?.type === "SECTION" ? existing.parent : null;
  createdSection.x = options.position?.x ?? existingSection?.x ?? existing?.x ?? 0;
  createdSection.y = options.position?.y ?? existingSection?.y ?? existing?.y ?? 0;

  const root = figma.createFrame();
  root.name = spec.name;
  root.setPluginData(DATA_KEY, spec.key);
  root.resize(spec.width, spec.height);
  applyLayout(root, spec.layout);
  applyVisual(root, spec);
  createdSection.appendChild(root);

  for (const child of spec.children || []) await build(child, root);
  root.resize(spec.width, spec.height);

  if (existing) {
    const oldParent = existing.parent;
    if (oldParent?.type === "SECTION" && oldParent.getPluginData?.(DATA_KEY) === "section:" + spec.key) {
      oldParent.remove();
    } else {
      existing.remove();
    }
  }

  figma.currentPage.selection = [root];
  figma.viewport.scrollAndZoomIntoView([createdSection]);
  return {
    rootId: root.id,
    sectionId: createdSection.id,
    key: spec.key,
    nodeCount: root.findAll().length + 1,
  };
} catch (error) {
  if (createdSection && !createdSection.removed) createdSection.remove();
  throw error;
}`;
}

export function buildPatchCode({ patches, ignoreMissing, screenshotKey }) {
  return `${helpers}
const patches = ${literal(patches)};
const ignoreMissing = ${literal(ignoreMissing)};
const screenshotKey = ${literal(screenshotKey)};
const resolved = await Promise.all(patches.map(async (patch) => ({
  patch,
  node: patch.key ? findByKey(patch.key) : await figma.getNodeByIdAsync(patch.id),
})));
const targetLabel = (patch) => patch.key || patch.id;
const missing = resolved.filter((item) => !item.node).map((item) => targetLabel(item.patch));
if (missing.length && !ignoreMissing) {
  throw new Error("Не найдены узлы: " + missing.join(", "));
}

async function setText(node, content) {
  if (node.type !== "TEXT") throw new Error("content поддерживается только для TEXT: " + node.name);
  if (node.fontName === figma.mixed) throw new Error("Смешанные шрифты нельзя патчить целиком: " + node.name);
  await figma.loadFontAsync(node.fontName);
  node.characters = content;
}

async function loadAppendFont(family, style) {
  try {
    await figma.loadFontAsync({ family, style });
    return { family, style };
  } catch {
    await figma.loadFontAsync({ family, style: "Regular" });
    return { family, style: "Regular" };
  }
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
  if (findByKey(item.key)) throw new Error("Узел с ключом уже существует: " + item.key);
  if (item.type === "componentSet") {
    const components = [];
    for (const child of item.children || []) {
      if (child.type !== "component") throw new Error("Component set может содержать только component-варианты");
      components.push(await appendNode(child, parent, created));
    }
    if (components.length < 2) throw new Error("Component set требует минимум два варианта");
    const set = figma.combineAsVariants(components, parent);
    set.name = item.name;
    set.setPluginData(DATA_KEY, item.key);
    applyLayout(set, item.layout);
    applyVisual(set, item);
    if (typeof item.width === "number") set.resize(item.width, set.height);
    if (typeof item.height === "number") set.resize(set.width, item.height);
    applyDimension(set, "width", item.width);
    applyDimension(set, "height", item.height);
    created.push(set);
    return set;
  }

  let node;
  if (item.type === "text") {
    node = figma.createText();
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
    const bytes = figma.base64Decode(item.data);
    const image = figma.createImage(bytes);
    node.fills = [{ type: "IMAGE", imageHash: image.hash, scaleMode: (item.scaleMode || "fill").toUpperCase() }];
  } else if (item.type === "svg") {
    node = figma.createNodeFromSvg(item.svg);
  } else if (item.type === "component") {
    node = figma.createComponent();
    applyLayout(node, item.layout);
  } else {
    node = figma.createFrame();
    applyLayout(node, item.layout);
  }

  node.name = item.type === "component" ? variantName(item.variant, item.name) : item.name;
  node.setPluginData(DATA_KEY, item.key);
  applyVisual(node, item);
  parent.appendChild(node);
  created.push(node);
  if (typeof item.width === "number") node.resize(item.width, node.height);
  if (typeof item.height === "number") node.resize(node.width, item.height);
  if ("children" in node) {
    for (const child of item.children || []) await appendNode(child, node, created);
  }
  applyDimension(node, "width", item.width);
  applyDimension(node, "height", item.height);
  return node;
}

for (const { patch, node } of resolved) {
  if (!node) continue;
  const value = patch.set || {};
  if (value.name !== undefined) node.name = value.name;
  if (value.content !== undefined) await setText(node, value.content);
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

  const created = [];
  try {
    for (const root of nestAppendItems(patch.append || [])) {
      await appendNode(root, node, created);
    }
  } catch (error) {
    for (const createdNode of created.reverse()) {
      if (createdNode && !createdNode.removed) createdNode.remove();
    }
    throw error;
  }
}

return {
  patched: resolved.filter((item) => item.node).map((item) => targetLabel(item.patch)),
  appended: resolved.flatMap((item) => (item.patch.append || []).map((node) => node.key)),
  missing,
  screenshotNodeId: screenshotKey ? findByKey(screenshotKey)?.id || null : null,
};`;
}

export function buildInspectCode({ nodeId, depth, maxNodes }) {
  return `${helpers}
const nodeId = ${literal(nodeId)};
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
  if ("layoutMode" in node) {
    item.layout = {
      mode: node.layoutMode,
      gap: node.itemSpacing,
      padding: [node.paddingTop, node.paddingRight, node.paddingBottom, node.paddingLeft],
    };
  }
  if (level < maxDepth && "children" in node) {
    item.children = node.children.map((child) => inspect(child, level + 1)).filter(Boolean);
  } else if ("children" in node) {
    item.childCount = node.children.length;
  }
  return item;
}

return {
  page: { id: figma.currentPage.id, name: figma.currentPage.name },
  selection: (nodeId
    ? [await figma.getNodeByIdAsync(nodeId)].filter(Boolean)
    : figma.currentPage.selection
  ).map((node) => inspect(node, 0)).filter(Boolean),
  inspectedNodes: count,
  truncated,
};`;
}

export function buildUseComponentCode(input) {
  return `${helpers}
const input = ${literal(input)};
let component = null;

if (input.sourceKey) {
  component = findByKey(input.sourceKey);
  if (!component) throw new Error("Локальный компонент не найден: " + input.sourceKey);
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

const parent = input.parentKey ? findByKey(input.parentKey) : figma.currentPage;
if (!parent || !("appendChild" in parent)) {
  throw new Error("Родитель не найден или не поддерживает дочерние узлы: " + input.parentKey);
}

const existing = findByKey(input.key);
if (existing) throw new Error("Узел с ключом " + input.key + " уже существует");

const instance = component.createInstance();
instance.name = input.name || component.name;
instance.setPluginData(DATA_KEY, input.key);
parent.appendChild(instance);
if (input.componentProperties) instance.setProperties(input.componentProperties);
if (input.position) {
  instance.x = input.position.x;
  instance.y = input.position.y;
}
figma.currentPage.selection = [instance];
figma.viewport.scrollAndZoomIntoView([instance]);
return {
  id: instance.id,
  key: input.key,
  name: instance.name,
  sourceId: component.id,
  parentId: parent.id,
  variantProperties: component.variantProperties,
  componentProperties: instance.componentProperties,
};`;
}

export { DATA_KEY };
