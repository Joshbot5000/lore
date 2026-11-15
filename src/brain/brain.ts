/**
 * The brain: state, integrations, the agent loop and voice. Plain Node, no Electron, so it can
 * run headless and be tested end to end.
 */
import { EventEmitter } from 'node:events';
import os from 'node:os';
import path from 'node:path';
import { Engine, type Fork } from './engines';
import { Store } from './store';
import { Models, entry, recommendedLlm } from './models';
import type { MacBridge } from './mac';
import { forecast, geocode, weatherSentence, type Fetch } from './weather';
import { expand, parseIcs } from './ics';
import { musicRequest, readPage, spotifyUri, webSearch, wikipedia } from './web';
import { describeWhen, eventOver, parseWhen, speakable, takeSentences } from '../shared/when';
import { dayKey, daysUntil, doneToday, focusStats, inDays, isFocusStop, matchCountdown, matchHabit, parseFocus, spokenMinutes, streak, tidy } from './life';
import { aboutRecordings, defaultHarkDir, harkContext, namesRecording, readHark, type HarkRec } from './hark';
import { HomeAssistant, isOn, matchEntities, parseHomeCommand, tapService, type HaEntity } from './ha';
import { MAIL_PRESETS, fetchUnread } from './imap';
import fs from 'node:fs';
import { contentWords, deckStats, fetchRepo, grade, isDue, isRepo, looksLegal, matchDecks, pickCards, readFolder, record, studyContext, vocabulary, type Card, type Library } from './study';
import { OPENAI_VOICES, elevenSpeak, elevenVoices, openaiCheck, openaiSpeak, type CloudVoice } from './cloudvoice';
import { DEFAULT_SETTINGS, uid } from '../shared/types';
import type { Focus, FocusNow, Habit, Recording, Routine } from '../shared/types';
import type { CalEvent, ChatMsg, EngineStatus, HomeAction, Integrations, Mail, Memory, Need, NowPlaying, Push, Settings, Snapshot, Task, Timer, ToolUse, Vitals, Weather } from '../shared/types';

export type BrainOptions = {
  dataDir: string;
  modelsDir: string;
  fork: Fork;
  forkLlm: Fork;
  fetch: Fetch;
  mac: MacBridge;
  version: string;
  port: number;
  notify?: (title: string, body: string) => void;
  /** Where Hark keeps its library, if not in the usual place. */
  harkDir?: string;
};

type LlmStats = { streamId: string; read: number; wrote: number; firstMs: number; ms: number };

type Tool = {
  name: string;
  description: string;
  params?: Record<string, unknown>;
  label: (args: any) => string;
  run: (args: any) => Promise<string>;
};

const dot = (a: number[], b: number[]): number => {
  let s = 0;
  for (let i = 0; i < Math.min(a.length, b.length); i++) s += a[i] * b[i];
  return s;
};
const str = (properties: Record<string, string>, required: string[] = Object.keys(properties)) => ({
  type: 'object',
  properties: Object.fromEntries(Object.entries(properties).map(([k, description]) => [k, { type: 'string', description }])),
  required,
});

const COMMAND = /^(?:please |then |also )?(open|launch|set|start|play|pause|resume|stop|skip|turn|remind|add|put|run|mute|unmute|lock|note|make a note|take a note|remember|track|schedule|book|close|switch|search|look up|tell me|what|who|when|where|how)\b/i;

const ACTION = /^(open|launch|set|start|play|pause|resume|stop|skip|turn|remind|add|put|run|mute|unmute|lock|note|make|take|remember|forget|track|schedule|book|close|switch|mark|complete|finish|tick|delete|remove|cancel|create|save|write|dim|lower|raise|increase|decrease|change|show me|search|look up|google|find)\b/i;

/** Is the user asking for something to be done (as opposed to asking a question or chatting)? */
export function wantsAction(text: string): boolean {
  const t = text.trim().replace(/^(hey |ok |okay )?jarvis[,.!]?\s*/i, '').replace(/^(please|can you|could you|would you|will you|i need you to|i want you to|i'd like you to|let's|go ahead and)\s+/i, '').replace(/^please\s+/i, '');
  return ACTION.test(t) || /\b(i've|i have|i'm|i am|i) (just )?(finished|done|completed)\b/i.test(t) || /\bremind me\b/i.test(t);
}

/** Split "do X and do Y" into its two requests, but leave "bread and butter" alone. */
export function splitCommands(text: string): string[] {
  const parts = text.split(/\s*(?:,\s*(?:and\s+)?(?:then\s+)?|\s+and\s+(?:then\s+)?|\s+then\s+|;\s*)(?=\S)/i);
  if (parts.length < 2 || parts.length > 4) return [text];
  // Every piece must itself read as a request, and the first must be an action (not a question about two things).
  if (!parts.every((p) => COMMAND.test(p.trim())) || /^(what|who|when|where|how|tell me)\b/i.test(parts[0].trim())) return [text];
  return parts.map((p) => p.trim().replace(/[.!]+$/, ''));
}

/** Which parts of Jarvis's view of the day a question could draw on. */
export function relevant(q: string): Record<'weather' | 'calendar' | 'tasks' | 'mail' | 'home' | 'music' | 'timers' | 'money' | 'notes' | 'focus' | 'habits' | 'countdowns', boolean> {
  const t = q.toLowerCase();
  const broad = /\b(plan|should i|what should|advice|suggest|recommend|my day|this (evening|morning|afternoon|week|weekend)|tonight|today|tomorrow|weekend|free time|busy|priorit|focus on|catch me up|what.s (up|going on|happening)|anything (i|else)|forget(ting)? anything)\b/.test(t);
  return {
    weather: broad || /\b(weather|rain|cold|warm|hot|sunny|coat|umbrella|outside|walk|run|jog|cycle|forecast)\b/.test(t),
    calendar: broad || /\b(calendar|schedule|meeting|event|appointment|free|when|seminar|lecture|deadline|diary|booked)\b/.test(t),
    tasks: broad || /\b(task|to-?do|list|remind|due|deadline|work on|need to|outstanding|overdue)\b/.test(t),
    mail: /\b(e-?mails?|mail|inbox|messages?|wrote|sent me|reply|replied)\b/.test(t),
    home: /\b(lights?|heating|home|house|lamp|switch|thermostat|temperature)\b/.test(t),
    music: /\b(music|song|playing|listen|track|artist|album|spotify|tune)\b/.test(t),
    timers: /\btimers?\b/.test(t),
    money: /\b(money|bills?|spending|subscriptions?|afford|budget|pay|cost|income|salary|rent)\b|[£$]/.test(t),
    notes: /\b(notes?|wrote down|jotted|notebook)\b/.test(t),
    focus: /\b(focus|focused|study|studied|revis\w*|productiv\w*|streak|goal|worked)\b/.test(t),
    habits: /\b(habits?|streak|routine)\b/.test(t),
    countdowns: /\b(countdown|exam|until|how (long|many days)|deadline|days left)\b/.test(t),
  };
}

/** The few tools a request could need, judged from its wording. A small model handed every tool misuses them. */
const TOOL_CUES: [string, RegExp][] = [
  ['remember', /\bremember\b/i], ['forget', /\bforget\b/i], ['add_task', /\b(remind|to-?do|list|task)\b/i], ['complete_task', /\b(done|finished|completed|tick|mark|complete)\b/i],
  ['add_note', /\b(note|write (that |this )?down|jot)\b/i], ['set_timer', /\btimer\b/i], ['add_event', /\b(schedule|book|calendar|appointment|meeting|diary)\b/i],
  ['music', /\b(music|song|play|pause|skip|spotify|track|album|playlist)\b/i], ['run_shortcut', /\b(shortcut|scene|run)\b/i], ['open_app_or_website', /\b(open|launch|go to|website|app)\b/i],
  ['computer', /\b(volume|mute|unmute|lock|dark mode|light mode|louder|quieter)\b/i], ['get_weather', /\b(weather|forecast)\b.*\b(in|at|for)\b/i], ['add_money', /\b(track|bill|subscription|income|salary)\b|[£$]\d/i],
];
export const toolsFor = (text: string, acting: boolean, outward: boolean): string[] => [
  ...(acting ? TOOL_CUES.filter(([, re]) => re.test(text)).map(([name]) => name).slice(0, 3) : /\b(weather|forecast)\b.*\b(in|at|for) [A-Z]/.test(text) ? ['get_weather'] : []),
  ...(outward ? ['web_search'] : []),
];

/** What should be shown and said of a model's raw output so far: its private reasoning is dropped. */
export function visibleText(raw: string): string {
  return raw.replace(/<think>[\s\S]*?<\/think>/g, '').replace(/<think>[\s\S]*$/, '').replace(/<\/?(?:t(?:h(?:i(?:n(?:k)?)?)?)?)?$/, '').replace(/^\s+/, '');
}

/** Cut the silence a voice pads its clips with (16-bit samples), leaving a few milliseconds and a soft edge. */
export function trimPcm(pcm: Buffer, rate = 24000): Buffer {
  const n = pcm.length >> 1, quiet = 200, keep = Math.round(rate * 0.012);
  let a = 0, b = n - 1;
  while (a < b && Math.abs(pcm.readInt16LE(a * 2)) < quiet) a++;
  while (b > a && Math.abs(pcm.readInt16LE(b * 2)) < quiet) b--;
  a = Math.max(0, a - keep);
  b = Math.min(n - 1, b + keep * 3);
  const out = Buffer.from(pcm.subarray(a * 2, (b + 1) * 2));
  const len = out.length >> 1, fade = Math.min(Math.round(rate * 0.006), len >> 1);
  for (let i = 0; i < fade; i++) {
    out.writeInt16LE(Math.round(out.readInt16LE(i * 2) * (i / fade)), i * 2);
    out.writeInt16LE(Math.round(out.readInt16LE((len - 1 - i) * 2) * (i / fade)), (len - 1 - i) * 2);
  }
  return out;
}

export class Brain extends EventEmitter {
  readonly store: Store;
  readonly models: Models;
  private speech: Engine;
  private voice: Engine;
  private llm: Engine;
  private status: EngineStatus;
  private llmInfo: { gpu: string; contextSize: number } | null = null;
  private llmLoaded = '';
  private asrLoaded = '';
  private voiceReady = false;

  private weather: Weather | null = null;
  private events: CalEvent[] = [];
  private mail: Mail[] = [];
  private unread = 0;
  private music: NowPlaying | null = null;
  private home: HomeAction[] = [];
  private timers: Timer[] = [];
  private vitals: Vitals = { cpu: 0, mem: 0, uptime: 0, host: os.hostname().replace(/\.local$/, '') };
  private integrations: Integrations = {
    weather: { state: 'setup' }, calendar: { state: 'off' }, mail: { state: 'off' }, music: { state: 'off' }, home: { state: 'off' }, system: { state: 'ok' }, hark: { state: 'off' },
  };
  private llmStats: LlmStats[] = [];
  private learning = '';
  private lastAsr: { ms: number; secs: number } | null = null;
  private focusNow: FocusNow | null = null;
  private library: Library = { decks: [], notes: [], syncedAt: 0, source: '' };
  private vocab = new Set<string>();
  private studyError = '';
  private quiz: { label: string; cards: Card[]; i: number; right: number; missed: Card[]; startedAt: number; last?: { q: string; a: string; given: string; grade: 'right' | 'close' | 'wrong'; key: string } } | null = null;
  private shortcutTiles: HomeAction[] = [];
  private haEntities: HaEntity[] = [];
  private haProblem = '';
  private recordings: HarkRec[] = [];
  private lastCpu = os.cpus().map((c) => c.times);
  private turnSeq = 0;
  private activeTurn = '';
  private intervals: ReturnType<typeof setInterval>[] = [];
  private announced = new Set<string>();
  readonly ramGb = Math.round(os.totalmem() / 2 ** 30);

  constructor(private o: BrainOptions) {
    super();
    this.store = new Store(o.dataDir);
    this.models = new Models(o.modelsDir, o.fetch as never);
    // The first voice (George at 1.05x) was replaced by a smoother blend at a natural pace: move anyone still on the old default.
    if (this.store.get('settings').voice === 'bm_george' && this.store.get('settings').speed === 1.05) this.patchSettings({ voice: DEFAULT_SETTINGS.voice, speed: DEFAULT_SETTINGS.speed }, true);
    if (!this.store.get('settings').onboarded && this.store.get('settings').llmModel === 'qwen-4b') this.patchSettings({ llmModel: recommendedLlm(this.ramGb) }, true);
    this.status = { llm: 'missing', asr: 'missing', voice: 'missing', ramGb: this.ramGb };

    this.speech = new Engine(o.fork, 'speech.js', 'speech');
    this.speech.onStart = async () => {
      await this.speech.raw('init', { modelsDir: o.modelsDir });
      this.asrLoaded = '';
    };
    this.voice = new Engine(o.fork, 'tts.js', 'voice');
    this.voice.onStart = async () => {
      this.voiceReady = false;
    };
    this.llm = new Engine(o.forkLlm, 'llm.js', 'mind');
    this.llm.on('stats', (st: LlmStats) => {
      this.llmStats = [...this.llmStats.slice(-11), st];
      if (process.env.JARVIS_DEBUG) console.log('[llm]', JSON.stringify(st));
    });
    this.llm.on('exit', () => {
      this.llmLoaded = '';
      this.llmInfo = null;
      this.refreshStatus({ llm: 'idle' });
    });
    this.speech.on('exit', () => this.refreshStatus({ asr: 'idle' }));
    this.voice.on('exit', () => this.refreshStatus({ voice: 'idle' }));

    this.models.on('progress', () => this.push({ type: 'patch', data: { downloads: this.models.downloads() } }));
    this.models.on('installed', (id: string) => {
      this.push({ type: 'patch', data: { models: this.models.list(this.ramGb), downloads: this.models.downloads() } });
      this.refreshStatus();
      const s = this.settings;
      if (id === s.llmModel) void this.ensureLlm().catch(() => undefined);
      if (id === 'voice') void this.ensureVoice().catch(() => undefined);
      if (id === s.asrModel) void this.ensureAsr().catch(() => undefined);
    });
    this.models.on('failed', () => this.push({ type: 'patch', data: { models: this.models.list(this.ramGb), downloads: this.models.downloads() } }));
  }

  // ------------------------------------------------------------------ lifecycle

  start(): void {
    this.refreshStatus();
    // An update can change a model (the voice moved to its full-quality version): fetch it without being asked.
    if (this.settings.onboarded && !this.models.installed('voice') && this.models.installed(this.settings.asrModel)) void this.models.download('voice');
    void this.ensureAsr().catch(() => undefined);
    // The built-in voice takes a good deal of memory: only load it up front if it is the one in use.
    if (!/^(mac|eleven|openai):/.test(this.settings.voice)) void this.ensureVoice().catch(() => undefined);
    setTimeout(() => void this.ensureLlm().catch(() => undefined), 1500);
    const every = (ms: number, fn: () => unknown) => {
      this.intervals.push(setInterval(() => void fn(), ms));
      void fn();
    };
    every(15 * 60e3, () => this.refreshWeather());
    every(2500, () => this.refreshMusic());
    every(120e3, () => this.refreshMail());
    every(5 * 60e3, () => this.refreshCalendar());
    every(10 * 60e3, () => this.refreshHome());
    every(5e3, () => this.refreshVitals());
    every(120e3, () => this.refreshHark());
    every(15e3, () => this.refreshHa());
    this.loadLibrary();
    every(30 * 60e3, () => this.syncStudy());
    every(1e3, () => this.tick());
  }

  stop(): void {
    this.intervals.forEach(clearInterval);
    this.store.flush();
    this.speech.stop();
    this.voice.stop();
    this.llm.stop();
  }

  get settings(): Settings {
    return this.store.get('settings');
  }

  private push(p: Push): void {
    this.emit('push', p);
  }

  private patch(data: Partial<Snapshot>): void {
    this.push({ type: 'patch', data });
  }

  private refreshStatus(patch: Partial<EngineStatus> = {}): void {
    Object.assign(this.status, patch);
    const s = this.settings;
    const sync = (key: 'llm' | 'asr' | 'voice', id: string) => {
      if (!this.models.installed(id)) this.status[key] = 'missing';
      else if (this.status[key] === 'missing') this.status[key] = 'idle';
    };
    sync('llm', s.llmModel);
    sync('asr', s.asrModel);
    sync('voice', 'voice');
    this.patch({ status: { ...this.status }, needs: this.needs() });
  }

  private async ensureAsr(): Promise<void> {
    const id = this.settings.asrModel;
    if (!this.models.installed(id)) throw new Error('The speech model has not been downloaded yet.');
    if (this.asrLoaded === id && this.speech.running) return;
    this.refreshStatus({ asr: 'loading' });
    try {
      await this.speech.call('loadAsr', { repo: entry(id).repo });
      this.asrLoaded = id;
      this.refreshStatus({ asr: 'ready' });
    } catch (err) {
      this.refreshStatus({ asr: 'error', error: String((err as Error).message) });
      throw err;
    }
  }

  private async ensureVoice(): Promise<void> {
    if (!this.models.installed('voice')) throw new Error('The voice has not been downloaded yet.');
    if (this.voiceReady && this.voice.running) return;
    this.refreshStatus({ voice: 'loading' });
    try {
      await this.voice.call('init', { modelsDir: this.o.modelsDir });
      this.voiceReady = true;
      this.refreshStatus({ voice: 'ready' });
    } catch (err) {
      this.refreshStatus({ voice: 'error', error: String((err as Error).message) });
      throw err;
    }
  }

