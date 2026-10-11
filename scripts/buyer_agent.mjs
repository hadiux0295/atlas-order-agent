// A second agent that shops at AtlasOfOne through its MCP server — agent-to-agent commerce.
// It is someone's family assistant: it finds the airport, renders the proof, shows it to its owner,
// opens the PayPal checkout, hands the approval to the owner (ask_owner), waits, and fetches the book.
// Every MCP tool call and result is written to a JSONL log (the evidence of what the agent did).
//
// Usage:
//   node scripts/buyer_agent.mjs "Get a maze book for my grandson Leo, he flies from Seattle"
//   --mcp <url>      MCP endpoint (default https://atlas.hun-is.com/mcp)
//   --scripted       no model: walk the same MCP calls in a fixed order (tests the server end to end)
//   --approve        sandbox only: approve on PayPal headlessly as the sandbox buyer (PAYPAL_ENV_FILE)
//   --child <name> --airport <text>   inputs for --scripted
//   --out <dir>      log + downloaded zip (default ./buyer_runs/<utc stamp>)
// Env: GEMINI_API_KEYS (model mode), AGENT_MODEL (gemini-3.5-flash), PAYPAL_ENV_FILE (--approve)
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline/promises';
import { createMCPClient } from '@ai-sdk/mcp';
import { generateText, tool, stepCountIs } from 'ai';
import { createGoogleGenerativeAI } from '@ai-sdk/google';
import { z } from 'zod';
import { loadEnvFile } from '../src/paypal.mjs';
import { approveOnPayPal } from './lib/approve.mjs';

const argv = process.argv.slice(2);
const flag = (k) => argv.includes(`--${k}`);
const opt = (k, d) => { const i = argv.indexOf(`--${k}`); return i >= 0 ? argv[i + 1] : d; };
const optKeys = new Set(['mcp', 'child', 'airport', 'out']);
const goal = argv.filter((a, i) => !a.startsWith('--') && !optKeys.has(argv[i - 1]?.slice(2))).join(' ')
  || 'Get a personalised airport maze book for my grandson Leo — he always flies out of Seattle.';
const MCP_URL = opt('mcp', 'https://atlas.hun-is.com/mcp');
const OUT = path.resolve(opt('out', path.join('buyer_runs', new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19))));
fs.mkdirSync(OUT, { recursive: true });
const LOG = path.join(OUT, 'mcp_calls.jsonl');
const t0 = Date.now();
const log = (o) => fs.appendFileSync(LOG, JSON.stringify({ t: ((Date.now() - t0) / 1000).toFixed(1), ...o }) + '\n');
const say = (who, msg) => console.log(`${((Date.now() - t0) / 1000).toFixed(1).padStart(6)}s  ${who.padEnd(6)} ${msg}`);
const parse = (r) => { try { return JSON.parse(r?.content?.[0]?.text); } catch { return r; } };

// the owner's side: in --approve mode the sandbox buyer approves headlessly; otherwise a person does it
async function ownerApproves(url) {
  if (flag('approve')) {
    const env = loadEnvFile(process.env.PAYPAL_ENV_FILE);
    const back = await approveOnPayPal(url, {
      email: env.PAYPAL_SANDBOX_BUYER_EMAIL, password: env.PAYPAL_SANDBOX_BUYER_PASSWORD,
      returnPrefix: new URL(MCP_URL).origin, shot: path.join(OUT, 'paypal_review.png'),
    });
    say('owner', `approved on PayPal (sandbox buyer) → ${back.slice(0, 70)}`);
    return 'The owner approved the payment on PayPal.';
  }
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const a = await rl.question(`\n  OWNER: open ${url}\n  approve on PayPal, then press Enter (or type "no"): `);
  rl.close();
  return /^n/i.test(a.trim()) ? 'The owner declined.' : 'The owner says they approved the payment on PayPal.';
}

async function download(url) {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`download ${r.status}`);
  const f = path.join(OUT, 'book.zip');
  fs.writeFileSync(f, Buffer.from(await r.arrayBuffer()));
  return f;
}

const client = await createMCPClient({ transport: { type: 'http', url: MCP_URL }, name: 'family-assistant-agent' });
const shopTools = await client.tools();
say('agent', `connected to ${MCP_URL} — shop tools: ${Object.keys(shopTools).join(', ')}`);
log({ goal, mcp: MCP_URL, tools: Object.keys(shopTools), mode: flag('scripted') ? 'scripted' : 'model' });

