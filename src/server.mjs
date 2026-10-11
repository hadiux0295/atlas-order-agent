// AtlasOfOne Order Agent: chat brief → watermarked proof → PayPal (JS SDK v6 button) → capture →
// verified PAYMENT.CAPTURE.COMPLETED webhook → render → zip → download link. Refunds via the PayPal Agent Toolkit.
// MCP: /mcp (Streamable HTTP) exposes the same tools to other agents (mcp.mjs).
// Env: PAYPAL_ENV_FILE, PUBLIC_URL, PORT (8742), DATA_DIR (./data), RENDERER (public = one airport, SAMPLE PDFs · private), PIPELINE_ROOT, GEMINI_API_KEY,
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
import { ShopAgent, MODEL, toolResult } from './agent.mjs';
import { createMcp } from './mcp.mjs';

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
const orders = load('orders.json'), proofs = load('proofs.json'), mandates = load('mandates.json');
const save = () => { for (const [f, o] of [['orders.json', orders], ['proofs.json', proofs], ['mandates.json', mandates]]) fs.writeFileSync(path.join(DATA, f), JSON.stringify(o, null, 1)); };
const log = (file, obj) => fs.appendFileSync(path.join(DATA, file), JSON.stringify({ t: new Date().toISOString(), ...obj }) + '\n');
const update = (id, patch) => { orders[id] = { ...orders[id], ...patch, updated: new Date().toISOString() }; save(); };

// ── agent mandates: on the first order the owner can let their agent reorder with the PayPal wallet that
// payment saved (vault). Limits are ours to enforce — a vault token has none: the catalogue price per book
// (no tool takes an amount), N books a day, an end date, one order per proof, revocable at any time. The
// agent's token is stored only as a hash and handed out once, to the agent session that placed the order.
const MANDATE = { perDay: 3, days: 30 };
const sha = (t) => crypto.createHash('sha256').update(t).digest('hex');
const pickup = new Map(); // orderId → mandate token, until the creating agent session collects it
const DAY = 86400_000;
const mandateView = (id) => {
  const m = mandates[id];
  if (!m) return null;
  const usedToday = m.orders.filter((x) => Date.now() - x.at < DAY).length;
  const active = !m.revoked && Date.now() < Date.parse(m.expires) && !!m.vaultId;
  return { mandate_id: id, active, per_book: `$${PRODUCT.price}`, books_per_day: MANDATE.perDay, used_today: usedToday,
    ends: m.expires.slice(0, 10), revoked: m.revoked || null, shop_only: 'AtlasOfOne' };
};
function mintMandate(orderId, vault) {
  const token = 'atl_' + crypto.randomBytes(24).toString('hex'), id = newId(), now = new Date();
  mandates[id] = { hash: sha(token), vaultId: vault.id, customerId: vault.customer?.id || null, fromOrder: orderId,
    created: now.toISOString(), expires: new Date(+now + MANDATE.days * DAY).toISOString(), revoked: null, orders: [] };
  pickup.set(orderId, token);
  update(orderId, { mandateId: id }); // update() saves all three stores
  log('mandates.log', { minted: id, fromOrder: orderId });
}

