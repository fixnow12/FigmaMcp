import test from 'node:test';
import assert from 'node:assert/strict';
import { copyFile, mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { findSensitiveIdentifiers } from '../../../scripts/sensitive-data.mjs';

const root = fileURLToPath(new URL('../../../', import.meta.url));
const file = 'Ab9'.repeat(7) + 'Z';
const session = 'ses_' + 'x'.repeat(26);

test('находит Figma-ID в обычном тексте и ID сессии без раскрытия значений', () => {
  const result = findSensitiveIdentifiers('Живая проверка в файле `' + file + '`:\nСессия ' + session);
  assert.deepEqual(result, [
    { rule: 'figma-file-id', line: 1 },
    { rule: 'opencode-session-id', line: 2 },
  ]);
  assert.equal(JSON.stringify(result).includes(file), false);
  assert.equal(JSON.stringify(result).includes(session), false);
});

test('находит Figma-ID в URL, присваиваниях и русском обозначении файла', async t => {
  const cases = [
    ['JSON fileKey', JSON.stringify({ fileKey: file })],
    ['присваивание без кавычек', 'fileKey = ' + file],
    ['присваивание в одинарных кавычках', "fileKey = '" + file + "'"],
    ['присваивание в обратных кавычках', 'fileKey = `' + file + '`'],
    ['URL design', 'https://www.figma.com/design/' + file + '/Example?node-id=1-2'],
    ['URL file', 'http://figma.com/file/' + file + '?node-id=1-2'],
    ['URL proto', 'https://figma.com/proto/' + file + '#preview'],
    ['URL board', 'https://figma.com/board/' + file],
    ['Markdown URL без названия', '[Figma](https://figma.com/design/' + file + ')'],
    ['Markdown autolink', '<https://figma.com/file/' + file + '>'],
    ['URL в конце предложения', 'Макет: https://figma.com/proto/' + file + '.'],
    ['файл в двойных кавычках', 'Файл "' + file + '" открыт'],
    ['в файле в одинарных кавычках', "Проверено в файле '" + file + "'"],
    ['файл в обратных кавычках', 'файл `' + file + '`'],
  ];
  for (const [name, source] of cases) {
    await t.test(name, () => {
      assert.deepEqual(findSensitiveIdentifiers(source), [{ rule: 'figma-file-id', line: 1 }]);
    });
  }
});

test('находит OpenCode-ID в тексте и JSON', () => {
  assert.deepEqual(findSensitiveIdentifiers('Сессия: `' + session + '`\n' + JSON.stringify({ sessionID: session })), [
    { rule: 'opencode-session-id', line: 1 },
    { rule: 'opencode-session-id', line: 2 },
  ]);
});

test('считает строки CRLF и объединяет одинаковые правила в одной строке', () => {
  const source = '\r\n' + session + ' ' + session + ' файл `' + file + '` https://figma.com/design/' + file
    + '\r\nfileKey = "' + file + '"\r\n' + session;
  assert.deepEqual(findSensitiveIdentifiers(source), [
    { rule: 'opencode-session-id', line: 2 },
    { rule: 'figma-file-id', line: 2 },
    { rule: 'figma-file-id', line: 3 },
    { rule: 'opencode-session-id', line: 4 },
  ]);
});

test('повторные вызовы не теряют находки из-за состояния регулярных выражений', () => {
  const source = 'файл `' + file + '`\n' + session;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    assert.deepEqual(findSensitiveIdentifiers(source), [
      { rule: 'figma-file-id', line: 1 },
      { rule: 'opencode-session-id', line: 2 },
    ]);
    assert.deepEqual(findSensitiveIdentifiers('Обычный текст'), []);
  }
});

test('пропускает placeholders, API-свойства и идентификаторы вне известных контекстов', () => {
  const allowed = [
    '',
    '<FILE_KEY> <SESSION_ID_1> <SESSION_ID_2> <SESSION_ID_3>',
    'layoutSizingHorizontal allowComponentChanges',
    'fileKey = "<FILE_KEY>"',
    '{"fileKey":"<FILE_KEY>"}',
    'https://figma.com/design/<FILE_KEY>/Example',
    'Живая проверка в файле `<FILE_KEY>`',
    file,
    'fileKey = "short-example"',
    'sessionID = "ses_' + 'a'.repeat(5) + '"',
    'https://example.com/design/' + file,
    'https://figma.com.example.org/design/' + file,
    'https://figma.com/design/' + 'a'.repeat(65),
    'https://figma.com/design/' + file + '_unsupported',
  ];
  for (const source of allowed) assert.deepEqual(findSensitiveIdentifiers(source), []);
});

