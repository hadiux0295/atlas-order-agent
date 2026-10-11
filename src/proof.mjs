// Proofs: the buyer sees the real cover with the child's name — watermarked — before paying.
// A base book per airport is generated once (placeholder name, slow: ~80 s of maze search); a proof only swaps
// the name into that HTML and screenshots two pages, so it takes a couple of seconds.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const PLACEHOLDER = 'Zzchildzz';
const ASSETS = path.join(path.dirname(fileURLToPath(import.meta.url)), '../assets');

// One switch for proofs and fulfilment. public = the base book bundled in assets/ (one airport) + a watermarked PDF;
// private = the AtlasOfOne production pipeline under PIPELINE_ROOT (all airports, clean PDF; not part of this repo).
export const mode = () => (process.env.RENDERER === 'private' ? 'private' : 'public');
export const NAME_RE = /^\p{L}[\p{L} '\-]{0,19}$/u;

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

export function baseBookPath(icao) {
  if (!/^[A-Z]{4}$/.test(String(icao))) return null;
  if (mode() === 'public') return path.join(ASSETS, 'books', icao, 'book.html');
  const root = process.env.PIPELINE_ROOT;
  return root ? path.join(root, 'temp/etsy_lane/mazes/custom', `${icao}_${PLACEHOLDER.toLowerCase()}`, 'book.html') : null;
}
export const hasBase = (icao) => { const p = baseBookPath(icao); return !!p && fs.existsSync(p); };

// Same sizing rule as the pipeline's cover: the name is the dominant element and must fit the text block.
const namePt = (name) => Math.floor(Math.min(150, 525 / (0.47 * (name.length + 2))));

export function personalise(icao, child, outDir) {
  let html = fs.readFileSync(baseBookPath(icao), 'utf8');
  const name = esc(child);
  html = html.replace(new RegExp(`font-size:\\d+pt">${PLACEHOLDER}'s`, 'g'), `font-size:${namePt(child)}pt">${name}'s`);
  html = html.split(PLACEHOLDER).join(name);
  // the bundled book names its fonts __FONTS__/…; the copy lives under data/, so point them at assets/fonts
  html = html.split('__FONTS__/').join('file://' + path.join(ASSETS, 'fonts') + '/');
  fs.mkdirSync(outDir, { recursive: true });
  const out = path.join(outDir, 'book.html');
  fs.writeFileSync(out, html);
  return out;
}

// Playwright's own build if installed, else the newest cached headless shell (same lookup as the pipeline's render.mjs).
function executable() {
  try { if (fs.existsSync(chromium.executablePath())) return undefined; } catch {}
  const cache = path.join(process.env.HOME || '', '.cache/ms-playwright');
  const shell = fs.existsSync(cache) && fs.readdirSync(cache).filter((d) => d.startsWith('chromium_headless_shell-')).sort().reverse()[0];
  return shell && ['chrome-linux/headless_shell', 'chrome-headless-shell-linux64/chrome-headless-shell']
    .map((x) => path.join(cache, shell, x)).find((f) => fs.existsSync(f));
}

let browser = null;
export async function getBrowser() {
  if (!browser || !browser.isConnected()) browser = await chromium.launch({ executablePath: executable(), args: ['--no-sandbox'] });
  return browser;
}

// Diagonal repeated text over every page, centred in a tile big enough for the rotated line (else it clips).
// Proofs say PROOF; the public build's PDFs say SAMPLE.
export function watermark(text) {
  const w = Math.round(text.length * 17 * 0.92) + 40, h = Math.round(w * 0.42) + 60;
  return `section.page{position:relative}
section.page::after{content:"";position:absolute;inset:0;pointer-events:none;z-index:9;
background-image:url("data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' width='${w}' height='${h}'><text x='${w / 2}' y='${h / 2 + 10}' text-anchor='middle' transform='rotate(-24 ${w / 2} ${h / 2})' font-family='Arial' font-weight='700' font-size='30' fill='rgba(14,24,40,0.13)'>${text}</text></svg>");}`;
}

// → { cover, maze } PNG paths inside outDir
export async function proofImages(bookHtml, outDir) {
  const b = await getBrowser();
  const page = await b.newPage({ viewport: { width: 816, height: 1056 } });
  try {
    await page.goto('file://' + bookHtml, { waitUntil: 'load' });
    await page.evaluate(() => document.fonts.ready);
    await page.addStyleTag({ content: watermark('PROOF · AtlasOfOne') });
    const pages = await page.$$('section.page');
    const maze = await page.$('section.page.puzzle');
    const out = { cover: path.join(outDir, 'cover.png'), maze: path.join(outDir, 'maze.png') };
    await pages[0].screenshot({ path: out.cover, scale: 'css' });
    await (maze || pages[2]).screenshot({ path: out.maze, scale: 'css' });
    return out;
  } finally {
    await page.close();
  }
}

export const newId = () => crypto.randomBytes(8).toString('hex');
