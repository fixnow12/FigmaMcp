param(
  [switch]$SkipCodex,
  [switch]$SkipOpenCodeCheck
)

$ErrorActionPreference = 'Stop'
$RepoRoot = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..')).Path
$PluginRoot = Join-Path $RepoRoot 'plugins\figma-local-bridge'
$ManifestPath = Join-Path $PluginRoot 'figma-plugin\manifest.json'

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
    if ($LASTEXITCODE -ne 0) {
      $marketplaces = (& codex plugin marketplace list 2>&1 | Out-String)
      if ($marketplaces -notmatch 'figma-mcp') { throw 'Не удалось зарегистрировать marketplace Codex.' }
    }
    & codex plugin add 'figma-local-bridge@figma-mcp' --json
    if ($LASTEXITCODE -ne 0) {
      $plugins = (& codex plugin list 2>&1 | Out-String)
      if ($plugins -notmatch 'figma-local-bridge') { throw 'Не удалось установить плагин Codex.' }
    }
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
Write-Host 'После установки или обновления плагина перезапустите Codex.'