// ── shop operations (the agent's tools call these) ──
let refundTool = null;
const shop = {
  available: hasBase,
  abs: (p) => PUBLIC_URL + p,
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
  async createCheckout(proofId, session, { saveWallet = false } = {}) {
    const p = proofs[proofId];
    const o = await pp.createOrder({
      vault: saveWallet,
      sku: PRODUCT.sku, amount: PRODUCT.price, customId: proofId,
      description: `${PRODUCT.title} — ${p.icao} — for ${p.child}`.slice(0, 127),
      itemName: `${p.child}'s Airport Mazes — ${label(byIcao(p.icao))}`,
      returnUrl: `${PUBLIC_URL}/return`, cancelUrl: `${PUBLIC_URL}/cancel`,
    });
    const paypalUrl = o.links?.find((l) => l.rel === 'payer-action' || l.rel === 'approve')?.href;
    update(o.id, { proofId, child: p.child, ident: p.icao, bookHtml: p.bookHtml, status: 'created', created: new Date().toISOString(), paypalUrl, saveWallet });
    session?.orders.add(o.id);
    // agents hand their owner our page first: what is bought, and what saving the wallet allows, before PayPal
    return { orderId: o.id, proofId, amount: PRODUCT.price, child: p.child, approveUrl: `${PUBLIC_URL}/approve/${o.id}`, saveWallet };
  },
  mandateByToken(token) {
    if (!/^atl_[0-9a-f]{48}$/.test(token || '')) return null;
    const h = sha(token);
    return Object.keys(mandates).find((id) => mandates[id].hash === h) || null;
  },
  mandateView,
  takeMandateToken(orderId) { const t = pickup.get(orderId); pickup.delete(orderId); return t || null; },
  // the agent pays alone: saved wallet, no redirect, PayPal returns the capture inline
  async buyWithMandate(proofId, session, mandateId) {
    const m = mandates[mandateId], v = mandateView(mandateId);
    if (!v?.active) return { error: m?.revoked ? 'the owner revoked this mandate' : 'mandate not active (ended or unknown)' };
    const p = proofs[proofId];
    if (!p) return { error: 'unknown proof' };
    const dup = m.orders.find((x) => x.proofId === proofId);
    if (dup) return { order_id: dup.orderId, note: 'this proof was already bought with the mandate' };
    if (v.used_today >= MANDATE.perDay) return { error: `daily limit reached (${MANDATE.perDay} books) — ask your owner` };
    const o = await pp.chargeVault({
      vaultId: m.vaultId, requestId: `mandate-${mandateId}-${proofId}`,
      sku: PRODUCT.sku, amount: PRODUCT.price, customId: proofId,
      description: `${PRODUCT.title} — ${p.icao} — for ${p.child} (agent reorder)`.slice(0, 127),
      itemName: `${p.child}'s Airport Mazes — ${label(byIcao(p.icao))}`,
    });
    const cap = o.purchase_units?.[0]?.payments?.captures?.[0];
    // write the order before anything else can look for it (the signed webhook follows within seconds)
    update(o.id, { proofId, child: p.child, ident: p.icao, bookHtml: p.bookHtml, created: new Date().toISOString(), mandateId, via: 'mandate',
      status: cap?.status === 'COMPLETED' ? 'captured' : `capture_${cap?.status}`, captureId: cap?.id, payer: o.payer?.payer_id });
    m.orders.push({ orderId: o.id, proofId, at: Date.now() }); save();
    session?.orders.add(o.id);
    log('mandates.log', { charged: mandateId, orderId: o.id, capture: cap?.id, status: cap?.status });
    if (cap?.status === 'COMPLETED') fulfil(o.id, cap.id);
    return { order_id: o.id, amount: `$${PRODUCT.price}`, paypal_status: o.status, fulfilment: orders[o.id].status, mandate: mandateView(mandateId) };
  },
  async revokeMandate(mandateId, by) {
    const m = mandates[mandateId];
    if (!m || m.revoked) return mandateView(mandateId);
    // PayPal-side delete needs the app's vault feature; either way we forget the vault id, so no further charge is possible
    let paypal = 'deleted';
    try { await pp.deleteVaultToken(m.vaultId); } catch (e) { paypal = `not deleted at PayPal (${e.status || e.message})`; }
    Object.assign(m, { revoked: new Date().toISOString(), revokedBy: by, vaultId: null, paypalDelete: paypal });
    save();
    log('mandates.log', { revoked: mandateId, by, paypal });
    return mandateView(mandateId);
  },
  orderOf: (id) => orders[id],
  async refund(orderId, reason, tool = refundTool) {
    const o = orders[orderId];
    if (!o?.captureId) return { error: 'this order has not been paid' };
    if (o.status === 'refunded') return { error: 'already refunded', refundId: o.refundId };
    if (Date.now() - Date.parse(o.created) > 14 * 86400_000) return { error: 'the 14-day refund window has passed' };
    let r = toolResult(await tool.execute({ capture_id: o.captureId, note_to_payer: `AtlasOfOne refund: ${reason}`.slice(0, 255) }, {}));
    // a retry after a refund we failed to record: PayPal is the source of truth
    if (!r?.id && /already been fully refunded/i.test(r?.message || '')) r = { id: o.refundId || 'already-refunded', status: 'COMPLETED' };
    if (!r?.id) { log('errors.log', { orderId, refund: r }); return { error: 'PayPal did not accept the refund', detail: String(r?.message || '').slice(0, 200) }; }
    if (o.token) fs.rmSync(path.join(DATA, 'dl', `${o.token}.zip`), { force: true });
    update(orderId, { status: 'refunded', refundId: r.id, refundStatus: r.status, refundReason: reason, token: null });
    return { refundId: r.id, status: r.status };
  },
};

