import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { webcrypto } from "node:crypto";
import { WebSocket } from "ws";
import { createAuthProof, FigmaBridge, LOCAL_AUTH_PROTOCOL } from "../src/bridge.mjs";

const AUTH_TOKEN = "test_auth_token_0123456789ABCDEFGH";

function connectPlugin(port, fileKey, fileName, authToken = AUTH_TOKEN) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}`);
    ws.once("error", reject);
    ws.on("message", (raw) => {
      const message = JSON.parse(Buffer.from(raw).toString("utf8"));
      if (message.type === "AUTH_CHALLENGE") {
        assert.equal(message.data.authProtocol, LOCAL_AUTH_PROTOCOL);
        ws.challenge = message.data.challenge;
        ws.send(JSON.stringify({
          type: "AUTH_RESPONSE",
          data: {
            authProtocol: LOCAL_AUTH_PROTOCOL,
            proof: createAuthProof(authToken, "client", port, ws.challenge),
          },
        }));
      } else if (message.type === "AUTH_OK") {
        assert.equal(message.data.proof, createAuthProof(authToken, "server", port, ws.challenge));
        ws.send(JSON.stringify({
          type: "FILE_INFO",
          data: { fileKey, fileName, currentPage: "Page 1", editorType: "figma" },
        }));
        resolve(ws);
      }
    });
  });
}

test("собственный bridge маршрутизирует команды по fileKey и точному socket", async () => {
  const bridge = new FigmaBridge({ host: "127.0.0.1", port: 0, authToken: AUTH_TOKEN });
  await bridge.start();
  const receivedBy = [];
  const first = await connectPlugin(bridge.port, "file-a", "A");
  const second = await connectPlugin(bridge.port, "file-b", "B");

  for (const [ws, fileKey] of [[first, "file-a"], [second, "file-b"]]) {
    ws.on("message", (raw) => {
      const message = JSON.parse(Buffer.from(raw).toString("utf8"));
      if (!message.id || message.method !== "EXECUTE_CODE") return;
      receivedBy.push(fileKey);
      if (fileKey === "file-a") {
        // A different authenticated file cannot forge this pending result.
        second.send(JSON.stringify({ id: message.id, result: { success: true, result: { fileKey: "forged" } } }));
      }
      setTimeout(() => {
        ws.send(JSON.stringify({
          id: message.id,
          result: {
            success: true,
            result: { fileKey },
            fileContext: { fileKey, fileName: fileKey.toUpperCase() },
          },
        }));
      }, 10);
    });
  }

  try {
    await new Promise((resolve) => setTimeout(resolve, 20));
    const result = await bridge.execute("return 1", { fileKey: "file-a", timeout: 1000 });
    assert.deepEqual(result.result, { fileKey: "file-a" });
    assert.deepEqual(receivedBy, ["file-a"]);
    assert.equal(bridge.status().files.length, 2);
    assert.equal(bridge.status().file.fileKey, "file-b");
  } finally {
    first.terminate();
    second.terminate();
    await bridge.stop();
  }
});

test("неаутентифицированный peer не может зарегистрировать FILE_INFO", async () => {
  const bridge = new FigmaBridge({ host: "127.0.0.1", port: 0, authToken: AUTH_TOKEN });
  await bridge.start();
  const ws = new WebSocket(`ws://127.0.0.1:${bridge.port}`);
  try {
    await new Promise((resolve, reject) => {
      ws.once("open", resolve);
      ws.once("error", reject);
    });
    ws.send(JSON.stringify({ type: "FILE_INFO", data: { fileKey: "forged", fileName: "Forged" } }));
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.equal(bridge.status().connected, false);
    assert.deepEqual(bridge.status().files, []);
  } finally {
    ws.terminate();
    await bridge.stop();
  }
});

