import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { webcrypto } from 'node:crypto';
import { WebSocket } from 'ws';
import vm from 'node:vm';
import { prepareInstallation } from '../scripts/prepare-install.mjs';
import { startBroker } from '../src/broker.mjs';
import { BrokerClient } from '../src/broker-client.mjs';

test('полный установленный UI: auto auth → FILE_INFO → команда → Pause → Resume', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'figma-ui-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await prepareInstallation(directory);
  const broker = await startBroker({ directory, port: 0 });
  t.after(() => broker.stop());
  let html = await readFile(join(directory, 'figma-plugin/ui.html'), 'utf8');
  // Only the test listener port differs; execute every generated script verbatim.
  html = html.replace('var WS_PORT_RANGE_START = 9233;', `var WS_PORT_RANGE_START = ${broker.bridge.port};`).replace('var WS_PORT_RANGE_END = 9233;', `var WS_PORT_RANGE_END = ${broker.bridge.port};`);
  const timers = new Set(), sockets = [], commands = [], errors = [];
  const context = {
    TextEncoder, TextDecoder, Uint8Array, DataView, AbortSignal,
    crypto: { getRandomValues: array => webcrypto.getRandomValues(array) },
    console: { log() {}, warn() {}, error(...args) { errors.push(args); } },
    document: { getElementById: () => null, querySelector: () => null, body: { setAttribute() {} }, documentElement: { classList: { contains: () => false } } },
    addEventListener() {},
    setTimeout(fn, ms) { const timer = setTimeout(fn, ms); timers.add(timer); return timer; },
    clearTimeout, clearInterval,
    setInterval(fn, ms) { const timer = setInterval(fn, ms); timers.add(timer); return timer; },
    requestAnimationFrame(fn) { const timer = setTimeout(fn, 0); timers.add(timer); },
    fetch,
    WebSocket: class extends WebSocket { constructor(url) { super(url.replace('localhost', '127.0.0.1')); sockets.push(this); } },
    parent: { postMessage({ pluginMessage: message }) {
      if (message.type === 'RESIZE_UI') return;
      commands.push(message.type);
      const response = { requestId: message.requestId, type: `${message.type}_RESULT`, success: true };
      if (message.type === 'GET_FILE_INFO') response.fileInfo = { fileKey: 'ui-file', fileName: 'Runtime test', pluginVersion: '0.3.0' };
      else if (message.type === 'EXECUTE_CODE') { response.result = { marker: 'executed' }; response.fileContext = { fileKey: 'ui-file' }; }
      queueMicrotask(() => context.onmessage({ data: { pluginMessage: response } }));
    } },
  };
  context.window = context; context.self = context;
  vm.createContext(context);
  t.after(() => { context.__wsDisconnectAll?.(); for (const timer of timers) clearTimeout(timer); for (const socket of sockets) socket.terminate(); });
  for (const script of html.matchAll(/<script>([\s\S]*?)<\/script>/g)) vm.runInContext(script[1], context);
  async function waitFor(check) {
    for (let i = 0; i < 100; i++) { if (check()) return; await new Promise(resolve => setTimeout(resolve, 10)); }
    throw new Error(`UI timeout: ${JSON.stringify(errors)}`);
  }
  await waitFor(() => broker.bridge.status().connected);
  assert.equal(context.__wsGetAuthenticatedCount(), 1);
  const client = new BrokerClient({ directory, ports: [broker.bridge.port], autoStart: false }); t.after(() => client.stop());
  assert.deepEqual((await client.execute('return 1')).result, { marker: 'executed' });
  assert.equal(commands.filter(type => type === 'EXECUTE_CODE').length, 1);
  context.__wsDisconnectAll();
  await waitFor(() => !broker.bridge.status().connected);
  assert.equal(context.__wsIsPaused(), true);
  context.__wsManualScan();
  await waitFor(() => broker.bridge.status().connected);
  assert.equal(context.__wsGetAuthenticatedCount(), 1);
  assert.equal(errors.length, 0);
});
