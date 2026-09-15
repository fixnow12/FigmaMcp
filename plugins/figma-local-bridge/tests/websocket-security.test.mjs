import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { spawn } from 'node:child_process';
import { WebSocket, WebSocketServer } from 'ws';
import { FigmaBridge, createAuthProof, LOCAL_AUTH_PROTOCOL } from '../src/bridge.mjs';
import { connectSecure } from '../src/broker-client.mjs';
import channel from '../src/secure-channel.cjs';

const token = 'test_auth_token_0123456789ABCDEFGH';
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
function identities() {
  const server = channel.newSeed(), plugin = channel.newSeed();
  return {
    server: { seed: server, peers: { plugin: channel.publicKey(plugin) } },
    plugin: { seed: plugin, role: 'plugin', serverKey: channel.publicKey(server) },
  };
}
async function bridgeFixture(t, secure = true) {
  const keys = identities();
  const bridge = new FigmaBridge({ host: '127.0.0.1', port: 0, authToken: token, ...(secure ? { identity: keys.server } : {}) });
  await bridge.start();
  t.after(() => bridge.stop());
  return { bridge, keys };
}
async function peer(t, port) {
  const ws = new WebSocket(`ws://127.0.0.1:${port}`);
  ws.on('error', () => {});
  t.after(() => ws.terminate());
  await once(ws, 'open');
  return ws;
}
async function closesPromptly(ws) {
  const closed = new Promise(resolve => ws.once('close', () => resolve(true)));
  let timer;
  try {
    assert.equal(await Promise.race([closed, new Promise(resolve => { timer = setTimeout(() => resolve(false), 700); })]), true,
      'peer must be rejected before waiting for the rest of the payload or auth timeout');
  } finally { clearTimeout(timer); }
}

for (const secure of [true, false]) {
  for (const attack of ['declared-length', 'fragments', 'binary']) {
    test(`${secure ? 'secure' : 'legacy'} rejects ${attack} before authentication`, async t => {
      const { bridge } = await bridgeFixture(t, secure);
      const ws = await peer(t, bridge.port);
      const closed = closesPromptly(ws);
      if (attack === 'declared-length') {
        // A masked frame declaring 64 KiB, with no payload: reject at the header.
        const header = Buffer.alloc(14); header[0] = 0x81; header[1] = 0xff;
        header.writeBigUInt64BE(65536n, 2);
        ws._socket.write(header);
      } else if (attack === 'fragments') {
        ws.send('a'.repeat(3000), { fin: false });
        ws.send('b'.repeat(3000), { fin: false });
      } else ws.send(Buffer.alloc(8192), { fin: false });
      await closed;
      assert.equal(bridge.status().connected, false);
    });
  }
}

test('MCP rejects an oversized unfinished reply from a fake broker before auth', async t => {
  const server = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  await once(server, 'listening');
  t.after(() => { for (const ws of server.clients) ws.terminate(); return new Promise(resolve => server.close(resolve)); });
  server.on('connection', ws => ws.send('x'.repeat(8192), { fin: false }));
  const result = connectSecure(server.address().port, identities().plugin, { timeout: 2000 });
  await assert.rejects(result, error => error.code === 'WS_ERR_UNSUPPORTED_MESSAGE_LENGTH');
});

test('pending authentication slots are bounded and released on disconnect and success', async t => {
  const { bridge, keys } = await bridgeFixture(t);
  const pending = [];
  for (let i = 0; i < 32; i++) pending.push(await peer(t, bridge.port));
  const overflow = new WebSocket(`ws://127.0.0.1:${bridge.port}`);
  t.after(() => overflow.terminate());
  const outcome = new Promise(resolve => {
    overflow.once('unexpected-response', (_request, response) => { response.resume(); resolve(response.statusCode); });
    overflow.once('open', () => resolve(101));
    overflow.on('error', () => {});
  });
  assert.equal(await outcome, 503);
  pending.shift().terminate();
  await pause(30);
  const good = await connectSecure(bridge.port, keys.plugin);
  t.after(() => good.ws.terminate());
  // Authenticated peers no longer consume the admission budget.
  const next = await peer(t, bridge.port);
  const closed = closesPromptly(next);
  next.send('x'.repeat(8192), { fin: false });
  await closed;
  assert.equal(good.ws.readyState, WebSocket.OPEN);
});

test('silent legacy peer is terminated at the authentication deadline', async t => {
  const { bridge } = await bridgeFixture(t, false);
  const ws = await peer(t, bridge.port);
  let timer;
  try {
    const closed = new Promise(resolve => ws.once('close', () => resolve(true)));
    assert.equal(await Promise.race([closed, new Promise(resolve => { timer = setTimeout(() => resolve(false), 6000); })]), true);
  } finally { clearTimeout(timer); }
});

test('a valid signature does not lift the server budget before key confirmation', async t => {
  const { bridge, keys } = await bridgeFixture(t);
  const ws = new WebSocket(`ws://127.0.0.1:${bridge.port}`);
  t.after(() => ws.terminate());
  const secure = channel.create({ side: 'client', port: bridge.port, identity: keys.plugin,
    send: message => {
      if (message.type === 'SECURE') ws.send('x'.repeat(8192), { fin: false });
      else ws.send(JSON.stringify(message));
    },
  });
  ws.on('message', raw => secure.receive(JSON.parse(String(raw))));
  ws.on('error', () => {});
  await closesPromptly(ws);
  assert.equal(bridge.status().connected, false);
});

