# MASTER EXECUTION PROMPT: Acoustic Proof-of-Proximity MVP

You are an autonomous engineering agent. Your task is to build, verify, and launch a complete, working **Acoustic Proximity Verification (Proof-of-Vicinity) MVP** from scratch in the current directory.

Execute the steps below **strictly one by one in sequential order**. Do not skip steps, do not use placeholders or `TODO` comments, and verify each step before moving to the next. When all steps are complete, output the final completion report.

---

## ARCHITECTURAL CONSTRAINTS (CRITICAL — DO NOT VIOLATE)

1. **100% Local HTTPS + WSS Proxy:** Mobile browsers block `navigator.mediaDevices.getUserMedia` over plain `http://` LAN IPs and block `ws://` connections from `https://` pages (Mixed Content). You MUST use `@vitejs/plugin-basic-ssl` on port `5173` with `host: true`, and proxy `/socket.io` and `/api` through Vite to the Express server on port `3001`.
2. **Disable Browser Audio Filters:** When calling `getUserMedia`, you MUST set `echoCancellation: false`, `autoGainControl: false`, and `noiseSuppression: false`. Otherwise, the phone browser will filter out the laptop's FSK acoustic signal as background noise.
3. **`ggwave` WebAssembly Memory Conversion:**
   - `ggwave.encode()` returns an `Int8Array` view of raw bytes representing 32-bit float samples. Convert it to `Float32Array` using the `convertTypedArray` helper before passing it to `AudioBuffer.getChannelData(0)`.
   - `ggwave.decode()` expects an `Int8Array` view of the raw `Float32Array` microphone PCM buffer.
4. **CommonJS / ESM Compatibility for `ggwave` in Vite:** Import `ggwave` safely so it resolves across both dev and build:
   ```js
   import ggwaveModule from 'ggwave';
   const ggwaveFactory = ggwaveModule.default || ggwaveModule;
   ```
5. **Short Payloads Only:** Only transmit a 6-character uppercase alphanumeric challenge code (e.g., `K9X2M4`) over sound so transmission takes ~1.2 seconds and Reed-Solomon error correction succeeds across a room.

---

## STEP-BY-STEP EXECUTION PLAN

### STEP 1: Initialize Project & Install Dependencies
Run the commands to initialize `package.json` and install all required packages:

```bash
npm init -y
npm pkg set type="module"
npm install react react-dom ggwave express socket.io socket.io-client lucide-react qrcode.react
npm install -D vite @vitejs/plugin-react @vitejs/plugin-basic-ssl tailwindcss @tailwindcss/vite concurrently qrcode-terminal
```

Update `package.json` scripts so `npm run dev` runs both the backend and Vite HTTPS server:
```json
"scripts": {
  "server": "node server.js",
  "client": "vite --host",
  "dev": "concurrently -n \"SERVER,VITE\" -c \"cyan,magenta\" \"npm run server\" \"npm run client\"",
  "build": "vite build"
}
```
**Checkpoint 1:** Confirm `node_modules` exists and `package.json` has `"type": "module"` and all dependencies installed.

---

### STEP 2: Configure Vite with Basic SSL & WebSocket Proxy
Create `vite.config.js` in the project root:

```javascript
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import basicSsl from '@vitejs/plugin-basic-ssl';
import tailwindcss from '@tailwindcss/vite';

export default defineConfig({
  plugins: [react(), basicSsl(), tailwindcss()],
  server: {
    host: true,
    port: 5173,
    proxy: {
      '/socket.io': {
        target: 'http://localhost:3001',
        ws: true,
        changeOrigin: true,
      },
      '/api': {
        target: 'http://localhost:3001',
        changeOrigin: true,
      },
    },
  },
});
```
**Checkpoint 2:** Verify `vite.config.js` is saved properly.

---

