import test from "node:test";
import assert from "node:assert/strict";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocket } from "ws";
import { createAuthProof, LOCAL_AUTH_PROTOCOL } from "../src/bridge.mjs";
import { createFigmaMock, executeGenerated } from "./helpers/figma-mock.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

test("MCP публикует типизированные схемы без unknown на верхнем уровне", async () => {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [join(root, "src", "server.mjs")],
    cwd: root,
    env: {
      ...process.env,
      FIGMA_WS_HOST: "127.0.0.1",
      FIGMA_WS_PORT: "9230",
      LOG_LEVEL: "silent",
    },
    stderr: "pipe",
  });
  const client = new Client({ name: "tool-schema-test", version: "0.1.0" });
  try {
    await client.connect(transport);
    const { tools } = await client.listTools();
    assert.deepEqual(
      tools.map((tool) => tool.name).sort(),
      ["get_status", "inspect_selection", "patch_nodes", "render_screen", "use_component"],
    );

    const render = tools.find((tool) => tool.name === "render_screen");
    const status = await client.callTool({ name: "get_status", arguments: {} });
    assert.equal(status.isError, undefined);
    assert.equal(status.structuredContent.connected, false);
    assert.match(status.structuredContent.pairingReference, /^\d+:/);
    const spec = render.inputSchema.properties.spec;
    assert.equal(spec.type, "object");
    assert.equal(spec.properties.nodes.type, "array");
    assert.deepEqual(
      [...spec.properties.nodes.items.properties.type.enum].sort(),
      ["component", "componentSet", "ellipse", "frame", "image", "rectangle", "svg", "text"],
    );
    assert.equal(spec.properties.tokens.type, "object");
    assert.equal(JSON.stringify(render.inputSchema).includes('"$ref"'), false);

    const useComponent = tools.find((tool) => tool.name === "use_component");
    assert.ok(
      useComponent.inputSchema.properties.key.type === "string" ||
        typeof useComponent.inputSchema.properties.key.$ref === "string",
    );
    assert.equal(useComponent.inputSchema.properties.sourceKey.type, "string");
    assert.equal(useComponent.inputSchema.properties.libraryKey.type, "string");
    assert.equal(useComponent.inputSchema.properties.variant.type, "object");

    const patchNodes = tools.find((tool) => tool.name === "patch_nodes");
    const patchProperties = patchNodes.inputSchema.properties.patches.items.properties;
    assert.equal(patchProperties.key.type, "string");
    assert.equal(patchProperties.id.type, "string");
    assert.equal(patchProperties.append.type, "array");

    const inspectSelection = tools.find((tool) => tool.name === "inspect_selection");
    assert.equal(inspectSelection.inputSchema.properties.nodeId.type, "string");
    assert.equal(inspectSelection.inputSchema.properties.nodeIds.type, "array");
    assert.deepEqual(inspectSelection.inputSchema.properties.detail.enum, ["compact", "full"]);
    assert.equal(useComponent.inputSchema.properties.sourceId.type, "string");
    assert.equal(useComponent.inputSchema.properties.parentId.type, "string");
    assert.equal(patchNodes.annotations.idempotentHint, false);
  } finally {
    await client.close();
  }
});

test("MCP → WebSocket → сгенерированный патч: ошибка PNG сохраняет успешный результат", async () => {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [join(root, "src", "server.mjs")], cwd: root,
    env: { ...process.env, FIGMA_WS_HOST: "127.0.0.1", FIGMA_WS_PORT: "0" }, stderr: "pipe",
  });
  const client = new Client({ name: "operation-test", version: "0.1.0" });
  const mock = createFigmaMock();
  const text = mock.key(mock.make("TEXT"), "title");
  let socket;
  try {
    await client.connect(transport);
    const status = await client.callTool({ name: "get_status", arguments: {} });
    const [port, token] = status.structuredContent.pairingReference.split(":");
    socket = new WebSocket("ws://127.0.0.1:" + port);
    const registered = new Promise((resolve, reject) => {
      socket.once("error", reject);
      socket.on("message", async (raw) => {
        const message = JSON.parse(String(raw));
        if (message.type === "AUTH_CHALLENGE") {
          socket.send(JSON.stringify({ type: "AUTH_RESPONSE", data: { authProtocol: LOCAL_AUTH_PROTOCOL, proof: createAuthProof(token, "client", Number(port), message.data.challenge) } }));
        } else if (message.type === "AUTH_OK") {
          socket.send(JSON.stringify({ type: "FILE_INFO", data: { fileKey: "test-file", fileName: "Тест", currentPageId: mock.page.id } }));
          // A ping/pong round trip ensures FILE_INFO has been consumed before the tool call.
          socket.once("pong", resolve);
          socket.ping();
        } else if (message.method === "EXECUTE_CODE") {
          try {
            const result = await executeGenerated(mock.figma, message.params.code);
            socket.send(JSON.stringify({ id: message.id, result: { success: true, result } }));
          } catch (error) {
            socket.send(JSON.stringify({ id: message.id, result: { success: false, error: error.message, operationStatus: error.operationStatus } }));
          }
        } else if (message.method === "CAPTURE_SCREENSHOT") {
          socket.send(JSON.stringify({ id: message.id, result: { success: false, error: "Экспорт недоступен" } }));
        }
      });
    });
    await registered;
    const response = await client.callTool({ name: "patch_nodes", arguments: {
      fileKey: "test-file", patches: [{ id: text.id, set: { content: "Готово", fontSize: 18 } }], screenshotKey: "title",
    } });
    assert.equal(response.isError, undefined);
    assert.equal(response.structuredContent.operationStatus, "applied");
    assert.equal(response.structuredContent.screenshot.status, "failed");
    assert.equal(response.structuredContent.fileContext.fileKey, "test-file");
    assert.equal(text.characters, "Готово");
    assert.equal(text.fontSize, 18);
    const invalid = await client.callTool({ name: "patch_nodes", arguments: { fileKey: "test-file", patches: [{ id: mock.page.id, set: { content: "Нельзя" } }] } });
    assert.equal(invalid.isError, true);
    assert.equal(invalid.structuredContent.operationStatus, "not_applied");
  } finally {
    socket?.terminate();
    await client.close();
  }
});
