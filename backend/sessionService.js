import crypto from 'node:crypto';

export class SessionError extends Error {
  constructor(message, status = 400) { super(message); this.status = status; }
}
const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const validNonce = (nonce) => typeof nonce === 'string' && /^[A-Z0-9]{6}$/.test(nonce);
export function createSessionService(storage, now = Date.now) {
  const clean = (value) => typeof value === 'string' ? value.trim().toUpperCase() : '';
  async function read(nonce) {
    if (!validNonce(nonce)) throw new SessionError('Invalid six-character challenge.');
    const record = await storage.read(nonce);
    if (!record || record.data.session.expiresAt <= now()) throw new SessionError('Challenge expired or unavailable. Start a new broadcast.', 410);
    return record;
  }
  function authorize(record, token) {
    const expected = record.data.accessToken;
    if (typeof token !== 'string' || !/^[a-f0-9]{64}$/.test(token) || !crypto.timingSafeEqual(Buffer.from(token), Buffer.from(expected))) {
      throw new SessionError('Not authorized to manage this broadcast.', 403);
    }
  }
  function payload(record) {
    return { session: record.session, latestAttestation: record.latestAttestation || null };
  }
  return {
    async create(protocolMode) {
      if (!['AUDIBLE_FAST', 'ULTRASOUND_FAST'].includes(protocolMode)) throw new SessionError('Unsupported acoustic protocol.');
      for (let attempt = 0; attempt < 8; attempt++) {
        const nonce = Array.from({ length: 6 }, () => alphabet[crypto.randomInt(alphabet.length)]).join('');
        const createdAt = now();
        const data = {
          accessToken: crypto.randomBytes(32).toString('hex'),
          session: { nonce, broadcasterSocketId: crypto.randomUUID(), protocolMode, createdAt, expiresAt: createdAt + 120000, verifiedDevices: [] },
        };
        if (await storage.create(nonce, data)) return { session: data.session, accessToken: data.accessToken };
      }
      throw new SessionError('Could not allocate a challenge. Try again.', 503);
    },
    async status(nonce, token) {
      const record = await read(clean(nonce));
      authorize(record, token);
      return payload(record.data);
    },
    async cancel(nonce, token) {
      nonce = clean(nonce);
      const record = await read(nonce);
      authorize(record, token);
      const data = { ...record.data, session: { ...record.data.session, expiresAt: 0 } };
      if (!await storage.replace(nonce, data, record.version)) throw new SessionError('Session changed. Retry cancellation.', 409);
      return { cancelled: true };
    },
    async verify(nonce, listenerId, deviceLabel) {
      nonce = clean(nonce);
      if (typeof listenerId !== 'string' || !/^[a-f0-9-]{36}$/i.test(listenerId)) throw new SessionError('Invalid listener identity.');
      for (let attempt = 0; attempt < 4; attempt++) {
        const record = await read(nonce);
        const data = record.data;
        if (data.latestAttestation) {
          if (data.latestAttestation.listenerId === listenerId) return payload(data);
          throw new SessionError('This challenge has already been verified. Start a new broadcast.', 409);
        }
        const verifiedAt = now();
        const broadcasterId = data.session.broadcasterSocketId;
        const attestationHash = '0x' + crypto.createHash('sha256').update(`${nonce}:${broadcasterId}:${listenerId}:${verifiedAt}`).digest('hex');
        const attestation = {
          status: 'VERIFIED_SAME_ROOM', nonce, protocolMode: data.session.protocolMode,
          broadcasterId, listenerId, deviceLabel: typeof deviceLabel === 'string' ? deviceLabel.trim().slice(0, 80) || 'Mobile Listener' : 'Mobile Listener',
          verifiedAt, latencyMs: verifiedAt - data.session.createdAt, attestationHash, proofHash: attestationHash,
        };
        const updated = { ...data, session: { ...data.session, verifiedDevices: [attestation] }, latestAttestation: attestation };
        if (await storage.replace(nonce, updated, record.version)) return payload(updated);
      }
      throw new SessionError('Challenge changed during verification. Try again.', 409);
    },
  };
}
