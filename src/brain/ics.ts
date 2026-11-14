/** Read calendar subscription feeds (.ics): Google, iCloud, Outlook and most others publish one. */
import type { CalEvent } from '../shared/types';

type Raw = { uid: string; summary: string; start: Date; end: Date; allDay: boolean; rrule?: string; exdates: number[]; location?: string };

const unescape = (s: string): string => s.replace(/\\n/gi, ' ').replace(/\\([,;\\])/g, '$1').trim();

function parseDate(value: string, params: string): { date: Date; allDay: boolean } {
  const m = value.match(/^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})(Z)?)?$/);
  if (!m) return { date: new Date(NaN), allDay: false };
  const [, y, mo, d, h, mi, s, z] = m;
  if (h === undefined) return { date: new Date(+y, +mo - 1, +d), allDay: true };
  if (z) return { date: new Date(Date.UTC(+y, +mo - 1, +d, +h, +mi, +s)), allDay: false };
  const tz = params.match(/TZID=([^;:]+)/)?.[1];
  if (tz) {
    // Wall-clock time in a named zone: find the UTC instant that shows this wall time there.
    try {
      const guess = Date.UTC(+y, +mo - 1, +d, +h, +mi, +s);
      const parts = new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' }).formatToParts(new Date(guess));
      const p = Object.fromEntries(parts.map((x) => [x.type, +x.value]));
      const shown = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
      return { date: new Date(guess - (shown - guess)), allDay: false };
    } catch {
      /* unknown zone: fall through to local time */
    }
  }
  return { date: new Date(+y, +mo - 1, +d, +h, +mi, +s), allDay: false };
}

export function parseIcs(text: string): Raw[] {
  const lines = text.replace(/\r\n/g, '\n').replace(/\n[ \t]/g, '').split('\n');
  const out: Raw[] = [];
  let cur: Partial<Raw> & { exdates: number[] } | null = null;
  for (const line of lines) {
    if (line === 'BEGIN:VEVENT') cur = { exdates: [] };
    else if (line === 'END:VEVENT') {
      if (cur?.start && !Number.isNaN(cur.start.getTime())) {
        const end = cur.end && !Number.isNaN(cur.end.getTime()) ? cur.end : new Date(cur.start.getTime() + (cur.allDay ? 864e5 : 36e5));
        out.push({ uid: cur.uid ?? String(out.length), summary: cur.summary ?? '(no title)', start: cur.start, end, allDay: !!cur.allDay, rrule: cur.rrule, exdates: cur.exdates, location: cur.location });
      }
      cur = null;
    } else if (cur) {
      const i = line.indexOf(':');
      if (i < 0) continue;
      const [name, ...params] = line.slice(0, i).split(';');
      const value = line.slice(i + 1);
      if (name === 'UID') cur.uid = value;
      else if (name === 'SUMMARY') cur.summary = unescape(value);
      else if (name === 'LOCATION') cur.location = unescape(value);
      else if (name === 'RRULE') cur.rrule = value;
      else if (name === 'DTSTART') {
        const d = parseDate(value, params.join(';'));
        cur.start = d.date;
        cur.allDay = d.allDay;
      } else if (name === 'DTEND') cur.end = parseDate(value, params.join(';')).date;
      else if (name === 'EXDATE') for (const v of value.split(',')) cur.exdates.push(parseDate(v, params.join(';')).date.getTime());
    }
  }
  return out;
}

const DAYS = ['SU', 'MO', 'TU', 'WE', 'TH', 'FR', 'SA'];

/** All occurrences that overlap [from, to], with common repeat rules expanded. */
export function expand(raws: Raw[], from: number, to: number, calendar?: string): CalEvent[] {
  const out: CalEvent[] = [];
  for (const r of raws) {
    const len = r.end.getTime() - r.start.getTime();
    const push = (start: Date) => {
      const s = start.getTime();
      if (s + len >= from && s <= to && !r.exdates.includes(s)) out.push({ id: `${r.uid}@${s}`, title: r.summary, start: s, end: s + len, allDay: r.allDay, where: r.location, calendar });
    };
    if (!r.rrule) {
      push(r.start);
      continue;
    }
    const rule = Object.fromEntries(r.rrule.split(';').map((p) => p.split('='))) as Record<string, string>;
    const interval = Math.max(1, parseInt(rule.INTERVAL ?? '1', 10));
    const until = rule.UNTIL ? parseDate(rule.UNTIL, '').date.getTime() + (rule.UNTIL.includes('T') ? 0 : 864e5) : Infinity;
    const count = rule.COUNT ? parseInt(rule.COUNT, 10) : Infinity;
    const byday = rule.BYDAY?.split(',').map((d) => DAYS.indexOf(d.slice(-2))).filter((d) => d >= 0);
    let made = 0;
    const cur = new Date(r.start);
    for (let guard = 0; guard < 3000 && cur.getTime() <= Math.min(to, until) && made < count; guard++) {
      if (rule.FREQ === 'WEEKLY' && byday?.length) {
        const week = new Date(cur);
        week.setDate(week.getDate() - week.getDay());
        for (const d of [...byday].sort()) {
          const occ = new Date(week);
          occ.setDate(week.getDate() + d);
          if (occ.getTime() < r.start.getTime() || occ.getTime() > until || made >= count) continue;
          made++;
          push(occ);
        }
        cur.setDate(cur.getDate() + 7 * interval);
        continue;
      }
      made++;
      push(new Date(cur));
      if (rule.FREQ === 'DAILY') cur.setDate(cur.getDate() + interval);
      else if (rule.FREQ === 'WEEKLY') cur.setDate(cur.getDate() + 7 * interval);
      else if (rule.FREQ === 'MONTHLY') cur.setMonth(cur.getMonth() + interval);
      else if (rule.FREQ === 'YEARLY') cur.setFullYear(cur.getFullYear() + interval);
      else break;
    }
  }
  return out.sort((a, b) => a.start - b.start);
}
