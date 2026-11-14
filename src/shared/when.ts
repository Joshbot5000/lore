/** Understand times the way people say them: "tomorrow at 5pm", "in 20 minutes", "Friday", "2026-11-20T09:00". */

const DAYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
const MONTHS = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december'];
const NUM: Record<string, number> = { a: 1, an: 1, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, fifteen: 15, twenty: 20, thirty: 30, forty: 40, 'forty-five': 45, sixty: 60, half: 0.5, couple: 2, few: 3 };
const num = (s: string): number => (s in NUM ? NUM[s] : parseFloat(s));

export function parseWhen(input: string, now = new Date()): number | null {
  const s = input.trim().toLowerCase().replace(/[,.]/g, ' ').replace(/\s+/g, ' ');
  if (!s) return null;

  const iso = input.trim().match(/^(\d{4})-(\d{2})-(\d{2})(?:[t ](\d{1,2}):(\d{2}))?/i);
  if (iso) return new Date(+iso[1], +iso[2] - 1, +iso[3], iso[4] ? +iso[4] : 9, iso[5] ? +iso[5] : 0).getTime();

  const rel = s.match(/\bin (?:about )?(\d+(?:\.\d+)?|an?|one|two|three|four|five|six|seven|eight|nine|ten|fifteen|twenty|thirty|forty|forty-five|sixty|half|a couple of|a few) ?(?:an? )?(second|sec|minute|min|hour|hr|day|week|month)s?\b/);
  if (rel) {
    const n = num(rel[1].replace(/^a (couple|few) of$/, '$1').replace(/^a (couple|few)$/, '$1'));
    const unit = { second: 1e3, sec: 1e3, minute: 6e4, min: 6e4, hour: 36e5, hr: 36e5, day: 864e5, week: 6048e5, month: 2592e6 }[rel[2]]!;
    return now.getTime() + n * unit;
  }

  const d = new Date(now);
  let dateSet = false;
  if (/\b(tomorrow|tmrw)\b/.test(s)) (d.setDate(d.getDate() + 1), (dateSet = true));
  else if (/\bday after tomorrow\b/.test(s)) (d.setDate(d.getDate() + 2), (dateSet = true));
  else if (/\b(today|tonight|this (morning|afternoon|evening))\b/.test(s)) dateSet = true;
  else if (/\bnext week\b/.test(s)) (d.setDate(d.getDate() + 7), (dateSet = true));
  else {
    const wd = s.match(new RegExp(`\\b(?:(next|this) )?(${DAYS.join('|')}|${DAYS.map((x) => x.slice(0, 3)).join('|')})\\b`));
    const md = s.match(new RegExp(`\\b(\\d{1,2})(?:st|nd|rd|th)?(?: of)? (${MONTHS.join('|')}|${MONTHS.map((x) => x.slice(0, 3)).join('|')})\\b`)) ?? s.match(new RegExp(`\\b(${MONTHS.join('|')}|${MONTHS.map((x) => x.slice(0, 3)).join('|')}) (\\d{1,2})(?:st|nd|rd|th)?\\b`));
    if (md) {
      const dayN = /^\d/.test(md[1]) ? +md[1] : +md[2];
      const mon = MONTHS.findIndex((m) => m.startsWith((/^\d/.test(md[1]) ? md[2] : md[1]).slice(0, 3)));
      d.setMonth(mon, dayN);
      if (d.getTime() < now.getTime() - 864e5) d.setFullYear(d.getFullYear() + 1);
      dateSet = true;
    } else if (wd) {
      const target = DAYS.findIndex((x) => x.startsWith(wd[2].slice(0, 3)));
      let add = (target - d.getDay() + 7) % 7;
      if (add === 0) add = 7;
      if (wd[1] === 'next' && add < 7 && target > d.getDay()) add += 7;
      d.setDate(d.getDate() + add);
      dateSet = true;
    }
  }

  let timeSet = false;
  const t = s.match(/\b(?:at |by |@ ?)?(\d{1,2})(?::(\d{2}))? ?(am|pm|a\.m|p\.m)\b/) ?? s.match(/\b(?:at |by )(\d{1,2}):(\d{2})\b/) ?? s.match(/\b(\d{1,2}):(\d{2})\b/) ?? s.match(/\b(?:at|by) (\d{1,2})\b/);
  if (t) {
    let h = +t[1];
    const ap = t[3]?.replace(/\./g, '');
    if (ap === 'pm' && h < 12) h += 12;
    else if (ap === 'am' && h === 12) h = 0;
    else if (!ap && h >= 1 && h <= 7 && !t[2]) h += 12; // "at 5" almost always means the afternoon
    d.setHours(h, t[2] ? +t[2] : 0, 0, 0);
    timeSet = true;
  } else if (/\bnoon|midday\b/.test(s)) (d.setHours(12, 0, 0, 0), (timeSet = true));
  else if (/\bmidnight\b/.test(s)) (d.setHours(23, 59, 0, 0), (timeSet = true));
  else if (/\bmorning\b/.test(s)) (d.setHours(9, 0, 0, 0), (timeSet = true));
  else if (/\bafternoon\b/.test(s)) (d.setHours(14, 0, 0, 0), (timeSet = true));
  else if (/\b(evening|tonight)\b/.test(s)) (d.setHours(19, 0, 0, 0), (timeSet = true));

  if (!dateSet && !timeSet) return null;
  if (!timeSet) d.setHours(9, 0, 0, 0);
  // A bare time that has already passed today means tomorrow.
  if (!dateSet && d.getTime() <= now.getTime()) d.setDate(d.getDate() + 1);
  return d.getTime();
}

