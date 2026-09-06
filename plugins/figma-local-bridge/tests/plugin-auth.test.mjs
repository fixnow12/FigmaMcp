import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

test("inline-скрипт plugin UI синтаксически корректен", async () => {
  const source = await readFile(resolve(root, "figma-plugin", "ui.html"), "utf8");
  const inlineScript = source.match(/<script>([\s\S]*)<\/script>/)?.[1];
  assert.ok(inlineScript);
  assert.doesNotThrow(() => new vm.Script(inlineScript));
});

test("plugin UI не содержит ручного сопряжения и направляет команды через защищённый канал", async () => {
  const source = await readFile(resolve(root, "figma-plugin", "ui.html"), "utf8");
  assert.doesNotMatch(source, /local-pairing-code|__wsPairLocal|localPairingTokens/);
  assert.match(source, /LOCAL_SECURE_BOOTSTRAP/);
  assert.match(source, /window\.FigmaSecureChannel\.create/);
  assert.match(source, /activeWs\.send = function\(value\) \{ secure\.send/);
  assert.match(source, /secure\.receive\(JSON\.parse\(event\.data\)\)/);
  assert.match(source, /if \(!isAuthenticatedConnection\(conn\)\) return/);
});

test("Figma plugin разрешает только локальные сетевые адреса", async () => {
  const manifest = JSON.parse(await readFile(resolve(root, "figma-plugin", "manifest.json"), "utf8"));
  const domains = [
    ...(manifest.networkAccess?.allowedDomains || []),
    ...(manifest.networkAccess?.devAllowedDomains || []),
  ];

  assert.ok(domains.length > 0);
  for (const domain of domains) {
    assert.match(domain, /^(?:http|ws):\/\/localhost(?::\d+)?$/);
  }

  const ui = await readFile(resolve(root, "figma-plugin", "ui.html"), "utf8");
  const code = await readFile(resolve(root, "figma-plugin", "code.js"), "utf8");
  const runtime = `${ui}\n${code}`;
  assert.doesNotMatch(runtime, /southleft|CLOUD_RELAY|STORE_CLOUD_CONFIG|__wsAddCloudConnection/i);
  assert.doesNotMatch(runtime, /wss?:\/\/(?!localhost)/i);
});

test("версия Figma plugin совпадает с версиями пакета и Codex plugin", async () => {
  const packageJson = JSON.parse(await readFile(resolve(root, "package.json"), "utf8"));
  const codexPlugin = JSON.parse(await readFile(resolve(root, ".codex-plugin", "plugin.json"), "utf8"));
  const code = await readFile(resolve(root, "figma-plugin", "code.js"), "utf8");
  const server = await readFile(resolve(root, "src", "server.mjs"), "utf8");
  const pluginVersion = code.match(/var PLUGIN_VERSION = '([^']+)'/)?.[1];
  const serverVersion = server.match(/name: "codex-figma-compact", version: "([^"]+)"/)?.[1];

  assert.equal(pluginVersion, packageJson.version);
  assert.equal(codexPlugin.version.split("+")[0], packageJson.version);
  assert.match(codexPlugin.version, /^[^+]+(?:\+codex\.[a-z0-9-]+)?$/);
  assert.equal(serverVersion, packageJson.version);
});
