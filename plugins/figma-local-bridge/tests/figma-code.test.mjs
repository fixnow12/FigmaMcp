import test from "node:test";
import assert from "node:assert/strict";
import {
  buildInspectCode,
  buildPatchCode,
  buildRenderCode,
  buildUseComponentCode,
} from "../src/figma-code.mjs";

test("render_screen компилирует стабильные ключи и экранирует закрывающие теги", () => {
  const code = buildRenderCode({
    spec: {
      key: "screen",
      name: "</script><script>alert(1)</script>",
      type: "screen",
      width: 320,
      height: 240,
      children: [],
    },
    replace: true,
  });
  assert.match(code, /codex-spec-key/);
  assert.match(code, /const spec =/);
  assert.equal(code.includes("</script>"), false);
});

test("render_screen компилирует изображения, SVG и component sets", () => {
  const code = buildRenderCode({
    spec: {
      key: "advanced",
      name: "Advanced",
      type: "screen",
      width: 320,
      height: 240,
      children: [
        {
          key: "set",
          name: "Button",
          type: "componentSet",
          children: [
            { key: "one", name: "One", type: "component", variant: { State: "One" }, children: [] },
            { key: "two", name: "Two", type: "component", variant: { State: "Two" }, children: [] },
          ],
        },
        { key: "image", name: "Image", type: "image", data: "AA==", mimeType: "image/png" },
        { key: "svg", name: "SVG", type: "svg", svg: "<svg/>" },
      ],
    },
    replace: true,
  });
  assert.match(code, /combineAsVariants/);
  assert.match(code, /createImage/);
  assert.match(code, /createNodeFromSvg/);
});

test("компиляторы остальных инструментов создают исполняемый код", () => {
  assert.match(buildPatchCode({ patches: [{ key: "title", set: { content: "Новый" } }], ignoreMissing: false }), /patched/);
  assert.match(buildPatchCode({ patches: [{ id: "1:2", set: { background: "#FF0000" } }], ignoreMissing: false }), /getNodeByIdAsync/);
  assert.match(buildInspectCode({ depth: 2, maxNodes: 50 }), /selection/);
  assert.match(buildInspectCode({ nodeId: "1:2", depth: 2, maxNodes: 50 }), /getNodeByIdAsync/);
  assert.match(buildUseComponentCode({ sourceKey: "button", key: "instance" }), /createInstance/);
  assert.match(buildUseComponentCode({ sourceKey: "button", key: "instance", variant: { State: "Pressed" } }), /COMPONENT_SET/);
});
