/** Everything Jarvis knows, as plain JSON files in one folder on this computer. */
import fs from 'node:fs';
import path from 'node:path';
import { DEFAULT_SETTINGS } from '../shared/types';
import type { ChatMsg, CalEvent, Countdown, Focus, Habit, Memory, Money, Note, Routine, Settings, Task } from '../shared/types';

type Shape = { settings: Settings; tasks: Task[]; notes: Note[]; money: Money[]; memories: Memory[]; chat: ChatMsg[]; events: CalEvent[]; focus: Focus[]; habits: Habit[]; countdowns: Countdown[]; routines: Routine[]; secrets: { haToken?: string; mail?: Record<string, string> }; meta: { token: string; lastBriefing?: string } };

const FILES: (keyof Shape)[] = ['settings', 'tasks', 'notes', 'money', 'memories', 'chat', 'events', 'focus', 'habits', 'countdowns', 'routines', 'secrets', 'meta'];

export class Store {
  private data: Shape;
  private dirty = new Set<keyof Shape>();
  private timer: ReturnType<typeof setTimeout> | null = null;

  constructor(readonly dir: string) {
    fs.mkdirSync(dir, { recursive: true });
    const read = <T>(name: string, fallback: T): T => {
      try {
        return JSON.parse(fs.readFileSync(path.join(dir, `${name}.json`), 'utf8')) as T;
      } catch {
        return fallback;
      }
    };
    this.data = {
      settings: { ...DEFAULT_SETTINGS, ...read<Partial<Settings>>('settings', {}) },
      tasks: read('tasks', []), notes: read('notes', []), money: read('money', []), memories: read('memories', []),
      chat: read('chat', []), events: read('events', []), focus: read('focus', []), habits: read('habits', []), countdowns: read('countdowns', []),
      // Two starter routines; edit or delete them in Settings.
      routines: read('routines', [
        { id: 'r-morning', name: 'Good morning', steps: ['briefing'] },
        { id: 'r-night', name: 'Good night', steps: ['pause the music', 'evening review'] },
      ]),
      // Passwords and tokens live in their own file, are never sent to the interface and are left out of exports.
      secrets: read('secrets', {}),
      meta: read('meta', { token: '' }),
    };
    if (!this.data.meta.token) {
      this.data.meta.token = Array.from({ length: 24 }, () => 'abcdefghjkmnpqrstuvwxyz23456789'[Math.floor(Math.random() * 31)]).join('');
      this.touch('meta');
    }
  }

  get<K extends keyof Shape>(key: K): Shape[K] {
    return this.data[key];
  }

  set<K extends keyof Shape>(key: K, value: Shape[K]): void {
    this.data[key] = value;
    this.touch(key);
  }

  /** Mark a collection changed; writes are batched a moment later. */
  touch(key: keyof Shape): void {
    this.dirty.add(key);
    this.timer ??= setTimeout(() => this.flush(), 150);
  }

  flush(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    for (const key of this.dirty) {
      const file = path.join(this.dir, `${key}.json`);
      const tmp = `${file}.${process.pid}.tmp`;
      const value = key === 'chat' ? this.data.chat.slice(-400) : this.data[key];
      fs.writeFileSync(tmp, JSON.stringify(value), key === 'secrets' ? { mode: 0o600 } : undefined);
      fs.renameSync(tmp, file);
    }
    this.dirty.clear();
  }

  /** One file with everything, for backup or moving to another computer. */
  exportAll(): string {
    return JSON.stringify(Object.fromEntries(FILES.filter((f) => f !== 'meta' && f !== 'secrets').map((f) => [f, this.data[f]])));
  }

  importAll(json: string): void {
    const incoming = JSON.parse(json) as Partial<Shape>;
    for (const f of FILES) {
      if (f === 'meta' || f === 'secrets' || incoming[f] === undefined) continue;
      (this.data as Record<string, unknown>)[f] = f === 'settings' ? { ...DEFAULT_SETTINGS, ...incoming.settings } : incoming[f];
      this.touch(f);
    }
  }
}