const agent = new ShopAgent({ paypalEnv: env, shop });
refundTool = agent.pp.create_refund;
const mcp = createMcp({ shop, pp: agent.pp });

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
  const vault = c.payment_source?.paypal?.attributes?.vault;
  if (orders[id].saveWallet && vault?.id && vault.status === 'VAULTED' && !orders[id].mandateId) mintMandate(id, vault);
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
const approvePage = (id, o) => `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Approve · AtlasOfOne</title><link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Barlow:wght@400;500;600&family=Barlow+Condensed:wght@600;700&display=swap" rel="stylesheet"><link rel="stylesheet" href="/style.css">
<header class="bar"><a class="logo" href="/"><svg viewBox="0 0 24 28" aria-hidden="true"><path d="M12 1 2 27h5l5-13 5 13h5z" fill="#0E1828"/><path d="M12 14 7 27h10z" fill="#F4AE45"/></svg>ATLAS OF <b>ONE</b></a><span class="pill">Sandbox demo</span></header>
<main class="approve"><div class="card">
<p class="kicker">Your assistant agent prepared this order</p>
<div class="pages one"><img src="/p/${o.proofId}/cover.png" alt="Proof: ${esc(o.child)}'s cover"></div>
<div class="checkout"><div class="line"><span>${esc(o.child)}'s Airport Mazes (PDF) · ${esc(label(byIcao(o.ident)))}</span><b class="amt">$${PRODUCT.price}</b></div></div>
${o.saveWallet ? `<div class="consent"><b>Your agent also asked to reorder for you</b>
<p>If you pay, PayPal saves your wallet for AtlasOfOne, and your agent may buy more books without asking you each time — within these limits:</p>
<ul><li>$${PRODUCT.price} per book, this shop only — the agent cannot change the price</li><li>at most ${MANDATE.perDay} books a day</li><li>ends ${new Date(Date.now() + MANDATE.days * DAY).toISOString().slice(0, 10)}, or when you switch it off on your order page</li></ul>
<p class="fine">Every reorder still gets a PayPal receipt, and the 14-day refund applies to each book.</p></div>` : ''}
<a class="primary dl" href="${esc(o.paypalUrl)}">${o.saveWallet ? 'Agree and continue to PayPal' : 'Continue to PayPal'}</a>
<p class="fine">This order was put together by an AI agent acting for you, through our shop's agent interface. The proof is drawn by our shop, and the price and limits are set by the shop — not by any AI. Full refund within 14 days, from your order page. For parents and gift-givers (18+). PayPal <b>sandbox</b> — no real money moves. <a href="/cancel">Cancel</a></p>
</div></main></html>`;
const readBody = (req) => new Promise((res) => { let b = ''; req.on('data', (d) => { if (b.length < 20000) b += d; }); req.on('end', () => res(b)); });
const send = (res, code, body, type = 'text/html; charset=utf-8', extra = {}) => { res.writeHead(code, { 'Content-Type': type, 'Cache-Control': 'no-store', ...extra }); res.end(body); };
const json = (res, code, obj) => send(res, code, JSON.stringify(obj), 'application/json');
const redirect = (res, to) => { res.writeHead(303, { Location: to }); res.end(); };
const STATIC = { '/': 'index.html', '/app.js': 'app.js', '/style.css': 'style.css' };
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.svg': 'image/svg+xml' };

