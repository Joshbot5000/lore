// End-to-end check of Home Assistant, IMAP mail, Spotify requests, instant answers and the voice pipeline,
// against stand-in servers. Starts its own brain. Usage: JARVIS_MODELS_DIR=... node tests/home.mjs
import WebSocket from 'ws';
import http from 'node:http'; import net from 'node:net';
import { spawn } from 'node:child_process';
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path';
const data = fs.mkdtempSync(path.join(os.tmpdir(), 'jv-home-'));
fs.writeFileSync(path.join(data, 'settings.json'), JSON.stringify({ userName: 'Josh', onboarded: true, speak: false, useAppleMail: false }));

// ---- a stand-in Home Assistant (and search engine)
const TOKEN = 'ha-test-token';
const st = (entity_id, state, attributes = {}) => ({ entity_id, state, attributes });
const states = [
  st('light.kitchen_ceiling', 'off', { friendly_name: 'Kitchen ceiling' }), st('light.kitchen_counter', 'off', { friendly_name: 'Kitchen counter' }),
  st('light.lamp', 'on', { friendly_name: 'Lamp', brightness: 255 }), st('light.bedroom', 'off', { friendly_name: 'Bedroom light' }),
  st('switch.coffee_machine', 'off', { friendly_name: 'Coffee machine' }), st('scene.movie_night', 'scening', { friendly_name: 'Movie night' }),
  st('climate.heating', 'heat', { friendly_name: 'Heating', temperature: 19, current_temperature: 18.4 }),
  st('sensor.living_room_temperature', '21.3', { friendly_name: 'Living room temperature', device_class: 'temperature', unit_of_measurement: '°C' }),
  st('sensor.power', '120', { friendly_name: 'Power', device_class: 'power' }), st('light.broken', 'unavailable', { friendly_name: 'Broken light' }),
];
const calls = []; const cloud = []; let cloudFail = false;
const web = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://x');
  if (url.pathname === '/html/') {
    const q = url.searchParams.get('q') ?? '';
    const hit = /blinding/i.test(q) ? '<a rel="nofollow" class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fopen.spotify.com%2Ftrack%2F0VjIjW4GlUZAMYd2vXMi3b&rut=x">Blinding Lights - song and lyrics by The Weeknd | Spotify</a><a class="result__snippet">Listen</a>' : '';
    return void res.end(`<html><body>${hit}</body></html>`);
  }
  // ---- stand-in ElevenLabs and OpenAI
  if (url.pathname === '/v1/voices') return req.headers['xi-api-key'] === 'el-good' ? void res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ voices: [{ voice_id: 'v-rachel', name: 'Rachel', labels: { accent: 'american', gender: 'female' } }, { voice_id: 'v-george', name: 'George - Warm', labels: { accent: 'british', gender: 'male', description: 'warm' } }] })) : void res.writeHead(401, { 'Content-Type': 'application/json' }).end(JSON.stringify({ detail: { status: 'invalid_api_key', message: 'Invalid API key' } }));
  if (url.pathname.startsWith('/v1/text-to-speech/')) { let b = ''; req.on('data', (d) => (b += d)); req.on('end', () => { cloud.push({ voice: url.pathname.split('/').pop(), ...JSON.parse(b) }); if (cloudFail) return void res.writeHead(401, { 'Content-Type': 'application/json' }).end(JSON.stringify({ detail: { status: 'quota_exceeded', message: 'You have run out of credits' } })); res.writeHead(200, { 'Content-Type': 'audio/mpeg' }).end(`MP3 for: ${JSON.parse(b).text}`); }); return; }
  if (url.pathname === '/v1/models') return req.headers.authorization === 'Bearer oa-good' ? void res.end('{"data":[]}') : void res.writeHead(401, { 'Content-Type': 'application/json' }).end(JSON.stringify({ error: { message: 'Incorrect API key provided' } }));
  if (url.pathname === '/v1/audio/speech') { let b = ''; req.on('data', (d) => (b += d)); req.on('end', () => { cloud.push(JSON.parse(b)); res.writeHead(200, { 'Content-Type': 'audio/mpeg' }).end(`MP3 for: ${JSON.parse(b).input}`); }); return; }
  if (req.headers.authorization !== `Bearer ${TOKEN}`) return void res.writeHead(401).end('{}');
  if (url.pathname === '/api/states') return void res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify(states));
  const svc = url.pathname.match(/^\/api\/services\/(\w+)\/(\w+)$/);
  if (svc && req.method === 'POST') {
    let body = ''; req.on('data', (d) => (body += d)); req.on('end', () => {
      const d = JSON.parse(body); calls.push({ domain: svc[1], service: svc[2], ...d });
      for (const id of [].concat(d.entity_id)) { const e = states.find((x) => x.entity_id === id); if (!e) continue;
        if (svc[2] === 'turn_on') { if (!id.startsWith('scene.')) e.state = 'on'; if (d.brightness_pct) e.attributes.brightness = Math.round(d.brightness_pct * 2.55); }
        else if (svc[2] === 'turn_off') e.state = 'off'; else if (svc[2] === 'toggle') e.state = e.state === 'on' ? 'off' : 'on';
        else if (svc[2] === 'set_temperature') e.attributes.temperature = d.temperature; }
      res.writeHead(200, { 'Content-Type': 'application/json' }).end('[]');
    });
    return;
  }
  res.writeHead(404).end('{}');
});
await new Promise((r) => web.listen(0, '127.0.0.1', r));
const HA = `http://127.0.0.1:${web.address().port}`;

