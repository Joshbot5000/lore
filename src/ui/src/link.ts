/** The line to the brain: one WebSocket, live state, and the stream of whatever Jarvis is saying. */
import { useSyncExternalStore } from 'react';
import type { Push, Snapshot, ToolUse } from '../../shared/types';

export type Turn = { id: string; heard: string; text: string; tools: ToolUse[]; state: 'thinking' | 'speaking' | 'idle'; done: boolean };
export type Mode = 'idle' | 'listening' | 'thinking' | 'speaking';
export type Toast = { id: number; text: string; tone: 'info' | 'alert' };

export type State = {
  online: boolean;
  everOnline: boolean;
  snap: Snapshot | null;
  turn: Turn | null;
  mode: Mode;
  handsFree: boolean;
  panel: null | 'settings' | 'mind' | 'pair' | 'log';
  tab: 'core' | 'today' | 'life';
  toasts: Toast[];
  micError: string;
};

let state: State = { online: false, everOnline: false, snap: null, turn: null, mode: 'idle', handsFree: false, panel: null, tab: 'core', toasts: [], micError: '' };
const subs = new Set<() => void>();
export const get = (): State => state;
export const set = (patch: Partial<State> | ((s: State) => Partial<State>)): void => {
  state = { ...state, ...(typeof patch === 'function' ? patch(state) : patch) };
  subs.forEach((f) => f());
};
export function useLink<T>(sel: (s: State) => T): T {
  return useSyncExternalStore((cb) => (subs.add(cb), () => subs.delete(cb)), () => sel(state));
}
/** Convenience: a slice of the snapshot (the snapshot is always present once the interface renders). */
export function useSnap<T>(sel: (s: Snapshot) => T): T {
  return useLink((s) => sel(s.snap!));
}

let toastId = 1;
export const toast = (text: string, tone: Toast['tone'] = 'info'): void => {
  const id = toastId++;
  set((s) => ({ toasts: [...s.toasts, { id, text, tone }] }));
  setTimeout(() => set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) })), 4200);
};

const params = new URLSearchParams(location.search);
const fromUrl = params.get('k');
if (fromUrl) {
  localStorage.setItem('jarvis.k', fromUrl);
  // Keep the pairing key out of the address bar and browser history.
  params.delete('k');
  history.replaceState(null, '', location.pathname + (params.toString() ? `?${params}` : ''));
}
export const token = (): string => localStorage.getItem('jarvis.k') ?? '';
export const isPhone = /iPhone|iPad|Android/i.test(navigator.userAgent) || (navigator.maxTouchPoints > 1 && window.innerWidth < 900);
const device = isPhone ? 'phone' : 'mac';

let ws: WebSocket | null = null;
let seq = 1;
let retry = 600;
const waits = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void }>();
const pushHandlers = new Set<(p: Push) => void>();
export const onPush = (fn: (p: Push) => void): (() => void) => (pushHandlers.add(fn), () => pushHandlers.delete(fn));

export function call<T = unknown>(method: string, params: Record<string, unknown> = {}): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    if (!ws || ws.readyState !== 1) return reject(new Error("I can't reach your Mac right now."));
    const id = seq++;
    waits.set(id, { resolve, reject });
    ws.send(JSON.stringify({ id, method, params }));
  });
}
/** Fire an action; show any failure as a toast. */
export const act = (method: string, params: Record<string, unknown> = {}): void => void call(method, params).catch((e: Error) => toast(e.message, 'alert'));

export function connect(): void {
  const port = params.get('port');
  const host = port ? `${location.hostname}:${port}` : location.host;
  ws = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${host}/ws?k=${encodeURIComponent(token())}&d=${device}`);
  ws.onopen = () => {
    retry = 600;
    set({ online: true, everOnline: true });
  };
  ws.onclose = () => {
    set({ online: false });
    for (const w of waits.values()) w.reject(new Error("I lost the connection to your Mac."));
    waits.clear();
    setTimeout(connect, retry);
    retry = Math.min(retry * 1.6, 8000);
  };
  ws.onmessage = (ev) => {
    const msg = JSON.parse(String(ev.data));
    if (msg.id !== undefined && waits.has(msg.id)) {
      const w = waits.get(msg.id)!;
      waits.delete(msg.id);
      return msg.error ? w.reject(new Error(msg.error)) : w.resolve(msg.result);
    }
    if (msg.type === 'snapshot') {
      set({ snap: msg.data });
      try {
        localStorage.setItem('jarvis.snap', JSON.stringify({ ...msg.data, chat: msg.data.chat.slice(-12) }));
      } catch {
        /* storage full or blocked: the cache is only a nicety */
      }
      return;
    }
    const p = msg as Push;
    if (p.type === 'patch') set((s) => (s.snap ? { snap: { ...s.snap, ...p.data } } : {}));
    else if (p.type === 'say') {
      set((s) => {
        const cur: Turn = s.turn && s.turn.id === p.turn ? s.turn : { id: p.turn, heard: '', text: '', tools: [], state: 'thinking', done: false };
        const turn: Turn = { ...cur, heard: p.heard ?? cur.heard, text: cur.text + (p.delta ?? ''), tools: p.tool ? [...cur.tools, p.tool] : cur.tools, state: p.state ?? cur.state, done: cur.done || !!p.done };
        // "Speaking" on screen is driven by the audio player when voice is on; text-only replies settle here.
        const mode: Mode = p.done ? (s.mode === 'thinking' ? 'idle' : s.mode) : p.state === 'thinking' ? 'thinking' : s.mode === 'listening' ? s.mode : turn.text ? (s.mode === 'thinking' ? 'speaking' : s.mode) : s.mode;
        return { turn, mode };
      });
    } else if (p.type === 'notify') toast(`${p.title}: ${p.body}`, 'alert');
    pushHandlers.forEach((f) => f(p));
  };
}

/** Show the last known dashboard instantly (and when the Mac is unreachable) while the live link comes up. */
export function restoreCache(): void {
  try {
    const cached = localStorage.getItem('jarvis.snap');
    if (cached) set({ snap: JSON.parse(cached) });
  } catch {
    /* no cache */
  }
}