test("неаутентифицированный duplicate fileKey не заменяет настоящий socket", async () => {
  const bridge = new FigmaBridge({ host: "127.0.0.1", port: 0, authToken: AUTH_TOKEN });
  await bridge.start();
  const legitimate = await connectPlugin(bridge.port, "file-a", "A");
  const rogue = new WebSocket(`ws://127.0.0.1:${bridge.port}`);
  legitimate.on("message", (raw) => {
    const message = JSON.parse(Buffer.from(raw).toString("utf8"));
    if (!message.id || message.method !== "EXECUTE_CODE") return;
    legitimate.send(JSON.stringify({
      id: message.id,
      result: { success: true, result: { owner: "legitimate" } },
    }));
  });
  try {
    await new Promise((resolve, reject) => {
      rogue.once("open", resolve);
      rogue.once("error", reject);
    });
    rogue.send(JSON.stringify({ type: "FILE_INFO", data: { fileKey: "file-a", fileName: "Forged" } }));
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.equal(legitimate.readyState, WebSocket.OPEN);
    assert.equal(bridge.status().files.length, 1);
    assert.equal(bridge.status().file.fileName, "A");
    const result = await bridge.execute("return 1", { fileKey: "file-a", timeout: 1000 });
    assert.deepEqual(result.result, { owner: "legitimate" });
  } finally {
    rogue.terminate();
    legitimate.terminate();
    await bridge.stop();
  }
});

test("неверное и replayed доказательство аутентификации отклоняются", async () => {
  const bridge = new FigmaBridge({ host: "127.0.0.1", port: 0, authToken: AUTH_TOKEN });
  await bridge.start();

  async function rejectedSocket(proofFactory) {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(`ws://127.0.0.1:${bridge.port}`);
      ws.once("error", reject);
      ws.on("message", (raw) => {
        const message = JSON.parse(Buffer.from(raw).toString("utf8"));
        if (message.type !== "AUTH_CHALLENGE") return;
        ws.send(JSON.stringify({
          type: "AUTH_RESPONSE",
          data: { authProtocol: LOCAL_AUTH_PROTOCOL, proof: proofFactory(message.data.challenge) },
        }));
      });
      ws.once("close", (code) => resolve(code));
    });
  }

  try {
    const incompatibleCode = await new Promise((resolve, reject) => {
      const ws = new WebSocket(`ws://127.0.0.1:${bridge.port}`);
      ws.once("error", reject);
      ws.on("message", (raw) => {
        const message = JSON.parse(Buffer.from(raw).toString("utf8"));
        if (message.type !== "AUTH_CHALLENGE") return;
        ws.send(JSON.stringify({
          type: "AUTH_RESPONSE",
          data: { authProtocol: "legacy-auth-v0", proof: "A".repeat(43) },
        }));
      });
      ws.once("close", (code) => resolve(code));
    });
    assert.equal(incompatibleCode, 4406);

    const wrongCode = await rejectedSocket((challenge) =>
      createAuthProof("wrong_auth_token_0123456789ABCDEFG", "client", bridge.port, challenge)
    );
    assert.equal(wrongCode, 4403);

    let oldChallenge;
    const first = new WebSocket(`ws://127.0.0.1:${bridge.port}`);
    await new Promise((resolve, reject) => {
      first.once("error", reject);
      first.on("message", (raw) => {
        const message = JSON.parse(Buffer.from(raw).toString("utf8"));
        if (message.type === "AUTH_CHALLENGE") {
          oldChallenge = message.data.challenge;
          resolve();
        }
      });
    });
    first.terminate();
    const replayProof = createAuthProof(AUTH_TOKEN, "client", bridge.port, oldChallenge);
    const replayCode = await rejectedSocket(() => replayProof);
    assert.equal(replayCode, 4403);
    assert.equal(bridge.status().connected, false);
  } finally {
    await bridge.stop();
  }
});

test("WebCrypto-клиент и Node-сервер вычисляют одинаковый HMAC proof", async () => {
  const challenge = "challenge_0123456789ABCDEFGHIJKLMNOP";
  const key = await webcrypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(AUTH_TOKEN),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const message = `${LOCAL_AUTH_PROTOCOL}:client:9223:${challenge}`;
  const signature = await webcrypto.subtle.sign("HMAC", key, new TextEncoder().encode(message));
  const browserProof = Buffer.from(signature).toString("base64url");
  assert.equal(browserProof, createAuthProof(AUTH_TOKEN, "client", 9223, challenge));
});

