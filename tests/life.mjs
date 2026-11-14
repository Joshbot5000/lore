// End-to-end check of focus sessions, habits, countdowns, routines, the evening review, the Hark link and the clipboard.
// Starts its own brain. Usage: JARVIS_MODELS_DIR=... node tests/life.mjs [--llm]
import WebSocket from 'ws';
import { spawn } from 'node:child_process';
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path';
const withLlm = process.argv.includes('--llm');
const data = fs.mkdtempSync(path.join(os.tmpdir(), 'jv-life-'));
const hark = path.join(data, 'hark');
const put = (id, meeting, paras) => { fs.mkdirSync(path.join(hark, 'conversations', id), { recursive: true }); fs.writeFileSync(path.join(hark, 'conversations', id, 'meeting.json'), JSON.stringify(meeting)); fs.writeFileSync(path.join(hark, 'conversations', id, 'transcript.json'), JSON.stringify(paras)); };
put('a1', { title: 'Weekly product sync', status: 'ready', createdAt: Date.now() - 864e5, duration: 1260, speakers: [{ id: 'S1', name: 'Priya', named: true }],
  summary: { overview: 'The team agreed to move the mobile app launch to the third of March.', keyPoints: ['Launch moves to 3 March', 'Onboarding rate rose from 58% to 71%'], decisions: ['Ship without a press release'], actions: [{ text: 'Recruit 50 beta customers', owner: 'George', due: 'Friday', done: false }] } },
  [{ sp: 'S1', text: 'I think the launch should move to the third of March.' }]);
