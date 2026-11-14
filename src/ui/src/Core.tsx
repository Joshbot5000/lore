import { useEffect, useRef } from 'react';
import { get } from './link';
import { level } from './voice';

/**
 * The core: Jarvis's face. Concentric instrument rings around a plasma centre. It breathes at
 * rest, tightens and brightens when listening, spins a scanning arc while thinking, and ripples
 * with the voice when speaking.
 */
export function Core({ size }: { size: number }) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const cv = ref.current!;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    cv.width = cv.height = Math.round(size * dpr);
    const g = cv.getContext('2d')!;
    const still = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    let raf = 0, t = 0, last = performance.now(), L = 0, spin = 0, energy = 0, tight = 0, scan = 0;
    const draw = (now: number) => {
      raf = requestAnimationFrame(draw);
      const dt = Math.min(0.05, (now - last) / 1000);
      last = now;
      const mode = get().mode;
      const target = level();
      L += (target - L) * (target > L ? 0.4 : 0.12);
      const want = mode === 'thinking' ? 1 : mode === 'speaking' ? 0.55 : mode === 'listening' ? 0.75 : 0.12;
      energy += (want - energy) * 0.06;
      tight += ((mode === 'listening' ? 1 : 0) - tight) * 0.1;
      scan += ((mode === 'thinking' ? 1 : 0) - scan) * 0.08;
      const speed = still ? 0.2 : 1;
      t += dt * speed;
      spin += dt * speed * (0.25 + energy * 1.6);
      const [r, gr, b] = (getComputedStyle(document.documentElement).getPropertyValue('--accent-rgb') || '94,230,255').split(',').map((x) => +x);
      const [r2, g2, b2] = (getComputedStyle(document.documentElement).getPropertyValue('--accent2-rgb') || '255,179,71').split(',').map((x) => +x);
      const col = (a: number) => `rgba(${r},${gr},${b},${a})`;
      const col2 = (a: number) => `rgba(${r2},${g2},${b2},${a})`;
      const W = cv.width, c = W / 2, R = W * 0.4 * (1 - tight * 0.05);
      g.clearRect(0, 0, W, W);
      g.lineCap = 'round';

      // halo
      const halo = g.createRadialGradient(c, c, R * 0.2, c, c, R * 1.25);
      halo.addColorStop(0, col(0.16 + energy * 0.12 + L * 0.15));
      halo.addColorStop(0.6, col(0.05));
      halo.addColorStop(1, col(0));
      g.fillStyle = halo;
      g.fillRect(0, 0, W, W);

      // outer tick ring
      const ticks = 96;
      for (let i = 0; i < ticks; i++) {
        const a = (i / ticks) * Math.PI * 2 - spin * 0.35;
        const major = i % 8 === 0;
        const wave = mode === 'speaking' || mode === 'listening' ? L * (0.5 + 0.5 * Math.sin(i * 0.9 + t * 9)) : 0;
        const len = R * ((major ? 0.075 : 0.04) + wave * 0.11);
        g.strokeStyle = col(major ? 0.75 : 0.28 + wave * 0.6);
        g.lineWidth = W * (major ? 0.0045 : 0.0028);
        g.beginPath();
        g.moveTo(c + Math.cos(a) * R, c + Math.sin(a) * R);
        g.lineTo(c + Math.cos(a) * (R + len), c + Math.sin(a) * (R + len));
        g.stroke();
      }

      // segmented rings
      const ring = (radius: number, segs: number, gap: number, rot: number, width: number, alpha: number) => {
        g.lineWidth = W * width;
        g.strokeStyle = col(alpha);
        for (let i = 0; i < segs; i++) {
          const a0 = rot + (i / segs) * Math.PI * 2 + gap / 2;
          g.beginPath();
          g.arc(c, c, radius, a0, a0 + (Math.PI * 2) / segs - gap);
          g.stroke();
        }
      };
      ring(R * 0.9, 3, 0.5, spin * 0.6, 0.012, 0.55 + energy * 0.3);
      ring(R * 0.8, 24, 0.09, -spin * 0.9, 0.006, 0.3);
      ring(R * 0.69, 2, 1.2, spin * 1.4, 0.004, 0.5);
      g.setLineDash([W * 0.004, W * 0.012]);
      ring(R * 0.6, 1, 0, -spin * 0.3, 0.0025, 0.35);
      g.setLineDash([]);

      // thinking: a bright arc sweeping round
      if (scan > 0.02) {
        const a = spin * 3.2;
        const sweep = g.createConicGradient(a, c, c);
        sweep.addColorStop(0, col2(0));
        sweep.addColorStop(0.2, col2(0.9 * scan));
        sweep.addColorStop(0.22, col2(0));
        sweep.addColorStop(1, col2(0));
        g.strokeStyle = sweep;
        g.lineWidth = W * 0.02;
        g.beginPath();
        g.arc(c, c, R * 0.9, 0, Math.PI * 2);
        g.stroke();
      }

      // voice: three living waveforms around the centre
      for (let k = 0; k < 3; k++) {
        g.beginPath();
        const base = R * (0.4 + k * 0.035);
        for (let i = 0; i <= 120; i++) {
          const a = (i / 120) * Math.PI * 2;
          const amp = 0.012 + L * 0.16 + energy * 0.012;
          const rr = base * (1 + amp * Math.sin(a * (5 + k * 2) + t * (2.2 + k) * (1 + energy)) + amp * 0.6 * Math.sin(a * (9 - k) - t * 3.1));
          const x = c + Math.cos(a) * rr, y = c + Math.sin(a) * rr;
          if (i) g.lineTo(x, y);
          else g.moveTo(x, y);
        }
        g.closePath();
        g.strokeStyle = k === 1 ? col2(0.35 + L * 0.5) : col(0.5 - k * 0.1 + L * 0.4);
        g.lineWidth = W * 0.004;
        g.stroke();
      }

      // plasma centre
      const breathe = 1 + Math.sin(t * 1.6) * 0.03 + L * 0.22;
      const core = g.createRadialGradient(c, c, 0, c, c, R * 0.36 * breathe);
      core.addColorStop(0, 'rgba(255,255,255,0.95)');
      core.addColorStop(0.18, col(0.95));
      core.addColorStop(0.55, col(0.28 + energy * 0.2));
      core.addColorStop(1, col(0));
      g.fillStyle = core;
      g.beginPath();
      g.arc(c, c, R * 0.36 * breathe, 0, Math.PI * 2);
      g.fill();
    };
    raf = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(raf);
  }, [size]);
  return <canvas ref={ref} className="core-canvas" style={{ width: size, height: size }} />;
}
