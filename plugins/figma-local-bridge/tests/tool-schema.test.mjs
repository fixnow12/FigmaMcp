import test from "node:test";
import assert from "node:assert/strict";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

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
      ["inspect_selection", "patch_nodes", "render_screen", "use_component"],
    );

    const render = tools.find((tool) => tool.name === "render_screen");
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

    const inspectSelection = tools.find((tool) => tool.name === "inspect_selection");
    assert.equal(inspectSelection.inputSchema.properties.nodeId.type, "string");
  } finally {
    await client.close();
  }
});
