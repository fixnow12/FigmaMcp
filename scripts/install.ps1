param(
  [switch]$SkipCodex,
  [switch]$SkipOpenCodeCheck
)

$ErrorActionPreference = 'Stop'
$RepoRoot = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..')).Path
$PluginRoot = Join-Path $RepoRoot 'plugins\figma-local-bridge'


function Require-Command([string]$Name) {
  $command = Get-Command $Name -ErrorAction SilentlyContinue
  if (-not $command) { throw "Не найдена команда '$Name'." }
  return $command
}

Require-Command 'node' | Out-Null
Require-Command 'npm' | Out-Null
$NodeMajor = [int]((& node --version).Trim().TrimStart('v').Split('.')[0])
if ($NodeMajor -lt 20) { throw "Требуется Node.js 20+, найдена версия $(& node --version)." }

Write-Host 'Устанавливаю зависимости и запускаю проверки...'
Push-Location $PluginRoot
try {
  & npm ci --ignore-scripts
  if ($LASTEXITCODE -ne 0) { throw 'npm ci завершился с ошибкой.' }
  & npm test
  if ($LASTEXITCODE -ne 0) { throw 'Тесты завершились с ошибкой.' }
  $ManifestPath = & node scripts/prepare-install.mjs
  if ($LASTEXITCODE -ne 0) { throw 'Не удалось подготовить автоподключение.' }
  & npm run verify
  if ($LASTEXITCODE -ne 0) { throw 'Проверка MCP завершилась с ошибкой.' }
} finally {
  Pop-Location
}

& node (Join-Path $RepoRoot 'scripts\validate-repo.mjs')
if ($LASTEXITCODE -ne 0) { throw 'Проверка структуры репозитория завершилась с ошибкой.' }

if (-not $SkipCodex) {
  $Codex = Get-Command codex -ErrorAction SilentlyContinue
  if ($Codex) {
    Write-Host 'Регистрирую marketplace и плагин Codex...'
    & codex plugin marketplace add $RepoRoot --json
    if ($LASTEXITCODE -ne 0) { throw 'Не удалось зарегистрировать marketplace Codex.' }
    & codex plugin add 'figma-local-bridge@figma-mcp' --json
    if ($LASTEXITCODE -ne 0) { throw 'Не удалось установить или обновить плагин Codex.' }
    & node (Join-Path $PluginRoot 'scripts\verify-codex-install.mjs')
    if ($LASTEXITCODE -ne 0) { throw 'Проверка установленной копии MCP завершилась с ошибкой.' }
  } else {
    Write-Warning 'Codex не найден: его установка пропущена.'
  }
}

if (-not $SkipOpenCodeCheck -and -not (Get-Command opencode -ErrorAction SilentlyContinue)) {
  Write-Warning 'OpenCode не найден в PATH. Проект уже настроен; после установки запускайте START_OPENCODE.cmd.'
}

Write-Host ''
Write-Host 'Готово.' -ForegroundColor Green
Write-Host "Импортируйте в Figma Desktop manifest: $ManifestPath"
Write-Host "OpenCode: $RepoRoot\START_OPENCODE.cmd"
Write-Host 'Перезапустите AI-приложение и откройте Bridge — Auto в Figma. Сопряжение выполнится автоматически.'
