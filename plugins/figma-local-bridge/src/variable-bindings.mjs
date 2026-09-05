import { compileOperation } from "./scene-access.mjs";

async function bindVariables(figma, input, access, safety) {
  const prepared = [];
  const variables = new Map();
  async function variable(id) {
    if (id === null) return null;
    if (!variables.has(id)) variables.set(id, await figma.variables.getVariableByIdAsync(id));
    const result = variables.get(id);
    if (!result) throw new Error("Переменная недоступна в файле: " + id);
    return result;
  }
  try {
    for (const item of input.bindings) {
      const node = await access.node(item.nodeId);
      access.editable(node, input.allowComponentChanges);
      const paint = item.field === "fills" || item.field === "strokes";
      if (!(item.field in node) || (!paint && typeof node.setBoundVariable !== "function")) throw new Error("Узел не поддерживает поле " + item.field);
      if (node[item.field] === figma.mixed) throw new Error("Поле содержит смешанные значения; выберите отдельный текстовый диапазон или слой");
      const next = await variable(item.variableId);
      const expectedType = paint ? "COLOR" : item.field === "visible" ? "BOOLEAN" : item.field === "characters" ? "STRING" : "FLOAT";
      if (next && next.resolvedType !== expectedType) throw new Error("Поле " + item.field + " требует переменную типа " + expectedType);
      let resolvedValue;
      if (next) {
        resolvedValue = next.resolveForConsumer(node).value;
        if (expectedType === "FLOAT") {
          const positive = ["width", "height", "fontSize"].includes(item.field);
          if (typeof resolvedValue !== "number" || !Number.isFinite(resolvedValue) || resolvedValue < 0 || (positive && resolvedValue === 0) || (item.field === "opacity" && resolvedValue > 1)) {
            throw new Error("Значение переменной несовместимо с полем " + item.field);
          }
        }
      }
      const index = item.paintIndex ?? 0;
      let snapshot;
      let previousVariable = null;
      const value = access.copy(node[item.field]);
      const previousBindings = JSON.stringify(node.boundVariables || {});
      if (paint) {
        if (!Array.isArray(node[item.field]) || node[item.field][index]?.type !== "SOLID") throw new Error("Выберите существующую SOLID-заливку или обводку через paintIndex");
        snapshot = await safety.prepare(node, item.field === "fills" ? { background: "#000000" } : { stroke: "#000000" });
      } else {
        const alias = node.boundVariables?.[item.field];
        if (alias && alias.type !== "VARIABLE_ALIAS") throw new Error("Смешанные привязки поля пока не поддержаны");
        previousVariable = alias ? await variable(alias.id) : null;
        if (item.field === "characters") snapshot = await safety.prepare(node, { content: node.characters });
        else if (item.field === "fontSize") snapshot = await safety.prepare(node, { fontSize: node.fontSize });
        else if (["width", "height"].includes(item.field)) snapshot = await safety.prepare(node, { [item.field]: node[item.field] });
      }
      prepared.push({ item, node, paint, index, next, resolvedValue, snapshot, value, previousVariable, previousBindings });
    }
    access.stablePage();
    for (const { node, item, value, previousBindings } of prepared) {
      access.editable(node, input.allowComponentChanges);
      if (JSON.stringify(node[item.field]) !== JSON.stringify(value)) throw new Error("Свойство узла изменилось во время проверки: " + node.id + "." + item.field);
      if (JSON.stringify(node.boundVariables || {}) !== previousBindings) throw new Error("Привязки узла изменились во время проверки: " + node.id);
    }
  } catch (error) {
    error.operationStatus = "not_applied";
    throw error;
  }
  const rollback = [];
  const applied = [];
  try {
    for (const entry of prepared) {
      access.check();
      const { item, node, paint, index, next, snapshot, value, previousVariable } = entry;
      rollback.push(async () => {
        if (paint) {
          await snapshot.restore();
        } else {
          node.setBoundVariable(item.field, null);
          if (snapshot) await snapshot.restore();
          else node[item.field] = access.copy(value);
          if (previousVariable) node.setBoundVariable(item.field, previousVariable);
        }
      });
      if (paint) {
        const paints = [...node[item.field]];
        paints[index] = figma.variables.setBoundVariableForPaint(paints[index], "color", next);
        node[item.field] = paints;
      } else {
        node.setBoundVariable(item.field, next);
      }
      applied.push({ nodeId: node.id, field: item.field, ...(paint ? { paintIndex: index } : {}), variableId: next?.id || null, ...(next ? { resolvedValue: entry.resolvedValue } : {}) });
    }
    access.check();
    return { bindings: applied, screenshotNodeId: applied[0]?.nodeId };
  } catch (error) {
    return await access.failWithRollback(error, rollback);
  }
}

export const buildBindVariablesCode = (input) => compileOperation(bindVariables, input, { mutationSafety: true });
