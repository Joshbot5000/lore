// End-to-end check of revision: syncing a study repository, the voice flashcard quiz, spaced repetition,
// and answering law questions from the notes. Usage: node tests/study.mjs <path-to-study-folder> [--llm]
import WebSocket from 'ws';
import http from 'node:http';
import { spawn } from 'node:child_process';
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path';
const folder = path.resolve(process.argv[2]); const withLlm = process.argv.includes('--llm');
const data = fs.mkdtempSync(path.join(os.tmpdir(), 'jv-study-'));
// A stand-in GitHub that serves the same folder, to test fetching from a repository.
const files = []; (function walk(d) { for (const n of fs.readdirSync(d)) { if (n.startsWith('.git') && n !== '.github') continue; const f = path.join(d, n); fs.statSync(f).isDirectory() ? walk(f) : files.push(path.relative(folder, f)); } })(folder);
const gh = http.createServer((req, res) => {
  const u = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  if (u === '/repos/someone/revision/git/trees/HEAD') return void res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ tree: files.map((p) => ({ path: p, type: 'blob', size: fs.statSync(path.join(folder, p)).size })) }));
  const m = u.match(/^\/someone\/revision\/HEAD\/(.+)$/);
  if (m && files.includes(m[1])) return void res.end(fs.readFileSync(path.join(folder, m[1])));
  res.writeHead(404).end('{}');
});
await new Promise((r) => gh.listen(0, '127.0.0.1', r)); const GH = `http://127.0.0.1:${gh.address().port}`;
fs.writeFileSync(path.join(data, 'settings.json'), JSON.stringify({ userName: 'Josh', onboarded: true, speak: false, useAppleMail: false, studySource: 'someone/revision', llmModel: process.env.JARVIS_LLM ?? 'qwen-2b' }));
const port = 8100 + Math.floor(Math.random() * 90);
const child = spawn('node', ['out/main/headless.js'], { env: { ...process.env, JARVIS_FAKE_MAC: '1', JARVIS_DATA_DIR: data, JARVIS_HARK_DIR: path.join(data, 'none'), JARVIS_PORT: String(port), JARVIS_GITHUB_API: GH, JARVIS_GITHUB_RAW: GH }, stdio: ['ignore', 'pipe', 'inherit'] });
const url = await new Promise((r) => child.stdout.on('data', (d) => { const m = String(d).match(/http:\/\/localhost:\d+\/\?k=\w+/); if (m) r(new URL(m[0])); }));
const ws = new WebSocket(`ws://${url.host}/ws?k=${url.searchParams.get('k')}&d=test`);
let snap = null, id = 1, cur = null; const waits = new Map();
ws.on('message', (raw) => { const p = JSON.parse(String(raw));
  if (p.id !== undefined && waits.has(p.id)) return void (waits.get(p.id)(p), waits.delete(p.id));
  if (p.type === 'snapshot') snap = p.data; else if (p.type === 'patch') Object.assign(snap, p.data);
  else if (p.type === 'say' && cur) { if (p.delta) cur.text += p.delta; if (p.tool) cur.tools.push(p.tool.label); if (p.done) cur.done(); } });
