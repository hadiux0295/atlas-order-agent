// Renderer adapter. RENDERER=private calls the AtlasOfOne production pipeline (not part of this repo,
// located by PIPELINE_ROOT); public (default) prints the approved proof book from the one bundled airport,
// watermarked SAMPLE on every page — the open-source build demonstrates the checkout, it does not sell books.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { mode, getBrowser, watermark } from './proof.mjs';

function run(cmd, args, opts) {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { ...opts, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '', err = '';
    p.stdout.on('data', (d) => (out += d));
    p.stderr.on('data', (d) => (err += d));
    p.on('error', reject);
    p.on('close', (code) => (code === 0 ? resolve(out) : reject(new Error(`${cmd} ${args.join(' ')} → ${code}\n${err.slice(-800)}`))));
  });
}

const mazesDir = () => {
  if (!process.env.PIPELINE_ROOT) throw new Error('PIPELINE_ROOT not set');
  return path.join(process.env.PIPELINE_ROOT, 'scripts/etsy_lane/taxiway_mazes');
};

// Book HTML for a legacy form order (no proof step): generate it with the pipeline.
async function generateBook({ ident, child }) {
  const root = process.env.PIPELINE_ROOT;
  const graph = path.join(root, 'temp/etsy_lane/mazes', `${ident}_graph.json`);
  if (!fs.existsSync(graph)) await run('python3', [path.join(mazesDir(), 'fetch_graph.py'), ident], { cwd: root });
  const out = await run('python3', [path.join(mazesDir(), 'gen.py'), ident, '--name', child], { cwd: root });
  const book = out.match(/→ (\S+book\.html)/)?.[1];
  if (!book) throw new Error('gen.py: no book.html in output');
  return book;
}

// order.bookHtml = the personalised book the buyer approved as a proof → Letter + A4 PDFs.
async function renderPrivate(order) {
  const book = order.bookHtml || await generateBook(order);
  await run('node', [path.join(mazesDir(), 'render.mjs'), book, '--paper', 'both'], {
    cwd: process.env.PIPELINE_ROOT, env: { ...process.env, NODE_PATH: path.resolve('node_modules') },
  });
  const dir = path.dirname(book);
  return fs.readdirSync(dir).filter((f) => f.endsWith('.pdf')).map((f) => path.join(dir, f));
}

// Same page setup as the pipeline's render.mjs: Letter uses the book's own @page size, A4 overrides it.
async function renderPublic(order) {
  if (!order.bookHtml || !fs.existsSync(order.bookHtml)) throw new Error('public renderer: order has no approved proof book');
  const dir = path.dirname(order.bookHtml), base = path.basename(order.bookHtml, '.html');
  const b = await getBrowser();
  const page = await b.newPage({ viewport: { width: 816, height: 1056 } });
  try {
    await page.goto('file://' + order.bookHtml, { waitUntil: 'load' });
    await page.evaluate(() => document.fonts.ready);
    await page.addStyleTag({ content: watermark('SAMPLE · AtlasOfOne open-source build') });
    await page.emulateMedia({ media: 'print' });
    const out = [];
    for (const p of ['letter', 'a4']) {
      const pdf = path.join(dir, `${base}_${p}_sample.pdf`);
      if (p === 'a4') await page.addStyleTag({ content: '@page{size:210mm 297mm;margin:0} .page{width:210mm;height:297mm}' });
      await page.pdf({ path: pdf, format: p === 'a4' ? 'A4' : 'Letter', printBackground: true, preferCSSPageSize: p === 'letter', margin: { top: 0, bottom: 0, left: 0, right: 0 } });
      out.push(pdf);
    }
    return out;
  } finally {
    await page.close();
  }
}

export async function render(order) {
  return mode() === 'private' ? renderPrivate(order) : renderPublic(order);
}

export async function zip(files, outZip) {
  fs.mkdirSync(path.dirname(outZip), { recursive: true });
  const py = 'import sys, zipfile, os\nz = zipfile.ZipFile(sys.argv[1], "w", zipfile.ZIP_DEFLATED)\n' +
    'for f in sys.argv[2:]: z.write(f, os.path.basename(f))\nz.close()';
  await run('python3', ['-c', py, outZip, ...files], {});
  return outZip;
}
