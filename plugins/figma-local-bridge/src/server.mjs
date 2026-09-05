import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { FigmaBridge } from "./bridge.mjs";
import { runToolOperation, toolSuccess as ok, toolFailure as fail } from "./tool-results.mjs";
import {
  inspectSelectionInputSchema,
  inspectSelectionSchema,
  patchNodesInputSchema,
  patchNodesSchema,
  renderScreenInputSchema,
  parseRenderScreenInput,
  useComponentSchema,
  useComponentInputSchema,
  normalizeScreenSpec,
} from "./schemas.mjs";
import {
  buildInspectCode,
  buildPatchCode,
  buildRenderCode,
  buildUseComponentCode,
} from "./figma-code.mjs";

const instructions =
  "Локальный write-путь в Figma через Plugin API. Для нового экрана используйте render_screen, " +
  "для итераций — patch_nodes, для чтения выделения — inspect_selection, для экземпляров — use_component. " +
  "Для подключения и списка файлов используйте get_status. Узлы адресуются стабильным key или id. Не перерисовывайте экран ради точечной правки. " +
  "Перед патчем неизвестного дизайна вызовите inspect_selection. Сервер не принимает произвольный JavaScript.";

const bridge = new FigmaBridge();
await bridge.start();

const server = new McpServer(
  { name: "codex-figma-compact", version: "0.2.2" },
  { instructions },
);

server.registerTool("get_status", {
  title: "Проверить подключение",
  description: "Мгновенно возвращает состояние локального Bridge и список подключённых файлов и страниц без чтения холста. Если сопряжение ожидается, показывает код для ввода в Figma.",
  inputSchema: {},
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
}, async () => {
  const status = bridge.status();
  if (!status.connected) status.pairingReference = bridge.getPairingReference();
  return ok(status);
});

server.registerTool(
  "render_screen",
  {
    title: "Создать экран",
    description:
      "Создаёт целый экран из плоской JSON-спеки с токенами, PNG/JPEG, SVG и вариантами. Повторный вызов с тем же spec.key атомарно заменяет предыдущую версию после успешной сборки; PNG возвращается по умолчанию.",
    inputSchema: renderScreenInputSchema,
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true },
  },
  async (input) => {
    try {
      const parsed = parseRenderScreenInput(input);
      const operation = {
        ...parsed,
        replace: parsed.replace ?? true,
        spec: normalizeScreenSpec(parsed.spec),
      };
      return await runToolOperation(bridge, parsed, buildRenderCode(operation), {
        screenshotRequested: parsed.screenshot !== false,
        screenshotNode: (payload) => payload.result?.rootId,
      });
    } catch (error) {
      return fail(error);
    }
  },
);

server.registerTool(
  "patch_nodes",
  {
    title: "Изменить узлы",
    description:
      "Проверяет цели, свойства и шрифты всего пакета до записи. Применяет изменения по key или id, при сбое восстанавливает свойства и сообщает результат отката. Append создаёт новые узлы и не должен автоматически повторяться.",
    inputSchema: patchNodesInputSchema,
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
  },
  async (input) => {
    try {
      const parsed = patchNodesSchema.parse(input);
      const operation = { ...parsed, ignoreMissing: parsed.ignoreMissing ?? false };
      return await runToolOperation(bridge, parsed, buildPatchCode(operation), {
        screenshotRequested: Boolean(parsed.screenshotKey),
        screenshotNode: (payload) => payload.result?.screenshotNodeId,
      });
    } catch (error) {
      return fail(error);
    }
  },
);

server.registerTool(
  "inspect_selection",
  {
    title: "Прочитать выделение",
    description:
      "Читает выделение, nodeId или nodeIds. Компактное дерево содержит размеры, layout, текст и свойства экземпляров; detail=full добавляет типографику, заливки, стили, переменные и Fill/Hug/Fixed. Опционально прикладывает PNG первого узла.",
    inputSchema: inspectSelectionInputSchema,
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
  },
  async (input) => {
    try {
      const parsed = inspectSelectionSchema.parse(input);
      const operation = {
        ...parsed,
        depth: parsed.depth ?? 3,
        maxNodes: parsed.maxNodes ?? 200,
      };
      return await runToolOperation(bridge, parsed, buildInspectCode(operation), {
        mutating: false,
        timeout: 10000,
        screenshotRequested: parsed.screenshot,
        screenshotNode: (payload) => payload.result?.selection?.[0]?.id,
        extendPayload: (payload) => {
          if (parsed.includeFiles) {
            payload.bridge = bridge.status();
            payload.connectedFiles = payload.bridge.files;
          }
        },
      });
    } catch (error) {
      return fail(error);
    }
  },
);

server.registerTool(
  "use_component",
  {
    title: "Создать экземпляр компонента",
    description:
      "Создаёт instance локального COMPONENT/COMPONENT_SET по sourceKey или sourceId либо библиотечного компонента по libraryKey. Родитель задаётся parentKey/parentId; поддержаны variant и componentProperties. При сбое настройки удаляет созданный instance.",
    inputSchema: useComponentInputSchema,
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
  },
  async (input) => {
    try {
      const parsed = useComponentSchema.parse(input);
      return await runToolOperation(bridge, parsed, buildUseComponentCode(parsed), {
        screenshotRequested: parsed.screenshot,
        screenshotNode: (payload) => payload.result?.id,
      });
    } catch (error) {
      return fail(error);
    }
  },
);

const transport = new StdioServerTransport();

async function shutdown() {
  await server.close().catch(() => {});
  await bridge.stop().catch(() => {});
}

process.once("SIGINT", async () => {
  await shutdown();
  process.exit(0);
});
process.once("SIGTERM", async () => {
  await shutdown();
  process.exit(0);
});

await server.connect(transport);
