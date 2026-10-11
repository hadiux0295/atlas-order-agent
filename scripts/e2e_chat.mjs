// End-to-end run of the agent front in a headless browser: brief chip → proof card → "looks good" →
// PayPal JS SDK v6 button → sandbox buyer login in the PayPal window → approve → capture → (webhook) → download.
// Usage: PAYPAL_ENV_FILE=… BASE_URL=https://… [SHOTS_DIR=…] [WIDTH=430] node scripts/e2e_chat.mjs ["brief text"]
import fs from 'node:fs';
import path from 'node:path';
import { chromium } from 'playwright';
import { loadEnvFile } from '../src/paypal.mjs';

const env = loadEnvFile(process.env.PAYPAL_ENV_FILE);
const BASE = process.env.BASE_URL.replace(/\/$/, '');
const brief = process.argv[2] || null; // null → click the first suggestion chip
const SHOTS = path.resolve(process.env.SHOTS_DIR || './shots');
const W = +(process.env.WIDTH || 430);
fs.mkdirSync(SHOTS, { recursive: true });

const cache = path.join(process.env.HOME, '.cache/ms-playwright');
const shell = fs.readdirSync(cache).filter((d) => d.startsWith('chromium_headless_shell-')).sort().reverse()[0];
const exe = ['chrome-linux/headless_shell', 'chrome-headless-shell-linux64/chrome-headless-shell']
  .map((x) => path.join(cache, shell, x)).find(fs.existsSync);

const b = await chromium.launch({ executablePath: exe, args: ['--no-sandbox'] });
const ctx = await b.newContext({ viewport: { width: W, height: W < 600 ? 932 : 900 }, locale: 'en-US' });
const page = await ctx.newPage();
let n = 0;
const shot = (p, name) => p.screenshot({ path: path.join(SHOTS, `${String(++n).padStart(2, '0')}_${name}.png`) });
const t0 = Date.now();
const lap = (msg) => console.log(`${((Date.now() - t0) / 1000).toFixed(1)}s ${msg}`);
page.on('console', (m) => { if (m.type() === 'error') console.log('  [console]', m.text().slice(0, 160)); });

try {
  await page.goto(BASE + '/');
  await page.evaluate(() => document.fonts.ready);
  await shot(page, 'home');
  if (brief) { await page.fill('#text', brief); await page.click('#send'); } else await page.click('#chips button');
  await page.locator('.card.proof img.cover').waitFor({ timeout: 60000 });
  await page.waitForFunction(() => [...document.querySelectorAll('.card.proof img')].every((i) => i.complete && i.naturalWidth > 0));
  lap('proof shown');
  await shot(page, 'proof');

  await page.locator('.card.proof .ok').last().click();
  const btn = page.locator('.card.checkout paypal-button:not([hidden])').last();
  await btn.waitFor({ timeout: 60000 });
  lap('checkout card + PayPal button');
  await shot(page, 'checkout');

  const [pp] = await Promise.all([ctx.waitForEvent('page', { timeout: 30000 }), btn.click()]);
  await pp.waitForLoadState('domcontentloaded');
  lap('PayPal window: ' + pp.url().slice(0, 70));
  await pp.locator('#email').fill(env.PAYPAL_SANDBOX_BUYER_EMAIL, { timeout: 30000 });
  if (await pp.locator('#btnNext').isVisible().catch(() => false)) await pp.click('#btnNext');
  await pp.locator('#password').fill(env.PAYPAL_SANDBOX_BUYER_PASSWORD, { timeout: 30000 });
  await pp.click('#btnLogin');
  const pay = pp.locator('[data-testid="submit-button-initial"], #payment-submit-btn, button:has-text("Complete Purchase"), button:has-text("Pay")').first();
  await pay.waitFor({ timeout: 60000 });
  await shot(pp, 'paypal_review');
  await pay.click();
  lap('approved in PayPal');

  const steps = page.locator('.card.checkout').last();
  for (let i = 0; i < 120; i++) {
    const state = await steps.evaluate((c) => [...c.querySelectorAll('.steps li')].map((li) => li.className[0] || '-').join(''));
    const dl = await steps.locator('a.dl:not([hidden])').count();
    if (i % 5 === 0) lap(`steps ${state}`);
    if (dl) { lap('READY ' + (await steps.locator('a.dl').getAttribute('href'))); break; }
    if (/Refunded|went wrong|error/i.test(await steps.locator('.hint').innerText())) { lap('STOPPED: ' + await steps.locator('.hint').innerText()); break; }
    await page.waitForTimeout(3000);
  }
  await shot(page, 'final');
  if (process.env.REFUND) { // unhappy path: ask the agent for a refund in the same chat
    const dl = await steps.locator('a.dl').getAttribute('href');
    await page.fill('#text', 'Oh no, I spelled the name wrong. Please refund this order.');
    await page.click('#send');
    await page.waitForFunction(() => [...document.querySelectorAll('.msg.bot')].some((m) => /Refund \S+ ·/.test(m.textContent)), null, { timeout: 60000 });
    lap('refund card: ' + (await page.locator('.msg.bot').filter({ hasText: /^Refund / }).last().innerText()));
    lap('download after refund → HTTP ' + (await page.request.get(BASE + dl)).status());
    await shot(page, 'refunded');
  }
} catch (e) {
  await shot(page, 'error').catch(() => {});
  console.error('E2E ERROR', e.message.split('\n')[0]);
  process.exitCode = 1;
} finally {
  await b.close();
}