await new Promise((r) => ws.on('open', r)); while (!snap) await new Promise((r) => setTimeout(r, 50));
const call = (method, params = {}) => new Promise((r) => { const n = id++; waits.set(n, r); ws.send(JSON.stringify({ id: n, method, params })); });
const say = (text) => new Promise((resolve) => { const t0 = Date.now(); cur = { text: '', tools: [], done: () => { const c = cur; cur = null; setTimeout(() => resolve({ text: c.text.trim(), tools: c.tools, ms: Date.now() - t0 }), 150); } }; ws.send(JSON.stringify({ id: id++, method: 'say', params: { text } })); });
const results = []; const check = (name, ok, extra = '') => { results.push(!!ok); console.log(ok ? 'PASS' : 'FAIL', name, extra ? `— ${extra}` : ''); };
const ask = async (text, test, name) => { const r = await say(text); check(name ?? text, test(r), `“${r.text.slice(0, 210)}”${r.tools.length ? ` [${r.tools.join(' | ')}]` : ''} (${r.ms} ms)`); return r; };
try {
  for (let i = 0; i < 40 && !snap.study.cards; i++) await new Promise((r) => setTimeout(r, 250));
  check('fetches flashcards and notes from the repository', snap.study.decks.length >= 3 && snap.study.cards >= 40 && snap.study.notes > 10 && !snap.study.error, `${snap.study.decks.map((d) => `${d.name} (${d.total})`).join(', ')}; ${snap.study.notes} note sections`);
  check('kept on disk for offline use', fs.existsSync(path.join(data, 'study-library.json')));
  let r = await ask('Quiz me on contract', (x) => /Contract agreement: 10 cards/.test(x.text) && /First question\. What is an offer\?/.test(x.text) && snap.study.quiz?.total === 10);
  await ask("It's a definite statement of the terms someone is willing to be bound by, intended to be binding once it is accepted", (x) => /^(Right|Correct|Yes|Spot on)\. Next\. /.test(x.text) && snap.study.quiz.right === 1 && snap.study.quiz.index === 1, 'a correct answer in my own words is marked right');
  await ask('skip', (x) => /An invitation for others to make offers/.test(x.text) && /Next\./.test(x.text) && snap.study.quiz.right === 1, 'skip reads out the answer');
  await ask('The shopkeeper was found guilty because the knife was on sale', (x) => /^Not quite\. A shopkeeper displayed a flick knife/.test(x.text), 'a wrong answer is corrected');
  await ask('I got that right', (x) => /Marked right/.test(x.text) && snap.study.quiz.right === 2, 'I can overrule the marking');
  const before = snap.study.quiz.index;
  await ask('set a timer for 5 minutes', (x) => /starting now/.test(x.text) && snap.timers.length === 1 && snap.study.quiz.index === before, 'other commands still work mid-quiz without counting as an answer');
  await ask('repeat the question', (x) => x.text === snap.study.quiz.question);
  await ask("It's when you say yes, and the offer and the acceptance match, and you tell the other side", (x) => snap.study.quiz.index === before + 1, 'an answer containing "and" is taken whole');
  r = await ask("that's enough", (x) => /That's \d out of 4\./.test(x.text) && /To go over again/.test(x.text) && snap.study.quiz === null, 'stopping gives the score and what to revisit');
  await new Promise((r2) => setTimeout(r2, 400));
  const prog = JSON.parse(fs.readFileSync(path.join(data, 'study.json'), 'utf8'));
  check('progress is saved, with missed cards due again soon', Object.keys(prog).length === 4 && Object.values(prog).filter((p) => p.box === 1).length >= 2 && Object.values(prog).some((p) => p.box === 0 && p.due - Date.now() < 11 * 6e4));
  await ask('how is my revision going', (x) => /you haven't seen yet/.test(x.text));
  r = await ask('test me on negligence', (x) => /Tort negligence core: 10 cards/.test(x.text));
  await say('stop');
  await ask('quiz me on land law', (x) => /don't have a deck on that/.test(x.text) && snap.study.quiz === null);
  // a folder on this computer works too
  await call('saveSettings', { studySource: folder }); await new Promise((r2) => setTimeout(r2, 1200));
  check('a local folder works as the source', snap.study.cards >= 40 && !snap.study.error);
  await call('saveSettings', { studySource: 'nobody/nothing' }); await new Promise((r2) => setTimeout(r2, 1200));
  check('a bad source is reported, and the last good copy is kept', /no public repository/.test(snap.study.error ?? '') && snap.study.cards >= 40, snap.study.error);
  if (withLlm) {
    while (snap.status.llm !== 'ready') await new Promise((r2) => setTimeout(r2, 500));
    await ask('What happened in Hyde v Wrench?', (x) => /counter|950|1,?000/i.test(x.text) && !x.tools.length, 'answers a case question from the notes');
    await ask('What does a claimant have to prove in negligence?', (x) => /duty/i.test(x.text) && /breach/i.test(x.text) && /caus/i.test(x.text), 'answers a rule question from the notes');
    await ask('What is the rule in Rylands v Fletcher?', (x) => /notes|don't|not sure|cover/i.test(x.text), 'says so when the notes do not cover something');
  }
  if (process.env.SHOTS) {
    await call('saveSettings', { studySource: folder }); await new Promise((r2) => setTimeout(r2, 1000));
    const { chromium, devices } = await import('playwright-core');
    const b = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium', args: ['--no-sandbox'] }); const errs = [];
    const page = await (await b.newContext({ viewport: { width: 1440, height: 1500 } })).newPage();
    page.on('console', (m) => m.type() === 'error' && errs.push(m.text())); page.on('pageerror', (e) => errs.push('PAGEERROR ' + e.message));
    await page.goto(url.href); await page.waitForSelector('.card-revise .decks'); await page.waitForTimeout(1000);
    await page.locator('.card-revise').screenshot({ path: `${process.env.SHOTS}/revise-decks.png` });
    await page.click('.card-revise .decks .btn >> nth=2'); await page.waitForSelector('.quiz-q'); await page.fill('.quiz input', 'duty and breach'); await page.keyboard.press('Enter'); await page.waitForSelector('.quiz-last'); await page.waitForTimeout(600);
    await page.locator('.card-revise').screenshot({ path: `${process.env.SHOTS}/revise-quiz.png` });
    const ph = await (await b.newContext({ ...devices['iPhone 14'] })).newPage(); await ph.goto(url.href); await ph.waitForSelector('.card-core'); await ph.click('.dock >> text=Today'); await ph.locator('.card-revise').scrollIntoViewIfNeeded(); await ph.waitForTimeout(600); await ph.screenshot({ path: `${process.env.SHOTS}/revise-phone.png` });
    await page.click('.quiz-actions .danger'); await page.waitForSelector('.card-revise .decks');
    check('Revision card works by tapping, without errors', errs.length === 0, errs.slice(0, 3).join(' || '));
    await b.close();
  }
} catch (e) { check('run completed', false, String(e.stack ?? e)); }
console.log(`\n${results.filter(Boolean).length}/${results.length} checks passed`);
child.kill(); process.exit(results.every(Boolean) ? 0 : 1);
