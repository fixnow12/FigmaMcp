import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile, mkdtemp, rm } from 'node:fs/promises';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { promisify } from 'node:util';
import { execFile } from 'node:child_process';
import { designSchemaText } from '../scripts/export-schema.mjs';

const exec = promisify(execFile);
const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');

test('опубликованная JSON Schema соответствует текущему генератору', async () => {
  const schema = await readFile(new URL('../schemas/design-spec.schema.json', import.meta.url), 'utf8');
  assert.equal(schema, designSchemaText());
});

test('OpenCode launcher сохраняет cwd, аргументы и код завершения', async t => {
  const temporary = await mkdtemp(join(tmpdir(), 'figma-launcher-'));
  t.after(() => rm(temporary, { recursive: true, force: true }));
  const windows = process.platform === 'win32';
  const shim = join(temporary, windows ? 'opencode.cmd' : 'opencode');
  await writeFile(shim, windows ? '@echo off\r\necho %CD%\r\necho %1\r\nexit /b 37\r\n' : '#!/bin/sh\nprintf "%s\\n" "$PWD" "$1"\nexit 37\n', { mode: 0o700 });
  const env = { ...process.env };
  const pathKey = Object.keys(env).find(k => k.toLowerCase() === 'path') || 'PATH';
  env[pathKey] = temporary + (windows ? ';' : ':') + (env[pathKey] || '');
  const command = windows ? process.env.ComSpec || 'cmd.exe' : 'bash';
  const args = windows ? ['/d', '/s', '/c', `""${join(root, 'START_OPENCODE.cmd')}" probe"`] : [join(root, 'scripts/start-opencode.sh'), 'probe'];
  await assert.rejects(exec(command, args, { cwd: temporary, env }), error => {
    assert.equal(error.code, 37, JSON.stringify({ code: error.code, stdout: error.stdout, stderr: error.stderr }));
    assert.deepEqual(error.stdout.trim().split(/\r?\n/), [root, 'probe']);
    return true;
  });
});
