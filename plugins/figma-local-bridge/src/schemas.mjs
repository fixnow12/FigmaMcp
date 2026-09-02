import { z } from "zod";

const keySchema = z.string().min(1).max(160);
const nameSchema = z.string().min(1).max(240);
const hexColor = z
  .string()
  .regex(/^#[0-9a-fA-F]{6}([0-9a-fA-F]{2})?$/, "Ожидается цвет #RRGGBB или #RRGGBBAA");

const tokenRef = z.object({ token: z.string().min(1).max(160) }).strict();
const colorValue = z.union([hexColor, tokenRef]);
const numberValue = z.union([z.number(), tokenRef]);
const nonnegativeValue = z.union([z.number().nonnegative(), tokenRef]);
const positiveValue = z.union([z.number().positive(), tokenRef]);
const unitValue = z.union([z.number().min(0).max(1), tokenRef]);
const dimension = z.union([positiveValue, z.enum(["fill", "hug"])]);
const paddingObject = z
  .object({
    top: nonnegativeValue.optional(),
    right: nonnegativeValue.optional(),
    bottom: nonnegativeValue.optional(),
    left: nonnegativeValue.optional(),
  })
  .strict();
const padding = z.union([nonnegativeValue, paddingObject]);
const concreteDimension = z.union([z.number().positive(), z.enum(["fill", "hug"])]);
const concretePaddingObject = z.object({
  top: z.number().nonnegative().optional(),
  right: z.number().nonnegative().optional(),
  bottom: z.number().nonnegative().optional(),
  left: z.number().nonnegative().optional(),
}).strict();
const concretePadding = z.union([z.number().nonnegative(), concretePaddingObject]);

const layout = z
  .object({
    direction: z.enum(["horizontal", "vertical", "none"]).optional(),
    gap: nonnegativeValue.optional(),
    padding: padding.optional(),
    primaryAlign: z.enum(["start", "center", "end", "space-between"]).optional(),
    counterAlign: z.enum(["start", "center", "end", "baseline"]).optional(),
    wrap: z.boolean().optional(),
  })
  .strict();

const common = {
  key: keySchema,
  parentKey: keySchema.optional(),
  order: z.number().int().nonnegative().optional(),
  name: nameSchema,
  width: dimension.optional(),
  height: dimension.optional(),
  opacity: unitValue.optional(),
  visible: z.boolean().optional(),
};

const containerFields = {
  ...common,
  background: colorValue.optional(),
  stroke: colorValue.optional(),
  strokeWidth: nonnegativeValue.optional(),
  cornerRadius: nonnegativeValue.optional(),
  clipContent: z.boolean().optional(),
  layout: layout.optional(),
};

export const designNodeSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("frame"), ...containerFields }).strict(),
  z.object({ type: z.literal("component"), ...containerFields, variant: z.record(z.string()).optional() }).strict(),
  z.object({ type: z.literal("componentSet"), ...containerFields }).strict(),
  z
    .object({
      type: z.literal("text"),
      ...common,
      content: z.string(),
      fontFamily: z.string().min(1).optional(),
      fontWeight: z.string().min(1).optional(),
      fontSize: positiveValue.optional(),
      lineHeight: positiveValue.optional(),
      letterSpacing: numberValue.optional(),
      color: colorValue.optional(),
      textAlign: z.enum(["left", "center", "right", "justified"]).optional(),
    })
    .strict(),
  z
    .object({
      type: z.literal("rectangle"),
      ...common,
      fill: colorValue.optional(),
      stroke: colorValue.optional(),
      strokeWidth: nonnegativeValue.optional(),
      cornerRadius: nonnegativeValue.optional(),
    })
    .strict(),
  z
    .object({
      type: z.literal("ellipse"),
      ...common,
      fill: colorValue.optional(),
      stroke: colorValue.optional(),
      strokeWidth: nonnegativeValue.optional(),
    })
    .strict(),
  z
    .object({
      type: z.literal("image"),
      ...common,
      data: z.string().min(1).max(30_000_000),
      mimeType: z.enum(["image/png", "image/jpeg"]),
      scaleMode: z.enum(["fill", "fit", "crop", "tile"]).optional(),
      cornerRadius: nonnegativeValue.optional(),
    })
    .strict(),
  z
    .object({
      type: z.literal("svg"),
      ...common,
      svg: z.string().min(1).max(2_000_000),
    })
    .strict(),
]);

