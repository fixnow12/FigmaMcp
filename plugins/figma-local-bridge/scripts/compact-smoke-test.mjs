import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");
const transport = new StdioClientTransport({
  command: process.execPath,
  args: [join(root, "src", "server.mjs")],
  cwd: root,
  env: { ...process.env, FIGMA_WS_HOST: "127.0.0.1" },
  stderr: "pipe",
});

transport.stderr?.on("data", (chunk) => process.stderr.write(String(chunk)));

const client = new Client({ name: "compact-smoke-test", version: "0.1.0" });

async function call(name, args) {
  const response = await client.callTool({ name, arguments: args });
  const text = response.content?.find((item) => item.type === "text")?.text;
  if (response.isError) throw new Error(`${name}: ${text}`);
  if (!text) return response;
  const parsed = JSON.parse(text);
  parsed.imageCount = response.content?.filter((item) => item.type === "image").length || 0;
  return parsed;
}

const spec = {
  key: "compact-mcp-smoke",
  name: "Compact MCP Smoke Test",
  type: "screen",
  width: 760,
  height: 420,
  background: "#F8FAFC",
  layout: { direction: "vertical", gap: 20, padding: 32 },
  nodes: [
    {
      key: "compact-title",
      name: "Title",
      type: "text",
      content: "Compact MCP connected",
      fontSize: 28,
      fontWeight: "Semi Bold",
      color: "#0F172A",
    },
    {
      key: "compact-button-source",
      name: "Primary Button",
      type: "component",
      width: 200,
      height: 52,
      background: "#2563EB",
      cornerRadius: 12,
      layout: {
        direction: "horizontal",
        gap: 8,
        padding: 14,
        primaryAlign: "center",
        counterAlign: "center",
      },
    },
    {
      key: "compact-button-label",
      parentKey: "compact-button-source",
      name: "Label",
      type: "text",
      content: "Source component",
      fontSize: 15,
      fontWeight: "Semi Bold",
      color: "#FFFFFF",
    },
    {
      key: "compact-instance-zone",
      name: "Instance Zone",
      type: "frame",
      width: "fill",
      height: 100,
      background: "#E2E8F0",
      cornerRadius: 12,
      layout: {
        direction: "horizontal",
        gap: 16,
        padding: 24,
        counterAlign: "center",
      },
    },
  ],
};

try {
  await client.connect(transport);
  const tools = await client.listTools();
  console.log("TOOLS", tools.tools.map((tool) => tool.name).join(","));

  console.log("RENDER", JSON.stringify(await call("render_screen", { spec })));
  console.log("INSPECT_ROOT", JSON.stringify(await call("inspect_selection", { depth: 2 })));
  console.log(
    "INSTANCE",
    JSON.stringify(
      await call("use_component", {
        sourceKey: "compact-button-source",
        parentKey: "compact-instance-zone",
        key: "compact-button-instance",
        name: "Primary Button Instance",
      }),
    ),
  );
  console.log(
    "PATCH",
    JSON.stringify(
      await call("patch_nodes", {
        patches: [
          { key: "compact-title", set: { content: "Compact MCP: create · inspect · patch · instance" } },
          { key: "compact-instance-zone", set: { background: "#DBEAFE" } },
        ],
      }),
    ),
  );
  console.log(
    "INSPECT_INSTANCE",
    JSON.stringify(await call("inspect_selection", { depth: 2, screenshot: true })),
  );
} finally {
  await client.close();
}
