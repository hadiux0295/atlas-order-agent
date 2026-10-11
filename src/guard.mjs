// Claim guard: the model said "checkout / PayPal button" but never created one → the shop creates it, so the
// buyer is never left with a false promise. It must only fire on a real claim: a reply that still asks the buyer
// to confirm ("let me know and I'll set up checkout") is not a claim, and neither is a turn that just made the
// proof — the buyer hasn't seen it, so nothing can be approved yet ("please check out the proof card above" = look at it).
// test/guard.test.mjs replays the real replies that fired it by mistake.
const CLAIM = /check ?out|paypal button/i;
const ASKING = /let me know|if you(?:'re| are)? (?:happy|ok|okay|ready|like)|would you like|shall i|should i|once you|ready to (?:check|order|pay)\?/i;

// cards = the cards this turn produced; s = the chat session (lastProof, orders)
export function guardShouldCheckout(text, cards, s) {
  const t = text || '';
  return CLAIM.test(t) && !ASKING.test(t)
    && !cards.some((c) => c.type === 'proof')
    && !cards.some((c) => c.type === 'checkout')
    && !!s.lastProof && !s.orders.size;
}