export const screenSpecBaseSchema = z
  .object({
    $schema: z.string().optional(),
    key: keySchema,
    name: nameSchema,
    type: z.literal("screen"),
    width: z.number().positive(),
    height: z.number().positive(),
    background: colorValue.optional(),
    cornerRadius: nonnegativeValue.optional(),
    layout: layout.optional(),
    tokens: z
      .object({
        colors: z.record(hexColor).optional(),
        numbers: z.record(z.number()).optional(),
      })
      .strict()
      .optional(),
    nodes: z.array(designNodeSchema).max(2000),
  })
  .strict();

// Публичная схема render_screen намеренно не использует discriminatedUnion и
// повторно используемые Zod-объекты. Некоторые MCP-клиенты не разворачивают
// anyOf/$ref и показывают такие поля модели как unknown. Строгая проверка по
// типам узлов остаётся во внутренней screenSpecBaseSchema ниже по потоку.
const publicColor = () => z.string().min(1).max(180);
const publicNumber = ({ minimum, exclusiveMinimum, maximum } = {}) => {
  let schema = z.number();
  if (minimum !== undefined) schema = schema.min(minimum);
  if (exclusiveMinimum !== undefined) schema = schema.gt(exclusiveMinimum);
  if (maximum !== undefined) schema = schema.max(maximum);
  return z.union([schema, z.string().min(1).max(180)]);
};
const publicDimension = () => z.union([
  z.number().positive(),
  z.string().min(1).max(180),
]);
const publicPadding = () => z.union([
  z.number().nonnegative(),
  z.string().min(1).max(180),
  z.object({
    top: publicNumber({ minimum: 0 }).optional(),
    right: publicNumber({ minimum: 0 }).optional(),
    bottom: publicNumber({ minimum: 0 }).optional(),
    left: publicNumber({ minimum: 0 }).optional(),
  }).strict(),
]);
const publicLayout = () => z.object({
  direction: z.enum(["horizontal", "vertical", "none"]).optional(),
  gap: publicNumber({ minimum: 0 }).optional(),
  padding: publicPadding().optional(),
  primaryAlign: z.enum(["start", "center", "end", "space-between"]).optional(),
  counterAlign: z.enum(["start", "center", "end", "baseline"]).optional(),
  wrap: z.boolean().optional(),
}).strict();

const publicDesignNodeSchema = z.object({
  type: z.enum(["frame", "component", "componentSet", "text", "rectangle", "ellipse", "image", "svg"]),
  key: z.string().min(1).max(160),
  parentKey: z.string().min(1).max(160).optional(),
  order: z.number().int().nonnegative().optional(),
  name: z.string().min(1).max(240),
  width: publicDimension().optional(),
  height: publicDimension().optional(),
  opacity: publicNumber({ minimum: 0, maximum: 1 }).optional(),
  visible: z.boolean().optional(),
  background: publicColor().optional(),
  fill: publicColor().optional(),
  stroke: publicColor().optional(),
  strokeWidth: publicNumber({ minimum: 0 }).optional(),
  cornerRadius: publicNumber({ minimum: 0 }).optional(),
  clipContent: z.boolean().optional(),
  layout: publicLayout().optional(),
  content: z.string().optional(),
  fontFamily: z.string().min(1).optional(),
  fontWeight: z.string().min(1).optional(),
  fontSize: publicNumber({ exclusiveMinimum: 0 }).optional(),
  lineHeight: publicNumber({ exclusiveMinimum: 0 }).optional(),
  letterSpacing: publicNumber().optional(),
  color: publicColor().optional(),
  textAlign: z.enum(["left", "center", "right", "justified"]).optional(),
  data: z.string().min(1).max(30_000_000).optional(),
  mimeType: z.enum(["image/png", "image/jpeg"]).optional(),
  scaleMode: z.enum(["fill", "fit", "crop", "tile"]).optional(),
  svg: z.string().min(1).max(2_000_000).optional(),
  variant: z.array(z.object({ property: z.string().min(1), value: z.string() }).strict()).optional(),
}).strict();

