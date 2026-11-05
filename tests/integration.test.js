import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import https from 'node:https';
import crypto from 'node:crypto';
import { io } from 'socket.io-client';

const origin = 'https://localhost:5173';
const ca = readFileSync(new URL('../node_modules/.vite/basic-ssl/_cert.pem', import.meta.url));
function event(socket, name) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => { socket.off(name, receive); reject(new Error(`Timed out: ${name}`)); }, 5000);
    function receive(payload) { clearTimeout(timeout); resolve(payload); }
    socket.once(name, receive);
  });
}
function get(path) {
  return new Promise((resolve, reject) => {
    https.get(origin + path, { ca }, (response) => {
      let body = '';
      response.on('data', (chunk) => { body += chunk; });
      response.on('end', () => resolve({ status: response.statusCode, body }));
    }).on('error', reject);
  });
}

test('HTTPS serves frontend and proxies network API', async () => {
  const page = await get('/');
  assert.equal(page.status, 200);
  assert.match(page.body, /src\/main.jsx/);
  const response = await get('/api/network-info');
  assert.equal(response.status, 200);
  const info = JSON.parse(response.body);
  assert.equal(info.httpsUrl, `https://${info.lanIp}:5173`);
});

test('WSS coordinates both clients, rejects unknown challenges, and hashes matching attestations', async () => {
  const broadcaster = io(origin, { transports: ['websocket'], ca, reconnection: false });
  const listener = io(origin, { transports: ['websocket'], ca, reconnection: false });
  try {
    await Promise.all([event(broadcaster, 'connect'), event(listener, 'connect')]);
    assert.equal(broadcaster.io.engine.transport.name, 'websocket');
    const failed = event(listener, 'verification-failed');
    listener.emit('verify-nonce', { nonce: 'NOPE00' });
    assert.match((await failed).reason, /No active room broadcast/);
    for (const protocolMode of ['AUDIBLE_FAST', 'ULTRASOUND_FAST']) {
      const created = event(broadcaster, 'session-created');
      broadcaster.emit('create-session', { protocolMode });
      const session = await created;
      assert.match(session.nonce, /^[A-HJ-NP-Z2-9]{6}$/);
      assert.equal(session.expiresAt - session.createdAt, 120000);
      const results = Promise.all([event(broadcaster, 'proximity-verified'), event(listener, 'proximity-verified')]);
      listener.emit('verify-nonce', { nonce: ` ${session.nonce.toLowerCase()} `, deviceLabel: 'Integration verifier' });
      const [a, b] = await results;
      assert.deepEqual(a, b);
      const proof = a.latestAttestation;
      assert.equal(proof.protocolMode, protocolMode);
      assert.equal(proof.nonce, session.nonce);
      assert.equal(proof.broadcasterId, broadcaster.id);
      assert.equal(proof.listenerId, listener.id);
      assert.equal(proof.status, 'VERIFIED_SAME_ROOM');
      const expected = '0x' + crypto.createHash('sha256').update(`${proof.nonce}:${broadcaster.id}:${listener.id}:${proof.verifiedAt}`).digest('hex');
      assert.equal(proof.attestationHash, expected);
    }
  } finally { broadcaster.disconnect(); listener.disconnect(); }
});
