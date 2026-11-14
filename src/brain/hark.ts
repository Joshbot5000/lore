/**
 * A read-only window onto Hark, the notetaker: if it is installed on this computer, Jarvis can
 * answer questions about recorded conversations and knows which action items are still open.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export type HarkRec = {
  id: string; title: string; at: number; minutes: number; overview: string; keyPoints: string[]; decisions: string[];
  actions: { text: string; owner?: string; due?: string; done: boolean }[]; speakers: string[];
};

/** Where Hark keeps its library on this kind of computer. */
export function defaultHarkDir(): string {
  const home = os.homedir();
  const base = process.platform === 'darwin' ? path.join(home, 'Library', 'Application Support') : process.platform === 'win32' ? process.env.APPDATA ?? path.join(home, 'AppData', 'Roaming') : process.env.XDG_CONFIG_HOME ?? path.join(home, '.config');
  return path.join(base, 'Hark', 'library');
}

/** Every finished conversation, newest first. Null when Hark is not installed. */
export function readHark(dir: string): HarkRec[] | null {
  const root = path.join(dir, 'conversations');
  if (!fs.existsSync(root)) return null;
  const out: HarkRec[] = [];
  for (const id of fs.readdirSync(root)) {
    try {
      const m = JSON.parse(fs.readFileSync(path.join(root, id, 'meeting.json'), 'utf8'));
      if (m.status !== 'ready') continue;
      const s = m.summary ?? {};
      out.push({
        id, title: String(m.title ?? 'Conversation'), at: Number(m.createdAt) || 0, minutes: Math.round((Number(m.duration) || 0) / 60),
        overview: String(s.overview ?? m.preview ?? ''), keyPoints: (s.keyPoints ?? []).map(String), decisions: (s.decisions ?? []).map(String),
        actions: (s.actions ?? []).map((a: any) => ({ text: String(a.text ?? ''), owner: a.owner || undefined, due: a.due || undefined, done: !!a.done })).filter((a: { text: string }) => a.text),
        speakers: (m.speakers ?? []).filter((x: any) => x.named).map((x: any) => String(x.name)),
      });
    } catch {
      /* a half-written or foreign folder: skip it */
    }
  }
  return out.sort((a, b) => b.at - a.at);
}

const STOP = new Set(['what', 'when', 'where', 'which', 'were', 'with', 'from', 'that', 'this', 'about', 'have', 'did', 'does', 'meeting', 'meetings', 'recording', 'recordings', 'conversation', 'conversations', 'call', 'last', 'latest', 'recent', 'said', 'discussed', 'decided', 'agreed', 'talked', 'anything', 'there', 'they', 'them', 'their', 'your', 'tell', 'summarise', 'summarize', 'summary', 'action', 'items', 'hark']);
export const keywords = (q: string): string[] => q.toLowerCase().split(/[^a-z0-9']+/).filter((w) => w.length > 3 && !STOP.has(w));

/** The recordings a question is most likely about: keyword matches first, otherwise the most recent. */
export function pickRecordings(recs: HarkRec[], query: string, k = 2): HarkRec[] {
  const words = keywords(query);
  if (!words.length || /\b(last|latest|most recent|today'?s|this morning'?s)\b/i.test(query)) return recs.slice(0, /\b(last|latest|most recent)\b/i.test(query) ? 1 : k);
  const scored = recs.map((r, i) => {
    const hay = `${r.title} ${r.overview} ${r.keyPoints.join(' ')} ${r.decisions.join(' ')} ${r.actions.map((a) => a.text).join(' ')} ${r.speakers.join(' ')}`.toLowerCase();
    const title = r.title.toLowerCase();
    return { r, score: words.reduce((n, w) => n + (title.includes(w) ? 2 : hay.includes(w) ? 1 : 0), 0) - i * 0.01 };
  });
  const hits = scored.filter((x) => x.score > 0).sort((a, b) => b.score - a.score).slice(0, k).map((x) => x.r);
  return hits.length ? hits : recs.slice(0, k);
}

/** A few passages of what was actually said that mention the question's keywords. */
export function transcriptSnippets(dir: string, rec: HarkRec, query: string, k = 3): string[] {
  const words = keywords(query);
  if (!words.length) return [];
  try {
    const m = JSON.parse(fs.readFileSync(path.join(dir, 'conversations', rec.id, 'meeting.json'), 'utf8'));
    const names = new Map<string, string>((m.speakers ?? []).map((s: any) => [s.id, s.name]));
    const paras = JSON.parse(fs.readFileSync(path.join(dir, 'conversations', rec.id, 'transcript.json'), 'utf8')) as { sp: string; text: string }[];
    return paras
      .map((p) => ({ p, score: words.filter((w) => p.text.toLowerCase().includes(w)).length }))
      .filter((x) => x.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, k)
      .map(({ p }) => `${names.get(p.sp) ?? 'Someone'}: “${p.text.slice(0, 260)}”`);
  } catch {
    return [];
  }
}

/** What Jarvis is shown about recordings when a question seems to be about them. */
export function harkContext(dir: string, recs: HarkRec[], query: string): string {
  if (!recs.length) return '';
  const day = (t: number): string => new Date(t).toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long' });
  const picked = pickRecordings(recs, query);
  const parts = picked.map((r, i) => {
    const L = [`“${r.title}” (${day(r.at)}, ${r.minutes || 1} min${r.speakers.length ? `, with ${r.speakers.join(', ')}` : ''}): ${r.overview}`];
    if (r.keyPoints.length) L.push(`Key points: ${r.keyPoints.slice(0, 5).join('; ')}.`);
    if (r.decisions.length) L.push(`Decisions: ${r.decisions.slice(0, 4).join('; ')}.`);
    const open = r.actions.filter((a) => !a.done);
    if (open.length) L.push(`Open action items: ${open.slice(0, 6).map((a) => `${a.owner ? a.owner + ': ' : ''}${a.text}${a.due ? ` (due ${a.due})` : ''}`).join('; ')}.`);
    if (i === 0) {
      const said = transcriptSnippets(dir, r, query);
      if (said.length) L.push(`Said in it: ${said.join(' ')}`);
    }
    return L.join(' ');
  });
  const others = recs.filter((r) => !picked.includes(r)).slice(0, 5);
  return `Recorded conversations (from Hark, the notetaker): ${parts.join('\n')}${others.length ? `\nOther recordings: ${others.map((r) => `“${r.title}” (${day(r.at)})`).join(', ')}.` : ''}`;
}

export const aboutRecordings = (q: string): boolean => /\b(meeting|meetings|recording|recordings|recorded|conversation|call|lecture|seminar|interview|discussed|talked about|decided|agreed|action items?|hark|minutes of)\b/i.test(q);

/** Does the question name one of the recordings (two words of its title, or its whole short title)? */
export function namesRecording(recs: HarkRec[], q: string): boolean {
  const low = q.toLowerCase();
  return recs.some((r) => {
    const words = r.title.toLowerCase().split(/[^a-z0-9']+/).filter((w) => w.length > 3 && !['with', 'from', 'about', 'conversation', 'morning', 'afternoon', 'evening'].includes(w));
    if (!words.length) return false;
    if (low.includes(r.title.toLowerCase())) return true;
    // Two of the title's words, in the order the title has them ("the product sync", not "call my landlord").
    const safe = words.map((w) => w.replace(/[^a-z0-9]/g, '')).filter(Boolean);
    for (let a = 0; a < safe.length; a++) for (let b = a + 1; b < safe.length; b++) if (new RegExp(`\\b${safe[a]}\\b.*\\b${safe[b]}\\b`).test(low)) return true;
    return false;
  });
}