// every shop call goes through here: logged with input and result
const call = async (name, input) => {
  say('→ shop', `${name} ${JSON.stringify(input)}`);
  const raw = await shopTools[name].execute(input, { toolCallId: name, messages: [] });
  const out = parse(raw);
  log({ call: name, input, result: out });
  say('← shop', JSON.stringify(out).slice(0, 150));
  return out;
};

let downloaded = null;
try {
  if (flag('scripted')) {
    const airports = await call('find_airports', { query: opt('airport', 'Seattle') });
    if (!Array.isArray(airports) || !airports.length) throw new Error('no airport');
    const proof = await call('make_proof', { icao: airports[0].icao, child_name: opt('child', 'Leo') });
    if (proof.error) throw new Error(proof.error);
    say('agent', `proof for the owner: ${proof.cover_url}`);
    const co = await call('create_checkout', { proof_id: proof.proof_id });
    if (co.error) throw new Error(co.error);
    say('owner', await ownerApproves(co.approve_url));
    for (let i = 0; i < 40; i++) {
      const st = await call('check_order', { order_id: co.order_id });
      if (st.download_ready) { downloaded = await download(st.download_url); break; }
      if (['failed', 'refunded'].includes(st.fulfilment)) throw new Error(`order ${st.fulfilment}`);
      await new Promise((r) => setTimeout(r, 5000));
    }
  } else {
    const keys = (process.env.GEMINI_API_KEYS || process.env.GEMINI_API_KEY || '').split(',').map((k) => k.trim()).filter(Boolean);
    if (!keys.length) throw new Error('no GEMINI_API_KEYS — use --scripted');
    const model = process.env.AGENT_MODEL || 'gemini-3.5-flash';
    const tools = {
      ...Object.fromEntries(Object.keys(shopTools).map((name) => [name, tool({
        description: shopTools[name].description, inputSchema: shopTools[name].inputSchema,
        execute: (input) => call(name, input),
      })])),
      ask_owner: tool({
        description: 'Show your owner something and wait for their answer. Use it to show the proof (cover_url) and to hand over the PayPal approve_url — only the owner can approve a payment.',
        inputSchema: z.object({ message: z.string(), approve_url: z.string().optional() }),
        execute: async ({ message, approve_url }) => {
          say('agent', `to owner: ${message}`);
          log({ ask_owner: message, approve_url });
          if (approve_url) return ownerApproves(approve_url);
          return 'The owner says: looks great, go ahead.';
        },
      }),
      wait: tool({
        description: 'Wait a number of seconds (5–30) before checking an order again.',
        inputSchema: z.object({ seconds: z.number() }),
        execute: async ({ seconds }) => { await new Promise((r) => setTimeout(r, Math.min(30, Math.max(5, seconds)) * 1000)); return 'waited'; },
      }),
      save_download: tool({
        description: 'Download the finished book from download_url to the owner\'s files.',
        inputSchema: z.object({ download_url: z.string() }),
        execute: async ({ download_url }) => { downloaded = await download(download_url); return { saved: path.basename(downloaded) }; },
      }),
    };
    const system = `You are a family assistant agent acting for your owner. You shop at merchant agents through their MCP tools.
Rules: you never pay — only your owner approves a payment, through ask_owner with the approve_url. Before checkout, show the owner the proof (ask_owner with the cover_url). Never invent prices; use what the shop returns. After approval, poll check_order (use wait between checks) until download_ready, then save_download. Finish with one short summary for the owner.`;
    for (let k = 0; k < keys.length; k++) {
      try {
        const r = await generateText({
          model: createGoogleGenerativeAI({ apiKey: keys[k] })(model), system, prompt: goal, tools,
          stopWhen: stepCountIs(30), maxRetries: 0,
          providerOptions: { google: { thinkingConfig: { thinkingLevel: 'minimal' } } },
        });
        say('agent', r.text);
        log({ final: r.text, model, steps: r.steps.length });
        break;
      } catch (e) {
        // never re-run a goal that already opened a checkout: a fresh run could buy twice
        const bought = fs.readFileSync(LOG, 'utf8').includes('"call":"create_checkout"');
        if (bought || !/quota|rate|429|RESOURCE_EXHAUSTED/i.test(String(e.message)) || k === keys.length - 1) throw e;
        say('agent', `model key ${k} over quota — next key`);
      }
    }
  }
} catch (e) {
  say('agent', `stopped: ${e.message}`);
  log({ error: e.message });
  process.exitCode = 1;
} finally {
  await client.close();
}
if (downloaded) say('agent', `book saved: ${downloaded} (${fs.statSync(downloaded).size} bytes) · log ${LOG}`);
else if (!process.exitCode) process.exitCode = 1;
