/**
 * Revision: flashcard decks and notes from a study repository (a folder of `flashcards/*.csv` and
 * `notes/**.md`, on GitHub or on this computer), quizzed by voice with spaced repetition and used
 * as the source for answers to questions about the subject.
 */
import fs from 'node:fs';
import path from 'node:path';
import type { Fetch } from './weather';

export type Card = { key: string; q: string; a: string };
export type Deck = { id: string; module: string; name: string; cards: Card[] };
export type NoteChunk = { module: string; title: string; text: string };
export type Library = { decks: Deck[]; notes: NoteChunk[]; syncedAt: number; source: string };
/** How well a card is known: box 0 (new or missed) to 4 (solid), and when it is next due. */
export type Progress = Record<string, { box: number; due: number; seen: number; right: number }>;

const INTERVAL_DAYS = [0, 1, 3, 7, 16];

export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [], cell = '', quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') (cell += '"'), i++;
      else if (c === '"') quoted = false;
      else cell += c;
    } else if (c === '"') quoted = true;
    else if (c === ',') (row.push(cell), (cell = ''));
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(cell);
      if (row.some((x) => x.trim())) rows.push(row);
      (row = []), (cell = '');
    } else cell += c;
  }
  row.push(cell);
  if (row.some((x) => x.trim())) rows.push(row);
  return rows;
}

const nice = (s: string): string => s.replace(/[-_]+/g, ' ').replace(/\bch(\d+)\b/i, 'chapter $1').replace(/^./, (c) => c.toUpperCase());
const hash = (s: string): string => {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
  return (h >>> 0).toString(36);
};

export function parseDeck(file: string, csv: string): Deck | null {
  const rows = parseCsv(csv);
  if (rows.length && /^question$/i.test(rows[0][0]?.trim() ?? '')) rows.shift();
  const base = path.basename(file).replace(/\.csv$/i, '');
  const module = base.split(/[-_]/)[0].toLowerCase();
  const cards = rows.filter((r) => r[0]?.trim() && r[1]?.trim()).map((r) => ({ key: `${base}:${hash(r[0].trim())}`, q: r[0].trim(), a: r.slice(1).join(', ').trim() }));
  return cards.length ? { id: base, module, name: nice(base), cards } : null;
}

