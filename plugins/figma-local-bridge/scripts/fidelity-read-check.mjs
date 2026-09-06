// Read-only live check through the public figma-local MCP server, not raw Plugin API.
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { fileURLToPath } from "node:url";
const root = fileURLToPath(new URL("../", import.meta.url));
const [fileKey, nodeId] = process.argv.slice(2);
if (!fileKey || !nodeId) throw new Error("Usage: node scripts/fidelity-read-check.mjs <fileKey> <nodeId>");
const transport = new StdioClientTransport({ command: process.execPath, args: [root + "src/server.mjs"], cwd: root, stderr: "pipe" });
const client = new Client({ name: "fidelity-read-check", version: "1.0.0" });
async function call(name, args) {
  const response = await client.callTool({ name, arguments: { fileKey, ...args } });
  if (response.isError) throw new Error(JSON.stringify(response.structuredContent || response.content));
  return response.structuredContent?.result || JSON.parse(response.content.find(c => c.type === "text").text).result;
}
try {
  await client.connect(transport);
  const result = await call("inspect_selection", { nodeId, detail: "full", depth: 8, maxNodes: 1000 });
  const nodes = [];
  const visit = node => { nodes.push(node); (node.children || []).forEach(visit); };
  result.selection.forEach(visit);
  // Complete shallow branches explicitly; never infer omitted text.
  const queue = [...result.coverage.unread];
  const seen = new Set();
  while (queue.length && seen.size < 100) {
    const next = queue.shift(); if (seen.has(next.nodeId)) continue; seen.add(next.nodeId);
    const branch = await call("inspect_selection", { nodeId: next.nodeId, detail: "full", depth: 8, maxNodes: 1000 });
    branch.selection.forEach(visit); queue.push(...branch.coverage.unread);
  }
  const unique = [...new Map(nodes.map(n => [n.id, n])).values()];
  const vector = unique.find(n => n.type === "VECTOR");
  const photo = unique.find(n => Array.isArray(n.fills) && n.fills.some(p => p.type === "IMAGE"));
  const svg = vector ? await call("export_assets", { nodeIds: [vector.id], format: "svg" }) : null;
  const images = photo ? await call("export_assets", { nodeIds: [photo.id], format: "images" }) : null;
  console.log(JSON.stringify({ inspected: unique.length, initialIncomplete: !result.coverage.complete, branchReads: seen.size,
    remainingBranches: queue.length, rootRadius: result.selection[0]?.cornerRadius,
    text: unique.filter(n => n.type === "TEXT").map(n => n.content),
    svg: svg && { complete: svg.complete, warnings: svg.warnings, length: svg.assets[0]?.svg?.length },
    image: images && { complete: images.complete, warnings: images.warnings, mimeType: images.assets[0]?.mimeType, length: images.assets[0]?.data?.length },
  }, null, 2));
} finally { await client.close(); }
