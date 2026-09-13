import { z } from 'zod';
import { compileOperation } from './scene-access.mjs';
import { fileKeyDescription } from './file-target.mjs';

const id = z.string().min(1).max(160);
const pageIds = z.array(id).min(1).max(100).refine(ids => new Set(ids).size === ids.length, 'Повторяющиеся PAGE ID');
export const getPageSettingsInputSchema = { fileKey: id.describe(fileKeyDescription), pageIds: pageIds.optional() };
export const getPageSettingsSchema = z.object(getPageSettingsInputSchema).strict();
export const setPageSettingsInputSchema = {
  fileKey: id.describe(fileKeyDescription), pageIds,
  background: z.object({ color: z.string().regex(/^#[0-9a-fA-F]{6}$/), opacity: z.number().min(0).max(1) }).strict().optional(),
  variableModes: z.array(z.object({ collectionKey: id, anchorVariableKey: id, modeName: id }).strict()).min(1).max(20)
    .refine(modes => new Set(modes.map(m => m.collectionKey)).size === modes.length, 'Повторяющаяся коллекция').optional(),
};
export const setPageSettingsSchema = z.object(setPageSettingsInputSchema).strict().refine(input => input.background || input.variableModes, 'Укажите фон или режимы');

async function pageSettings(figma, input, access) {
  const copy = access.copy;
  const equal = (a, b) => JSON.stringify(a) === JSON.stringify(b);
  const fail = message => { throw Object.assign(new Error(message), { operationStatus: 'not_applied' }); };
  const inventory = [...figma.root.children].filter(p => p.type === 'PAGE');
  const pages = [];
  const collections = new Map();
  const modes = [];
  async function collectionById(id) {
    if (!collections.has(id)) {
      const c = await access.read(figma.variables.getVariableCollectionByIdAsync(id), 'коллекция ' + id);
      if (!c) fail('Коллекция недоступна: ' + id);
      collections.set(id, c);
    }
    return collections.get(id);
  }
  async function readPages() {
    const result = [];
    for (const p of pages) {
      const explicit = copy(p.explicitVariableModes);
      if (!Array.isArray(p.backgrounds) || !explicit || typeof explicit !== 'object') fail('PAGE_SETTINGS_UNSUPPORTED: фон или режимы страницы недоступны');
      const entries = [];
      for (const [id, modeId] of Object.entries(explicit)) {
        const c = await collectionById(id);
        const mode = c.modes.find(m => m.modeId === modeId);
        if (!mode) fail('Режим недоступен: ' + modeId);
        entries.push({ collectionId: c.id, collectionKey: c.key, collectionName: c.name, modeId, modeName: mode.name });
      }
      result.push({ id: p.id, name: p.name, backgrounds: copy(p.backgrounds), explicitVariableModes: entries });
    }
    return { pages: result };
  }
  try {
    for (const id of input.pageIds || inventory.map(p => p.id)) {
      const p = await access.node(id);
      if (p.type !== 'PAGE' || !inventory.includes(p)) fail('Настройки разрешены только для PAGE текущего файла: ' + id);
      await access.read(p.loadAsync(), 'страница ' + id);
      pages.push(p);
    }
    if (input.mode === 'read') return await readPages();
    // Imports only make the existing library resource available; no collection/value setters are used.
    for (const requested of input.variableModes || []) {
      const v = await access.read(figma.variables.importVariableByKeyAsync(requested.anchorVariableKey), 'импорт переменной');
      if (v?.key !== requested.anchorVariableKey) fail('Неверная импортированная переменная');
      const c = await collectionById(v.variableCollectionId);
      if (c.key !== requested.collectionKey) fail('Ключ коллекции не совпал');
      const matches = c.modes.filter(m => m.name === requested.modeName);
      if (matches.length !== 1) fail('VARIABLE_MODE_UNAVAILABLE: ' + requested.modeName);
      modes.push({ collection: c, modeId: matches[0].modeId });
    }
    await readPages();
    for (const p of pages) {
      if (modes.length && (typeof p.setExplicitVariableModeForCollection !== 'function' || typeof p.clearExplicitVariableModeForCollection !== 'function')) fail('PAGE_SETTINGS_UNSUPPORTED: явные режимы недоступны');
    }
    access.check();
    if (inventory.length !== figma.root.children.length || inventory.some((p, i) => figma.root.children[i] !== p || p.removed)) fail('Список страниц изменился до записи');
  } catch (error) { error.operationStatus = 'not_applied'; throw error; }
  const rollback = [];
  try {
    for (const p of pages) {
      if (input.background) {
        const color = input.background.color;
        const wanted = [{ type: 'SOLID', color: { r: parseInt(color.slice(1, 3), 16) / 255, g: parseInt(color.slice(3, 5), 16) / 255, b: parseInt(color.slice(5, 7), 16) / 255 }, opacity: input.background.opacity }];
        const before = copy(p.backgrounds);
        if (!equal(before, wanted)) {
          let written = wanted;
          rollback.push(() => {
            if (equal(p.backgrounds, before)) return;
            if (!equal(p.backgrounds, written)) throw new Error('Конфликт отката фона ' + p.id);
            p.backgrounds = before;
            if (!equal(p.backgrounds, before)) throw new Error('Фон не восстановился ' + p.id);
          });
          p.backgrounds = wanted;
          written = copy(p.backgrounds); // Figma can materialize paint defaults.
          const paint = written[0];
          if (written.length !== 1 || paint.type !== 'SOLID' || (paint.opacity ?? 1) !== input.background.opacity || ['r','g','b'].some(k => Math.abs(paint.color[k] - wanted[0].color[k]) > 1e-6)) throw new Error('Фон не совпал после записи');
        }
      }
      for (const { collection: c, modeId } of modes) {
        const before = p.explicitVariableModes[c.id];
        if (before === modeId) continue;
        rollback.push(() => {
          const current = p.explicitVariableModes[c.id];
          if (current === before) return;
          if (current !== modeId) throw new Error('Конфликт отката режима ' + p.id);
          if (before === undefined) p.clearExplicitVariableModeForCollection(c);
          else p.setExplicitVariableModeForCollection(c, before);
          if (p.explicitVariableModes[c.id] !== before) throw new Error('Режим не восстановился');
        });
        p.setExplicitVariableModeForCollection(c, modeId);
        if (p.explicitVariableModes[c.id] !== modeId) throw new Error('Режим не совпал после записи');
      }
    }
    access.check();
    return await readPages();
  } catch (error) { return await access.failWithRollback(error, rollback); }
}

export const buildGetPageSettingsCode = input => compileOperation(pageSettings, { ...input, mode: 'read' }, { readOnly: true });
export const buildSetPageSettingsCode = input => compileOperation(pageSettings, { ...input, mode: 'write' });
