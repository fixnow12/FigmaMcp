import { compileOperation } from "./scene-access.mjs";

async function bindVariables(figma, input, access, safety) {
  const prepared = [], variables = new Map();
  const textFields = ["fontFamily", "fontWeight", "fontSize", "lineHeight"];
  const segmentFields = ["fontName", "fontSize", "lineHeight", "fills", "boundVariables"];
  async function variable(id) {
    if (id === null) return null;
    if (!variables.has(id)) variables.set(id, await figma.variables.getVariableByIdAsync(id));
    const value = variables.get(id);
    if (!value) throw new Error("Переменная недоступна в файле: " + id);
    return value;
  }
  const segments = (node, start, end) => access.copy(node.getStyledTextSegments(segmentFields, start, end));
  const read = entry => entry.range ? segments(entry.node, entry.start, entry.end) : access.copy(entry.node[entry.item.field]);
  let fonts;
  const projectedFamilies = new Map();
  try {
    for (const item of input.bindings) {
      const node = await access.node(item.nodeId);
      access.editable(node, input.allowComponentChanges);
      const explicitRange = item.start !== undefined;
      const range = explicitRange || node.type === "TEXT" && textFields.includes(item.field) && node.characters.length > 0;
      const paint = ["fills", "strokes"].includes(item.field), index = item.paintIndex ?? 0;
      const start = item.start ?? 0, end = item.end ?? node.characters?.length;
      if (range) {
        if (node.type !== "TEXT" || !Number.isInteger(start) || !Number.isInteger(end) || start < 0 || end <= start || end > node.characters.length) throw new Error("Диапазон привязки выходит за границы непустого TEXT");
        const split = i => i > 0 && i < node.characters.length && /[\uD800-\uDBFF]/.test(node.characters[i - 1]) && /[\uDC00-\uDFFF]/.test(node.characters[i]);
        if (split(start) || split(end)) throw new Error("Диапазон разрезает символ UTF-16");
        if (typeof node[paint ? "setRangeFills" : "setRangeBoundVariable"] !== "function") throw new Error("Узел не поддерживает привязку текстового диапазона");
      } else if (!(item.field in node) || (!paint && typeof node.setBoundVariable !== "function")) throw new Error("Узел не поддерживает поле " + item.field);
      if (!range && node[item.field] === figma.mixed) throw new Error("Поле содержит смешанные значения; выберите отдельный текстовый диапазон или слой");
      const next = await variable(item.variableId);
      const expectedType = paint ? "COLOR" : item.field === "visible" ? "BOOLEAN" : ["characters", "fontFamily"].includes(item.field) ? "STRING" : "FLOAT";
      if (next && next.resolvedType !== expectedType) throw new Error("Поле " + item.field + " требует переменную типа " + expectedType);
      const resolvedValue = next?.resolveForConsumer(node).value;
      if (next && expectedType === "FLOAT") {
        const positive = ["width", "height", "fontSize", "fontWeight", "lineHeight"].includes(item.field);
        if (typeof resolvedValue !== "number" || !Number.isFinite(resolvedValue) || resolvedValue < 0 || positive && resolvedValue === 0 || item.field === "opacity" && resolvedValue > 1 || item.field === "fontWeight" && resolvedValue > 1000) throw new Error("Значение переменной несовместимо с полем " + item.field);
      }
      if (next && item.field === "fontFamily" && (typeof resolvedValue !== "string" || !resolvedValue.trim())) throw new Error("Пустое семейство шрифта");
      const entry = { item, node, range, explicitRange, paint, index, start, end, next, resolvedValue };
      entry.value = read(entry);
      entry.previousBindings = JSON.stringify(node.boundVariables || {});
      entry.characters = node.characters;
      if (paint) {
        const values = range ? entry.value.map(run => run.fills) : [node[item.field]];
        if (values.some(paints => !Array.isArray(paints) || paints[index]?.type !== "SOLID")) throw new Error("Выберите существующую SOLID-заливку или обводку через paintIndex");
        entry.snapshot = await safety.prepare(node, item.field === "fills" ? { fills: [] } : { strokes: [] });
      } else if (range) {
        entry.snapshot = await safety.prepare(node, { [item.field]: item.field === "fontFamily" ? node.fontName?.family || "" : item.field === "fontWeight" ? node.fontName?.style || "" : node[item.field] });
      } else {
        const alias = node.boundVariables?.[item.field];
        if (alias && alias.type !== "VARIABLE_ALIAS") throw new Error("Смешанные привязки поля пока не поддержаны");
        entry.previousVariable = alias ? await variable(alias.id) : null;
        if (item.field === "characters") entry.snapshot = await safety.prepare(node, { content: node.characters });
        else if (item.field === "fontSize") entry.snapshot = await safety.prepare(node, { fontSize: node.fontSize });
        else if (["width", "height"].includes(item.field)) entry.snapshot = await safety.prepare(node, { [item.field]: node[item.field] });
      }
      if (range && next && ["fontFamily", "fontWeight"].includes(item.field)) {
        const families = projectedFamilies.get(node.id) || new Set(entry.value.map(run => run.fontName.family));
        if (item.field === "fontFamily") families.add(resolvedValue);
        projectedFamilies.set(node.id, families);
        // Figma resolves numeric weights to available styles. Load every exact
        // style in the involved families; never guess a weight-to-name mapping.
        if (typeof figma.listAvailableFontsAsync === "function") {
          fonts ||= await figma.listAvailableFontsAsync();
          for (const family of families) {
            const available = fonts.filter(font => font.fontName.family === family);
            if (!available.length) throw new Error("Недоступно семейство шрифта: " + family);
            for (const { fontName } of available) await safety.loadFont(fontName);
          }
        } else if (item.field === "fontWeight") throw new Error("Невозможно проверить начертания fontWeight: каталог шрифтов недоступен");
        else for (const run of entry.value) await safety.loadFont({ ...run.fontName, family: resolvedValue });
      }
      prepared.push(entry);
    }
    access.stablePage();
    for (const entry of prepared) {
      access.editable(entry.node, input.allowComponentChanges);
      if (entry.node.characters !== entry.characters || JSON.stringify(read(entry)) !== JSON.stringify(entry.value)) throw new Error("Свойство узла изменилось во время проверки: " + entry.node.id);
      if (JSON.stringify(entry.node.boundVariables || {}) !== entry.previousBindings) throw new Error("Привязки узла изменились во время проверки: " + entry.node.id);
    }
  } catch (error) { error.operationStatus = "not_applied"; throw error; }
  const rollback = [], applied = [];
  try {
    for (const entry of prepared) {
      access.stablePage();
      const { item, node, paint, index, next, snapshot, value, previousVariable, range, start, end } = entry;
      rollback.push(async () => {
        if (range || paint) await snapshot.restore();
        else {
          node.setBoundVariable(item.field, null);
          if (snapshot) await snapshot.restore(); else node[item.field] = access.copy(value);
          if (previousVariable) node.setBoundVariable(item.field, previousVariable);
        }
      });
      if (paint) {
        const runs = range ? segments(node, start, end) : [{ fills: node[item.field] }];
        for (const run of runs) {
          const paints = [...run.fills];
          paints[index] = figma.variables.setBoundVariableForPaint(paints[index], "color", next);
          if (range) node.setRangeFills(run.start, run.end, paints); else node[item.field] = paints;
        }
      } else if (range) node.setRangeBoundVariable(start, end, item.field, next);
      else node.setBoundVariable(item.field, next);
      applied.push({ nodeId: node.id, field: item.field, ...(paint ? { paintIndex: index } : {}), ...(entry.explicitRange ? { start, end } : {}), variableId: next?.id || null, ...(next ? { resolvedValue: entry.resolvedValue } : {}), actual: read(entry) });
    }
    access.stablePage();
    // Verify actual aliases after the entire batch, including every mixed run.
    for (const entry of prepared) {
      const {node,item,range,start,end,paint,index,next} = entry;
      const actual = read(entry);
      const aliases = paint ? (range ? actual.map(run => run.fills[index]?.boundVariables?.color) : [actual[index]?.boundVariables?.color])
        : range ? actual.map(run => run.boundVariables?.[item.field]) : [node.boundVariables?.[item.field]];
      if (aliases.some(alias => (alias?.id || null) !== (next?.id || null))) throw new Error("Привязка не подтверждена обратным чтением: " + node.id + "." + item.field);
      applied[prepared.indexOf(entry)].actual = actual;
    }
    return { bindings: applied, screenshotNodeId: applied[0]?.nodeId };
  } catch (error) { return await access.failWithRollback(error, rollback); }
}

export const buildBindVariablesCode = (input) => compileOperation(bindVariables, input, { mutationSafety: true });
