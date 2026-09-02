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
- `patch_nodes` — пакетно меняет существующие узлы по стабильным ключам или Figma ID;
- `render_screen` — создаёт экран из типизированной JSON-спецификации;
- `use_component` — вставляет экземпляр локального или библиотечного компонента.

Произвольный JavaScript наружу не выставлен. Созданные мостом узлы получают стабильный `key`, а элементы в обычных существующих макетах можно адресовать по их Figma ID.

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
6. При первом обращении MCP покажет локальный код вида `9223:…`. Вставьте его в поле **Local pairing code** в окне плагина и нажмите **Pair**. Код высокоэнтропийный, действует только для текущего процесса MCP и не передаётся другим найденным портам.

Пока OpenCode или Codex не запущен, плагин может показывать `Looking for your AI app…`. До сопряжения он показывает `Local pairing required…` и не передаёт сведения о файле, переменные или команды. После взаимной проверки статус меняется на `Connected — AI can work in this file`. Сервер слушает только IPv4 loopback `127.0.0.1`; не публикуйте порты `9223–9232` во внешнюю сеть.

## Codex

После установщика перезапустите Codex и откройте проект. Плагин `figma-local-bridge` добавляет MCP и навык автоматически.

Ручная установка из клонированного репозитория:

```bash
codex plugin marketplace add .
codex plugin add figma-local-bridge@figma-mcp
```

## OpenCode

### OpenCode Desktop: установка от начала до конца

OpenCode Desktop не требует отдельной установки MCP-плагина. Он автоматически читает файл `opencode.json`, когда репозиторий открыт как проект.

#### 1. Установите необходимые приложения

- [Node.js](https://nodejs.org/) версии 20 или новее;
- Figma Desktop;
- OpenCode Desktop.

#### 2. Скачайте и подготовьте репозиторий

На macOS откройте Terminal и выполните:

```bash
git clone https://github.com/fixnow12/FigmaMcp.git
cd FigmaMcp
chmod +x scripts/install.sh scripts/start-opencode.sh
./scripts/install.sh
```

На Windows откройте PowerShell и выполните:

```powershell
git clone https://github.com/fixnow12/FigmaMcp.git
cd FigmaMcp
powershell -ExecutionPolicy Bypass -File .\scripts\install.ps1
```

Если репозиторий уже скачан, повторно клонировать его не нужно: перейдите в его папку и запустите установщик.

#### 3. Один раз добавьте Bridge в Figma

1. Откройте Figma Desktop.
2. Выберите **Plugins → Development → Import plugin from manifest…**.
3. Выберите файл `plugins/figma-local-bridge/figma-plugin/manifest.json` внутри репозитория.

#### 4. Подготовьте нужный Figma-файл

1. Откройте нужный макет в Figma Desktop.
2. Запустите **Plugins → Development → Figma Desktop Bridge**.
3. Оставьте окно Bridge открытым. До запуска OpenCode оно может показывать `Looking for your AI app…` — это нормально.

#### 5. Откройте проект в OpenCode Desktop

1. Запустите OpenCode Desktop.
2. Выберите открытие папки или проекта.
3. Укажите корневую папку репозитория `FigmaMcp`, в которой лежит `opencode.json`. Не открывайте отдельно подпапку `plugins/figma-local-bridge`.
4. Создайте новый чат. OpenCode прочитает `opencode.json` и сам запустит локальный MCP-сервер `figma-local`.

После подключения в окне Figma Desktop Bridge появится статус `Connected — AI can work in this file`.

#### 6. Отправьте первую команду

Например:

> Проверь выделение в Figma через figma-local, измени цвет выделенной кнопки на красный и подтверди результат скриншотом.

Сначала выделите нужный элемент в Figma. Если открыто несколько Figma-файлов, укажите ссылку на нужный файл или узел.

#### 7. Если Bridge не подключается

Проверьте три вещи:

1. В OpenCode Desktop открыта именно корневая папка `FigmaMcp` с файлом `opencode.json`.
2. В Figma открыт нужный файл и запущен **Figma Desktop Bridge**.
3. Установлен Node.js 20 или новее.

После проверки нажмите **Try again** в Bridge или переоткройте проект в OpenCode Desktop.

### OpenCode в терминале

Если вместо Desktop-приложения используется терминальная версия, запускайте OpenCode из корня репозитория:

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

Локальный bridge использует случайный сессионный pairing secret и взаимный HMAC challenge-response. Secret возвращается в ошибке первого MCP-инструмента, пока плагин ожидает сопряжения; он не публикуется через `/health`, не записывается в логи и не хранится в репозитории. Для автоматизированного запуска можно передать собственный высокоэнтропийный `FIGMA_BRIDGE_AUTH_TOKEN` (не менее 32 символов base64url) через защищённую конфигурацию окружения. Файлы `.env`, ключи и локальные токены исключены из Git; CI дополнительно проверяет типичные шаблоны секретов.

Наш код распространяется по лицензии MIT. Desktop Bridge получен из `figma-console-mcp@1.40.0`; сведения и исходная лицензия находятся в [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) и `plugins/figma-local-bridge/figma-plugin/LICENSE.upstream`.
Сторонняя копия адаптирована для полностью локальной работы: Figma-плагин разрешает соединения только с `localhost`, а его версия синхронизирована с пакетом `figma-local-bridge`.
