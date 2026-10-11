// AtlasOfOne Order Agent: chat brief → watermarked proof → PayPal (JS SDK v6 button) → capture →
// verified PAYMENT.CAPTURE.COMPLETED webhook → render → zip → download link. Refunds via the PayPal Agent Toolkit.
// Env: PAYPAL_ENV_FILE, PUBLIC_URL, PORT (8742), DATA_DIR (./data), RENDERER, PIPELINE_ROOT, GEMINI_API_KEY,
//      AGENT_MODEL, SKIP_WEBHOOK=1 (local dev: never re-point the app's one webhook at localhost).
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { PayPal, loadEnvFile } from './paypal.mjs';
import { render, zip } from './renderer.mjs';
import { PRODUCT, byIcao, label } from './catalog.mjs';
import { personalise, proofImages, hasBase, newId, NAME_RE } from './proof.mjs';
import { ShopAgent, MODEL } from './agent.mjs';

const PORT = +(process.env.PORT || 8742);
const PUBLIC_URL = (process.env.PUBLIC_URL || `http://localhost:${PORT}`).replace(/\/$/, '');
const DATA = path.resolve(process.env.DATA_DIR || './data');
const WEB = path.join(path.dirname(fileURLToPath(import.meta.url)), '../public');
const EVENTS = ['CHECKOUT.ORDER.APPROVED', 'PAYMENT.CAPTURE.COMPLETED', 'PAYMENT.CAPTURE.REFUNDED', 'PAYMENT.CAPTURE.DENIED'];

const env = loadEnvFile(process.env.PAYPAL_ENV_FILE);
const pp = new PayPal({ clientId: env.PAYPAL_CLIENT_ID, clientSecret: env.PAYPAL_CLIENT_SECRET, apiBase: env.PAYPAL_API_BASE });
fs.mkdirSync(DATA, { recursive: true });

// ── tiny JSON stores ──
const load = (f) => (fs.existsSync(path.join(DATA, f)) ? JSON.parse(fs.readFileSync(path.join(DATA, f), 'utf8')) : {});
const orders = load('orders.json'), proofs = load('proofs.json');
const save = () => { fs.writeFileSync(path.join(DATA, 'orders.json'), JSON.stringify(orders, null, 1)); fs.writeFileSync(path.join(DATA, 'proofs.json'), JSON.stringify(proofs, null, 1)); };
const log = (file, obj) => fs.appendFileSync(path.join(DATA, file), JSON.stringify({ t: new Date().toISOString(), ...obj }) + '\n');
const update = (id, patch) => { orders[id] = { ...orders[id], ...patch, updated: new Date().toISOString() }; save(); };

// ── shop operations (the agent's tools call these) ──
let refundTool = null;
const shop = {
  available: hasBase,
  async makeProof(icao, child, session) {
    if (!hasBase(icao)) throw new Error(`no base book for ${icao}`);
    const proofId = newId(), dir = path.join(DATA, 'proofs', proofId);
    const t0 = Date.now();
    const bookHtml = personalise(icao, child, dir);
    await proofImages(bookHtml, dir);
    const a = byIcao(icao);
    proofs[proofId] = { icao, child, bookHtml, created: new Date().toISOString(), ms: Date.now() - t0 };
    save();
    session?.proofs.add(proofId);
    return { proofId, child, airport: label(a), airportName: a.name, price: PRODUCT.price, cover: `/p/${proofId}/cover.png`, maze: `/p/${proofId}/maze.png` };
  },
  async createCheckout(proofId, session) {
    const p = proofs[proofId];
    const o = await pp.createOrder({
      sku: PRODUCT.sku, amount: PRODUCT.price, customId: proofId,
      description: `${PRODUCT.title} — ${p.icao} — for ${p.child}`.slice(0, 127),
      itemName: `${p.child}'s Airport Mazes — ${label(byIcao(p.icao))}`,
      returnUrl: `${PUBLIC_URL}/return`, cancelUrl: `${PUBLIC_URL}/cancel`,
    });
    update(o.id, { proofId, child: p.child, ident: p.icao, bookHtml: p.bookHtml, status: 'created', created: new Date().toISOString() });
    session?.orders.add(o.id);
    return { orderId: o.id, proofId, amount: PRODUCT.price, child: p.child };
  },
  orderOf: (id) => orders[id],
  async refund(orderId, reason, tool = refundTool) {
    const o = orders[orderId];
    if (!o?.captureId) return { error: 'this order has not been paid' };
    if (o.status === 'refunded') return { error: 'already refunded', refundId: o.refundId };
    if (Date.now() - Date.parse(o.created) > 14 * 86400_000) return { error: 'the 14-day refund window has passed' };
    const r = await tool.execute({ capture_id: o.captureId, note_to_payer: `AtlasOfOne refund: ${reason}`.slice(0, 255) }, {});
    if (!r?.id) return { error: 'PayPal did not accept the refund', detail: JSON.stringify(r).slice(0, 300) };
    if (o.token) fs.rmSync(path.join(DATA, 'dl', `${o.token}.zip`), { force: true });
    update(orderId, { status: 'refunded', refundId: r.id, refundStatus: r.status, refundReason: reason, token: null });
    return { refundId: r.id, status: r.status };
  },
};