export function describeWhen(ts: number, now = new Date()): string {
  const d = new Date(ts);
  const days = Math.round((new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime() - new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime()) / 864e5);
  const time = d.toLocaleTimeString('en-GB', { hour: 'numeric', minute: '2-digit', hour12: true }).replace(':00', '').replace(' ', '');
  const day = days === 0 ? 'today' : days === 1 ? 'tomorrow' : days === -1 ? 'yesterday' : days > 1 && days < 7 ? d.toLocaleDateString('en-GB', { weekday: 'long' }) : d.toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' });
  return `${day} at ${time}`;
}

/** Split text that is still being written into finished sentences plus the unfinished remainder. */
export function takeSentences(buffer: string, flush = false): { sentences: string[]; rest: string } {
  const sentences: string[] = [];
  let rest = buffer;
  for (;;) {
    const m = rest.match(/^([\s\S]*?[.!?…]["')\]]?)(\s+|$)(?=\S|$)/);
    if (!m || (!m[2] && !flush)) break;
    // Don't cut after "Mr." or a decimal like "3.5".
    if (/\b(Mr|Mrs|Ms|Dr|St|e\.g|i\.e|vs)\.$/.test(m[1]) && rest.length > m[0].length) {
      const next = takeSentences(rest.slice(m[0].length), flush);
      if (!next.sentences.length) break;
      sentences.push(m[0] + next.sentences[0], ...next.sentences.slice(1));
      rest = next.rest;
      break;
    }
    sentences.push(m[1].trim());
    rest = rest.slice(m[0].length);
    if (!rest) break;
  }
  if (flush && rest.trim()) {
    sentences.push(rest.trim());
    rest = '';
  }
  return { sentences: sentences.filter(Boolean), rest };
}

/** Make text comfortable to say aloud. */
export function speakable(text: string): string {
  return text
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/https?:\/\/\S+/g, 'a link')
    .replace(/[*_#`>|]/g, '')
    .replace(/^\s*[-•]\s+/gm, '')
    .replace(/(\d)°/g, '$1 degrees')
    .replace(/\s+/g, ' ')
    .trim();
}
