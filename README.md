# Acoustic Proof-of-Proximity MVP

## Vercel deployment

Live app: https://proof-of-vicinity.vercel.app

The production build includes a complete hosted coordinator at `/api/proximity`. It uses **private Vercel Blob storage** for shared session state and HTTPS status polling every 1.5 seconds while a challenge is active. Both devices can use any internet connection. Audio encoding/decoding remains entirely in their browsers. The QR code points at the current public origin.

The Vercel project is `proof-of-vicinity`. Import the repository using Vite (`npm run build`, output `dist`) and attach a private Blob store to the project. Vercel supplies the server-only `BLOB_READ_WRITE_TOKEN`. The configured deployment uses Node 24. Supply `CRON_SECRET` as a random server-only environment variable for daily expired-record cleanup. Never give either secret a `VITE_` prefix or put it in source control.

`vercel.json` deploys the frontend, coordinator function, and daily cleanup function together. Health checks fail clearly if shared storage is missing. No local Express server, Vite proxy, LAN IP, self-signed certificate, or Redis account is needed for the hosted version. Vercel deployment protection must permit your intended phone users to access the app.

Hosted sessions expire after two minutes; Stop/Reset revokes the challenge. The first listener to verify wins, and retries by that listener return the same attestation. Updates use Blob ETag preconditions, so simultaneous functions cannot overwrite the winner. Reads bypass the Blob cache for consistent results. Management requests require a separate 256-bit token that is never included in the acoustic challenge or attestation. Daily cleanup removes old records; expiry is enforced immediately even before physical deletion.

Run `npm test` for the real WASM/audio tests plus hosted API, shared-state, race, expiry, cancellation, input validation, and client coordination tests. The local Socket.IO checks remain available via `npm run test:integration` while `npm run dev` is running.

Storage and Function operations count toward your Vercel plan limits. Stop the broadcast when finished. This prototype still accepts knowledge of the acoustic nonce as its verification evidence, so relays/replays of an active code remain outside its security guarantees.

Local React + ggwave WebAssembly demo with an Express/Socket.IO coordinator. The laptop broadcasts a six-character challenge; a phone decodes it through its microphone, and both screens receive a timestamped SHA-256 attestation.

## Run

Use Node.js 22.12+ (verified with Node.js 26.13.0).

```sh
npm ci
npm run dev
```

Open https://localhost:5173 on the laptop. The terminal and broadcaster UI display a QR code for the detected LAN address. Connect the phone to the same Wi-Fi and scan it. Accept the self-signed HTTPS certificate on each device, select Listener on the phone, and allow microphone access.

1. Start Listening on the phone.
2. Select Audible on the laptop, set speaker volume to roughly 50–70%, and Start Acoustic Broadcast.
3. Keep the devices nearby. The challenge repeats until verification, Stop, or its two-minute expiry.
4. Both screens show the matching attestation. Copy JSON to export it; New Verification resets the interface.

Ultrasound is optional and depends on speaker/microphone frequency response. Audible is the starting point for hardware testing. Turn off Bluetooth audio routing if the signal is playing through another device. Keep the phone browser in the foreground. If the LAN address is unreachable, check Wi-Fi isolation, VPN routing, and the host firewall. The supplied resolver selects the first non-internal IPv4 interface; on a computer with several interfaces, use Vite's printed address for the Wi-Fi network shared with the phone.

## Architecture

- Vite serves HTTPS on port 5173 with `@vitejs/plugin-basic-ssl` and `host: true`. `strictPort` prevents an unnoticed port change from invalidating the QR code.
- Same-origin `/api` and `/socket.io` requests, including WSS upgrades, proxy to Express on port 3001.
- `src/lib/acousticModem.js` copies the WASM byte view into Float32 PCM for playback and converts microphone PCM back into bytes for decoding. Echo cancellation, automatic gain control, and noise suppression are disabled.
- ggwave 0.4.0 exposes `ProtocolId` enum objects. Audible Fast and Ultrasound Fast each produced 1.323 seconds of audio for the six-character test payload at 48 kHz.
- The coordinator retains the exact implementation supplied in the execution prompt. Frontend fixes initialize audio from the user gesture, honor the session's selected protocol, stop at expiry/disconnection, cancel pending audio operations on reset, and report clipboard failures.

## Verify

```sh
npm test
npm run build
# With npm run dev running in another terminal:
npm run test:integration
```

The modem tests use the real ggwave WASM encoder and decoder with a simulated Web Audio graph. They cover both protocols, microphone constraints, PCM conversions, level feedback, and cancellation during permission requests and pending playback. Integration tests use the generated local certificate as their trusted CA, exercise HTTPS/API and actual WSS connections, reject unknown nonces, and recompute the attestation hash received by both clients.

Automated tests cannot establish physical speaker-to-microphone performance. Complete the two-device workflow above to validate the particular laptop, phone, browser, room, and volume. The public Vercel deployment was verified in-browser: coordinator connection, real audio initialization, broadcast controls, and attestation display. The browser success check submitted a test nonce through the API; it was not a physical phone microphone test. Live API checks also verified actual private Blob reads/writes, matching attestations, cancellation, and rejection of cancelled challenges.

`npm run build` produces `dist/`. It can emit browser externalization notices for ggwave's Node-only `fs` and `path` branches; those branches are unused in browser mode. The local launch command is `npm run dev`; production uses the Vercel functions described above.

## Attestation semantics

The payload includes `nonce`, `protocolMode`, `broadcasterId`, `listenerId`, `deviceLabel`, `verifiedAt`, `latencyMs`, and `attestationHash`. The hash is SHA-256 over `nonce:broadcasterId:listenerId:verifiedAt`. The supplied implementation names this field `attestationHash`, although the prompt's introductory description calls it `proofHash`. `latencyMs` measures time since session creation, including the wait before the phone hears the signal.

This is a cooperative demo. The coordinator accepts a submitted nonce, so knowledge of the code (including a replay or relay) can produce an attestation. The hash is unsigned, has no independent identity binding, and is not an on-chain transaction or a cryptographic guarantee of physical distance. The original local Socket.IO backend has no authentication, rate limiting, background session cleanup, or cancellation endpoint; stopping/resetting the local UI does not revoke a challenge before expiry. The hosted coordinator adds management tokens, cancellation, conditional updates, and daily cleanup; it has no per-user authentication or application-level rate limiting. Do not treat its success wording as a security boundary.

## Research

Reviewed before implementation:

- [Official ggwave Web Audio example](https://github.com/ggerganov/ggwave/blob/master/examples/ggwave-js/index-tmpl.html): PCM conversion, capture settings, and 1024-sample decoder input.
- [ggwave package](https://www.npmjs.com/package/ggwave) and installed `node_modules/ggwave/emscripten.cpp`: CommonJS factory, enum names, raw waveform views, and encode/decode signatures.
- [Vite server options](https://vite.dev/config/server-options): HTTPS, host binding, strict port selection, and WebSocket proxying.
- [Official basic SSL plugin](https://github.com/vitejs/vite-plugin-basic-ssl): self-signed local certificate generation.
