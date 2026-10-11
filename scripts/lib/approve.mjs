// Sandbox stand-in for "the owner approves on PayPal": log in as the sandbox buyer in a headless browser
// and press the pay button. Used by the e2e scripts and the buyer agent's --approve demo mode only.
import fs from 'node:fs';
import path from 'node:path';
import { chromium } from 'playwright';

export function headlessShell() {
  const cache = path.join(process.env.HOME, '.cache/ms-playwright');
  const shell = fs.readdirSync(cache).filter((d) => d.startsWith('chromium_headless_shell-')).sort().reverse()[0];
  return ['chrome-linux/headless_shell', 'chrome-headless-shell-linux64/chrome-headless-shell']
    .map((x) => path.join(cache, shell, x)).find(fs.existsSync);
}

// → final URL after PayPal redirects back (startsWith returnPrefix)
export async function approveOnPayPal(url, { email, password, returnPrefix, shot }) {
  const b = await chromium.launch({ executablePath: headlessShell(), args: ['--no-sandbox'] });
  const page = await b.newPage({ viewport: { width: 430, height: 932 }, locale: 'en-US' });
  try {
    await page.goto(url);
    await page.locator('#email').fill(email, { timeout: 30000 });
    if (await page.locator('#btnNext').isVisible().catch(() => false)) await page.click('#btnNext');
    await page.locator('#password').fill(password, { timeout: 30000 });
    await page.click('#btnLogin');
    const pay = page.locator('[data-testid="submit-button-initial"], #payment-submit-btn, button:has-text("Complete Purchase"), button:has-text("Pay")').first();
    await pay.waitFor({ timeout: 60000 });
    if (shot) await page.screenshot({ path: shot });
    await Promise.all([page.waitForURL((u) => u.href.startsWith(returnPrefix), { timeout: 60000 }), pay.click()]);
    return page.url();
  } finally {
    await b.close();
  }
}
