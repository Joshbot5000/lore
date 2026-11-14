/** Focus sessions, habits and countdowns: the small, pure pieces, kept apart from the brain so they are easy to test. */
import type { Countdown, Focus, Habit } from '../shared/types';

const pad = (n: number): string => String(n).padStart(2, '0');
/** The local calendar day of a moment, as YYYY-MM-DD. */
export const dayKey = (t: number | Date = Date.now()): string => {
  const d = new Date(t);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
};
const shift = (key: string, days: number): string => {
  const [y, m, d] = key.split('-').map(Number);
  return dayKey(new Date(y, m - 1, d + days));
};

/** Consecutive days up to today. A streak is still alive if today has not been done yet but yesterday was. */
export function streak(days: string[], today = dayKey()): number {
  const set = new Set(days);
  let cur = set.has(today) ? today : shift(today, -1);
  let n = 0;
  while (set.has(cur)) {
    n++;
    cur = shift(cur, -1);
  }
  return n;
}

export const doneToday = (h: Habit, today = dayKey()): boolean => h.days.includes(today);

/** Whole days from today until a date (0 = today, negative = past). */
export function daysUntil(date: number, now = Date.now()): number {
  const a = new Date(now), b = new Date(date);
  return Math.round((new Date(b.getFullYear(), b.getMonth(), b.getDate()).getTime() - new Date(a.getFullYear(), a.getMonth(), a.getDate()).getTime()) / 864e5);
}

export const inDays = (n: number): string => (n === 0 ? 'today' : n === 1 ? 'tomorrow' : n === -1 ? 'yesterday' : n < 0 ? `${-n} days ago` : n < 14 ? `in ${n} days` : n < 70 ? `in ${Math.round(n / 7)} weeks` : `in ${Math.round(n / 30.4)} months`);

export type FocusStats = { today: number; week: number; streak: number; bySubject: [string, number][]; last7: number[] };

/** Minutes focused today and over the last seven days, the daily streak, and where the week went. */
export function focusStats(sessions: Focus[], now = Date.now()): FocusStats {
  const today = dayKey(now);
  const per = new Map<string, number>();
  for (const s of sessions) per.set(dayKey(s.start), (per.get(dayKey(s.start)) ?? 0) + s.minutes);
  const last7 = Array.from({ length: 7 }, (_, i) => Math.round(per.get(shift(today, i - 6)) ?? 0));
  const weekStart = new Date(now - 6 * 864e5).setHours(0, 0, 0, 0);
  const subjects = new Map<string, number>();
  for (const s of sessions) if (s.start >= weekStart) subjects.set(s.subject || 'General', (subjects.get(s.subject || 'General') ?? 0) + s.minutes);
  return {
    today: last7[6], week: last7.reduce((a, b) => a + b, 0), streak: streak([...per.keys()], today),
    bySubject: [...subjects.entries()].map(([k, v]) => [k, Math.round(v)] as [string, number]).sort((a, b) => b[1] - a[1]),
    last7,
  };
}

/** "95" -> "1 hour 35 minutes", for speaking. */
export const spokenMinutes = (m: number): string => {
  m = Math.round(m);
  if (m < 60) return `${m} minute${m === 1 ? '' : 's'}`;
  const h = Math.floor(m / 60), r = m % 60;
  return `${h} hour${h === 1 ? '' : 's'}${r ? ` ${r} minute${r === 1 ? '' : 's'}` : ''}`;
};

const WORDS: Record<string, number> = { a: 1, an: 1, one: 1, two: 2, three: 3, four: 4, five: 5, ten: 10, fifteen: 15, twenty: 20, 'twenty five': 25, 'twenty-five': 25, thirty: 30, forty: 40, 'forty five': 45, 'forty-five': 45, fifty: 50, sixty: 60, ninety: 90, half: 0.5 };
const NUMBER = `\\d+(?:\\.\\d+)?|${Object.keys(WORDS).sort((a, b) => b.length - a.length).join('|')}`;
const tidy = (s: string): string => s.trim().replace(/^(my|the|some)\s+/i, '').replace(/[.!?]+$/, '').replace(/^./, (c) => c.toUpperCase());

