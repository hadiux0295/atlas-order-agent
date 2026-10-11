# AtlasOfOne Order Agent — demo video narration (target 2:30, hard cap 2:50)

Each `## P<n>` block is one narrated segment, synthesised as one paragraph (natural prosody inside a
scene, an exact cut at every scene boundary). `say:` is spoken verbatim and burned in as captions;
`show:` is what the recording puts on screen. Every number spoken is measured or set in code:
$9.99 · 3 books a day · 30 days (src/catalog.mjs, src/server.mjs MANDATE) · "under thirty seconds"
(live run 28.6 s, public build 21.8 s — re-check against the recorded take) · "about twelve seconds"
(mandate reorder, call → book ready: 12 s live and 11.9 s from a fresh clone). Patterns: design_lab/hackathons_q4/paypal_video_research.md.

## P1
show: shop page, desktop. The brief is typed into the chat; the proof card (cover with "Leo's", one maze) appears.
say: A parent types one line: my six-year-old Leo loves planes, and we fly out of J F K. Seconds later, the shop's own AI agent shows the real cover, with Leo's name on it, and a maze drawn from the real taxiways of his airport. Nothing has been charged.

## P2
show: "Looks good — check out" → checkout card with the PayPal button → PayPal window over the page (sandbox buyer, US) → approve → steps tick: captured, drawing, ready → "Download the book".
say: When the parent approves the proof, the agent opens a PayPal checkout. The price comes from the shop's catalogue; no tool lets the model set an amount. PayPal's version six JavaScript SDK opens the payment window. The parent approves, the shop captures the payment on its server, and starts drawing. From brief to book, under thirty seconds.

## P3
show: the order card's steps, then the downloaded book (cover + a maze page), then 6–8 s of the README "PayPal integration" table.
say: Under the hood, this is PayPal end to end. Orders version two, with no shipping for a digital book. Webhooks, each signature verified against the raw body. And the PayPal Agent Toolkit for order lookups and refunds. When a tool fails, the agent gets the error, so it can never claim a step that didn't happen.

## P4
show: split screen — left: a second agent's MCP call log (find_airports → make_proof → create_checkout save_wallet_for_agent); right: the approve page with the consent box and its limits → PayPal approve.
say: Now a second AI, a family assistant, shops at the same store through the shop's MCP server, with the same guarded tools. On its first order, it asks to reorder for its owner. The owner sees exactly what that means: this shop only, nine ninety-nine a book, at most three books a day, for thirty days, and it can be switched off. One approval in PayPal saves the wallet.

## P5
show: call log — buy_with_mandate → capture COMPLETED → book ready (no PayPal window). Then the order page: owner clicks "switch off" → call log: buy_with_mandate → refused "the owner revoked this mandate".
say: The next time, the assistant buys on its own, with no approval step, and the book is ready in about twelve seconds. The limits are enforced by the shop, not by the AI. And the moment the owner switches the mandate off, the very next attempt is refused.

## P6
show: chat — "I spelled the name wrong, please refund" → refund card → download link closed. Then end card: AtlasOfOne Order Agent · atlas.hun-is.com · github repo · "open source".
say: Spelled the name wrong? Ask the agent. The toolkit refunds the payment, the webhook confirms it, and the download closes. AtlasOfOne Order Agent: a shop's own agent that sells, gets paid with PayPal, and delivers, to people and to their agents. The agent and the full PayPal layer are open source. Try it live in the PayPal sandbox.
