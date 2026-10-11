// AtlasOfOne shop front: chat with the order agent, proof cards, PayPal JS SDK v6 checkout, live order status.
const $ = (s, el = document) => el.querySelector(s);
const log = $('#log'), form = $('#ask'), input = $('#text'), sendBtn = $('#send');
const TOOL_LABEL = { find_airports: 'find_airports', make_proof: 'make_proof', create_checkout: 'create_checkout · Orders v2',
  check_order: 'get_order · PayPal Agent Toolkit', refund_order: 'create_refund · PayPal Agent Toolkit', rules: 'rule-based reply' };

let sid = null;
try { sid = sessionStorage.getItem('aoo_sid'); } catch {}
if (!sid) { sid = [...crypto.getRandomValues(new Uint8Array(12))].map((b) => b.toString(16).padStart(2, '0')).join(''); try { sessionStorage.setItem('aoo_sid', sid); } catch {} }

fetch('/api/config').then((r) => r.json()).then((c) => {
  const name = c.model ? `Google ${c.model.replace(/^gemini-/, 'Gemini ').replace(/-/g, ' ').replace(/\b\w/g, (x) => x.toUpperCase())}` : 'none — rule-based replies';
  $('#model').textContent = name;
  $('#who').textContent = c.model ? `AI shop assistant · ${name}` : 'Shop assistant';
}).catch(() => {});

const scroll = () => { log.scrollTop = log.scrollHeight; };
function bubble(text, who) {
  const d = document.createElement('div');
  d.className = `msg ${who}`;
  d.textContent = text;
  log.append(d); scroll();
  return d;
}

async function say(text) {
  text = text.trim();
  if (!text) return;
  bubble(text, 'me');
  input.value = ''; sendBtn.disabled = true; $('#chips').hidden = true;
  const t = document.createElement('div'); t.className = 'typing'; t.innerHTML = '<i></i><i></i><i></i>'; log.append(t); scroll();
  try {
    const r = await fetch('/api/chat', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ sid, text }) });
    const j = await r.json();
    t.remove();
    if (j.steps?.length) {
      const tr = document.createElement('div'); tr.className = 'trace';
      for (const s of j.steps) { const sp = document.createElement('span'); sp.textContent = TOOL_LABEL[s] || s; tr.append(sp); }
      log.append(tr);
    }
    for (const c of j.cards || []) renderCard(c);
    if (j.reply) bubble(j.reply, 'bot');
    if (!r.ok && !j.reply) bubble(j.error || 'Something went wrong — please try again.', 'bot err');
  } catch {
    t.remove(); bubble('Connection problem — please try again.', 'bot err');
  } finally { sendBtn.disabled = false; input.focus({ preventScroll: true }); }
}

form.addEventListener('submit', (e) => { e.preventDefault(); say(input.value); });
document.querySelectorAll('#chips button').forEach((b) => b.addEventListener('click', () => say(b.dataset.say)));
log.addEventListener('click', (e) => {
  if (e.target.matches('.proof img')) {
    const z = document.createElement('div'); z.className = 'zoom';
    const img = document.createElement('img'); img.src = e.target.src; img.alt = e.target.alt;
    z.append(img); z.addEventListener('click', () => z.remove()); document.body.append(z);
  }
});

function renderCard(c) {
  if (c.type === 'proof') {
    const n = $('#t-proof').content.firstElementChild.cloneNode(true);
    $('.cover', n).src = c.cover; $('.cover', n).alt = `Proof: ${c.child}'s cover`;
    $('.maze', n).src = c.maze; $('.maze', n).alt = `Proof: a maze page at ${c.airport}`;
    $('.title', n).textContent = `${c.child}'s Airport Mazes`;
    $('.sub', n).textContent = `${c.airportName} · ${c.airport} · $${c.price} · watermark removed after payment`;
    $('.ok', n).addEventListener('click', () => say("Looks good — let's check out."));
    $('.change', n).addEventListener('click', () => { input.value = 'Please change '; input.focus(); });
    log.append(n); n.querySelectorAll('img').forEach((i) => i.addEventListener('load', scroll));
  } else if (c.type === 'checkout') {
    const n = $('#t-checkout').content.firstElementChild.cloneNode(true);
    $('.what', n).textContent = `${c.child}'s Airport Mazes (PDF)`;
    $('.amt', n).textContent = `$${c.amount}`;
    log.append(n); scroll();
    mountPayPal(n, c.orderId);
  } else if (c.type === 'refund') {
    bubble(`Refund ${c.refundId} · ${c.status}`, 'bot');
  }
}

