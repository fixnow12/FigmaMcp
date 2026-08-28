import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const transport = new StdioClientTransport({
  command: process.execPath,
  args: [join(root, "src", "server.mjs")],
  cwd: root,
  env: { ...process.env, FIGMA_WS_HOST: "127.0.0.1" },
  stderr: "pipe",
});
transport.stderr?.on("data", (chunk) => process.stderr.write(String(chunk)));
const client = new Client({ name: "advanced-smoke-test", version: "0.2.0" });

async function call(name, args) {
  const response = await client.callTool({ name, arguments: args });
  const text = response.content?.find((item) => item.type === "text")?.text;
  if (response.isError) throw new Error(`${name}: ${text}`);
  const parsed = text ? JSON.parse(text) : response;
  parsed.imageCount = response.content?.filter((item) => item.type === "image").length || 0;
  return parsed;
}

const spec = {
  key: "advanced-mcp-smoke",
  name: "Advanced MCP Smoke Test",
  type: "screen",
  width: 900,
  height: 560,
  background: "$colors.canvas",
  layout: { direction: "vertical", gap: "$numbers.gap", padding: 32 },
  tokens: {
    colors: [
      { name: "canvas", value: "#F8FAFC" },
      { name: "primary", value: "#2563EB" },
      { name: "pressed", value: "#1D4ED8" },
      { name: "white", value: "#FFFFFF" },
    ],
    numbers: [
      { name: "gap", value: 20 },
      { name: "radius", value: 12 },
    ],
  },
  nodes: [
    { key: "advanced-title", name: "Title", type: "text", content: "Tokens · image · SVG · variants", fontSize: 28, fontWeight: "Semi Bold", color: "#0F172A" },
    { key: "advanced-assets", name: "Assets", type: "frame", width: "fill", height: 112, layout: { direction: "horizontal", gap: 20, padding: 16, counterAlign: "center" }, background: "#E2E8F0", cornerRadius: "$numbers.radius" },
    { key: "advanced-image", parentKey: "advanced-assets", name: "Embedded PNG", type: "image", data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=", mimeType: "image/png", width: 80, height: 80, cornerRadius: 12 },
    { key: "advanced-svg", parentKey: "advanced-assets", name: "Embedded SVG", type: "svg", svg: "<svg xmlns=\"http://www.w3.org/2000/svg\" width=\"80\" height=\"80\" viewBox=\"0 0 80 80\"><circle cx=\"40\" cy=\"40\" r=\"36\" fill=\"#8B5CF6\"/><path d=\"M24 41l10 10 22-24\" fill=\"none\" stroke=\"white\" stroke-width=\"7\" stroke-linecap=\"round\" stroke-linejoin=\"round\"/></svg>", width: 80, height: 80 },
    { key: "advanced-button-set", name: "Button", type: "componentSet" },
    { key: "advanced-button-default", parentKey: "advanced-button-set", name: "Default", type: "component", variant: [{ property: "State", value: "Default" }], width: 200, height: 52, background: "$colors.primary", cornerRadius: "$numbers.radius", layout: { direction: "horizontal", padding: 14, primaryAlign: "center", counterAlign: "center" } },
    { key: "advanced-label-default", parentKey: "advanced-button-default", name: "Label", type: "text", content: "Default", fontSize: 15, fontWeight: "Semi Bold", color: "$colors.white" },
    { key: "advanced-button-pressed", parentKey: "advanced-button-set", name: "Pressed", type: "component", variant: [{ property: "State", value: "Pressed" }], width: 200, height: 52, background: "$colors.pressed", cornerRadius: "$numbers.radius", layout: { direction: "horizontal", padding: 14, primaryAlign: "center", counterAlign: "center" } },
    { key: "advanced-label-pressed", parentKey: "advanced-button-pressed", name: "Label", type: "text", content: "Pressed", fontSize: 15, fontWeight: "Semi Bold", color: "$colors.white" },
    { key: "advanced-instance-zone", name: "Selected Variant", type: "frame", width: "fill", height: 100, layout: { direction: "horizontal", padding: 24, counterAlign: "center" }, background: "#DBEAFE", cornerRadius: 12 },
  ],
};

try {
  await client.connect(transport);
  console.log("RENDER", JSON.stringify(await call("render_screen", { spec })));
  console.log("INSTANCE", JSON.stringify(await call("use_component", {
    sourceKey: "advanced-button-set",
    parentKey: "advanced-instance-zone",
    key: "advanced-pressed-instance",
    name: "Pressed Instance",
    variant: { State: "Pressed" },
    screenshot: true,
  })));
  console.log("INSPECT", JSON.stringify(await call("inspect_selection", { depth: 2, screenshot: true, includeFiles: true })));
} finally {
  await client.close();
}