  private async ensureLlm(): Promise<{ gpu: string; contextSize: number }> {
    const id = this.settings.llmModel;
    if (!this.models.installed(id)) throw new Error('The AI model has not been downloaded yet. Open Settings to download it.');
    if (this.llmLoaded === id && this.llm.running && this.llmInfo) return this.llmInfo;
    this.refreshStatus({ llm: 'loading' });
    try {
      this.llmInfo = await this.llm.call('load', { modelPath: process.env.JARVIS_LLM_FILE || this.models.llmPath(id), contextSize: this.ramGb >= 14 ? 8192 : this.ramGb >= 10 ? 6144 : 4096 });
      this.llmLoaded = id;
      this.refreshStatus({ llm: 'ready', gpu: this.llmInfo!.gpu });
      // Read the standing instructions once now, so the first real question does not pay for it.
      void this.llm.call('generate', { streamId: `warm${++this.turnSeq}`, system: this.persona(), prompt: 'Hello', maxTokens: 1, temperature: 0 }).catch(() => undefined);
      return this.llmInfo!;
    } catch (err) {
      this.refreshStatus({ llm: 'error', error: String((err as Error).message) });
      throw err;
    }
  }

  // ------------------------------------------------------------------ integrations

  private setIntegration(key: keyof Integrations, state: Integrations[keyof Integrations]['state'], detail?: string): void {
    const cur = this.integrations[key];
    if (cur.state === state && cur.detail === detail) return;
    this.integrations = { ...this.integrations, [key]: { state, detail } };
    this.patch({ integrations: this.integrations, needs: this.needs() });
  }

  async refreshWeather(): Promise<void> {
    const s = this.settings;
    if (!s.place) return this.setIntegration('weather', 'setup', 'Tell me where you are');
    try {
      if (s.lat === undefined || s.lon === undefined) {
        const g = await geocode(this.o.fetch, s.place);
        if (!g) return this.setIntegration('weather', 'error', `Couldn't find “${s.place}”`);
        this.patchSettings({ lat: g.lat, lon: g.lon, place: g.name }, true);
      }
      this.weather = await forecast(this.o.fetch, this.settings.lat!, this.settings.lon!, this.settings.place, s.units);
      this.setIntegration('weather', 'ok');
      this.patch({ weather: this.weather });
    } catch (err) {
      const msg = (err as Error).message;
      this.setIntegration('weather', 'error', /fetch failed|ENOTFOUND|network|ERR_/i.test(msg) ? "can't reach the weather service (offline?)" : msg);
    }
  }

  async refreshMusic(): Promise<void> {
    try {
      const m = await this.o.mac.music(this.settings.musicApp);
      this.setIntegration('music', m ? 'ok' : 'off', m ? undefined : `${this.settings.musicApp} isn't open`);
      const changed = JSON.stringify({ ...m, position: 0 }) !== JSON.stringify({ ...this.music, position: 0 }) || Math.abs((m?.position ?? 0) - (this.music?.position ?? 0)) > 6;
      this.music = m;
      if (changed) this.patch({ music: m });
    } catch (err) {
      this.setIntegration('music', 'error', (err as Error).message);
    }
  }

  async refreshMail(): Promise<void> {
    const accounts = this.settings.mailAccounts;
    if (!this.settings.useAppleMail && !accounts.length) return this.setIntegration('mail', 'off', 'Add a mail account in Settings');
    const items: Mail[] = [];
    let unread = 0, ok = false, problem = '';
    if (this.settings.useAppleMail) {
      try {
        const m = await this.o.mac.mail();
        if (m) (items.push(...m.items), (unread += m.unread), (ok = true));
      } catch (err) {
        problem = (err as Error).message;
      }
    }
    const passwords = this.store.get('secrets').mail ?? {};
    for (const a of accounts) {
      try {
        const m = await fetchUnread({ ...a, pass: passwords[a.id] ?? '' });
        items.push(...m.items);
        unread += m.unread;
        ok = true;
      } catch (err) {
        problem = `${a.label}: ${(err as Error).message}`;
      }
    }
    if (!ok && !problem) return this.setIntegration('mail', 'off', accounts.length ? undefined : 'Open the Mail app, or add a mail account in Settings');
    this.mail = items.sort((a, b) => b.at - a.at).slice(0, 12);
    this.unread = unread;
    // One account failing should be visible even while another works.
    this.setIntegration('mail', problem ? 'error' : 'ok', problem || undefined);
    this.patch({ mail: this.mail, unread: this.unread, needs: this.needs() });
  }

  async refreshCalendar(): Promise<void> {
    const s = this.settings;
    const from = new Date().setHours(0, 0, 0, 0), to = Date.now() + 14 * 864e5;
    const all: CalEvent[] = this.store.get('events').filter((e) => e.end >= from && e.start <= to).map((e) => ({ ...e, calendar: 'Jarvis' }));
    let ok = false, problem = '';
    for (const url of s.calendarUrls) {
      try {
        // A feed that never answers must not leave yesterday's events on screen.
        const ctrl = new AbortController();
        const timer = setTimeout(() => ctrl.abort(), 20000);
        const res = await this.o.fetch(url.replace(/^webcal:/, 'https:'), { signal: ctrl.signal, cache: 'no-store' } as never).finally(() => clearTimeout(timer));
        if (!res.ok) throw new Error(`Calendar feed returned ${res.status}`);
        all.push(...expand(parseIcs(await res.text()), from, to, 'Calendar'));
        ok = true;
      } catch (err) {
        problem = (err as Error).message;
      }
    }
    if (s.useAppleCalendar) {
      try {
        const evs = await this.o.mac.calendar(14);
        if (evs) {
          all.push(...evs);
          ok = true;
        }
      } catch (err) {
        problem ||= (err as Error).message;
      }
    }
    const seen = new Set<string>();
    this.events = all.sort((a, b) => a.start - b.start).filter((e) => {
      const k = `${e.title}|${e.start}`;
      return seen.has(k) || eventOver(e) ? false : (seen.add(k), true);
    });
    this.calendarAt = Date.now();
    this.setIntegration('calendar', ok ? 'ok' : problem ? 'error' : all.length ? 'ok' : 'setup', ok ? undefined : problem || 'Add a calendar in Settings');
    this.patch({ events: this.events, needs: this.needs() });
  }

  async refreshHome(): Promise<void> {
    try {
      const all = await this.o.mac.shortcuts();
      const chosen = this.settings.homeShortcuts;
      this.shortcutTiles = (chosen.length ? all.filter((n) => chosen.includes(n)) : all.slice(0, this.settings.haUrl ? 4 : 8)).map((name) => ({ id: name, name, kind: 'shortcut' as const }));
      this.home = [...this.haTiles(), ...this.shortcutTiles];
      if (!this.settings.haUrl) this.setIntegration('home', all.length ? 'ok' : 'setup', all.length ? undefined : 'Create a shortcut in the Shortcuts app, or connect Home Assistant in Settings');
      this.patch({ home: this.home });
    } catch (err) {
      if (!this.settings.haUrl) this.setIntegration('home', 'error', (err as Error).message);
    }
  }

  private haClient(): HomeAssistant | null {
    const url = this.settings.haUrl.trim(), token = this.store.get('secrets').haToken;
    return url && token ? new HomeAssistant(this.o.fetch, url, token) : null;
  }

  private haTiles(): HomeAction[] {
    const chosen = this.settings.haEntities;
    const pick = chosen.length
      ? chosen.map((id) => this.haEntities.find((e) => e.id === id)).filter((e): e is HaEntity => !!e)
      : this.haEntities.filter((e) => ['light', 'switch', 'scene', 'climate', 'cover'].includes(e.domain)).slice(0, 8);
    return pick.map((e) => ({
      id: e.id, name: e.name, kind: 'ha' as const, domain: e.domain, on: e.domain === 'scene' || e.domain === 'script' ? undefined : isOn(e),
      detail: e.domain === 'climate' ? (e.current !== undefined ? `${Math.round(e.current * 10) / 10}°` : undefined) : e.domain === 'light' && isOn(e) && e.brightness ? `${e.brightness}%` : undefined,
    }));
  }

  /** Read the state of the home from Home Assistant. */
  async refreshHa(): Promise<void> {
    const ha = this.haClient();
    if (!ha) {
      if (this.haEntities.length) ((this.haEntities = []), (this.home = this.shortcutTiles), this.patch({ home: this.home }));
      return;
    }
    try {
      this.haEntities = await ha.states();
      this.haProblem = '';
      this.setIntegration('home', 'ok', `Home Assistant: ${this.haEntities.filter((e) => e.domain !== 'sensor').length} devices`);
    } catch (err) {
      this.haProblem = (err as Error).message;
      this.setIntegration('home', 'error', this.haProblem);
    }
    const next = [...this.haTiles(), ...this.shortcutTiles];
    if (JSON.stringify(next) !== JSON.stringify(this.home)) ((this.home = next), this.patch({ home: next }));
  }

  /** Carry out a home command, then look again so the dashboard shows the new state. */
  private async haCall(targets: HaEntity[], domain: string, service: string, data: Record<string, unknown> = {}): Promise<void> {
    const ha = this.haClient();
    if (!ha) throw new Error('Home Assistant is not connected');
    await ha.call(domain, service, { entity_id: targets.map((t) => t.id), ...data });
    setTimeout(() => void this.refreshHa(), 700);
    setTimeout(() => void this.refreshHa(), 2500);
  }

  private get harkDir(): string {
    return this.o.harkDir || process.env.JARVIS_HARK_DIR || defaultHarkDir();
  }

  /** Look at Hark's library (read-only), so questions about recorded conversations can be answered. */
  refreshHark(): void {
    if (!this.settings.useHark) {
      this.recordings = [];
      this.patch({ recordings: [] });
      return this.setIntegration('hark', 'off', 'Turned off in Settings');
    }
    const recs = readHark(this.harkDir);
    if (!recs) {
      this.recordings = [];
      return this.setIntegration('hark', 'off', 'Hark is not installed on this computer');
    }
    const changed = JSON.stringify(recs) !== JSON.stringify(this.recordings);
    this.recordings = recs;
    this.setIntegration('hark', 'ok', `${recs.length} recording${recs.length === 1 ? '' : 's'}`);
    if (changed) this.patch({ recordings: this.recordingList(), needs: this.needs() });
  }

  /** Is this question about something recorded in Hark? */
  private aboutHark(q: string): boolean {
    return this.recordings.length > 0 && (aboutRecordings(q) || namesRecording(this.recordings, q));
  }

  private recordingList(): Recording[] {
    return this.recordings.slice(0, 8).map((r) => ({ id: r.id, title: r.title, at: r.at, minutes: r.minutes, overview: r.overview, open: r.actions.filter((a) => !a.done).length }));
  }

  // ------------------------------------------------------------------ focus, habits, countdowns

  private recentFocus(): Focus[] {
    const from = Date.now() - 30 * 864e5;
    return this.store.get('focus').filter((f) => f.start >= from);
  }

  startFocus(minutes: number, subject = ''): FocusNow {
    if (this.focusNow) this.endFocus();
    const now = Date.now();
    const ms = Math.max(0.01, Math.min(240, Number(minutes) || 25)) * 6e4;
    this.focusNow = { id: uid(), subject: subject.trim(), start: now, endsAt: now + ms, total: ms };
    this.patch({ focusNow: this.focusNow });
    return this.focusNow;
  }

  /** Stop the running session and log the time actually spent. Returns a sentence about it. */
  endFocus(): string {
    const f = this.focusNow;
    if (!f) return 'No focus session is running.';
    this.focusNow = null;
    const mins = Math.round((Math.min(Date.now(), f.endsAt) - f.start) / 6e4);
    if (mins >= 1) {
      this.store.get('focus').push({ id: f.id, subject: f.subject, start: f.start, minutes: mins });
      this.store.touch('focus');
    }
    this.patch({ focusNow: null, focus: this.recentFocus() });
    if (mins < 1) return 'Session cancelled, nothing logged.';
    const today = focusStats(this.store.get('focus')).today;
    return `${spokenMinutes(mins)}${f.subject ? ` on ${f.subject}` : ''} logged${today > mins ? `, ${spokenMinutes(today)} today in all` : ''}.`;
  }

  private habitsText(): string {
    const habits = this.store.get('habits');
    if (!habits.length) return 'You are not tracking any habits yet. Say "add a habit" and its name to start one.';
    const left = habits.filter((h) => !doneToday(h));
    const best = [...habits].sort((a, b) => streak(b.days) - streak(a.days))[0];
    const lead = left.length ? `${habits.length - left.length} of ${habits.length} done today. Still to do: ${left.map((h) => h.name.toLowerCase()).join(', ')}.` : `All ${habits.length} habit${habits.length === 1 ? '' : 's'} done today.`;
    return streak(best.days) > 1 ? `${lead} Your longest streak is ${best.name.toLowerCase()}, at ${streak(best.days)} days.` : lead;
  }

  private setHabit(h: Habit, done: boolean): void {
    const k = dayKey();
    if (done && !h.days.includes(k)) h.days.push(k);
    if (!done) h.days = h.days.filter((d) => d !== k);
    if (h.days.length > 800) h.days = h.days.slice(-800);
    this.store.touch('habits');
    this.patch({ habits: this.store.get('habits'), needs: this.needs() });
  }

  private matchRoutine(text: string): Routine | undefined {
    const t = text.toLowerCase().replace(/[.!?,]/g, '').replace(new RegExp(`^(hey |ok |okay )?${this.settings.assistantName.toLowerCase()}\\s*`), '').replace(new RegExp(`\\s*${this.settings.assistantName.toLowerCase()}$`), '')
      .replace(/^(please )?(run|start|do|begin|play) (my |the )?/, '').replace(/ routine$/, '').trim();
    return t ? this.store.get('routines').find((r) => r.name.toLowerCase().replace(/[.!?,]/g, '').trim() === t && r.steps.length > 0) : undefined;
  }

  /** The evening review: what got done today and what tomorrow holds. Built from real data. */
  reviewText(): string {
    const now = Date.now();
    const start = new Date().setHours(0, 0, 0, 0);
    const P: string[] = [`Here's your day, ${this.you()}.`];
    const tasks = this.store.get('tasks');
    const done = tasks.filter((t) => t.done && (t.doneAt ?? 0) >= start);
    P.push(done.length ? `You finished ${done.length === 1 ? 'one task' : `${done.length} tasks`}${done.length <= 3 ? `: ${done.map((t) => t.title.toLowerCase()).join(', ')}` : `, including ${done[0].title.toLowerCase()}`}.` : 'No tasks were ticked off today.');
    const fs = focusStats(this.store.get('focus'));
    const goal = this.settings.focusGoal;
    if (fs.today) P.push(`You focused for ${spokenMinutes(fs.today)}${goal ? (fs.today >= goal ? ', which meets your goal' : `, ${spokenMinutes(goal - fs.today)} short of your goal`) : ''}.`);
    const habits = this.store.get('habits');
    if (habits.length) {
      const left = habits.filter((h) => !doneToday(h));
      P.push(left.length ? `${habits.length - left.length} of ${habits.length} habits done. Still open: ${left.map((h) => h.name.toLowerCase()).join(', ')}.` : 'Every habit is done, so your streaks are safe.');
    }
    const overdue = tasks.filter((t) => !t.done && t.due && t.due < now);
    if (overdue.length) P.push(`${overdue.length === 1 ? 'One task is' : `${overdue.length} tasks are`} still overdue.`);
    const tStart = start + 864e5, tEnd = start + 2 * 864e5;
    const tomorrow = this.events.filter((e) => e.start >= tStart && e.start < tEnd);
    const dueTomorrow = tasks.filter((t) => !t.done && t.due && t.due >= tStart && t.due < tEnd);
    if (tomorrow.length) P.push(`Tomorrow starts with ${tomorrow[0].title}${tomorrow[0].allDay ? '' : ' at ' + new Date(tomorrow[0].start).toLocaleTimeString('en-GB', { hour: 'numeric', minute: '2-digit', hour12: true }).replace(':00', '').replace(' ', '')}${tomorrow.length > 1 ? `, with ${tomorrow.length - 1} more after it` : ''}.`);
    else P.push('Nothing is in the calendar for tomorrow.');
    if (dueTomorrow.length) P.push(`Due tomorrow: ${dueTomorrow.slice(0, 3).map((t) => t.title.toLowerCase()).join(', ')}.`);
    const soon = this.store.get('countdowns').filter((c) => daysUntil(c.date) >= 0 && daysUntil(c.date) <= 7).sort((a, b) => a.date - b.date)[0];
    if (soon) P.push(`${soon.title} is ${inDays(daysUntil(soon.date))}.`);
    P.push(['Rest well.', 'That is the day done.', 'Sleep well.'][new Date().getDate() % 3]);
    return P.join(' ');
  }

  /** "Play X": find it and start it. Returns what to say. */
  async playMusic(said: string): Promise<{ reply: string; ok: boolean }> {
    const app = this.settings.musicApp;
    const { query, kind } = musicRequest(said);
    if (!query) return { reply: 'Play what?', ok: false };
    const settle = async (): Promise<string> => {
      await new Promise((r) => setTimeout(r, 1300));
      await this.refreshMusic();
      return this.music?.state === 'playing' && this.music.title ? `Playing ${this.music.title}${this.music.artist ? ` by ${this.music.artist}` : ''}.` : `I've asked ${app} to play ${query}.`;
    };
    try {
      if (app === 'Music') {
        if (await this.o.mac.playMusic(app, query)) return { reply: await settle(), ok: true };
      } else {
        // Spotify can play anything by its address; a quick search finds the address. No account or key involved.
        const hits = await webSearch(this.o.fetch, `site:open.spotify.com ${query}${kind ? ` ${kind}` : ''}`).catch(() => []);
        const hit = spotifyUri(hits, kind);
        if (hit) {
          await this.o.mac.playMusic(app, hit.uri);
          return { reply: await settle(), ok: true };
        }
      }
    } catch (err) {
      return { reply: `${app} wouldn't play that: ${(err as Error).message}`, ok: false };
    }
    // Couldn't find it: show the search in the app rather than pretend.
    await this.o.mac.musicControl(app, 'search', query).catch(() => undefined);
    return { reply: `I couldn't find ${query} to play directly, so I've opened the search in ${app === 'Music' ? 'Apple Music' : app}.`, ok: false };
  }

