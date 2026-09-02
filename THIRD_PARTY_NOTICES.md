# Сторонние компоненты

## Figma Desktop Bridge

Каталог `plugins/figma-local-bridge/figma-plugin/` получен из npm-пакета `figma-console-mcp@1.40.0`.

- Исходный проект: https://github.com/southleft/figma-console-mcp
- Лицензия: MIT
- Copyright (c) 2025 Figma Console MCP Contributors

Копия исходной лицензии находится в `plugins/figma-local-bridge/figma-plugin/LICENSE.upstream`.

Файлы Desktop Bridge сохранены как закреплённая и локально адаптированная копия для воспроизводимого импорта development-плагина в Figma Desktop. Удалены удалённый relay и внешние сетевые разрешения. Локальный MCP-сервер этого репозитория не зависит от runtime `figma-console-mcp`.
