# FigmaMcp

**FigmaMcp** — локальное подключение Codex или OpenCode к открытому файлу в Figma Desktop. Оно позволяет безопасно читать выделение, создавать экраны, менять узлы и вставлять компоненты — без браузерной автоматизации, Figma API-токена и облачного relay.

```text
Codex / OpenCode
       ↓ MCP по stdio
figma-local
       ↓ ws://127.0.0.1:9223–9232 + взаимное HMAC-сопряжение
Figma Desktop Bridge
       ↓ Figma Plugin API
Открытый файл Figma
```

## Что умеет

MCP публикует четыре типизированных инструмента:

- `inspect_selection` — читает выделение и по запросу возвращает PNG;
- `patch_nodes` — меняет существующие узлы по Figma ID или стабильному ключу;
- `render_screen` — создаёт экран из JSON-спецификации;
- `use_component` — вставляет экземпляр локального или библиотечного компонента.

Произвольный JavaScript наружу не выдаётся. Все операции выполняются только в Figma Desktop через установленный development-плагин.

## Быстрый старт

### 1. Подготовьте компьютер

Нужны:

- Node.js 20 или новее;
- Figma Desktop;
- Codex и/или OpenCode;
- macOS либо Windows 10/11.

Склонируйте репозиторий:

```bash
git clone https://github.com/fixnow12/FigmaMcp.git
cd FigmaMcp
```

На macOS запустите:

```bash
chmod +x scripts/install.sh scripts/start-opencode.sh
./scripts/install.sh
```

На Windows откройте PowerShell в папке репозитория:

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\install.ps1
```

Установщик ставит зависимости, запускает тесты и проверяет MCP-контракт. Если Codex доступен в терминале, он также добавляет локальный marketplace и плагин.

### 2. Один раз импортируйте Bridge в Figma

1. Откройте Figma Desktop.
2. Выберите **Plugins → Development → Import plugin from manifest…**.
3. Укажите `plugins/figma-local-bridge/figma-plugin/manifest.json` из этого репозитория.
4. Откройте нужный Figma-файл.
5. Запустите **Plugins → Development → Figma Desktop Bridge** и оставьте его окно открытым.

Если менялись `manifest.json`, `code.js` или `ui.html`, импортируйте manifest ещё раз: Figma кеширует файлы development-плагина.

### 3. Подключите Codex или OpenCode

#### Codex

После установщика перезапустите Codex и откройте этот проект. Плагин `figma-local-bridge` подключит MCP и рабочий навык автоматически.

Для ручной установки из корня репозитория:

```bash
codex plugin marketplace add .
codex plugin add figma-local-bridge@figma-mcp
```

#### OpenCode Desktop

1. Откройте в OpenCode именно корневую папку `FigmaMcp` — в ней лежит `opencode.json`.
2. Создайте новый чат: OpenCode сам запустит `figma-local`.
3. Не открывайте отдельно папку `plugins/figma-local-bridge`: тогда проектная конфигурация MCP не будет найдена.

Для терминальной версии OpenCode используйте из корня репозитория:

```bash
# macOS
./scripts/start-opencode.sh

# Windows
.\START_OPENCODE.cmd
```

## Локальное сопряжение

При первом вызове инструмента агент покажет код вида `9223:<secret>` и попросит вставить его в плагин.

1. Скопируйте код целиком.
2. В Figma Desktop Bridge вставьте его в поле **Local pairing code**.
3. Нажмите **Pair**.
4. Дождитесь статуса `Connected — AI can work in this file`.

Это нормальный обязательный шаг: пока сопряжение не завершено, Bridge не передаёт сведения о файле, переменные, события, скриншоты и не принимает команды. Код действует только для текущего процесса MCP и конкретного порта.

## Первая команда

Выделите в Figma нужный элемент и попросите агента, например:

> Проверь выделение через figma-local, сделай кнопку красной и подтверди результат скриншотом.

Если Bridge не подключается, проверьте:

1. Открыт ли нужный файл в Figma Desktop.
2. Запущен ли **Figma Desktop Bridge** в этом файле.
3. Открыт ли в Codex/OpenCode именно проект `FigmaMcp`.
4. Вставлен ли актуальный код сопряжения для текущего процесса MCP.

После этого нажмите **Try again** в плагине либо перезапустите MCP-клиент.

## Несколько файлов

Bridge может держать несколько открытых Figma-файлов. Агент сначала вызывает `inspect_selection` с `includeFiles: true`, затем передаёт нужный `fileKey` в следующий вызов. Если файл один, `fileKey` не нужен.

## Разработка и проверки

```bash
cd plugins/figma-local-bridge
npm ci --ignore-scripts
npm test
npm run verify
```

Дополнительно из корня репозитория:

```bash
node scripts/validate-repo.mjs
```

Живые проверки с открытым Figma Desktop Bridge:

```bash
npm run smoke:compact
npm run smoke:advanced
```

## Безопасность

- Bridge разрешает только `localhost` и слушает IPv4 loopback `127.0.0.1`;
- внешний cloud relay удалён;
- до взаимной HMAC-проверки блокируются данные и команды;
- challenge создаётся заново для каждого WebSocket-соединения;
- pairing secret не сохраняется в репозитории, не записывается в логи и не возвращается из `/health`.

Не публикуйте порты `9223–9232` во внешнюю сеть и не передавайте pairing-код другим людям. Для автоматизированного запуска можно задать `FIGMA_BRIDGE_AUTH_TOKEN`: минимум 32 символа base64url, только через защищённую конфигурацию окружения.

## Структура репозитория

- `plugins/figma-local-bridge/src/` — MCP-сервер, транспорт и схемы;
- `plugins/figma-local-bridge/figma-plugin/` — development-плагин для импорта в Figma;
- `plugins/figma-local-bridge/skills/figma-local/` — рабочий процесс агента;
- `.agents/plugins/marketplace.json` — локальный marketplace Codex;
- `opencode.json` — конфигурация OpenCode;
- `scripts/` — установщики, проверки и запуск OpenCode.

## Лицензии

Код этого репозитория распространяется по лицензии MIT. Desktop Bridge основан на `figma-console-mcp@1.40.0`; уведомления и исходная лицензия находятся в [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) и `plugins/figma-local-bridge/figma-plugin/LICENSE.upstream`.
