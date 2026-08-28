import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import {
  normalizeScreenSpec,
  screenSpecSchema,
  useComponentSchema,
} from "../src/schemas.mjs";

test("существующая smoke-спека проходит валидацию", async () => {
  const spec = JSON.parse(await readFile(new URL("../specs/smoke-test.json", import.meta.url), "utf8"));
  const parsed = screenSpecSchema.parse(spec);
  assert.equal(parsed.key, "codex-figma-smoke-test");
  assert.equal(parsed.nodes.length, 7);
});

test("повторяющиеся стабильные ключи запрещены", () => {
  const result = screenSpecSchema.safeParse({
    key: "screen",
    name: "Screen",
    type: "screen",
    width: 100,
    height: 100,
    nodes: [
      { key: "same", name: "One", type: "frame" },
      { key: "same", name: "Two", type: "frame" },
    ],
  });
  assert.equal(result.success, false);
});

test("неизвестный parentKey запрещён", () => {
  const result = screenSpecSchema.safeParse({
    key: "screen",
    name: "Screen",
    type: "screen",
    width: 100,
    height: 100,
    nodes: [
      { key: "title", parentKey: "missing", name: "Title", type: "text", content: "Text" },
    ],
  });
  assert.equal(result.success, false);
});

test("циклическая иерархия запрещена", () => {
  const result = screenSpecSchema.safeParse({
    key: "screen",
    name: "Screen",
    type: "screen",
    width: 100,
    height: 100,
    nodes: [
      { key: "one", parentKey: "two", name: "One", type: "frame" },
      { key: "two", parentKey: "one", name: "Two", type: "frame" },
    ],
  });
  assert.equal(result.success, false);
});

test("токены разрешаются, а component set, image и svg проходят нормализацию", () => {
  const normalized = normalizeScreenSpec({
    key: "advanced",
    name: "Advanced",
    type: "screen",
    width: 640,
    height: 480,
    background: { token: "colors.canvas" },
    tokens: {
      colors: { canvas: "#F8FAFC", primary: "#2563EB" },
      numbers: { radius: 12, gap: 8 },
    },
    nodes: [
      { key: "set", name: "Button", type: "componentSet" },
      { key: "default", parentKey: "set", name: "Default", type: "component", variant: { State: "Default" }, background: { token: "colors.primary" }, cornerRadius: { token: "numbers.radius" } },
      { key: "pressed", parentKey: "set", name: "Pressed", type: "component", variant: { State: "Pressed" } },
      { key: "image", name: "Image", type: "image", data: "AA==", mimeType: "image/png", width: 24, height: 24 },
      { key: "icon", name: "Icon", type: "svg", svg: "<svg xmlns=\"http://www.w3.org/2000/svg\"/>", width: 16, height: 16 },
    ],
  });
  assert.equal(normalized.background, "#F8FAFC");
  assert.equal(normalized.children[0].type, "componentSet");
  assert.equal(normalized.children[0].children[0].background, "#2563EB");
  assert.equal(normalized.children[0].children[0].cornerRadius, 12);
});

test("неизвестный токен отклоняется", () => {
  assert.throws(() => normalizeScreenSpec({
    key: "screen",
    name: "Screen",
    type: "screen",
    width: 100,
    height: 100,
    background: { token: "colors.missing" },
    nodes: [],
  }), /Не найден токен/);
});

test("use_component принимает ровно один источник", () => {
  assert.equal(
    useComponentSchema.safeParse({ sourceKey: "button", key: "button-instance" }).success,
    true,
  );
  assert.equal(
    useComponentSchema.safeParse({
      sourceKey: "button",
      libraryKey: "library",
      key: "button-instance",
    }).success,
    false,
  );
  assert.equal(useComponentSchema.safeParse({ key: "button-instance" }).success, false);
});
