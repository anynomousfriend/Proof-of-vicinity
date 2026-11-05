import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { createSessionService } from '../backend/sessionService.js';
import { createHandler } from '../api/proximity.js';
import { createHostedCoordinator } from '../src/lib/hostedCoordinator.js';

function memoryStorage() {
  const records = new Map();
  return {
    async create(key, data) { if (records.has(key)) return false; records.set(key, { data: structuredClone(data), version: 1 }); return true; },
    async read(key) { return records.has(key) ? structuredClone(records.get(key)) : null; },
    async replace(key, data, version) {
      if (records.get(key)?.version !== version) return false;
      records.set(key, { data: structuredClone(data), version: version + 1 }); return true;
    },
  };
}
const listener = () => crypto.randomUUID();

test('different function instances share challenge and exactly matching attestation', async () => {
  const storage = memoryStorage();
  const first = createSessionService(storage), second = createSessionService(storage);
  const record = await first.create('ULTRASOUND_FAST');
  assert.match(record.session.nonce, /^[A-HJ-NP-Z2-9]{6}$/);
  const phone = listener();
  const proof = await second.verify(record.session.nonce.toLowerCase(), phone, 'Phone');
  assert.deepEqual(await first.status(record.session.nonce, record.accessToken), proof);
  assert.deepEqual(await second.verify(record.session.nonce, phone, 'Phone'), proof);
  assert.equal(proof.latestAttestation.protocolMode, 'ULTRASOUND_FAST');
  const p = proof.latestAttestation;
  assert.equal(p.proofHash, '0x' + crypto.createHash('sha256').update(`${p.nonce}:${p.broadcasterId}:${phone}:${p.verifiedAt}`).digest('hex'));
  assert.equal('accessToken' in proof, false);
});

test('simultaneous listeners cannot overwrite the winning proof', async () => {
  const service = createSessionService(memoryStorage());
  const record = await service.create('AUDIBLE_FAST');
  const results = await Promise.allSettled([service.verify(record.session.nonce, listener(), 'A'), service.verify(record.session.nonce, listener(), 'B')]);
  assert.equal(results.filter((r) => r.status === 'fulfilled').length, 1);
  assert.equal(results.find((r) => r.status === 'rejected').reason.status, 409);
});

test('expiry, cancellation, authentication, and malformed inputs are enforced', async () => {
  let clock = 1000;
  const service = createSessionService(memoryStorage(), () => clock);
  const record = await service.create('AUDIBLE_FAST');
  await assert.rejects(service.status(record.session.nonce, 'wrong'), { status: 403 });
  await assert.rejects(service.status(record.session.nonce, 'é'.repeat(64)), { status: 403 });
  await assert.rejects(service.create('INVALID'), { status: 400 });
  await assert.rejects(service.verify({}, listener(), ''), { status: 400 });
  await service.cancel(record.session.nonce, record.accessToken);
  await assert.rejects(service.verify(record.session.nonce, listener(), ''), { status: 410 });
  const expired = await service.create('AUDIBLE_FAST');
  clock += 120000;
  await assert.rejects(service.verify(expired.session.nonce, listener(), ''), { status: 410 });
});

async function request(handler, body, method = 'POST') {
  let status = 200, data, headers = {};
  const response = { setHeader(k, v) { headers[k] = v; }, status(value) { status = value; return this; }, json(value) { data = value; } };
  await handler({ method, body }, response);
  return { status, data, headers };
}

test('API validates methods, configuration, payloads, and reports storage failures safely', async () => {
  const handler = createHandler(createSessionService(memoryStorage()), () => true);
  assert.equal((await request(handler, {}, 'GET')).status, 405);
  assert.equal((await request(handler, '{')).status, 400);
  assert.equal((await request(handler, { action: 'create', protocolMode: 'INVALID' })).status, 400);
  assert.equal((await request(handler, { action: 'health' })).headers['Cache-Control'], 'no-store');
  assert.equal((await request(createHandler({}, () => false), { action: 'health' })).status, 503);
});

test('hosted clients create, decode, and receive identical results through the API', async () => {
  const handler = createHandler(createSessionService(memoryStorage()), () => true);
  const fetcher = async (_url, options) => {
    const response = await request(handler, JSON.parse(options.body));
    return { ok: response.status === 200, status: response.status, json: async () => response.data };
  };
  const laptop = createHostedCoordinator(fetcher), phone = createHostedCoordinator(fetcher);
  const next = (client, name) => new Promise((resolve) => client.on(name, resolve));
  try {
    await Promise.all([next(laptop, 'connect'), next(phone, 'connect')]);
    const created = next(laptop, 'session-created');
    laptop.emit('create-session', { protocolMode: 'AUDIBLE_FAST' });
    const session = await created;
    const results = Promise.all([next(laptop, 'proximity-verified'), next(phone, 'proximity-verified')]);
    phone.emit('verify-nonce', { nonce: session.nonce, deviceLabel: 'Phone' });
    const [a, b] = await results;
    assert.deepEqual(a, b);
  } finally { laptop.disconnect(); phone.disconnect(); }
});
