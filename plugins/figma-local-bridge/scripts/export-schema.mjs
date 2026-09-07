import { readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { zodToJsonSchema } from "zod-to-json-schema";
import { screenSpecPublicSchema } from "../src/schemas.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
export function designSchemaText() {
  const schema = zodToJsonSchema(screenSpecPublicSchema, {
    name: "CodexFigmaDesignSpec",
    target: "jsonSchema7",
});
schema.$id = "https://local.invalid/codex-figma-design-spec.schema.json";
schema.title = "Codex Figma design spec";
schema.description = "Плоская типизированная спека экрана для render_screen. Семантические проверки parentKey, циклов и токенов выполняются MCP-сервером.";
return `${JSON.stringify(schema, null, 2)}\n`;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const path = join(root, "schemas", "design-spec.schema.json");
  const expected = designSchemaText();
  if (process.argv.includes("--check")) {
    if (await readFile(path, "utf8") !== expected) throw new Error("JSON Schema устарела. Выполните npm run schema:export и добавьте обновлённую схему в изменения.");
    console.log("JSON Schema соответствует исходникам.");
  } else await writeFile(path, expected, "utf8");
}
