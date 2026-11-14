// The real desktop app: first-run flow in Electron, with models already present.
import { _electron as electron } from 'playwright-core';
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path';
const out = process.argv[2] ?? '/tmp/jv-shots'; fs.mkdirSync(out, { recursive: true });
const data = fs.mkdtempSync(path.join(os.tmpdir(), 'jv-shell-'));
fs.writeFileSync(path.join(data, 'settings.json'), JSON.stringify({ llmModel: 'qwen-2b' }));
const app = await electron.launch({ ...(process.env.JARVIS_EXE ? { executablePath: process.env.JARVIS_EXE, args: ['--no-sandbox'] } : { args: ['--no-sandbox', '.'] }), env: { ...process.env, JARVIS_DATA_DIR: data, JARVIS_FAKE_MAC: '1', JARVIS_PORT: '7791' } });
const page = await app.firstWindow(); const errors = [];
page.on('console', (m) => m.type() === 'error' && errors.push(m.text())); page.on('pageerror', (e) => errors.push('PAGEERROR ' + e.message));
await page.setViewportSize({ width: 1440, height: 900 });
const t0 = Date.now(); const log = (...a) => console.log(`[${((Date.now() - t0) / 1000).toFixed(0)}s]`, ...a);
try {
  await page.waitForSelector('.onboard'); await page.waitForTimeout(900); await page.screenshot({ path: `${out}/s01-boot.png` });
  await page.waitForSelector('.onboard-card input', { timeout: 15000 }); await page.fill('.onboard-card input', 'Josh'); await page.screenshot({ path: `${out}/s02-name.png` }); await page.keyboard.press('Enter');
  await page.waitForSelector('text=Good to meet you'); await page.fill('.onboard-card input', 'Stockport'); await page.screenshot({ path: `${out}/s03-place.png` });
  await page.click('.onboard-card .btn.big'); await page.waitForSelector('.dl-list'); await page.waitForTimeout(600); await page.screenshot({ path: `${out}/s04-online.png` });
  await page.click('text=Wake me up'); await page.waitForSelector('.card-core', { timeout: 20000 });
  await page.waitForFunction(() => (document.querySelector('.said')?.textContent ?? '').includes('Good'), null, { timeout: 60000 });
  log('briefing:', (await page.locator('.said').innerText()).slice(0, 260));
  await page.waitForTimeout(2500); await page.screenshot({ path: `${out}/s05-briefing.png` });
  await page.waitForFunction(() => document.querySelector('.eng.ready'), null, { timeout: 90000 });
  await page.fill('.say input', "What's my name and where do I live?"); await page.keyboard.press('Enter');
  await page.waitForFunction(() => !document.querySelector('.send.stop') && /Josh|Stockport/.test(document.querySelector('.said')?.textContent ?? ''), null, { timeout: 180000 });
  log('answer:', await page.locator('.said').innerText()); await page.screenshot({ path: `${out}/s06-answer.png` });
  log('status chips:', (await page.locator('.eng').allInnerTexts()).join(' | '));
  log('errors:', errors.length ? errors.slice(0, 5).join(' || ') : 'none');
} catch (e) { await page.screenshot({ path: `${out}/SHELL-FAILED.png` }).catch(() => {}); console.log('SHELL FAILED', String(e.message).split('\n')[0], '|', errors.slice(0, 5).join(' || ')); }
await app.close();
