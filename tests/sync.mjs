// Checks that words appear on screen as they are spoken (not before), in a real browser playing real audio.
// Starts its own brain. Usage: JARVIS_MODELS_DIR=... node tests/sync.mjs
import { chromium } from 'playwright-core';
import { spawn } from 'node:child_process';
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path';
const data = fs.mkdtempSync(path.join(os.tmpdir(), 'jv-sync-'));
fs.writeFileSync(path.join(data, 'settings.json'), JSON.stringify({ userName: 'Josh', onboarded: true, speak: true, useAppleMail: false, studySource: '' }));
const port = 8200 + Math.floor(Math.random() * 90);
const child = spawn('node', ['out/main/headless.js'], { env: { ...process.env, JARVIS_FAKE_MAC: '1', JARVIS_DATA_DIR: data, JARVIS_HARK_DIR: path.join(data, 'none'), JARVIS_PORT: String(port) }, stdio: ['ignore', 'pipe', 'inherit'] });
const url = await new Promise((r) => child.stdout.on('data', (d) => { const m = String(d).match(/http:\/\/localhost:\d+\/\?k=\w+/); if (m) r(m[0]); }));
const results = []; const check = (name, ok, extra = '') => { results.push(!!ok); console.log(ok ? 'PASS' : 'FAIL', name, extra ? `— ${extra}` : ''); };
const b = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium', args: ['--no-sandbox', '--autoplay-policy=no-user-gesture-required'] });
try {
  const page = await (await b.newContext({ viewport: { width: 1440, height: 900 } })).newPage(); const errs = [];
  page.on('console', (m) => m.type() === 'error' && errs.push(m.text())); page.on('pageerror', (e) => errs.push('PAGEERROR ' + e.message));
  await page.goto(url); await page.waitForSelector('.card-core'); 
  await page.waitForFunction(() => /VOICE\s*READY/i.test(document.body.innerText) && /MIND\s*READY/i.test(document.body.innerText), null, { timeout: 120000 });
  await page.waitForTimeout(3000); // let the engines settle so timings are not skewed by start-up
  const run = async (text) => {
    const before = await page.evaluate(() => document.querySelector('.said')?.innerText ?? '');
    await page.click('.say input'); await page.fill('.say input', text); const t0 = Date.now(); await page.keyboard.press('Enter');
    const samples = [];
    for (let i = 0; i < 400; i++) {
      const s = await page.evaluate(() => ({ said: document.querySelector('.said')?.innerText ?? '', dots: !!document.querySelector('.said .dots'), mode: document.querySelector('.core-hint')?.innerText ?? '' }));
      if (before && s.said === before && samples.every((x) => x.len === 0)) { samples.push({ t: Date.now() - t0, len: 0, said: '', mode: s.mode }); await page.waitForTimeout(100); continue; } // still showing the previous reply
      samples.push({ t: Date.now() - t0, len: s.dots ? 0 : s.said.length, said: s.said, mode: s.mode });
      if (samples.length > 80 && samples.slice(-70).every((x) => x.len === samples[samples.length - 1].len && x.len > 0) && !/interrupt/i.test(s.mode)) break;
      await page.waitForTimeout(150);
    }
    return samples;
  };
  const s = await run('briefing');
  const full = s[s.length - 1].len, first = s.find((x) => x.len > 0), half = s.find((x) => x.len >= full / 2), end = s.find((x) => x.len === full);
  const grows = s.every((x, i) => i === 0 || x.len >= s[i - 1].len - 2);
  check('the reply appears gradually, not all at once', first && first.len < full * 0.45 && s.filter((x, i) => i > 0 && x.len > s[i - 1].len).length >= 8, `first shows ${first?.len} of ${full} characters at ${first?.t} ms: “${first?.said}”`);
  check('the words keep pace with the voice to the end', grows && half && end && end.t - first.t > 6000 && half.t - first.t > (end.t - first.t) * 0.25 && half.t - first.t < (end.t - first.t) * 0.75, `half at ${half?.t} ms, all ${full} characters at ${end?.t} ms`);
  check('the whole reply is on screen when he finishes', /habit|list|calendar/i.test(s[s.length - 1].said) && full > 120);
  const q = await run('what time is it');
  check('a short answer appears with its sound', q[q.length - 1].len > 8 && q.find((x) => x.len > 0).t < 6000, `visible after ${q.find((x) => x.len > 0)?.t} ms: “${q[q.length - 1].said}”`);
  await page.click('.top .chip >> nth=2').catch(() => {});
  check('no errors in the page', errs.length === 0, errs.slice(0, 3).join(' || '));
} catch (e) { check('run completed', false, String(e.stack ?? e).slice(0, 500)); }
console.log(`\n${results.filter(Boolean).length}/${results.length} checks passed`);
await b.close(); child.kill(); process.exit(results.every(Boolean) ? 0 : 1);
