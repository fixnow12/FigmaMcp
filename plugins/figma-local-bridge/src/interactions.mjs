import { compileOperation } from "./scene-access.mjs";

// Serialized as one bounded operation. Preflight reads every target before writes.
async function setInteractions(figma, input, access) {
  const isText = Array.isArray(input.links);
  const prepared = new Map();
  const destinations = [];
  const snapshotLinks = node => access.copy(node.getStyledTextSegments(["hyperlink"]).map(({ start, end, hyperlink }) => ({ start, end, hyperlink: hyperlink || null })));
  const linkedRanges = node => snapshotLinks(node).filter(range => range.hyperlink !== null);
  const canonical = reactions => access.copy(reactions).map(({ action, actions, ...rest }) => ({ ...rest, actions: actions || (action ? [action] : []) }));
  const ordered = value => Array.isArray(value) ? value.map(ordered) : value && typeof value === "object"
    ? Object.fromEntries(Object.keys(value).sort().map(key => [key, ordered(value[key])])) : value;
  // Figma materializes resetVideoPosition:false for NODE actions when omitted.
  // Normalize only that known default for comparisons; true and unknown fields
  // must still reveal concurrent edits. Keep the requested write unchanged.
  const comparable = value => isText ? value : canonical(value).map(reaction => ({
    ...reaction,
    actions: reaction.actions.map(action => action.type === "NODE" ? { resetVideoPosition: false, ...action } : action),
  }));
  // Figma may also return both action and actions, with a different property order.
  const same = (a, b) => JSON.stringify(ordered(comparable(a))) === JSON.stringify(ordered(comparable(b)));
  const topFrame = node => {
    const frames = access.ancestors(node).filter(n => n.type === "FRAME" || n.type === "COMPONENT" || n.type === "INSTANCE");
    return frames[frames.length - 1];
  };
  const topLevel = node => node.type === "FRAME" && access.ancestors(node.parent).every(n => ["SECTION", "PAGE", "DOCUMENT"].includes(n.type));
  function validateDestination(node, target, action) {
    if (!target || target.removed) throw new Error("Цель ссылки удалена");
    if (isText) {
      if (target.type === "DOCUMENT" || access.ancestors(target.parent).some(n => n.type === "INSTANCE")) throw new Error("Цель ссылки не может быть документом или слоем внутри экземпляра");
    } else {
      access.onPage(target);
      if (action.navigation === "SCROLL_TO") {
        if (!topFrame(node) || topFrame(node) !== topFrame(target) || node === target || topFrame(target) === target) throw new Error("SCROLL_TO требует другой вложенный блок в том же экране");
      } else if (!topLevel(target) || topFrame(node) === target) {
        throw new Error("NAVIGATE/OVERLAY требует другой верхнеуровневый FRAME на той же странице");
      }
    }
  }
  function unchanged(entry) {
    access.editable(entry.node, input.allowComponentChanges);
    const current = isText ? snapshotLinks(entry.node) : entry.node.reactions;
    if ((isText && entry.node.characters !== entry.characters) || !same(current, entry.before)) throw new Error("Узел изменился во время проверки: " + entry.node.id);
  }
  try {
    for (const item of input.links || input.updates) {
      let entry = prepared.get(item.nodeId);
      if (!entry) {
        const node = await access.node(item.nodeId);
        access.editable(node, input.allowComponentChanges);
        if (isText ? node.type !== "TEXT" || typeof node.setRangeHyperlink !== "function" : typeof node.setReactionsAsync !== "function") throw new Error("Узел не поддерживает " + (isText ? "текстовые ссылки" : "прототипные переходы"));
        entry = { node, characters: isText ? node.characters : undefined, before: isText ? snapshotLinks(node) : access.copy(node.reactions), items: [] };
        prepared.set(item.nodeId, entry);
      }
      if (isText) {
        const start = item.start ?? 0; const end = item.end ?? entry.characters.length;
        if (start >= end || end > entry.characters.length) throw new Error("Диапазон ссылки выходит за границы непустого текста: " + item.nodeId);
        // Figma uses UTF-16 offsets; never split a surrogate pair.
        const split = index => index > 0 && index < entry.characters.length && /[\uD800-\uDBFF]/.test(entry.characters[index - 1]) && /[\uDC00-\uDFFF]/.test(entry.characters[index]);
        if (split(start) || split(end)) throw new Error("Диапазон разрезает символ UTF-16");
        if (item.target?.type === "NODE") {
          const target = await access.node(item.target.value);
          validateDestination(entry.node, target);
          destinations.push({ node: entry.node, target });
        }
        entry.items.push({ start, end, target: item.target });
      } else {
        for (const reaction of item.reactions) for (const action of reaction.actions) if (action.type === "NODE") {
          const target = await access.node(action.destinationId);
          validateDestination(entry.node, target, action);
          destinations.push({ node: entry.node, target, action });
        }
        const next = canonical(item.reactions);
        for (const reaction of next) for (const action of reaction.actions) if (action.type === "NODE") action.transition ??= null;
        const triggers = new Set(next.map(r => r.trigger.type));
        entry.next = item.mode === "replace" ? next : [...canonical(entry.before).filter(r => !triggers.has(r.trigger?.type)), ...next];
      }
    }
    access.stablePage();
    for (const entry of prepared.values()) unchanged(entry);
    for (const destination of destinations) validateDestination(destination.node, destination.target, destination.action);
  } catch (error) { error.operationStatus = "not_applied"; throw error; }
  if (input.dryRun) return { dryRun: true, validatedNodeIds: [...prepared.keys()], actualClicks: "not-tested" };
  const rollback = [];
  try {
    for (const entry of prepared.values()) {
      access.stablePage();
      unchanged(entry);
      for (const destination of destinations) validateDestination(destination.node, destination.target, destination.action);
      const { node, before } = entry;
      let lastWritten = before;
      rollback.push(async () => {
        const current = isText ? snapshotLinks(node) : node.reactions;
        if (same(current, before)) return;
        // Cancellation blocks new writes, but must not block restoration.
        if (figma.currentPage !== access.page) throw new Error("Страница изменилась; проверьте узел перед откатом: " + node.id);
        access.editable(node, input.allowComponentChanges);
        if (node.removed || !same(current, lastWritten)) throw new Error("Конфликт отката: узел изменён вне операции: " + node.id);
        if (isText) {
          if (node.characters !== entry.characters) throw new Error("Текст изменился; откат диапазонов небезопасен: " + node.id);
          for (const range of before) node.setRangeHyperlink(range.start, range.end, range.hyperlink);
        } else {
          await node.setReactionsAsync(canonical(before));
          if (!same(node.reactions, before)) throw new Error("Конфликт отката: переходы изменились при восстановлении: " + node.id);
        }
      });
      if (isText) {
        for (const item of entry.items) {
          node.setRangeHyperlink(item.start, item.end, item.target);
          lastWritten = snapshotLinks(node);
        }
      } else {
        // If the async setter rejects after changing state, restore only the
        // value we requested; unknown state is a conflict, never overwritten.
        lastWritten = entry.next;
        await node.setReactionsAsync(entry.next);
        if (!same(node.reactions, lastWritten)) throw new Error("Переходы изменились во время записи: " + node.id);
      }
      entry.expected = lastWritten;
    }
    access.stablePage();
    for (const entry of prepared.values()) {
      access.editable(entry.node, input.allowComponentChanges);
      const current = isText ? snapshotLinks(entry.node) : entry.node.reactions;
      if ((isText && entry.node.characters !== entry.characters) || !same(current, entry.expected)) throw new Error("Связи изменились до завершения пакета: " + entry.node.id);
    }
    const result = [...prepared.values()].map(({ node }) => isText ? { nodeId: node.id, hyperlinks: linkedRanges(node) } : { nodeId: node.id, reactions: access.copy(node.reactions) });
    return { [isText ? "links" : "updates"]: result, mutatedNodeIds: [...prepared.keys()], actualClicks: "not-tested", screenshotNodeId: result[0]?.nodeId };
  } catch (error) { return await access.failWithRollback(error, rollback); }
}

export const buildSetTextLinksCode = input => compileOperation(setInteractions, input);
export const buildSetReactionsCode = input => compileOperation(setInteractions, input);
