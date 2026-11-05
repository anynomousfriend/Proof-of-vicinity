import ggwaveModule from 'ggwave';

const ggwaveFactory = ggwaveModule.default || ggwaveModule;

let audioContext = null;
let ggwave = null;
let instance = null;
let mediaStream = null;
let scriptNode = null;
let sourceNode = null;
let activePlaybackSource = null;
let initialization = null;
let listenerGeneration = 0;
let playbackGeneration = 0;

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
  if (!initialization) initialization = ggwaveFactory().catch((error) => {
    initialization = null;
    throw error;
  });
  if (!ggwave) {
    ggwave = await initialization;
    ggwave.disableLog();
  }
  if (instance === null) {
    const parameters = ggwave.getDefaultParameters();
    parameters.sampleRateInp = audioContext.sampleRate;
    parameters.sampleRateOut = audioContext.sampleRate;
    instance = ggwave.init(parameters);
  }
  return { audioContext, ggwave, instance };
}

export async function playChallengeTone(nonce, useUltrasound = false) {
  if (!/^[A-Z0-9]{6}$/.test(nonce)) throw new Error('Expected a six-character challenge.');
  const generation = ++playbackGeneration;
  await initModem();
  if (generation !== playbackGeneration) return;

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
      source.disconnect();
      if (activePlaybackSource === source) activePlaybackSource = null;
      resolve();
    };
    source.start(0);
  });
}

export function stopChallengeTone() {
  playbackGeneration++;
  if (activePlaybackSource) {
    try {
      activePlaybackSource.stop();
    } catch (_) {}
    activePlaybackSource = null;
  }
}

export async function startAcousticListener(onDecoded, onAudioLevel) {
  stopAcousticListener();
  const generation = listenerGeneration;
  await initModem();
  if (generation !== listenerGeneration) return false;
  if (!navigator.mediaDevices?.getUserMedia) {
    throw new Error('Microphone access requires a secure HTTPS browser context.');
  }

  const stream = await navigator.mediaDevices.getUserMedia({
    audio: {
      echoCancellation: false,
      autoGainControl: false,
      noiseSuppression: false,
    },
  });
  if (generation !== listenerGeneration) {
    stream.getTracks().forEach((track) => track.stop());
    return false;
  }
  mediaStream = stream;

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
  return true;
}

export function stopAcousticListener() {
  listenerGeneration++;
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