/** Split a notes file into passages by heading, without diagrams or tables of links. */
export function parseNotes(file: string, md: string): NoteChunk[] {
  const parts = file.split(/[\\/]/);
  const module = parts.length > 1 ? parts[parts.length - 2].toLowerCase() : 'general';
  const clean = md.replace(/```[\s\S]*?```/g, '').replace(/^\|.*\|\s*$/gm, '').replace(/\[([^\]]+)\]\([^)]*\)/g, '$1');
  const out: NoteChunk[] = [];
  let doc = '', title = '', buf: string[] = [];
  const flush = () => {
    const text = buf.join('\n').replace(/[*_`>#]/g, '').replace(/\n{2,}/g, '\n').trim();
    if (text.length > 60) out.push({ module, title: [doc, title].filter(Boolean).join(': '), text: text.slice(0, 1800) });
    buf = [];
  };
  for (const line of clean.split('\n')) {
    const h = line.match(/^(#{1,3})\s+(.*)$/);
    if (h) {
      flush();
      if (h[1].length === 1) (doc = h[2].trim()), (title = '');
      else title = h[2].trim();
    } else buf.push(line);
  }
  flush();
  return out;
}

/** Read a study folder on this computer. Looks for `flashcards/` and `notes/` (and `templates/`) anywhere inside it. */
export function readFolder(root: string): { decks: Deck[]; notes: NoteChunk[] } {
  const decks: Deck[] = [], notes: NoteChunk[] = [];
  const walk = (dir: string, depth: number) => {
    if (depth > 6) return;
    for (const name of fs.readdirSync(dir)) {
      if (name.startsWith('.') || name === 'node_modules') continue;
      const full = path.join(dir, name);
      const st = fs.statSync(full);
      if (st.isDirectory()) walk(full, depth + 1);
      else if (st.size < 400_000) take(path.relative(root, full), () => fs.readFileSync(full, 'utf8'), decks, notes);
    }
  };
  walk(root, 0);
  return { decks, notes };
}

const wanted = (rel: string): 'deck' | 'notes' | null => {
  const p = rel.replace(/\\/g, '/');
  if (/(^|\/)flashcards\/[^/]+\.csv$/i.test(p)) return 'deck';
  if (/(^|\/)(notes|templates)\/.+\.md$/i.test(p) && !/README\.md$/i.test(p) && !/TEMPLATE\.md$/.test(p)) return 'notes';
  return null;
};
function take(rel: string, read: () => string, decks: Deck[], notes: NoteChunk[]): void {
  const kind = wanted(rel);
  if (kind === 'deck') {
    const d = parseDeck(rel, read());
    if (d) decks.push(d);
  } else if (kind === 'notes') notes.push(...parseNotes(rel, read()));
}

/** Fetch the study material from a public GitHub repository ("owner/name"). No account or key needed. */
export async function fetchRepo(fetcher: Fetch, repo: string): Promise<{ decks: Deck[]; notes: NoteChunk[] }> {
  const api = process.env.JARVIS_GITHUB_API ?? 'https://api.github.com';
  const raw = process.env.JARVIS_GITHUB_RAW ?? 'https://raw.githubusercontent.com';
  const headers = { 'User-Agent': 'jarvis-study', Accept: 'application/vnd.github+json' };
  const res = await fetcher(`${api}/repos/${repo}/git/trees/HEAD?recursive=1`, { headers });
  if (res.status === 404) throw new Error(`no public repository called ${repo}`);
  if (res.status === 403 || res.status === 429) throw new Error('GitHub is limiting requests for now; it will retry later');
  if (!res.ok) throw new Error(`GitHub answered ${res.status}`);
  const tree = ((await res.json()) as { tree?: { path: string; type: string; size?: number }[] }).tree ?? [];
  const files = tree.filter((t) => t.type === 'blob' && (t.size ?? 0) < 400_000 && wanted(t.path)).slice(0, 300);
  const decks: Deck[] = [], notes: NoteChunk[] = [];
  for (const f of files) {
    const r = await fetcher(`${raw}/${repo}/HEAD/${f.path.split('/').map(encodeURIComponent).join('/')}`, { headers: { 'User-Agent': 'jarvis-study' } });
    if (!r.ok) continue;
    const text = await r.text();
    take(f.path, () => text, decks, notes);
  }
  return { decks, notes };
}

export const isRepo = (source: string): boolean => /^[\w.-]+\/[\w.-]+$/.test(source.trim());

// ------------------------------------------------------------------ quizzing

const STOP = new Set('a an the of to in on at for and or but is are was were be been being it its this that these those as by with from not no if so than then there their they he she his her him you your i we our which who whom what when where why how does do did has have had can could would should may might must will shall into out up down over under about any some such only also just very more most other each both own same one two'.split(' '));
const stem = (w: string): string => w.replace(/(ations?|ments?|ness|ingly|edly|ing|ed|ies|es|s|ly)$/, '').replace(/(.)\1$/, '$1');
export const contentWords = (s: string): string[] => [...new Set(s.toLowerCase().replace(/['’]/g, '').split(/[^a-z0-9]+/).filter((w) => w.length > 2 && !STOP.has(w)).map(stem).filter((w) => w.length > 1))];

/** How much of the model answer's substance the spoken answer covers: 0 to 1. */
export function coverage(given: string, expected: string): number {
  const want = contentWords(expected);
  if (!want.length) return 0;
  const got = new Set(contentWords(given));
  // Short answers are judged on their key words; long ones need about half the substance for full marks.
  const need = Math.max(2, Math.min(want.length, Math.ceil(want.length * 0.5)));
  return Math.min(1, want.filter((w) => got.has(w)).length / need);
}

const NEG = /^(not|no|never|without|cannot|neither|nor)$|n't$/;
/** The outcome words each side negates ("not guilty", "no contract") and the ones it states plainly. */
function polarity(text: string): { neg: Set<string>; pos: Set<string> } {
  const words = text.toLowerCase().replace(/[’]/g, "'").split(/[^a-z0-9']+/).filter(Boolean);
  const neg = new Set<string>(), pos = new Set<string>();
  words.forEach((w, i) => {
    if (w.length < 4 || STOP.has(w) || NEG.test(w)) return;
    const negated = words.slice(Math.max(0, i - 3), i).some((x) => NEG.test(x));
    (negated ? neg : pos).add(stem(w));
  });
  return { neg, pos };
}

/** Does the answer say the opposite of the model answer on some point (guilty / not guilty)? */
export function contradicts(given: string, expected: string): boolean {
  const g = polarity(given), e = polarity(expected);
  const flips = (a: { neg: Set<string>; pos: Set<string> }, b: { neg: Set<string>; pos: Set<string> }) => [...a.neg].some((w) => b.pos.has(w) && !b.neg.has(w) && !a.pos.has(w));
  return flips(e, g) || flips(g, e);
}

export type Grade = 'right' | 'close' | 'wrong';
export const grade = (given: string, expected: string): Grade => {
  const c = coverage(given, expected);
  // The right words with the opposite conclusion is not a near miss.
  if (c >= 0.4 && contradicts(given, expected)) return 'wrong';
  return c >= 0.75 ? 'right' : c >= 0.4 ? 'close' : 'wrong';
};

export function record(progress: Progress, key: string, right: boolean, now = Date.now()): void {
  const p = progress[key] ?? { box: 0, due: 0, seen: 0, right: 0 };
  p.seen++;
  if (right) (p.right++, (p.box = Math.min(4, p.box + 1)), (p.due = now + INTERVAL_DAYS[p.box] * 864e5));
  else (p.box = 0), (p.due = now + 10 * 6e4);
  progress[key] = p;
}

export const isDue = (progress: Progress, key: string, now = Date.now()): boolean => !progress[key] || progress[key].due <= now;

export type DeckStats = { id: string; module: string; name: string; total: number; due: number; fresh: number; solid: number };
export function deckStats(decks: Deck[], progress: Progress, now = Date.now()): DeckStats[] {
  return decks.map((d) => ({
    id: d.id, module: d.module, name: d.name, total: d.cards.length,
    due: d.cards.filter((c) => progress[c.key] && progress[c.key].due <= now).length,
    fresh: d.cards.filter((c) => !progress[c.key]).length,
    solid: d.cards.filter((c) => (progress[c.key]?.box ?? 0) >= 3).length,
  }));
}

/** The cards for a session: those due for review first (weakest first), then ones never seen, up to `n`. */
export function pickCards(decks: Deck[], progress: Progress, n = 10, now = Date.now()): Card[] {
  const all = decks.flatMap((d) => d.cards);
  const due = all.filter((c) => progress[c.key] && progress[c.key].due <= now).sort((a, b) => progress[a.key].box - progress[b.key].box || progress[a.key].due - progress[b.key].due);
  const fresh = all.filter((c) => !progress[c.key]);
  const picked = [...due, ...fresh].slice(0, n);
  // Nothing due and nothing new: go round again on the least secure cards.
  return picked.length ? picked : [...all].sort((a, b) => progress[a.key].box - progress[b.key].box || progress[a.key].due - progress[b.key].due).slice(0, n);
}

/** Which decks someone means: "contract", "tort negligence", "criminal law", or nothing (all of them). */
export function matchDecks(decks: Deck[], said: string): Deck[] {
  const words = said.toLowerCase().replace(/[^a-z0-9 ]/g, ' ').split(/\s+/).filter((w) => w.length > 2 && !['law', 'the', 'deck', 'cards', 'flashcards', 'everything', 'all', 'chapter', 'module', 'some', 'revision', 'please'].includes(w));
  if (!words.length) return decks;
  const byModule = decks.filter((d) => words.some((w) => d.module === w || d.module.startsWith(w) || w.startsWith(d.module)));
  const byName = (byModule.length ? byModule : decks).filter((d) => words.filter((w) => !byModule.length || !(d.module === w || d.module.startsWith(w) || w.startsWith(d.module))).every((w) => d.name.toLowerCase().includes(w.replace(/s$/, ''))));
  return byName.length ? byName : byModule;
}

// ------------------------------------------------------------------ answering from the notes

/** Case names and defined terms: the words that mark a question as being about the subject. */
export function vocabulary(lib: { decks: Deck[]; notes: NoteChunk[] }): Set<string> {
  const v = new Set<string>();
  const add = (text: string) => {
    for (const w of contentWords(text)) if (w.length > 3) v.add(w);
  };
  for (const d of lib.decks) for (const c of d.cards) add(c.q);
  for (const n of lib.notes) add(n.title);
  for (const common of ['what', 'happen', 'mean', 'thing', 'need', 'make', 'case', 'work', 'time', 'year', 'when', 'general', 'rule', 'test', 'about', 'tell', 'today', 'does', 'kind', 'take', 'give', 'know', 'chapter', 'person', 'people', 'must', 'they', 'explain', 'between', 'differ', 'example', 'still', 'prove', 'where', 'into', 'want', 'come', 'call', 'open', 'stop', 'start', 'play', 'matter']) v.delete(stem(common));
  return v;
}

/** The passages and flashcards that best match a question; empty when the question is not about the subject. */
export function studyContext(lib: { decks: Deck[]; notes: NoteChunk[] }, vocab: Set<string>, query: string, max = 1700): string {
  const words = contentWords(query).filter((w) => vocab.has(w));
  const names = query.match(/\b[A-Z][a-z]+ v\.? [A-Z][a-z]+/g) ?? [];
  if (words.length < 2 && !names.length && !(words.length === 1 && /\b(law|legal|case|tort|contract|criminal|offence|claim|liab|duty|doctrine|principle|rule)\b/i.test(query))) return '';
  const score = (text: string): number => {
    const low = text.toLowerCase();
    const have = new Set(contentWords(text));
    return words.filter((w) => have.has(w)).length + names.filter((n) => low.includes(n.toLowerCase().replace('v.', 'v'))).length * 3;
  };
  const cards = lib.decks.flatMap((d) => d.cards.map((c) => ({ text: `Q: ${c.q} A: ${c.a}`, s: score(`${c.q} ${c.a}`) + score(c.q) })));
  const notes = lib.notes.map((n) => ({ text: `${n.title}: ${n.text}`, s: score(`${n.title} ${n.text}`) + score(n.title) }));
  const best = [...cards, ...notes].filter((x) => x.s >= Math.min(2, words.length + names.length * 3)).sort((a, b) => b.s - a.s);
  const out: string[] = [];
  let used = 0;
  for (const b of best.slice(0, 6)) {
    const t = b.text.replace(/\s+/g, ' ').slice(0, 700);
    if (used + t.length > max) break;
    out.push(t);
    used += t.length;
  }
  return out.length ? out.join('\n') : '';
}

/** Does this read as a question about law (a case name, or legal vocabulary), whether or not the notes cover it? */
export const looksLegal = (q: string): boolean =>
  /\b[A-Z][a-z]+ v\.? [A-Z][a-z]+/.test(q) || /\b(tort|negligence|contract law|criminal law|land law|equity|trusts?|public law|mens rea|actus reus|liabilit|doctrine|statut|claimant|defendant|ratio|obiter|precedent|case law|legal (test|rule|principle)|offence|manslaughter|murder|duty of care|consideration|estoppel|misrepresentation|judicial review)\b/i.test(q);