const agent = new ShopAgent({ paypalEnv: env, shop });
refundTool = agent.pp.create_refund;

// ── fulfilment: runs once per capture id; a failed render refunds automatically (unhappy path) ──
async function fulfil(orderId, captureId) {
  const o = orders[orderId];
  if (!o || o.captureId === captureId && ['rendering', 'ready', 'failed', 'refunded'].includes(o.status)) return;
  update(orderId, { status: 'rendering', captureId });
  try {
    const t0 = Date.now();
    const pdfs = await render(o);
    const token = crypto.randomBytes(16).toString('hex');
    await zip(pdfs, path.join(DATA, 'dl', `${token}.zip`));
    update(orderId, { status: 'ready', token, renderSec: Math.round((Date.now() - t0) / 1000) });
  } catch (e) {
    update(orderId, { status: 'failed', error: String(e.message).slice(0, 500) });
    try { await shop.refund(orderId, "we couldn't make your book — full refund"); } catch (re) { log('errors.log', { orderId, refund: re.message }); }
  }
}

async function capture(id) {
  if (orders[id]?.status !== 'created') return orders[id];
  const c = await pp.captureOrder(id);
  const cap = c.purchase_units?.[0]?.payments?.captures?.[0];
  update(id, { status: cap?.status === 'COMPLETED' ? 'captured' : `capture_${cap?.status}`, captureId: cap?.id, payer: c.payer?.payer_id });
  // Our own server-to-server capture saying COMPLETED is final → start drawing now. The signed
  // PAYMENT.CAPTURE.COMPLETED webhook (~40 s later in sandbox) is the fallback path; fulfil() is idempotent.
  // A PENDING capture waits for the webhook.
  if (cap?.status === 'COMPLETED') fulfil(id, cap.id);
  return orders[id];
}

// ── http ──
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
const page = (body) => `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>AtlasOfOne</title>
<style>body{font:16px system-ui;max-width:34rem;margin:2rem auto;padding:0 1rem}</style>${body}`;
const readBody = (req) => new Promise((res) => { let b = ''; req.on('data', (d) => { if (b.length < 20000) b += d; }); req.on('end', () => res(b)); });
const send = (res, code, body, type = 'text/html; charset=utf-8', extra = {}) => { res.writeHead(code, { 'Content-Type': type, 'Cache-Control': 'no-store', ...extra }); res.end(body); };
const json = (res, code, obj) => send(res, code, JSON.stringify(obj), 'application/json');
const redirect = (res, to) => { res.writeHead(303, { Location: to }); res.end(); };
const STATIC = { '/': 'index.html', '/app.js': 'app.js', '/style.css': 'style.css' };
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.svg': 'image/svg+xml' };

// public chat costs model tokens → per-IP budget
const hits = new Map();
const limited = (ip) => { const now = Date.now(), h = (hits.get(ip) || []).filter((t) => now - t < 600_000); h.push(now); hits.set(ip, h); return h.length > 40; };