### STEP 3: Create the Backend Coordinator & LAN IP Resolver (`server.js`)
Create `server.js` in the project root. It must:
1. Detect the machine's active LAN IPv4 address using Node's `os.networkInterfaces()` and print a scannable terminal QR code (`qrcode-terminal`) pointing to `https://<LAN_IP>:5173` on startup.
2. Expose `GET /api/network-info` returning `{ lanIp, httpsUrl: "https://<LAN_IP>:5173" }` so the laptop UI can render a scannable QR code on screen for the phone.
3. Run a Socket.IO server managing ephemeral 6-character acoustic challenge sessions and generating an on-chain ready attestation payload (`proofHash`, `nonce`, `broadcasterId`, `listenerId`, `verifiedAt`) when the phone decodes the sound.

Write `server.js` with this exact implementation:

```javascript
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
```
**Checkpoint 3:** Confirm `server.js` has no syntax errors using `node --check server.js`.

---

### STEP 4: Create the `ggwave` Web Audio Modem Wrapper (`src/lib/acousticModem.js`)
Create `src/lib/acousticModem.js` to handle `AudioContext`, `ggwave` encoding, and microphone decoding:

```javascript
import ggwaveModule from 'ggwave';

const ggwaveFactory = ggwaveModule.default || ggwaveModule;

let audioContext = null;
let ggwave = null;
let instance = null;
let mediaStream = null;
let scriptNode = null;
let sourceNode = null;
let activePlaybackSource = null;

function convertTypedArray(src, type) {
  const buffer = new ArrayBuffer(src.byteLength);
  new src.constructor(buffer).set(src);
  return new type(buffer);
}

export async function initModem() {
  if (!audioContext) {
    const AudioCtx = window.AudioContext || window.webkitAudioContext;
    audioContext = new AudioCtx({ sampleRate: 48000 });
  }
  if (audioContext.state === 'suspended') {
    await audioContext.resume();
  }
  if (!ggwave) {
    ggwave = await ggwaveFactory();
    const parameters = ggwave.getDefaultParameters();
    parameters.sampleRateInp = audioContext.sampleRate;
    parameters.sampleRateOut = audioContext.sampleRate;
    instance = ggwave.init(parameters);
  }
  return { audioContext, ggwave, instance };
}

export async function playChallengeTone(nonce, useUltrasound = false) {
  await initModem();

  const ProtocolEnum = ggwave.ProtocolId || ggwave.TxProtocolId || {};
  const protocolId = useUltrasound
    ? (ProtocolEnum.GGWAVE_PROTOCOL_ULTRASOUND_FAST ??
       ProtocolEnum.GGWAVE_TX_PROTOCOL_ULTRASOUND_FAST ??
       4)
    : (ProtocolEnum.GGWAVE_PROTOCOL_AUDIBLE_FAST ??
       ProtocolEnum.GGWAVE_TX_PROTOCOL_AUDIBLE_FAST ??
       1);

  const waveform = ggwave.encode(instance, nonce, protocolId, 25);
  const floatSamples = convertTypedArray(waveform, Float32Array);

  const buffer = audioContext.createBuffer(
    1,
    floatSamples.length,
    audioContext.sampleRate
  );
  buffer.getChannelData(0).set(floatSamples);

  return new Promise((resolve) => {
    const source = audioContext.createBufferSource();
    activePlaybackSource = source;
    source.buffer = buffer;
    source.connect(audioContext.destination);
    source.onended = () => {
      if (activePlaybackSource === source) activePlaybackSource = null;
      resolve();
    };
    source.start(0);
  });
}

export function stopChallengeTone() {
  if (activePlaybackSource) {
    try {
      activePlaybackSource.stop();
    } catch (_) {}
    activePlaybackSource = null;
  }
}

export async function startAcousticListener(onDecoded, onAudioLevel) {
  await initModem();
  stopAcousticListener();

  mediaStream = await navigator.mediaDevices.getUserMedia({
    audio: {
      echoCancellation: false,
      autoGainControl: false,
      noiseSuppression: false,
    },
  });

  sourceNode = audioContext.createMediaStreamSource(mediaStream);
  scriptNode = audioContext.createScriptProcessor(1024, 1, 1);

  scriptNode.onaudioprocess = (event) => {
    const channelData = event.inputBuffer.getChannelData(0);

    // Compute RMS for real-time mic visual feedback
    if (onAudioLevel) {
      let sum = 0;
      for (let i = 0; i < channelData.length; i++) {
        sum += channelData[i] * channelData[i];
      }
      const rms = Math.sqrt(sum / channelData.length);
      onAudioLevel(Math.min(100, Math.round(rms * 400)));
    }

    const rawBytes = convertTypedArray(new Float32Array(channelData), Int8Array);
    const res = ggwave.decode(instance, rawBytes);

    if (res && res.length > 0) {
      const decodedText = new TextDecoder('utf-8').decode(res).trim();
      if (decodedText && onDecoded) {
        onDecoded(decodedText);
      }
    }
  };

  sourceNode.connect(scriptNode);
  scriptNode.connect(audioContext.destination);
}

export function stopAcousticListener() {
  if (scriptNode) {
    try {
      scriptNode.disconnect();
    } catch (_) {}
    scriptNode.onaudioprocess = null;
    scriptNode = null;
  }
  if (sourceNode) {
    try {
      sourceNode.disconnect();
    } catch (_) {}
    sourceNode = null;
  }
  if (mediaStream) {
    mediaStream.getTracks().forEach((track) => track.stop());
    mediaStream = null;
  }
}
```
**Checkpoint 4:** Verify `src/lib/acousticModem.js` exists.

