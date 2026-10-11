// The shop as an MCP server (Streamable HTTP at /mcp): another agent — a family assistant, a gift
// concierge — can find an airport, render the proof, and check out through the same guarded tools the
// chat agent uses (tools.mjs). One MCP session = one shop session, so orders and refunds stay scoped to
// the agent that created them, exactly as in the chat.
import crypto from 'node:crypto';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { PRODUCT } from './catalog.mjs';
import { toolSpecs } from './tools.mjs';

const MAX_SESSIONS = 200, IDLE_MS = 60 * 60_000, MAX_ORDERS = 3;

const INSTRUCTIONS = `AtlasOfOne sells one product: ${PRODUCT.title} — ${PRODUCT.blurb} Price $${PRODUCT.price} ${PRODUCT.currency}, set by the shop (no tool takes an amount). Flow: find_airports → make_proof (show cover_url to your user) → create_checkout → your user approves on approve_url → check_order until download_ready. If your owner wants you to reorder on your own, pass save_wallet_for_agent: true on that first checkout; they accept the limits on approve_url, check_order then returns a mandate token once, and later connections that send it as Authorization: Bearer can buy_with_mandate without an approval step. Refund within 14 days: refund_order. Sandbox demo: no real money moves.`;

export function createMcp({ shop, pp }) {
  const sessions = new Map(); // mcp-session-id → { transport, s, seen }

  const sweep = () => {
    const now = Date.now();
    for (const [id, x] of sessions) if (now - x.seen > IDLE_MS) { x.transport.close().catch(() => {}); sessions.delete(id); }
  };

  // Authorization: Bearer <mandate token> → this connection may buy with the owner's saved wallet
  function open(req) {
    const s = { messages: [], proofs: new Set(), orders: new Set(), cards: [] };
    const bearer = (req.headers.authorization || '').match(/^Bearer\s+(\S+)$/i)?.[1];
    if (bearer) { s.mandateId = shop.mandateByToken(bearer); s.badMandate = !s.mandateId; }
    const server = new McpServer({ name: 'atlasofone-shop', version: '0.2.0' }, { instructions: INSTRUCTIONS });
    for (const [name, spec] of Object.entries(toolSpecs({ shop, pp, s, maxOrders: MAX_ORDERS, agent: true }))) {
      server.registerTool(name, { description: spec.description, inputSchema: spec.inputSchema }, async (args) => {
        s.cards.length = 0; // cards are for the chat UI; an MCP client gets everything in the result
        const r = await spec.execute(args);
        return { content: [{ type: 'text', text: JSON.stringify(r) }], ...(r?.error && { isError: true }) };
      });
    }
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => crypto.randomUUID(),
      onsessioninitialized: (id) => { sweep(); if (sessions.size >= MAX_SESSIONS) sessions.delete(sessions.keys().next().value); sessions.set(id, { transport, s, seen: Date.now() }); },
    });
    transport.onclose = () => { if (transport.sessionId) sessions.delete(transport.sessionId); };
    return server.connect(transport).then(() => transport);
  }

  // raw node req/res — call before anything reads the body
  return async function handle(req, res) {
    const id = req.headers['mcp-session-id'];
    const x = id && sessions.get(id);
    if (x) { x.seen = Date.now(); return x.transport.handleRequest(req, res); }
    if (id) { res.writeHead(404, { 'Content-Type': 'application/json' }); return res.end(JSON.stringify({ jsonrpc: '2.0', error: { code: -32001, message: 'session not found — initialize again' }, id: null })); }
    if (req.method !== 'POST') { res.writeHead(405, { Allow: 'POST' }); return res.end(); }
    return (await open(req)).handleRequest(req, res);
  };
}
