/**
 * Ears and mouth in the browser: capture speech from the microphone (push-to-talk or hands-free)
 * and play Jarvis's voice as it arrives, exposing a loudness level so the core can react.
 */
import { Segmenter } from '../../shared/vad';
import { call, get, onPush, set, toast } from './link';

let ctx: AudioContext | null = null; // playback
let analyser: AnalyserNode | null = null;
let micCtx: AudioContext | null = null;
let micStream: MediaStream | null = null;
let micAnalyser: AnalyserNode | null = null;
let tap: AudioWorkletNode | null = null;
let held: Float32Array[] | null = null; // push-to-talk buffer
let seg: Segmenter | null = null; // hands-free
let openUntil = 0; // after a reply, follow-ups need no wake word
let playHead = 0;
let playing = 0;
let lastTurn = '';
const buf = new Uint8Array(512);

const audio = (): AudioContext => {
  if (!ctx) {
    ctx = new AudioContext();
    analyser = ctx.createAnalyser();
    analyser.fftSize = 512;
    analyser.smoothingTimeConstant = 0.6;
    analyser.connect(ctx.destination);
  }
  return ctx;
};

/** Browsers only allow sound after a tap or key press: call this from one. */
export function unlock(): void {
  void audio().resume();
}

/** 0..1 loudness of whatever is audible right now: Jarvis speaking, or you while listening. */
export function level(): number {
  const a = get().mode === 'listening' ? micAnalyser : analyser;
  if (!a) return 0;
  a.getByteTimeDomainData(buf);
  let sum = 0;
  for (let i = 0; i < buf.length; i++) {
    const v = (buf[i] - 128) / 128;
    sum += v * v;
  }
  return Math.min(1, Math.sqrt(sum / buf.length) * 5);
}

function settle(): void {
  if (playing > 0) return;
  openUntil = Date.now() + 25000;
  if (get().mode === 'speaking') set({ mode: 'idle' });
}

function playPcm(rate: number, b64: string): void {
  const c = audio();
  const bin = atob(b64);
  const n = bin.length >> 1;
  const f32 = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const v = bin.charCodeAt(i * 2) | (bin.charCodeAt(i * 2 + 1) << 8);
    f32[i] = (v >= 0x8000 ? v - 0x10000 : v) / 32768;
  }
  const ab = c.createBuffer(1, n, rate);
  ab.getChannelData(0).set(f32);
  const src = c.createBufferSource();
  src.buffer = ab;
  src.connect(analyser!);
  const at = Math.max(c.currentTime + 0.03, playHead);
  playHead = at + ab.duration + 0.06;
  playing++;
  set({ mode: 'speaking' });
  src.onended = () => {
    playing--;
    setTimeout(settle, 120);
  };
  src.start(at);
  sources.add(src);
  src.addEventListener('ended', () => sources.delete(src));
}
const sources = new Set<AudioBufferSourceNode>();

export function hush(): void {
  for (const s of sources) {
    try {
      s.stop();
    } catch {
      /* already stopped */
    }
  }
  sources.clear();
  playing = 0;
  playHead = 0;
  speechSynthesis?.cancel();
  if (get().mode === 'speaking') set({ mode: 'idle' });
}

export function initVoice(): void {
  onPush((p) => {
    // The summon shortcut on the Mac: first press starts listening, second press sends.
    if (p.type === 'summon') {
      if (!(window as { jarvisDesktop?: unknown }).jarvisDesktop) return;
      if (get().mode === 'listening') talkEnd();
      else void talkStart();
      return;
    }
    if (p.type === 'audio') {
      if (p.turn !== lastTurn && !p.turn.startsWith('n')) {
        // A new reply replaces anything still being said.
        if (lastTurn && playing) hush();
        lastTurn = p.turn;
      }
      if (p.wav) {
        const i = p.wav.indexOf(':');
        playPcm(+p.wav.slice(0, i), p.wav.slice(i + 1));
      } else if (p.last) setTimeout(settle, 50);
    } else if (p.type === 'say' && p.done) {
      const s = get();
      // No neural voice installed yet: fall back to the device's built-in voice.
      if (s.snap?.settings.speak && s.snap.status.voice === 'missing' && s.turn?.text && 'speechSynthesis' in window) {
        const u = new SpeechSynthesisUtterance(s.turn.text);
        u.lang = 'en-GB';
        u.rate = 1.05;
        u.onstart = () => set({ mode: 'speaking' });
        u.onend = () => set({ mode: 'idle' });
        speechSynthesis.speak(u);
      } else if (!s.snap?.settings.speak && s.mode !== 'listening') set({ mode: 'idle' });
    }
  });
}

