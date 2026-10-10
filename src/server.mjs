// Spike server: form → PayPal order → buyer approves → capture on return →
// verified PAYMENT.CAPTURE.COMPLETED webhook → render → zip → download link.
// Env: PAYPAL_ENV_FILE, PUBLIC_URL, PORT (8742), DATA_DIR (./data), RENDERER, PIPELINE_ROOT.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { PayPal, loadEnvFile } from './paypal.mjs';
import { render, zip } from './renderer.mjs';

const PORT = +(process.env.PORT || 8742);
const PUBLIC_URL = (process.env.PUBLIC_URL || `http://localhost:${PORT}`).replace(/\/$/, '');
const DATA = path.resolve(process.env.DATA_DIR || './data');
const EVENTS = ['CHECKOUT.ORDER.APPROVED', 'PAYMENT.CAPTURE.COMPLETED', 'PAYMENT.CAPTURE.REFUNDED', 'PAYMENT.CAPTURE.DENIED'];
const PRODUCT = { sku: 'taxiway-maze-book', description: 'Taxiway Mazes — personalised airport maze book (PDF)', amount: '9.99' };

const env = loadEnvFile(process.env.PAYPAL_ENV_FILE);
const pp = new PayPal({ clientId: env.PAYPAL_CLIENT_ID, clientSecret: env.PAYPAL_CLIENT_SECRET, apiBase: env.PAYPAL_API_BASE });
fs.mkdirSync(DATA, { recursive: true });

// ── tiny JSON store ──
const STORE = path.join(DATA, 'orders.json');
const orders = fs.existsSync(STORE) ? JSON.parse(fs.readFileSync(STORE, 'utf8')) : {};
const save = () => fs.writeFileSync(STORE, JSON.stringify(orders, null, 1));
const log = (file, obj) => fs.appendFileSync(path.join(DATA, file), JSON.stringify({ t: new Date().toISOString(), ...obj }) + '\n');
const update = (id, patch) => { orders[id] = { ...orders[id], ...patch, updated: new Date().toISOString() }; save(); };

// ── fulfilment: runs once per capture id ──
async function fulfil(orderId, captureId) {
  const o = orders[orderId];
  if (!o || o.captureId === captureId && ['rendering', 'ready'].includes(o.status)) return;
  update(orderId, { status: 'rendering', captureId });
  try {
    const t0 = Date.now();
    const pdfs = await render(o);
    const token = crypto.randomBytes(16).toString('hex');
    await zip(pdfs, path.join(DATA, 'dl', `${token}.zip`));
    update(orderId, { status: 'ready', token, renderSec: Math.round((Date.now() - t0) / 1000) });
  } catch (e) {
    update(orderId, { status: 'failed', error: String(e.message).slice(0, 500) });
  }
}

// ── html ──
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
const page = (body, refresh) => `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
${refresh ? '<meta http-equiv="refresh" content="4">' : ''}<title>AtlasOfOne — spike</title>
<style>body{font:16px system-ui;max-width:34rem;margin:2rem auto;padding:0 1rem}input,button{font:inherit;padding:.5rem;margin:.25rem 0;width:100%}</style>
<h1>AtlasOfOne</h1><p><small>Sandbox demo — no real money moves.</small></p>${body}`;

const home = page(`<form method="post" action="/order">
<label>Child's first name <input name="child" maxlength="20" required pattern="[A-Za-z][A-Za-z '\\-]{0,19}"></label>
<label>Airport ICAO code <input name="ident" maxlength="4" required pattern="[A-Za-z]{4}" placeholder="KJFK"></label>
<button>Pay $${PRODUCT.amount} with PayPal</button></form>`);

function statusPage(id) {
  const o = orders[id];
  if (!o) return page('<p>Unknown order.</p>');
  const line = {
    created: 'Waiting for PayPal approval…',
    captured: 'Payment captured. Waiting for PayPal to confirm (webhook)…',
    rendering: `Drawing ${esc(o.child)}'s ${esc(o.ident)} maze book…`,
    ready: `<a href="/dl/${o.token}">Download ${esc(o.child)}'s book (zip)</a>`,
    failed: `Something went wrong: ${esc(o.error)}`,
  }[o.status] || esc(o.status);
  return page(`<p>Order <code>${esc(id)}</code></p><p>${line}</p>`, !['ready', 'failed'].includes(o.status));
}

