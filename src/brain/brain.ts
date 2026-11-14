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
import { readPage, webSearch, wikipedia } from './web';
import { describeWhen, parseWhen, speakable, takeSentences } from '../shared/when';
import { uid } from '../shared/types';
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
};

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
    weather: { state: 'setup' }, calendar: { state: 'off' }, mail: { state: 'off' }, music: { state: 'off' }, home: { state: 'off' }, system: { state: 'ok' },
  };
  private lastCpu = os.cpus().map((c) => c.times);
  private turnSeq = 0;
  private activeTurn = '';
  private intervals: ReturnType<typeof setInterval>[] = [];
  private toolRuns = new Map<string, ToolUse[]>();
  private announced = new Set<string>();
  readonly ramGb = Math.round(os.totalmem() / 2 ** 30);

  constructor(private o: BrainOptions) {
    super();
    this.store = new Store(o.dataDir);
    this.models = new Models(o.modelsDir, o.fetch as never);
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
    void this.ensureAsr().catch(() => undefined);
    void this.ensureVoice().catch(() => undefined);
    setTimeout(() => void this.ensureLlm().catch(() => undefined), 1500);
    const every = (ms: number, fn: () => unknown) => {
      this.intervals.push(setInterval(() => void fn(), ms));
      void fn();
    };
    every(15 * 60e3, () => this.refreshWeather());
    every(4e3, () => this.refreshMusic());
    every(120e3, () => this.refreshMail());
    every(10 * 60e3, () => this.refreshCalendar());
    every(10 * 60e3, () => this.refreshHome());
    every(5e3, () => this.refreshVitals());
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
      this.llmInfo = await this.llm.call('load', { modelPath: process.env.JARVIS_LLM_FILE || this.models.llmPath(id), contextSize: this.ramGb >= 14 ? 8192 : 6144 });
      this.llmLoaded = id;
      this.refreshStatus({ llm: 'ready', gpu: this.llmInfo!.gpu });
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
      this.setIntegration('weather', 'error', (err as Error).message);
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
    if (!this.settings.useAppleMail) return this.setIntegration('mail', 'off', 'Turned off in Settings');
    try {
      const m = await this.o.mac.mail();
      if (!m) return this.setIntegration('mail', 'off', 'Open the Mail app to see your inbox');
      this.mail = m.items;
      this.unread = m.unread;
      this.setIntegration('mail', 'ok');
      this.patch({ mail: this.mail, unread: this.unread, needs: this.needs() });
    } catch (err) {
      this.setIntegration('mail', 'error', (err as Error).message);
    }
  }

  async refreshCalendar(): Promise<void> {
    const s = this.settings;
    const from = Date.now() - 36e5, to = Date.now() + 14 * 864e5;
    const all: CalEvent[] = this.store.get('events').filter((e) => e.end >= from && e.start <= to).map((e) => ({ ...e, calendar: 'Jarvis' }));
    let ok = false, problem = '';
    for (const url of s.calendarUrls) {
      try {
        const res = await this.o.fetch(url.replace(/^webcal:/, 'https:'));
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
      return seen.has(k) ? false : (seen.add(k), true);
    });
    this.setIntegration('calendar', ok ? 'ok' : problem ? 'error' : all.length ? 'ok' : 'setup', ok ? undefined : problem || 'Add a calendar in Settings');
    this.patch({ events: this.events, needs: this.needs() });
  }

  async refreshHome(): Promise<void> {
    try {
      const all = await this.o.mac.shortcuts();
      const chosen = this.settings.homeShortcuts;
      this.home = (chosen.length ? all.filter((n) => chosen.includes(n)) : all.slice(0, 8)).map((name) => ({ id: name, name }));
      this.setIntegration('home', all.length ? 'ok' : 'setup', all.length ? undefined : 'Create a shortcut in the Shortcuts app');
      this.patch({ home: this.home });
    } catch (err) {
      this.setIntegration('home', 'error', (err as Error).message);
    }
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
  private tick(): void {
    const now = Date.now();
    const done = this.timers.filter((t) => t.endsAt <= now);
    if (done.length) {
      this.timers = this.timers.filter((t) => t.endsAt > now);
      this.patch({ timers: this.timers });
      for (const t of done) this.announce(`${t.label || 'Timer'} finished`, `Your ${t.label ? t.label + ' ' : ''}timer is up.`, `${this.you()}, your ${t.label ? t.label + ' ' : ''}timer is up.`);
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
    const next = this.events.find((e) => e.start > now && e.start - now < 3 * 36e5 && !e.allDay);
    if (next) out.push({ id: 'next', tone: 'info', text: `${next.title} in ${Math.max(1, Math.round((next.start - now) / 6e4))} min` });
    if (this.unread) out.push({ id: 'mail', tone: 'info', text: `${this.unread} unread email${this.unread === 1 ? '' : 's'}` });
    const dom = new Date().getDate();
    const bill = this.store.get('money').find((m) => m.kind === 'bill' && m.every === 'month' && m.day && m.day - dom >= 0 && m.day - dom <= 2);
    if (bill) out.push({ id: 'bill', tone: 'warn', text: `${bill.name} (${s.currency}${bill.amount}) is due ${bill.day === dom ? 'today' : `in ${bill.day! - dom} day${bill.day! - dom === 1 ? '' : 's'}`}` });
    if (this.weather?.days[0] && this.weather.days[0].rain >= 70) out.push({ id: 'rain', tone: 'info', text: `Rain likely today (${this.weather.days[0].rain}%)` });
    for (const [k, v] of Object.entries(this.integrations)) if (v.state === 'error') out.push({ id: `int-${k}`, tone: 'warn', text: `${k[0].toUpperCase() + k.slice(1)}: ${v.detail ?? 'not responding'}`, action: { view: 'settings' } });
    if (!s.place) out.push({ id: 'place', tone: 'info', text: 'Tell me your town for local weather', action: { view: 'settings' } });
    return out.slice(0, 6);
  }

  snapshot(lan: string[] = []): Snapshot {
    return {
      settings: this.settings, tasks: this.store.get('tasks'), notes: this.store.get('notes'), money: this.store.get('money'),
      memories: this.store.get('memories').map(({ v: _v, ...m }) => m), timers: this.timers, chat: this.store.get('chat').slice(-60),
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
    const name = this.settings.userName || 'The user';
    try {
      const raw = await this.llm.call<string>('generate', {
        streamId: `learn${++this.turnSeq}`,
        system: 'You maintain a personal assistant\'s long-term memory. You are precise and never invent details.',
        prompt: `${name} said: "${text}"\n\nList any lasting personal facts worth remembering about ${name} from this message: preferences, people in their life, places, routines, work or study, goals, important dates. Ignore one-off requests, questions and small talk. Write each fact as one short sentence starting with "${name}". If there is nothing lasting, reply with exactly NONE.`,
        maxTokens: 120,
        temperature: 0.1,
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
        name: 'music', description: `Control ${s.musicApp}: play, pause, skip, go back, set volume (0-100), or search for something to play.`,
        params: { type: 'object', properties: { action: { type: 'string', enum: ['play', 'pause', 'next', 'previous', 'volume', 'search'] }, value: { type: 'string', description: 'Volume number, or what to search for' } }, required: ['action'] },
        label: ({ action }) => `Music: ${action}`,
        run: async ({ action, value }) => {
          await mac.musicControl(s.musicApp, action, value);
          setTimeout(() => void this.refreshMusic(), 600);
          return 'Done.';
        },
      },
      ...(this.home.length
        ? [{
            name: 'run_shortcut', description: `Run one of the user's Shortcuts (home and device automations). Available: ${this.home.map((h) => h.name).join(', ')}.`,
            params: { type: 'object', properties: { name: { type: 'string', enum: this.home.map((h) => h.name) } }, required: ['name'] },
            label: ({ name }: { name: string }) => `Ran “${name}”`,
            run: async ({ name }: { name: string }) => {
              await mac.runShortcut(String(name));
              return `Ran ${name}.`;
            },
          } as Tool]
        : []),
      {
        name: 'open', description: 'Open an app or a website on the Mac.', params: str({ target: 'App name (e.g. "Safari") or a full https URL' }), label: ({ target }) => `Opened ${target}`,
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
    if (this.weather) L.push(`Weather: ${weatherSentence(this.weather)}.`);
    const evs = this.events.filter((e) => e.end > now.getTime()).slice(0, 6);
    L.push(evs.length ? `Calendar: ${evs.map((e) => `${e.title} (${describeWhen(e.start)})`).join('; ')}.` : 'Calendar: nothing coming up.');
    const open = this.store.get('tasks').filter((t) => !t.done).slice(0, 10);
    L.push(open.length ? `To-do list: ${open.map((t) => t.title + (t.due ? ` (due ${describeWhen(t.due)})` : '')).join('; ')}.` : 'To-do list: empty.');
    if (this.integrations.mail.state === 'ok') L.push(this.unread ? `Unread email (${this.unread}): ${this.mail.slice(0, 5).map((m) => `${m.from}: “${m.subject}”`).join('; ')}.` : 'No unread email.');
    if (this.music?.title) L.push(`Music: ${this.music.state} “${this.music.title}” by ${this.music.artist}.`);
    if (this.timers.length) L.push(`Timers: ${this.timers.map((t) => `${t.label || 'timer'} with ${Math.ceil((t.endsAt - now.getTime()) / 6e4)} min left`).join('; ')}.`);
    const money = this.store.get('money');
    if (money.length) L.push(`Regular money: ${money.map((m) => `${m.name} ${s.currency}${m.amount}/${m.every} (${m.kind})`).join('; ')}.`);
    const notes = this.store.get('notes').slice(0, 4);
    if (notes.length) L.push(`Recent notes: ${notes.map((n) => `“${n.text.slice(0, 80)}”`).join('; ')}.`);
    const mems = await this.recall(query);
    if (mems.length) L.push(`What you remember about ${s.userName || 'the user'}: ${mems.map((m) => m.text).join(' ')}`);
    return L.join('\n');
  }

  private persona(): string {
    const s = this.settings;
    const who = s.userName || 'the user';
    const address = s.address === 'name' ? (s.userName ? `Call them ${s.userName}, sparingly.` : '') : `Address them as "${this.you()}", sparingly.`;
    return `You are ${s.assistantName}, ${who}'s personal assistant, running privately on their own computer. You are calm, capable and quick, with a dry British wit that you use lightly. ${address}

Your replies are spoken aloud, so write the way a person talks: one to three short sentences, plain words, no lists, no markdown, no emoji. Give the answer first. Never read out raw data such as URLs or IDs.

Each request comes with a <context> block showing the time, weather, calendar, to-do list, email, music and what you remember. Answer from it directly when you can. When the user asks you to do something, use a tool, then confirm in a few words what you did. Use web_search for facts you are not sure of. If something cannot be done, say so plainly. Never claim to have done something unless a tool confirmed it.`;
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
      [/^(pause|stop)( the)?( music| song| track| it)?$/, 'pause', 'Paused.'], [/^(play|resume)( the)?( music| it)?$/, 'play', 'Playing.'],
      [/^(next|skip)( song| track| this| it)?$/, 'next', 'Skipped.'], [/^(previous|last|go back)( song| track)?$/, 'previous', 'Going back one.'],
    ];
    for (const [re, action, reply] of music) if (re.test(t)) return { reply, tool: await use('music', { action }) };
    return null;
  }

  // ------------------------------------------------------------------ conversation

  private speakChain: Promise<void> = Promise.resolve();
  private speakSeq = new Map<string, number>();

  /** Turn text into speech and send it to every connected device, in order. */
  private speakOut(turn: string, text: string, last = false): Promise<void> {
    const clean = speakable(text);
    const s = this.settings;
    this.speakChain = this.speakChain.then(async () => {
      if (!clean && !last) return;
      const seq = this.speakSeq.get(turn) ?? 0;
      this.speakSeq.set(turn, seq + 1);
      if (!clean || !this.models.installed('voice') || (this.activeTurn !== turn && !turn.startsWith('n') && !turn.startsWith('p'))) {
        if (last) this.push({ type: 'audio', turn, seq, wav: '', text: '', last: true });
        return;
      }
      try {
        await this.ensureVoice();
        const out = await this.voice.call<{ pcm: string; rate: number }>('speak', { text: clean, voice: s.voice, speed: s.speed });
        this.push({ type: 'audio', turn, seq, wav: `${out.rate}:${out.pcm}`, text: clean, last });
      } catch {
        if (last) this.push({ type: 'audio', turn, seq, wav: '', text: '', last: true });
      }
    });
    return this.speakChain;
  }

  async previewVoice(voice: string): Promise<void> {
    const turn = `p${++this.turnSeq}`;
    const s = this.settings;
    await this.ensureVoice();
    const out = await this.voice.call<{ pcm: string; rate: number }>('speak', { text: `Good ${new Date().getHours() < 12 ? 'morning' : new Date().getHours() < 18 ? 'afternoon' : 'evening'}${s.userName ? ', ' + s.userName : ''}. All systems are online.`, voice, speed: s.speed });
    this.push({ type: 'audio', turn, seq: 0, wav: `${out.rate}:${out.pcm}`, text: '', last: true });
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
    const heard = await this.speech.call<string>('transcribe', { pcm, language: 'en' });
    if (!heard || heard.replace(/[^a-z]/gi, '').length < 2) return { heard: '', ignored: true };
    if (opts.needWake) {
      const name = this.settings.assistantName.toLowerCase();
      // Whisper hears the name a few ways.
      const variants = name === 'jarvis' ? ['jarvis', 'jervis', 'jarvas', 'javis', 'jarves', 'jarvus', 'travis'] : [name];
      const low = heard.toLowerCase();
      if (!variants.some((v) => low.includes(v))) return { heard, ignored: true };
    }
    void this.say(heard, { device: opts.device, voice: true });
    return { heard };
  }

  /** One conversational turn. Resolves when the reply text is complete. */
  async say(text: string, opts: { device?: string; voice?: boolean } = {}): Promise<ChatMsg> {
    text = text.trim();
    const turn = `t${++this.turnSeq}`;
    if (this.activeTurn && this.llm.running) void this.llm.call('abort', { streamId: this.activeTurn }).catch(() => undefined);
    this.activeTurn = turn;
    const chat = this.store.get('chat');
    const history = chat.slice(-8).map((c) => ({ role: c.role, text: c.text }));
    const userMsg: ChatMsg = { id: uid(), role: 'user', text, at: Date.now(), device: opts.device };
    chat.push(userMsg);
    this.store.touch('chat');
    this.push({ type: 'say', turn, heard: text, state: 'thinking' });
    const speak = this.settings.speak;
    let reply = '';
    const uses: ToolUse[] = [];
    this.toolRuns.set(turn, uses);
    try {
      const fast = await this.quick(text).catch(() => null);
      if (fast) {
        reply = fast.reply;
        if (fast.tool) (uses.push(fast.tool), this.push({ type: 'say', turn, tool: fast.tool }));
        this.push({ type: 'say', turn, delta: reply, state: 'speaking' });
        if (speak) void this.speakOut(turn, reply, true);
      } else {
        await this.ensureLlm();
        const tools = this.tools();
        let pending = '';
        const onChunk = (c: { streamId: string; delta: string }) => {
          if (c.streamId !== turn || this.activeTurn !== turn) return;
          reply += c.delta;
          this.push({ type: 'say', turn, delta: c.delta, state: 'speaking' });
          if (!speak) return;
          const cut = takeSentences(pending + c.delta);
          pending = cut.rest;
          for (const sentence of cut.sentences) void this.speakOut(turn, sentence);
        };
        const onTool = async (c: { streamId: string; callId: string; name: string; args: any }) => {
          if (c.streamId !== turn) return;
          const tool = tools.find((t) => t.name === c.name);
          let result = 'Unknown tool.';
          let ok = false;
          try {
            if (tool) (result = await tool.run(c.args ?? {})), (ok = true);
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
            tools: tools.map(({ name, description, params }) => ({ name, description, params })),
            maxTokens: 500,
            temperature: 0.5,
          });
          if (final && final.length > reply.trim().length) reply = final;
        } finally {
          this.llm.off('chunk', onChunk);
          this.llm.off('tool', onTool);
        }
        reply = reply.trim() || (uses.some((u) => u.ok) ? 'Done.' : "I'm not sure what to say to that.");
        if (speak) void this.speakOut(turn, pending.trim() ? pending : uses.length && !reply.includes(pending) ? reply : '', true);
      }
    } catch (err) {
      reply = /not been downloaded/.test(String(err)) ? "My language model isn't installed yet. Open Settings and I'll download it." : `Something went wrong on my side: ${(err as Error).message}`;
      this.push({ type: 'say', turn, delta: reply, error: (err as Error).message });
      if (speak) void this.speakOut(turn, reply, true);
    }
    const msg: ChatMsg = { id: uid(), role: 'assistant', text: reply, at: Date.now(), tools: uses.length ? uses : undefined };
    chat.push(msg);
    this.store.touch('chat');
    this.toolRuns.delete(turn);
    this.push({ type: 'say', turn, done: true, state: 'idle' });
    this.patch({ chat: chat.slice(-60) });
    if (this.activeTurn === turn) this.activeTurn = speak ? turn : '';
    void this.learn(text);
    return msg;
  }

  /** The morning briefing: built from real data, so it is instant and never made up. */
  briefingText(): string {
    const s = this.settings;
    const now = new Date();
    const h = now.getHours();
    const P: string[] = [`Good ${h < 12 ? 'morning' : h < 18 ? 'afternoon' : 'evening'}, ${this.you()}. It's ${now.toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long' })}.`];
    if (this.weather) P.push(`It's ${weatherSentence(this.weather)}.`);
    const end = new Date().setHours(23, 59, 59, 999);
    const today = this.events.filter((e) => e.start <= end && e.end > now.getTime());
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

  readonly actions: Record<string, (p: any) => unknown> = {
    saveSettings: (p: Partial<Settings>) => this.patchSettings(p),
    say: (p: { text: string; device?: string }) => void this.say(p.text, p),
    hear: (p: { pcm: string; device?: string; needWake?: boolean }) => this.hear(p.pcm, p),
    stop: () => this.stopTalking(),
    briefing: () => void this.briefing(),
    previewVoice: (p: { voice: string }) => this.previewVoice(p.voice),
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
    refresh: () => Promise.all([this.refreshWeather(), this.refreshMail(), this.refreshCalendar(), this.refreshMusic(), this.refreshHome()]).then(() => true),
    downloadModel: (p: { id: string }) => void this.models.download(p.id),
    cancelDownload: (p: { id: string }) => this.models.cancel(p.id),
    exportData: () => this.store.exportAll(),
    importData: (p: { json: string }) => {
      this.store.importAll(p.json);
      this.patch(this.snapshot());
      return true;
    },
  };
}