// ---- a stand-in IMAP mail server with two unread messages
const imapLog = [];
const imap = net.createServer((sock) => {
  sock.write('* OK stand-in IMAP ready\r\n'); let buf = '';
  sock.on('data', (d) => { buf += d; let i; while ((i = buf.indexOf('\r\n')) >= 0) { const line = buf.slice(0, i); buf = buf.slice(i + 2); const [tag, ...rest] = line.split(' '); const cmd = rest.join(' '); const up = cmd.toUpperCase(); imapLog.push(up.replace(/LOGIN .*/, 'LOGIN …'));
    const ok = (extra = '') => sock.write(`${extra}${tag} OK done\r\n`);
    if (up.startsWith('CAPABILITY')) ok('* CAPABILITY IMAP4rev1\r\n');
    else if (up.startsWith('LOGIN')) (/"?abcd efgh ijkl mnop"?$|abcdefghijklmnop/.test(cmd.replace(/"/g, '')) ? ok() : sock.write(`${tag} NO [AUTHENTICATIONFAILED] Invalid credentials\r\n`));
    else if (up.startsWith('EXAMINE') || up.startsWith('SELECT')) sock.write(`* 3 EXISTS\r\n* 0 RECENT\r\n* FLAGS (\\Seen \\Answered)\r\n* OK [UIDVALIDITY 7] ok\r\n* OK [UIDNEXT 10] ok\r\n${tag} OK [READ-ONLY] done\r\n`);
    else if (up.startsWith('UID SEARCH')) ok('* SEARCH 7 9\r\n');
    else if (up.startsWith('UID FETCH')) ok('* 2 FETCH (UID 7 INTERNALDATE "14-Nov-2026 09:00:00 +0000" ENVELOPE ("Sat, 14 Nov 2026 09:00:00 +0000" "Seminar moved to Thursday" (("Dr Patel" NIL "patel" "uni.example")) NIL NIL NIL NIL NIL NIL "<a@x>"))\r\n* 3 FETCH (UID 9 INTERNALDATE "14-Nov-2026 11:30:00 +0000" ENVELOPE ("Sat, 14 Nov 2026 11:30:00 +0000" "Re: Five-a-side on Sunday?" ((NIL NIL "sam" "mates.example")) NIL NIL NIL NIL NIL NIL "<b@x>"))\r\n');
    else if (up.startsWith('LOGOUT')) { sock.write(`* BYE\r\n${tag} OK bye\r\n`); sock.end(); }
    else ok(); } });
  sock.on('error', () => {});
});
await new Promise((r) => imap.listen(0, '127.0.0.1', r));

const port = 8000 + Math.floor(Math.random() * 90);
const child = spawn('node', ['out/main/headless.js'], { env: { ...process.env, JARVIS_FAKE_MAC: '1', JARVIS_DATA_DIR: data, JARVIS_HARK_DIR: path.join(data, 'none'), JARVIS_PORT: String(port), JARVIS_SEARCH_URL: `${HA}/html/`, JARVIS_ELEVEN_URL: HA, JARVIS_OPENAI_URL: HA }, stdio: ['ignore', 'pipe', 'inherit'] });
const url = await new Promise((r) => child.stdout.on('data', (d) => { const m = String(d).match(/http:\/\/localhost:\d+\/\?k=\w+/); if (m) r(new URL(m[0])); }));
const ws = new WebSocket(`ws://${url.host}/ws?k=${url.searchParams.get('k')}&d=test`);
let snap = null, id = 1, cur = null; const waits = new Map(); const audio = []; const timings = [];
ws.on('message', (raw) => {
  const p = JSON.parse(String(raw));
  if (p.id !== undefined && waits.has(p.id)) return void (waits.get(p.id)(p), waits.delete(p.id));
  if (p.type === 'snapshot') snap = p.data; else if (p.type === 'patch') Object.assign(snap, p.data);
  else if (p.type === 'audio' && p.wav && p.wav.startsWith('mp3:')) audio.push({ at: Date.now(), gap: p.gap, text: p.text, mp3: Buffer.from(p.wav.slice(4), 'base64').toString(), secs: 0, pcm: Buffer.alloc(0) });
  else if (p.type === 'audio' && p.wav) audio.push({ at: Date.now(), gap: p.gap, text: p.text, secs: (Buffer.from(p.wav.slice(p.wav.indexOf(':') + 1), 'base64').length / 2) / +p.wav.slice(0, p.wav.indexOf(':')), pcm: Buffer.from(p.wav.slice(p.wav.indexOf(':') + 1), 'base64') });
  else if (p.type === 'say' && p.timing) timings.push(p.timing);
  else if (p.type === 'say' && cur) { if (p.delta) cur.text += p.delta; if (p.tool) cur.tools.push(p.tool); if (p.timing) cur.timing = p.timing; if (p.done) cur.done(); }
});
await new Promise((r) => ws.on('open', r)); while (!snap) await new Promise((r) => setTimeout(r, 50));
const call = (method, params = {}) => new Promise((r) => { const n = id++; waits.set(n, r); ws.send(JSON.stringify({ id: n, method, params })); });
const say = (text) => new Promise((resolve) => { const t0 = Date.now(); cur = { text: '', tools: [], done: () => { const c = cur; cur = null; setTimeout(() => resolve({ text: c.text.trim(), tools: c.tools, ms: Date.now() - t0, timing: c.timing }), 150); } }; ws.send(JSON.stringify({ id: id++, method: 'say', params: { text } })); });
const results = []; const check = (name, ok, extra = '') => { results.push(!!ok); console.log(ok ? 'PASS' : 'FAIL', name, extra ? `— ${extra}` : ''); };
const ask = async (text, test, name) => { const r = await say(text); check(name ?? text, test(r), `“${r.text.slice(0, 150)}”${r.tools.length ? ` [${r.tools.map((t) => (t.ok ? '' : '✗ ') + t.label).join(' | ')}]` : ''} (${r.ms} ms)`); return r; };
// Wait until speech has stopped arriving (a busy machine makes fixed waits unreliable).
const hush = async (quietMs = 3500) => { let n = -1, since = Date.now(); for (let i = 0; i < 240; i++) { if (audio.length !== n) (n = audio.length), (since = Date.now()); else if (n > 0 && Date.now() - since > quietMs) return; await new Promise((r2) => setTimeout(r2, 250)); } };
const S = (eid) => states.find((x) => x.entity_id === eid);
const last = () => calls[calls.length - 1] ?? {};
try {
  // ---------------- Home Assistant
  let r = await call('saveHomeAssistant', { url: HA, token: 'wrong' });
  check('a bad token is refused, with a reason', /rejected the token/.test(r.error ?? ''), r.error);
  r = await call('saveHomeAssistant', { url: HA, token: TOKEN });
  check('connects and finds the devices', r.result?.devices === 7, JSON.stringify(r.result ?? r.error));
  check('devices appear as tiles, with state', snap.home.filter((h) => h.kind === 'ha').length === 7 && snap.home.find((h) => h.id === 'light.lamp')?.on === true && snap.home.find((h) => h.id === 'climate.heating')?.detail === '18.4°' && snap.integrations.home.state === 'ok', snap.integrations.home.detail);
  await ask('Turn on the kitchen lights', (x) => /2 lights on/.test(x.text) && S('light.kitchen_ceiling').state === 'on' && S('light.kitchen_counter').state === 'on' && S('light.bedroom').state === 'off');
  await ask('Jarvis, set the lamp to 40 percent', (x) => /Lamp at 40 percent/.test(x.text) && last().service === 'turn_on' && last().brightness_pct === 40);
  await ask('set the heating to 20 degrees', (x) => /Heating set to 20 degrees/.test(x.text) && last().domain === 'climate' && S('climate.heating').attributes.temperature === 20);
  await ask("what's the temperature in the living room?", (x) => /Living room temperature is at 21.3 degrees/.test(x.text));
  await ask('is the lamp on?', (x) => /Lamp is on/.test(x.text));
  await ask('activate movie night', (x) => /Movie night is on/.test(x.text) && last().domain === 'scene' && last().entity_id[0] === 'scene.movie_night');
  await ask('switch the coffee machine on', (x) => S('switch.coffee_machine').state === 'on' && /Coffee machine is on/.test(x.text));
  await ask('turn off all the lights', (x) => ['light.kitchen_ceiling', 'light.kitchen_counter', 'light.lamp', 'light.bedroom'].every((e) => S(e).state === 'off') && S('switch.coffee_machine').state === 'on' && !last().entity_id.includes('light.broken'));
  await call('tapHome', { id: 'light.bedroom' }); await new Promise((r2) => setTimeout(r2, 1000));
  check('tapping a tile toggles it and the dashboard follows', S('light.bedroom').state === 'on' && snap.home.find((h) => h.id === 'light.bedroom')?.on === true);
  await ask('turn off the music', (x) => /Paused/.test(x.text) && x.ms < 600 && !calls.some((c) => JSON.stringify(c).includes('music')), 'non-home commands are left alone');
  // ---------------- mail
  r = await call('saveMailAccount', { preset: 'other', host: '127.0.0.1', port: imap.address().port, user: 'josh@example.com', pass: 'wrong-password' });
  check('a wrong mail password is refused, with a reason', /refused the password/.test(r.error ?? ''), r.error);
  r = await call('saveMailAccount', { preset: 'other', host: '127.0.0.1', port: imap.address().port, user: 'josh@example.com', pass: 'abcd efgh ijkl mnop' });
  check('mail account connects', r.result?.unread === 2, JSON.stringify(r.result ?? r.error));
  await new Promise((r2) => setTimeout(r2, 1500));
  check('unread mail shows on the dashboard, newest first', snap.unread === 2 && snap.mail[0]?.from === 'Sam' && snap.mail[1]?.from === 'Dr Patel' && snap.integrations.mail.state === 'ok', JSON.stringify(snap.mail.map((m) => `${m.from}: ${m.subject}`)));
  check('the inbox is opened read-only', imapLog.some((l) => l.startsWith('EXAMINE')) && !imapLog.some((l) => /^SELECT|STORE|EXPUNGE|DELETE/.test(l)), [...new Set(imapLog)].join(', '));
  await ask('do I have any emails?', (x) => /2 unread/.test(x.text) && /Dr Patel about Seminar moved/.test(x.text) && /Five-a-side/.test(x.text) && x.ms < 600);
  await new Promise((r2) => setTimeout(r2, 400));
  const disk = (f) => fs.readFileSync(path.join(data, f), 'utf8');
  const exported = (await call('exportData')).result;
  check('passwords and tokens stay out of settings, the dashboard and exports', !/mnop|ha-test-token/.test(disk('settings.json') + JSON.stringify(snap) + exported) && /mnop/.test(disk('secrets.json')) && /ha-test-token/.test(disk('secrets.json')) && (fs.statSync(path.join(data, 'secrets.json')).mode & 0o077) === 0);
  // ---------------- music
  await call('music', { action: 'play' }); await new Promise((r2) => setTimeout(r2, 800));
  await ask('what song is this?', (x) => /This is Midnight City by M83/.test(x.text) && x.ms < 900);
  await ask('who sings this', (x) => /M83/.test(x.text));
  await ask('play Blinding Lights by The Weeknd', (x) => /Playing Played spotify:track:0VjIjW4GlUZAMYd2vXMi3b/.test(x.text) && x.tools[0]?.ok, 'finds a song and plays it by its Spotify address');
  await ask('play some obscure thing nobody has heard of', (x) => /couldn't find .* opened the search in Spotify/.test(x.text) && x.tools[0]?.ok === false, 'says so when it cannot find something');
  await ask('pause the music', (x) => /Paused/.test(x.text)); await new Promise((r2) => setTimeout(r2, 900));
  check('the dashboard shows it paused', snap.music.state === 'paused');
  // ---------------- instant answers
  await ask("what's on today?", (x) => /calendar|today:/i.test(x.text) && x.ms < 600);
  await ask("what's on my list?", (x) => /list is empty/.test(x.text));
  await ask("what's the weather like?", (x) => /Tell me your town|can't reach/.test(x.text) && x.ms < 600);
  // ---------------- voice
  await call('saveSettings', { speak: true });
  while (snap.status.voice !== 'ready') await new Promise((r2) => setTimeout(r2, 300));
  audio.length = 0; const t0 = Date.now();
  r = await say('what time is it');
  await hush(1500);
  check('a spoken answer starts quickly', audio.length === 1 && audio[0].at - t0 < 5000, `first sound after ${audio[0]?.at - t0} ms; stages ${JSON.stringify(timings[timings.length - 1])}`);
  const quiet = (b, from, step) => { let i = from, n = 0; while (i >= 0 && i < b.length - 1 && Math.abs(b.readInt16LE(i)) < 200) { i += step * 2; n++; } return n / 24000; };
  check('clips carry no padding silence', audio[0] && quiet(audio[0].pcm, 0, 1) < 0.06 && quiet(audio[0].pcm, audio[0].pcm.length - 2, -1) < 0.09, `lead ${quiet(audio[0].pcm, 0, 1).toFixed(2)} s, tail ${quiet(audio[0].pcm, audio[0].pcm.length - 2, -1).toFixed(2)} s`);
  audio.length = 0; const tb = Date.now(); await say('briefing'); await hush(22000);
  check('a long reply is voiced as a few flowing passages with a breath between', audio.length >= 2 && audio.length <= 4 && audio.every((a) => a.gap === 280) && /\. \w/.test(audio[audio.length - 1].text), `${audio.length} clips (${audio.map((a) => a.secs.toFixed(1) + ' s').join(', ')}), first sound after ${audio[0]?.at - tb} ms, gaps ${[...new Set(audio.map((a) => a.gap))]}`);
  if (process.env.SHOTS) {
    const { chromium } = await import('playwright-core');
    const b = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium', args: ['--no-sandbox'] });
    const page = await (await b.newContext({ viewport: { width: 1440, height: 1100 } })).newPage(); const errs = [];
    page.on('console', (m) => m.type() === 'error' && errs.push(m.text())); page.on('pageerror', (e) => errs.push('PAGEERROR ' + e.message));
    await page.goto(url.href); await page.waitForSelector('.card-home .tiles'); await page.waitForTimeout(1200);
    await page.locator('.card-home').screenshot({ path: `${process.env.SHOTS}/home-card.png` });
    await page.locator('.card-core').screenshot({ path: `${process.env.SHOTS}/core.png` });
    await page.click('.top .chip >> nth=3'); await page.waitForSelector('text=Home Assistant'); await page.locator('text=Mail accounts').scrollIntoViewIfNeeded(); await page.waitForTimeout(500);
    await page.screenshot({ path: `${process.env.SHOTS}/settings.png` });
    check('interface shows the new sections without errors', errs.length === 0, errs.slice(0, 3).join(' || '));
    await b.close();
  }
  // ---------------- voices
  const mv = (await call('macVoices')).result;
  check("the Mac's own voices are offered, best first, English only", mv.length === 4 && mv[0].id === 'mac:Jamie (Premium)' && mv[0].quality === 'premium' && !mv.some((v) => /Thomas/.test(v.name)), mv.map((v) => v.name).join(', '));
  audio.length = 0; await call('saveSettings', { voice: 'mac:Jamie (Premium)' }); await say('what time is it'); await hush(1500);
  check('a Mac voice is used when chosen, with its padding trimmed', audio.length === 1 && quiet(audio[0].pcm, 0, 1) < 0.03 && Math.abs(audio[0].secs - (0.3 + audio[0].text.length * 0.04)) < 0.2, `${audio[0]?.secs.toFixed(2)} s clip`);
  audio.length = 0; await call('saveSettings', { voice: 'bm_george*0.55+bm_fable*0.45' }); await say('what time is it'); await hush();
  const blend = audio[0]?.pcm;
  audio.length = 0; await call('saveSettings', { voice: 'bm_george' }); await say('what time is it'); await hush();
  const plain = audio[0]?.pcm; let diff = 0; for (let i = 0; i < Math.min(blend.length, plain.length) - 1; i += 2) diff += Math.abs(blend.readInt16LE(i) - plain.readInt16LE(i));
  check('a blended voice really is a different voice', blend && plain && diff / (Math.min(blend.length, plain.length) / 2) > 300, `average difference ${(diff / (Math.min(blend.length, plain.length) / 2)).toFixed(0)}`);
  // ---------------- cloud voices
  let cr = await call('saveVoiceKey', { provider: 'eleven', key: 'el-bad' });
  check('a wrong cloud voice key is refused, with a reason', /ElevenLabs rejected the key/.test(cr.error ?? ''), cr.error);
  cr = await call('saveVoiceKey', { provider: 'eleven', key: 'el-good' });
  const cv = (await call('cloudVoices')).result;
  check('ElevenLabs voices are listed, British first', cr.result?.ok && cv.eleven?.[0]?.id === 'eleven:v-george' && cv.eleven[0].name === 'George' && cv.openai === null, JSON.stringify(cv.eleven));
  audio.length = 0; await call('saveSettings', { voice: 'eleven:v-george' }); await say('what time is it'); await hush(1500);
  check('replies are spoken with the cloud voice', audio.length === 1 && /^MP3 for: It's \d/.test(audio[0].mp3) && cloud[cloud.length - 1].voice === 'v-george' && cloud[cloud.length - 1].model_id === 'eleven_flash_v2_5', audio[0]?.mp3);
  cloudFail = true; audio.length = 0; await say('what time is it'); await hush(3500); cloudFail = false;
  check('if the cloud voice fails, the built-in voice takes over', audio.length === 1 && !audio[0].mp3 && audio[0].secs > 0.5);
  cr = await call('saveVoiceKey', { provider: 'openai', key: 'oa-good' });
  audio.length = 0; await call('saveSettings', { voice: 'openai:fable' }); await say('what time is it'); await hush(1500);
  check('OpenAI voices work too', cr.result?.ok && audio.length === 1 && /^MP3 for/.test(audio[0].mp3) && cloud[cloud.length - 1].voice === 'fable' && /British/.test(cloud[cloud.length - 1].instructions));
  await new Promise((r2) => setTimeout(r2, 400));
  check('cloud keys are kept out of settings and the dashboard', !/el-good|oa-good/.test(fs.readFileSync(path.join(data, 'settings.json'), 'utf8') + JSON.stringify(snap)) && /el-good/.test(fs.readFileSync(path.join(data, 'secrets.json'), 'utf8')));
  await call('saveSettings', { voice: 'bm_george*0.55+bm_fable*0.45' });
  // ---------------- everyday commands, without the language model
  const fastCmd = async (text, re, name) => ask(text, (x) => re.test(x.text) && x.ms < 700, name);
  await fastCmd('Open Safari for me', /Opening Safari/);
  await fastCmd('open youtube', /Opening youtube/);
  await fastCmd('set the volume to 30', /Volume at 30/);
  await fastCmd('turn it up a bit', /Louder/);
  await fastCmd('lock the screen', /Locked/);
  await fastCmd('switch to dark mode', /Dark mode on/);
  await fastCmd('run movie night', /Movie night/);
  await fastCmd('Schedule dinner with Sam on Friday at 7pm', /Dinner with Sam, .*7pm.*calendar/);
  await fastCmd('track Netflix £10.99 a month', /Tracking Netflix at £10.99 a month/);
  await fastCmd('thanks Jarvis', /Any time|Of course|My pleasure/);
  await fastCmd('hello', /What do you need|What can I do|Go ahead/);
  check('scheduled event is on the calendar', snap.events.some((e) => e.title === 'Dinner with Sam'));
  const report = (await call('diagnose')).result;
  check('the health check reports every part', /Mind: /.test(report) && /Ears: /.test(report) && /Voice: .*making speech [\d.]+x faster/.test(report) && /Music check \(Spotify\): (playing|paused)/.test(report) && /Calendar: \d+ events/.test(report) && /home: ok/.test(report), report.split('\n').slice(0, 6).join(' | ').slice(0, 300));
  if (process.argv.includes('--llm')) {
    while (snap.status.llm !== 'ready') await new Promise((r2) => setTimeout(r2, 500));
    audio.length = 0; const r3 = await say('Tell me in two sentences why sleep matters.'); await hush(9000);
    check('an answer from the language model is spoken in full', audio.length >= 1 && audio.map((a) => a.text).join(' ').replace(/\s+/g, ' ').length >= r3.text.replace(/\s+/g, ' ').length * 0.9, `${audio.length} clips for “${r3.text.slice(0, 120)}”; stages ${JSON.stringify(timings[timings.length - 1])}`);
  }
} catch (e) { check('run completed', false, String(e.stack ?? e)); }
console.log(`\n${results.filter(Boolean).length}/${results.length} checks passed`);
child.kill(); process.exit(results.every(Boolean) ? 0 : 1);