// public chat costs model tokens → per-IP budget
const hits = new Map();
const limited = (ip, max = 40, key = '') => { const k = key + ip, now = Date.now(), h = (hits.get(k) || []).filter((t) => now - t < 600_000); h.push(now); hits.set(k, h); return h.length > max; };

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

    // MCP door for other agents (same guarded tools as the chat). Before any body read: the transport reads the stream.
    if (p === '/mcp') {
      const ip = req.headers['cf-connecting-ip'] || req.socket.remoteAddress;
      if (limited(ip, 150, 'mcp:')) return json(res, 429, { jsonrpc: '2.0', error: { code: -32000, message: 'rate limited — wait a few minutes' }, id: null });
      return await mcp(req, res);
    }

    if (req.method === 'POST' && p === '/api/chat') {
      const ip = req.headers['cf-connecting-ip'] || req.socket.remoteAddress;
      if (limited(ip)) return json(res, 429, { reply: 'Too many messages — please wait a few minutes.' });
      const { sid, text, action } = JSON.parse((await readBody(req)) || '{}');
      if (!/^[0-9a-f]{16,32}$/.test(sid || '') || !String(text || '').trim()) return json(res, 400, { error: 'bad request' });
      const t0 = Date.now();
      const r = await agent.chat(sid, text, action === 'checkout' ? 'checkout' : null);
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
      return json(res, 200, { status: o.status, child: o.child, ident: o.ident, download: o.status === 'ready' ? `/dl/${o.token}` : null, refundId: o.refundId || null,
        saveWallet: !!o.saveWallet, via: o.via || null, mandate: o.mandateId ? mandateView(o.mandateId) : null });
    }
    // the owner's off switch (on the order page); revoking only ever removes power, so the order link is enough
    const rm = p.match(/^\/api\/orders\/([A-Z0-9]{10,20})\/revoke-mandate$/);
    if (req.method === 'POST' && rm) {
      const o = orders[rm[1]];
      if (!o?.mandateId) return json(res, 404, { error: 'no mandate on this order' });
      return json(res, 200, { mandate: await shop.revokeMandate(o.mandateId, 'owner (order page)') });
    }
    // refund from the order page (the order link is the buyer's receipt; 14-day rule enforced in shop.refund)
    const fm = p.match(/^\/api\/orders\/([A-Z0-9]{10,20})\/refund$/);
    if (req.method === 'POST' && fm) {
      if (!orders[fm[1]]) return json(res, 404, { error: 'unknown order' });
      return json(res, 200, await shop.refund(fm[1], 'requested on the order page'));
    }
    // consent page for agent-placed orders: what is bought, and what saving the wallet allows, before PayPal
    const am = p.match(/^\/approve\/([A-Z0-9]{10,20})$/);
    if (req.method === 'GET' && am) {
      const o = orders[am[1]];
      if (!o) return send(res, 404, page('<p>Unknown order.</p>'));
      if (o.status !== 'created') return redirect(res, `/?order=${am[1]}`);
      return send(res, 200, approvePage(am[1], o));
    }

    // legacy redirect flow (kept for the headless e2e script and redirect presentation)
    if (req.method === 'POST' && p === '/order') {
      const f = new URLSearchParams(await readBody(req));
      const child = (f.get('child') || '').trim(), ident = (f.get('ident') || '').trim().toUpperCase();
      if (!NAME_RE.test(child) || !byIcao(ident)) return send(res, 400, page('<p>Check the name and the airport code.</p>'));
      if (!shop.available(ident)) return send(res, 400, page('<p>We can’t draw that airport in this build yet.</p>'));
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
      // refund events carry no order id: follow the refund's `up` link to its capture
      const upCapture = (r.links || []).find((l) => l.rel === 'up')?.href?.match(/captures\/([A-Z0-9]+)/)?.[1];
      const orderId = r.supplementary_data?.related_ids?.order_id || (ev.event_type.startsWith('CHECKOUT.ORDER') ? r.id : null)
        || (upCapture && Object.keys(orders).find((k) => orders[k].captureId === upCapture)) || null;
      log('webhooks.log', { event: ev.event_type, id: ev.id, orderId, verified: ok, err });
      send(res, 200, '', 'text/plain'); // ack fast; PayPal retries non-2xx
      if (ok && ev.event_type === 'PAYMENT.CAPTURE.COMPLETED' && orders[orderId]) fulfil(orderId, r.id);
      if (ok && ev.event_type === 'PAYMENT.CAPTURE.REFUNDED' && orders[orderId]) {
        // reconcile: a refund made anywhere (agent, PayPal dashboard) closes the download
        const o = orders[orderId];
        if (o.token) fs.rmSync(path.join(DATA, 'dl', `${o.token}.zip`), { force: true });
        update(orderId, { status: 'refunded', refundId: o.refundId || r.id, refundConfirmed: ev.id, token: null });
      }
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
