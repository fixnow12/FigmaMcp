import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { FigmaBridge } from "./bridge.mjs";
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
  "Все изменяемые узлы адресуются стабильным key. Не перерисовывайте экран ради точечной правки. " +
  "Перед патчем неизвестного дизайна вызовите inspect_selection. Сервер не принимает произвольный JavaScript.";

const bridge = new FigmaBridge();
await bridge.start();

const server = new McpServer(
  { name: "codex-figma-compact", version: "0.2.2" },
  { instructions },
);

function ok(payload) {
  return {
    content: [{ type: "text", text: JSON.stringify(payload) }],
    structuredContent: payload,
  };
}

function okWithImage(payload, image) {
  return {
    content: [
      { type: "text", text: JSON.stringify(payload) },
      { type: "image", data: image.base64, mimeType: "image/png" },
    ],
    structuredContent: {
      ...payload,
      screenshot: {
        format: image.format,
        scale: image.scale,
        byteLength: image.byteLength,
        bounds: image.bounds,
        node: image.node,
      },
    },
  };
}

function fail(error) {
  return {
    isError: true,
    content: [
      {
        type: "text",
        text: JSON.stringify({ error: error instanceof Error ? error.message : String(error) }),
      },
    ],
  };
}

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
      const payload = await bridge.execute(buildRenderCode(operation), { fileKey: parsed.fileKey });
      if (parsed.screenshot !== false && payload.result?.rootId) {
        const image = await bridge.captureScreenshot(payload.result.rootId, {
          scale: parsed.screenshotScale ?? 1,
          fileKey: parsed.fileKey,
        });
        return okWithImage(payload, image);
      }
      return ok(payload);
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
      "Применяет пакет точечных изменений к узлам по стабильным key без пересоздания экрана. По умолчанию сначала проверяет наличие всех целей.",
    inputSchema: patchNodesInputSchema,
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
  },
  async (input) => {
    try {
      const parsed = patchNodesSchema.parse(input);
      const operation = { ...parsed, ignoreMissing: parsed.ignoreMissing ?? false };
      const payload = await bridge.execute(buildPatchCode(operation), { fileKey: parsed.fileKey });
      if (payload.result?.screenshotNodeId) {
        const image = await bridge.captureScreenshot(payload.result.screenshotNodeId, {
          scale: parsed.screenshotScale ?? 1,
          fileKey: parsed.fileKey,
        });
        return okWithImage(payload, image);
      }
      return ok(payload);
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
      "Возвращает компактное дерево текущего выделения: id, стабильные key, размеры, layout, текст и свойства экземпляров. Опционально прикладывает PNG первого выделенного узла.",
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
      const payload = await bridge.execute(buildInspectCode(operation), { timeout: 10000, fileKey: parsed.fileKey });
      if (parsed.includeFiles) {
        payload.bridge = bridge.status();
        payload.connectedFiles = payload.bridge.files;
      }
      const firstNodeId = payload.result?.selection?.[0]?.id;
      if (parsed.screenshot && firstNodeId) {
        const image = await bridge.captureScreenshot(firstNodeId, {
          scale: parsed.screenshotScale ?? 1,
          fileKey: parsed.fileKey,
        });
        return okWithImage(payload, image);
      }
      return ok(payload);
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
      "Создаёт instance локального COMPONENT/COMPONENT_SET по sourceKey или библиотечного компонента по libraryKey, выбирает variant, назначает componentProperties и стабильный key.",
    inputSchema: useComponentInputSchema,
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
  },
  async (input) => {
    try {
      const parsed = useComponentSchema.parse(input);
      const payload = await bridge.execute(buildUseComponentCode(parsed), { fileKey: parsed.fileKey });
      if (parsed.screenshot && payload.result?.id) {
        const image = await bridge.captureScreenshot(payload.result.id, {
          scale: parsed.screenshotScale ?? 1,
          fileKey: parsed.fileKey,
        });
        return okWithImage(payload, image);
      }
      return ok(payload);
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
