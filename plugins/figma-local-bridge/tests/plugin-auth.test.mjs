import test from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
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

test("plugin UI не инициализирует локальный WebSocket до mutual auth", async () => {
  const source = await readFile(resolve(root, "figma-plugin", "ui.html"), "utf8");

  const initialOpenStart = source.indexOf("testWs.onopen = function()", source.indexOf("function wsScanAndConnect"));
  const initialOpenEnd = source.indexOf("testWs.onerror = function()", initialOpenStart);
  const initialOpen = source.slice(initialOpenStart, initialOpenEnd);
  assert.ok(initialOpenStart >= 0 && initialOpenEnd > initialOpenStart);
  assert.equal(initialOpen.includes("initializeConnection(testWs"), false);

  const authOkStart = source.indexOf("if (message.type === 'AUTH_OK'");
  const authOkEnd = source.indexOf("if (message.type === 'AUTH_ERROR'", authOkStart);
  const authOk = source.slice(authOkStart, authOkEnd);
  assert.match(authOk, /createLocalAuthProof\(verifiedToken, 'server'/);
  assert.ok(authOk.indexOf("conn.authenticated = true") > authOk.indexOf("message.data.proof !== expectedProof"));
  assert.ok(authOk.indexOf("initializeConnection(activeWs, port)") > authOk.indexOf("conn.authenticated = true"));

  const broadcastStart = source.indexOf("function broadcastToAll(message)");
  const broadcastEnd = source.indexOf("window.__wsForwardVariables", broadcastStart);
  assert.match(source.slice(broadcastStart, broadcastEnd), /isAuthenticatedConnection\(conn\)/);

  const unauthenticatedGate = source.indexOf("if (!isAuthenticatedConnection(conn))", authOkEnd);
  const updateNotice = source.indexOf("if (message.type === 'PLUGIN_UPDATE_AVAILABLE')", unauthenticatedGate);
  const handlerLookup = source.indexOf("var handler = methodMap[message.method]", unauthenticatedGate);
  assert.ok(updateNotice > unauthenticatedGate, "update notice must not be trusted before authentication");
  assert.ok(handlerLookup > unauthenticatedGate, "privileged method dispatch must remain behind authentication");
});

test("plugin UI вычисляет совместимый HMAC без crypto.subtle", async () => {
  const source = await readFile(resolve(root, "figma-plugin", "ui.html"), "utf8");
  const helperStart = source.indexOf("function asciiBytes(value)");
  const helperEnd = source.indexOf("function setLocalPairingStatus", helperStart);
  assert.ok(helperStart >= 0 && helperEnd > helperStart);

  const token = "5wSUlVhi7oQ04kW2olu5i8VqHXzOfjng";
  const role = "client";
  const port = 9223;
  const challenge = "abcdefghijklmnopqrstuvwxyzABCDEFG";
  const protocol = "figma-local-bridge-auth-v1";
  const context = {
    Uint8Array,
    Uint32Array,
    Promise,
    Math,
    window: {},
    btoa(value) {
      return Buffer.from(value, "binary").toString("base64");
    },
  };
  vm.runInNewContext(
    `var LOCAL_AUTH_PROTOCOL = ${JSON.stringify(protocol)};\n${source.slice(helperStart, helperEnd)}`,
    context,
  );

  const actual = await context.createLocalAuthProof(token, role, port, challenge);
  const expected = createHmac("sha256", token)
    .update(`${protocol}:${role}:${port}:${challenge}`)
    .digest("base64url");
  assert.equal(actual, expected);
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
  assert.equal(codexPlugin.version, packageJson.version);
  assert.equal(serverVersion, packageJson.version);
});