  private nowPlayingText(): string {
    const m = this.music;
    const app = this.settings.musicApp === 'Music' ? 'Apple Music' : this.settings.musicApp;
    if (!m) return `${app} isn't open.`;
    if (!m.title || m.state === 'stopped') return 'Nothing is playing.';
    return `${m.state === 'playing' ? 'This is' : 'Paused on'} ${m.title}${m.artist ? ` by ${m.artist}` : ''}${m.album && m.album !== m.title ? `, from ${m.album}` : ''}.`;
  }

  private dayText(offset: 0 | 1): string {
    const start = new Date().setHours(0, 0, 0, 0) + offset * 864e5, end = start + 864e5, now = Date.now();
    const evs = this.events.filter((e) => !eventOver(e) && e.start < end && e.end > Math.max(start, offset ? start : now));
    const at = (t: number) => new Date(t).toLocaleTimeString('en-GB', { hour: 'numeric', minute: '2-digit', hour12: true }).replace(':00', '').replace(' ', '');
    const day = offset ? 'tomorrow' : 'today';
    if (this.integrations.calendar.state !== 'ok' && !evs.length) return `I can't see a calendar yet. Add one in Settings.`;
    if (!evs.length) return offset ? 'Nothing in the calendar tomorrow.' : 'Nothing else in the calendar today.';
    return `${evs.length === 1 ? 'One thing' : `${evs.length} things`} ${day}: ${evs.slice(0, 5).map((e) => `${e.title}${e.allDay ? '' : ` at ${at(e.start)}`}`).join(', ')}.`;
  }

  // ------------------------------------------------------------------ revision

  private get libraryFile(): string {
    return path.join(this.o.dataDir, 'study-library.json');
  }

  private loadLibrary(): void {
    try {
      this.library = JSON.parse(fs.readFileSync(this.libraryFile, 'utf8')) as Library;
      this.vocab = vocabulary(this.library);
    } catch {
      /* nothing synced yet */
    }
  }

  /** Bring in the latest flashcards and notes. Kept on disk, so revision works offline afterwards. */
  async syncStudy(force = false): Promise<void> {
    const source = this.settings.studySource.trim();
    if (!source) {
      this.library = { decks: [], notes: [], syncedAt: 0, source: '' };
      this.vocab = new Set();
      this.studyError = '';
      return this.patch({ study: this.studyView(), needs: this.needs() });
    }
    if (!force && this.library.source === source && Date.now() - this.library.syncedAt < 6 * 36e5) return;
    try {
      const got = isRepo(source) ? await fetchRepo(this.o.fetch, source) : fs.existsSync(source) ? readFolder(source) : null;
      if (!got) throw new Error('that is neither a GitHub repository (owner/name) nor a folder on this Mac');
      if (!got.decks.length && !got.notes.length) throw new Error('no flashcards or notes were found there (looking for flashcards/*.csv and notes/**/*.md)');
      this.library = { ...got, syncedAt: Date.now(), source };
      this.vocab = vocabulary(this.library);
      this.studyError = '';
      fs.writeFileSync(this.libraryFile, JSON.stringify(this.library));
    } catch (err) {
      const msg = (err as Error).message;
      this.studyError = /fetch failed|ENOTFOUND|network|ERR_/i.test(msg) ? "can't reach GitHub (offline?)" : msg;
    }
    this.patch({ study: this.studyView(), needs: this.needs() });
  }

  private studyView(): Snapshot['study'] {
    const progress = this.store.get('study');
    const decks = deckStats(this.library.decks, progress);
    const q = this.quiz;
    return {
      source: this.settings.studySource, syncedAt: this.library.syncedAt, error: this.studyError || undefined,
      due: decks.reduce((n, d) => n + d.due, 0), cards: decks.reduce((n, d) => n + d.total, 0), notes: this.library.notes.length, decks,
      quiz: q ? { label: q.label, index: q.i, total: q.cards.length, right: q.right, question: q.cards[q.i]?.q ?? '', last: q.last && { q: q.last.q, a: q.last.a, given: q.last.given, grade: q.last.grade } } : null,
    };
  }

  /** Begin a flashcard session. Returns what to say. */
  startQuiz(said = ''): string {
    if (!this.library.decks.length) return this.studyError ? `I couldn't load your flashcards: ${this.studyError}.` : 'I have no flashcards yet. Set where your revision material lives in Settings.';
    const decks = matchDecks(this.library.decks, said);
    if (!decks.length) return `I don't have a deck on that. I have ${[...new Set(this.library.decks.map((d) => d.module))].join(', ')}.`;
    const cards = pickCards(decks, this.store.get('study'), 10);
    const modules = [...new Set(decks.map((d) => d.module))];
    const label = decks.length === 1 ? decks[0].name : modules.length === 1 ? modules[0].replace(/^./, (c) => c.toUpperCase()) : 'Mixed revision';
    this.quiz = { label, cards, i: 0, right: 0, missed: [], startedAt: Date.now(), last: undefined };
    this.patch({ study: this.studyView() });
    return `${label}: ${cards.length === 1 ? 'one card' : `${cards.length} cards`}. Say skip if you don't know one, or stop to finish. First question. ${cards[0].q}`;
  }

  private endQuiz(): string {
    const q = this.quiz;
    if (!q) return 'No quiz is running.';
    this.quiz = null;
    const done = q.i;
    const mins = Math.round((Date.now() - q.startedAt) / 6e4);
    if (mins >= 1) {
      // Revision counts as focused work.
      this.store.get('focus').push({ id: uid(), subject: q.label, start: q.startedAt, minutes: mins });
      this.store.touch('focus');
    }
    this.patch({ study: this.studyView(), focus: this.recentFocus(), needs: this.needs() });
    if (!done) return 'Quiz stopped.';
    const missed = [...new Set(q.missed.map((c) => c.q.replace(/\?$/, '')))];
    return `That's ${q.right} out of ${done}.${missed.length ? ` To go over again: ${missed.slice(0, 3).join('; ')}${missed.length > 3 ? `; and ${missed.length - 3} more` : ''}. I'll bring ${missed.length === 1 ? 'it' : 'them'} back soon.` : ' Every one right.'}`;
  }

