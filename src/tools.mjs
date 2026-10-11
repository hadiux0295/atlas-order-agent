// The shop's tools, defined once. The chat agent wraps them as AI SDK tools (agent.mjs); the MCP server
// exposes the same specs to other agents (mcp.mjs). Guard rails live here, so both doors get them:
// prices come from the catalogue (no tool takes an amount), orders and refunds are scoped to the session
// that created them, names are checked, and a thrown error comes back as an explicit error result.
import { z } from 'zod';
import { PRODUCT, AIRPORTS, findAirports, byIcao, label } from './catalog.mjs';
import { NAME_RE } from './proof.mjs';

// PayPal Agent Toolkit tools return a JSON *string* ({ok:false,status,code,message} on errors), not an object.
export const toolResult = (r) => { if (typeof r !== 'string') return r; try { return JSON.parse(r); } catch { return { raw: r }; } };

// a thrown tool error becomes an explicit result, so a model can't mistake silence for success
const safe = (fn) => async (args) => {
  try { return await fn(args); } catch (e) { console.error('tool error:', e.message); return { error: 'failed on our side', detail: String(e.message).slice(0, 200) }; }
};

// s = session { proofs:Set, orders:Set, cards:[], lastProof, lastOrder, proofInfo } · shop = server hooks ·
// pp = PayPal Agent Toolkit tools (get_order · create_refund) · maxOrders = per-session order cap ·
// agent = the caller is another agent over MCP: adds the mandate tools (save wallet · buy · status)
export function toolSpecs({ shop, pp, s, maxOrders = Infinity, agent = false }) {
  const cards = s.cards;
  const specs = {
    find_airports: {
      description: 'Find catalogue airports matching free text (city, airport name, or IATA/ICAO code). Returns up to 3.',
      inputSchema: z.object({ query: z.string().describe('what the buyer said about where they fly from') }),
      execute: async ({ query }) => {
        const ok = (a) => shop.available(a.icao);
        const hits = findAirports(query, 5).filter(ok).slice(0, 3);
        return hits.length ? hits.map((a) => ({ icao: a.icao, label: label(a), name: a.name }))
          : { none: true, airports_we_can_draw: AIRPORTS.filter(ok).map(label) };
      },
    },
    make_proof: {
      description: "Render the watermarked proof (cover with the child's name + one maze page) for the buyer to approve.",
      inputSchema: z.object({ icao: z.string().describe('ICAO code from find_airports'), child_name: z.string().describe('first name exactly as it should be printed') }),
      execute: async ({ icao, child_name }) => {
        const a = byIcao(icao);
        if (!a || !shop.available(a.icao)) return { error: 'not an airport we can draw — use find_airports first' };
        if (!NAME_RE.test(child_name.trim())) return { error: 'name must be letters only, up to 20 characters' };
        const prev = s.proofInfo?.[s.lastProof];
        if (prev && prev.icao === a.icao && prev.child === child_name.trim())
          return { proof_id: s.lastProof, note: 'this proof is already on screen — no need to make it again' };
        const p = await shop.makeProof(a.icao, child_name.trim(), s);
        s.proofInfo = { ...s.proofInfo, [p.proofId]: { icao: a.icao, child: p.child } };
        s.lastProof = p.proofId;
        cards.push({ type: 'proof', ...p });
        return { proof_id: p.proofId, airport: p.airport, child: p.child, price: `$${PRODUCT.price}`, cover_url: shop.abs(p.cover), maze_url: shop.abs(p.maze), shown_to_buyer: true };
      },
    },
    create_checkout: {
      description: 'Create the PayPal order for an approved proof (default: the latest proof in this session). The price comes from the catalogue. Returns approve_url: the buyer opens it and pays on PayPal.',
      inputSchema: z.object({
        proof_id: z.string().optional().describe('omit to use the latest proof'),
        ...(agent && { save_wallet_for_agent: z.boolean().optional().describe('only when your owner asked to let you reorder without approving each time: their PayPal is saved for this shop, with limits they see and accept on approve_url before paying') }),
      }),
      execute: async ({ proof_id, save_wallet_for_agent }) => {
        if (!proof_id || !s.proofs.has(proof_id)) proof_id = s.lastProof;
        if (!proof_id) return { error: 'no proof in this session yet — make one first' };
        if (s.orders.size >= maxOrders) return { error: `order limit reached for this session (${maxOrders})` };
        const c = await shop.createCheckout(proof_id, s, { saveWallet: agent && !!save_wallet_for_agent });
        s.lastOrder = c.orderId;
        cards.push({ type: 'checkout', ...c });
        return { order_id: c.orderId, amount: `$${c.amount}`, approve_url: c.approveUrl, save_wallet_for_agent: c.saveWallet,
          next: 'the buyer approves the payment (approve_url, or the PayPal button on the card)' };
      },
    },
    check_order: {
      description: 'Look up an order from this session (default: the latest one): PayPal status plus our fulfilment status and, when ready, the download link.',
      inputSchema: z.object({ order_id: z.string().optional() }),
      execute: async ({ order_id }) => {
        if (!order_id || !s.orders.has(order_id)) order_id = s.lastOrder;
        if (!order_id) return { error: 'no order in this session yet' };
        const o = toolResult(await pp.get_order.execute({ id: order_id }, {}));
        const ours = shop.orderOf(order_id) || {};
        // a freshly minted mandate token goes out once, to the session that placed the order
        const token = agent && ours.mandateId ? shop.takeMandateToken(order_id) : null;
        return { order_id, paypal_status: o?.status, fulfilment: ours.status, download_ready: ours.status === 'ready',
          ...(ours.status === 'ready' && { download_url: shop.abs(`/dl/${ours.token}`) }),
          ...(agent && ours.mandateId && { agent_mandate: { ...shop.mandateView(ours.mandateId),
            ...(token && { token, how_to_use: 'shown once: connect to this MCP server with the header Authorization: Bearer <token>, then buy_with_mandate' }) } }) };
      },
    },
    refund_order: {
      description: 'Refund a paid order from this session in full (default: the latest one) — wrong name, changed mind. The book link stops working.',
      inputSchema: z.object({ order_id: z.string().optional(), reason: z.string() }),
      execute: async ({ order_id, reason }) => {
        // an agent with the owner's mandate may also refund books bought with that mandate in earlier sessions
        const mine = (id) => s.orders.has(id) || (agent && s.mandateId && shop.orderOf(id)?.mandateId === s.mandateId);
        if (!order_id || !mine(order_id)) order_id = s.lastOrder;
        if (!order_id) return { error: 'no order in this session yet' };
        const r = await shop.refund(order_id, reason, pp.create_refund);
        if (r.refundId) cards.push({ type: 'refund', orderId: order_id, ...r });
        return r;
      },
    },
  };
  if (agent) Object.assign(specs, {
    buy_with_mandate: {
      description: "Buy a proof with your owner's saved PayPal wallet — no approval step. Needs the mandate token as the connection's Authorization: Bearer header; the shop enforces the owner's limits (price, books per day, end date).",
      inputSchema: z.object({ proof_id: z.string().optional().describe('omit to use the latest proof') }),
      execute: async ({ proof_id }) => {
        if (!s.mandateId) return { error: s.badMandate ? 'the mandate token is not valid (revoked, ended or unknown)' : 'no mandate on this connection — use create_checkout and let your owner approve' };
        if (!proof_id || !s.proofs.has(proof_id)) proof_id = s.lastProof;
        if (!proof_id) return { error: 'no proof in this session yet — make one first' };
        if (s.orders.size >= maxOrders) return { error: `order limit reached for this session (${maxOrders})` };
        const r = await shop.buyWithMandate(proof_id, s, s.mandateId);
        if (r.order_id) s.lastOrder = r.order_id;
        return r;
      },
    },
    mandate_status: {
      description: "What this connection's mandate allows right now (limits, used today, end date) — or that there is none.",
      inputSchema: z.object({}),
      execute: async () => (s.mandateId ? shop.mandateView(s.mandateId) : { none: true, ...(s.badMandate && { note: 'token sent but not valid' }) }),
    },
  });
  for (const k of Object.keys(specs)) specs[k].execute = safe(specs[k].execute);
  return specs;
}
