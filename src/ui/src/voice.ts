/**
 * Ears and mouth in the browser: capture speech from the microphone (push-to-talk or hands-free)
 * and play Jarvis's voice as it arrives, exposing a loudness level so the core can react.
 */
import { Segmenter } from '../../shared/vad';
import { call, get, onPush, set, setVoiced, toast } from './link';

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

let decoding: Promise<void> = Promise.resolve();

// ---- words appear on screen as they are spoken
type Segment = { text: string; at: number; dur: number };
let segments: Segment[] = [];
let segTurn = '';
let segFinal = false;
let revealTimer = 0;

function showAll(): void {
  clearInterval(revealTimer);
  revealTimer = 0;
  if (segTurn) setVoiced(segTurn, undefined);
  segments = [];
  segTurn = '';
  segFinal = false;
}

function reveal(): void {
  const c = ctx;
  if (!c || !segTurn) return;
  const now = c.currentTime;
  let out = '';
  let finished = true;
  for (const seg of segments) {
    if (now >= seg.at + seg.dur) out += seg.text + ' ';
    else {
      finished = false;
      if (now >= seg.at) {
        // Up to the end of the word being said.
        const upTo = Math.ceil(seg.text.length * ((now - seg.at) / seg.dur)) + 1;
        const end = seg.text.indexOf(' ', upTo);
        out += seg.text.slice(0, end < 0 ? seg.text.length : end);
      }
      break;
    }
  }
  if (finished && segFinal) return showAll();
  setVoiced(segTurn, out.trimEnd());
}

/** Note that this text starts being spoken at `at`, so the screen can follow the voice. */
function follow(turn: string, text: string, at: number, clipSeconds: number): void {
  if (get().turn?.id !== turn) return;
  if (segTurn !== turn) (segments = []), (segTurn = turn), (segFinal = false);
  // A streamed voice sends the words with its first sliver of sound: judge the length from the text then.
  const pace = 15.5 * (get().snap?.settings.speed ?? 1);
  const est = text.length / pace;
  segments.push({ text, at, dur: clipSeconds < est * 0.6 ? est : clipSeconds });
  if (!revealTimer) revealTimer = window.setInterval(reveal, 50);
}

function playPcm(rate: number, b64: string, gap = 60, turn = '', text = ''): void {
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
  playBuffer(ab, gap, turn, text);
}

function playBuffer(ab: AudioBuffer, gap = 60, turn = '', text = ''): void {
  const c = audio();
  const src = c.createBufferSource();
  src.buffer = ab;
  src.connect(analyser!);
  const at = Math.max(c.currentTime + 0.015, playHead);
  // The pause after this clip: a breath after a sentence, barely anything inside one.
  playHead = at + ab.duration + gap / 1000;
  if (text) follow(turn, text, at, ab.duration);
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
  showAll();
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
        const kind = p.wav.slice(0, i), data = p.wav.slice(i + 1), gap = p.gap, turn = p.turn, text = p.text;
        // Clips are decoded one after another so they always play in the order they were sent.
        decoding = decoding.then(async () => {
          if (turn !== lastTurn && !turn.startsWith('n')) return; // a newer reply has taken over
          if (kind === 'mp3') {
            try {
              const bin = atob(data);
              const bytes = new Uint8Array(bin.length);
              for (let k = 0; k < bin.length; k++) bytes[k] = bin.charCodeAt(k);
              playBuffer(await audio().decodeAudioData(bytes.buffer), gap, turn, text);
            } catch {
              /* an undecodable clip is skipped rather than stalling the rest */
            }
          } else playPcm(+kind, data, gap, turn, text);
        });
      } else if (p.last) {
        const turn = p.turn;
        // After everything queued before it: the reply is complete once the last word has been said.
        decoding = decoding.then(() => {
          if (segTurn === turn && segments.length) segFinal = true;
          else setVoiced(turn, undefined); // nothing was spoken: just show the text
          setTimeout(settle, 50);
        });
      }
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
  if (playing > 0 || get().mode === 'thinking') return void (seg = new Segmenter({ maxLen: 14, minSilence: 0.55 }));
  for (const s of seg.push(chunk)) if (s.end - s.start >= 0.5) void send(s.pcm, Date.now() > openUntil);
}

/** A soft two-note chime the instant you stop talking, so you know you were heard before the reply arrives. */
function blip(): void {
  try {
    const c = audio();
    const t = c.currentTime;
    const g = c.createGain();
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(0.045, t + 0.012);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.16);
    g.connect(c.destination);
    const o = c.createOscillator();
    o.type = 'sine';
    o.frequency.setValueAtTime(740, t);
    o.frequency.setValueAtTime(988, t + 0.07);
    o.connect(g);
    o.start(t);
    o.stop(t + 0.18);
  } catch {
    /* sound is a nicety */
  }
}

async function send(pcm: Float32Array, needWake: boolean): Promise<void> {
  if (!needWake) blip();
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
    seg = new Segmenter({ maxLen: 14, minSilence: 0.55 });
    set({ handsFree: true });
  } else {
    seg = null;
    set({ handsFree: false });
    closeMic();
  }
}
