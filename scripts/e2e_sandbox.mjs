// End-to-end sandbox run in a headless browser: form → PayPal sandbox login → approve →
// back on /status until the zip link appears. Screenshots of every step go to SHOTS_DIR.
// Usage: PAYPAL_ENV_FILE=… BASE_URL=https://… node scripts/e2e_sandbox.mjs [child] [ICAO]
import fs from 'node:fs';
import path from 'node:path';
import { chromium } from 'playwright';
import { loadEnvFile } from '../src/paypal.mjs';

const env = loadEnvFile(process.env.PAYPAL_ENV_FILE);
const BASE = process.env.BASE_URL.replace(/\/$/, '');
const [child = 'Noah', ident = 'KJFK'] = process.argv.slice(2);
const SHOTS = path.resolve(process.env.SHOTS_DIR || './shots');
fs.mkdirSync(SHOTS, { recursive: true });

const cache = path.join(process.env.HOME, '.cache/ms-playwright');
const shell = fs.readdirSync(cache).filter((d) => d.startsWith('chromium_headless_shell-')).sort().reverse()[0];
const exe = ['chrome-linux/headless_shell', 'chrome-headless-shell-linux64/chrome-headless-shell']
  .map((x) => path.join(cache, shell, x)).find(fs.existsSync);

const b = await chromium.launch({ executablePath: exe, args: ['--no-sandbox'] });
const page = await b.newPage({ viewport: { width: 430, height: 932 }, locale: 'en-US' });
let n = 0;
const shot = (name) => page.screenshot({ path: path.join(SHOTS, `${String(++n).padStart(2, '0')}_${name}.png`) });
const t0 = Date.now();
const lap = (msg) => console.log(`${((Date.now() - t0) / 1000).toFixed(1)}s ${msg}`);

try {
  await page.goto(BASE + '/');
  await page.fill('input[name=child]', child);
  await page.fill('input[name=ident]', ident);
  await shot('form');
  await Promise.all([page.waitForURL(/paypal\.com/, { timeout: 30000 }), page.click('button')]);
  lap('on PayPal: ' + page.url().slice(0, 80));
  await page.waitForLoadState('domcontentloaded');
  await shot('paypal_landing');

  // Login: email → Next → password → Log In (the page sometimes shows both fields at once)
  await page.locator('#email').fill(env.PAYPAL_SANDBOX_BUYER_EMAIL, { timeout: 30000 });
  if (await page.locator('#btnNext').isVisible().catch(() => false)) await page.click('#btnNext');
  await page.locator('#password').fill(env.PAYPAL_SANDBOX_BUYER_PASSWORD, { timeout: 30000 });
  await shot('login');
  await page.click('#btnLogin');
  lap('logged in');

  const pay = page.locator('[data-testid="submit-button-initial"], #payment-submit-btn, button:has-text("Complete Purchase"), button:has-text("Pay")').first();
  await pay.waitFor({ timeout: 60000 });
  await shot('review');
  await Promise.all([page.waitForURL((u) => u.href.startsWith(BASE), { timeout: 60000 }), pay.click()]);
  lap('approved → ' + page.url());

  for (let i = 0; i < 60; i++) {
    const link = page.locator('a[href^="/dl/"]');
    if (await link.count()) { lap('READY ' + (await link.getAttribute('href'))); break; }
    if (await page.locator('text=Something went wrong').count()) { lap('FAILED'); break; }
    await page.waitForTimeout(5000);
    await page.reload();
  }
  await shot('status');
  console.log('final:', (await page.locator('body').innerText()).replace(/\s+/g, ' ').slice(0, 300));
} catch (e) {
  await shot('error').catch(() => {});
  console.error('E2E ERROR', e.message.split('\n')[0], '@', page.url());
  process.exitCode = 1;
} finally {
  await b.close();
}
