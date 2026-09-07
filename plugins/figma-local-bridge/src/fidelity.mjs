import { z } from "zod";

const unit = () => z.number().min(0).max(1);
const rgb = () => z.object({ r: unit(), g: unit(), b: unit() }).strict();
const rgba = () => z.object({ r: unit(), g: unit(), b: unit(), a: unit() }).strict();
const alias = () => z.object({ type: z.literal("VARIABLE_ALIAS"), id: z.string().min(1) }).strict();
// Homogeneous fixed-length arrays preserve Figma's 2×3 matrix validation
// without tuple-style JSON Schema `items: [...]`, which MCP clients may reject.
const transform = () => z.array(z.array(z.number()).length(3)).length(2);
const blend = () => z.enum(["NORMAL", "DARKEN", "MULTIPLY", "COLOR_BURN", "LIGHTEN", "SCREEN", "COLOR_DODGE", "OVERLAY", "SOFT_LIGHT", "HARD_LIGHT", "DIFFERENCE", "EXCLUSION", "HUE", "SATURATION", "COLOR", "LUMINOSITY"]);

// Factories avoid shared $refs in the public MCP schema. No arbitrary paint JSON.
export function paintsSchema() {
  return z.array(z.object({
    type: z.enum(["SOLID", "GRADIENT_LINEAR", "GRADIENT_RADIAL", "GRADIENT_ANGULAR", "GRADIENT_DIAMOND", "IMAGE"]),
    visible: z.boolean().optional(), opacity: unit().optional(), blendMode: blend().optional(),
    color: rgb().optional(),
    boundVariables: z.object({ color: alias().optional() }).strict().optional(),
    gradientTransform: transform().optional(),
    gradientStops: z.array(z.object({ position: unit(), color: rgba(), boundVariables: z.object({ color: alias().optional() }).strict().optional() }).strict()).min(2).max(100).optional(),
    imageHash: z.string().min(1).optional(),
    scaleMode: z.enum(["FILL", "FIT", "CROP", "TILE"]).optional(),
    imageTransform: transform().optional(), scalingFactor: z.number().positive().optional(), rotation: z.number().optional(),
    filters: z.object(Object.fromEntries(["exposure", "contrast", "saturation", "temperature", "tint", "highlights", "shadows"].map(k => [k, z.number().min(-1).max(1).optional()]))).strict().optional(),
  }).strict().superRefine((p, ctx) => {
    const issue = message => ctx.addIssue({ code: z.ZodIssueCode.custom, message });
    if (p.type === "SOLID" && !p.color) issue("SOLID требует color");
    if (p.type.startsWith("GRADIENT") && (!p.gradientStops || !p.gradientTransform)) issue("Градиент требует gradientStops и gradientTransform");
    if (p.type === "IMAGE" && (!p.imageHash || !p.scaleMode)) issue("IMAGE требует imageHash и scaleMode");
    const forbidden = p.type === "SOLID" ? ["gradientStops", "gradientTransform", "imageHash", "scaleMode", "imageTransform", "scalingFactor", "rotation", "filters"]
      : p.type === "IMAGE" ? ["color", "gradientStops", "gradientTransform", "boundVariables"]
        : ["color", "imageHash", "scaleMode", "imageTransform", "scalingFactor", "rotation", "filters", "boundVariables"];
    if (forbidden.some(k => p[k] !== undefined)) issue("Поля не соответствуют типу заливки " + p.type);
  })).max(32);
}