  /** One turn while a quiz is running: an answer or a control word. Null means "this was not for the quiz". */
  private quizTurn(text: string): string | null {
    const q = this.quiz;
    if (!q) return null;
    const t = text.toLowerCase().replace(/[.!?,]/g, '').replace(new RegExp(`^(hey |ok |okay )?${this.settings.assistantName.toLowerCase()}\\s*`), '').trim();
    const progress = this.store.get('study');
    const card = q.cards[q.i];
    const next = (lead: string): string => {
      q.i++;
      this.store.touch('study');
      if (q.i >= q.cards.length) return `${lead} ${this.endQuiz()}`.trim();
      this.patch({ study: this.studyView() });
      return `${lead} Next. ${q.cards[q.i].q}`.trim();
    };
    if (/^(stop|end|finish|quit|exit|cancel)( the| this)?( quiz| flashcards| revision| test)?( now| please)?$|^thats enough( for now)?$|^(im|i am) done$/.test(t.replace(/'/g, ''))) return this.endQuiz();
    if (/^(repeat|again|say (that|it) again|repeat (that|the question)|what was the question|pardon|sorry)$/.test(t)) return card.q;
    if (/^(i (was|got (it|that)) right|i got it|mark (it|that)( as)? (right|correct)|that was right|(that|it) counts)$/.test(t) && q.last && q.last.grade !== 'right') {
      // The checker is rough: the person has the last word.
      record(progress, q.last.key, true);
      q.last.grade = 'right';
      q.right++;
      q.missed = q.missed.filter((c) => c.key !== q.last!.key);
      this.store.touch('study');
      this.patch({ study: this.studyView() });
      return `Marked right. ${card.q}`;
    }
    const skip = /^(skip|pass|next|i dont know|dont know|no idea|not sure|i have no idea|i cant remember|cant remember|show (me )?(the )?answer|tell me|what is it|i forget|ive forgotten)$/.test(t.replace(/'/g, ''));
    // Anything that reads as an instruction or a question to Jarvis is not an answer.
    if (!skip && (wantsAction(text) || /^(what|whats|who|when|where|why|how|can you|could you|will you|do i|is there|are there)\b/.test(t.replace(/'/g, '')) && /\?\s*$/.test(text.trim()) && contentWords(text).length < 4)) return null;
    const g = skip ? 'wrong' : grade(text, card.a);
    record(progress, card.key, g === 'right');
    if (g === 'right') q.right++;
    else q.missed.push(card);
    q.last = { q: card.q, a: card.a, given: skip ? '' : text, grade: g, key: card.key };
    return next(g === 'right' ? ['Right.', 'Correct.', 'Yes.', 'Spot on.'][q.i % 4] : g === 'close' ? `Close. ${card.a}` : skip ? card.a : `Not quite. ${card.a}`);
  }

  /** Is this question about the subject being studied? */
  private aboutStudy(q: string): boolean {
    return this.vocab.size > 0 && (studyContext(this.library, this.vocab, q) !== '' || looksLegal(q));
  }

  /** A plain-text health report: what is connected, how fast each part is running, and any errors. For troubleshooting. */
  async diagnose(): Promise<string> {
    const s = this.settings;
    const L: string[] = [`Jarvis ${this.o.version} health check, ${new Date().toLocaleString('en-GB')}`];
    L.push(`Computer: ${os.cpus()[0]?.model ?? 'unknown'}, ${this.ramGb} GB memory, ${Math.round(os.freemem() / 2 ** 20)} MB free, macOS ${os.release()}, real Mac integrations: ${this.o.mac.real}`);
    L.push(`Mind: ${s.llmModel} is ${this.status.llm}${this.llmInfo ? `, running on ${this.llmInfo.gpu === 'metal' ? 'the Apple GPU (good)' : this.llmInfo.gpu === 'false' || this.llmInfo.gpu === 'cpu' ? 'the CPU only (slow: this is a problem)' : this.llmInfo.gpu}, context ${this.llmInfo.contextSize}` : ''}`);
    for (const st of this.llmStats.filter((x) => /^t\d/.test(x.streamId)).slice(-5)) L.push(`  reply ${st.streamId}: read ${st.read} tokens, wrote ${st.wrote}, first word after ${st.firstMs} ms, finished in ${st.ms} ms (${st.wrote > 2 ? Math.round((st.wrote / Math.max(1, st.ms - st.firstMs)) * 1000) : '?'} tokens/s)`);
    L.push(`Ears: ${s.asrModel} is ${this.status.asr}${this.lastAsr ? `, last transcription took ${this.lastAsr.ms} ms for ${this.lastAsr.secs.toFixed(1)} s of speech` : ''}`);
    L.push(`Voice: ${s.voice} at ${s.speed}x, built-in voice ${this.status.voice}${this.voiceStats ? `; last passage: ${this.voiceStats.lastChars} characters in ${this.voiceStats.lastMs} ms, making speech ${this.voiceStats.rate}x faster than it is spoken${this.voiceStats.rate < 1.5 ? ' (too slow: expect gaps)' : ''}` : ''}${this.cloudDown ? `; cloud voice problem: ${this.cloudDown}` : ''}`);
    for (const [turn, m] of [...this.marks].slice(-4)) if (m.think !== undefined) L.push(`  turn ${turn}: heard ${m.asr ?? 0} ms, thought ${m.think} ms, voice ${m.voice ?? '-'} ms`);
    for (const [k, v] of Object.entries(this.integrations)) L.push(`${k}: ${v.state}${v.detail ? ` (${v.detail})` : ''}`);
    try {
      const m = await this.o.mac.music(s.musicApp);
      L.push(`Music check (${s.musicApp}): ${m ? `${m.state}${m.title ? `, “${m.title}” by ${m.artist}` : ', no track'}` : 'the app is not running'}`);
    } catch (err) {
      L.push(`Music check (${s.musicApp}) FAILED: ${(err as Error).message}`);
    }
    L.push(`Calendar: ${this.events.length} events, last refreshed ${this.calendarAt ? `${Math.round((Date.now() - this.calendarAt) / 1000)} s ago` : 'never'}; sources: ${s.useAppleCalendar ? 'Apple Calendar' : ''}${s.calendarUrls.length ? ` + ${s.calendarUrls.length} link(s)` : ''}`);
    for (const e of this.events.slice(0, 8)) L.push(`  ${e.allDay ? 'all-day' : 'timed'} “${e.title}” ${new Date(e.start).toLocaleString('en-GB')} to ${new Date(e.end).toLocaleString('en-GB')} [${e.calendar ?? '?'}]`);
    L.push(`Mail: ${this.unread} unread; accounts: ${s.mailAccounts.map((a) => `${a.user} via ${a.host}`).join(', ') || 'none'}; Apple Mail ${s.useAppleMail ? 'on' : 'off'}`);
    L.push(`Revision: ${this.library.decks.length} decks, ${this.library.notes.length} note sections${this.studyError ? `, error: ${this.studyError}` : ''}`);
    return L.join('\n');
  }

  private refreshing: Promise<boolean> | null = null;
  /** Bring everything on the dashboard up to date. */
  refreshAll(): Promise<boolean> {
    this.refreshing ??= Promise.allSettled([this.refreshCalendar(), this.refreshMail(), this.refreshWeather(), this.refreshMusic(), this.refreshHome(), this.refreshHa(), this.syncStudy()])
      .then(() => {
        this.refreshHark();
        this.patch({ events: this.events, needs: this.needs() });
        return true;
      })
      .finally(() => (this.refreshing = null));
    return this.refreshing;
  }

  /** Events that have not finished yet, soonest first. */
  private upcoming(): CalEvent[] {
    const now = Date.now();
    return this.events.filter((e) => !eventOver(e, now));
  }

  private batteryAt = 0;
  async refreshVitals(): Promise<void> {
    const now = os.cpus().map((c) => c.times);
    let idle = 0, total = 0;
    now.forEach((t, i) => {
      const p = this.lastCpu[i] ?? t;
      idle += t.idle - p.idle;
      total += t.user - p.user + (t.nice - p.nice) + (t.sys - p.sys) + (t.irq - p.irq) + (t.idle - p.idle);
    });
    this.lastCpu = now;
    const v: Vitals = { ...this.vitals, cpu: total ? Math.round((1 - idle / total) * 100) : 0, mem: Math.round((1 - os.freemem() / os.totalmem()) * 100), uptime: os.uptime() };
    if (Date.now() - this.batteryAt > 60e3) {
      this.batteryAt = Date.now();
      const b = await this.o.mac.battery().catch(() => null);
      if (b) (v.battery = b.percent), (v.charging = b.charging);
    }
    this.vitals = v;
    this.patch({ vitals: v });
  }

  /** Once a second: timers, reminders and heads-ups. */
  private calendarAt = 0;
  private lastTick = Date.now();
  private lastDay = new Date().getDate();
  private tick(): void {
    const now = Date.now();
    // Waking from sleep, or a new day: what is on screen is out of date, so look again at once.
    const woke = now - this.lastTick > 20e3, newDay = new Date().getDate() !== this.lastDay;
    this.lastTick = now;
    this.lastDay = new Date().getDate();
    if (woke || newDay) void this.refreshAll();
    const done = this.timers.filter((t) => t.endsAt <= now);
    if (done.length) {
      this.timers = this.timers.filter((t) => t.endsAt > now);
      this.patch({ timers: this.timers });
      for (const t of done) this.announce(`${t.label || 'Timer'} finished`, `Your ${t.label ? t.label + ' ' : ''}timer is up.`, `${this.you()}, your ${t.label ? t.label + ' ' : ''}timer is up.`);
    }
    if (this.focusNow && this.focusNow.endsAt <= now) {
      const msg = this.endFocus();
      this.announce('Focus session complete', msg, `Time's up, ${this.you()}. ${msg} Take a break.`);
    }
    for (const t of this.store.get('tasks')) {
      if (!t.done && t.due && t.due <= now && !t.notified) {
        t.notified = true;
        this.store.touch('tasks');
        this.announce('Reminder', t.title, `A reminder, ${this.you()}: ${t.title}.`);
        this.patch({ tasks: this.store.get('tasks'), needs: this.needs() });
      }
    }
    for (const e of this.events) {
      const mins = (e.start - now) / 6e4;
      if (!e.allDay && mins > 9 && mins <= 10 && !this.announced.has(e.id)) {
        this.announced.add(e.id);
        this.announce('Starting soon', `${e.title} in 10 minutes`, `Heads up, ${this.you()}: ${e.title} starts in ten minutes.`);
      }
    }
    if (new Date().getSeconds() === 0) this.patch({ needs: this.needs() });
  }

  private announce(title: string, body: string, speak: string): void {
    this.o.notify?.(title, body);
    this.push({ type: 'notify', title, body, speak });
    if (this.settings.speak) void this.speakOut(`n${++this.turnSeq}`, speak);
  }

  // ------------------------------------------------------------------ snapshot

  private you(): string {
    const s = this.settings;
    return s.address === 'sir' ? 'sir' : s.address === 'boss' ? 'boss' : s.address === 'maam' ? "ma'am" : s.userName || 'friend';
  }

  needs(): Need[] {
    const out: Need[] = [];
    const now = Date.now();
    const s = this.settings;
    if (this.status.llm === 'missing' || this.status.asr === 'missing' || this.status.voice === 'missing') out.push({ id: 'models', tone: 'warn', text: 'Finish downloading my AI models', action: { view: 'settings' } });
    const tasks = this.store.get('tasks').filter((t) => !t.done);
    const overdue = tasks.filter((t) => t.due && t.due < now);
    if (overdue.length) out.push({ id: 'overdue', tone: 'alert', text: overdue.length === 1 ? `Overdue: ${overdue[0].title}` : `${overdue.length} tasks are overdue`, action: { view: 'tasks' } });
    const endOfDay = new Date().setHours(23, 59, 59, 999);
    const today = tasks.filter((t) => t.due && t.due >= now && t.due <= endOfDay);
    if (today.length) out.push({ id: 'today', tone: 'warn', text: today.length === 1 ? `Today: ${today[0].title}` : `${today.length} tasks due today`, action: { view: 'tasks' } });
    const next = this.upcoming().find((e) => e.start > now && e.start - now < 3 * 36e5 && !e.allDay);
    if (next) out.push({ id: 'next', tone: 'info', text: `${next.title} in ${Math.max(1, Math.round((next.start - now) / 6e4))} min` });
    if (this.unread) out.push({ id: 'mail', tone: 'info', text: `${this.unread} unread email${this.unread === 1 ? '' : 's'}` });
    const dom = new Date().getDate();
    const bill = this.store.get('money').find((m) => m.kind === 'bill' && m.every === 'month' && m.day && m.day - dom >= 0 && m.day - dom <= 2);
    if (bill) out.push({ id: 'bill', tone: 'warn', text: `${bill.name} (${s.currency}${bill.amount}) is due ${bill.day === dom ? 'today' : `in ${bill.day! - dom} day${bill.day! - dom === 1 ? '' : 's'}`}` });
    for (const c of this.store.get('countdowns').filter((x) => daysUntil(x.date) >= 0 && daysUntil(x.date) <= 7).sort((a, b) => a.date - b.date).slice(0, 2)) out.push({ id: `cd-${c.id}`, tone: daysUntil(c.date) <= 2 ? 'warn' : 'info', text: `${c.title} is ${inDays(daysUntil(c.date))}` });
    const dueCards = this.library.decks.reduce((n, d) => n + d.cards.filter((c) => this.store.get('study')[c.key] && isDue(this.store.get('study'), c.key)).length, 0);
    if (dueCards) out.push({ id: 'study', tone: 'info', text: `${dueCards} flashcard${dueCards === 1 ? '' : 's'} due for revision` });
    const habitsLeft = this.store.get('habits').filter((h) => !doneToday(h));
    if (habitsLeft.length && new Date().getHours() >= 17) out.push({ id: 'habits', tone: 'info', text: habitsLeft.length === 1 ? `Habit left today: ${habitsLeft[0].name}` : `${habitsLeft.length} habits left today` });
    const fromRecordings = this.recordings.filter((r) => now - r.at < 14 * 864e5).reduce((n, r) => n + r.actions.filter((a) => !a.done).length, 0);
    if (fromRecordings) out.push({ id: 'hark', tone: 'info', text: `${fromRecordings} open action item${fromRecordings === 1 ? '' : 's'} from your recordings` });
    if (this.weather?.days[0] && this.weather.days[0].rain >= 70) out.push({ id: 'rain', tone: 'info', text: `Rain likely today (${this.weather.days[0].rain}%)` });
    for (const [k, v] of Object.entries(this.integrations)) if (v.state === 'error') out.push({ id: `int-${k}`, tone: 'warn', text: `${k[0].toUpperCase() + k.slice(1)}: ${v.detail ?? 'not responding'}`, action: { view: 'settings' } });
    if (!s.place) out.push({ id: 'place', tone: 'info', text: 'Tell me your town for local weather', action: { view: 'settings' } });
    return out.slice(0, 8);
  }

  snapshot(lan: string[] = []): Snapshot {
    return {
      settings: this.settings, tasks: this.store.get('tasks'), notes: this.store.get('notes'), money: this.store.get('money'),
      memories: this.store.get('memories').map(({ v: _v, ...m }) => m), timers: this.timers,
      focus: this.recentFocus(), focusNow: this.focusNow, habits: this.store.get('habits'), countdowns: this.store.get('countdowns'), routines: this.store.get('routines'), recordings: this.recordingList(), study: this.studyView(), chat: this.store.get('chat').slice(-60),
      events: this.events, mail: this.mail, unread: this.unread, music: this.music, weather: this.weather, vitals: this.vitals, home: this.home,
      integrations: this.integrations, models: this.models.list(this.ramGb), downloads: this.models.downloads(), status: { ...this.status },
      needs: this.needs(), mac: this.o.mac.real, version: this.o.version, links: { lan, token: this.store.get('meta').token, port: this.o.port },
    };
  }

  patchSettings(patch: Partial<Settings>, quiet = false): Settings {
    const before = this.settings;
    const next = { ...before, ...patch };
    if (patch.place !== undefined && patch.place !== before.place && patch.lat === undefined) (next.lat = undefined), (next.lon = undefined);
    this.store.set('settings', next);
    if (quiet) return next;
    this.patch({ settings: next });
    if (patch.place !== undefined || patch.units !== undefined) void this.refreshWeather();
    if (patch.calendarUrls !== undefined || patch.useAppleCalendar !== undefined) void this.refreshCalendar();
    if (patch.useAppleMail !== undefined) void this.refreshMail();
    if (patch.musicApp !== undefined) void this.refreshMusic();
    if (patch.homeShortcuts !== undefined) void this.refreshHome();
    if (patch.useHark !== undefined) this.refreshHark();
    if (patch.haUrl !== undefined || patch.haEntities !== undefined) void this.refreshHa();
    if (patch.mailAccounts !== undefined) void this.refreshMail();
    if (patch.studySource !== undefined) void this.syncStudy(true);
    if (patch.asrModel !== undefined && patch.asrModel !== before.asrModel) void this.ensureAsr().catch(() => undefined);
    if (patch.llmModel !== undefined && patch.llmModel !== before.llmModel) {
      this.llmLoaded = '';
      if (this.llm.running) void this.llm.call('unload').catch(() => undefined);
      void this.ensureLlm().catch(() => undefined);
    }
    this.refreshStatus();
    return next;
  }

  // ------------------------------------------------------------------ memory

  private async embed(texts: string[]): Promise<number[][] | null> {
    if (!this.models.installed('embed')) return null;
    try {
      return await this.speech.call<number[][]>('embed', { texts });
    } catch {
      return null;
    }
  }

  async remember(text: string, source: Memory['source'], kind: Memory['kind'] = 'fact'): Promise<Memory | null> {
    text = text.trim().replace(/\s+/g, ' ');
    if (text.length < 4) return null;
    const mems = this.store.get('memories');
    const v = (await this.embed([text]))?.[0];
    const twin = mems.find((m) => m.text.toLowerCase() === text.toLowerCase() || (v && m.v && dot(v, m.v) > 0.86));
    if (twin) {
      // Newer wording wins: people's details change.
      if (twin.text !== text && source === 'you') (twin.text = text), (twin.v = v), (twin.at = Date.now());
      this.store.touch('memories');
      this.patch({ memories: this.snapshot().memories });
      return twin;
    }
    const m: Memory = { id: uid(), text, kind, at: Date.now(), source, v };
    mems.push(m);
    this.store.touch('memories');
    this.patch({ memories: this.snapshot().memories });
    return m;
  }

  private async recall(query: string, k = 6): Promise<Memory[]> {
    const mems = this.store.get('memories');
    if (mems.length <= k) return mems;
    const qv = (await this.embed([query]))?.[0];
    const words = query.toLowerCase().split(/[^a-z0-9']+/).filter((w) => w.length > 3);
    const scored = mems.map((m) => {
      const low = m.text.toLowerCase();
      return { m, score: (qv && m.v ? dot(qv, m.v) : 0) + (words.length ? (words.filter((w) => low.includes(w)).length / words.length) * 0.3 : 0) + (m.pinned ? 1 : 0) };
    });
    return scored.sort((a, b) => b.score - a.score).slice(0, k).map((x) => x.m);
  }

  /** After a turn: quietly note anything lasting the user revealed about themselves. */
  private async learn(text: string): Promise<void> {
    if (text.length < 12 || !/\b(i|i'm|im|i've|my|mine|me|we|our)\b/i.test(text) || /\?\s*$/.test(text.trim())) return;
    // Requests are not facts.
    if (/^(please |can you |could you )?(remind|add|set|play|pause|open|turn|run|track|note|schedule|put|start|stop|skip|show|tell|give|find|search|what|when|who|where|how|why)\b/i.test(text.trim())) return;
    const name = this.settings.userName || 'The user';
    try {
      const raw = await this.llm.call<string>('generate', {
        streamId: (this.learning = `learn${++this.turnSeq}`),
        system: 'You maintain a personal assistant\'s long-term memory. You are precise and never invent details.',
        prompt: `${name} said: "${text}"\n\nList any lasting personal facts worth remembering about ${name} from this message: preferences, people in their life, places, routines, work or study, goals, important dates. Ignore one-off requests, questions, small talk, things they are doing right now and tasks they have finished. Write each fact as one short sentence starting with "${name}". If there is nothing lasting, reply with exactly NONE.`,
        maxTokens: 120,
        temperature: 0.1,
        side: true,
      });
      if (/^\s*none\b/i.test(raw)) return;
      for (const line of raw.split('\n').map((l) => l.replace(/^\s*(?:[-*•]|\d+[.)])\s*/, '').trim()).filter((l) => l.length > 8 && l.length < 200 && l.toLowerCase().startsWith(name.toLowerCase().split(' ')[0])).slice(0, 3)) {
        await this.remember(line, 'jarvis');
      }
    } catch {
      /* learning is best-effort */
    }
  }

  // ------------------------------------------------------------------ tools

  private tools(): Tool[] {
    const s = this.settings;
    const mac = this.o.mac;
    const tasks = () => this.store.get('tasks');
    const findTask = (title: string): Task | undefined => {
      const low = title.toLowerCase();
      const open = tasks().filter((t) => !t.done);
      return open.find((t) => t.title.toLowerCase() === low) ?? open.find((t) => t.title.toLowerCase().includes(low) || low.includes(t.title.toLowerCase())) ?? open.find((t) => low.split(/\s+/).filter((w) => w.length > 3).some((w) => t.title.toLowerCase().includes(w)));
    };
    return [
      {
        name: 'remember', description: `Save a lasting fact about ${s.userName || 'the user'} to long-term memory when they ask you to remember something or share something important about themselves.`,
        params: str({ fact: 'The fact, as one full sentence in the third person' }), label: () => 'Saved to memory',
        run: async ({ fact }) => ((await this.remember(String(fact), 'you')) ? 'Saved to memory.' : 'Nothing to save.'),
      },
      {
        name: 'forget', description: 'Delete a memory when the user asks you to forget something.', params: str({ about: 'What to forget' }), label: () => 'Removed from memory',
        run: async ({ about }) => {
          const hit = (await this.recall(String(about), 1))[0];
          if (!hit) return 'No matching memory.';
          this.store.set('memories', this.store.get('memories').filter((m) => m.id !== hit.id));
          this.patch({ memories: this.snapshot().memories });
          return `Forgot: ${hit.text}`;
        },
      },
      {
        name: 'add_task', description: 'Add a to-do or a reminder. Use this for "remind me to…" and "add … to my list".',
        params: str({ title: 'What to do, short', when: 'When it is due, e.g. "tomorrow 5pm", "in 20 minutes", "Friday". Empty if no time was given.' }, ['title']),
        label: ({ title }) => `Added “${title}”`,
        run: async ({ title, when }) => {
          const due = when ? parseWhen(String(when)) ?? undefined : undefined;
          tasks().unshift({ id: uid(), title: String(title).replace(/^to /i, '').replace(/^./, (c) => c.toUpperCase()), due, done: false, at: Date.now() });
          this.store.touch('tasks');
          this.patch({ tasks: tasks(), needs: this.needs() });
          return due ? `Added. Reminder set for ${describeWhen(due)}.` : 'Added to the list.';
        },
      },
      {
        name: 'complete_task', description: 'Mark a to-do as done.', params: str({ title: 'The task, or part of its name' }), label: ({ title }) => `Completed “${title}”`,
        run: async ({ title }) => {
          const t = findTask(String(title));
          if (!t) return 'No open task matches that.';
          t.done = true;
          t.doneAt = Date.now();
          this.store.touch('tasks');
          this.patch({ tasks: tasks(), needs: this.needs() });
          return `Marked done: ${t.title}`;
        },
      },
      {
        name: 'add_note', description: 'Save a note to the notebook.', params: str({ text: 'The note' }), label: () => 'Note saved',
        run: async ({ text }) => {
          this.store.get('notes').unshift({ id: uid(), text: String(text), at: Date.now() });
          this.store.touch('notes');
          this.patch({ notes: this.store.get('notes') });
          return 'Note saved.';
        },
      },
      {
        name: 'set_timer', description: 'Start a countdown timer.', params: { type: 'object', properties: { minutes: { type: 'number', description: 'Length in minutes (0.5 = 30 seconds)' }, label: { type: 'string', description: 'What it is for, e.g. "pasta"' } }, required: ['minutes'] },
        label: ({ minutes }) => `Timer: ${minutes} min`,
        run: async ({ minutes, label }) => {
          const ms = Math.max(1, Number(minutes) * 60e3);
          this.timers = [...this.timers, { id: uid(), label: String(label ?? ''), endsAt: Date.now() + ms, total: ms }];
          this.patch({ timers: this.timers });
          return `Timer started for ${minutes} minutes.`;
        },
      },
      {
        name: 'add_event', description: 'Put an event in the calendar.', params: str({ title: 'Event name', when: 'Start, e.g. "Saturday 7pm"' }), label: ({ title }) => `Scheduled “${title}”`,
        run: async ({ title, when }) => {
          const start = parseWhen(String(when));
          if (!start) return 'I could not understand that time.';
          this.store.get('events').push({ id: uid(), title: String(title), start, end: start + 36e5 });
          this.store.touch('events');
          await this.refreshCalendar();
          return `Scheduled for ${describeWhen(start)}.`;
        },
      },
      {
        name: 'music', description: `Control ${s.musicApp}: play, pause, skip, go back, set volume (0-100), or play something specific (action "play" with the song, artist, album or playlist as value).`,
        params: { type: 'object', properties: { action: { type: 'string', enum: ['play', 'pause', 'next', 'previous', 'volume', 'search'] }, value: { type: 'string', description: 'Volume number, or what to play' } }, required: ['action'] },
        label: ({ action }) => `Music: ${action}`,
        run: async ({ action, value }) => {
          if ((action === 'search' || action === 'play') && value) return (await this.playMusic(String(value))).reply;
          await mac.musicControl(s.musicApp, action, value);
          setTimeout(() => void this.refreshMusic(), 600);
          return 'Done.';
        },
      },
      ...(this.shortcutTiles.length
        ? [{
            name: 'run_shortcut', description: `Run one of the user's Shortcuts (home and device automations). Available: ${this.shortcutTiles.map((h) => h.name).join(', ')}.`,
            params: { type: 'object', properties: { name: { type: 'string', enum: this.shortcutTiles.map((h) => h.name) } }, required: ['name'] },
            label: ({ name }: { name: string }) => `Ran “${name}”`,
            run: async ({ name }: { name: string }) => {
              await mac.runShortcut(String(name));
              return `Ran ${name}.`;
            },
          } as Tool]
        : []),
      {
        name: 'open_app_or_website', description: 'Open an app or a website on the Mac.', params: str({ target: 'App name (e.g. "Safari") or a full https URL' }), label: ({ target }) => `Opened ${target}`,
        run: async ({ target }) => {
          const t = String(target);
          if (/^https?:\/\//i.test(t) || /^[\w-]+(\.[\w-]+)+(\/\S*)?$/.test(t)) await mac.openUrl(/^https?:/i.test(t) ? t : `https://${t}`);
          else await mac.openApp(t);
          return `Opened ${t}.`;
        },
      },
      {
        name: 'computer', description: "Control the Mac itself: set the system volume, mute or unmute, lock the screen, or switch dark mode.",
        params: { type: 'object', properties: { action: { type: 'string', enum: ['volume', 'mute', 'unmute', 'lock', 'dark-mode'] }, percent: { type: 'number', description: 'Volume 0-100, only for "volume"' } }, required: ['action'] },
        label: ({ action }) => `Mac: ${action}`,
        run: async ({ action, percent }) => {
          if (action === 'volume') await mac.setVolume(Number(percent) || 0);
          else await mac.system(action);
          return 'Done.';
        },
      },
      {
        name: 'get_weather', description: 'Get the weather for a place other than home.', params: str({ place: 'Town or city' }), label: ({ place }) => `Weather: ${place}`,
        run: async ({ place }) => {
          const g = await geocode(this.o.fetch, String(place));
          if (!g) return `No place called ${place} was found.`;
          return weatherSentence(await forecast(this.o.fetch, g.lat, g.lon, g.name, s.units));
        },
      },
      {
        name: 'web_search', description: 'Look something up on the internet: current facts, news, people, definitions. Use it when you are not sure.', params: str({ query: 'What to search for' }), label: ({ query }) => `Searched “${query}”`,
        run: async ({ query }) => {
          // Never send the user's own name out to a search engine.
          if (s.userName && new RegExp(`\\b${s.userName.split(' ')[0]}\\b`, 'i').test(String(query))) return 'Do not search the web for the user\'s personal details. Answer from the context and your memory instead.';
          const [hits, wiki] = await Promise.all([webSearch(this.o.fetch, String(query)).catch(() => []), wikipedia(this.o.fetch, String(query)).catch(() => null)]);
          const parts = [wiki ? `Wikipedia (${wiki.title}): ${wiki.extract.slice(0, 600)}` : '', ...hits.slice(0, 4).map((h) => `${h.title}: ${h.snippet}`)].filter(Boolean);
          if (!parts.length && hits[0]) parts.push(await readPage(this.o.fetch, hits[0].url).catch(() => ''));
          return parts.join('\n') || 'The search returned nothing. I may be offline.';
        },
      },
      {
        name: 'add_money', description: 'Track a regular bill, subscription or income.',
        params: { type: 'object', properties: { name: { type: 'string' }, amount: { type: 'number' }, every: { type: 'string', enum: ['month', 'year', 'week'] }, kind: { type: 'string', enum: ['bill', 'income'] } }, required: ['name', 'amount'] },
        label: ({ name }) => `Tracking ${name}`,
        run: async ({ name, amount, every, kind }) => {
          this.store.get('money').push({ id: uid(), name: String(name), amount: Number(amount) || 0, every: every ?? 'month', kind: kind ?? 'bill', at: Date.now() });
          this.store.touch('money');
          this.patch({ money: this.store.get('money') });
          return `Now tracking ${name}.`;
        },
      },
    ];
  }

  /** What Jarvis can see right now, given to the model with each request. */
  private async context(query: string): Promise<string> {
    const s = this.settings;
    const now = new Date();
    const L: string[] = [`Now: ${now.toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' })}, ${now.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })}.`];
    L.push(`You are talking to: ${s.userName || 'the user'}${s.place ? `, who lives in ${s.place}` : ''}.`);
    // Only what bears on the question goes in: a short prompt is read in a fraction of the time, and a small
    // model given everything tends to drag unrelated details into its answer.
    const want = relevant(query);
    if (!want.weather) {
      /* not about the weather */
    } else if (this.weather) L.push(`Weather: ${weatherSentence(this.weather)}.`);
    else L.push('Weather: not available right now (say so if asked; never guess it).');
    const evs = this.upcoming().slice(0, 4);
    if (want.calendar) L.push(evs.length ? `Calendar: ${evs.map((e) => `${e.title} (${describeWhen(e.start)})`).join('; ')}.` : 'Calendar: nothing coming up.');
    const open = this.store.get('tasks').filter((t) => !t.done).slice(0, 6);
    if (want.tasks) L.push(open.length ? `To-do list: ${open.map((t) => t.title + (t.due ? ` (due ${describeWhen(t.due)})` : '')).join('; ')}.` : 'To-do list: empty.');
    if (want.mail && this.integrations.mail.state === 'ok') L.push(this.unread ? `Inbox: ${this.unread} unread emails. ${this.mail.slice(0, 5).map((m) => `From ${m.from}, subject “${m.subject}”`).join('. ')}.` : 'Inbox: no unread emails.');
    if (want.home && this.haEntities.length) {
      const lit = this.haEntities.filter((e) => e.domain === 'light' && isOn(e));
      const heat = this.haEntities.find((e) => e.domain === 'climate');
      L.push(`Home: ${lit.length ? `${lit.length} light${lit.length === 1 ? '' : 's'} on (${lit.slice(0, 6).map((e) => e.name).join(', ')})` : 'all lights off'}${heat?.current !== undefined ? `; ${heat.name} is at ${heat.current} degrees${heat.temperature !== undefined ? `, set to ${heat.temperature}` : ''}` : ''}.`);
    }
    if (want.music && this.music?.title) L.push(`Music: ${this.music.state} “${this.music.title}” by ${this.music.artist}.`);
    if (want.timers && this.timers.length) L.push(`Timers: ${this.timers.map((t) => `${t.label || 'timer'} with ${Math.ceil((t.endsAt - now.getTime()) / 6e4)} min left`).join('; ')}.`);
    const money = this.store.get('money');
    if (want.money && money.length) L.push(`Regular money: ${money.map((m) => `${m.name} ${s.currency}${m.amount}/${m.every} (${m.kind})`).join('; ')}.`);
    const notes = this.store.get('notes').slice(0, 4);
    if (want.notes && notes.length) L.push(`Recent notes: ${notes.map((n) => `“${n.text.slice(0, 80)}”`).join('; ')}.`);
    const fs = focusStats(this.store.get('focus'));
    if (want.focus && (fs.week || this.focusNow)) L.push(`Focused work: ${fs.today} minutes today (daily goal ${s.focusGoal}), ${fs.week} minutes over the last 7 days${fs.bySubject.length ? ` (${fs.bySubject.slice(0, 4).map(([k, v]) => `${k} ${v} min`).join(', ')})` : ''}, ${fs.streak}-day streak.${this.focusNow ? ` A focus session${this.focusNow.subject ? ` on ${this.focusNow.subject}` : ''} is running with ${Math.max(1, Math.ceil((this.focusNow.endsAt - now.getTime()) / 6e4))} minutes left.` : ''}`);
    const habits = this.store.get('habits');
    if (want.habits && habits.length) L.push(`Daily habits: ${habits.map((h) => `${h.name} (${doneToday(h) ? 'done today' : 'not done yet today'}, ${streak(h.days)}-day streak)`).join('; ')}.`);
    const cds = this.store.get('countdowns').filter((c) => daysUntil(c.date) >= 0).sort((a, b) => a.date - b.date).slice(0, 6);
    if (want.countdowns && cds.length) L.push(`Countdowns: ${cds.map((c) => `${c.title} ${inDays(daysUntil(c.date))} (${new Date(c.date).toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'long' })})`).join('; ')}.`);
    const revision = this.vocab.size ? studyContext(this.library, this.vocab, query) : '';
    if (revision) L.push(`From ${s.userName || 'the user'}'s own revision notes and flashcards (answer from these; if they don't cover the point, say the notes don't cover it rather than guessing):\n${revision}`);
    else if (this.vocab.size && looksLegal(query)) L.push(`Revision notes: nothing on this in ${s.userName || 'the user'}'s notes. The user has already been told so; answer in one sentence from general knowledge.`);
    if (this.aboutHark(query)) L.push(harkContext(this.harkDir, this.recordings, query));
    if (/\b(clipboard|copied|pasted)\b/i.test(query)) {
      // The clipboard is only ever read when the user brings it up.
      const clip = (await this.o.mac.clipboard().catch(() => '')).trim();
      L.push(clip ? `Clipboard (text ${s.userName || 'the user'} copied): «${clip.slice(0, 3000)}»` : 'Clipboard: empty, or not text.');
    }
    const mems = await this.recall(query, 4);
    if (mems.length) L.push(`What you remember about ${s.userName || 'the user'}: ${mems.map((m) => m.text).join(' ')}`);
    return L.join('\n');
  }

  private persona(): string {
    const s = this.settings;
    const who = s.userName || 'the user';
    const address = s.address === 'name' ? (s.userName ? ` Call them ${s.userName} now and then.` : '') : ` Address them as "${this.you()}" now and then.`;
    // Kept short on purpose: this is read before every reply.
    return `You are ${s.assistantName}, ${who}'s personal assistant: calm, quick, with a dry British wit used lightly.${address} You are speaking aloud in conversation. Reply in one or two short, natural spoken sentences with contractions; give the answer first; no lists, no markdown, no emoji. The lines under <context> are things you can see about ${who}'s day: use them as facts, and never invent appointments, tasks, emails or details that are not there. If asked to do something you have no tool for, say plainly that you can't do that yet.`;
  }

  /** Instant answers for the simplest commands: no need to wake the language model. */
  private async quick(text: string): Promise<{ reply: string; tool?: ToolUse } | null> {
    const t = text.toLowerCase().replace(/[.!?,]/g, '').replace(new RegExp(`^(hey |ok |okay )?${this.settings.assistantName.toLowerCase()}\\s*`), '').trim();
    const s = this.settings;
    const tools = this.tools();
    const use = async (name: string, args: Record<string, unknown>) => {
      const tool = tools.find((x) => x.name === name)!;
      await tool.run(args);
      return { name, label: tool.label(args), ok: true };
    };
    const c = t.replace(/^(please |can you |could you |will you |would you )+/, '').replace(/ please$/, '').trim();
    const did = (name: string, label: string): ToolUse => ({ name, label, ok: true });

    // ---- revision: a quiz in progress takes the turn, unless this was plainly meant for something else
    const quizReply = this.quizTurn(text);
    if (quizReply !== null) return { reply: quizReply };
    const quiz = c.match(/^(?:quiz|test|examine|grill) me(?: on (.+))?$/) ?? c.match(/^(?:start|do|run|begin|lets do|lets have|give me)(?: a| an| some| my)? (?:quiz|flashcards?|flash cards?|revision quiz|test)(?: on (.+))?$/) ?? c.match(/^(?:flashcards?|flash cards?)(?: on (.+))?$/);
    if (quiz) return { reply: this.startQuiz(quiz[1] ?? '') };
    if (/^(how many (flash ?)?cards (are|do i have) due|whats due for revision|what do i need to revise|how is my revision going|revision (status|progress))$/.test(c.replace(/'/g, ''))) {
      const v = this.studyView();
      if (!v.cards) return { reply: 'I have no flashcards loaded yet.' };
      const weakest = [...v.decks].sort((a, b) => a.solid / a.total - b.solid / b.total)[0];
      return { reply: `${v.due ? `${v.due} card${v.due === 1 ? ' is' : 's are'} due` : 'Nothing is due'}, and ${v.decks.reduce((n, d) => n + d.fresh, 0)} you haven't seen yet. ${v.decks.reduce((n, d) => n + d.solid, 0)} of ${v.cards} are solid${weakest && weakest.solid < weakest.total ? `; ${weakest.name.toLowerCase()} needs the most work` : ''}.` };
    }

    // ---- everyday commands, carried out directly: instant, and never at the mercy of the language model
    const said = text.trim().replace(new RegExp(`^(hey |ok |okay )?${s.assistantName}[,.!]?\\s*`, 'i'), '').replace(/^(please |can you |could you |will you |would you )+/i, '').replace(/( please| for me| now)+[.!?]*$/i, '').replace(/[.!?]+$/, '').trim();
    if (/^(hi|hello|hey|hiya|yo|good (morning|afternoon|evening))( there)?$/.test(c) && !this.matchRoutine(text)) return { reply: [`Hello${s.userName ? ', ' + s.userName : ''}. What do you need?`, `Here${s.userName ? ', ' + s.userName : ''}. What can I do?`, "I'm here. Go ahead."][new Date().getSeconds() % 3] };
    if (/^(thanks|thank you|cheers|ta|thanks a lot|thank you very much|nice one|perfect|great|brilliant)( jarvis)?$/.test(c)) return { reply: ['Any time.', 'Of course.', 'My pleasure.'][new Date().getSeconds() % 3] };
    if (/^(never ?mind|forget it|cancel( that)?|nothing|stop|shush|be quiet|quiet|thats all|that is all)$/.test(c.replace(/'/g, ''))) return { reply: '' };
    if (/^(how are you|how are you doing|hows it going|you ok|are you there|can you hear me)$/.test(c.replace(/'/g, ''))) return { reply: ['All systems running smoothly. What do you need?', "I'm here and listening.", 'Running well, thanks. What can I do for you?'][new Date().getSeconds() % 3] };
    if (/^(who are you|what are you|what can you do|what do you do|help|what can i ask( you)?)$/.test(c)) return { reply: `I'm ${s.assistantName}. I keep your day in order: calendar, reminders, mail, music, focus sessions, habits and revision quizzes, and I can answer questions or look things up. Just ask.` };
    if (/^(who am i|whats my name|what is my name|do you know (who i am|my name))$/.test(c.replace(/'/g, ''))) return { reply: s.userName ? `You're ${s.userName}.` : "You haven't told me your name yet. Add it in Settings." };
    if (/^(whats your name|what is your name|what are you called|what should i call you)$/.test(c.replace(/'/g, ''))) return { reply: `I'm ${s.assistantName}.` };
    let mm: RegExpMatchArray | null;
    if ((mm = said.match(/^(?:open|launch|start up|pull up|bring up|go to|take me to) (?:the |my )?(.+?)(?: app| website| site)?$/i)) && !/\b(focus|study|quiz|timer|session|routine|briefing)\b/i.test(mm[1])) {
      const SITES: Record<string, string> = { youtube: 'https://www.youtube.com', gmail: 'https://mail.google.com', google: 'https://www.google.com', netflix: 'https://www.netflix.com', 'bbc news': 'https://www.bbc.co.uk/news', bbc: 'https://www.bbc.co.uk', iplayer: 'https://www.bbc.co.uk/iplayer', twitter: 'https://x.com', x: 'https://x.com', instagram: 'https://www.instagram.com', linkedin: 'https://www.linkedin.com', github: 'https://github.com', amazon: 'https://www.amazon.co.uk', chatgpt: 'https://chatgpt.com', claude: 'https://claude.ai', 'google drive': 'https://drive.google.com', 'google calendar': 'https://calendar.google.com', 'google maps': 'https://maps.google.com', maps: 'https://maps.google.com', reddit: 'https://www.reddit.com', facebook: 'https://www.facebook.com', outlook: 'https://outlook.live.com', notion: 'https://www.notion.so' };
      const name = mm[1].trim();
      const site = SITES[name.toLowerCase()];
      try {
        if (site) await this.o.mac.openUrl(site);
        else if (/^https?:\/\//i.test(name) || /^[\w-]+(\.[\w-]+)+(\/\S*)?$/.test(name)) await this.o.mac.openUrl(/^https?:/i.test(name) ? name : `https://${name}`);
        else await this.o.mac.openApp(name.replace(/\b\w/g, (ch) => ch.toUpperCase()));
        return { reply: `Opening ${name}.`, tool: did('open', `Opened ${name}`) };
      } catch {
        return { reply: `I couldn't find an app called ${name}.`, tool: { name: 'open', label: `Couldn't open ${name}`, ok: false } };
      }
    }
    if ((mm = c.match(/^(?:set |turn |put |change )?(?:the |my )?(?:system |mac |computer |laptop )?volume (?:to |at |up to |down to )?(\d{1,3})(?: percent)?$/))) {
      await this.o.mac.setVolume(Math.min(100, +mm[1]));
      return { reply: `Volume at ${Math.min(100, +mm[1])}.`, tool: did('computer', `Volume ${Math.min(100, +mm[1])}%`) };
    }
    if ((mm = c.match(/^(?:turn |make )?(?:it |the volume |the sound |that |the music |volume )?(up|down|louder|quieter)(?: a bit| a little| slightly)?$/) ?? c.match(/^(?:turn|make) (up|down|louder|quieter) (?:the )?(?:volume|sound|music)$/) ?? c.match(/^(louder|quieter)$/))) {
      const up = /up|louder/.test(mm[1]);
      await this.o.mac.system(up ? 'louder' : 'quieter');
      return { reply: up ? 'Louder.' : 'Quieter.', tool: did('computer', up ? 'Volume up' : 'Volume down') };
    }
    if (/^(mute|unmute)( the)?( sound| volume| mac| computer| laptop| it)?$/.test(c)) {
      const un = c.startsWith('unmute');
      await this.o.mac.system(un ? 'unmute' : 'mute');
      return { reply: un ? 'Sound back on.' : 'Muted.', tool: did('computer', un ? 'Unmuted' : 'Muted') };
    }
    if (/^lock( the| my)?( screen| mac| computer| laptop)?$/.test(c)) {
      await this.o.mac.system('lock');
      return { reply: 'Locked.', tool: did('computer', 'Locked the screen') };
    }
    if ((mm = c.match(/^(?:turn |switch |put )?(on|off) dark mode$/) ?? c.match(/^(?:turn |switch |put )?dark mode (on|off)$/) ?? c.match(/^(?:switch|change|go) to (dark|light) mode$/) ?? c.match(/^(dark|light) mode$/))) {
      const on = mm[1] === 'on' || mm[1] === 'dark';
      await this.o.mac.system(on ? 'dark-on' : 'dark-off');
      return { reply: on ? 'Dark mode on.' : 'Light mode on.', tool: did('computer', on ? 'Dark mode' : 'Light mode') };
    }
    const shortcut = this.shortcutTiles.find((h) => h.name.toLowerCase() === c.replace(/^(run|start|do|activate|trigger) (the |my )?/, '').replace(/ (shortcut|scene)$/, ''));
    // A Home Assistant scene of the same name takes precedence (handled further down).
    if (shortcut && /^(run|start|do|activate|trigger) /.test(c) && !(this.haEntities.length && parseHomeCommand(c, this.haEntities))) {
      try {
        await this.o.mac.runShortcut(shortcut.name);
        return { reply: `${shortcut.name}, done.`, tool: did('run_shortcut', `Ran “${shortcut.name}”`) };
      } catch (err) {
        return { reply: `That shortcut failed: ${(err as Error).message}.`, tool: { name: 'run_shortcut', label: `${shortcut.name} failed`, ok: false } };
      }
    }
    if ((mm = said.match(/^(?:schedule|book|put|add) (?:in )?(?:a |an |my )?(.+?) (?:in|into|to|on) (?:my |the )?(?:calendar|diary)(?: (?:for|on|at) )?(.*)$/i) ?? said.match(/^(?:schedule|book)(?: in)? (?:a |an |my )?(.+)$/i))) {
      // "schedule dinner with Sam on Friday at 7": find where the title ends and the time begins.
      let title = mm[1], when = mm[2] ?? '';
      if (!when) {
        const words = mm[1].split(/\s+/);
        for (let i = 1; i < words.length; i++) {
          const tail = words.slice(i).join(' ');
          if (/^(tomorrow|today|tonight|on|at|for|in|next|this|monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b/i.test(tail) && parseWhen(tail)) {
            title = words.slice(0, i).join(' ');
            when = tail.replace(/^for /i, '');
            break;
          }
        }
      }
      const start = when ? parseWhen(when) : null;
      if (start) {
        const nice = title.replace(/^./, (ch) => ch.toUpperCase());
        this.store.get('events').push({ id: uid(), title: nice, start, end: start + 36e5 });
        this.store.touch('events');
        await this.refreshCalendar();
        return { reply: `${nice}, ${describeWhen(start)}. It's in your calendar.`, tool: did('add_event', `Scheduled “${nice}”`) };
      }
    }
    if ((mm = said.match(/^(?:i(?:'ve| have)? (?:just )?(?:finished|done|completed)|mark|tick off|tick|complete|check off|cross off) (?:the |my )?(.+?)(?: as done| as complete| done| off| from my list| off my list)?$/i)) && !matchHabit(this.store.get('habits'), mm[1])) {
      const low = mm[1].toLowerCase();
      const open = this.store.get('tasks').filter((x) => !x.done);
      const task = open.find((x) => x.title.toLowerCase() === low) ?? open.find((x) => x.title.toLowerCase().includes(low) || low.includes(x.title.toLowerCase())) ?? open.find((x) => low.split(/\s+/).filter((w) => w.length > 3).some((w) => x.title.toLowerCase().includes(w)));
      if (task) {
        task.done = true;
        task.doneAt = Date.now();
        this.store.touch('tasks');
        this.patch({ tasks: this.store.get('tasks'), needs: this.needs() });
        return { reply: `Ticked off: ${task.title.toLowerCase()}.`, tool: did('complete_task', `Completed “${task.title}”`) };
      }
    }
    if ((mm = said.match(/^track (?:my |the |a |an )?(.+?),? (?:at |for |of |which is |its |it's )?[£$€]?(\d+(?:\.\d+)?)(?: pounds| quid| dollars| euros)?(?: (?:a|per|every|each) (month|year|week))?$/i))) {
      const name = mm[1].replace(/ (subscription|bill)$/i, '').replace(/^./, (ch) => ch.toUpperCase());
      this.store.get('money').push({ id: uid(), name, amount: +mm[2], every: (mm[3]?.toLowerCase() as 'month' | 'year' | 'week') ?? 'month', kind: /salary|income|wage|pay/i.test(name) ? 'income' : 'bill', at: Date.now() });
      this.store.touch('money');
      this.patch({ money: this.store.get('money'), needs: this.needs() });
      return { reply: `Tracking ${name} at ${s.currency}${mm[2]} a ${mm[3]?.toLowerCase() ?? 'month'}.`, tool: did('add_money', `Tracking ${name}`) };
    }
    if ((mm = c.match(/^(?:set |start |give me )?(?:a |an )?timer (?:for |of )?(\d+(?:\.\d+)?|a|an|one|two|three|four|five|ten|fifteen|twenty|thirty|forty five|forty-five|sixty|ninety) (second|minute|hour)s?$/))) {
      const WORDS: Record<string, number> = { a: 1, an: 1, one: 1, two: 2, three: 3, four: 4, five: 5, ten: 10, fifteen: 15, twenty: 20, thirty: 30, 'forty five': 45, 'forty-five': 45, sixty: 60, ninety: 90 };
      const n = WORDS[mm[1]] ?? parseFloat(mm[1]);
      return { reply: `${n} ${mm[2]}${n === 1 ? '' : 's'}, starting now.`, tool: await use('set_timer', { minutes: n * (mm[2] === 'second' ? 1 / 60 : mm[2] === 'hour' ? 60 : 1), label: '' }) };
    }
    if ((mm = said.match(/^(?:what(?:'s| is)|how(?:'s| is)) the weather (?:like )?(?:in|at|for) (.+?)(?: today| right now| tomorrow)?$/i))) {
      try {
        const g = await geocode(this.o.fetch, mm[1]);
        if (!g) return { reply: `I couldn't find a place called ${mm[1]}.` };
        return { reply: `In ${g.name} it's ${weatherSentence(await forecast(this.o.fetch, g.lat, g.lon, g.name, s.units))}.` };
      } catch {
        return { reply: "I can't reach the weather service right now." };
      }
    }

    // ---- focus sessions
    if (isFocusStop(c)) return this.focusNow ? { reply: this.endFocus(), tool: did('focus', 'Focus session ended') } : { reply: 'No focus session is running.' };
    const focus = parseFocus(c);
    if (focus) {
      this.startFocus(focus.minutes, focus.subject);
      return { reply: `${spokenMinutes(focus.minutes)}${focus.subject ? ` on ${focus.subject}` : ''}, starting now. I'll tell you when time is up.`, tool: did('focus', `Focus: ${focus.minutes} min${focus.subject ? ` · ${focus.subject}` : ''}`) };
    }
    if (/^how (much|long) have i (focused|studied|worked|revised)( for)?( today| this week| so far)*$|^(focus|study) (stats|time|summary)$/.test(c)) {
      const st = focusStats(this.store.get('focus'));
      if (!st.week) return { reply: 'Nothing logged yet. Say "start a focus session" and I will time it.' };
      return { reply: `${st.today ? spokenMinutes(st.today) : 'Nothing'} today, and ${spokenMinutes(st.week)} over the last seven days${st.bySubject[0] && st.bySubject[0][0] !== 'General' ? `, mostly on ${st.bySubject[0][0]}` : ''}.${st.streak > 1 ? ` That's ${st.streak} days in a row.` : ''}` };
    }

    // ---- habits
    const habits = this.store.get('habits');
    const newHabit = c.match(/^(?:add|create|start|track|make) (?:a |an )?(?:new )?(?:daily )?habit(?: called| named| of| for| to)? (.+)$/);
    if (newHabit) {
      const name = tidy(newHabit[1]);
      if (matchHabit(habits, name)?.name.toLowerCase() === name.toLowerCase()) return { reply: `${name} is already one of your habits.` };
      habits.push({ id: uid(), name, days: [], at: Date.now() });
      this.store.touch('habits');
      this.patch({ habits, needs: this.needs() });
      return { reply: `${name} is now a daily habit. Tell me when you've done it.`, tool: did('habit', `New habit: ${name}`) };
    }
    if (/^(how are my habits( doing| going)?|habits|my habits|what habits (do i have|are left)( today)?|which habits are left( today)?|habit (check|status))$/.test(c)) return { reply: this.habitsText() };
    const ticked = c.match(/^(?:i(?:'ve| have)? (?:just )?(?:did|done|finished|completed)|mark|tick off|tick|log|check off) (?:my |the )?(.+?)(?: as done| as complete| done| off| complete)?(?: for)?(?: today)?$/);
    const habit = ticked ? matchHabit(habits, ticked[1]) : undefined;
    if (habit) {
      if (doneToday(habit)) return { reply: `${habit.name} was already ticked off today.` };
      this.setHabit(habit, true);
      const n = streak(habit.days);
      return { reply: `${habit.name} done.${n > 1 ? ` That's ${n} days in a row.` : ''}`, tool: did('habit', `Habit done: ${habit.name}`) };
    }

    // ---- countdowns
    const cds = this.store.get('countdowns');
    const newCd = c.match(/^(?:add |start |set |create |make )?(?:a |an )?count ?down (?:to|for|until|till) (?:my |the )?(.+?) (?:on|is on|which is on|at) (.+)$/);
    const cdDate = newCd ? parseWhen(newCd[2]) : null;
    if (newCd && cdDate) {
      const title = tidy(newCd[1]);
      this.store.set('countdowns', [...cds.filter((x) => x.title.toLowerCase() !== title.toLowerCase()), { id: uid(), title, date: cdDate }]);
      this.patch({ countdowns: this.store.get('countdowns'), needs: this.needs() });
      return { reply: `${title} is ${inDays(daysUntil(cdDate))}. I'll keep count.`, tool: did('countdown', `Counting down to ${title}`) };
    }
    const until = c.match(/^how (?:long|many days|many sleeps|many weeks) (?:is it |are there |do i have |have i got )?(?:left )?(?:until|till|to|before) (?:my |the )?(.+)$/);
    const cd = until ? matchCountdown(cds, until[1]) : undefined;
    if (cd) return { reply: `${cd.title} is ${daysUntil(cd.date) > 1 ? `${daysUntil(cd.date)} days away` : inDays(daysUntil(cd.date))}, on ${new Date(cd.date).toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long' })}.` };
    const dropCd = c.match(/^(?:remove|delete|cancel|stop) (?:the |my )?count ?down (?:to|for|until|till) (?:my |the )?(.+)$/);
    const gone = dropCd ? matchCountdown(cds, dropCd[1]) : undefined;
    if (gone) {
      this.store.set('countdowns', cds.filter((x) => x.id !== gone.id));
      this.patch({ countdowns: this.store.get('countdowns'), needs: this.needs() });
      return { reply: `Stopped counting down to ${gone.title}.`, tool: did('countdown', `Removed ${gone.title}`) };
    }

    // ---- the day, top and tail
    if (/^(evening review|daily review|review (my|the) day|how did (today|my day) go|end of day( review)?|wrap up( my| the)? day|how was my day)$/.test(c)) return { reply: this.reviewText() };
    if (/^(briefing|brief me|morning briefing|daily briefing|(give me|play) (my|the) (morning |daily )?briefing)$/.test(c.replace(/'/g, ''))) return { reply: this.briefingText() };

    // ---- the home, through Home Assistant
    if (this.haEntities.length) {
      const cmd = parseHomeCommand(c, this.haEntities);
      if (cmd && 'answer' in cmd) return { reply: cmd.answer };
      if (cmd) {
        try {
          await this.haCall(cmd.targets, cmd.domain, cmd.service, cmd.data);
          return { reply: cmd.reply, tool: did('home', cmd.reply.replace(/\.$/, '')) };
        } catch (err) {
          return { reply: `That didn't work: ${(err as Error).message}.`, tool: { name: 'home', label: 'Home command failed', ok: false } };
        }
      }
    }

    // ---- things he can simply see: answered at once, without waking the language model
    if (/^(what|which) (song|track|music|tune|album|artist)( is|s)? (this|that|playing|on)( right now| now)?$|^whats (this song|this track|this|playing|on)( right now| now)?$|^what is (this song|this track|playing)( right now| now)?$|^who (sings|is singing|is this|made|plays) ?(this|that)?( song)?$|^what am i listening to( right now)?$|^(name|identify) (this|that) (song|track)$/.test(c.replace(/'/g, ''))) {
      await this.refreshMusic();
      return { reply: this.nowPlayingText() };
    }
    const play = c.match(/^(?:play|put on|stick on|throw on) (.+)$/);
    if (play && !/^(the |some |my |a )?(music|it|song|track|that|this|something|anything)$/.test(play[1]) && !/^(next|previous)\b/.test(play[1])) {
      const r = await this.playMusic(play[1]);
      return { reply: r.reply, tool: { name: 'music', label: r.ok ? `Playing ${musicRequest(play[1]).query}` : `Searched ${s.musicApp} for ${musicRequest(play[1]).query}`, ok: r.ok } };
    }
    const vol = c.match(/^(?:set |turn |change )?(?:the )?(?:music |spotify )?volume (?:to |at )?(\d{1,3})(?: percent)?$/) ?? c.match(/^(?:turn |set )(?:the )?(?:music|spotify|it) (?:up|down) to (\d{1,3})(?: percent)?$/);
    if (vol && /music|spotify/.test(c)) return { reply: `Music volume at ${Math.min(100, +vol[1])}.`, tool: await use('music', { action: 'volume', value: String(Math.min(100, +vol[1])) }) };
    if (/^(whats|what is|hows|how is) the weather( like)?( today| right now| outside| now)?$|^weather$|^(is it|will it) (going to )?rain(ing)?( today| later| tonight)?$|^do i need (an umbrella|a coat|a jacket)( today)?$/.test(c.replace(/'/g, ''))) {
      if (!this.weather) return { reply: s.place ? "I can't reach the weather service right now." : "Tell me your town in Settings and I'll keep an eye on the weather." };
      const rain = this.weather.days[0]?.rain ?? 0;
      return { reply: /rain|umbrella|coat|jacket/.test(c) ? `${rain >= 50 ? 'Yes, likely' : rain >= 25 ? 'Possibly' : 'Unlikely'}: ${rain} percent chance of rain today. It's ${weatherSentence(this.weather)}.` : `It's ${weatherSentence(this.weather)}.` };
    }
    if (/^(whats|what is|what have i got|what do i have|anything|is there anything) on( my calendar)?( for)? (today|tomorrow)$|^whats (on )?(my )?(calendar|schedule|diary)( look like)?( for)?( today| tomorrow)?$|^what does (today|tomorrow) look like$/.test(c.replace(/'/g, ''))) return { reply: this.dayText(/tomorrow/.test(c) ? 1 : 0) };
    if (/^whats (my )?next (meeting|event|appointment|thing)$|^what is (my )?next (meeting|event|appointment)$|^whats next$/.test(c.replace(/'/g, ''))) {
      const next = this.upcoming().find((e) => e.start > Date.now() && !e.allDay) ?? this.upcoming().find((e) => e.start > Date.now());
      return { reply: next ? `${next.title}, ${describeWhen(next.start)}.` : 'Nothing coming up in your calendar.' };
    }
    if (/^(whats|what is) on my (to ?do )?list$|^what do i (have|need) to do( today)?$|^(read|list|tell me)( me)? my (tasks|to ?dos|reminders|to ?do list|list)$|^whats left to do( today)?$/.test(c.replace(/['-]/g, ''))) {
      const open = this.store.get('tasks').filter((x) => !x.done);
      if (!open.length) return { reply: 'Your list is empty.' };
      return { reply: `${open.length === 1 ? 'One thing' : `${open.length} things`}: ${open.slice(0, 5).map((x) => x.title.toLowerCase() + (x.due ? `, ${describeWhen(x.due)}` : '')).join('; ')}${open.length > 5 ? `; and ${open.length - 5} more` : ''}.` };
    }
    if (/^(do i have |have i got |is there |are there )?(any )?(new |unread )?(emails?|mail|messages)$|^(check|read)( me)? my (emails?|mail|inbox)$|^who( has|s)? emailed me$|^whats in my inbox$/.test(c.replace(/'/g, ''))) {
      if (this.integrations.mail.state !== 'ok') return { reply: "I can't see your mail yet. Add a mail account in Settings, or open the Mail app." };
      if (!this.unread) return { reply: 'No unread email.' };
      return { reply: `${this.unread} unread${this.mail.length ? `: ${this.mail.slice(0, 3).map((m) => `${m.from} about ${m.subject.replace(/^(re|fwd?):\s*/i, '')}`).join('; ')}` : ''}.` };
    }

    // ---- clipboard
    if (/^copy (that|this|it|your (answer|reply|response)|what you (just )?said)( to (my |the )?clipboard)?$/.test(c)) {
      const last = [...this.store.get('chat')].reverse().find((m) => m.role === 'assistant');
      if (!last) return { reply: 'There is nothing to copy yet.' };
      await this.o.mac.setClipboard(last.text);
      return { reply: 'Copied.', tool: did('clipboard', 'Copied to clipboard') };
    }

    if (/^(what('?s| is) the time|what time is it|time)( now| please)?$/.test(t)) return { reply: `It's ${new Date().toLocaleTimeString('en-GB', { hour: 'numeric', minute: '2-digit', hour12: true })}.` };
    if (/^(what('?s| is) (the|today'?s) date|what day is it)( today)?$/.test(t)) return { reply: `It's ${new Date().toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long' })}.` };
    const timer = t.match(/^(?:set|start) (?:a |an )?(?:(.+?) )?timer for (\d+(?:\.\d+)?|a|an|one|two|three|four|five|ten|fifteen|twenty|thirty) (second|minute|hour)s?$/) ?? t.match(/^(?:set |start )?(?:a |an )?(\d+(?:\.\d+)?|one|two|three|four|five|ten|fifteen|twenty|thirty) (second|minute|hour)s? timer()$/);
    if (timer) {
      const [label, n, unit] = timer.length === 4 && /second|minute|hour/.test(timer[3]) ? [timer[1] ?? '', timer[2], timer[3]] : ['', timer[1], timer[2]];
      const words: Record<string, number> = { a: 1, an: 1, one: 1, two: 2, three: 3, four: 4, five: 5, ten: 10, fifteen: 15, twenty: 20, thirty: 30 };
      const minutes = (words[n] ?? parseFloat(n)) * (unit === 'second' ? 1 / 60 : unit === 'hour' ? 60 : 1);
      return { reply: `${words[n] ?? n} ${unit}${(words[n] ?? +n) === 1 ? '' : 's'}, starting now.`, tool: await use('set_timer', { minutes, label }) };
    }
    const music: [RegExp, string, string][] = [
      [/^(pause|stop)( the)?( music| song| track| it)?$|^(turn|switch) off( the)? music$|^(turn|switch)( the)? music off$/, 'pause', 'Paused.'], [/^(play|resume)( the| some)?( music| it)?$|^(turn|switch) on( the)? music$|^(turn|switch)( the)? music on$/, 'play', 'Playing.'],
      [/^(next|skip)( song| track| this| it)?$/, 'next', 'Skipped.'], [/^(previous|last|go back)( song| track)?$/, 'previous', 'Going back one.'],
    ];
    for (const [re, action, reply] of music) if (re.test(t)) return { reply, tool: await use('music', { action }) };

    // The everyday commands are handled directly, so they are instant and never depend on the model's mood.
    const raw = text.trim().replace(new RegExp(`^(hey |ok |okay )?${s.assistantName}[,.!]?\\s*`, 'i'), '').replace(/^(please |can you |could you |will you )/i, '').replace(/[.!]+$/, '');
    const remind = raw.match(/^remind me (?:to |about |that )(.+)$/i);
    if (remind) {
      // Find where the task ends and the time begins: "call the dentist | tomorrow at 9am".
      const words = remind[1].split(/\s+/);
      let title = remind[1], when = '';
      for (let i = 1; i < words.length; i++) {
        const tail = words.slice(i).join(' ');
        if (/^(tomorrow|today|tonight|on|at|in|next|this|by|every|monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b/i.test(tail) && parseWhen(tail)) {
          title = words.slice(0, i).join(' ');
          when = tail;
          break;
        }
      }
      // Also "remind me tomorrow at 9 to call the dentist".
      const lead = remind[1].match(/^(.+?) to (.+)$/i);
      if (!when && lead && parseWhen(lead[1])) (when = lead[1]), (title = lead[2]);
      const tool = await use('add_task', { title, when });
      const due = when ? parseWhen(when) : null;
      return { reply: due ? `I'll remind you ${describeWhen(due)}.` : "It's on your list.", tool };
    }
    const todo = raw.match(/^(?:add|put) (.+?) (?:to|on) (?:my |the )?(?:to-?do(?: list)?|list|tasks?)$/i);
    if (todo) return { reply: "It's on your list.", tool: await use('add_task', { title: todo[1] }) };
    const note = raw.match(/^(?:make |take |add |save )?(?:a )?note(?: down)?(?: that| to self| saying)?[:,]? (.+)$/i);
    if (note) return { reply: 'Noted.', tool: await use('add_note', { text: note[1].replace(/^./, (c) => c.toUpperCase()) }) };
    const rem = raw.match(/^remember (?:that )?(.+)$/i);
    if (rem) {
      const who = s.userName || 'The user';
      const fact = rem[1].replace(/\bmy\b/gi, `${who}'s`).replace(/\bi am\b|\bi'm\b/gi, `${who} is`).replace(/\bi have\b|\bi've\b/gi, `${who} has`).replace(/\bi\b/g, who).replace(/\bme\b/gi, who);
      return { reply: "I'll remember that.", tool: await use('remember', { fact: fact.replace(/^./, (c) => c.toUpperCase()) + '.' }) };
    }
    return null;
  }

  // ------------------------------------------------------------------ conversation

  /** Stage timings for each reply, so slow spots can be seen (in the log) rather than guessed at. */
  private marks = new Map<string, { t0: number; asr?: number; think?: number; voice?: number; thinkAt?: number }>();
  private mark(turn: string, stage: 'think' | 'voice'): void {
    const m = this.marks.get(turn);
    if (!m || m[stage] !== undefined) return;
    const now = Date.now();
    if (stage === 'think') (m.think = now - m.t0 - (m.asr ?? 0)), (m.thinkAt = now);
    else {
      m.voice = now - (m.thinkAt ?? m.t0);
      this.push({ type: 'say', turn, timing: { asr: m.asr, think: m.think, voice: m.voice, total: now - m.t0 } });
    }
  }

  private speakChain: Promise<void> = Promise.resolve();
  private speakSeq = new Map<string, number>();

  private waiting = new Map<string, string[]>();
  private cloudDown = '';
  private voiceStats: { voice: string; rate: number; lastMs: number; lastChars: number } | null = null;
  /** When the audio already sent will finish playing, and how fast the voice makes audio (seconds of speech per second). */
  private playEnd = 0;
  private voiceRate = 3;

  /** Synthesize with whichever voice is chosen: one of the Mac's own, or the built-in neural voice. */
  private async synth(text: string, voice: string, speed: number): Promise<string> {
    const keys = this.store.get('secrets');
    if (voice.startsWith('eleven:') || voice.startsWith('openai:')) {
      try {
        const mp3 = voice.startsWith('eleven:')
          ? await elevenSpeak(this.o.fetch, keys.elevenKey ?? '', voice.slice(7), text, speed)
          : await openaiSpeak(this.o.fetch, keys.openaiKey ?? '', voice.slice(7), text, this.settings.assistantName);
        this.cloudDown = '';
        return `mp3:${mp3.toString('base64')}`;
      } catch (err) {
        // Say why once, then carry on with the built-in voice rather than fall silent.
        const why = (err as Error).message;
        if (why !== this.cloudDown) {
          this.cloudDown = why;
          this.push({ type: 'notify', title: 'Cloud voice unavailable', body: `${why}. Using the built-in voice for now.` });
        }
        voice = DEFAULT_SETTINGS.voice;
      }
    }
    if (voice.startsWith('mac:')) {
      try {
        return `24000:${trimPcm(await this.o.mac.speak(voice.slice(4), text, speed)).toString('base64')}`;
      } catch {
        voice = DEFAULT_SETTINGS.voice; // that Mac voice has gone: fall back rather than go silent
      }
    }
    if (!this.models.installed('voice')) throw new Error('The voice has not been downloaded yet.');
    await this.ensureVoice();
    const out = await this.voice.call<{ pcm: string; rate: number }>('speak', { text, voice, speed });
    return `${out.rate}:${out.pcm}`;
  }

  private canSpeak(): boolean {
    return /^(mac|eleven|openai):/.test(this.settings.voice) || this.models.installed('voice');
  }

  /**
   * Turn text into speech and send it to every connected device, in order.
   * Sentences that arrive while the voice is busy are spoken together as one passage: a voice
   * reads two sentences in one breath far more naturally than it reads them one at a time.
   */
  private speakOut(turn: string, text: string, last = false): Promise<void> {
    const clean = speakable(text);
    const s = this.settings;
    if (clean) this.waiting.set(turn, [...(this.waiting.get(turn) ?? []), clean]);
    this.speakChain = this.speakChain.then(async () => {
      const seq = this.speakSeq.get(turn) ?? 0;
      const queue = this.waiting.get(turn) ?? [];
      // How much to say in one breath. The opening is kept short so speech starts promptly. After
      // that, a passage may only be as long as the voice can produce before what is already
      // playing runs out; otherwise speech would stop dead while the next passage is made.
      const lead = Math.max(0, (this.playEnd - Date.now()) / 1000);
      const limit = seq === 0 ? 110 : Math.max(70, Math.min(320, Math.round(lead * this.voiceRate * 0.7 * 15)));
      const take: string[] = [];
      while (queue.length && (!take.length || take.join(' ').length + queue[0].length < limit)) take.push(queue.shift()!);
      if (!queue.length) this.waiting.delete(turn);
      const passage = take.join(' ');
      if (!passage && !last) return;
      this.speakSeq.set(turn, seq + 1);
      if (this.speakSeq.size > 40) this.speakSeq.delete(this.speakSeq.keys().next().value!);
      if (!passage || !this.canSpeak() || (this.activeTurn !== turn && !turn.startsWith('n') && !turn.startsWith('p'))) {
        if (last) this.push({ type: 'audio', turn, seq, wav: '', text: '', last: true });
        return;
      }
      try {
        const t0 = Date.now();
        const wav = await this.synth(passage, s.voice, s.speed);
        // About 15 characters are spoken per second; raw audio tells us exactly.
        const secs = wav.startsWith('mp3:') ? passage.length / 15 : (wav.length - wav.indexOf(':') - 1) * 0.75 / 2 / (parseInt(wav, 10) || 24000);
        this.voiceRate = Math.max(0.5, Math.min(40, this.voiceRate * 0.5 + (secs / Math.max(0.05, (Date.now() - t0) / 1000)) * 0.5));
        this.playEnd = Math.max(Date.now(), this.playEnd) + secs * 1000 + 250;
        this.voiceStats = { voice: s.voice.split(':')[0].replace(/^[a-z]{2}_.*/, 'built-in'), rate: Math.round(this.voiceRate * 10) / 10, lastMs: Date.now() - t0, lastChars: passage.length };
        // A breath after a sentence, a beat after a clause.
        const gap = /[.!?…]["')\]]?$/.test(passage) ? 280 : /[,;:—–]$/.test(passage) ? 110 : 60;
        this.push({ type: 'audio', turn, seq, wav, text: passage, last: last && !this.waiting.has(turn), gap });
        this.mark(turn, 'voice');
      } catch {
        if (last) this.push({ type: 'audio', turn, seq, wav: '', text: '', last: true });
      }
    });
    return this.speakChain;
  }

  async previewVoice(voice: string): Promise<void> {
    const turn = `p${++this.turnSeq}`;
    const s = this.settings;
    const h = new Date().getHours();
    const wav = await this.synth(`Good ${h < 12 ? 'morning' : h < 18 ? 'afternoon' : 'evening'}${s.userName ? ', ' + s.userName : ''}. I've had a look at your day, and there's nothing urgent. Shall we get started?`, voice, s.speed);
    this.push({ type: 'audio', turn, seq: 0, wav, text: '', last: true });
  }

  stopTalking(): void {
    const t = this.activeTurn;
    this.activeTurn = '';
    if (t && this.llm.running) void this.llm.call('abort', { streamId: t }).catch(() => undefined);
    this.push({ type: 'say', turn: t, done: true, state: 'idle' });
  }

  /** Speech in: transcribe, then (if it was meant for Jarvis) answer. */
  async hear(pcmBase64: string, opts: { device?: string; needWake?: boolean } = {}): Promise<{ heard: string; ignored?: boolean }> {
    await this.ensureAsr();
    const buf = Buffer.from(pcmBase64, 'base64');
    const pcm = new Float32Array(buf.length / 2);
    for (let i = 0; i < pcm.length; i++) pcm[i] = buf.readInt16LE(i * 2) / 32768;
    const t0 = Date.now();
    const heard = await this.speech.call<string>('transcribe', { pcm, language: 'en' });
    const asr = Date.now() - t0;
    this.lastAsr = { ms: asr, secs: pcm.length / 16000 };
    if (!heard || heard.replace(/[^a-z]/gi, '').length < 2) return { heard: '', ignored: true };
    if (opts.needWake) {
      const name = this.settings.assistantName.toLowerCase();
      // Whisper hears the name a few ways.
      const variants = name === 'jarvis' ? ['jarvis', 'jervis', 'jarvas', 'javis', 'jarves', 'jarvus', 'travis'] : [name];
      const low = heard.toLowerCase();
      if (!variants.some((v) => low.includes(v))) return { heard, ignored: true };
    }
    void this.say(heard, { device: opts.device, voice: true, t0, asr });
    return { heard };
  }

  /** One conversational turn. Resolves when the reply text is complete. */
  async say(text: string, opts: { device?: string; voice?: boolean; t0?: number; asr?: number } = {}): Promise<ChatMsg> {
    text = text.trim();
    const turn = `t${++this.turnSeq}`;
    this.marks.set(turn, { t0: opts.t0 ?? Date.now(), asr: opts.asr });
    if (this.marks.size > 20) this.marks.delete(this.marks.keys().next().value!);
    if (this.activeTurn && this.llm.running) void this.llm.call('abort', { streamId: this.activeTurn }).catch(() => undefined);
    this.activeTurn = turn;
    const chat = this.store.get('chat');
    // Past actions are shown as finished, so an old request is never carried out a second time.
    // A new question outranks background note-taking.
    if (this.learning) void this.llm.call('abort', { streamId: this.learning }).catch(() => undefined);
    const history = chat.slice(-4).map((c) => ({ role: c.role, text: c.tools?.some((t) => t.ok) ? `${c.text.slice(0, 240)} [Already completed: ${c.tools.filter((t) => t.ok).map((t) => t.label).join('; ')}]` : c.text.slice(0, 240) }));
    const userMsg: ChatMsg = { id: uid(), role: 'user', text, at: Date.now(), device: opts.device };
    chat.push(userMsg);
    this.store.touch('chat');
    this.push({ type: 'say', turn, heard: text, state: 'thinking' });
    const speak = this.settings.speak;
    let reply = '';
    const uses: ToolUse[] = [];
    try {
      // "Turn the volume down and open Safari" is two requests: handle each on its own, so neither is dropped.
      const routine = this.quiz ? undefined : this.matchRoutine(text);
      // While a quiz is running the whole message is one answer, even if it contains "and".
      for (const part of this.quiz ? [text] : routine ? routine.steps : splitCommands(text)) {
        if (this.activeTurn !== turn) break;
        const lead = reply ? ' ' : '';
        const piece = await this.answer(turn, part, history, uses, speak, lead);
        reply += lead + piece;
      }
    } catch (err) {
      const sorry = /not been downloaded/.test(String(err)) ? "My language model isn't installed yet. Open Settings and I'll download it." : `Something went wrong on my side: ${(err as Error).message}`;
      this.push({ type: 'say', turn, delta: (reply ? ' ' : '') + sorry, error: (err as Error).message });
      if (speak) void this.speakOut(turn, sorry);
      reply += (reply ? ' ' : '') + sorry;
    }
    if (speak) void this.speakOut(turn, '', true);
    const mk = this.marks.get(turn);
    const msg: ChatMsg = { id: uid(), role: 'assistant', text: reply, at: Date.now(), tools: uses.length ? uses : undefined, timing: mk ? { asr: mk.asr, think: mk.think } : undefined };
    chat.push(msg);
    this.store.touch('chat');
    this.push({ type: 'say', turn, done: true, state: 'idle' });
    this.patch({ chat: chat.slice(-60) });
    if (this.activeTurn === turn && !speak) this.activeTurn = '';
    // Commands are not facts about the person: only learn from conversation (or an explicit "remember").
    // Note-taking waits a moment and gives way to the next question, so it never slows a reply.
    if (!uses.length || /\bremember\b/i.test(text)) setTimeout(() => this.activeTurn === '' || this.activeTurn === turn ? void this.learn(text) : undefined, 2500);
    return msg;
  }

  /** Answer one request: instantly if it is an everyday command, otherwise with the language model and its tools. */
  private async answer(turn: string, text: string, history: { role: 'user' | 'assistant'; text: string }[], uses: ToolUse[], speak: boolean, lead: string): Promise<string> {
    const fast = await this.quick(text).catch(() => null);
    if (fast) {
      if (fast.tool) (uses.push(fast.tool), this.push({ type: 'say', turn, tool: fast.tool }));
      this.mark(turn, 'think');
      this.push({ type: 'say', turn, delta: lead + fast.reply, state: 'speaking' });
      // Long replies (a briefing, a review) are voiced a sentence at a time, so speech starts at once.
      if (speak) for (const sentence of takeSentences(fast.reply, true).sentences) void this.speakOut(turn, sentence);
      return fast.reply;
    }
    await this.ensureLlm();
    // Web search only for questions about the outside world; action tools only for requests to do
    // something, and then only the two or three the wording points at.
    const outward = /\b(search|look up|google|find out|news|latest|headline|who (is|was|were|won|invented|wrote)|what (is|are|was|were) (the|a|an)\b|when (is|was|did|does)|where (is|are|was)|how (many|much|far|old|tall|long|do|does|did)|price of|score|define|meaning of|capital of)\b/i.test(text) && !/\b(my|mine|me|i|i'm|i've|we|our)\b/i.test(text) && !this.aboutHark(text) && !this.aboutStudy(text) && !/\b(clipboard|copied|pasted)\b/i.test(text);
    const names = toolsFor(text, wantsAction(text), outward);
    const tools = this.tools().filter((t) => names.includes(t.name));
    // Answers drawn from notes, recordings or the clipboard may need a third sentence; chat does not.
    const maxSentences = this.aboutStudy(text) || this.aboutHark(text) || /\b(clipboard|copied|pasted|explain|summar)/i.test(text) ? 3 : 2;
    let raw = '';
    let shown = '';
    let said = 0; // how much of `shown` has been handed to the voice
    let reply = '';
    let first = true;
    let stopped = false;
    // A law question the notes can't answer: say where the answer is coming from before giving it.
    // (Said by Jarvis himself, not left to the model, so it is never skipped.)
    if (this.vocab.size && looksLegal(text) && !studyContext(this.library, this.vocab, text)) {
      const caveat = "That isn't in your notes, so this is from my own memory and needs checking.";
      reply = caveat + ' ';
      this.mark(turn, 'think');
      this.push({ type: 'say', turn, delta: lead + reply, state: 'speaking' });
      first = false;
      if (speak) void this.speakOut(turn, caveat);
    }
    const before = uses.length;
    /** Hand finished sentences to the voice. A very short opener ("Sure.") waits for the next sentence, so speech doesn't start, stall, then start again. */
    const voice = (final: boolean): void => {
      if (!speak) return;
      const cut = takeSentences(shown.slice(said), final);
      if (!cut.sentences.length) return;
      if (!final && said === 0 && cut.sentences.length === 1 && cut.sentences[0].length < 28) return;
      for (const sentence of cut.sentences) void this.speakOut(turn, sentence);
      said = shown.length - cut.rest.length;
    };
    const onChunk = (c: { streamId: string; delta: string }) => {
      if (c.streamId !== turn || this.activeTurn !== turn || stopped) return;
      raw += c.delta;
      let next = visibleText(raw);
      // Enough has been said: stop the model there rather than let it ramble.
      const whole = takeSentences(next);
      if (whole.sentences.length >= maxSentences) {
        next = whole.sentences.slice(0, maxSentences).join(' ');
        stopped = true;
        void this.llm.call('abort', { streamId: turn }).catch(() => undefined);
      }
      if (next.length <= shown.length) return;
      const delta = next.slice(shown.length);
      shown = next;
      this.mark(turn, 'think');
      this.push({ type: 'say', turn, delta: (first ? lead : '') + delta, state: 'speaking' });
      first = false;
      voice(stopped);
    };
    const done = new Set<string>();
    let calls = 0;
    const onTool = async (c: { streamId: string; callId: string; name: string; args: any }) => {
      if (c.streamId !== turn) return;
      const tool = tools.find((t) => t.name === c.name);
      let result = 'Unknown tool.';
      let ok = false;
      const sig = `${c.name}:${JSON.stringify(c.args ?? {})}`;
      try {
        // One request, one or two actions: a model that keeps reaching for tools is stopped, not obeyed.
        if (!tool || done.has(sig) || ++calls > 2) {
          await this.llm.call('toolResult', { callId: c.callId, result: done.has(sig) ? 'That was already done a moment ago.' : 'No further actions are needed. Reply to the user now.' }).catch(() => undefined);
          return;
        }
        done.add(sig);
        result = await tool.run(c.args ?? {});
        ok = true;
      } catch (err) {
        result = `That failed: ${(err as Error).message}`;
      }
      const use = { name: c.name, label: tool ? (ok ? tool.label(c.args ?? {}) : `${c.name} failed`) : c.name, ok };
      uses.push(use);
      this.push({ type: 'say', turn, tool: use });
      await this.llm.call('toolResult', { callId: c.callId, result }).catch(() => undefined);
    };
    this.llm.on('chunk', onChunk);
    this.llm.on('tool', onTool);
    try {
      const final = await this.llm.call<string>('generate', {
        streamId: turn,
        system: this.persona(),
        history,
        prompt: `<context>\n${await this.context(text)}\n</context>\n\n${text}`,
        ...(tools.length ? { tools: tools.map(({ name, description, params }) => ({ name, description, params })) } : {}),
        maxTokens: 160,
        temperature: 0.5,
      });
      if (!shown.trim() && !stopped && final) {
        shown = takeSentences(visibleText(final), true).sentences.slice(0, maxSentences).join(' ');
        if (shown) this.push({ type: 'say', turn, delta: (first ? lead : '') + shown, state: 'speaking' });
      }
    } finally {
      this.llm.off('chunk', onChunk);
      this.llm.off('tool', onTool);
    }
    if (!shown.trim()) {
      shown = uses.length > before && uses.slice(before).some((u) => u.ok) ? 'Done.' : reply ? '' : "Sorry, I didn't catch that properly. Could you say it another way?";
      if (shown) this.push({ type: 'say', turn, delta: (first ? lead : '') + shown, state: 'speaking' });
    }
    voice(true);
    reply += shown;
    return reply.replace(/\s*\n+\s*/g, ' ').trim();
  }

  /** The morning briefing: built from real data, so it is instant and never made up. */
  briefingText(): string {
    const s = this.settings;
    const now = new Date();
    const h = now.getHours();
    const P: string[] = [`Good ${h < 12 ? 'morning' : h < 18 ? 'afternoon' : 'evening'}, ${this.you()}. It's ${now.toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long' })}.`];
    if (this.weather) P.push(`It's ${weatherSentence(this.weather)}.`);
    const end = new Date().setHours(23, 59, 59, 999);
    const today = this.events.filter((e) => !eventOver(e) && e.start <= end && e.end > now.getTime());
    if (today.length) P.push(`You have ${today.length} thing${today.length === 1 ? '' : 's'} on today: ${today.slice(0, 4).map((e) => `${e.title}${e.allDay ? '' : ' at ' + new Date(e.start).toLocaleTimeString('en-GB', { hour: 'numeric', minute: '2-digit', hour12: true }).replace(':00', '').replace(' ', '')}`).join(', ')}.`);
    else P.push('Your calendar is clear today.');
    const open = this.store.get('tasks').filter((t) => !t.done);
    const overdue = open.filter((t) => t.due && t.due < now.getTime());
    const due = open.filter((t) => t.due && t.due >= now.getTime() && t.due <= end);
    if (overdue.length) P.push(`${overdue.length === 1 ? 'One task is' : `${overdue.length} tasks are`} overdue, starting with ${overdue[0].title.toLowerCase()}.`);
    if (due.length) P.push(`Due today: ${due.slice(0, 3).map((t) => t.title.toLowerCase()).join(', ')}.`);
    else if (!overdue.length) P.push(open.length ? `Nothing is due today, and there ${open.length === 1 ? 'is one item' : `are ${open.length} items`} on your list.` : 'Your to-do list is empty.');
    if (this.unread) P.push(`You have ${this.unread} unread email${this.unread === 1 ? '' : 's'}${this.mail.length ? `, including one from ${this.mail[0].from}` : ''}.`);
    const bill = this.needs().find((n) => n.id === 'bill');
    if (bill) P.push(`${bill.text}.`);
    for (const c of this.store.get('countdowns').filter((x) => daysUntil(x.date) >= 0 && daysUntil(x.date) <= 14).sort((a, b) => a.date - b.date).slice(0, 2)) P.push(`${c.title} is ${inDays(daysUntil(c.date))}.`);
    const habits = this.store.get('habits');
    const dueNow = this.studyView().due;
    if (dueNow) P.push(`${dueNow} flashcard${dueNow === 1 ? ' is' : 's are'} due for revision.`);
    const alive = habits.filter((x) => streak(x.days) >= 2 && !doneToday(x));
    if (alive.length) P.push(`Keep ${alive.length === 1 ? `your ${alive[0].name.toLowerCase()} streak` : `${alive.length} habit streaks`} going today.`);
    else if (habits.length) P.push(`${habits.length} habit${habits.length === 1 ? '' : 's'} to tick off today.`);
    P.push(['That is everything for now.', "That's the lot.", 'I will be here if you need me.'][now.getDate() % 3]);
    void s;
    return P.join(' ');
  }

  async briefing(): Promise<ChatMsg> {
    const turn = `t${++this.turnSeq}`;
    this.activeTurn = turn;
    const text = this.briefingText();
    this.push({ type: 'say', turn, delta: text, state: 'speaking' });
    const msg: ChatMsg = { id: uid(), role: 'assistant', text, at: Date.now() };
    this.store.get('chat').push(msg);
    this.store.touch('chat');
    if (this.settings.speak) {
      const parts = takeSentences(text, true).sentences;
      parts.forEach((p, i) => void this.speakOut(turn, p, i === parts.length - 1));
    }
    this.push({ type: 'say', turn, done: true, state: 'idle' });
    this.patch({ chat: this.store.get('chat').slice(-60) });
    return msg;
  }

  // ------------------------------------------------------------------ direct actions from the interface

  /** Bring Jarvis forward and start listening (the global hotkey and the menu-bar icon call this). */
  summon(): void {
    this.push({ type: 'summon' });
  }

  readonly actions: Record<string, (p: any) => unknown> = {
    saveSettings: (p: Partial<Settings>) => this.patchSettings(p),
    say: (p: { text: string; device?: string }) => void this.say(p.text, p),
    hear: (p: { pcm: string; device?: string; needWake?: boolean }) => this.hear(p.pcm, p),
    stop: () => this.stopTalking(),
    briefing: () => void this.briefing(),
    previewVoice: (p: { voice: string }) => this.previewVoice(p.voice),
    macVoices: () => this.o.mac.voices().catch(() => []),
    /** Which cloud voices are set up, and the voices each offers. */
    cloudVoices: async () => {
      const k = this.store.get('secrets');
      const out: { eleven: CloudVoice[] | null; openai: CloudVoice[] | null; error?: string } = { eleven: null, openai: k.openaiKey ? OPENAI_VOICES : null };
      if (k.elevenKey) {
        try {
          out.eleven = await elevenVoices(this.o.fetch, k.elevenKey);
        } catch (err) {
          out.eleven = [];
          out.error = (err as Error).message;
        }
      }
      return out;
    },
    /** Save (or, with an empty key, remove) a cloud voice key, after checking it works. */
    saveVoiceKey: async (p: { provider: 'eleven' | 'openai'; key: string }) => {
      const key = String(p.key ?? '').trim();
      const field = p.provider === 'eleven' ? 'elevenKey' : 'openaiKey';
      if (!key) {
        this.store.set('secrets', { ...this.store.get('secrets'), [field]: undefined });
        if (this.settings.voice.startsWith(`${p.provider}:`)) this.patchSettings({ voice: DEFAULT_SETTINGS.voice });
        return { ok: true, voices: [] };
      }
      const voices = p.provider === 'eleven' ? await elevenVoices(this.o.fetch, key) : (await openaiCheck(this.o.fetch, key), OPENAI_VOICES);
      this.store.set('secrets', { ...this.store.get('secrets'), [field]: key });
      return { ok: true, voices };
    },
    clearChat: () => (this.store.set('chat', []), this.patch({ chat: [] })),
    addTask: (p: { title: string; when?: string }) => this.tools().find((t) => t.name === 'add_task')!.run(p),
    updateTask: (p: { id: string; patch: Partial<Task> }) => {
      const t = this.store.get('tasks').find((x) => x.id === p.id);
      if (!t) return;
      Object.assign(t, p.patch, p.patch.done ? { doneAt: Date.now() } : {}, p.patch.due ? { notified: false } : {});
      this.store.touch('tasks');
      this.patch({ tasks: this.store.get('tasks'), needs: this.needs() });
    },
    deleteTask: (p: { id: string }) => (this.store.set('tasks', this.store.get('tasks').filter((t) => t.id !== p.id)), this.patch({ tasks: this.store.get('tasks'), needs: this.needs() })),
    addNote: (p: { text: string }) => this.tools().find((t) => t.name === 'add_note')!.run(p),
    updateNote: (p: { id: string; text: string }) => {
      const n = this.store.get('notes').find((x) => x.id === p.id);
      if (n) (n.text = p.text), (n.at = Date.now());
      this.store.touch('notes');
      this.patch({ notes: this.store.get('notes') });
    },
    deleteNote: (p: { id: string }) => (this.store.set('notes', this.store.get('notes').filter((n) => n.id !== p.id)), this.patch({ notes: this.store.get('notes') })),
    addMoney: (p: { name: string; amount: number; every?: string; kind?: string; day?: number }) => {
      this.store.get('money').push({ id: uid(), name: p.name, amount: Number(p.amount) || 0, every: (p.every as never) ?? 'month', kind: (p.kind as never) ?? 'bill', day: p.day, at: Date.now() });
      this.store.touch('money');
      this.patch({ money: this.store.get('money'), needs: this.needs() });
    },
    deleteMoney: (p: { id: string }) => (this.store.set('money', this.store.get('money').filter((m) => m.id !== p.id)), this.patch({ money: this.store.get('money') })),
    addMemory: (p: { text: string }) => this.remember(p.text, 'you').then(() => true),
    updateMemory: (p: { id: string; pinned?: boolean; text?: string }) => {
      const m = this.store.get('memories').find((x) => x.id === p.id);
      if (!m) return;
      if (p.pinned !== undefined) m.pinned = p.pinned;
      if (p.text !== undefined) (m.text = p.text), (m.v = undefined);
      this.store.touch('memories');
      this.patch({ memories: this.snapshot().memories });
    },
    deleteMemory: (p: { id: string }) => (this.store.set('memories', this.store.get('memories').filter((m) => m.id !== p.id)), this.patch({ memories: this.snapshot().memories })),
    addTimer: (p: { minutes: number; label?: string }) => this.tools().find((t) => t.name === 'set_timer')!.run(p),
    cancelTimer: (p: { id: string }) => ((this.timers = this.timers.filter((t) => t.id !== p.id)), this.patch({ timers: this.timers })),
    music: async (p: { action: 'play' | 'pause' | 'toggle' | 'next' | 'previous' | 'volume'; value?: number }) => {
      await this.o.mac.musicControl(this.settings.musicApp, p.action, p.value);
      setTimeout(() => void this.refreshMusic(), 500);
    },
    runShortcut: (p: { name: string }) => this.o.mac.runShortcut(p.name),
    allShortcuts: () => this.o.mac.shortcuts().catch(() => []),
    refresh: () => this.refreshAll(),
    openUrl: (p: { url: string }) => (/^https:\/\/(myaccount\.google\.com|elevenlabs\.io|platform\.openai\.com|support\.google\.com)\//.test(String(p.url)) ? this.o.mac.openUrl(String(p.url)) : undefined),
    diagnose: () => this.diagnose(),
    downloadModel: (p: { id: string }) => void this.models.download(p.id),
    cancelDownload: (p: { id: string }) => this.models.cancel(p.id),
    tapHome: async (p: { id: string }) => {
      const e = this.haEntities.find((x) => x.id === p.id);
      if (!e) throw new Error('That device is no longer available.');
      const svc = tapService(e);
      await this.haCall([e], svc.domain, svc.service);
      return true;
    },
    /** Save the Home Assistant address and token, after checking they work. */
    saveHomeAssistant: async (p: { url: string; token?: string }) => {
      const url = String(p.url ?? '').trim().replace(/\/+$/, '');
      const token = p.token?.trim() || this.store.get('secrets').haToken || '';
      if (!url) {
        this.store.set('secrets', { ...this.store.get('secrets'), haToken: undefined });
        this.patchSettings({ haUrl: '', haEntities: [] });
        await this.refreshHome();
        return { ok: true, devices: 0 };
      }
      if (!/^https?:\/\//i.test(url)) throw new Error('The address should start with http:// or https://');
      if (!token) throw new Error('Paste a long-lived access token from Home Assistant.');
      const devices = (await new HomeAssistant(this.o.fetch, url, token).states()).filter((e) => e.domain !== 'sensor').length;
      this.store.set('secrets', { ...this.store.get('secrets'), haToken: token });
      this.patchSettings({ haUrl: url });
      await this.refreshHa();
      return { ok: true, devices };
    },
    allHaEntities: () => this.haEntities.filter((e) => e.domain !== 'sensor').map((e) => ({ id: e.id, name: e.name, domain: e.domain })),
    /** Add a mail account, after checking the server accepts it. */
    saveMailAccount: async (p: { preset: string; host?: string; port?: number; user: string; pass: string }) => {
      const preset = MAIL_PRESETS[p.preset] ?? MAIL_PRESETS.other;
      const host = (preset.host || String(p.host ?? '')).trim(), user = String(p.user ?? '').trim(), pass = String(p.pass ?? '').replace(/\s+/g, p.preset === 'gmail' ? '' : ' ').trim();
      if (!host || !user || !pass) throw new Error('Fill in the server, your email address and the app password.');
      const acc = { id: uid(), label: user, host, port: Number(p.port) || preset.port, user };
      const found = await fetchUnread({ ...acc, pass }, 1);
      this.store.set('secrets', { ...this.store.get('secrets'), mail: { ...(this.store.get('secrets').mail ?? {}), [acc.id]: pass } });
      this.patchSettings({ mailAccounts: [...this.settings.mailAccounts.filter((a) => a.user !== user || a.host !== host), acc] });
      return { ok: true, unread: found.unread };
    },
    deleteMailAccount: (p: { id: string }) => {
      const mail = { ...(this.store.get('secrets').mail ?? {}) };
      delete mail[p.id];
      this.store.set('secrets', { ...this.store.get('secrets'), mail });
      this.patchSettings({ mailAccounts: this.settings.mailAccounts.filter((a) => a.id !== p.id) });
    },
    startQuiz: (p: { deck?: string; device?: string }) => void this.say(p.deck ? `Quiz me on ${p.deck}` : 'Quiz me', p),
    syncStudy: async () => {
      await this.syncStudy(true);
      return { ok: !this.studyError, error: this.studyError || undefined, cards: this.studyView().cards, notes: this.library.notes.length };
    },
    startFocus: (p: { minutes: number; subject?: string }) => void this.startFocus(p.minutes, p.subject ?? ''),
    stopFocus: () => this.endFocus(),
    addHabit: (p: { name: string }) => {
      const name = tidy(String(p.name ?? ''));
      if (!name || this.store.get('habits').some((h) => h.name.toLowerCase() === name.toLowerCase())) return;
      this.store.get('habits').push({ id: uid(), name, days: [], at: Date.now() });
      this.store.touch('habits');
      this.patch({ habits: this.store.get('habits'), needs: this.needs() });
    },
    toggleHabit: (p: { id: string }) => {
      const h = this.store.get('habits').find((x) => x.id === p.id);
      if (h) this.setHabit(h, !doneToday(h));
    },
    deleteHabit: (p: { id: string }) => (this.store.set('habits', this.store.get('habits').filter((h) => h.id !== p.id)), this.patch({ habits: this.store.get('habits'), needs: this.needs() })),
    addCountdown: (p: { title: string; when: string }) => {
      const date = parseWhen(String(p.when));
      const title = tidy(String(p.title ?? ''));
      if (!date || !title) throw new Error('I could not understand that date. Try “12 January” or “2027-01-12”.');
      this.store.get('countdowns').push({ id: uid(), title, date });
      this.store.touch('countdowns');
      this.patch({ countdowns: this.store.get('countdowns'), needs: this.needs() });
    },
    deleteCountdown: (p: { id: string }) => (this.store.set('countdowns', this.store.get('countdowns').filter((c) => c.id !== p.id)), this.patch({ countdowns: this.store.get('countdowns'), needs: this.needs() })),
    saveRoutine: (p: { id?: string; name: string; steps: string[] }) => {
      const name = String(p.name ?? '').trim();
      const steps = (p.steps ?? []).map((x) => String(x).trim()).filter(Boolean).slice(0, 8);
      if (!name) return;
      const list = this.store.get('routines');
      const cur = list.find((r) => r.id === p.id);
      if (cur) (cur.name = name), (cur.steps = steps);
      else list.push({ id: uid(), name, steps });
      this.store.touch('routines');
      this.patch({ routines: list });
    },
    deleteRoutine: (p: { id: string }) => (this.store.set('routines', this.store.get('routines').filter((r) => r.id !== p.id)), this.patch({ routines: this.store.get('routines') })),
    runRoutine: (p: { name: string; device?: string }) => void this.say(p.name, p),
    review: () => void this.say('Evening review'),
    exportData: () => this.store.exportAll(),
    importData: (p: { json: string }) => {
      this.store.importAll(p.json);
      this.patch(this.snapshot());
      return true;
    },
  };
}
