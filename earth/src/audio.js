// All sound is synthesised with Web Audio, so there are no audio files to download.
import { G, clamp } from './util.js';

export class Audio {
  constructor() { this.ctx = null; this.on = true; }
  start() {
    if (this.ctx) { this.ctx.resume(); return; }
    const AC = window.AudioContext || window.webkitAudioContext; if (!AC) return;
    const c = this.ctx = new AC(); this.out = c.createGain(); this.out.gain.value = 0.55; this.out.connect(c.destination);
    const n = c.sampleRate * 2, b = this.nb = c.createBuffer(1, n, c.sampleRate), d = b.getChannelData(0); for (let i = 0; i < n; i++) d[i] = Math.random() * 2 - 1;
    // continuous layers: wind, rain, engine, siren, jets, rotor
    this.windL = this.loopNoise('bandpass', 500, 0.6); this.rainL = this.loopNoise('highpass', 2500, 0.3); this.jetL = this.loopNoise('lowpass', 900, 0.8); this.heliL = this.loopNoise('lowpass', 160, 1);
    this.eng = this.osc('sawtooth', 60); this.eng2 = this.osc('square', 30); this.sir = this.osc('triangle', 700);
    this.engT = 0; this.heliT = 0; this.heliV = 0; this.sirOn = false;
  }
  loopNoise(type, f, q) { const c = this.ctx, s = c.createBufferSource(); s.buffer = this.nb; s.loop = true; const fl = c.createBiquadFilter(); fl.type = type; fl.frequency.value = f; fl.Q.value = q; const g = c.createGain(); g.gain.value = 0; s.connect(fl); fl.connect(g); g.connect(this.out); s.start(); return { g, fl }; }
  osc(type, f) { const c = this.ctx, o = c.createOscillator(); o.type = type; o.frequency.value = f; const fl = c.createBiquadFilter(); fl.type = 'lowpass'; fl.frequency.value = 900; const g = c.createGain(); g.gain.value = 0; o.connect(fl); fl.connect(g); g.connect(this.out); o.start(); return { o, g }; }
  vol(p) { return p && G.player ? 1 / (1 + G.player.pos.distanceTo(p) / 18) : 1; }
  tone(f, dur, type = 'sine', v = 0.2, to = null) { const c = this.ctx; if (!c) return; const o = c.createOscillator(), g = c.createGain(), t = c.currentTime; o.type = type; o.frequency.setValueAtTime(f, t); if (to) o.frequency.exponentialRampToValueAtTime(to, t + dur); g.gain.setValueAtTime(v, t); g.gain.exponentialRampToValueAtTime(0.001, t + dur); o.connect(g); g.connect(this.out); o.start(t); o.stop(t + dur); }
  noise(dur, v = 0.3, f = 1000, type = 'lowpass', to = null) { const c = this.ctx; if (!c) return; const s = c.createBufferSource(), fl = c.createBiquadFilter(), g = c.createGain(), t = c.currentTime; s.buffer = this.nb; fl.type = type; fl.frequency.setValueAtTime(f, t); if (to) fl.frequency.exponentialRampToValueAtTime(to, t + dur); g.gain.setValueAtTime(v, t); g.gain.exponentialRampToValueAtTime(0.001, t + dur); s.connect(fl); fl.connect(g); g.connect(this.out); s.start(t, Math.random()); s.stop(t + dur); }
  set(param, v, k = 0.1) { if (this.ctx && isFinite(v)) param.setTargetAtTime(v, this.ctx.currentTime, k); }
  thwip() { this.noise(0.16, 0.25, 3000, 'bandpass', 900); this.tone(900, 0.1, 'sine', 0.08, 300); }
  whoosh(k = 1) { this.noise(0.3, 0.16 * k, 500, 'bandpass', 1800); }
  jump() { this.tone(220, 0.14, 'sine', 0.1, 420); }
  land() { this.noise(0.25, 0.4, 220); this.tone(70, 0.2, 'sine', 0.3, 35); }
  hit(p, k = 0.6) { const v = this.vol(p) * k; this.noise(0.09, 0.5 * v, 900); this.tone(130, 0.1, 'square', 0.14 * v, 55); }
  shot(p) { const v = this.vol(p); this.noise(0.12, 0.45 * v, 2400, 'lowpass', 300); }
  crash(p, s) { const v = this.vol(p) * clamp(s / 20, 0.2, 1); this.noise(0.4, 0.6 * v, 1800, 'lowpass', 150); this.tone(90, 0.25, 'sawtooth', 0.15 * v, 40); }
  boom(p, k = 1) { const v = this.vol(p) * k; this.noise(1.1, 0.9 * v, 900, 'lowpass', 50); this.tone(55, 0.8, 'sine', 0.7 * v, 22); }
  shatter(p) { const v = this.vol(p); this.noise(0.3, 0.3 * v, 5000, 'highpass'); this.tone(2400, 0.2, 'triangle', 0.06 * v, 5200); }
  thunder() { this.noise(2.6, 0.7, 260, 'lowpass', 40); }
  door() { this.noise(0.08, 0.3, 300); }
  deny() { this.tone(160, 0.12, 'square', 0.07, 120); }
  blink() { this.tone(1400, 0.18, 'sine', 0.12, 180); this.noise(0.15, 0.15, 4000, 'bandpass', 600); }
  power(h, i) { const f = [520, 180, 900, 300][h] * (1 + i * 0.25); this.tone(f, 0.35, h === 1 ? 'sawtooth' : 'triangle', 0.12, f * (h === 2 ? 2 : 0.5)); this.noise(0.35, 0.18, h === 2 ? 5000 : 700, h === 2 ? 'highpass' : 'lowpass'); }
  wind(speed, grounded) { if (!this.ctx) return; this.set(this.windL.g.gain, clamp((speed - 6) / 50, 0.015, 0.5)); this.set(this.windL.fl.frequency, 300 + speed * 22); }
  engine(vf, thr) { if (!this.ctx) return; this.engT = 0.15; const s = Math.abs(vf), f = 46 + (s % 22) * 4.2 + s * 1.1; this.set(this.eng.o.frequency, f, 0.05); this.set(this.eng2.o.frequency, f / 2, 0.05); this.set(this.eng.g.gain, 0.05 + Math.abs(thr) * 0.05); this.set(this.eng2.g.gain, 0.05); }
  jet(on, kind) { if (!this.ctx) return; this.set(this.jetL.g.gain, on ? 0.3 : 0, 0.08); if (on) this.set(this.jetL.fl.frequency, kind ? 2600 : 700); }
  heli(d) { this.heliT = 0.3; this.heliV = clamp(1 - d / 350, 0, 1) * 0.5; }
  siren(on) { this.sirOn = on; }
  frame(dt) {
    if (!this.ctx) return; this.engT -= dt; this.heliT -= dt;
    if (this.engT <= 0) { this.set(this.eng.g.gain, 0); this.set(this.eng2.g.gain, 0); }
    this.set(this.heliL.g.gain, this.heliT > 0 ? this.heliV * (0.6 + 0.4 * Math.sin(G.time * 38)) : 0, 0.02);
    const w = G.wanted, near = w && w.level > 0 && G.ents.cars.some(c => c.ai === 'cop' && c.emp <= 0 && c.pos.distanceTo(G.player.pos) < 220);
    this.set(this.sir.g.gain, near ? 0.045 : 0); if (near) this.set(this.sir.o.frequency, 650 + 250 * Math.sign(Math.sin(G.time * 4.2)), 0.08);
    this.set(this.rainL.g.gain, G.sky ? G.sky.cur.rain * 0.22 : 0, 0.5);
  }
  mute(m) { if (this.out) this.out.gain.value = m ? 0 : 0.55; }
}
