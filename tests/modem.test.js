import test from 'node:test';
import assert from 'node:assert/strict';
import { initModem, playChallengeTone, stopChallengeTone, startAcousticListener, stopAcousticListener } from '../src/lib/acousticModem.js';

let lastBuffer, processor, constraints, stopped = 0, permissionRequest;
class AudioContext {
  sampleRate = 48000;
  state = 'running';
  destination = {};
  createBuffer(_channels, length) {
    const samples = new Float32Array(length);
    lastBuffer = samples;
    return { getChannelData: () => samples };
  }
  createBufferSource() {
    return { connect() {}, disconnect() {}, start() { queueMicrotask(() => this.onended()); }, stop() { this.onended(); } };
  }
  createMediaStreamSource() { return { connect() {}, disconnect() {} }; }
  createScriptProcessor() { processor = { connect() {}, disconnect() {} }; return processor; }
}
globalThis.window = { AudioContext };
Object.defineProperty(globalThis.navigator, 'mediaDevices', { configurable: true, value: {
  getUserMedia: async (value) => {
    constraints = value;
    return permissionRequest ? permissionRequest : { getTracks: () => [{ stop() { stopped++; } }] };
  },
} });

test('real WASM audible and ultrasound waveforms survive Web Audio byte conversions', async () => {
  const modem = await initModem();
  for (const ultrasound of [false, true]) {
    await playChallengeTone('K9X2M4', ultrasound);
    assert.equal(lastBuffer.length / 48000, 1.3226666666666667);
    assert.ok(lastBuffer.some((sample) => sample !== 0));
    assert.ok(lastBuffer.every(Number.isFinite));
    let decoded = '', peak = 0;
    assert.equal(await startAcousticListener((value) => { decoded = value; }, (level) => { peak = Math.max(peak, level); }), true);
    assert.deepEqual(constraints.audio, { echoCancellation: false, autoGainControl: false, noiseSuppression: false });
    for (let i = 0; i < lastBuffer.length; i += 1024) {
      const chunk = new Float32Array(1024);
      chunk.set(lastBuffer.subarray(i, i + 1024));
      processor.onaudioprocess({ inputBuffer: { getChannelData: () => chunk } });
    }
    assert.equal(decoded, 'K9X2M4');
    assert.ok(peak > 0 && peak <= 100);
    stopAcousticListener();
    assert.equal(processor.onaudioprocess, null);
  }
  assert.equal(stopped, 2);
  assert.ok(modem.instance >= 0);
});

test('stop during microphone permission request disposes of the late stream', async () => {
  let resolvePermission;
  permissionRequest = new Promise((resolve) => { resolvePermission = resolve; });
  const pending = startAcousticListener(() => assert.fail('Cancelled listener decoded audio'));
  await new Promise(setImmediate);
  stopAcousticListener();
  resolvePermission({ getTracks: () => [{ stop() { stopped++; } }] });
  assert.equal(await pending, false);
  assert.equal(stopped, 3);
  permissionRequest = null;
});

test('stop cancels playback while modem initialization is pending', async () => {
  const previous = lastBuffer;
  const pending = playChallengeTone('ABC234');
  stopChallengeTone();
  await pending;
  assert.equal(lastBuffer, previous);
  await assert.rejects(playChallengeTone('long payload'), /six-character/);
});
