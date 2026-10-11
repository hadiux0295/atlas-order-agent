# AtlasOfOne Order Agent

**A small shop's own AI agent that takes an order from a one-line brief to a paid, delivered product, with PayPal handling every step where money moves.**

Live sandbox demo: **https://atlas.hun-is.com** (PayPal sandbox; no real money moves) · MCP endpoint for other agents: `https://atlas.hun-is.com/mcp`

AtlasOfOne sells one thing: a personalised, printable maze book for kids (ages 4–8), drawn on the real taxiways of the airport the family flies from. A parent types *"My 5-year-old Mia loves planes, we fly out of LAX"*. The agent finds the airport, renders a watermarked proof of the real cover with the child's name, and opens a PayPal checkout once the parent approves the proof. When the capture completes, the shop prints the book and hands over the download. Refunds, order status and reorders go through the same agent.

```
brief ─▶ find_airports ─▶ make_proof (watermarked cover + maze) ─▶ buyer approves the proof
      ─▶ create_checkout (Orders v2) ─▶ PayPal button (JS SDK v6) ─▶ capture
      ─▶ fulfil (render Letter + A4 PDFs, zip) ─▶ download link
      ─▶ check_order · refund_order (Agent Toolkit) · webhook reconciles every state
```

## Why it is built this way

- **The merchant owns the checkout.** No marketplace sits between the buyer and the shop. The shop's own agent runs proof → payment → fulfilment end to end, so the shop keeps the customer and controls what is promised.
- **Show before charge.** Personalised goods are bought on the proof. The buyer sees the actual cover with the actual name *before* the PayPal button appears, which is standard practice for personalised products.
- **The model chooses *what*, never *how much*.** No tool takes an amount. Prices live only in `src/catalog.mjs`, and the PayPal order is built server-side from the catalogue.
- **The agent cannot claim what did not happen.** Tool errors come back as explicit results. The prompt forbids claiming a step that failed. A deterministic guard checks replies that promise a checkout against the checkout cards that actually exist.
- **No model key, still a shop.** Without a Gemini key, a rule-based brief parser (`src/brief.mjs`) runs the same flow: name + airport → proof → checkout.

## PayPal integration

