import React, { useState, useEffect, useRef } from 'react';
import { io } from 'socket.io-client';
import { createHostedCoordinator } from './lib/hostedCoordinator.js';
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
  initModem,
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
  const broadcastGeneration = useRef(0);
  const pendingBroadcast = useRef(false);
  const [isStarting, setIsStarting] = useState(false);
  const expiryTimer = useRef(null);

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
    if (import.meta.env.PROD) {
      setNetworkInfo({ httpsUrl: window.location.origin, hosted: true });
    } else {
    fetch('/api/network-info')
      .then((r) => r.json())
      .then((data) => setNetworkInfo(data))
      .catch(() => {});
    }

    const s = import.meta.env.PROD ? createHostedCoordinator() : io();
    setSocket(s);

    s.on('connect', () => { setConnected(true); setErrorMsg(''); });
    s.on('connect_error', (error) => setErrorMsg('Coordinator unavailable: ' + error.message));
    s.on('session-error', ({ reason }) => {
      broadcastGeneration.current++;
      pendingBroadcast.current = false;
      broadcastLoopRef.current = false;
      clearTimeout(expiryTimer.current);
      stopChallengeTone();
      setIsBroadcasting(false);
      setIsStarting(false);
      setActiveSession(null);
      setErrorMsg(reason);
    });
    s.on('disconnect', () => {
      setConnected(false);
      broadcastGeneration.current++;
      pendingBroadcast.current = false;
      broadcastLoopRef.current = false;
      stopChallengeTone();
      stopAcousticListener();
      setIsBroadcasting(false);
      setIsListening(false);
      setIsStarting(false);
      setActiveSession(null);
    });

    s.on('session-created', (sessionData) => {
      if (!pendingBroadcast.current) return;
      pendingBroadcast.current = false;
      setIsStarting(false);
      setActiveSession(sessionData);
      setVerifiedData(null);
      setErrorMsg('');
      startBroadcastLoop(sessionData.nonce, sessionData.protocolMode, sessionData.expiresAt);
    });

    s.on('proximity-verified', (payload) => {
      broadcastLoopRef.current = false;
      broadcastGeneration.current++;
      clearTimeout(expiryTimer.current);
      setIsBroadcasting(false);
      stopChallengeTone();
      stopAcousticListener();
      setIsListening(false);
      setMicLevel(0);
      setVerifiedData(payload);
      setErrorMsg('');
    });

    s.on('verification-failed', ({ reason }) => {
      setErrorMsg(reason);
    });

    return () => {
      broadcastGeneration.current++;
      clearTimeout(expiryTimer.current);
      broadcastLoopRef.current = false;
      stopChallengeTone();
      stopAcousticListener();
      s.disconnect();
    };
  }, []);

  const startBroadcastLoop = async (nonce, protocolMode, expiresAt) => {
    const generation = ++broadcastGeneration.current;
    broadcastLoopRef.current = true;
    setIsBroadcasting(true);
    clearTimeout(expiryTimer.current);
    expiryTimer.current = setTimeout(() => {
      handleStopBroadcast();
      setActiveSession(null);
      setErrorMsg('Challenge expired after two minutes. Start a new broadcast.');
    }, Math.max(0, expiresAt - Date.now()));
    while (broadcastLoopRef.current && generation === broadcastGeneration.current) {
      try {
        await playChallengeTone(nonce, protocolMode === 'ULTRASOUND_FAST');
      } catch (err) {
        handleStopBroadcast();
        setErrorMsg('Audio playback error: ' + err.message);
        break;
      }
      await new Promise((r) => setTimeout(r, 1800));
    }
  };

  const handleStartBroadcast = async () => {
    if (!socket?.connected || pendingBroadcast.current) return;
    pendingBroadcast.current = true;
    setIsStarting(true);
    setErrorMsg('');
    setVerifiedData(null);
    try {
      await initModem();
      if (!pendingBroadcast.current || !socket.connected) return;
      socket.emit('create-session', {
        protocolMode: useUltrasound ? 'ULTRASOUND_FAST' : 'AUDIBLE_FAST',
      });
    } catch (err) {
      pendingBroadcast.current = false;
      setIsStarting(false);
      setErrorMsg('Audio initialization failed: ' + err.message);
    }
  };

  const handleStopBroadcast = () => {
    socket?.emit('cancel-session');
    broadcastGeneration.current++;
    pendingBroadcast.current = false;
    setIsStarting(false);
    clearTimeout(expiryTimer.current);
    broadcastLoopRef.current = false;
    setIsBroadcasting(false);
    stopChallengeTone();
  };

  const handleStartListening = async () => {
    if (!socket?.connected || isStarting) return;
    setIsStarting(true);
    setErrorMsg('');
    setVerifiedData(null);
    setLastDecodedRaw('');
    try {
      const started = await startAcousticListener(
        (decodedToken) => {
          setLastDecodedRaw(decodedToken);
          if (socket.connected && /^[A-Z0-9]{6}$/.test(decodedToken)) {
            socket.emit('verify-nonce', {
              nonce: decodedToken,
              deviceLabel,
            });
          }
        },
        (level) => setMicLevel(level)
      );
      setIsListening(started);
    } catch (err) {
      setErrorMsg(
        `Microphone unavailable: ${err.message}. Open the HTTPS URL, accept the certificate warning, and allow microphone access.`
      );
    } finally {
      setIsStarting(false);
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

  const copyAttestation = async () => {
    if (!verifiedData) return;
    try {
    await navigator.clipboard.writeText(
      JSON.stringify(verifiedData.latestAttestation, null, 2)
    );
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
    } catch (err) {
      setErrorMsg('Could not copy the payload: ' + err.message);
    }
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
                <span className="text-emerald-400">Coordinator Connected</span>
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
                <span className="text-slate-400 block">Time Since Challenge</span>
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
                  disabled={isBroadcasting || isStarting}
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
                  disabled={isBroadcasting || isStarting}
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
              disabled={!connected || isStarting}
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
              {isStarting ? 'Preparing Audio…' : isBroadcasting
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
                    {networkInfo.hosted ? 'Open on Your Phone' : 'Connect Your Phone on Same Wi-Fi'}
                  </span>
                  <p className="text-xs text-slate-300">
                    Scan this QR code with your phone or open{' '}
                    <code className="font-mono text-emerald-300 bg-slate-900 px-1.5 py-0.5 rounded">
                      {networkInfo.httpsUrl}
                    </code>
                  </p>
                  <p className="text-[11px] text-slate-400">
                    {networkInfo.hosted
                      ? 'Open this link on both devices. Allow microphone access on the phone, and keep both devices nearby. Wi-Fi or mobile data works.'
                      : <>On your phone, tap <b>Advanced &rarr; Proceed</b> past the self-signed HTTPS warning so microphone access is unlocked.</>}
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
              <label htmlFor="device-label" className="text-xs font-semibold text-slate-400">
                Verifier Device Label
              </label>
              <input
                id="device-label"
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
              disabled={!connected || isStarting}
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
              {isStarting ? 'Preparing Microphone…' : isListening
                ? 'Stop Listening'
                : 'Start Listening for Room Sound'}
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
