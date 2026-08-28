---
name: figma-local
description: "Работа с открытым файлом Figma Desktop через локальный MCP: чтение выделения, точечные правки узлов, создание экранов и вставка компонентов. Использовать для запросов на просмотр, создание или изменение макета Figma через Desktop Bridge."
---

# Figma Local

Используй только инструменты MCP-сервера `figma-local`: `inspect_selection`, `patch_nodes`, `render_screen` и `use_component`.

## Рабочий процесс

1. Для незнакомого макета сначала вызови `inspect_selection`.
2. Если выделение пустое, попроси пользователя выделить нужный узел в Figma Desktop.
3. Для точечной правки используй `patch_nodes` и стабильные `key`; не пересоздавай весь экран.
4. Для нового экрана используй один `render_screen`. Все узлы должны иметь уникальные стабильные `key`.
5. Экземпляры компонентов создавай через `use_component`.
6. После записи проверь PNG из ответа инструмента или повтори `inspect_selection` с `screenshot: true`.

## Подключение

- Не открывай Figma в браузере, не используй Playwright, REST API, официальный удалённый Figma MCP, API-токены, `list_mcp_resources` или `list_mcp_resource_templates` для операций с холстом.
- Ссылка на Figma нужна только для извлечения `fileKey`; открывать ссылку не требуется.
- Если Desktop Bridge не подключён, попроси открыть целевой файл в Figma Desktop, запустить **Plugins → Development → Figma Desktop Bridge** и оставить окно плагина открытым.
- Если подключено несколько файлов, вызови `inspect_selection` с `includeFiles: true`, затем передавай нужный `fileKey`.
- Не предлагай произвольный JavaScript: сервер принимает только типизированные операции.

Формат экрана, токены и правила стабильных ключей описаны в [references/design-spec.md](references/design-spec.md).