export const screenSpecPublicSchema = z.object({
  $schema: z.string().optional(),
  key: z.string().min(1).max(160),
  name: z.string().min(1).max(240),
  type: z.literal("screen"),
  width: z.number().positive(),
  height: z.number().positive(),
  background: publicColor().optional(),
  cornerRadius: publicNumber({ minimum: 0 }).optional(),
  layout: publicLayout().optional(),
  tokens: z.object({
    colors: z.array(z.object({ name: z.string().min(1), value: z.string() }).strict()).optional(),
    numbers: z.array(z.object({ name: z.string().min(1), value: z.number() }).strict()).optional(),
  }).strict().optional(),
  nodes: z.array(publicDesignNodeSchema).max(2000),
}).strict();

export const screenSpecSchema = screenSpecBaseSchema.superRefine((spec, context) => {
  const keys = new Set([spec.key]);
  for (const [index, node] of spec.nodes.entries()) {
    if (keys.has(node.key)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: `Повторяющийся key: ${node.key}`,
        path: ["nodes", index, "key"],
      });
    }
    keys.add(node.key);
  }

  const nodeKeys = new Set(spec.nodes.map((node) => node.key));
  const nodesByKey = new Map(spec.nodes.map((node) => [node.key, node]));
  const parents = new Map(spec.nodes.map((node) => [node.key, node.parentKey || spec.key]));
  for (const [index, node] of spec.nodes.entries()) {
    if (node.parentKey && node.parentKey !== spec.key && !nodeKeys.has(node.parentKey)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: `Не найден parentKey: ${node.parentKey}`,
        path: ["nodes", index, "parentKey"],
      });
    }

    if (node.parentKey && node.parentKey !== spec.key) {
      const parent = nodesByKey.get(node.parentKey);
      if (parent && !["frame", "component", "componentSet"].includes(parent.type)) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message: `Узел ${parent.key} типа ${parent.type} не может содержать дочерние узлы`,
          path: ["nodes", index, "parentKey"],
        });
      }
      if (parent?.type === "componentSet" && node.type !== "component") {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message: "Component set может содержать только component-варианты",
          path: ["nodes", index, "type"],
        });
      }
    }

    const visited = new Set([node.key]);
    let parent = parents.get(node.key);
    while (parent && parent !== spec.key) {
      if (visited.has(parent)) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message: `Циклическая иерархия около key: ${node.key}`,
          path: ["nodes", index, "parentKey"],
        });
        break;
      }
      visited.add(parent);
      parent = parents.get(parent);
    }
  }

  for (const [index, node] of spec.nodes.entries()) {
    if (node.type !== "componentSet") continue;
    const variants = spec.nodes.filter((candidate) => candidate.parentKey === node.key);
    if (variants.length < 2) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Component set должен содержать минимум два component-варианта",
        path: ["nodes", index],
      });
    }
  }
});

function resolveTokenReferences(value, tokens, path = "spec") {
  if (Array.isArray(value)) {
    return value.map((item, index) => resolveTokenReferences(item, tokens, `${path}[${index}]`));
  }
  if (!value || typeof value !== "object") return value;
  if (Object.keys(value).length === 1 && typeof value.token === "string") {
    const [group, ...rest] = value.token.split(".");
    const name = rest.join(".");
    if (!name || !["colors", "numbers"].includes(group)) {
      throw new Error(`Некорректная ссылка на токен ${value.token} в ${path}`);
    }
    const resolved = tokens?.[group]?.[name];
    if (resolved === undefined) throw new Error(`Не найден токен ${value.token} в ${path}`);
    return resolved;
  }
  return Object.fromEntries(
    Object.entries(value).map(([key, item]) => [
      key,
      key === "tokens" ? item : resolveTokenReferences(item, tokens, `${path}.${key}`),
    ]),
  );
}

