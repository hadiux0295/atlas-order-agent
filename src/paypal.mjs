// PayPal REST layer: OAuth, Orders v2, webhook registration + signature verification.
// Credentials come from an env file (PAYPAL_ENV_FILE) — never from this repo.
import fs from 'node:fs';
import crypto from 'node:crypto';

export function loadEnvFile(file) {
  const env = {};
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m) env[m[1]] = m[2].replace(/^['"]|['"]$/g, '');
  }
  return env;
}

export class PayPal {
  constructor({ clientId, clientSecret, apiBase }) {
    Object.assign(this, { clientId, clientSecret, apiBase });
    this._tok = null;
  }

  async token() {
    if (this._tok && this._tok.exp > Date.now() + 60_000) return this._tok.value;
    const r = await fetch(this.apiBase + '/v1/oauth2/token', {
      method: 'POST',
      headers: {
        Authorization: 'Basic ' + Buffer.from(`${this.clientId}:${this.clientSecret}`).toString('base64'),
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: 'grant_type=client_credentials',
    });
    const j = await r.json();
    if (!r.ok) throw new Error(`oauth ${r.status}: ${j.error_description || j.error}`);
    this._tok = { value: j.access_token, exp: Date.now() + j.expires_in * 1000 };
    return this._tok.value;
  }

  // Browser-safe client token for JS SDK v6 (15 min, sdk_init scope only — never the server token).
  async clientToken() {
    const r = await fetch(this.apiBase + '/v1/oauth2/token', {
      method: 'POST',
      headers: {
        Authorization: 'Basic ' + Buffer.from(`${this.clientId}:${this.clientSecret}`).toString('base64'),
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: 'grant_type=client_credentials&response_type=client_token&intent=sdk_init',
    });
    const j = await r.json();
    if (!r.ok) throw new Error(`client token ${r.status}: ${j.error_description || j.error}`);
    return j.access_token;
  }

  // body: object → JSON, string → sent as-is (needed to embed a raw webhook body byte-for-byte)
  async api(method, path, body, headers = {}) {
    const r = await fetch(this.apiBase + path, {
      method,
      headers: { Authorization: 'Bearer ' + (await this.token()), 'Content-Type': 'application/json', ...headers },
      body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body),
    });
    const text = await r.text();
    const json = text ? JSON.parse(text) : {};
    if (!r.ok) {
      const err = new Error(`${method} ${path} → ${r.status} ${json.name || ''} ${json.message || ''}`);
      Object.assign(err, { status: r.status, body: json, debugId: r.headers.get('paypal-debug-id') });
      throw err;
    }
    return json;
  }

  // Digital good: NO_SHIPPING (the toolkit's create_order can't set it, so orders are created here),
  // one line item so the PayPal review page shows what is being bought.
  // vault: true = save the buyer's PayPal wallet when the payment succeeds (they opted in to agent reorders);
  // the capture response then carries payment_source.paypal.attributes.vault {id, customer.id}.
  createOrder({ sku, description, amount, customId, returnUrl, cancelUrl, itemName, vault = false }) {
    return this.api('POST', '/v2/checkout/orders', {
      intent: 'CAPTURE',
      purchase_units: this.units({ sku, description, amount, customId, itemName }),
      payment_source: {
        paypal: {
          ...(vault && { attributes: { vault: { store_in_vault: 'ON_SUCCESS', usage_type: 'MERCHANT', customer_type: 'CONSUMER' } } }),
          experience_context: {
            brand_name: 'AtlasOfOne',
            locale: 'en-US',
            user_action: 'PAY_NOW',
            shipping_preference: 'NO_SHIPPING',
            return_url: returnUrl,
            cancel_url: cancelUrl,
          },
        },
      },
    }, { 'PayPal-Request-Id': crypto.randomUUID(), Prefer: 'return=representation' });
  }

  // Pay with a saved wallet: no redirect, the order comes back COMPLETED with the capture inline.
  // requestId is required here (PayPal 400s without one) and makes a retry return the first result.
  chargeVault({ vaultId, requestId, ...unit }) {
    return this.api('POST', '/v2/checkout/orders', {
      intent: 'CAPTURE', purchase_units: this.units(unit), payment_source: { paypal: { vault_id: vaultId } },
    }, { 'PayPal-Request-Id': requestId, Prefer: 'return=representation' });
  }

  // Needs the app's "Save payment methods" feature; without it PayPal answers 403 and the caller's own
  // revocation (forgetting the vault id) is what stops further charges.
  deleteVaultToken(id) { return this.api('DELETE', `/v3/vault/payment-tokens/${id}`); }

  units({ sku, description, amount, customId, itemName }) {
    return [{
      reference_id: sku,
      custom_id: customId,
      description,
      amount: { currency_code: 'USD', value: amount, breakdown: { item_total: { currency_code: 'USD', value: amount } } },
      items: [{ name: (itemName || description).slice(0, 127), quantity: '1', category: 'DIGITAL_GOODS', sku,
        unit_amount: { currency_code: 'USD', value: amount } }],
    }];
  }

  getOrder(id) { return this.api('GET', `/v2/checkout/orders/${id}`); }

  // Idempotent per order: a retried capture with the same request id returns the first result.
  captureOrder(id) {
    return this.api('POST', `/v2/checkout/orders/${id}/capture`, {}, {
      'PayPal-Request-Id': `capture-${id}`, Prefer: 'return=representation',
    });
  }

  // One webhook per app: reuse it, re-pointing the URL when the tunnel/host changes.
  async ensureWebhook(url, events) {
    const { webhooks = [] } = await this.api('GET', '/v1/notifications/webhooks');
    const want = events.map((name) => ({ name }));
    const same = webhooks.find((w) => w.url === url);
    if (same) return same.id;
    if (webhooks.length) {
      const w = webhooks[0];
      await this.api('PATCH', `/v1/notifications/webhooks/${w.id}`, [
        { op: 'replace', path: '/url', value: url },
        { op: 'replace', path: '/event_types', value: want },
      ]);
      return w.id;
    }
    return (await this.api('POST', '/v1/notifications/webhooks', { url, event_types: want })).id;
  }

  // Raw body is spliced in unparsed: re-serialising the event can change bytes and fail verification.
  async verifyWebhook(headers, rawBody, webhookId) {
    const h = (k) => headers[k] || '';
    const pre = JSON.stringify({
      auth_algo: h('paypal-auth-algo'),
      cert_url: h('paypal-cert-url'),
      transmission_id: h('paypal-transmission-id'),
      transmission_sig: h('paypal-transmission-sig'),
      transmission_time: h('paypal-transmission-time'),
      webhook_id: webhookId,
    });
    const body = pre.slice(0, -1) + ',"webhook_event":' + rawBody + '}';
    const r = await this.api('POST', '/v1/notifications/verify-webhook-signature', body);
    return r.verification_status === 'SUCCESS';
  }
}
