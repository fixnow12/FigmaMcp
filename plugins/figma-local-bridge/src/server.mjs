import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { FigmaBridge } from "./bridge.mjs";
import { runToolOperation, toolSuccess as ok, toolFailure as fail } from "./tool-results.mjs";
import {
  cloneNodesInputSchema, cloneNodesSchema, moveNodesInputSchema, moveNodesSchema,
  findAssetsInputSchema, findAssetsSchema, bindVariablesInputSchema, bindVariablesSchema,
} from "./operation-schemas.mjs";
import { buildCloneCode, buildMoveCode } from "./scene-operations.mjs";
import { buildFindAssetsCode } from "./asset-catalog.mjs";
import { buildBindVariablesCode } from "./variable-bindings.mjs";
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
  "find_assets находит элементы и ресурсы; clone_nodes копирует готовые блоки; move_nodes переносит и переставляет слои; bind_variables привязывает существующие Variables без изменения их значений. " +
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
      "Создаёт экран из JSON-спеки с токенами, PNG/JPEG, SVG и вариантами. Повторный вызов с тем же spec.key заменяет предыдущую версию после успешной сборки, сохраняя посторонние элементы секции; PNG возвращается по умолчанию.",
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
        operationName: "render_screen",
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
        operationName: "patch_nodes",
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
        operationName: "inspect_selection",
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
        operationName: "use_component",
        screenshotRequested: parsed.screenshot,
        screenshotNode: (payload) => payload.result?.id,
      });
    } catch (error) {
      return fail(error);
    }
  },
);

function registerGeneratedTool(name, config, schema, buildCode, { mutating = true } = {}) {
  server.registerTool(name, config, async (input) => {
    try {
      const parsed = schema.parse(input);
      return await runToolOperation(bridge, parsed, buildCode(parsed), {
        operationName: name,
        mutating,
        screenshotRequested: parsed.screenshot,
        screenshotNode: (payload) => payload.result?.screenshotNodeId,
      });
    } catch (error) {
      return fail(error);
    }
  });
}

registerGeneratedTool("clone_nodes", {
  title: "Скопировать элементы",
  description: "Клонирует готовые блоки с сохранением оформления и экземпляров. Назначает новые key всем слоям копий, возвращает соответствие sourceId → id. При ошибке удаляет созданные копии. Не копирует определения компонентов и не меняет их внутреннюю структуру.",
  inputSchema: cloneNodesInputSchema,
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
}, cloneNodesSchema, buildCloneCode);

registerGeneratedTool("move_nodes", {
  title: "Переместить элементы",
  description: "Перемещает или переставляет узлы текущей страницы по ID между PAGE/FRAME/SECTION. index — конечная позиция с нуля на каждом шаге пакета. Сохраняет ID; при ошибке восстанавливает родителей, порядок и геометрию. Компоненты и внутреннюю структуру экземпляров не меняет.",
  inputSchema: moveNodesInputSchema,
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
}, moveNodesSchema, buildMoveCode);

registerGeneratedTool("find_assets", {
  title: "Найти элементы и ресурсы",
  description: "Ищет по имени nodes/components на странице или во всём файле, локальные styles/variables и метаданные доступных библиотечных коллекций/переменных. Возвращает ID, ключи, свойства и страницы результатов. Не импортирует ресурсы; внешний каталог компонентов недоступен через Plugin API.",
  inputSchema: findAssetsInputSchema,
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
}, findAssetsSchema, buildFindAssetsCode, { mutating: false });

registerGeneratedTool("bind_variables", {
  title: "Привязать переменные",
  description: "Привязывает доступные в файле Figma Variables по variableId к поддержанным свойствам слоёв и SOLID-заливкам/обводкам. variableId=null снимает привязку. Проверяет типы до записи, при сбое восстанавливает исходные значения и привязки. allowComponentChanges требует подтверждения пользователя на изменение оригинала компонента.",
  inputSchema: bindVariablesInputSchema,
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
}, bindVariablesSchema, buildBindVariablesCode);

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
