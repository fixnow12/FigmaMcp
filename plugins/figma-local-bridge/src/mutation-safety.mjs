// Serialized into Plugin API code. Keep this function self-contained.
export function createMutationSafety(figma) {
  const fonts = new Map();
  const fieldMap = {
    name: "name", content: "characters", visible: "visible", opacity: "opacity",
    x: "x", y: "y", background: "fills", color: "fills", stroke: "strokes",
    strokeWidth: "strokeWeight", cornerRadius: "cornerRadius", gap: "itemSpacing",
    fontSize: "fontSize", fontFamily: "fontName", fontWeight: "fontName",
    lineHeight: "lineHeight", letterSpacing: "letterSpacing", textAlign: "textAlignHorizontal",
    clipContent: "clipsContent",
  };
  const textFields = ["content", "color", "fontSize", "fontFamily", "fontWeight", "lineHeight", "letterSpacing", "textAlign"];
  const layoutFields = ["layoutMode", "itemSpacing", "paddingTop", "paddingRight", "paddingBottom", "paddingLeft", "primaryAxisAlignItems", "counterAxisAlignItems", "layoutWrap"];
  const copy = (value) => value === undefined || typeof value === "symbol" ? value : JSON.parse(JSON.stringify(value));

  function loadFont(font) {
    const key = JSON.stringify(font);
    if (!fonts.has(key)) fonts.set(key, figma.loadFontAsync(font));
    return fonts.get(key);
  }

  async function prepare(node, value, append) {
    for (const field of Object.keys(value)) {
      if (textFields.includes(field) && node.type !== "TEXT") throw new Error(field + " поддерживается только для TEXT: " + node.name);
      const property = fieldMap[field];
      if (property && !(property in node)) throw new Error("Узел не поддерживает " + field + ": " + node.name);
    }
    if (value.padding !== undefined && !("paddingTop" in node)) throw new Error("Узел не поддерживает padding: " + node.name);
    if (value.layout !== undefined && !("layoutMode" in node)) throw new Error("Узел не поддерживает Auto Layout: " + node.name);
    const layoutMode = value.layout?.direction === "none" ? "NONE" : value.layout?.direction ? "AUTO" : node.layoutMode;
    if ((value.gap !== undefined || value.padding !== undefined || (value.layout && Object.keys(value.layout).some((key) => key !== "direction"))) && layoutMode === "NONE") {
      throw new Error("Сначала включите Auto Layout: " + node.name);
    }
    if (append?.length && (!["FRAME", "COMPONENT", "PAGE", "SECTION"].includes(node.type) || !("appendChild" in node))) {
      throw new Error("Нельзя добавлять дочерние узлы в " + node.type + ": " + node.name);
    }
    for (const axis of ["width", "height"]) {
      const dimension = value[axis];
      if (dimension === undefined) continue;
      if (typeof node.resize !== "function") throw new Error("Узел не поддерживает изменение размера: " + node.name);
      if (dimension === "fill" && (!node.parent || !node.parent.layoutMode || node.parent.layoutMode === "NONE")) {
        throw new Error("Fill требует родителя с Auto Layout: " + node.name);
      }
      if (dimension === "hug" && node.type !== "TEXT" && (!layoutMode || layoutMode === "NONE")) {
        throw new Error("Hug требует Auto Layout или TEXT: " + node.name);
      }
    }
    if (value.componentProperties !== undefined) {
      if (node.type !== "INSTANCE") throw new Error("componentProperties поддерживается только для INSTANCE: " + node.name);
      for (const [key, val] of Object.entries(value.componentProperties)) {
        const current = node.componentProperties[key];
        if (!current) throw new Error("Не найдено свойство компонента: " + key);
        if (typeof current.value !== typeof val) throw new Error("Неверный тип свойства компонента: " + key);
      }
    }
    let nextFont;
    if (node.type === "TEXT" && (textFields.some((field) => value[field] !== undefined) || value.background !== undefined)) {
      if (node.fontName === figma.mixed) throw new Error("Смешанные шрифты требуют правки диапазонов: " + node.name);
      await loadFont(node.fontName);
      if (value.fontFamily !== undefined || value.fontWeight !== undefined) {
        nextFont = { family: value.fontFamily ?? node.fontName.family, style: value.fontWeight ?? node.fontName.style };
        await loadFont(nextFont);
      }
    }

    const fields = new Set(Object.keys(value).map((key) => fieldMap[key]).filter(Boolean));
    if (value.padding !== undefined) for (const field of layoutFields.slice(2, 6)) fields.add(field);
    if (value.layout !== undefined) for (const field of layoutFields) if (field in node) fields.add(field);
    const dimensions = value.width !== undefined || value.height !== undefined || value.layout !== undefined || value.padding !== undefined || value.gap !== undefined || value.content !== undefined || value.fontSize !== undefined || value.lineHeight !== undefined || value.letterSpacing !== undefined || nextFont;
    if (dimensions) {
      for (const field of ["layoutSizingHorizontal", "layoutSizingVertical", "textAutoResize"]) if (field in node) fields.add(field);
    }
    const values = Object.fromEntries([...fields].map((field) => [field, copy(node[field])]));
    const sizes = dimensions ? { width: node.width, height: node.height } : null;
    const bindings = copy(node.boundVariables || {});
    const componentProperties = value.componentProperties ? Object.fromEntries(Object.keys(value.componentProperties).map((key) => [key, node.componentProperties[key].value])) : null;
    const segments = node.type === "TEXT" && node.characters.length && (fields.has("characters") || fields.has("fills") || textFields.some((field) => value[field] !== undefined))
      ? node.getStyledTextSegments(["fontName", "fontSize", "fills", "textCase", "textDecoration", "letterSpacing", "lineHeight", "hyperlink", "textStyleId", "fillStyleId", "boundVariables"])
      : [];
    const styles = {};
    if (fields.has("fills") && "fillStyleId" in node && node.fillStyleId !== figma.mixed) styles.fillStyleId = node.fillStyleId;
    if (fields.has("strokes") && "strokeStyleId" in node && node.strokeStyleId !== figma.mixed) styles.strokeStyleId = node.strokeStyleId;

    return {
      nextFont,
      async restore() {
        const errors = [];
        const attempt = async (label, fn) => { try { await fn(); } catch (error) { errors.push(label + ": " + error.message); } };
        if (node.removed) throw new Error("Узел удалён: " + node.id);
        if (componentProperties) await attempt("componentProperties", () => node.setProperties(componentProperties));
        // Font and layout must precede characters and sizing.
        for (const field of new Set(["fontName", "layoutMode", ...fields])) {
          if (!(field in values) || values[field] === figma.mixed) continue;
          await attempt(field, () => { node[field] = copy(values[field]); });
        }
        for (const segment of segments) {
          if (segment.textStyleId) await attempt("textStyle", () => node.setRangeTextStyleIdAsync(segment.start, segment.end, segment.textStyleId));
          if (segment.fillStyleId) await attempt("fillStyle", () => node.setRangeFillStyleIdAsync(segment.start, segment.end, segment.fillStyleId));
          for (const field of ["fontName", "fontSize", "fills", "textCase", "textDecoration", "letterSpacing", "lineHeight", "hyperlink"]) {
            if (segment[field] === undefined) continue;
            const setter = "setRange" + field[0].toUpperCase() + field.slice(1);
            await attempt(setter, () => node[setter](segment.start, segment.end, copy(segment[field])));
          }
          for (const [field, binding] of Object.entries(segment.boundVariables || {})) {
            if (!binding || Array.isArray(binding) || binding.type !== "VARIABLE_ALIAS") continue;
            await attempt("rangeBinding:" + field, async () => {
              const variable = await figma.variables.getVariableByIdAsync(binding.id);
              if (!variable) throw new Error("Переменная недоступна: " + binding.id);
              node.setRangeBoundVariable(segment.start, segment.end, field, variable);
            });
          }
        }
        if (sizes) {
          await attempt("resize", () => node.resize(sizes.width, sizes.height));
          for (const field of ["textAutoResize", "layoutSizingHorizontal", "layoutSizingVertical"]) {
            if (field in values) await attempt(field, () => { node[field] = values[field]; });
          }
        }
        for (const [field, id] of Object.entries(styles)) {
          const setter = field === "fillStyleId" ? "setFillStyleIdAsync" : "setStrokeStyleIdAsync";
          await attempt(field, () => node[setter](id));
        }
        // Paint bindings are part of the restored paints. Restore scalar bindings separately.
        const bindingFields = new Set([...fields, ...Object.keys(value), ...(sizes ? ["width", "height"] : [])]);
        for (const field of bindingFields) {
          const binding = bindings[field];
          if (!binding || Array.isArray(binding) || binding.type !== "VARIABLE_ALIAS") continue;
          await attempt("binding:" + field, async () => {
            const variable = await figma.variables.getVariableByIdAsync(binding.id);
            if (!variable) throw new Error("Переменная недоступна: " + binding.id);
            node.setBoundVariable(field, variable);
          });
        }
        if (errors.length) throw new Error(errors.join("; "));
      },
    };
  }

  async function rollback(snapshots, created, cause) {
    const errors = [];
    for (const node of [...created].reverse()) {
      try { if (!node.removed) node.remove(); } catch (error) { errors.push(error.message); }
    }
    for (const snapshot of [...snapshots].reverse()) {
      try { await snapshot.restore(); } catch (error) { errors.push(error.message); }
    }
    const error = new Error(cause.message + (errors.length ? ". Откат неполный: " + errors.join("; ") : ". Изменения пакета отменены."));
    error.operationStatus = errors.length ? "partial" : "rolled_back";
    error.rollbackErrors = errors;
    throw error;
  }

  return { prepare, loadFont, rollback };
}
