/** Data model shared by the brain and the interface. */

export type Memory = { id: string; text: string; kind: 'profile' | 'preference' | 'fact'; at: number; source: 'you' | 'jarvis'; pinned?: boolean; v?: number[] };
export type Task = { id: string; title: string; due?: number; done: boolean; doneAt?: number; at: number; notified?: boolean; notes?: string };
export type Note = { id: string; text: string; at: number };
export type Money = { id: string; name: string; amount: number; every: 'month' | 'year' | 'week' | 'once'; kind: 'bill' | 'income'; day?: number; at: number };
export type Timer = { id: string; label: string; endsAt: number; total: number };
export type ChatMsg = { id: string; role: 'user' | 'assistant'; text: string; at: number; tools?: ToolUse[]; device?: string };
export type ToolUse = { name: string; label: string; ok: boolean };

export type CalEvent = { id: string; title: string; start: number; end: number; allDay?: boolean; where?: string; calendar?: string };
export type Mail = { id: string; from: string; subject: string; at: number; preview?: string };
export type NowPlaying = { app: string; state: 'playing' | 'paused' | 'stopped'; title?: string; artist?: string; album?: string; art?: string; position?: number; duration?: number; volume?: number };
export type Weather = {
  place: string; at: number; temp: number; feels: number; code: number; label: string; wind: number; rain: number; isDay: boolean;
  days: { date: string; hi: number; lo: number; code: number; label: string; rain: number }[];
  hours: { t: number; temp: number; code: number; rain: number }[];
};
export type Vitals = { cpu: number; mem: number; battery?: number; charging?: boolean; uptime: number; host: string; disk?: number };
export type HomeAction = { id: string; name: string; icon?: string };

export type IntegrationState = 'ok' | 'off' | 'error' | 'setup';
export type Integrations = Record<'weather' | 'calendar' | 'mail' | 'music' | 'home' | 'system', { state: IntegrationState; detail?: string }>;

export type Settings = {
  userName: string;
  address: 'name' | 'sir' | 'boss' | 'maam';
  assistantName: string;
  place: string;
  lat?: number;
  lon?: number;
  units: 'c' | 'f';
  voice: string;
  speed: number;
  speak: boolean;
  wake: boolean;
  accent: string;
  asrModel: string;
  llmModel: string;
  calendarUrls: string[];
  useAppleCalendar: boolean;
  useAppleMail: boolean;
  musicApp: 'Spotify' | 'Music';
  homeShortcuts: string[];
  currency: string;
  onboarded: boolean;
  briefingHour: number;
};

export const DEFAULT_SETTINGS: Settings = {
  userName: '', address: 'name', assistantName: 'Jarvis', place: '', units: 'c', voice: 'bm_george', speed: 1.05, speak: true, wake: false,
  accent: 'arc', asrModel: 'whisper-base', llmModel: 'qwen-4b', calendarUrls: [], useAppleCalendar: true, useAppleMail: true, musicApp: 'Spotify',
  homeShortcuts: [], currency: '£', onboarded: false, briefingHour: 8,
};

export type ModelInfo = { id: string; kind: 'asr' | 'llm' | 'voice' | 'support'; name: string; blurb: string; bytes: number; installed: boolean; recommended?: boolean };
export type DownloadState = { id: string; received: number; total: number; error?: string; done?: boolean };
export type EngineStatus = { llm: 'missing' | 'idle' | 'loading' | 'ready' | 'error'; asr: 'missing' | 'idle' | 'loading' | 'ready' | 'error'; voice: 'missing' | 'idle' | 'loading' | 'ready' | 'error'; gpu?: string; ramGb: number; error?: string };

/** Everything the dashboard shows, in one snapshot. */
export type Snapshot = {
  settings: Settings;
  tasks: Task[];
  notes: Note[];
  money: Money[];
  memories: Omit<Memory, 'v'>[];
  timers: Timer[];
  chat: ChatMsg[];
  events: CalEvent[];
  mail: Mail[];
  unread: number;
  music: NowPlaying | null;
  weather: Weather | null;
  vitals: Vitals;
  home: HomeAction[];
  integrations: Integrations;
  models: ModelInfo[];
  downloads: DownloadState[];
  status: EngineStatus;
  needs: Need[];
  mac: boolean;
  version: string;
  links: { lan: string[]; token: string; port: number };
};

export type Need = { id: string; tone: 'alert' | 'warn' | 'info'; text: string; action?: { view: string } };

/** Server -> client pushes. */
export type Push =
  | { type: 'patch'; data: Partial<Snapshot> }
  | { type: 'say'; turn: string; delta?: string; done?: boolean; error?: string; heard?: string; tool?: ToolUse; state?: 'thinking' | 'speaking' | 'idle' }
  | { type: 'audio'; turn: string; seq: number; wav: string; text: string; last?: boolean }
  | { type: 'notify'; title: string; body: string; speak?: string };

export const VOICES: [string, string][] = [
  ['bm_george', 'George · British, measured'], ['bm_fable', 'Fable · British, warm'], ['bm_lewis', 'Lewis · British, deep'], ['bm_daniel', 'Daniel · British, bright'],
  ['bf_emma', 'Emma · British'], ['bf_isabella', 'Isabella · British'], ['am_michael', 'Michael · American'], ['am_fenrir', 'Fenrir · American, low'],
  ['af_heart', 'Heart · American'], ['af_bella', 'Bella · American'],
];

export const uid = (): string => Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4);