---

### STEP 5: Create Frontend Entry Points & UI (`index.html`, `src/index.css`, `src/main.jsx`, `src/App.jsx`)

1. Create `index.html`:
```html
<!DOCTYPE html>
<html lang="en" class="dark">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>Acoustic Proof-of-Proximity MVP</title>
  </head>
  <body class="bg-slate-950 text-slate-100 antialiased selection:bg-emerald-500 selection:text-slate-950">
    <div id="root"></div>
    <script type="module" src="/src/main.jsx"></script>
  </body>
</html>
```

2. Create `src/index.css`:
```css
@import "tailwindcss";
```

3. Create `src/main.jsx`:
```javascript
import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App.jsx';
import './index.css';

ReactDOM.createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <App/>
  </React.StrictMode>
);
```

4. Create `src/App.jsx` with the complete Broadcaster + Listener + QR Code + On-Chain Attestation UI:
```javascript
import React, { useState, useEffect, useRef } from 'react';
import { io } from 'socket.io-client';
import { QRCodeSVG } from 'qrcode.react';
import {
  Volume2,
  Mic,
  ShieldCheck,
  Radio,
  Wifi,
  WifiOff,
  Copy,
  Check,
  RefreshCw,
  Eye,
  EyeOff,
  Smartphone,
  Laptop,
  AlertCircle,
} from 'lucide-react';
import {
  playChallengeTone,
  stopChallengeTone,
  startAcousticListener,
  stopAcousticListener,
} from './lib/acousticModem.js';

export default function App() {
  const [socket, setSocket] = useState(null);
  const [connected, setConnected] = useState(false);
  const [networkInfo, setNetworkInfo] = useState({ lanIp: '', httpsUrl: '' });

  // Role: 'broadcaster' (Laptop) or 'listener' (Phone)
  const [role, setRole] = useState(() =>
    /iPhone|iPad|iPod|Android/i.test(navigator.userAgent) ? 'listener' : 'broadcaster'
  );

  // Broadcaster state
  const [useUltrasound, setUseUltrasound] = useState(false);
  const [isBroadcasting, setIsBroadcasting] = useState(false);
  const [activeSession, setActiveSession] = useState(null);
  const [hideNonce, setHideNonce] = useState(false);
  const broadcastLoopRef = useRef(false);

  // Listener state
  const [isListening, setIsListening] = useState(false);
  const [micLevel, setMicLevel] = useState(0);
  const [deviceLabel, setDeviceLabel] = useState(() =>
    /iPhone|iPad|iPod|Android/i.test(navigator.userAgent)
      ? 'Mobile Verifier'
      : 'Desktop Verifier'
  );
  const [lastDecodedRaw, setLastDecodedRaw] = useState('');
  const [errorMsg, setErrorMsg] = useState('');

  // Shared Verification Result
  const [verifiedData, setVerifiedData] = useState(null);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    fetch('/api/network-info')
      .then((r) => r.json())
      .then((data) => setNetworkInfo(data))
      .catch(() => {});

    const s = io();
    setSocket(s);

    s.on('connect', () => setConnected(true));
    s.on('disconnect', () => setConnected(false));

    s.on('session-created', (sessionData) => {
      setActiveSession(sessionData);
      setVerifiedData(null);
      setErrorMsg('');
      startBroadcastLoop(sessionData.nonce);
    });

    s.on('proximity-verified', (payload) => {
      broadcastLoopRef.current = false;
      setIsBroadcasting(false);
      stopChallengeTone();
      stopAcousticListener();
      setIsListening(false);
      setVerifiedData(payload);
      setErrorMsg('');
    });

    s.on('verification-failed', ({ reason }) => {
      setErrorMsg(reason);
    });

    return () => {
      broadcastLoopRef.current = false;
      stopChallengeTone();
      stopAcousticListener();
      s.disconnect();
    };
  }, []);

  const startBroadcastLoop = async (nonce) => {
    broadcastLoopRef.current = true;
    setIsBroadcasting(true);
    while (broadcastLoopRef.current) {
      try {
        await playChallengeTone(nonce, useUltrasound);
      } catch (err) {
        setErrorMsg('Audio playback error: ' + err.message);
        break;
      }
      await new Promise((r) => setTimeout(r, 1800));
    }
  };

  const handleStartBroadcast = () => {
    if (!socket) return;
    setErrorMsg('');
    setVerifiedData(null);
    socket.emit('create-session', {
      protocolMode: useUltrasound ? 'ULTRASOUND_FAST' : 'AUDIBLE_FAST',
    });
  };

  const handleStopBroadcast = () => {
    broadcastLoopRef.current = false;
    setIsBroadcasting(false);
    stopChallengeTone();
  };

  const handleStartListening = async () => {
    setErrorMsg('');
    setVerifiedData(null);
    setLastDecodedRaw('');
    try {
      await startAcousticListener(
        (decodedToken) => {
          setLastDecodedRaw(decodedToken);
          if (socket && decodedToken.length >= 4) {
            socket.emit('verify-nonce', {
              nonce: decodedToken,
              deviceLabel,
            });
          }
        },
        (level) => setMicLevel(level)
      );
      setIsListening(true);
    } catch (err) {
      setErrorMsg(
        'Microphone permission denied or blocked. Ensure you opened the https:// URL and accepted the certificate warning.'
      );
    }
  };

  const handleStopListening = () => {
    stopAcousticListener();
    setIsListening(false);
    setMicLevel(0);
  };

  const handleReset = () => {
    handleStopBroadcast();
    handleStopListening();
    setVerifiedData(null);
    setActiveSession(null);
    setLastDecodedRaw('');
    setErrorMsg('');
  };

  const copyAttestation = () => {
    if (!verifiedData) return;
    navigator.clipboard.writeText(
      JSON.stringify(verifiedData.latestAttestation, null, 2)
    );
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <div className="min-h-screen bg-slate-950 text-slate-100 p-4 md:p-8">
      <div className="max-w-3xl mx-auto space-y-6">
        {/* Header Bar */}
        <header className="flex flex-wrap items-center justify-between gap-4 bg-slate-900/90 border border-slate-800 rounded-2xl p-4">
          <div className="flex items-center gap-3">
            <div className="p-2.5 rounded-xl bg-emerald-500/10 border border-emerald-500/30 text-emerald-400">
              <Radio className="w-6 h-6"/>
            </div>
            <div>
              <h1 className="text-lg font-bold tracking-tight">
                Acoustic Proof-of-Vicinity
              </h1>
              <p className="text-xs text-slate-400">
                ggwave FSK Data-Over-Sound Co-Location Verifier
              </p>
            </div>
          </div>

          <div className="flex items-center gap-2 text-xs font-medium px-3 py-1.5 rounded-full bg-slate-800 border border-slate-700">
            {connected ? (
              <>
                <Wifi className="w-3.5 h-3.5 text-emerald-400"/>
                <span className="text-emerald-400">Socket Connected</span>
              </>
            ) : (
              <>
                <WifiOff className="w-3.5 h-3.5 text-rose-400"/>
                <span className="text-rose-400">Disconnected</span>
              </>
            )}
          </div>
        </header>

        {/* Role Selector Tabs */}
        <div className="grid grid-cols-2 gap-3 bg-slate-900 p-1.5 rounded-2xl border border-slate-800">
          <button
            onClick={() => {
              handleReset();
              setRole('broadcaster');
            }}
            className={`flex items-center justify-center gap-2 py-3 px-4 rounded-xl font-semibold text-sm transition ${
              role === 'broadcaster'
                ? 'bg-emerald-500 text-slate-950 shadow-lg'
                : 'text-slate-400 hover:text-slate-200'
            }`}
          >
            <Laptop className="w-4 h-4"/>
            Broadcaster (Laptop)
          </button>
          <button
            onClick={() => {
              handleReset();
              setRole('listener');
            }}
            className={`flex items-center justify-center gap-2 py-3 px-4 rounded-xl font-semibold text-sm transition ${
              role === 'listener'
                ? 'bg-emerald-500 text-slate-950 shadow-lg'
                : 'text-slate-400 hover:text-slate-200'
            }`}
          >
            <Smartphone className="w-4 h-4"/>
            Listener (Phone)
          </button>
        </div>

        {/* Error Banner */}
        {errorMsg && (
          <div className="flex items-start gap-3 bg-rose-950/60 border border-rose-500/40 text-rose-200 p-4 rounded-xl text-sm">
            <AlertCircle className="w-5 h-5 text-rose-400 shrink-0 mt-0.5"/>
            <span>{errorMsg}</span>
          </div>
        )}

        {/* VERIFIED SUCCESS BANNER (Shows on BOTH screens simultaneously) */}
        {verifiedData && (
          <div className="bg-emerald-950/40 border-2 border-emerald-500 rounded-2xl p-6 space-y-5 animate-pulse-once">
            <div className="flex items-center justify-between flex-wrap gap-4">
              <div className="flex items-center gap-3">
                <ShieldCheck className="w-10 h-10 text-emerald-400"/>
                <div>
                  <span className="text-xs font-bold uppercase tracking-wider px-2.5 py-0.5 rounded-full bg-emerald-500/20 text-emerald-300">
                    Physical Proximity Confirmed
                  </span>
                  <h2 className="text-2xl font-extrabold text-white mt-1">
                    Devices Verified in Same Room!
                  </h2>
                </div>
              </div>
              <button
                onClick={handleReset}
                className="flex items-center gap-2 px-4 py-2 rounded-xl bg-slate-800 hover:bg-slate-700 text-xs font-semibold border border-slate-700"
              >
                <RefreshCw className="w-3.5 h-3.5"/>
                New Verification
              </button>
            </div>

            <div className="grid grid-cols-2 sm:grid-cols-3 gap-3 text-xs">
              <div className="bg-slate-900/90 p-3 rounded-xl border border-slate-800">
                <span className="text-slate-400 block">Matched Nonce</span>
                <span className="font-mono text-lg font-bold text-emerald-400">
                  {verifiedData.latestAttestation.nonce}
                </span>
              </div>
              <div className="bg-slate-900/90 p-3 rounded-xl border border-slate-800">
                <span className="text-slate-400 block">Acoustic Protocol</span>
                <span className="font-mono text-sm font-semibold text-slate-200">
                  {verifiedData.latestAttestation.protocolMode}
                </span>
              </div>
              <div className="bg-slate-900/90 p-3 rounded-xl border border-slate-800 col-span-2 sm:col-span-1">
                <span className="text-slate-400 block">Roundtrip Time</span>
                <span className="font-mono text-sm font-semibold text-slate-200">
                  {(verifiedData.latestAttestation.latencyMs / 1000).toFixed(2)}s
                </span>
              </div>
            </div>

            <div className="space-y-2">
              <div className="flex items-center justify-between">
                <span className="text-xs font-semibold text-slate-400 uppercase tracking-wider">
                  On-Chain Ready Attestation Payload
                </span>
                <button
                  onClick={copyAttestation}
                  className="flex items-center gap-1.5 text-xs text-emerald-400 hover:text-emerald-300 font-medium"
                >
                  {copied ? (
                    <>
                      <Check className="w-3.5 h-3.5"/> Copied
                    </>
                  ) : (
                    <>
                      <Copy className="w-3.5 h-3.5"/> Copy JSON
                    </>
                  )}
                </button>
              </div>
              <pre className="bg-slate-950 p-4 rounded-xl border border-slate-800 text-xs font-mono text-emerald-300 overflow-x-auto">
                {JSON.stringify(verifiedData.latestAttestation, null, 2)}
              </pre>
            </div>
          </div>
        )}

        {/* BROADCASTER VIEW (LAPTOP) */}
        {!verifiedData && role === 'broadcaster' && (
          <div className="bg-slate-900 border border-slate-800 rounded-2xl p-6 space-y-6">
            <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 border-b border-slate-800 pb-5">
              <div>
                <h2 className="text-lg font-bold">Room Sound Broadcaster</h2>
                <p className="text-xs text-slate-400">
                  Emits an FSK acoustic token every 3 seconds through your speakers.
                </p>
              </div>

              {/* Frequency Protocol Toggle */}
              <div className="flex items-center gap-2 bg-slate-950 p-1.5 rounded-xl border border-slate-800 text-xs">
                <button
                  disabled={isBroadcasting}
                  onClick={() => setUseUltrasound(false)}
                  className={`px-3 py-1.5 rounded-lg font-medium transition ${
                    !useUltrasound
                      ? 'bg-emerald-500 text-slate-950 font-bold'
                      : 'text-slate-400'
                  }`}
                >
                  Audible (1.8 kHz)
                </button>
                <button
                  disabled={isBroadcasting}
                  onClick={() => setUseUltrasound(true)}
                  className={`px-3 py-1.5 rounded-lg font-medium transition ${
                    useUltrasound
                      ? 'bg-emerald-500 text-slate-950 font-bold'
                      : 'text-slate-400'
                  }`}
                >
                  Ultrasound (15+ kHz)
                </button>
              </div>
            </div>

            {activeSession && isBroadcasting && (
              <div className="bg-slate-950 border border-slate-800 rounded-xl p-5 text-center space-y-3">
                <div className="flex items-center justify-center gap-2 text-xs text-emerald-400 font-semibold">
                  <span className="w-2.5 h-2.5 rounded-full bg-emerald-400 animate-ping" />
                  Broadcasting Acoustic Token Across Room...
                </div>

                <div className="flex items-center justify-center gap-3">
                  <span className="font-mono text-3xl font-black tracking-widest text-white">
                    {hideNonce ? '••••••' : activeSession.nonce}
                  </span>
                  <button
                    onClick={() => setHideNonce(!hideNonce)}
                    className="p-2 rounded-lg bg-slate-900 hover:bg-slate-800 text-slate-400"
                    title="Toggle visibility"
                  >
                    {hideNonce ? (
                      <Eye className="w-4 h-4"/>
                    ) : (
                      <EyeOff className="w-4 h-4"/>
                    )}
                  </button>
                </div>
                <p className="text-xs text-slate-500">
                  Keep laptop speaker volume at 50–70%. Waiting for nearby phone to decode...
                </p>
              </div>
            )}

            <button
              onClick={
                isBroadcasting ? handleStopBroadcast : handleStartBroadcast
              }
              className={`w-full py-4 rounded-xl font-bold text-base flex items-center justify-center gap-2 transition ${
                isBroadcasting
                  ? 'bg-rose-600 hover:bg-rose-500 text-white'
                  : 'bg-emerald-500 hover:bg-emerald-400 text-slate-950'
              }`}
            >
              <Volume2 className="w-5 h-5"/>
              {isBroadcasting
                ? 'Stop Room Broadcast'
                : 'Start Acoustic Broadcast'}
            </button>

            {/* Mobile QR Code Helper */}
            {networkInfo.httpsUrl && (
              <div className="flex flex-col sm:flex-row items-center gap-4 bg-slate-950/80 border border-slate-800/80 rounded-xl p-4">
                <div className="bg-white p-2.5 rounded-xl shrink-0">
                  <QRCodeSVG size={96} value={networkInfo.httpsUrl}/>
                </div>
                <div className="space-y-1 text-center sm:text-left">
                  <span className="text-xs font-bold uppercase tracking-wider text-emerald-400">
                    Connect Your Phone on Same Wi-Fi
                  </span>
                  <p className="text-xs text-slate-300">
                    Scan this QR code with your phone or open{' '}
                    <code className="font-mono text-emerald-300 bg-slate-900 px-1.5 py-0.5 rounded">
                      {networkInfo.httpsUrl}
                    </code>
                  </p>
                  <p className="text-[11px] text-slate-400">
                    On your phone, tap <b>Advanced &rarr; Proceed</b> past the self-signed HTTPS warning so microphone access is unlocked.
                  </p>
                </div>
              </div>
            )}
          </div>
        )}

        {/* LISTENER VIEW (PHONE) */}
        {!verifiedData && role === 'listener' && (
          <div className="bg-slate-900 border border-slate-800 rounded-2xl p-6 space-y-6">
            <div>
              <h2 className="text-lg font-bold">Acoustic Room Listener</h2>
              <p className="text-xs text-slate-400">
                Listens via your device microphone with DSP noise-suppression disabled to decode nearby FSK room tokens.
              </p>
            </div>

            <div className="space-y-2">
              <label className="text-xs font-semibold text-slate-400">
                Verifier Device Label
              </label>
              <input
                type="text"
                value={deviceLabel}
                onChange={(e) => setDeviceLabel(e.target.value)}
                className="w-full bg-slate-950 border border-slate-800 rounded-xl px-3.5 py-2.5 text-sm text-white focus:outline-none focus:border-emerald-500"
              />
            </div>

            {isListening && (
              <div className="bg-slate-950 border border-slate-800 rounded-xl p-4 space-y-3">
                <div className="flex items-center justify-between text-xs">
                  <span className="text-emerald-400 font-semibold flex items-center gap-2">
                    <span className="w-2 h-2 rounded-full bg-emerald-400 animate-ping" />
                    Listening for Acoustic Chirp...
                  </span>
                  <span className="font-mono text-slate-400">
                    Mic Level: {micLevel}%
                  </span>
                </div>
                <div className="w-full h-2.5 bg-slate-900 rounded-full overflow-hidden">
                  <div
                    className="h-full bg-emerald-500 transition-all duration-75"
                    style={{ width: `${micLevel}%` }}
                  />
                </div>
                {lastDecodedRaw && (
                  <div className="text-xs text-slate-300 pt-1">
                    Last Decoded Token:{' '}
                    <span className="font-mono font-bold text-emerald-400">
                      {lastDecodedRaw}
                    </span>
                  </div>
                )}
              </div>
            )}

            <button
              onClick={
                isListening ? handleStopListening : handleStartListening
              }
              className={`w-full py-4 rounded-xl font-bold text-base flex items-center justify-center gap-2 transition ${
                isListening
                  ? 'bg-rose-600 hover:bg-rose-500 text-white'
                  : 'bg-emerald-500 hover:bg-emerald-400 text-slate-950'
              }`}
            >
              <Mic className="w-5 h-5"/>
              {isListening
                ? 'Stop Listening'
                : 'Start Listening for Room Sound'}
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
```