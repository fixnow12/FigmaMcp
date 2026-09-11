# Ссылки и переходы

Две типизированные операции для Figma Design. Произвольный JS не нужен.
Всегда передавайте `fileKey`, полученный для целевого файла. До записи прочитайте
узлы через `inspect_selection`. Команды не меняют текст и не создают слои.

## Текстовые ссылки

```json
{
  "fileKey": "FILE_KEY",
  "links": [
    { "nodeId": "1:10", "start": 0, "end": 6, "target": { "type": "URL", "value": "https://example.com/help" } },
    { "nodeId": "1:11", "target": { "type": "NODE", "value": "1:20" } }
  ],
  "dryRun": true
}
```

Передайте в `set_text_links`. После успешной проверки уберите `dryRun` для записи.
Без `start/end` ссылка относится ко всему тексту. `target:null` снимает ссылку.
Индексы UTF-16: start включён, end исключён. Нельзя разрезать суррогатную пару
(например, emoji) или задавать пересекающиеся диапазоны одного текста. Пустой
текст отклоняется. Максимум 100 диапазонов за вызов. URL: http, https, mailto, tel.
NODE — существующий узел файла, включая другую страницу, кроме слоя внутри INSTANCE.
Figma может автоматически преобразовать URL на узел текущего файла в NODE.

Ответ `result.links[].hyperlinks` содержит фактические связанные диапазоны всего
затронутого текста. Не связанные диапазоны опущены; пустой массив означает отсутствие ссылок.

## Прототипные реакции

```json
{
  "fileKey": "FILE_KEY",
  "updates": [{
    "nodeId": "1:10",
    "mode": "upsert",
    "reactions": [{
      "trigger": { "type": "ON_CLICK" },
      "actions": [{
        "type": "NODE", "navigation": "NAVIGATE", "destinationId": "1:20",
        "transition": { "type": "DISSOLVE", "duration": 0.3, "easing": { "type": "EASE_OUT" } }
      }]
    }]
  }]
}
```

Передайте в `set_reactions`. `transition:null` или отсутствие transition означает
мгновенный переход. Анимации: DISSOLVE, SMART_ANIMATE; duration — 0.01–10 секунд;
easing — LINEAR, EASE_IN, EASE_OUT, EASE_IN_AND_OUT. `preserveScrollPosition`
применяется только к NAVIGATE. SCROLL_TO поддерживает только мгновенный переход.

- NAVIGATE/OVERLAY: другой верхнеуровневый FRAME той же страницы, допускается SECTION вокруг него.
- SCROLL_TO: другой вложенный блок в том же экране.
- URL: `{ "type":"URL", "url":"https://example.com" }`.
- BACK/CLOSE: `{ "type":"BACK" }` или `{ "type":"CLOSE" }`.
- Триггеры: ON_CLICK, ON_HOVER, ON_PRESS, ON_DRAG. Одно действие на триггер.

До 100 узлов за вызов, каждый ID один раз. По умолчанию upsert заменяет все
реакции указанных типов триггеров и сохраняет остальные, включая неподдержанные
этой схемой действия. Повторный вызов не добавляет дубли. replace заменяет весь
список; для удаления всех реакций явно передайте `mode:"replace", reactions:[]`.

## Безопасность и проверка

Проверяется весь пакет до первой записи: типы узлов, диапазоны, цели, страница,
защита оригиналов компонентов и неизменность прочитанных свойств. При сбое
записи восстанавливаются исходные ссылки/реакции в обратном порядке.
`rolled_back` означает успешный откат; `partial` — ошибку восстановления,
подробности в `rollbackErrors`. После тайм-аута не повторяйте запись: сначала
прочитайте узлы. Опциональный скриншот не влияет на успешность записи.

Figma может вернуть одновременно `action`/`actions` и добавить
`resetVideoPosition:false` в NODE-действие. Bridge учитывает это при сравнении;
изменение цели, `resetVideoPosition:true` и других параметров остаётся конфликтом.
При `partial` сначала прочитайте фактические реакции, даже если следующая попытка
дала `rolled_back`: она не отменяет изменения предыдущей операции.

`dryRun:true` ничего не записывает и не делает PNG, ответ имеет
`operationStatus:"read"`. Оригиналы компонентов даже в dryRun требуют явного
`allowComponentChanges:true` после подтверждения пользователя. Обычные экземпляры
не требуют этого флага.

`inspect_selection` возвращает `hyperlinks` и `reactions` в обоих режимах detail.
Результат записи содержит `mutatedNodeIds` и `actualClicks:"not-tested"`:
чтение Plugin API и PNG не заменяют ручной проверки кликов в Present.

Проверены автоматизированные операции, откат и путь MCP → WebSocket → Plugin API
на поведенческой модели. Реальная проверка Present для этого обновления не выполнена.
`recreate_screen` не переносит эти связи; настройте их на новых ID отдельным пакетом.
Figma Slides/FigJam, CHANGE_TO, условия, переменные прототипа, таймеры и клавиатурные
триггеры пока не входят в контракт новых команд.

API: [HyperlinkTarget](https://developers.figma.com/docs/plugins/api/HyperlinkTarget/),
[Reaction](https://developers.figma.com/docs/plugins/api/Reaction/),
[Action](https://developers.figma.com/docs/plugins/api/Action/).
