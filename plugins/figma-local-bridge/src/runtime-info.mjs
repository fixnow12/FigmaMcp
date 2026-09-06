import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';

const root = new URL('./', import.meta.url);
function digest(paths) {
  const hash = createHash('sha256');
  for (const path of paths) hash.update(path).update('\0').update(readFileSync(new URL(path, root))).update('\0');
  return hash.digest('hex').slice(0, 16);
}
export function sourceRevision() {
  return digest(readdirSync(root).filter(name => /\.(mjs|cjs)$/.test(name)).sort());
}
export function pluginRevision() {
  return digest(['figma-plugin/code.js', 'figma-plugin/ui.html', 'secure-channel.cjs']);
}
// Snapshot at process start: reading only the files on disk would hide a stale process.
export const runtimeInfo = { revision: sourceRevision(), startedAt: new Date().toISOString() };

export function runtimeDiagnostics(status) {
  const revision = sourceRevision();
  const expectedPlugin = pluginRevision();
  const warnings = [];
  if (runtimeInfo.revision !== revision) warnings.push('Исходники MCP обновлены после его запуска. Переподключите figma-local в OpenCode и откройте новый чат для обновления каталога инструментов.');
  if (status.runtime?.revision !== revision) warnings.push('Работающий broker отличается от исходников или не сообщает ревизию. После завершения операций перезапустите broker и MCP; новый чат сам по себе не обновляет broker.');
  for (const file of status.files || []) {
    if (file.pluginBuild !== expectedPlugin) warnings.push(`Плагин в файле ${file.fileName} не подтверждает актуальную сборку. Обновите персональную сборку установщиком и заново откройте Bridge в этом файле.`);
  }
  return { mcp: runtimeInfo, sourceRevision: revision, expectedPluginBuild: expectedPlugin, warnings,
    activityNote: 'isActive — последнее событие файла, а не проверка активной вкладки или готовности Plugin API.' };
}
