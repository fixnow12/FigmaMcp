import { spawn } from 'node:child_process';
import { readdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { once } from 'node:events';

const root = dirname(fileURLToPath(new URL('../package.json', import.meta.url)));
const testsDirectory = join(root, 'tests');
const files = (await readdir(testsDirectory))
  .filter(file => file.endsWith('.test.mjs'))
  .sort()
  .map(file => join(testsDirectory, file));

if (!files.length) throw new Error(`Не найдены unit-тесты: ${testsDirectory}`);

const child = spawn(process.execPath, ['--test', ...files], {
  cwd: root,
  stdio: 'inherit',
  windowsHide: true,
});
const [code, signal] = await once(child, 'close');
if (signal) throw new Error(`Тесты завершились по сигналу ${signal}`);
process.exitCode = code ?? 1;