/** "start a 45 minute focus session on contract law", "study tort for an hour", "focus" -> what to time. */
export function parseFocus(text: string): { minutes: number; subject: string } | null {
  const t = text.toLowerCase().replace(/[.!?,]/g, '').replace(/\s+/g, ' ').trim();
  const start = /^(?:start|begin|do|kick off|let'?s (?:start|do|begin|have)) (?:a |an |my |another )?(?:.*?)(focus|study|deep work|pomodoro|revision|work) ?(?:session|block|timer|sprint)?\b/.test(t) && /(focus|study|deep work|pomodoro|revision) ?(session|block|timer|sprint)?|work (session|block|sprint)/.test(t);
  // Only a plain instruction starts a session: "I need to study for my exam" is a remark, not a request.
  const direct = /^(?:let'?s |time to )?(focus|study|revise|concentrate)\b/.test(t);
  if (!start && !direct) return null;
  if (/\b(how|what|when|did|have i|stats?)\b/.test(t)) return null;
  let minutes = 25;
  const half = t.match(/\b(?:an? )?hour and a half\b/);
  const dur = t.match(new RegExp(`\\b(${NUMBER})(?: an?)?[ -]?(minute|min|hour|hr)s?\\b`));
  if (half) minutes = 90;
  else if (dur) minutes = (WORDS[dur[1]] ?? parseFloat(dur[1])) * (/^h/.test(dur[2]) ? 60 : 1);
  let rest = t.replace(/\b(?:for )?(?:an? )?hour and a half\b/, ' ').replace(new RegExp(`\\b(?:for |of )?(?:${NUMBER})(?: an?)?[ -]?(?:minute|min|hour|hr)s?\\b`), ' ');
  rest = rest
    .replace(/^(?:start|begin|do|kick off|let'?s (?:start|do|begin|have)|let'?s|time to|i'?m going to|i want to|i need to)\b/, ' ')
    .replace(/\b(?:a|an|my|another)\b/, ' ')
    .replace(/\b(?:focus(?:ing|ed)?|study(?:ing)?|revis(?:e|ing|ion)|concentrat(?:e|ing)|deep work|pomodoro|work)\b ?(?:session|block|timer|sprint)?/, ' ')
    .replace(/\b(?:session|block|timer|sprint)\b/, ' ')
    .replace(/^\s*(?:on|for|about)\b/, ' ')
    .replace(/\s+/g, ' ').trim()
    .replace(/^(?:on|for|about) /, '').replace(/ (?:now|please)$/, '');
  if (!Number.isFinite(minutes) || minutes <= 0) return null;
  return { minutes: Math.min(minutes, 240), subject: rest && rest !== 'now' ? tidy(rest) : '' };
}

export const isFocusStop = (text: string): boolean =>
  /^(?:stop|end|finish|cancel|quit) (?:the |my |this )?(?:focus|study|session|pomodoro|revision|deep work)(?:ing)?(?: session| timer| block)?$|^i'?m (?:done|finished)(?: focusing| studying| revising| with (?:my |the )?(?:session|focus))$/.test(text.toLowerCase().replace(/[.!?,]/g, '').trim());

/** Find the habit someone means: "my workout" -> Workout, "meditation" -> Meditate. */
export function matchHabit(habits: Habit[], said: string): Habit | undefined {
  const low = said.toLowerCase().replace(/^(my|the|a|an|some)\s+/, '').replace(/[.!?]+$/, '').trim();
  if (!low) return undefined;
  const stem = (w: string): string => w.replace(/(ation|ating|ing|ed|es|s|e)$/, '');
  return (
    habits.find((h) => h.name.toLowerCase() === low) ??
    habits.find((h) => h.name.toLowerCase().includes(low) || low.includes(h.name.toLowerCase())) ??
    habits.find((h) => h.name.toLowerCase().split(/\s+/).some((w) => w.length > 3 && low.split(/\s+/).some((x) => x.length > 3 && stem(x).length >= 4 && stem(w).length >= 4 && (stem(x).startsWith(stem(w)) || stem(w).startsWith(stem(x))))))
  );
}

export const matchCountdown = (list: Countdown[], said: string): Countdown | undefined => {
  const low = said.toLowerCase().replace(/^(my|the|a|an)\s+/, '').replace(/[.!?]+$/, '').trim();
  const words = low.split(/\s+/).filter((w) => w.length > 2);
  return list.find((c) => c.title.toLowerCase() === low) ?? list.find((c) => c.title.toLowerCase().includes(low) || low.includes(c.title.toLowerCase())) ?? list.find((c) => words.length > 0 && words.every((w) => c.title.toLowerCase().includes(w)));
};

export { tidy };
