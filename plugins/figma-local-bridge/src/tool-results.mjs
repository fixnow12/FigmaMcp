export function toolSuccess(payload, image) {
  return {
    content: [
      { type: "text", text: JSON.stringify(payload) },
      ...(image ? [{ type: "image", data: image.base64, mimeType: "image/png" }] : []),
    ],
    structuredContent: payload,
  };
}

export function toolFailure(error) {
  const payload = {
    error: error instanceof Error ? error.message : String(error),
    ...(error.operationStatus ? { operationStatus: error.operationStatus } : {}),
    ...(error.rollbackErrors ? { rollbackErrors: error.rollbackErrors } : {}),
  };
  return { isError: true, content: [{ type: "text", text: JSON.stringify(payload) }], structuredContent: payload };
}

// The write and its optional preview share the same pinned connection target and queue.
export async function runToolOperation(bridge, input, code, {
  mutating = true, timeout, screenshotRequested = false, screenshotNode, extendPayload, operationName,
} = {}) {
  try {
    return await bridge.runInFile(input.fileKey, async (target) => {
      const payload = await bridge.execute(code, { ...target, timeout, operation: { name: operationName, mutating } });
      payload.operationStatus = mutating ? "applied" : "read";
      if (extendPayload) extendPayload(payload);
      if (!screenshotRequested) return toolSuccess(payload);
      try {
        const nodeId = screenshotNode(payload);
        if (!nodeId) throw new Error("Узел для снимка не найден");
        const image = await bridge.captureScreenshot(nodeId, { ...target, scale: input.screenshotScale ?? 1 });
        const { base64: _base64, ...metadata } = image;
        payload.screenshot = { status: "captured", ...metadata };
        return toolSuccess(payload, image);
      } catch (error) {
        payload.screenshot = { status: "failed", error: error.message };
        payload.warnings = [mutating
          ? "Изменения выполнены, но снимок не получен. Не повторяйте запись: запросите снимок отдельно."
          : "Чтение выполнено, но снимок не получен."];
        return toolSuccess(payload);
      }
    }, { requireExplicitFile: mutating });
  } catch (error) {
    return toolFailure(error);
  }
}
