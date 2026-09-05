import { z } from "zod";

const id = () => z.string().min(1).max(160);
const position = () => z.object({ x: z.number(), y: z.number() }).strict();
const preview = () => ({ screenshot: z.boolean().optional(), screenshotScale: z.number().min(0.5).max(4).optional(), fileKey: id().optional() });

export const cloneNodesInputSchema = {
  copies: z.array(z.object({
    sourceId: id(), parentId: id().optional(), key: id(),
    name: z.string().min(1).max(240).optional(),
    index: z.number().int().nonnegative().optional(), position: position().optional(),
  }).strict()).min(1).max(20),
  maxNodes: z.number().int().min(1).max(2000).optional(),
  ...preview(),
};
export const cloneNodesSchema = z.object(cloneNodesInputSchema).strict().superRefine((input, context) => {
  const keys = new Set();
  input.copies.forEach((copy, index) => {
    if (keys.has(copy.key)) context.addIssue({ code: z.ZodIssueCode.custom, message: "Ключи копий должны быть уникальны", path: ["copies", index, "key"] });
    keys.add(copy.key);
  });
});

export const moveNodesInputSchema = {
  moves: z.array(z.object({
    id: id(), parentId: id().optional(), index: z.number().int().nonnegative().optional(), position: position().optional(),
  }).strict().refine((item) => item.parentId !== undefined || item.index !== undefined || item.position !== undefined, "Укажите parentId, index или position")).min(1).max(100),
  ...preview(),
};
export const moveNodesSchema = z.object(moveNodesInputSchema).strict().refine(
  (input) => new Set(input.moves.map((item) => item.id)).size === input.moves.length,
  "Каждый узел может перемещаться только один раз в пакете",
);

export const findAssetsInputSchema = {
  kind: z.enum(["nodes", "components", "styles", "variables", "library_collections", "library_variables"]),
  query: z.string().max(240).optional(),
  scope: z.enum(["page", "file"]).optional(),
  types: z.array(z.enum(["FRAME", "SECTION", "GROUP", "TEXT", "RECTANGLE", "ELLIPSE", "VECTOR", "INSTANCE", "COMPONENT", "COMPONENT_SET"])).min(1).max(10).optional(),
  collectionKey: id().optional(),
  offset: z.number().int().nonnegative().optional(),
  limit: z.number().int().min(1).max(200).optional(),
  fileKey: id().optional(),
};
export const findAssetsSchema = z.object(findAssetsInputSchema).strict().superRefine((input, context) => {
  if (input.kind === "library_variables" && !input.collectionKey) context.addIssue({ code: z.ZodIssueCode.custom, message: "Для library_variables нужен collectionKey" });
  if (input.kind !== "library_variables" && input.collectionKey) context.addIssue({ code: z.ZodIssueCode.custom, message: "collectionKey используется только для library_variables" });
  if (input.kind !== "nodes" && input.types) context.addIssue({ code: z.ZodIssueCode.custom, message: "types используется только для поиска nodes" });
  if (input.scope && !["nodes", "components"].includes(input.kind)) context.addIssue({ code: z.ZodIssueCode.custom, message: "scope используется только для nodes/components; остальные ресурсы относятся к файлу" });
});

export const bindVariablesInputSchema = {
  bindings: z.array(z.object({
    nodeId: id(),
    field: z.enum(["fills", "strokes", "width", "height", "opacity", "visible", "itemSpacing", "paddingTop", "paddingRight", "paddingBottom", "paddingLeft", "topLeftRadius", "topRightRadius", "bottomLeftRadius", "bottomRightRadius", "fontSize", "characters"]),
    variableId: id().nullable(),
    paintIndex: z.number().int().nonnegative().optional(),
  }).strict()).min(1).max(100),
  allowComponentChanges: z.boolean().optional(),
  ...preview(),
};
export const bindVariablesSchema = z.object(bindVariablesInputSchema).strict().superRefine((input, context) => {
  const targets = new Set();
  input.bindings.forEach((binding, index) => {
    const paint = ["fills", "strokes"].includes(binding.field);
    if (!paint && binding.paintIndex !== undefined) context.addIssue({ code: z.ZodIssueCode.custom, message: "paintIndex допустим только для fills/strokes", path: ["bindings", index] });
    const key = JSON.stringify([binding.nodeId, binding.field, paint ? binding.paintIndex ?? 0 : null]);
    if (targets.has(key)) context.addIssue({ code: z.ZodIssueCode.custom, message: "Повторяющаяся цель привязки", path: ["bindings", index] });
    targets.add(key);
  });
});
