// Hold-to-talk through the real browser microphone path (a recorded clip stands in for the mic).
import { chromium } from 'playwright-core';
const [url, wav, out] = process.argv.slice(2);
const b = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium', args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', `--use-file-for-fake-audio-capture=${wav}%noloop`, '--autoplay-policy=no-user-gesture-required'] });
const page = await (await b.newContext({ viewport: { width: 1440, height: 900 } })).newPage(); const errors = [];
page.on('console', (m) => m.type() === 'error' && errors.push(m.text())); page.on('pageerror', (e) => errors.push('PAGEERROR ' + e.message));
await page.goto(url); await page.waitForSelector('.card-core'); await page.waitForTimeout(1500);
await page.locator('.card-head').first().click();
await page.keyboard.down('Space'); await page.waitForTimeout(1200);
console.log('while holding: state =', await page.locator('.state').innerText()); await page.screenshot({ path: `${out}/t01-listening.png` });
await page.waitForTimeout(5200); await page.keyboard.up('Space');
await page.waitForFunction(() => document.querySelector('.heard'), null, { timeout: 30000 }).catch(() => {});
console.log('heard:', await page.locator('.heard').innerText().catch(() => '(nothing)'));
await page.waitForFunction(() => (document.querySelector('.said')?.textContent ?? '').length > 20, null, { timeout: 120000 }).catch(() => {});
await page.waitForTimeout(1500); console.log('state while replying:', await page.locator('.state').innerText()); await page.screenshot({ path: `${out}/t02-speaking.png` });
await page.waitForFunction(() => !document.querySelector('.send.stop'), null, { timeout: 120000 }).catch(() => {});
console.log('said:', await page.locator('.said').innerText().catch(() => '')); console.log('toasts:', await page.locator('.toast').allInnerTexts(), '| errors:', errors.slice(0, 5).join(' || ') || 'none');
await b.close();
