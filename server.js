import express from 'express';
import { createServer } from 'http';
import { Server } from 'socket.io';
import os from 'os';
import crypto from 'crypto';
import qrcode from 'qrcode-terminal';

const app = express();
const httpServer = createServer(app);
const io = new Server(httpServer, {
  cors: { origin: '*' },
});

function getLocalLanIp() {
  const nets = os.networkInterfaces();
  for (const name of Object.keys(nets)) {
    for (const net of nets[name]) {
      if (net.family === 'IPv4' && !net.internal) {
        return net.address;
      }
    }
  }
  return 'localhost';
}

const CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
function generateNonce(length = 6) {
  let result = '';
  for (let i = 0; i < length; i++) {
    result += CHARS.charAt(Math.floor(Math.random() * CHARS.length));
  }
  return result;
}

// Active sessions keyed by 6-char nonce
const sessions = new Map();

app.get('/api/network-info', (req, res) => {
  const lanIp = getLocalLanIp();
  res.json({
    lanIp,
    httpsUrl: `https://${lanIp}:5173`,
  });
});

io.on('connection', (socket) => {
  socket.on('create-session', ({ protocolMode } = {}) => {
    const nonce = generateNonce(6);
    const createdAt = Date.now();
    const sessionData = {
      nonce,
      broadcasterSocketId: socket.id,
      protocolMode: protocolMode || 'AUDIBLE_FAST',
      createdAt,
      expiresAt: createdAt + 120000, // 2 minutes TTL for testing
      verifiedDevices: [],
    };
    sessions.set(nonce, sessionData);
    socket.join(`session:${nonce}`);
    socket.emit('session-created', sessionData);
  });

  socket.on('verify-nonce', ({ nonce, deviceLabel }) => {
    const cleanNonce = (nonce || '').trim().toUpperCase();
    const session = sessions.get(cleanNonce);

    if (!session) {
      socket.emit('verification-failed', {
        receivedNonce: cleanNonce,
        reason: `No active room broadcast found matching code "${cleanNonce}".`,
      });
      return;
    }

    if (Date.now() > session.expiresAt) {
      sessions.delete(cleanNonce);
      socket.emit('verification-failed', {
        receivedNonce: cleanNonce,
        reason: 'Challenge code expired. Start a new broadcast.',
      });
      return;
    }

    const verifiedAt = Date.now();
    const latencyMs = verifiedAt - session.createdAt;
    const rawProofString = `${cleanNonce}:${session.broadcasterSocketId}:${socket.id}:${verifiedAt}`;
    const attestationHash =
      '0x' + crypto.createHash('sha256').update(rawProofString).digest('hex');

    const attestation = {
      status: 'VERIFIED_SAME_ROOM',
      nonce: cleanNonce,
      protocolMode: session.protocolMode,
      broadcasterId: session.broadcasterSocketId,
      listenerId: socket.id,
      deviceLabel: deviceLabel || 'Mobile Listener',
      verifiedAt,
      latencyMs,
      attestationHash,
    };

    session.verifiedDevices.push(attestation);
    socket.join(`session:${cleanNonce}`);

    // Notify both Broadcaster (Laptop) and Listener (Phone)
    io.to(`session:${cleanNonce}`).emit('proximity-verified', {
      session,
      latestAttestation: attestation,
    });
  });
});

const PORT = 3001;
httpServer.listen(PORT, () => {
  const lanIp = getLocalLanIp();
  const url = `https://${lanIp}:5173`;
  console.log('\n======================================================');
  console.log('🔊 ACOUSTIC PROXIMITY VERIFIER BACKEND READY');
  console.log(`🌐 Open on Laptop & Phone: ${url}`);
  console.log('   (Accept the self-signed HTTPS warning on both)');
  console.log('======================================================\n');
  qrcode.generate(url, { small: true });
});
