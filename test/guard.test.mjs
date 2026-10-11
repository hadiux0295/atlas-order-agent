// The claim guard opens a PayPal order on its own, so every reply that ever fired it by mistake stays here.
// Replies are verbatim Gemini 3.5 Flash outputs from the live shop.
import test from 'node:test';
import assert from 'node:assert/strict';
import { guardShouldCheckout } from '../src/guard.mjs';

const afterProof = { lastProof: 'p1', orders: new Set() };
const proofCard = [{ type: 'proof' }];

test('a conditional promise is not a claim (lex-1066)', () => {
  assert.equal(guardShouldCheckout('Here is the proof. Let me know and I will set up the checkout for you.', [], afterProof), false);
  assert.equal(guardShouldCheckout("Please check the proof above to make sure Leo's name and the airport look good. If you're happy with it, let me know and I can generate your checkout link!", [], afterProof), false);
});

test('"check out the proof card" in the turn that made the proof is not a claim (2026-10-11 demo take)', () => {
  const reply = "I've created a preview proof of Leo's personalized airport maze book for John F. Kennedy International Airport (JFK)!\n\nPlease check out the proof card above. How does it look to you?";
  assert.equal(guardShouldCheckout(reply, proofCard, afterProof), false);
});

test('a real claim with no checkout card still gets one', () => {
  assert.equal(guardShouldCheckout('Here is your checkout — pay with the PayPal button on the card.', [], afterProof), true);
});

test('never a second order, never without a proof', () => {
  assert.equal(guardShouldCheckout('Here is your checkout.', [{ type: 'checkout' }], afterProof), false);
  assert.equal(guardShouldCheckout('Here is your checkout.', [], { lastProof: 'p1', orders: new Set(['O1']) }), false);
  assert.equal(guardShouldCheckout('Here is your checkout.', [], { lastProof: null, orders: new Set() }), false);
});
