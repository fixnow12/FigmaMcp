/* Shared by Node and the generated Figma UI. No network or storage access. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('tweetnacl'));
  else root.FigmaSecureChannel = factory(root.nacl);
})(typeof globalThis !== 'undefined' ? globalThis : this, function (nacl) {
  'use strict';
  const protocol = 'figma-local-secure-v2';
  const encoder = new TextEncoder();
  const decoder = new TextDecoder('utf-8', { fatal: true });
  const encode = value => encoder.encode(JSON.stringify(value));
  const hex = bytes => Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('');
  function unhex(value, size) {
    if (typeof value !== 'string' || !/^(?:[0-9a-f]{2})+$/.test(value) || (size && value.length !== size * 2)) throw new Error('Invalid key or message');
    return Uint8Array.from(value.match(/../g), byte => parseInt(byte, 16));
  }
  function nonce(direction, sequence) {
    if (!Number.isSafeInteger(sequence) || sequence < 0) throw new Error('Invalid sequence');
    const bytes = new Uint8Array(24);
    bytes[0] = direction === 'server' ? 1 : 2;
    new DataView(bytes.buffer).setBigUint64(16, BigInt(sequence));
    return bytes;
  }
  function signature(identity, data) {
    return hex(nacl.sign.detached(encode(data), nacl.sign.keyPair.fromSeed(unhex(identity.seed, 32)).secretKey));
  }
  function verify(key, data, proof) {
    if (!nacl.sign.detached.verify(encode(data), unhex(proof, 64), unhex(key, 32))) throw new Error('Peer identity verification failed');
  }
  function publicKey(seed) { return hex(nacl.sign.keyPair.fromSeed(unhex(seed, 32)).publicKey); }
  function newSeed() { return hex(nacl.randomBytes(32)); }

  // Both ephemeral keys and fresh nonces are signed. Role and port are part of
  // the transcript. Application traffic uses a fresh X25519/XSalsa20-Poly1305
  // key, directional nonces and exact monotonic counters (WebSocket is ordered).
  function create({ side, identity, port, send, onReady = () => {}, onMessage = () => {}, onError = () => {} }) {
    const own = publicKey(identity.seed);
    let stage = 'initial', ephemeral, hello, transcript, key, peerRole;
    let sent = 0, received = 0;
    function fail(error) {
      if (stage === 'closed') return;
      stage = 'closed';
      if (key) key.fill(0);
      if (ephemeral) ephemeral.secretKey.fill(0);
      onError(error);
    }
    function derive(peerKey) {
      const raw = unhex(peerKey, 32);
      const shared = nacl.scalarMult(ephemeral.secretKey, raw);
      if (shared.every(byte => byte === 0)) throw new Error('Invalid ephemeral key');
      key = nacl.box.before(raw, ephemeral.secretKey);
      shared.fill(0);
      ephemeral.secretKey.fill(0);
    }
    function pack(value) {
      if (!key || (stage !== 'ready' && stage !== 'confirm')) throw new Error('Connection is not authenticated');
      return { type: 'SECURE', sequence: sent, box: hex(nacl.secretbox(encode(value), nonce(side, sent++), key)) };
    }
    function unpack(message) {
      if (message.type !== 'SECURE' || message.sequence !== received) throw new Error('Unexpected or replayed message');
      const plain = nacl.secretbox.open(unhex(message.box), nonce(side === 'server' ? 'client' : 'server', received), key);
      if (!plain) throw new Error('Message authentication failed');
      received++;
      return JSON.parse(decoder.decode(plain));
    }
    function receive(message) {
      if (stage === 'closed') return;
      try {
        if (stage === 'ready') { onMessage(unpack(message)); return; }
        if (side === 'client' && stage === 'initial') {
          if (message.type !== 'SECURE_HELLO') throw new Error('Secure bridge required');
          hello = message.data;
          if (!Array.isArray(hello) || hello.length !== 5 || hello[0] !== protocol || hello[1] !== port || hello[2] !== identity.serverKey) throw new Error('Unknown bridge');
          unhex(hello[3], 32); unhex(hello[4], 32);
          verify(identity.serverKey, ['server-hello', ...hello], message.proof);
          ephemeral = nacl.box.keyPair();
          peerRole = 'server';
          transcript = [...hello, identity.role, own, newSeed(), hex(ephemeral.publicKey)];
          derive(hello[4]);
          stage = 'response';
          send({ type: 'SECURE_RESPONSE', data: transcript, proof: signature(identity, ['client-response', ...transcript]) });
          return;
        }
        if (side === 'server' && stage === 'hello') {
          if (message.type !== 'SECURE_RESPONSE') throw new Error('Secure client required');
          transcript = message.data;
          if (!Array.isArray(transcript) || transcript.length !== 9 || JSON.stringify(transcript.slice(0, 5)) !== JSON.stringify(hello)) throw new Error('Invalid handshake');
          peerRole = transcript[5];
          if (!Object.hasOwn(identity.peers, peerRole) || identity.peers[peerRole] !== transcript[6]) throw new Error('Unknown client');
          unhex(transcript[7], 32); unhex(transcript[8], 32);
          verify(identity.peers[peerRole], ['client-response', ...transcript], message.proof);
          derive(transcript[8]);
          stage = 'confirm';
          send({ type: 'SECURE_OK', proof: signature(identity, ['server-confirm', ...transcript]) });
          return;
        }
        if (side === 'client' && stage === 'response') {
          if (message.type !== 'SECURE_OK') throw new Error('Invalid server confirmation');
          verify(identity.serverKey, ['server-confirm', ...transcript], message.proof);
          stage = 'confirm';
          send(pack({ type: 'CLIENT_READY' }));
          return;
        }
        if (stage === 'confirm') {
          const confirmed = unpack(message);
          if (confirmed.type !== (side === 'server' ? 'CLIENT_READY' : 'SERVER_READY')) throw new Error('Invalid key confirmation');
          if (side === 'server') send(pack({ type: 'SERVER_READY' }));
          stage = 'ready';
          onReady(peerRole);
          return;
        }
        throw new Error('Unexpected handshake message');
      } catch (error) { fail(error); }
    }
    return {
      start() {
        if (side !== 'server' || stage !== 'initial') return;
        try {
          ephemeral = nacl.box.keyPair();
          hello = [protocol, port, own, newSeed(), hex(ephemeral.publicKey)];
          stage = 'hello';
          send({ type: 'SECURE_HELLO', data: hello, proof: signature(identity, ['server-hello', ...hello]) });
        } catch (error) { fail(error); }
      },
      receive,
      send(value) { if (stage !== 'ready') throw new Error('Connection is not authenticated'); send(pack(value)); },
      close() { fail(new Error('Connection closed')); },
      get ready() { return stage === 'ready'; },
    };
  }
  return { protocol, create, publicKey, newSeed };
});
