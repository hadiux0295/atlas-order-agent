// Renderer adapter. RENDERER=private calls the AtlasOfOne production pipeline (not part of this repo,
// located by PIPELINE_ROOT); RENDERER=public will be the reduced, watermarked one-airport renderer.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

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

async function renderPrivate({ ident, child }) {
  const root = process.env.PIPELINE_ROOT;
  if (!root) throw new Error('PIPELINE_ROOT not set');
  const mz = path.join(root, 'scripts/etsy_lane/taxiway_mazes');
  const graph = path.join(root, 'temp/etsy_lane/mazes', `${ident}_graph.json`);
  if (!fs.existsSync(graph)) await run('python3', [path.join(mz, 'fetch_graph.py'), ident], { cwd: root });
  const out = await run('python3', [path.join(mz, 'gen.py'), ident, '--name', child], { cwd: root });
  const book = out.match(/→ (\S+book\.html)/)?.[1];
  if (!book) throw new Error('gen.py: no book.html in output');
  await run('node', [path.join(mz, 'render.mjs'), book, '--paper', 'both'], {
    cwd: root, env: { ...process.env, NODE_PATH: path.resolve('node_modules') },
  });
  const dir = path.dirname(book);
  return fs.readdirSync(dir).filter((f) => f.endsWith('.pdf')).map((f) => path.join(dir, f));
}

export async function render(order) {
  const mode = process.env.RENDERER || 'public';
  if (mode === 'private') return renderPrivate(order);
  throw new Error('public renderer not built yet');
}

export async function zip(files, outZip) {
  fs.mkdirSync(path.dirname(outZip), { recursive: true });
  const py = 'import sys, zipfile, os\nz = zipfile.ZipFile(sys.argv[1], "w", zipfile.ZIP_DEFLATED)\n' +
    'for f in sys.argv[2:]: z.write(f, os.path.basename(f))\nz.close()';
  await run('python3', ['-c', py, outZip, ...files], {});
  return outZip;
}
