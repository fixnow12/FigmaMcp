export const HANDSHAKE_MAX_PAYLOAD = 4096;
export const SECURE_MAX_PAYLOAD = 250 * 1024 * 1024;
export const LEGACY_MAX_PAYLOAD = 100 * 1024 * 1024;
export const MAX_PENDING_AUTHENTICATIONS = 32;

export function allowAuthenticatedPayload(ws, maxPayload) {
  // ws 8.21.3 has no public per-connection setter. Its Receiver checks this
  // budget at the frame header, before buffering, and emits message synchronously.
  // Promote only inside onReady so the next frame in the same TCP read is safe.
  // Compression is disabled: its separate decompressor budget must not diverge.
  if (ws.readyState !== 1 || ws.extensions || ws._receiver?._maxPayload !== HANDSHAKE_MAX_PAYLOAD) {
    ws.terminate();
    throw new Error('Unsupported WebSocket authentication boundary');
  }
  ws._receiver._maxPayload = maxPayload;
}