| What | How |
|---|---|
| Order creation | Orders v2 `POST /v2/checkout/orders`, `intent: CAPTURE`, `shipping_preference: NO_SHIPPING` (a digital good), `user_action: PAY_NOW`, a `PayPal-Request-Id` on every call |
| Buyer approval | **JS SDK v6** one-time payment session (`paypal-payments`) with a server-issued client token. A redirect flow (`/order` → approve → `/return`) is kept for headless tests |
| Capture | Server-to-server capture with an idempotent `PayPal-Request-Id`. Fulfilment starts on our own `COMPLETED` capture |
| Webhooks | `PAYMENT.CAPTURE.COMPLETED / REFUNDED / DENIED`, `CHECKOUT.ORDER.APPROVED`, each checked with `verify-webhook-signature` against the **raw** request body. The webhook is the idempotent fallback for fulfilment and reconciles refunds (a refunded order's download closes) |
| Agent Toolkit | `@paypal/agent-toolkit` (Vercel AI SDK adapter) provides the agent's `get_order` and `create_refund` |
| Vault | On the first checkout, the owner can save their PayPal wallet (`store_in_vault: ON_SUCCESS`). That wallet backs an **agent mandate** (below) |

**Why the shop creates orders itself instead of using the toolkit's `create_order`:** the toolkit's order payload has no `shipping_preference` or `custom_id`, and a digital download must not ask for a shipping address. Reading and refunding go through the toolkit. Creating goes through our Orders v2 call.

## Agent-to-agent: MCP server + agent mandate

`/mcp` (Streamable HTTP) exposes the **same guarded tools** the chat agent uses (`src/tools.mjs`): `find_airports`, `make_proof`, `create_checkout`, `check_order`, `refund_order`, `buy_with_mandate`, `mandate_status`. One MCP session is one shop session, so an agent can only see and refund the orders it created.

**Agent mandate:** a family assistant (`scripts/buyer_agent.mjs`) shops through MCP. On its first checkout it can ask to reorder for its owner. The approve page, which the owner opens, shows the proof, the price and a consent box: "Your agent also asked to reorder for you", with the limits listed. The button reads "Agree and continue to PayPal". When that payment completes, PayPal vaults the wallet and the agent receives a bearer token. From then on it can buy a new book **without an approval step**, inside limits **the shop enforces** (a vault token has no limits of its own):

- catalogue price per book ($9.99)
- at most 3 books per day
- 30 days

The owner can revoke the mandate on the order page. Revoking forgets the vault id and asks PayPal to delete it.

Measured in the sandbox: save-wallet order 16 s → bearer reorder 12 s with no approval, webhook verified.

## Unhappy paths

- **Render fails after payment:** automatic full refund ("we couldn't make your book").
- **Refund:** full refund within 14 days for any reason, from the order page or by asking the agent. The download link closes.
- **Airport we can't draw:** the agent says so and lists what it can draw. It never guesses the catalogue.
- **Duplicates:** a `PayPal-Request-Id` on each create/capture, fulfilment that runs once per capture id, and deduplicated proofs.
- **Cancelled approval:** the buyer returns to the shop and nothing is charged.

## Open-source build vs. the hosted demo

| | Open-source build (this repo, default) | Hosted demo (atlas.hun-is.com) |
|---|---|---|
| Renderer | `RENDERER=public` (or unset): **reduced renderer**, one bundled airport (New York JFK) | `RENDERER=private`: the AtlasOfOne production pipeline (not in this repo) |
| Airports | 1 | the shop's full catalogue |
| Delivered PDF | watermarked **SAMPLE** on every page | clean |
| Agent, PayPal, MCP, mandate code | identical | identical |

The paid generator that turns OpenStreetMap taxiways into solvable mazes stays private. Everything about the agent and the PayPal flow is here in full. The public build runs the complete purchase end to end: proof, PayPal sandbox payment, capture and a SAMPLE-watermarked download.

## Run it

Requirements: Node.js (tested on 24), Python 3 (zips the download), a PayPal **sandbox** app (developer.paypal.com → Apps & Credentials).

```bash
npm install
npx playwright install chromium        # proofs and PDFs are rendered in headless Chromium

cat > paypal_sandbox.env <<'EOF'
PAYPAL_CLIENT_ID=...
PAYPAL_CLIENT_SECRET=...
PAYPAL_API_BASE=https://api-m.sandbox.paypal.com
EOF

# local: no webhook (the app's single webhook is never re-pointed at localhost)
PAYPAL_ENV_FILE=paypal_sandbox.env SKIP_WEBHOOK=1 PORT=8742 npm start
# → http://localhost:8742   (add GEMINI_API_KEY=... for the model agent; without it the rule path runs)
```

On a public URL, set `PUBLIC_URL=https://your.host` and leave `SKIP_WEBHOOK` unset. The server then creates or updates the app's webhook to `PUBLIC_URL/webhook` for the events above.

| Env | Meaning |
|---|---|
| `PAYPAL_ENV_FILE` | file with `PAYPAL_CLIENT_ID`, `PAYPAL_CLIENT_SECRET`, `PAYPAL_API_BASE` |
| `PUBLIC_URL` · `PORT` (8742) · `DATA_DIR` (`./data`) | where it is reachable · where orders and downloads are kept |
| `GEMINI_API_KEY` or `GEMINI_API_KEYS=a,b` | the model agent (rotates keys on quota errors); none = rule path |
| `AGENT_MODEL` (`gemini-3.5-flash`) · `AGENT_THINKING` (`minimal`) | model choice |
| `RENDERER` · `PIPELINE_ROOT` | `public` (default) or `private` + the pipeline location |
| `SKIP_WEBHOOK=1` | local development |

### Test scripts

```bash
# the chat front, headless: brief → proof → PayPal popup → sandbox buyer login → approve → download
PAYPAL_ENV_FILE=… BASE_URL=http://localhost:8742 node scripts/e2e_chat.mjs "Leo, 6, flies from JFK"
# the redirect flow
PAYPAL_ENV_FILE=… BASE_URL=… node scripts/e2e_sandbox.mjs Leo KJFK
# a second agent buying over MCP (scripted, or model-driven with GEMINI_API_KEYS)
node scripts/buyer_agent.mjs --mcp http://localhost:8742/mcp --scripted --child Leo --airport JFK --approve --save-wallet
```

`e2e_chat.mjs` and `--approve` log in as the sandbox buyer account (`PAYPAL_ENV_FILE`). Measured: hosted demo brief → download **28.6 s** (6 s after approval); this public build locally **21.8 s**.

## Code map

```
src/server.mjs    HTTP server: chat API, proofs, orders, capture, webhooks, downloads, mandates
src/agent.mjs     the shop agent (Gemini via AI SDK 7) + rule path + claim guard
src/tools.mjs     the guarded tools, shared by the chat agent and the MCP server
src/mcp.mjs       MCP server (Streamable HTTP, one shop session per MCP session)
src/paypal.mjs    OAuth, Orders v2, client token, vault, webhook setup + signature verification
src/catalog.mjs   the product, its price, and the airports
src/proof.mjs     watermarked proofs; RENDERER mode switch
src/renderer.mjs  fulfilment: private pipeline or the public SAMPLE renderer
src/brief.mjs     rule-based brief parser (no model)
assets/           the public build's one airport + fonts (see assets/README.md)
public/           the shop page (chat + proof cards + PayPal button)
scripts/          headless end-to-end tests + the MCP buyer agent
```

## Responsible-AI notes

- The page states that an AI assistant answers and names the model.
- The approve page says an AI agent prepared the order and that the shop, not any AI, sets the price and limits. Every mandate reorder still gets a PayPal receipt and the 14-day refund.
- The agent never asks for card numbers, passwords or addresses; PayPal handles payment.
- Data kept: the child's first name, the airport and the chat, to make and deliver the book. There is no account, no email and no tracking. Chat text is sent to the model provider (Google Gemini) to produce replies. Orders, proofs and mandates are stored as JSON files in `DATA_DIR`.

## License

Code: MIT (`LICENSE`). The bundled sample book, its fonts and its map data carry their own licenses; see `assets/README.md` (sample book CC BY-NC 4.0 · Barlow SIL OFL 1.1 · map data © OpenStreetMap contributors, ODbL).
