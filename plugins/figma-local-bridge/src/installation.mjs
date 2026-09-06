import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { lstat, readFile, mkdir, open, rename, unlink } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import channel from './secure-channel.cjs';

export const installationDirectory = () => resolve(process.env.FIGMA_LOCAL_STATE_DIR || join(homedir(), '.figma-local-bridge'));

function windowsPermissions(path, set = false) {
  const script = `
$ErrorActionPreference = 'Stop'
$path = $env:FIGMA_PRIVATE_PATH
$sid = [System.Security.Principal.WindowsIdentity]::GetCurrent().User
$system = New-Object System.Security.Principal.SecurityIdentifier('S-1-5-18')
$item = Get-Item -LiteralPath $path -Force
$acl = $item.GetAccessControl()
${set ? `
$acl = New-Object System.Security.AccessControl.DirectorySecurity
$acl.SetOwner($sid)
$acl.SetAccessRuleProtection($true, $false)
foreach ($principal in @($sid, $system)) {
  $rule = New-Object System.Security.AccessControl.FileSystemAccessRule($principal, 'FullControl', 'ContainerInherit,ObjectInherit', 'None', 'Allow')
  $acl.AddAccessRule($rule)
}
$item.SetAccessControl($acl)
$acl = $item.GetAccessControl()
` : ''}
if ($acl.GetOwner([System.Security.Principal.SecurityIdentifier]).Value -ne $sid.Value) { throw 'Installation must belong to the current user' }
foreach ($rule in $acl.GetAccessRules($true, $true, [System.Security.Principal.SecurityIdentifier])) {
  if ($rule.AccessControlType -eq 'Allow' -and $rule.IdentityReference.Value -notin @($sid.Value, $system.Value)) { throw 'Installation permissions are not private' }
}
`;
  execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')], {
    env: { ...process.env, FIGMA_PRIVATE_PATH: path }, stdio: 'pipe', windowsHide: true,
  });
}

export async function assertPrivate(path, directory = false) {
  const info = await lstat(path);
  if (info.isSymbolicLink() || (directory ? !info.isDirectory() : !info.isFile())) throw new Error(`Небезопасный путь установки: ${path}`);
  if (process.platform !== 'win32' && (info.uid !== process.getuid() || (info.mode & 0o077))) throw new Error(`Нужны права только текущего пользователя: ${path}`);
  if (process.platform === 'win32') windowsPermissions(path);
}

export async function privateDirectory(path) {
  try { await mkdir(path, { mode: 0o700 }); } catch (error) { if (error.code !== 'EEXIST') throw error; }
  const info = await lstat(path);
  if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('Небезопасный каталог установки');
  if (process.platform === 'win32') windowsPermissions(path, true);
  await assertPrivate(path, true);
}

export async function privateWrite(path, value) {
  const temporary = `${path}.${channel.newSeed().slice(0, 16)}.tmp`;
  const file = await open(temporary, 'wx', 0o600);
  try {
    await file.writeFile(value);
    await file.sync();
    await file.close();
    await rename(temporary, path);
  } finally { await file.close().catch(() => {}); await unlink(temporary).catch(() => {}); }
}

export function validateInstallation(data) {
  if (data?.version !== 2) throw new Error('Несовместимая установка Bridge. Повторите установку.');
  for (const role of ['server', 'plugin', 'mcp']) channel.publicKey(data[role]);
  if (new Set([data.server, data.plugin, data.mcp]).size !== 3) throw new Error('Ключи ролей должны различаться');
  return data;
}

export async function loadInstallation(directory = installationDirectory()) {
  try {
    await assertPrivate(directory, true);
    await assertPrivate(join(directory, 'identity.json'));
    return validateInstallation(JSON.parse(await readFile(join(directory, 'identity.json'), 'utf8')));
  } catch (error) {
    if (error.code === 'ENOENT') throw new Error('Автоподключение ещё не установлено. Запустите scripts/install.sh (macOS) или scripts/install.ps1 (Windows), затем импортируйте созданный manifest в Figma.');
    throw error;
  }
}

export function identityFor(data, role) {
  if (role === 'server') return { seed: data.server, peers: { plugin: channel.publicKey(data.plugin), mcp: channel.publicKey(data.mcp) } };
  if (!['mcp', 'plugin'].includes(role)) throw new Error('Unknown role');
  return { role, seed: data[role], serverKey: channel.publicKey(data.server) };
}
