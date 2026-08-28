import { writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { zodToJsonSchema } from "zod-to-json-schema";
import { screenSpecPublicSchema } from "../src/schemas.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const schema = zodToJsonSchema(screenSpecPublicSchema, {
  name: "CodexFigmaDesignSpec",
  target: "jsonSchema7",
});
schema.$id = "https://local.invalid/codex-figma-design-spec.schema.json";
schema.title = "Codex Figma design spec";
schema.description = "Плоская типизированная спека экрана для render_screen. Семантические проверки parentKey, циклов и токенов выполняются MCP-сервером.";
await writeFile(join(root, "schemas", "design-spec.schema.json"), `${JSON.stringify(schema, null, 2)}\n`, "utf8");