fs.writeFileSync(path.join(data, 'settings.json'), JSON.stringify({ userName: 'Josh', onboarded: true, speak: false, llmModel: process.env.JARVIS_LLM ?? 'qwen-4b' }));
const port = 7900 + Math.floor(Math.random() * 90);
const child = spawn('node', ['out/main/headless.js'], { env: { ...process.env, JARVIS_FAKE_MAC: '1', JARVIS_DATA_DIR: data, JARVIS_HARK_DIR: hark, JARVIS_PORT: String(port), JARVIS_FAKE_CLIPBOARD: 'Dear tenant, your rent will rise from £950 to £1,020 a month starting on the first of February. Please reply by 20 December if you wish to renew.' }, stdio: ['ignore', 'pipe', 'inherit'] });
const url = await new Promise((r) => child.stdout.on('data', (d) => { const m = String(d).match(/http:\/\/localhost:\d+\/\?k=\w+/); if (m) r(new URL(m[0])); }));
const ws = new WebSocket(`ws://${url.host}/ws?k=${url.searchParams.get('k')}&d=test`);
let snap = null, id = 1, cur = null; const waits = new Map();
ws.on('message', (raw) => {
  const p = JSON.parse(String(raw));
  if (p.id !== undefined && waits.has(p.id)) return void (waits.get(p.id)(p), waits.delete(p.id));
  if (p.type === 'snapshot') snap = p.data;
  else if (p.type === 'patch') Object.assign(snap, p.data);
  else if (p.type === 'say' && cur) { if (p.delta) cur.text += p.delta; if (p.tool) cur.tools.push(p.tool.label); if (p.done) cur.done(); }
});
await new Promise((r) => ws.on('open', r)); while (!snap) await new Promise((r) => setTimeout(r, 50));
const call = (method, params = {}) => new Promise((r) => { const n = id++; waits.set(n, r); ws.send(JSON.stringify({ id: n, method, params })); });
const say = (text) => new Promise((resolve) => { const t0 = Date.now(); cur = { text: '', tools: [], done: () => { const c = cur; cur = null; setTimeout(() => resolve({ text: c.text.trim(), tools: c.tools, ms: Date.now() - t0 }), 120); } }; ws.send(JSON.stringify({ id: id++, method: 'say', params: { text } })); });
const results = []; const check = (name, ok, extra = '') => { results.push(ok); console.log(ok ? 'PASS' : 'FAIL', name, extra ? `— ${extra}` : ''); };
const ask = async (text, test, name) => { const r = await say(text); check(name ?? text, !!test(r), `“${r.text.slice(0, 170)}”${r.tools.length ? ` [${r.tools.join(' | ')}]` : ''} (${r.ms} ms)`); return r; };
try {
  check('Hark library found', snap.integrations.hark.state === 'ok' && snap.recordings.length === 1 && snap.recordings[0].open === 1, snap.integrations.hark.detail);
  check('open actions from recordings surface', snap.needs.some((n) => /1 open action item from your recordings/.test(n.text)));
  // focus
  await ask('Start a 45 minute focus session on contract law', (r) => /45 minutes on Contract law/.test(r.text) && snap.focusNow?.subject === 'Contract law' && Math.round(snap.focusNow.total / 6e4) === 45);
  await ask('Jarvis, stop the focus session', (r) => /cancelled|logged/.test(r.text) && snap.focusNow === null);
  await call('startFocus', { minutes: 0.02, subject: 'Tort' }); await new Promise((r) => setTimeout(r, 2600));
  check('a session that runs out ends itself', snap.focusNow === null);
  await ask('how much have I focused today?', (r) => /logged yet|today/.test(r.text));
  // habits
  await ask('Add a habit called reading', (r) => /Reading is now a daily habit/.test(r.text) && snap.habits.length === 1);
  await ask('track a habit called workout', () => snap.habits.length === 2);
  await ask('I did my workout', (r) => /Workout done/.test(r.text) && snap.habits.find((h) => h.name === 'Workout').days.length === 1);
  await ask("I've done my workout", (r) => /already/.test(r.text) && snap.habits.find((h) => h.name === 'Workout').days.length === 1, 'habit is not double counted');
  await ask('how are my habits', (r) => /1 of 2 done today/.test(r.text) && /reading/.test(r.text));
  // countdowns
  await ask('Count down to my tort exam on 12 January', (r) => /Tort exam is in \d+ (weeks|months|days)/.test(r.text) && snap.countdowns.length === 1 && new Date(snap.countdowns[0].date).getMonth() === 0);
  await ask('How many days until my tort exam?', (r) => /Tort exam is \d+ days away, on \w+ 12 January/.test(r.text));
  // day reviews and routines
  await call('addTask', { title: 'Submit the essay' }); await call('updateTask', { id: snap.tasks[0].id, patch: { done: true } });
  await ask('evening review', (r) => /Here's your day, Josh/.test(r.text) && /finished one task: submit the essay/.test(r.text) && /1 of 2 habits done/.test(r.text) && /Tomorrow starts with Gym at 7:30am/.test(r.text));
  await call('musicControl').catch(() => {}); await call('music', { action: 'play' }); await new Promise((r) => setTimeout(r, 900));
  await ask('Good night', (r) => /Paused\./.test(r.text) && /Here's your day/.test(r.text) && r.tools.includes('Music: pause'), 'routine: Good night runs both steps');
  await ask('Jarvis, good morning.', (r) => /Good (morning|afternoon|evening), Josh/.test(r.text) && /habit/.test(r.text), 'routine: Good morning gives the briefing');
  await call('saveRoutine', { name: 'Study mode', steps: ['pause the music', 'start a focus session for 50 minutes on revision'] });
  await ask('start my study mode routine', (r) => snap.focusNow && Math.round(snap.focusNow.total / 6e4) === 50 && snap.focusNow.subject === 'Revision', 'a routine made in Settings runs');
  await call('stopFocus');
  // everyday commands still behave
  await ask('remind me to call the dentist tomorrow at 9am', (r) => /remind you/.test(r.text) && snap.tasks.some((t) => /dentist/i.test(t.title) && t.due));
  await ask('set a timer for 5 minutes', () => snap.timers.length === 1 && !snap.focusNow, 'a plain timer is not a focus session');
  if (withLlm) {
    while (snap.status.llm !== 'ready') await new Promise((r) => setTimeout(r, 500));
    await ask('What was decided in my last meeting?', (r) => /march|press release/i.test(r.text) && !r.tools.length, 'answers from a Hark recording');
    await ask('Who is recruiting the beta customers from the product sync?', (r) => /george/i.test(r.text), 'finds an action item owner in a recording');
    await ask('Summarise what I copied', (r) => /rent|1,?020|february/i.test(r.text), 'reads the clipboard when asked');
    await ask('How are my habits going?', (r) => /workout|reading/i.test(r.text) && !r.tools.length, 'model sees habits in its context');
    await ask("What's the weather like?", (r) => !/rent|tenant/i.test(r.text) && !/sunny|degrees|rain/i.test(r.text), 'clipboard is not read unless mentioned, and weather is not invented offline');
  }
  await ask('copy that', (r) => /Copied/.test(r.text));
} catch (e) { check('run completed', false, String(e)); }
console.log(`\n${results.filter(Boolean).length}/${results.length} checks passed`);
child.kill(); process.exit(results.every(Boolean) ? 0 : 1);