let webhookId = null;

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, PUBLIC_URL);
  const p = url.pathname;
  try {
    if (req.method === 'GET' && STATIC[p]) {
      const f = path.join(WEB, STATIC[p]);
      return send(res, 200, fs.readFileSync(f), TYPES[path.extname(f)]);
    }
    if (req.method === 'GET' && p.startsWith('/img/') && /^\/img\/[\w.-]+\.(png|svg)$/.test(p)) {
      const f = path.join(WEB, p);
      return fs.existsSync(f) ? send(res, 200, fs.readFileSync(f), TYPES[path.extname(f)], { 'Cache-Control': 'max-age=3600' }) : send(res, 404, '');
    }
    if (req.method === 'GET' && p === '/api/config') {
      return json(res, 200, { sdk: 'https://www.sandbox.paypal.com/web-sdk/v6/core', model: agent.google ? MODEL : null, price: PRODUCT.price });
    }
    if (req.method === 'GET' && p === '/api/paypal/client-token') return json(res, 200, { token: await pp.clientToken() });

    if (req.method === 'POST' && p === '/api/chat') {
      const ip = req.headers['cf-connecting-ip'] || req.socket.remoteAddress;
      if (limited(ip)) return json(res, 429, { reply: 'Too many messages — please wait a few minutes.' });
      const { sid, text } = JSON.parse((await readBody(req)) || '{}');
      if (!/^[0-9a-f]{16,32}$/.test(sid || '') || !String(text || '').trim()) return json(res, 400, { error: 'bad request' });
      const t0 = Date.now();
      const r = await agent.chat(sid, text);
      log('chat.log', { sid, text: String(text).slice(0, 300), reply: r.reply.slice(0, 300), steps: r.steps, ms: Date.now() - t0, model: r.model });
      return json(res, 200, r);
    }

    const pm = p.match(/^\/p\/([0-9a-f]{16})\/(cover|maze)\.png$/);
    if (req.method === 'GET' && pm) {
      const f = path.join(DATA, 'proofs', pm[1], `${pm[2]}.png`);
      return fs.existsSync(f) ? send(res, 200, fs.readFileSync(f), 'image/png') : send(res, 404, '');
    }

    // v6 onApprove → capture (idempotent); fulfilment waits for the signed webhook
    const cm = p.match(/^\/api\/orders\/([A-Z0-9]{10,20})\/capture$/);
    if (req.method === 'POST' && cm) {
      if (!orders[cm[1]]) return json(res, 404, { error: 'unknown order' });
      const o = await capture(cm[1]);
      return json(res, 200, { status: o.status });
    }
    const om = p.match(/^\/api\/orders\/([A-Z0-9]{10,20})$/);
    if (req.method === 'GET' && om) {
      const o = orders[om[1]];
      if (!o) return json(res, 404, null);
      return json(res, 200, { status: o.status, child: o.child, ident: o.ident, download: o.status === 'ready' ? `/dl/${o.token}` : null, refundId: o.refundId || null });
    }

    // legacy redirect flow (kept for the headless e2e script and redirect presentation)
    if (req.method === 'POST' && p === '/order') {
      const f = new URLSearchParams(await readBody(req));
      const child = (f.get('child') || '').trim(), ident = (f.get('ident') || '').trim().toUpperCase();
      if (!NAME_RE.test(child) || !byIcao(ident)) return send(res, 400, page('<p>Check the name and the airport code.</p>'));
      const pr = await shop.makeProof(ident, child, null);
      const c = await shop.createCheckout(pr.proofId, null);
      const o = await pp.getOrder(c.orderId);
      return redirect(res, o.links.find((l) => l.rel === 'payer-action' || l.rel === 'approve').href);
    }
    if (req.method === 'GET' && p === '/return') {
      const id = url.searchParams.get('token');
      if (!orders[id]) return send(res, 404, page('<p>Unknown order.</p>'));
      await capture(id);
      return redirect(res, `/?order=${id}`);
    }
    if (req.method === 'GET' && p === '/cancel') return redirect(res, '/?cancelled=1');

    if (req.method === 'GET' && p.startsWith('/dl/')) {
      const token = p.slice(4);
      const o = Object.values(orders).find((x) => x.token === token && /^[0-9a-f]{32}$/.test(token));
      if (!o) return send(res, 404, 'not found', 'text/plain');
      return send(res, 200, fs.readFileSync(path.join(DATA, 'dl', `${token}.zip`)), 'application/zip',
        { 'Content-Disposition': `attachment; filename="AirportMazes_${o.ident}_${o.child.replace(/[^\p{L}]/gu, '')}.zip"` });
    }

    if (req.method === 'POST' && p === '/webhook') {
      const raw = await readBody(req);
      let ok = false, err = null;
      try { ok = await pp.verifyWebhook(req.headers, raw, webhookId); } catch (e) { err = e.message; }
      const ev = JSON.parse(raw);
      const r = ev.resource || {};
      const orderId = r.supplementary_data?.related_ids?.order_id || (ev.event_type.startsWith('CHECKOUT.ORDER') ? r.id : null);
      log('webhooks.log', { event: ev.event_type, id: ev.id, orderId, verified: ok, err });
      send(res, 200, '', 'text/plain'); // ack fast; PayPal retries non-2xx
      if (ok && ev.event_type === 'PAYMENT.CAPTURE.COMPLETED' && orders[orderId]) fulfil(orderId, r.id);
      if (ok && ev.event_type === 'PAYMENT.CAPTURE.REFUNDED' && orders[orderId]) update(orderId, { refundConfirmed: ev.id });
      return;
    }

    send(res, 404, 'not found', 'text/plain');
  } catch (e) {
    log('errors.log', { path: p, msg: e.message, debugId: e.debugId, body: e.body });
    if (p.startsWith('/api/')) return json(res, 500, { error: 'Something went wrong on our side — please try again.' });
    send(res, 500, page(`<p>Error: ${esc(e.message)}</p>`));
  }
});

webhookId = process.env.SKIP_WEBHOOK ? 'local-dev' : await pp.ensureWebhook(`${PUBLIC_URL}/webhook`, EVENTS);
server.listen(PORT, '127.0.0.1', () => console.log(`listening :${PORT} · public ${PUBLIC_URL} · webhook ${webhookId} · model ${agent.google ? MODEL : 'none (rules)'}`));