export function resolveScreenSpecTokens(input) {
  const parsed = screenSpecSchema.parse(input);
  const resolved = resolveTokenReferences(parsed, parsed.tokens);
  return screenSpecSchema.parse(resolved);
}

export function normalizeScreenSpec(input) {
  const publicResult = screenSpecPublicSchema.safeParse(input);
  const spec = resolveScreenSpecTokens(
    publicResult.success ? adaptPublicScreenSpec(publicResult.data) : input,
  );
  const byParent = new Map();
  for (const node of spec.nodes) {
    const parentKey = node.parentKey || spec.key;
    const list = byParent.get(parentKey) || [];
    list.push(node);
    byParent.set(parentKey, list);
  }
  for (const list of byParent.values()) {
    list.sort((a, b) => (a.order ?? Number.MAX_SAFE_INTEGER) - (b.order ?? Number.MAX_SAFE_INTEGER));
  }
  const buildChildren = (parentKey) =>
    (byParent.get(parentKey) || []).map((node) => {
      const { parentKey: _parentKey, order: _order, ...rest } = node;
      if (node.type === "frame" || node.type === "component" || node.type === "componentSet") {
        return { ...rest, children: buildChildren(node.key) };
      }
      return rest;
    });
  const { nodes: _nodes, ...root } = spec;
  return { ...root, children: buildChildren(spec.key) };
}

function publicTokenValue(value) {
  return typeof value === "string" && /^\$(colors|numbers)\.[^.].*/.test(value)
    ? { token: value.slice(1) }
    : value;
}

function publicLayoutToInternal(value) {
  if (!value) return value;
  const paddingValue = value.padding;
  const padding = paddingValue && typeof paddingValue === "object"
    ? Object.fromEntries(Object.entries(paddingValue).map(([key, item]) => [key, publicTokenValue(item)]))
    : publicTokenValue(paddingValue);
  return {
    ...value,
    gap: publicTokenValue(value.gap),
    padding,
  };
}

function withoutUndefined(value) {
  return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined));
}

export function adaptPublicScreenSpec(spec) {
  const tokens = spec.tokens
    ? {
        colors: Object.fromEntries((spec.tokens.colors || []).map(({ name, value }) => [name, value])),
        numbers: Object.fromEntries((spec.tokens.numbers || []).map(({ name, value }) => [name, value])),
      }
    : undefined;
  const nodes = spec.nodes.map((node) => withoutUndefined({
      ...node,
      width: publicTokenValue(node.width),
      height: publicTokenValue(node.height),
      opacity: publicTokenValue(node.opacity),
      background: publicTokenValue(node.background),
      fill: publicTokenValue(node.fill),
      stroke: publicTokenValue(node.stroke),
      strokeWidth: publicTokenValue(node.strokeWidth),
      cornerRadius: publicTokenValue(node.cornerRadius),
      layout: publicLayoutToInternal(node.layout),
      fontSize: publicTokenValue(node.fontSize),
      lineHeight: publicTokenValue(node.lineHeight),
      letterSpacing: publicTokenValue(node.letterSpacing),
      color: publicTokenValue(node.color),
      variant: node.variant ? Object.fromEntries(node.variant.map(({ property, value }) => [property, value])) : undefined,
    }));
  return {
    ...spec,
    background: publicTokenValue(spec.background),
    cornerRadius: publicTokenValue(spec.cornerRadius),
    layout: publicLayoutToInternal(spec.layout),
    tokens,
    nodes,
  };
}

export const renderScreenInputSchema = {
  spec: screenSpecPublicSchema,
  replace: z.boolean().optional(),
  sectionName: nameSchema.optional(),
  position: z.object({ x: z.number(), y: z.number() }).strict().optional(),
  screenshot: z.boolean().optional(),
  screenshotScale: z.number().min(0.5).max(4).optional(),
  fileKey: z.string().min(1).optional(),
};

export const renderScreenSchema = z.object({
  ...renderScreenInputSchema,
  spec: screenSpecBaseSchema,
}).strict();

const renderScreenPublicSchema = z.object(renderScreenInputSchema).strict();