export function fidelityFields() {
  return {
    fills: paintsSchema().optional(), strokes: paintsSchema().optional(),
    fillStyleId: z.string().optional(), strokeStyleId: z.string().optional(),
    topLeftRadius: z.number().nonnegative().optional(), topRightRadius: z.number().nonnegative().optional(),
    bottomLeftRadius: z.number().nonnegative().optional(), bottomRightRadius: z.number().nonnegative().optional(),
    cornerSmoothing: unit().optional(),
    strokeAlign: z.enum(["INSIDE", "OUTSIDE", "CENTER"]).optional(),
    strokeTopWeight: z.number().nonnegative().optional(), strokeBottomWeight: z.number().nonnegative().optional(),
    strokeLeftWeight: z.number().nonnegative().optional(), strokeRightWeight: z.number().nonnegative().optional(),
    dashPattern: z.array(z.number().nonnegative()).max(100).optional(),
    isMask: z.boolean().optional(), maskType: z.enum(["ALPHA", "VECTOR", "LUMINANCE"]).optional(),
    blendMode: z.union([blend(), z.literal("PASS_THROUGH")]).optional(),
    x: z.number().optional(), y: z.number().optional(), rotation: z.number().optional(),
    layoutPositioning: z.enum(["AUTO", "ABSOLUTE"]).optional(),
    minWidth: z.number().nonnegative().nullable().optional(), maxWidth: z.number().nonnegative().nullable().optional(),
    minHeight: z.number().nonnegative().nullable().optional(), maxHeight: z.number().nonnegative().nullable().optional(),
    constraints: z.object({ horizontal: z.enum(["MIN", "CENTER", "MAX", "STRETCH", "SCALE"]), vertical: z.enum(["MIN", "CENTER", "MAX", "STRETCH", "SCALE"]) }).strict().optional(),
  };
}

export function textFidelityFields() {
  return {
    textAutoResize: z.enum(["NONE", "HEIGHT", "WIDTH_AND_HEIGHT", "TRUNCATE"]).optional(),
    textAlignVertical: z.enum(["TOP", "CENTER", "BOTTOM"]).optional(),
    paragraphSpacing: z.number().nonnegative().optional(), paragraphIndent: z.number().nonnegative().optional(),
  };
}

// Serialized with the compiler; only documented, allowlisted properties are assigned.
export function createFidelityRuntime(figma) {
  const fields = ["isMask", "maskType", "topLeftRadius", "topRightRadius", "bottomLeftRadius", "bottomRightRadius", "cornerSmoothing", "strokeAlign", "strokeTopWeight", "strokeBottomWeight", "strokeLeftWeight", "strokeRightWeight", "dashPattern", "blendMode", "rotation", "layoutPositioning", "constraints", "minWidth", "maxWidth", "minHeight", "maxHeight"];
  async function validate(item, node) {
    for (const field of [...fields, "fills", "strokes", "fillStyleId", "strokeStyleId"]) {
      if (node && item[field] !== undefined && !(field in node)) throw new Error("Узел не поддерживает " + field + ": " + node.name);
    }
    for (const field of ["fillStyleId", "strokeStyleId"]) if (item[field]) {
      if ((await figma.getStyleByIdAsync(item[field]))?.type !== "PAINT") throw new Error("Не найден стиль заливки: " + item[field]);
    }
    for (const p of [...(item.fills || []), ...(item.strokes || []), ...(item.textRuns || []).flatMap(r => r.fills || [])]) {
      if (p.type === "IMAGE" && !figma.getImageByHash(p.imageHash)) throw new Error("Изображение недоступно в этом файле: " + p.imageHash + ". Импортируйте исходные байты через image.");
    }
  }
  async function apply(node, item) {
    await validate(item, node);
    for (const field of ["fillStyleId", "strokeStyleId"]) if (item[field] !== undefined) await node["set" + field[0].toUpperCase() + field.slice(1) + "Async"](item[field]);
    for (const field of ["fills", "strokes", ...fields]) if (item[field] !== undefined) node[field] = item[field];
    if (node.type === "TEXT") for (const run of item.textRuns || []) if (run.fills !== undefined) node.setRangeFills(run.start, run.end, run.fills);
  }
  function position(node, item) {
    if (item.x === undefined && item.y === undefined) return;
    if (node.parent?.layoutMode && node.parent.layoutMode !== "NONE" && node.layoutPositioning !== "ABSOLUTE") throw new Error("x/y требуют свободной раскладки или layoutPositioning: ABSOLUTE: " + node.name);
    if (item.x !== undefined) node.x = item.x;
    if (item.y !== undefined) node.y = item.y;
  }
  return { validate, apply, position };
}
