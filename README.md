# Acoustic Proof-of-Proximity MVP

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

Automated tests cannot establish physical speaker-to-microphone performance. Complete the two-device workflow above to validate the particular laptop, phone, browser, room, and volume. Browser UI verification in the agent session was blocked by the local self-signed certificate warning, which requires the user to accept it.

`npm run build` produces `dist/`. It can emit browser externalization notices for ggwave's Node-only `fs` and `path` branches; those branches are unused in browser mode. The supported local launch command is `npm run dev`; a standalone static deployment would need its own HTTPS/WSS coordinator routing.

## Attestation semantics

The payload includes `nonce`, `protocolMode`, `broadcasterId`, `listenerId`, `deviceLabel`, `verifiedAt`, `latencyMs`, and `attestationHash`. The hash is SHA-256 over `nonce:broadcasterId:listenerId:verifiedAt`. The supplied implementation names this field `attestationHash`, although the prompt's introductory description calls it `proofHash`. `latencyMs` measures time since session creation, including the wait before the phone hears the signal.

This is a cooperative demo. The coordinator accepts a submitted nonce, so knowledge of the code (including a replay or relay) can produce an attestation. The hash is unsigned, has no independent identity binding, and is not an on-chain transaction or a cryptographic guarantee of physical distance. The exact supplied backend also has no authentication, rate limiting, background session cleanup, or cancellation endpoint; stopping/resetting the UI does not revoke a challenge at the coordinator before its expiry. Do not treat its success wording as a security boundary.

## Research

Reviewed before implementation:

- [Official ggwave Web Audio example](https://github.com/ggerganov/ggwave/blob/master/examples/ggwave-js/index-tmpl.html): PCM conversion, capture settings, and 1024-sample decoder input.
- [ggwave package](https://www.npmjs.com/package/ggwave) and installed `node_modules/ggwave/emscripten.cpp`: CommonJS factory, enum names, raw waveform views, and encode/decode signatures.
- [Vite server options](https://vite.dev/config/server-options): HTTPS, host binding, strict port selection, and WebSocket proxying.
- [Official basic SSL plugin](https://github.com/vitejs/vite-plugin-basic-ssl): self-signed local certificate generation.
