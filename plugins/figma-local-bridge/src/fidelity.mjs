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
    listOptions: z.object({ type: z.enum(["NONE", "ORDERED", "UNORDERED"]) }).strict().optional(),
    listSpacing: z.number().nonnegative().optional(), indentation: z.number().int().nonnegative().optional(),
    textAutoResize: z.enum(["NONE", "HEIGHT", "WIDTH_AND_HEIGHT", "TRUNCATE"]).optional(),
    textAlignVertical: z.enum(["TOP", "CENTER", "BOTTOM"]).optional(),
    paragraphSpacing: z.number().nonnegative().optional(), paragraphIndent: z.number().nonnegative().optional(),
  };
}

// Serialized with the compiler; only documented, allowlisted properties are assigned.
export function createFidelityRuntime(figma) {
  const fields = ["isMask", "maskType", "topLeftRadius", "topRightRadius", "bottomLeftRadius", "bottomRightRadius", "cornerSmoothing", "strokeAlign", "strokeTopWeight", "strokeBottomWeight", "strokeLeftWeight", "strokeRightWeight", "dashPattern", "blendMode", "rotation", "layoutPositioning", "constraints", "minWidth", "maxWidth", "minHeight", "maxHeight"];
  const geometry = { vectorPaths: ["VECTOR"], booleanOperation: ["BOOLEAN_OPERATION"], pointCount: ["POLYGON", "STAR"], strokeCap: ["VECTOR", "LINE"], strokeJoin: ["VECTOR", "LINE"] };
  function insideInstance(node) { for (let p = node.parent; p; p = p.parent) if (p.type === "INSTANCE") return true; return false; }
  const immutableInstanceFields = ["isMask", "maskType", "x", "y", "rotation", "layoutPositioning", "constraints", "minWidth", "maxWidth", "minHeight", "maxHeight"];
  function sameValue(a, b) {
  if (a === b) return true;
  if (!a || !b || typeof a !== "object" || typeof b !== "object" || Array.isArray(a) !== Array.isArray(b)) return false;
  if (Array.isArray(a) && a.length !== b.length) return false;
  const keys = Object.keys(a);
  return keys.length === Object.keys(b).length && keys.every(key => Object.prototype.hasOwnProperty.call(b, key) && sameValue(a[key], b[key]));
}
  const same = sameValue;
  function samePaints(a, b) {
    // Figma returns an empty binding map for unbound paints; omitted input has
    // the same meaning. Preserve every nonempty alias and all other fields.
    function withoutEmptyBindings(value) {
      if (!value || typeof value !== "object" || Array.isArray(value)) return value;
      const copy = { ...value };
      if (copy.boundVariables && typeof copy.boundVariables === "object" && !Array.isArray(copy.boundVariables) && !Object.keys(copy.boundVariables).length) delete copy.boundVariables;
      return copy;
    }
    const normalize = value => Array.isArray(value) ? value.map(paint => {
      const copy = withoutEmptyBindings(paint);
      if (copy && Array.isArray(copy.gradientStops)) copy.gradientStops = copy.gradientStops.map(withoutEmptyBindings);
      return copy;
    }) : value;
    return same(normalize(a), normalize(b));
  }
  async function validate(item, node) {
    if (node && insideInstance(node)) for (const field of immutableInstanceFields) {
      if (item[field] !== undefined && !same(node[field], item[field])) throw new Error("Нельзя менять " + field + " внутри экземпляра: " + node.id);
    }
    for (const [field, types] of Object.entries(geometry)) if (item[field] !== undefined) {
      const type = node?.type || ({line:"LINE",vector:"VECTOR",polygon:"POLYGON",star:"STAR",booleanOperation:"BOOLEAN_OPERATION"})[item.type];
      if (!types.includes(type)) throw new Error(field + " не поддерживается типом " + type);
      if (node && insideInstance(node) && !same(node[field], item[field])) throw new Error("Нельзя менять " + field + " внутри экземпляра: " + node.id);
    }
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
    for (const field of ["fillStyleId", "strokeStyleId"]) if (item[field] !== undefined && !same(node[field], item[field])) await node["set" + field[0].toUpperCase() + field.slice(1) + "Async"](item[field]);
    for (const field of Object.keys(geometry)) if (item[field] !== undefined && !same(node[field], item[field])) node[field] = item[field];
    for (const field of ["fills", "strokes", ...fields]) if (item[field] !== undefined && !(["fills", "strokes"].includes(field) ? samePaints : same)(node[field], item[field])) node[field] = item[field];
    if (node.type === "TEXT") for (const run of item.textRuns || []) if (run.fills !== undefined && !samePaints(node.getRangeFills(run.start, run.end), run.fills)) node.setRangeFills(run.start, run.end, run.fills);
  }
  function position(node, item) {
    if ((item.x === undefined || same(node.x, item.x)) && (item.y === undefined || same(node.y, item.y))) return;
    if (node.parent?.layoutMode && node.parent.layoutMode !== "NONE" && node.layoutPositioning !== "ABSOLUTE") throw new Error("x/y требуют свободной раскладки или layoutPositioning: ABSOLUTE: " + node.name);
    if (item.x !== undefined && !same(node.x, item.x)) node.x = item.x;
    if (item.y !== undefined && !same(node.y, item.y)) node.y = item.y;
  }
  return { validate, apply, position, samePaints };
}
