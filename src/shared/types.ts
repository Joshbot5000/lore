/** Data model shared by the brain and the interface. */

export type Memory = { id: string; text: string; kind: 'profile' | 'preference' | 'fact'; at: number; source: 'you' | 'jarvis'; pinned?: boolean; v?: number[] };
export type Task = { id: string; title: string; due?: number; done: boolean; doneAt?: number; at: number; notified?: boolean; notes?: string };
export type Note = { id: string; text: string; at: number };
export type Money = { id: string; name: string; amount: number; every: 'month' | 'year' | 'week' | 'once'; kind: 'bill' | 'income'; day?: number; at: number };
/** A finished stretch of focused work. */
export type Focus = { id: string; subject: string; start: number; minutes: number };
export type FocusNow = { id: string; subject: string; start: number; endsAt: number; total: number };
/** A daily habit; `days` holds the local dates (YYYY-MM-DD) it was done. */
export type Habit = { id: string; name: string; days: string[]; at: number };
export type Countdown = { id: string; title: string; date: number };
/** A named set of commands run in order: saying the name runs them all. */
export type Routine = { id: string; name: string; steps: string[] };
/** A conversation recorded in Hark (read-only). */
export type Recording = { id: string; title: string; at: number; minutes: number; overview: string; open: number };
/** Revision material and the flashcard quiz in progress, as the dashboard sees them. */
export type StudyView = {
  source: string; syncedAt: number; error?: string; due: number; cards: number; notes: number;
  decks: { id: string; module: string; name: string; total: number; due: number; fresh: number; solid: number }[];
  quiz: null | { label: string; index: number; total: number; right: number; question: string; last?: { q: string; a: string; given: string; grade: 'right' | 'close' | 'wrong' } };
};
export type Timer = { id: string; label: string; endsAt: number; total: number };
export type ChatMsg = { id: string; role: 'user' | 'assistant'; text: string; at: number; tools?: ToolUse[]; device?: string; timing?: Timing };
/** How long each stage of a reply took, in milliseconds (shown in the log, for tuning). */
export type Timing = { asr?: number; think?: number; voice?: number; total?: number };
export type ToolUse = { name: string; label: string; ok: boolean };

export type CalEvent = { id: string; title: string; start: number; end: number; allDay?: boolean; where?: string; calendar?: string; source?: 'apple' | 'google' | 'feed' | 'jarvis' };
export type Mail = { id: string; from: string; subject: string; at: number; preview?: string; /** Opens this exact message (in Gmail or the Mail app). */ link?: string };
export type NowPlaying = { app: string; state: 'playing' | 'paused' | 'stopped'; title?: string; artist?: string; album?: string; art?: string; /** The track's address in Spotify. */ uri?: string; position?: number; duration?: number; volume?: number };
export type Weather = {
  place: string; at: number; temp: number; feels: number; code: number; label: string; wind: number; rain: number; isDay: boolean;
  days: { date: string; hi: number; lo: number; code: number; label: string; rain: number }[];
  hours: { t: number; temp: number; code: number; rain: number }[];
};
export type Vitals = { cpu: number; mem: number; battery?: number; charging?: boolean; uptime: number; host: string; disk?: number };
/** A tile on the Home card: a Shortcut, or a Home Assistant device or scene. */
export type HomeAction = { id: string; name: string; icon?: string; kind?: 'shortcut' | 'ha'; domain?: string; on?: boolean; detail?: string };
/** A mail account read over IMAP. The password is kept apart from settings and never sent to the interface. */
export type MailAccount = { id: string; label: string; host: string; port: number; user: string };

export type IntegrationState = 'ok' | 'off' | 'error' | 'setup';
export type Integrations = Record<'weather' | 'calendar' | 'mail' | 'music' | 'home' | 'system' | 'hark', { state: IntegrationState; detail?: string }>;

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
  /** Minutes of focused work to aim for each day. */
  focusGoal: number;
  /** Key combination that summons Jarvis from anywhere on the Mac. Empty turns it off. */
  hotkey: string;
  /** Read conversations recorded in Hark, so Jarvis can answer questions about them. */
  useHark: boolean;
  /** Home Assistant address, e.g. http://homeassistant.local:8123 (the access token is stored separately). */
  haUrl: string;
  /** Which Home Assistant devices appear on the Home card. Empty shows the first few lights, switches and scenes. */
  haEntities: string[];
  mailAccounts: MailAccount[];
  /** Where revision material lives: a public GitHub repository ("owner/name") or a folder on this computer. */
  studySource: string;
};

export const DEFAULT_SETTINGS: Settings = {
  userName: '', address: 'name', assistantName: 'Jarvis', place: '', units: 'c', voice: 'bm_george*0.55+bm_fable*0.45', speed: 1, speak: true, wake: false,
  accent: 'arc', asrModel: 'whisper-base', llmModel: 'qwen-4b', calendarUrls: [], useAppleCalendar: true, useAppleMail: true, musicApp: 'Spotify',
  homeShortcuts: [], currency: '£', onboarded: false, briefingHour: 8, focusGoal: 120, hotkey: 'Alt+Space', useHark: true, haUrl: '', haEntities: [], mailAccounts: [], studySource: 'Joshbot5000/Law-Conversion-Course',
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
  focus: Focus[];
  focusNow: FocusNow | null;
  habits: Habit[];
  countdowns: Countdown[];
  routines: Routine[];
  recordings: Recording[];
  study: StudyView;
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
  | { type: 'say'; turn: string; delta?: string; done?: boolean; error?: string; heard?: string; tool?: ToolUse; state?: 'thinking' | 'speaking' | 'idle'; timing?: Timing }
  | { type: 'audio'; turn: string; seq: number; wav: string; text: string; last?: boolean; gap?: number }
  | { type: 'notify'; title: string; body: string; speak?: string }
  | { type: 'summon' };

/** Built-in neural voices. Blends mix two voices (name*weight+name*weight), which smooths out each one's quirks. */
export const VOICES: [string, string][] = [
  ['bm_george*0.55+bm_fable*0.45', 'Jarvis · British, smooth blend'], ['bm_george', 'George · British, measured'], ['bm_fable', 'Fable · British, warm'],
  ['bm_george*0.6+am_michael*0.4', 'Atlas · mid-Atlantic, deeper'], ['bf_emma', 'Emma · British, clear'], ['bf_emma*0.6+af_heart*0.4', 'Ivy · British, soft blend'],
  ['af_heart', 'Heart · American, the most natural'], ['af_bella', 'Bella · American, lively'], ['af_heart*0.5+af_bella*0.5', 'Nova · American, warm blend'],
  ['am_michael', 'Michael · American'], ['am_fenrir', 'Fenrir · American, low'], ['bm_lewis', 'Lewis · British, deep'],
];
/** A voice installed on the Mac itself (System Settings → Accessibility → Spoken Content). */
export type MacVoice = { id: string; name: string; lang: string; quality: 'premium' | 'enhanced' | 'standard' };

export const uid = (): string => Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4);
