import { DATA_KEY } from "../../src/figma-code.mjs";

// Behavioral test double: tracks nodes/parents, writes, resource failures and removals.
// It intentionally does not claim to emulate Figma's layout engine.
export function createFigmaMock() {
  const nodes = new Map();
  const writes = [];
  const loadedFonts = [];
  let counter = 0;
  let rejectWrite = () => false;
  const mixed = Symbol("mixed");
  let page;
  function make(type, props = {}, parent = page) {
    const data = {};
    const raw = {
      id: "node:" + ++counter, name: type, type, parent: null, removed: false,
      x: 0, y: 0, width: 100, height: 40, visible: true, opacity: 1,
      fills: [], strokes: [], strokeWeight: 1, boundVariables: {},
      layoutSizingHorizontal: "FIXED", layoutSizingVertical: "FIXED",
      getPluginData: (key) => data[key] || "",
      setPluginData: (key, value) => { data[key] = value; },
      resize(width, height) { this.width = width; this.height = height; },
      remove() {
        for (const child of [...(this.children || [])]) child.remove();
        if (this.parent) this.parent.children = this.parent.children.filter((child) => child !== this);
        this.removed = true;
        nodes.delete(this.id);
      },
      async setFillStyleIdAsync(id) { this.fillStyleId = id; },
      async setStrokeStyleIdAsync(id) { this.strokeStyleId = id; },
      setBoundVariable(field, variable) { this.boundVariables = { ...this.boundVariables, [field]: { type: "VARIABLE_ALIAS", id: variable.id } }; },
    };
    if (["PAGE", "SECTION", "FRAME", "COMPONENT", "COMPONENT_SET", "INSTANCE"].includes(type)) {
      Object.assign(raw, {
        children: [], selection: [], layoutMode: type === "PAGE" ? "NONE" : "VERTICAL",
        itemSpacing: 0, paddingTop: 0, paddingRight: 0, paddingBottom: 0, paddingLeft: 0,
        primaryAxisAlignItems: "MIN", counterAxisAlignItems: "MIN", layoutWrap: "NO_WRAP",
        clipsContent: false, cornerRadius: 0,
        appendChild(child) {
          if (child.parent) child.parent.children = child.parent.children.filter((item) => item !== child);
          this.children = [...this.children, child];
          child.parent = this;
        },
        findAll(predicate = () => true) {
          return this.children.flatMap((node) => [...(predicate(node) ? [node] : []), ...(node.findAll?.(predicate) || [])]);
        },
      });
    }
    if (type === "TEXT") {
      Object.assign(raw, {
        characters: "Текст", fontName: { family: "Inter", style: "Regular" }, fontSize: 14,
        textAutoResize: "WIDTH_AND_HEIGHT", textAlignHorizontal: "LEFT", lineHeight: { unit: "AUTO" },
        letterSpacing: { unit: "PIXELS", value: 0 }, textCase: "ORIGINAL", textDecoration: "NONE", hyperlink: null,
        fillStyleId: "", textStyleId: "",
        getStyledTextSegments(fields) {
          return [{ start: 0, end: this.characters.length, ...Object.fromEntries(fields.map((field) => [field, this[field]])) }];
        },
      });
      for (const field of ["fontName", "fontSize", "fills", "textCase", "textDecoration", "letterSpacing", "lineHeight", "hyperlink"]) {
        raw["setRange" + field[0].toUpperCase() + field.slice(1)] = function(_start, _end, value) { this[field] = value; };
      }
      raw.setRangeTextStyleIdAsync = async function(_start, _end, id) { this.textStyleId = id; };
      raw.setRangeFillStyleIdAsync = async function(_start, _end, id) { this.fillStyleId = id; };
      raw.setRangeBoundVariable = function(_start, _end, field, variable) { this.setBoundVariable(field, variable); };
    }
    const node = new Proxy(Object.assign(raw, props), {
      set(target, field, value) {
        if (rejectWrite(target, field, value)) throw new Error("Injected write failure: " + field);
        target[field] = value;
        writes.push({ id: target.id, field, value });
        return true;
      },
    });
    nodes.set(node.id, node);
    if (parent) parent.appendChild(node);
    return node;
  }
  page = make("PAGE", { name: "Страница" }, null);
  const figma = {
    currentPage: page, mixed, root: { name: "Тестовый файл" },
    getNodeByIdAsync: async (id) => nodes.get(id) || null,
    loadFontAsync: async (font) => {
      if (font.family === "Missing") throw new Error("Шрифт недоступен");
      loadedFonts.push(font);
    },
    createFrame: () => make("FRAME"), createSection: () => make("SECTION"),
    createText: () => make("TEXT"), createRectangle: () => make("RECTANGLE", { cornerRadius: 0 }),
    createEllipse: () => make("ELLIPSE"), createComponent: () => make("COMPONENT"),
    base64Decode: (data) => Buffer.from(data, "base64"),
    createImage: () => { throw new Error("Некорректное изображение"); },
    createNodeFromSvg: () => { throw new Error("Некорректный SVG"); },
    viewport: { scrollAndZoomIntoView() {} },
    variables: { getVariableByIdAsync: async (id) => ({ id }) },
  };
  return {
    figma, page, make, nodes, writes, loadedFonts,
    key(node, value) { node.setPluginData(DATA_KEY, value); return node; },
    rejectWrites(fn) { rejectWrite = fn; },
  };
}

export async function executeGenerated(figma, code) {
  const AsyncFunction = Object.getPrototypeOf(async function() {}).constructor;
  return new AsyncFunction("figma", code)(figma);
}