// ── http ──
const readBody = (req) => new Promise((res) => { let b = ''; req.on('data', (d) => (b += d)); req.on('end', () => res(b)); });
const send = (res, code, body, type = 'text/html; charset=utf-8', extra = {}) => { res.writeHead(code, { 'Content-Type': type, ...extra }); res.end(body); };
const redirect = (res, to) => { res.writeHead(303, { Location: to }); res.end(); };

let webhookId = null;

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, PUBLIC_URL);
  try {
    if (req.method === 'GET' && url.pathname === '/') return send(res, 200, home);

    if (req.method === 'POST' && url.pathname === '/order') {
      const f = new URLSearchParams(await readBody(req));
      const child = (f.get('child') || '').trim(), ident = (f.get('ident') || '').trim().toUpperCase();
      if (!/^[A-Za-z][A-Za-z '-]{0,19}$/.test(child) || !/^[A-Z]{4}$/.test(ident)) return send(res, 400, page('<p>Check the name and the 4-letter code.</p>'));
      const o = await pp.createOrder({ ...PRODUCT, customId: `${ident}|${child}`, returnUrl: `${PUBLIC_URL}/return`, cancelUrl: `${PUBLIC_URL}/cancel` });
      update(o.id, { child, ident, status: 'created', created: new Date().toISOString() });
      const approve = o.links.find((l) => l.rel === 'payer-action' || l.rel === 'approve').href;
      return redirect(res, approve);
    }

    if (req.method === 'GET' && url.pathname === '/return') {
      const id = url.searchParams.get('token');
      if (!orders[id]) return send(res, 404, page('<p>Unknown order.</p>'));
      if (orders[id].status === 'created') {
        const c = await pp.captureOrder(id);
        const cap = c.purchase_units?.[0]?.payments?.captures?.[0];
        update(id, { status: cap?.status === 'COMPLETED' ? 'captured' : `capture_${cap?.status}`, captureId: cap?.id, payer: c.payer?.payer_id });
      }
      return redirect(res, `/status/${id}`);
    }

    if (req.method === 'GET' && url.pathname === '/cancel') return send(res, 200, page('<p>Payment cancelled — nothing was charged. <a href="/">Start again</a></p>'));
    if (req.method === 'GET' && url.pathname.startsWith('/status/')) return send(res, 200, statusPage(url.pathname.slice(8)));
    if (req.method === 'GET' && url.pathname.startsWith('/api/status/')) return send(res, 200, JSON.stringify(orders[url.pathname.slice(12)] || null), 'application/json');

    if (req.method === 'GET' && url.pathname.startsWith('/dl/')) {
      const token = url.pathname.slice(4);
      const o = Object.values(orders).find((x) => x.token === token && /^[0-9a-f]{32}$/.test(token));
      if (!o) return send(res, 404, 'not found', 'text/plain');
      return send(res, 200, fs.readFileSync(path.join(DATA, 'dl', `${token}.zip`)), 'application/zip',
        { 'Content-Disposition': `attachment; filename="TaxiwayMazes_${o.ident}_${o.child.replace(/\W/g, '')}.zip"` });
    }

    if (req.method === 'POST' && url.pathname === '/webhook') {
      const raw = await readBody(req);
      let ok = false, err = null;
      try { ok = await pp.verifyWebhook(req.headers, raw, webhookId); } catch (e) { err = e.message; }
      const ev = JSON.parse(raw);
      const r = ev.resource || {};
      const orderId = r.supplementary_data?.related_ids?.order_id || (ev.event_type.startsWith('CHECKOUT.ORDER') ? r.id : null);
      log('webhooks.log', { event: ev.event_type, id: ev.id, orderId, verified: ok, err });
      send(res, 200, '', 'text/plain'); // ack fast; PayPal retries non-2xx
      if (ok && ev.event_type === 'PAYMENT.CAPTURE.COMPLETED' && orders[orderId]) fulfil(orderId, r.id);
      return;
    }

    send(res, 404, 'not found', 'text/plain');
  } catch (e) {
    log('errors.log', { path: url.pathname, msg: e.message, debugId: e.debugId, body: e.body });
    send(res, 500, page(`<p>Error: ${esc(e.message)}</p>`));
  }
});

webhookId = await pp.ensureWebhook(`${PUBLIC_URL}/webhook`, EVENTS);
server.listen(PORT, '127.0.0.1', () => console.log(`listening :${PORT} · public ${PUBLIC_URL} · webhook ${webhookId}`));
