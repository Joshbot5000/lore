// Voice round trip against a running brain: send recorded speech, expect a transcript, a reply and spoken audio back.
import WebSocket from 'ws';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
const u = new URL(process.argv[2]); const wav = process.argv[3]; const needWake = process.argv[4] === 'wake';
const raw = execFileSync('ffmpeg', ['-loglevel', 'error', '-i', wav, '-ar', '16000', '-ac', '1', '-f', 's16le', '-']);
const ws = new WebSocket(`ws://${u.host}/ws?k=${u.searchParams.get('k')}&d=test`);
let t0 = 0, text = '', clips = 0, bytes = 0, heard = '';
ws.on('message', (m) => {
  const p = JSON.parse(String(m));
  if (p.type === 'snapshot') { const go = () => { t0 = Date.now(); ws.send(JSON.stringify({ id: 1, method: 'hear', params: { pcm: raw.toString('base64'), needWake } })); }; setTimeout(go, 500); }
  else if (p.id === 1) { console.log(`heard after ${Date.now() - t0} ms:`, JSON.stringify(p.result ?? p.error)); if (p.result?.ignored || p.error) process.exit(0); }
  else if (p.type === 'say') { if (p.heard) heard = p.heard; if (p.delta) text += p.delta; if (p.done) setTimeout(() => { console.log(`reply: ${text.trim()}\nspoken clips: ${clips} (${Math.round(bytes / 2 / 24000 * 10) / 10}s of audio), total ${Date.now() - t0} ms`); process.exit(0); }, 6000); }
  else if (p.type === 'audio' && p.wav) { clips++; const b = Buffer.from(p.wav.slice(p.wav.indexOf(':') + 1), 'base64'); bytes += b.length; fs.appendFileSync('/tmp/jv-reply.pcm', b); }
});
