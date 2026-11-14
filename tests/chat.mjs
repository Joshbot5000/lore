// Talk to a running brain over its WebSocket. Usage: node tests/chat.mjs <url-with-token> "message" ["message" ...]
import WebSocket from 'ws';
const u = new URL(process.argv[2]);
const ws = new WebSocket(`ws://${u.host}/ws?k=${u.searchParams.get('k')}&d=test`);
const msgs = process.argv.slice(3);
let id = 1, snap = null, t0 = 0, first = 0, audio = 0, text = '', tools = [];
const next = () => {
  if (!msgs.length) { console.log('\nfinal state:', JSON.stringify({ tasks: snap.tasks.map((t) => t.title + (t.due ? ' @' + new Date(t.due).toLocaleString('en-GB') : '') + (t.done ? ' ✓' : '')), memories: snap.memories.map((m) => m.text), notes: snap.notes.map((n) => n.text), timers: snap.timers.length, music: snap.music?.state + ' ' + snap.music?.title, money: snap.money.map((m) => m.name + ' ' + m.amount) }, null, 1)); return void setTimeout(() => process.exit(0), 300); }
  const m = msgs.shift(); t0 = Date.now(); first = 0; audio = 0; text = ''; tools = [];
  console.log(`\n> ${m}`); ws.send(JSON.stringify({ id: id++, method: 'say', params: { text: m } }));
};
ws.on('message', (raw) => {
  const p = JSON.parse(String(raw));
  if (p.type === 'snapshot') { snap = p.data; console.log('status', JSON.stringify(snap.status), 'integrations', Object.entries(snap.integrations).map(([k, v]) => k + ':' + v.state).join(' ')); const wait = () => (snap.status.llm === 'ready' ? next() : setTimeout(wait, 500)); wait(); }
  else if (p.type === 'patch') Object.assign(snap, p.data);
  else if (p.type === 'audio') audio++;
  else if (p.type === 'say') {
    if (p.delta) { first ||= Date.now() - t0; text += p.delta; }
    if (p.tool) tools.push(`${p.tool.ok ? '✓' : '✗'} ${p.tool.label}`);
    if (p.done) { console.log(`< ${text.trim()}\n  [first words ${first} ms, total ${Date.now() - t0} ms${tools.length ? ', tools: ' + tools.join(' | ') : ''}]`); setTimeout(() => { console.log(`  [audio clips: ${audio}]`); next(); }, 2500); }
  }
});
ws.on('error', (e) => { console.error('ws error', e.message); process.exit(1); });
