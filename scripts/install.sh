#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
plugin_root="$repo_root/plugins/figma-local-bridge"
manifest_path="$plugin_root/figma-plugin/manifest.json"

command -v node >/dev/null 2>&1 || { echo "Не найден Node.js." >&2; exit 1; }
command -v npm >/dev/null 2>&1 || { echo "Не найден npm." >&2; exit 1; }
node_major="$(node --version | sed 's/^v//' | cut -d. -f1)"
if [ "$node_major" -lt 20 ]; then
  echo "Требуется Node.js 20+, найдена версия $(node --version)." >&2
  exit 1
fi

printf '%s\n' 'Устанавливаю зависимости и запускаю проверки...'
(
  cd "$plugin_root"
  npm ci --ignore-scripts
  npm test
  npm run verify
)
node "$repo_root/scripts/validate-repo.mjs"

if [ "${SKIP_CODEX:-0}" != "1" ]; then
  if command -v codex >/dev/null 2>&1; then
    printf '%s\n' 'Регистрирую marketplace и плагин Codex...'
    codex plugin marketplace add "$repo_root" --json || codex plugin marketplace list | grep -q 'figma-mcp'
    codex plugin add 'figma-local-bridge@figma-mcp' --json || codex plugin list | grep -q 'figma-local-bridge'
  else
    printf '%s\n' 'Предупреждение: Codex не найден, установка плагина пропущена.' >&2
  fi
fi

if [ "${SKIP_OPENCODE_CHECK:-0}" != "1" ] && ! command -v opencode >/dev/null 2>&1; then
  printf '%s\n' 'Предупреждение: OpenCode не найден в PATH. Проект уже настроен.' >&2
fi

printf '\n%s\n' 'Готово.'
printf 'Импортируйте в Figma Desktop manifest: %s\n' "$manifest_path"
printf 'OpenCode: %s/scripts/start-opencode.sh\n' "$repo_root"
printf '%s\n' 'После установки или обновления плагина перезапустите Codex.'