// ── PayPal JS SDK v6 ──
let sdkPromise = null;
function paypalSdk() {
  if (!sdkPromise) sdkPromise = (async () => {
    for (let i = 0; i < 50 && !window.paypal?.createInstance; i++) await new Promise((r) => setTimeout(r, 100));
    if (!window.paypal?.createInstance) throw new Error('PayPal SDK did not load');
    const { token } = await (await fetch('/api/paypal/client-token')).json();
    const sdk = await window.paypal.createInstance({ clientToken: token, components: ['paypal-payments'], pageType: 'checkout' });
    const methods = await sdk.findEligibleMethods({ currencyCode: 'USD' });
    if (!methods.isEligible('paypal')) throw new Error('PayPal is not available for this browser');
    return sdk;
  })();
  return sdkPromise;
}

async function mountPayPal(card, orderId) {
  const btn = $('paypal-button', card), hint = $('.hint', card);
  try {
    const sdk = await paypalSdk();
    const session = sdk.createPayPalOneTimePaymentSession({
      onApprove: async (data) => {
        hint.textContent = 'Confirming your payment…';
        btn.hidden = true;
        await fetch(`/api/orders/${data.orderId}/capture`, { method: 'POST' });
        track(card, data.orderId);
      },
      onCancel: () => { hint.textContent = 'Payment cancelled — nothing was charged. You can try again.'; },
      onError: (e) => { hint.textContent = `PayPal error: ${e?.message || 'please try again'}`; },
    });
    btn.hidden = false; hint.textContent = '';
    step(card, 'pay', 'on');
    btn.addEventListener('click', async () => {
      try { await session.start({ presentationMode: 'auto' }, Promise.resolve({ orderId })); }
      catch (e) { hint.textContent = `Could not open PayPal: ${e.message}`; }
    });
  } catch (e) {
    hint.textContent = `${e.message}.`;
  }
}

function step(card, s, state) {
  const order = ['pay', 'paid', 'make', 'ready'];
  card.querySelectorAll('.steps li').forEach((li) => {
    const i = order.indexOf(li.dataset.s), k = order.indexOf(s);
    li.className = i < k ? 'done' : i === k ? state : '';
  });
}

async function track(card, orderId) {
  for (let i = 0; i < 240; i++) {
    const o = await (await fetch(`/api/orders/${orderId}`)).json().catch(() => null);
    const st = o?.status;
    if (st === 'created') step(card, 'pay', 'on');
    else if (st === 'captured') step(card, 'paid', 'on');
    else if (st === 'rendering') step(card, 'make', 'on');
    else if (st === 'ready') {
      step(card, 'ready', 'done'); card.querySelectorAll('.steps li').forEach((li) => (li.className = 'done'));
      const a = $('.dl', card); a.href = o.download; a.hidden = false; $('.hint', card).textContent = `Paid · order ${orderId}`;
      bubble(`${o.child}'s book is ready! Print it on Letter or A4 — have fun at the airport. ✈`, 'bot');
      return;
    } else if (st === 'refunded' || st === 'failed') {
      $('.hint', card).textContent = st === 'refunded' ? `Refunded in full (${o.refundId}).` : 'Something went wrong — a full refund is on its way.';
      return;
    }
    await new Promise((r) => setTimeout(r, 2000));
  }
}

// returning from the redirect flow: /?order=ID
const q = new URLSearchParams(location.search);
if (q.get('order')) {
  const n = $('#t-checkout').content.firstElementChild.cloneNode(true);
  $('.what', n).textContent = 'Your order'; $('.pay', n).remove();
  log.append(n); track(n, q.get('order'));
}
if (q.get('cancelled')) bubble('Payment cancelled — nothing was charged.', 'bot');
