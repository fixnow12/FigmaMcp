import { z } from "zod";

export const exportAssetsInputSchema = {
  fileKey: z.string().min(1).optional(),
  nodeIds: z.array(z.string().min(1).max(160)).min(1).max(20),
  format: z.enum(["svg", "images"]).default("svg"),
  maxBytes: z.number().int().min(1024).max(8_000_000).default(2_000_000),
};
export const exportAssetsSchema = z.object(exportAssetsInputSchema).strict();

// Exports only explicit targets; never traverses a whole file or substitutes a bitmap for SVG.
export function buildExportAssetsCode(input) {
  return `
const input = ${JSON.stringify(input).replaceAll("</", "<\\/")};
const assets = [], warnings = [];
const hashes = new Set();
let used = 0;
for (const nodeId of input.nodeIds) {
  const node = await figma.getNodeByIdAsync(nodeId);
  if (!node) { warnings.push({ nodeId, reason: "missing" }); continue; }
  try {
    if (input.format === "svg") {
      const svg = await node.exportAsync({ format: "SVG_STRING", svgOutlineText: true });
      // UTF-8 upper bound prevents non-ASCII strings exceeding the transport budget.
      const bytes = svg.length * 3;
      if (used + bytes > input.maxBytes) { warnings.push({ nodeId, reason: "maxBytes" }); continue; }
      used += bytes;
      assets.push({ nodeId, name: node.name, type: "svg", svg, width: node.width, height: node.height });
    } else {
      const paints = [...(Array.isArray(node.fills) ? node.fills : []), ...(Array.isArray(node.strokes) ? node.strokes : [])];
      if (node.type === "TEXT") for (const segment of node.getStyledTextSegments(["fills"])) paints.push(...segment.fills);
      const images = paints.filter(p => p.type === "IMAGE");
      if (!images.length) warnings.push({ nodeId, reason: "no_image_paints", message: "Укажите узел с IMAGE-заливкой, а не его контейнер" });
      for (const paint of images) {
        if (hashes.has(paint.imageHash)) continue;
        const resource = figma.getImageByHash(paint.imageHash);
        if (!resource) { warnings.push({ nodeId, reason: "missing_image", imageHash: paint.imageHash }); continue; }
        const bytes = await resource.getBytesAsync();
        const encodedLength = 4 * Math.ceil(bytes.length / 3);
        if (used + encodedLength > input.maxBytes) { warnings.push({ nodeId, reason: "maxBytes", imageHash: paint.imageHash }); continue; }
        used += encodedLength;
        hashes.add(paint.imageHash);
        const mimeType = bytes[0] === 137 && bytes[1] === 80 ? "image/png" : bytes[0] === 255 && bytes[1] === 216 ? "image/jpeg" : "application/octet-stream";
        assets.push({ nodeId, imageHash: paint.imageHash, mimeType, data: figma.base64Encode(bytes), paint });
      }
    }
  } catch (error) { warnings.push({ nodeId, reason: "export_failed", message: error.message }); }
}
return { assets, warnings, complete: warnings.length === 0, encodedBytesUpperBound: used };
`;
}
