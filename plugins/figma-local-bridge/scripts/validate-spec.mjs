// Offline validation only: no MCP connection, font loading, or canvas access.
import { readFile } from 'node:fs/promises';
import { parseRenderScreenInput, normalizeScreenSpec } from '../src/schemas.mjs';
import { analyzeNormalizedGeometry } from '../src/geometry-analysis.mjs';

try {
  if (process.argv.length !== 3) throw new Error('Использование: node scripts/validate-spec.mjs <spec.json или render-args.json>');
  const input = JSON.parse(await readFile(process.argv[2], 'utf8'));
  const parsed = parseRenderScreenInput(input && Object.hasOwn(input, 'spec') ? input : { spec: input });
  const normalized = normalizeScreenSpec(parsed.spec);
  const geometry = analyzeNormalizedGeometry(normalized);
  console.log(JSON.stringify({ valid: true, key: parsed.spec.key, nodes: parsed.spec.nodes.length,
    geometryWarnings: geometry.warnings,
    geometryWarningCount: geometry.totalWarnings,
    geometryWarningsTruncated: geometry.truncated,
    fonts: 'not_checked', layout: 'not_checked', visual: 'not_checked',
    nextStep: geometry.totalWarnings
      ? 'Исправьте или явно проверьте предупреждения геометрии, затем выполните render_screen с dryRun:true в целевом fileKey.'
      : 'Проверьте render_screen с dryRun:true в целевом fileKey для проверки свойств, раскладки и шрифтов.' }, null, 2));
} catch (error) {
  const errors = error.issues?.map(issue => ({ path: issue.path.join('.'), message: issue.message }))
    || [{ path: '', message: error.message }];
  console.log(JSON.stringify({ valid: false, errors, fonts: 'not_checked', layout: 'not_checked', visual: 'not_checked',
    nextStep: 'Исправьте указанные поля. spec.nodes — один плоский массив; вложенность задаётся parentKey. Вложенные nodes/children и неизвестные поля не поддерживаются.' }, null, 2));
  process.exitCode = 1;
}