async function validatorFixture(t) {
  const temporary = await mkdtemp(join(tmpdir(), 'figma-sensitive-data-'));
  t.after(() => rm(temporary, { recursive: true, force: true }));
  const repository = join(temporary, 'repo');
  // Copy only the validator and its required public metadata, never local exports or shortcuts.
  for (const relativePath of [
    'scripts/validate-repo.mjs',
    'scripts/sensitive-data.mjs',
    'opencode.json',
    '.agents/plugins/marketplace.json',
    'plugins/figma-local-bridge/.codex-plugin/plugin.json',
    'plugins/figma-local-bridge/.mcp.json',
    'plugins/figma-local-bridge/package.json',
    'plugins/figma-local-bridge/src/figma-plugin/manifest.template.json',
  ]) {
    const destination = join(repository, relativePath);
    await mkdir(dirname(destination), { recursive: true });
    await copyFile(join(root, relativePath), destination);
  }
  await mkdir(join(repository, 'docs'), { recursive: true });
  const document = join(repository, 'docs', 'probe.md');
  const run = () => {
    const result = spawnSync(process.execPath, [join(repository, 'scripts', 'validate-repo.mjs')], {
      cwd: repository,
      encoding: 'utf8',
      timeout: 10_000,
    });
    assert.equal(result.error, undefined);
    assert.equal(result.signal, null);
    return { status: result.status, output: result.stdout + result.stderr };
  };
  return { temporary, repository, document, run };
}

test('валидатор отклоняет ID, выводит только путь/строку/правило и принимает placeholders', async t => {
  const { document, run } = await validatorFixture(t);
  const unsafe = 'Диагностика\nВ файле `' + file + '`\nСессия ' + session;
  await writeFile(document, unsafe);
  let result = run();
  assert.equal(result.status, 1);
  assert.equal(result.output.includes(document + ':2: figma-file-id'), true);
  assert.equal(result.output.includes(document + ':3: opencode-session-id'), true);
  assert.equal(result.output.includes(file), false);
  assert.equal(result.output.includes(session), false);

  await writeFile(document, 'В файле `<FILE_KEY>`\nСессия <SESSION_ID_1>');
  result = run();
  assert.equal(result.status, 0);

  await writeFile(document, unsafe);
  result = run();
  assert.equal(result.status, 1);
  assert.equal(result.output.includes(file), false);
  assert.equal(result.output.includes(session), false);
});

test('валидатор отклоняет Figma URL в Markdown и рядом с пунктуацией', async t => {
  const { document, run } = await validatorFixture(t);
  for (const source of [
    '[Figma](https://figma.com/design/' + file + ')',
    '<https://figma.com/file/' + file + '>',
    'Макет: https://figma.com/proto/' + file + '.',
  ]) {
    await writeFile(document, source);
    const result = run();
    assert.equal(result.status, 1);
    assert.equal(result.output.includes(document + ':1: figma-file-id'), true);
    assert.equal(result.output.includes(file), false);
  }
});

test('валидатор сохраняет проверки токенов и маркеров приватного ключа', async t => {
  const { document, run } = await validatorFixture(t);
  for (const value of [
    'github' + '_pat_' + 'a'.repeat(24),
    'gh' + 'p_' + 'b'.repeat(32),
    'sk' + '-' + 'c'.repeat(24),
    'fig' + 'd_' + 'd'.repeat(24),
    '-----BEGIN ' + 'PRIVATE KEY-----',
  ]) {
    await writeFile(document, value);
    const result = run();
    assert.equal(result.status, 1);
    assert.equal(result.output.includes(document + ': возможный секрет'), true);
    if (!value.startsWith('-----')) assert.equal(result.output.includes(value), false);
  }
});

test('валидатор сохраняет исключения локальных каталогов', async t => {
  const { repository, document, run } = await validatorFixture(t);
  const unsafe = 'В файле `' + file + '`\n' + session;
  for (const name of ['.git', '.tmp-figma', 'node_modules', 'migration-backup', 'dist']) {
    await mkdir(join(repository, name), { recursive: true });
    await writeFile(join(repository, name, 'probe.md'), unsafe);
  }
  assert.equal(run().status, 0);
  await writeFile(document, unsafe);
  assert.equal(run().status, 1);
});

test('валидатор не следует по symlink во внешние временные файлы и каталоги', async t => {
  const { temporary, repository, document, run } = await validatorFixture(t);
  const external = join(temporary, 'external');
  await mkdir(external);
  const externalDocument = join(external, 'probe.md');
  const unsafe = 'В файле `' + file + '`\n' + session;
  await writeFile(externalDocument, unsafe);
  await symlink(external, join(repository, 'linked-directory'), process.platform === 'win32' ? 'junction' : 'dir');
  // Windows junctions do not require developer mode; file symlinks do.
  if (process.platform !== 'win32') await symlink(externalDocument, join(repository, 'linked-file.md'), 'file');
  assert.equal(run().status, 0);
  await writeFile(document, unsafe);
  assert.equal(run().status, 1);
});