for (const confirmed of [false, true]) {
  test(`MCP ${confirmed ? 'accepts coalesced large data after' : 'rejects large data before'} server key confirmation`, async t => {
    const keys = identities();
    const server = new WebSocketServer({ host: '127.0.0.1', port: 0, perMessageDeflate: true });
    await once(server, 'listening');
    t.after(() => { for (const ws of server.clients) ws.terminate(); return new Promise(resolve => server.close(resolve)); });
    const payload = 'z'.repeat(16000);
    server.on('connection', ws => {
      // connectSecure must not negotiate a second, independent inflate budget.
      assert.equal(ws.extensions, '');
      const secure = channel.create({ side: 'server', port: server.address().port, identity: keys.server,
        send: message => {
          if (!confirmed && message.type === 'SECURE') ws.send(payload, { fin: false });
          else ws.send(JSON.stringify(message));
        },
        onReady: () => { if (confirmed) secure.send({ result: payload }); },
      });
      ws.on('message', raw => {
        ws._socket.cork();
        try { secure.receive(JSON.parse(String(raw))); } finally { ws._socket.uncork(); }
      });
      ws.on('error', () => {});
      secure.start();
    });
    const received = [];
    const connection = connectSecure(server.address().port, keys.plugin, { onMessage: message => received.push(message) });
    if (!confirmed) await assert.rejects(connection, { code: 'WS_ERR_UNSUPPORTED_MESSAGE_LENGTH' });
    else {
      const client = await connection;
      t.after(() => client.ws.terminate());
      for (let i = 0; i < 100 && !received.length; i++) await pause(10);
      assert.equal(received[0].result, payload);
    }
  });
}

test('authenticated encrypted and legacy traffic can still exceed the handshake budget', async t => {
  const { bridge, keys } = await bridgeFixture(t);
  const replies = [];
  const client = await connectSecure(bridge.port, keys.plugin, { onMessage: value => replies.push(value) });
  t.after(() => client.ws.terminate());
  const fileName = 'Ф'.repeat(12000);
  client.secure.send({ type: 'FILE_INFO', data: { fileKey: 'large-secure', fileName } });
  for (let i = 0; i < 100 && !bridge.status().connected; i++) await pause(10);
  assert.equal(bridge.status().file.fileName, fileName);
  bridge.wsServer.clients.get('large-secure').ws.send(JSON.stringify({ result: fileName }));
  for (let i = 0; i < 100 && !replies.length; i++) await pause(10);
  assert.equal(replies[0].result, fileName);

  const { bridge: legacy } = await bridgeFixture(t, false);
  const ws = new WebSocket(`ws://127.0.0.1:${legacy.port}`);
  t.after(() => ws.terminate());
  const registered = new Promise((resolve, reject) => {
    ws.on('error', reject);
    ws.on('message', raw => {
      const message = JSON.parse(String(raw));
      if (message.type === 'AUTH_CHALLENGE') {
        // AUTH_RESPONSE and the large application frame can share a TCP read.
        ws._socket.cork();
        ws.send(JSON.stringify({ type: 'AUTH_RESPONSE', data: { authProtocol: LOCAL_AUTH_PROTOCOL, proof: createAuthProof(token, 'client', legacy.port, message.data.challenge) } }));
        ws.send(JSON.stringify({ type: 'FILE_INFO', data: { fileKey: 'large-legacy', fileName } }));
        ws._socket.uncork();
      } else if (message.type === 'AUTH_OK') resolve();
    });
  });
  await registered;
  for (let i = 0; i < 100 && !legacy.status().connected; i++) await pause(10);
  assert.equal(legacy.status().file.fileName, fileName);
});

test('legacy malformed frame closes only its peer, not the MCP process', async () => {
  const code = `
    import { once } from 'node:events';
    import { WebSocket } from 'ws';
    import { FigmaBridge, createAuthProof, LOCAL_AUTH_PROTOCOL } from './src/bridge.mjs';
    const bridge = new FigmaBridge({host:'127.0.0.1',port:0,authToken:${JSON.stringify(token)}});
    await bridge.start();
    const good = new WebSocket('ws://127.0.0.1:' + bridge.port);
    await new Promise((resolve,reject) => {
      good.on('error',reject);
      good.on('message', raw => {
        const m=JSON.parse(String(raw));
        if(m.type==='AUTH_CHALLENGE') good.send(JSON.stringify({type:'AUTH_RESPONSE',data:{authProtocol:LOCAL_AUTH_PROTOCOL,proof:createAuthProof(${JSON.stringify(token)},'client',bridge.port,m.data.challenge)}}));
        if(m.type==='AUTH_OK') resolve();
      });
    });
    const bad = new WebSocket('ws://127.0.0.1:' + bridge.port);
    await once(bad,'open');
    const closed=once(bad,'close');
    bad._socket.write(Buffer.from([0x83,0x80,0,0,0,0]));
    await closed;
    if(good.readyState!==WebSocket.OPEN) throw new Error('Legitimate peer lost');
    good.send(JSON.stringify({type:'FILE_INFO',data:{fileKey:'survived',fileName:'OK'}}));
    for(let i=0;i<100&&!bridge.status().connected;i++) await new Promise(r=>setTimeout(r,10));
    if(bridge.status().file?.fileKey!=='survived') throw new Error('Bridge stopped processing');
    good.terminate(); await bridge.stop();
  `;
  const child = spawn(process.execPath, ['--input-type=module', '-e', code], { cwd: new URL('../', import.meta.url), stdio: ['ignore', 'pipe', 'pipe'], timeout: 5000 });
  let stderr = ''; child.stderr.on('data', data => { stderr += data; });
  const [exitCode, signal] = await once(child, 'close');
  assert.equal(signal, null, stderr);
  assert.equal(exitCode, 0, stderr);
});
