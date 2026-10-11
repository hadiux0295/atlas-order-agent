// The shop agent: brief → airport → watermarked proof → PayPal order → status / refund.
// Model = Gemini via the Vercel AI SDK; PayPal reads/refunds go through the official PayPal Agent Toolkit.
// Guard rails live in the tools (tools.mjs, shared with the MCP server), not the prompt; the no-model path
// (readBrief) keeps the shop usable.
import { generateText, tool, stepCountIs } from 'ai';
import { createGoogleGenerativeAI } from '@ai-sdk/google';
import { PayPalAgentToolkit } from '@paypal/agent-toolkit/ai-sdk';
import { PRODUCT, AIRPORTS, label } from './catalog.mjs';
import { readBrief } from './brief.mjs';
import { toolSpecs, toolResult } from './tools.mjs';

export { toolResult };

export const MODEL = process.env.AGENT_MODEL || 'gemini-3.5-flash';
const THINKING = process.env.AGENT_THINKING || 'minimal';

const INSTRUCTIONS = `You are the order assistant of AtlasOfOne, a small shop that makes personalised printable airport maze books for kids (ages 4–8): ${PRODUCT.blurb} Price: $${PRODUCT.price} ${PRODUCT.currency}, instant download after payment. Refunds: full refund within 14 days of purchase for any reason (refund_order).

How you work:
- You need two things: the child's first name exactly as it should be printed, and their home airport. Ask only for what is missing, one short question at a time.
- Resolve the airport with find_airports. If it returns several, ask which one. If it returns none, say we can't draw that airport yet and list a few nearby options from the catalogue.
- The airports we can draw are exactly what find_airports returns — never guess how many or which. Asked which airports we draw → call find_airports with their words; when nothing matches it lists the whole catalogue.
- As soon as you have both, call make_proof — once. Call it again only if the buyer changes the name or the airport. The buyer sees the proof card (the real cover with the name, watermarked) — do not describe the images in detail.
- Only after the buyer approves the proof (or clearly asks to buy) call create_checkout. Then tell them to use the PayPal button on the card.
- Payment status questions → check_order. A refund request for a paid order → refund_order (it refuses anything not from this chat).
- Never state a price, discount, or delivery promise that is not written above. Never ask for card numbers, passwords or addresses — PayPal handles payment.
- If a tool returns an error, never claim the step worked: say plainly what failed and offer the next best step.
- This is a sandbox demo: no real money moves. Say so if asked.
- Reply in the buyer's language, in 1–3 short sentences, warm and plain.`;

export class ShopAgent {
  constructor({ paypalEnv, shop }) {
    // shop = server hooks: makeProof(icao, child, session) · createCheckout(proofId, session) · orderOf(orderId) · refund(orderId, session)
    this.shop = shop;
    // several keys (GEMINI_API_KEYS=a,b,c) → rotate on a quota error; none → rule path only
    const keys = (process.env.GEMINI_API_KEYS || process.env.GEMINI_API_KEY || '').split(',').map((k) => k.trim()).filter(Boolean);
    this.providers = keys.map((apiKey) => createGoogleGenerativeAI({ apiKey }));
    this.google = this.providers[0] || null;
    this.keyIdx = 0;
    const tk = new PayPalAgentToolkit({
      clientId: paypalEnv.PAYPAL_CLIENT_ID, clientSecret: paypalEnv.PAYPAL_CLIENT_SECRET,
      configuration: { actions: { orders: { get: true }, payments: { createRefund: true } }, context: { sandbox: true } },
    });
    this.pp = tk.getTools(); // get_order · create_refund (toolkit implementations, called by our guarded tools)
    this.sessions = new Map();
  }

  session(id) {
    if (!this.sessions.has(id)) this.sessions.set(id, { messages: [], proofs: new Set(), orders: new Set(), cards: [] });
    if (this.sessions.size > 500) this.sessions.delete(this.sessions.keys().next().value);
    return this.sessions.get(id);
  }

  // the shared guarded specs (tools.mjs), wrapped as AI SDK tools
  tools(s) {
    const specs = toolSpecs({ shop: this.shop, pp: this.pp, s });
    return Object.fromEntries(Object.entries(specs).map(([k, v]) => [k, tool(v)]));
  }

  // → { reply, cards, steps, model }
  // A button press is a decision, not a sentence to interpret: checkout runs without the model.
  async checkoutAction(s) {
    const c = await this.shop.createCheckout(s.lastProof, s);
    s.lastOrder = c.orderId;
    s.cards.push({ type: 'checkout', ...c });
    return c;
  }

