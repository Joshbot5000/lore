// Screenshots of the interface against a running brain. Usage: node tests/look.mjs <url> <outDir> [phone]
import { chromium, devices } from 'playwright-core';
import fs from 'node:fs';
const [url, out, phone] = process.argv.slice(2); fs.mkdirSync(out, { recursive: true });
const b = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium', args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', '--autoplay-policy=no-user-gesture-required'] });
const ctx = await b.newContext(phone ? { ...devices['iPhone 14'] } : { viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 });
const page = await ctx.newPage(); const errors = [];
page.on('console', (m) => m.type() === 'error' && errors.push(m.text())); page.on('pageerror', (e) => errors.push('PAGEERROR ' + e.message));
let n = 0; const shot = async (name) => { await page.waitForTimeout(500); await page.screenshot({ path: `${out}/${phone ? 'p' : 'd'}${String(++n).padStart(2, '0')}-${name}.png` }); console.log('shot', name); };
try {
  await page.goto(url); await page.waitForSelector('.card-core', { timeout: 20000 }); await page.waitForTimeout(1500); await shot('dashboard');
  await page.fill('.say input', 'Remind me to submit the tort essay on Friday at 5pm'); await page.keyboard.press('Enter');
  await page.waitForSelector('.said', { timeout: 10000 }); await page.waitForTimeout(1200); await shot('thinking');
  await page.waitForFunction(() => document.querySelector('.tools span') || (document.querySelector('.said')?.textContent ?? '').length > 8, null, { timeout: 180000 });
  await page.waitForFunction(() => !document.querySelector('.send.stop'), null, { timeout: 180000 }).catch(() => {}); await shot('replied');
  console.log('reply:', await page.locator('.said').innerText(), '| tools:', await page.locator('.tools span').allInnerTexts());
  if (phone) { await page.click('.dock >> text=Today'); await shot('today'); await page.click('.dock >> text=Life'); await shot('life'); await page.click('.dock >> text=Memory'); await shot('memory'); }
  else {
    await page.mouse.wheel(0, 900); await shot('lower');
    await page.click('.top .chip >> nth=0'); await shot('memory'); await page.keyboard.press('Escape');
    await page.click('.top .chip >> nth=2'); await page.waitForSelector('.qr img', { timeout: 8000 }); await shot('pair'); await page.keyboard.press('Escape');
    await page.click('.top .chip >> nth=3'); await shot('settings'); await page.keyboard.press('Escape');
  }
  console.log('errors:', errors.length ? errors.slice(0, 6).join(' || ') : 'none');
} catch (e) { await page.screenshot({ path: `${out}/FAILED.png` }).catch(() => {}); console.log('FAILED', String(e.message).split('\n')[0], '| errors:', errors.slice(0, 6).join(' || ')); }
await b.close();