export function parseRenderScreenInput(input) {
  const parsed = renderScreenPublicSchema.parse(input);
  return renderScreenSchema.parse({ ...parsed, spec: adaptPublicScreenSpec(parsed.spec) });
}

const patchSetSchema = z
  .object({
    name: nameSchema.optional(),
    content: z.string().optional(),
    width: concreteDimension.optional(),
    height: concreteDimension.optional(),
    x: z.number().optional(),
    y: z.number().optional(),
    visible: z.boolean().optional(),
    opacity: z.number().min(0).max(1).optional(),
    background: hexColor.optional(),
    color: hexColor.optional(),
    stroke: hexColor.optional(),
    strokeWidth: z.number().nonnegative().optional(),
    cornerRadius: z.number().nonnegative().optional(),
    gap: z.number().nonnegative().optional(),
    padding: concretePadding.optional(),
    componentProperties: z.record(z.union([z.string(), z.boolean()])).optional(),
  })
  .strict()
  .refine((value) => Object.keys(value).length > 0, "Патч не должен быть пустым");

export const patchNodesInputSchema = {
  patches: z
    .array(
      z
        .object({
          key: keySchema.optional(),
          id: z.string().min(1).max(160).optional(),
          set: patchSetSchema.optional(),
          append: z.array(designNodeSchema).min(1).max(200).optional(),
        })
        .strict()
        .superRefine((value, context) => {
          if (Boolean(value.key) === Boolean(value.id)) {
            context.addIssue({ code: z.ZodIssueCode.custom, message: "Укажите ровно один target: key или id" });
          }
          if (!value.set && !value.append) {
            context.addIssue({ code: z.ZodIssueCode.custom, message: "Укажите set и/или append" });
          }
          if (!value.append) return;
          const keys = new Set();
          for (const [index, node] of value.append.entries()) {
            if (keys.has(node.key)) {
              context.addIssue({
                code: z.ZodIssueCode.custom,
                message: `Повторяющийся append key: ${node.key}`,
                path: ["append", index, "key"],
              });
            }
            keys.add(node.key);
          }
          for (const [index, node] of value.append.entries()) {
            if (node.parentKey && !keys.has(node.parentKey)) {
              context.addIssue({
                code: z.ZodIssueCode.custom,
                message: `Не найден append parentKey: ${node.parentKey}`,
                path: ["append", index, "parentKey"],
              });
            }
          }
        }),
    )
    .min(1)
    .max(200),
  ignoreMissing: z.boolean().optional(),
  screenshotKey: keySchema.optional(),
  screenshotScale: z.number().min(0.5).max(4).optional(),
  fileKey: z.string().min(1).optional(),
};
export const patchNodesSchema = z.object(patchNodesInputSchema).strict();

export const inspectSelectionInputSchema = {
  nodeId: z.string().min(1).max(160).optional(),
  depth: z.number().int().min(0).max(8).optional(),
  maxNodes: z.number().int().min(1).max(1000).optional(),
  screenshot: z.boolean().optional(),
  screenshotScale: z.number().min(0.5).max(4).optional(),
  includeFiles: z.boolean().optional(),
  fileKey: z.string().min(1).optional(),
};
export const inspectSelectionSchema = z.object(inspectSelectionInputSchema).strict();

export const useComponentInputSchema = {
  sourceKey: keySchema.optional(),
  libraryKey: z.string().min(1).optional(),
  parentKey: keySchema.optional(),
  key: keySchema,
  name: nameSchema.optional(),
  variant: z.record(z.string()).optional(),
  componentProperties: z.record(z.union([z.string(), z.boolean()])).optional(),
  position: z.object({ x: z.number(), y: z.number() }).strict().optional(),
  screenshot: z.boolean().optional(),
  screenshotScale: z.number().min(0.5).max(4).optional(),
  fileKey: z.string().min(1).optional(),
};

export const useComponentSchema = z
  .object(useComponentInputSchema)
  .strict()
  .superRefine((value, context) => {
    if (Number(Boolean(value.sourceKey)) + Number(Boolean(value.libraryKey)) !== 1) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Укажите ровно один источник: sourceKey или libraryKey",
      });
    }
  });
