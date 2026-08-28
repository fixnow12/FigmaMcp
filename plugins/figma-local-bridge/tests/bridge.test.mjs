import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { WebSocket } from "ws";
import { FigmaBridge } from "../src/bridge.mjs";

function connectPlugin(port, fileKey, fileName) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}`);
    ws.once("error", reject);
    ws.once("open", () => {
      ws.send(JSON.stringify({
        type: "FILE_INFO",
        data: { fileKey, fileName, currentPage: "Page 1", editorType: "figma" },
      }));
      resolve(ws);
    });
  });
}

test("собственный bridge маршрутизирует команды по fileKey", async () => {
  const bridge = new FigmaBridge({ host: "127.0.0.1", port: 0 });
  await bridge.start();
  const receivedBy = [];
  const first = await connectPlugin(bridge.port, "file-a", "A");
  const second = await connectPlugin(bridge.port, "file-b", "B");

  for (const [ws, fileKey] of [[first, "file-a"], [second, "file-b"]]) {
    ws.on("message", (raw) => {
      const message = JSON.parse(Buffer.from(raw).toString("utf8"));
      if (!message.id || message.method !== "EXECUTE_CODE") return;
      receivedBy.push(fileKey);
      ws.send(JSON.stringify({
        id: message.id,
        result: {
          success: true,
          result: { fileKey },
          fileContext: { fileKey, fileName: fileKey.toUpperCase() },
        },
      }));
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

test("bridge переходит на следующий порт, если основной занят", async () => {
  const blocker = createServer();
  await new Promise((resolve) => blocker.listen(0, "127.0.0.1", resolve));
  const address = blocker.address();
  const occupiedPort = typeof address === "object" && address ? address.port : 0;
  const bridge = new FigmaBridge({ host: "127.0.0.1", port: occupiedPort });
  try {
    await bridge.start();
    assert.notEqual(bridge.port, occupiedPort);
    assert.ok(bridge.port > occupiedPort);
  } finally {
    await bridge.stop();
    await new Promise((resolve) => blocker.close(resolve));
  }
});
