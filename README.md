# FigmaMcp

Локальный мост **Codex/OpenCode → Figma Desktop** для чтения и изменения макетов без браузерной автоматизации и без Figma API-токена.

```text
Codex или OpenCode
        ↓ STDIO MCP
figma-local: 4 типизированных инструмента
        ↓ WebSocket 127.0.0.1:9223–9232
Figma Desktop Bridge
        ↓ Figma Plugin API
Figma Canvas
```

Репозиторий оформлен как гибрид:

- MCP-сервер выполняет операции;
- общий навык задаёт безопасный рабочий процесс агенту;
- Codex-плагин устанавливает MCP и навык вместе;
- `opencode.json` подключает тот же сервер и тот же навык в OpenCode;
- development-плагин Figma обеспечивает локальную связь с открытым файлом.

## Возможности

Сервер публикует ровно четыре инструмента:

- `inspect_selection` — компактно читает выделение и при необходимости возвращает PNG;
- `patch_nodes` — пакетно меняет существующие узлы по стабильным ключам;
- `render_screen` — создаёт экран из типизированной JSON-спецификации;
- `use_component` — вставляет экземпляр локального или библиотечного компонента.

Произвольный JavaScript наружу не выставлен. Каждый создаваемый узел получает стабильный `key`, поэтому точечные итерации не зависят от временных Figma node ID.

## Требования

- Windows 10/11 или macOS;
- Node.js 20 или новее;
- Figma Desktop;
- Codex и/или OpenCode.

## Установка

Клонируйте репозиторий:

```bash
git clone https://github.com/fixnow12/FigmaMcp.git
cd FigmaMcp
```

### Windows

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\install.ps1
```

### macOS

```bash
chmod +x scripts/install.sh scripts/start-opencode.sh
./scripts/install.sh
```

Установщик ставит npm-зависимости без lifecycle-скриптов, запускает тесты, проверяет контракт MCP и при наличии Codex регистрирует локальный marketplace и плагин. OpenCode использует проектный `opencode.json`, поэтому его глобальные MCP-настройки не меняются.

## Подключение Figma Desktop

1. Откройте Figma Desktop.
2. Выберите **Plugins → Development → Import plugin from manifest…**.
3. Укажите файл `plugins/figma-local-bridge/figma-plugin/manifest.json` из клонированного репозитория.
4. Откройте целевой Figma-файл.
5. Запустите **Plugins → Development → Figma Desktop Bridge** и оставьте окно плагина открытым.

Статус плагина должен стать `READY`. Сервер слушает только IPv4 loopback `127.0.0.1`; не публикуйте порты `9223–9232` во внешнюю сеть.

## Codex

После установщика перезапустите Codex и откройте проект. Плагин `figma-local-bridge` добавляет MCP и навык автоматически.

Ручная установка из клонированного репозитория:

```bash
codex plugin marketplace add .
codex plugin add figma-local-bridge@figma-mcp
```

## OpenCode

Запускайте OpenCode из корня репозитория:

```powershell
.\START_OPENCODE.cmd
```

или на macOS:

```bash
./scripts/start-opencode.sh
```

Проверить подключение можно командой `opencode mcp list`. Затем выберите свою модель обычным способом и формулируйте задачу, например: «Проверь выделенную кнопку, измени её цвет на красный и подтверди результат скриншотом».

## Работа с несколькими файлами

Desktop Bridge может подключить несколько открытых файлов. Сначала агент вызывает `inspect_selection` с `includeFiles: true`, затем передаёт нужный `fileKey`. Если подключён один файл, `fileKey` можно не указывать.

## Разработка

```bash
cd plugins/figma-local-bridge
npm ci --ignore-scripts
npm test
npm run verify
```

Живые тесты требуют открытого Figma Desktop Bridge:

```bash
npm run smoke:compact
npm run smoke:advanced
```

Схема design spec пересобирается командой `npm run schema:export`.

## Структура

- `.agents/plugins/marketplace.json` — локальный marketplace Codex;
- `plugins/figma-local-bridge/.codex-plugin/plugin.json` — манифест Codex-плагина;
- `plugins/figma-local-bridge/.mcp.json` — запуск локального MCP;
- `plugins/figma-local-bridge/skills/figma-local/` — общий рабочий процесс агента;
- `plugins/figma-local-bridge/src/` — сервер, транспорт, схемы и компилятор операций;
- `plugins/figma-local-bridge/figma-plugin/` — импортируемый Desktop Bridge;
- `opencode.json` — переносимая конфигурация OpenCode;
- `scripts/` — установщики и запуск OpenCode.

## Безопасность и лицензии

Секреты и токены не требуются. Файлы `.env`, ключи и локальные токены исключены из Git; CI дополнительно проверяет типичные шаблоны секретов. Перед каждой публикацией всё равно просматривайте `git diff --cached`.

Наш код распространяется по лицензии MIT. Desktop Bridge получен из `figma-console-mcp@1.40.0`; сведения и исходная лицензия находятся в [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) и `plugins/figma-local-bridge/figma-plugin/LICENSE.upstream`.

У включённого Desktop Bridge есть интерфейс необязательного cloud relay из исходного проекта. Этот репозиторий его не использует: локальный путь работает через `127.0.0.1`.