  async chat(sessionId, text, action) {
    const s = this.session(sessionId);
    s.cards.length = 0;
    if (action === 'checkout' && s.lastProof) {
      await this.checkoutAction(s);
      const reply = 'Here is your checkout — pay with the PayPal button on the card.';
      s.messages.push({ role: 'user', content: 'Looks good — check out.' }, { role: 'assistant', content: `${reply} (order created)` });
      return { reply, cards: [...s.cards], steps: ['create_checkout'], model: null };
    }
    s.messages.push({ role: 'user', content: String(text).slice(0, 1000) });
    for (let tries = 0; tries < this.providers.length; tries++) {
      const google = this.providers[this.keyIdx];
      try {
        const r = await generateText({
          model: google(MODEL), instructions: INSTRUCTIONS, messages: s.messages,
          tools: this.tools(s), stopWhen: stepCountIs(6), maxRetries: 0,
          providerOptions: { google: { thinkingConfig: { thinkingLevel: THINKING } } },
        });
        s.messages.push(...r.response.messages);
        const steps = r.steps.flatMap((st) => st.toolCalls.map((c) => c.toolName));
        // claim guard: the model said "checkout/PayPal button" but never created one → do it, don't leave a false promise.
        // A reply that still asks the buyer to confirm ("let me know and I'll set up checkout") is not a claim.
        const asking = /let me know|if you(?:'re| are)? (?:happy|ok|okay|ready|like)|would you like|shall i|should i|once you|ready to (?:check|order|pay)\?/i;
        if (/check ?out|paypal button/i.test(r.text || '') && !asking.test(r.text || '') && !s.cards.some((c) => c.type === 'checkout') && s.lastProof && !s.orders.size) {
          await this.checkoutAction(s);
          steps.push('create_checkout (guard)');
        }
        return { reply: r.text || '', cards: [...s.cards], steps, model: MODEL };
      } catch (e) {
        const quota = /quota|rate|429|RESOURCE_EXHAUSTED/i.test(String(e.message) + (e.statusCode || ''));
        console.error(`agent error (key ${this.keyIdx}${quota ? ', quota' : ''}):`, String(e.message).slice(0, 160));
        if (!quota) break;
        this.keyIdx = (this.keyIdx + 1) % this.providers.length;
        if (s.cards.length) break; // tools already ran this turn — don't run them twice
      }
    }
    if (s.cards.length) {
      const reply = 'Here you go — take a look at the card above.';
      s.messages.push({ role: 'assistant', content: reply });
      return { reply, cards: [...s.cards], steps: ['rules'], model: null };
    }
    return this.rulePath(s, text);
  }

  // No model: read the brief, remember what we know, proof as soon as both are known.
  async rulePath(s, text) {
    const b = readBrief(text);
    const named = b.airports;
    b.airports = named.filter((a) => this.shop.available(a.icao));
    s.known = { ...s.known, ...(b.child && { child: b.child }), ...(b.airports.length === 1 && { icao: b.airports[0].icao }) };
    let reply;
    if (/\b(yes|buy|looks good|approve|perfect|great|ok)\b/i.test(text) && s.lastProof) {
      const c = await this.shop.createCheckout(s.lastProof, s);
      s.lastOrder = c.orderId;
      s.cards.push({ type: 'checkout', ...c });
      reply = 'Here is your checkout — pay with the PayPal button on the card.';
    } else if (s.known?.child && s.known?.icao) {
      const p = await this.shop.makeProof(s.known.icao, s.known.child, s);
      s.lastProof = p.proofId;
      s.cards.push({ type: 'proof', ...p });
      reply = `Here is ${p.child}'s proof for ${p.airport}. Happy with it? Say "yes" to check out.`;
    } else if (b.airports.length > 1) reply = `Which one: ${b.airports.map(label).join(', ')}?`;
    else if (!s.known?.icao && (named.length || /\bwhich airports\b|\bwhat airports\b/i.test(text))) {
      const drawable = AIRPORTS.filter((a) => this.shop.available(a.icao)).map(label).join(', ');
      reply = `${named.length ? `We can't draw ${named.map(label).join(', ')} yet. ` : ''}Today we draw: ${drawable}.`;
    } else if (!s.known?.icao) reply = 'Which airport do you fly from? A city or a code like LAX works.';
    else reply = "What's the child's first name, exactly as it should be printed?";
    s.messages.push({ role: 'assistant', content: reply });
    return { reply, cards: [...s.cards], steps: ['rules'], model: null };
  }
}
