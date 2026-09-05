import { createMutationSafety } from "./mutation-safety.mjs";

// Self-contained helpers serialized into generated Plugin API operations.
export function createSceneAccess(figma, check) {
  const page = figma.currentPage;
  const dataKey = "codex-spec-key";
  const copy = (value) => value === undefined || typeof value === "symbol" ? value : JSON.parse(JSON.stringify(value));
  async function node(id) {
    const result = await figma.getNodeByIdAsync(id);
    check();
    if (!result || result.removed) throw new Error("Узел не найден: " + id);
    return result;
  }
  function ancestors(node) {
    const result = [];
    for (let current = node; current; current = current.parent) result.push(current);
    return result;
  }
  function onPage(node) {
    if (!node) throw new Error("Узел или его родитель недоступен");
    if (!ancestors(node).includes(page)) throw new Error("Узел находится на другой странице: " + node.id);
  }
  function editable(node, allowComponentChanges = false) {
    onPage(node);
    if (!allowComponentChanges && ancestors(node).some((item) => item.type === "COMPONENT" || item.type === "COMPONENT_SET")) {
      throw new Error("Изменение затронет исходный компонент. Используйте экземпляр; для правки оригинала требуется подтверждение пользователя и allowComponentChanges.");
    }
  }
  function structural(node) {
    editable(node);
    if (ancestors(node.parent).some((item) => item.type === "INSTANCE")) throw new Error("Нельзя менять структуру внутри экземпляра: " + node.id);
    if (node.findAll?.((child) => child.type === "COMPONENT" || child.type === "COMPONENT_SET").length) throw new Error("Узел содержит определения компонентов; изменение их структуры не разрешено");
  }
  function parent(node) {
    editable(node);
    if (!["PAGE", "FRAME", "SECTION"].includes(node.type) || typeof node.insertChild !== "function") {
      throw new Error("Родителем должен быть PAGE, FRAME или SECTION: " + node.id);
    }
    if (ancestors(node).some((item) => item.type === "INSTANCE")) throw new Error("Нельзя вставлять узлы внутрь экземпляра");
  }
  function placement(node, parent, position) {
    const auto = parent.layoutMode && parent.layoutMode !== "NONE";
    if (!auto && [node.layoutSizingHorizontal, node.layoutSizingVertical].includes("FILL")) throw new Error("Fill требует родителя с Auto Layout: " + node.id);
    if (position && auto && node.layoutPositioning !== "ABSOLUTE") throw new Error("Позицию в Auto Layout задавайте через index, а не x/y");
  }
  function stablePage() {
    check();
    if (figma.currentPage !== page) throw new Error("Страница изменилась во время проверки. Повторите чтение.");
  }
  async function failWithRollback(error, rollback) {
    const errors = [];
    for (const restore of [...rollback].reverse()) {
      try { await restore(); } catch (failure) { errors.push(failure.message); }
    }
    error.operationStatus = errors.length ? "partial" : "rolled_back";
    error.rollbackErrors = errors;
    throw error;
  }
  return { page, dataKey, copy, node, ancestors, onPage, editable, structural, parent, placement, stablePage, check, failWithRollback };
}

export function compileOperation(operation, input, { mutationSafety = false } = {}) {
  const json = JSON.stringify(input).replaceAll("</", "<\\/");
  return `const safety = ${mutationSafety ? `(${createMutationSafety.toString()})(figma)` : "null"};
  const access = (${createSceneAccess.toString()})(figma, () => {
    if (typeof executionControl !== "undefined" && executionControl.cancelled) throw new Error("Время операции истекло");
  });
  return await (${operation.toString()})(figma, ${json}, access, safety);`;
}