async function openMic(): Promise<boolean> {
  if (tap) return true;
  try {
    if (!window.isSecureContext || !navigator.mediaDevices) throw new Error('insecure');
    const desk = (window as unknown as { jarvisDesktop?: { mic(): Promise<boolean> } }).jarvisDesktop;
    if (desk && !(await desk.mic())) throw new Error('denied');
    micStream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true, channelCount: 1 } });
    micCtx = new AudioContext({ sampleRate: 16000 });
    await micCtx.audioWorklet.addModule(new URL('./pcm-worklet.js', document.baseURI).href);
    const src = micCtx.createMediaStreamSource(micStream);
    micAnalyser = micCtx.createAnalyser();
    micAnalyser.fftSize = 512;
    src.connect(micAnalyser);
    tap = new AudioWorkletNode(micCtx, 'pcm-tap', { numberOfInputs: 1, numberOfOutputs: 0, channelCount: 1, channelCountMode: 'explicit' });
    src.connect(tap);
    tap.port.onmessage = (e: MessageEvent<Float32Array>) => onAudio(e.data);
    set({ micError: '' });
    return true;
  } catch (err) {
    const msg = String((err as Error).message);
    const why = msg === 'insecure' ? 'The microphone needs a secure (https) connection on this device. Type instead, or use your keyboard\'s dictation key. See “Pair a phone” on the Mac for the secure link.' : /denied|NotAllowed/i.test(msg) ? 'Microphone access was denied. Allow it in your system settings.' : 'No microphone is available.';
    set({ micError: why, handsFree: false });
    toast(why, 'alert');
    return false;
  }
}

function closeMic(): void {
  if (held || get().handsFree) return;
  tap?.disconnect();
  tap = null;
  micStream?.getTracks().forEach((t) => t.stop());
  micStream = null;
  void micCtx?.close();
  micCtx = null;
  micAnalyser = null;
}

function onAudio(chunk: Float32Array): void {
  if (held) return void held.push(chunk);
  if (!seg) return;
  // Don't listen to our own voice coming out of the speakers.
  if (playing > 0 || get().mode === 'thinking') return void (seg = new Segmenter({ maxLen: 14, minSilence: 0.7 }));
  for (const s of seg.push(chunk)) if (s.end - s.start >= 0.5) void send(s.pcm, Date.now() > openUntil);
}

async function send(pcm: Float32Array, needWake: boolean): Promise<void> {
  const bytes = new Uint8Array(pcm.length * 2);
  const view = new DataView(bytes.buffer);
  for (let i = 0; i < pcm.length; i++) view.setInt16(i * 2, Math.max(-32768, Math.min(32767, Math.round(pcm[i] * 32767))), true);
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  try {
    if (!needWake) set({ mode: 'thinking' });
    const r = await call<{ heard: string; ignored?: boolean }>('hear', { pcm: btoa(bin), needWake });
    if (r.ignored && !needWake) {
      set({ mode: get().handsFree ? 'idle' : 'idle' });
      if (!r.heard) toast("I didn't catch that.");
    }
  } catch (err) {
    set({ mode: 'idle' });
    toast((err as Error).message, 'alert');
  }
}

/** Push-to-talk: call on press… */
export async function talkStart(): Promise<void> {
  if (held) return;
  unlock();
  hush();
  void call('stop').catch(() => undefined);
  held = [];
  if (!(await openMic())) return void (held = null);
  set({ mode: 'listening' });
}

/** …and on release. */
export function talkEnd(): void {
  if (!held) return;
  const chunks = held;
  held = null;
  const n = chunks.reduce((a, c) => a + c.length, 0);
  if (get().mode === 'listening') set({ mode: 'idle' });
  if (n < 16000 * 0.35) return void closeMic();
  const pcm = new Float32Array(n);
  let o = 0;
  for (const c of chunks) (pcm.set(c, o), (o += c.length));
  closeMic();
  void send(pcm, false);
}

/** Hands-free: Jarvis listens all the time and answers when he hears his name. */
export async function setHandsFree(on: boolean): Promise<void> {
  unlock();
  if (on) {
    if (!(await openMic())) return;
    seg = new Segmenter({ maxLen: 14, minSilence: 0.7 });
    set({ handsFree: true });
  } else {
    seg = null;
    set({ handsFree: false });
    closeMic();
  }
}