test("ошибка подключения выдаёт port-scoped pairing reference", async () => {
  const bridge = new FigmaBridge({ host: "127.0.0.1", port: 0, authToken: AUTH_TOKEN });
  await bridge.start();
  const ws = new WebSocket(`ws://127.0.0.1:${bridge.port}`);
  try {
    await new Promise((resolve, reject) => {
      ws.once("open", resolve);
      ws.once("error", reject);
    });
    await assert.rejects(
      bridge.waitForConnection(1000),
      new RegExp(`${bridge.port}:${AUTH_TOKEN}`),
    );
  } finally {
    ws.terminate();
    await bridge.stop();
  }
});

test("bridge переходит на следующий порт, если основной занят", async () => {
  const blocker = createServer();
  await new Promise((resolve) => blocker.listen(0, "127.0.0.1", resolve));
  const address = blocker.address();
  const occupiedPort = typeof address === "object" && address ? address.port : 0;
  const bridge = new FigmaBridge({ host: "127.0.0.1", port: occupiedPort, authToken: AUTH_TOKEN });
  try {
    await bridge.start();
    assert.notEqual(bridge.port, occupiedPort);
    assert.ok(bridge.port > occupiedPort);
  } finally {
    await bridge.stop();
    await new Promise((resolve) => blocker.close(resolve));
  }
});

function queueBridge() {
  const bridge = new FigmaBridge({ authToken: AUTH_TOKEN });
  const files = [
    { fileKey: "a", currentPageId: "page-a", isActive: true },
    { fileKey: "b", currentPageId: "page-b", isActive: false },
  ];
  bridge.waitForConnection = async () => {};
  bridge.wsServer = {
    getConnectedFiles: () => files.map((file) => ({ ...file })),
    clients: new Map(files.map((file) => [file.fileKey, { ws: {} }])),
  };
  return { bridge, files };
}

test("очередь сохраняет файл и страницу до завершения операции", async () => {
  const { bridge, files } = queueBridge();
  let release;
  let started;
  const begun = new Promise((resolve) => { started = resolve; });
  const wait = new Promise((resolve) => { release = resolve; });
  const events = [];
  const first = bridge.runInFile("a", async (target) => { events.push("first"); started(); await wait; return target; });
  await begun;
  const second = bridge.runInFile("a", async (target) => { events.push("second"); return target; });
  await Promise.resolve();
  files[0].isActive = false;
  files[1].isActive = true;
  assert.deepEqual(events, ["first"]);
  release();
  const expected = { fileKey: "a", pageId: "page-a", expectedSocket: bridge.wsServer.clients.get("a").ws };
  assert.deepEqual(await first, expected);
  assert.deepEqual(await second, expected);
  assert.deepEqual(events, ["first", "second"]);
  assert.equal(bridge.fileQueues.size, 0);
});

test("при нескольких файлах запись требует явного fileKey, чтение остаётся доступно", async () => {
  const { bridge } = queueBridge();
  await assert.rejects(bridge.runInFile(undefined, () => assert.fail("Запись не должна запускаться"), { requireExplicitFile: true }), /Укажите fileKey/);
  assert.equal(await bridge.runInFile(undefined, (target) => target.fileKey), "a");
});

test("ошибка одной команды не блокирует следующую в очереди", async () => {
  const { bridge } = queueBridge();
  await assert.rejects(bridge.runInFile("a", () => { throw new Error("Ошибка"); }), /Ошибка/);
  assert.equal(await bridge.runInFile("a", () => "ok"), "ok");
});

test("замена socket во время ожидания не перенаправляет команду новому подключению", async () => {
  const { bridge } = queueBridge();
  let release;
  const wait = new Promise((resolve) => { release = resolve; });
  const first = bridge.runInFile("a", () => wait);
  await Promise.resolve();
  await Promise.resolve();
  const second = bridge.runInFile("a", () => assert.fail("Новый socket не должен получить команду"));
  await Promise.resolve();
  bridge.wsServer.clients.set("a", { ws: {} });
  const rejected = assert.rejects(second, /Подключение файла изменилось/);
  release();
  await first;
  await rejected;
});
