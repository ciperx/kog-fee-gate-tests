import test from "node:test";
import assert from "node:assert/strict";

import { DEFAULT_FEE_CONFIG, FeeGate, formatKog } from "../src/feeGate.js";
import { FeeLedger } from "../src/ledger.js";
import { InMemoryRegistry } from "../src/registry.js";
import type { BidBody, FeeProof, OfferBody, RegistryResponse } from "../src/types.js";

const JOB_ID = "job_fee_gate_1";
const LISTING_FEE = DEFAULT_FEE_CONFIG.listing.amount;
const BID_FEE = DEFAULT_FEE_CONFIG.bid.amount;

const offerBody: OfferBody = {
  agentDid: "did:key:z6MkOfferAgent",
  capability: "testing",
  priceUsdc: "30",
};

const bidBody: BidBody = {
  agentDid: "did:key:z6MkBidAgent",
  priceUsdc: "30",
  deliveryDate: "2026-10-27T12:00:00Z",
  approach: "Write the fee gate tests first, then the reference handler they drive.",
  settlement: "x402-base",
};

interface Harness {
  registry: InMemoryRegistry;
  gate: FeeGate;
  ledger: FeeLedger;
}

function harness(): Harness {
  const ledger = new FeeLedger();
  const gate = new FeeGate(DEFAULT_FEE_CONFIG, ledger, () => "2026-10-23T00:00:00.000Z");
  const registry = new InMemoryRegistry(gate);
  registry.addJob({ id: JOB_ID, ceilingUsdc: "30", open: true });
  return { registry, gate, ledger };
}

let txCounter = 0;

/** A proof that every rule accepts, so a test can change exactly one field. */
function validProof(purpose: "listing" | "bid" = "listing"): FeeProof {
  txCounter += 1;
  const terms = purpose === "listing" ? DEFAULT_FEE_CONFIG.listing : DEFAULT_FEE_CONFIG.bid;
  return {
    txHash: `0x${txCounter.toString(16).padStart(64, "0")}`,
    from: "0xagent",
    recipient: terms.recipient,
    token: terms.token,
    amount: terms.amount,
    chainId: terms.chainId,
    purpose,
  };
}

function postOffer(h: Harness, fee: unknown): RegistryResponse {
  return h.registry.handle({ method: "POST", path: "/offers", body: offerBody, fee });
}

function postBid(h: Harness, fee: unknown): RegistryResponse {
  return h.registry.handle({ method: "POST", path: `/jobs/${JOB_ID}/bids`, body: bidBody, fee });
}

function code(response: RegistryResponse): unknown {
  return response.body.code;
}

function message(response: RegistryResponse): string {
  return String(response.body.message ?? "");
}

test("rule 1: a listing without a fee is refused and stores nothing", () => {
  const h = harness();
  const response = postOffer(h, undefined);

  assert.equal(response.status, 402);
  assert.equal(code(response), "FEE_MISSING");
  assert.match(message(response), /listing fee is required/);
  assert.equal(h.registry.offers.size, 0, "no offer may be stored without a fee");
  assert.equal(h.ledger.size, 0, "a refusal may not consume a transaction");
});

test("rule 1: a bid without a fee is refused and stores nothing", () => {
  const h = harness();
  const response = postBid(h, undefined);

  assert.equal(response.status, 402);
  assert.equal(code(response), "FEE_MISSING");
  assert.match(message(response), /bid fee is required/);
  assert.equal(h.registry.bids.get(JOB_ID)?.length, 0, "no bid may be stored without a fee");
  assert.equal(h.ledger.size, 0);
});

test("rule 2: a fee with the wrong amount is refused, short and excess alike", () => {
  const short = validProof("listing");
  short.amount = LISTING_FEE - 1n;
  const h1 = harness();
  const shortResponse = postOffer(h1, short);

  assert.equal(shortResponse.status, 402);
  assert.equal(code(shortResponse), "FEE_AMOUNT_SHORT");
  assert.match(message(shortResponse), /24\.999999 KOG is below the 25\.000000 KOG listing fee/);
  assert.equal(h1.registry.offers.size, 0);

  const excess = validProof("listing");
  excess.amount = LISTING_FEE + 1n;
  const h2 = harness();
  const excessResponse = postOffer(h2, excess);

  assert.equal(excessResponse.status, 402);
  assert.equal(code(excessResponse), "FEE_AMOUNT_EXCESS");
  assert.equal(h2.registry.offers.size, 0);

  // The bid price is different from the listing price, so the same shortfall bites there too.
  const shortBid = validProof("bid");
  shortBid.amount = BID_FEE / 2n;
  const h3 = harness();
  const bidResponse = postBid(h3, shortBid);

  assert.equal(code(bidResponse), "FEE_AMOUNT_SHORT");
  assert.equal(h3.registry.bids.get(JOB_ID)?.length, 0);
});

test("rule 3: a fee paid to the wrong recipient is refused", () => {
  const h = harness();
  const proof = validProof("listing");
  proof.recipient = "0xattacker";

  const response = postOffer(h, proof);

  assert.equal(response.status, 402);
  assert.equal(code(response), "FEE_WRONG_RECIPIENT");
  assert.match(message(response), /expected kog-treasury/);
  assert.equal(h.registry.offers.size, 0);
  assert.equal(h.ledger.size, 0);
});

test("rule 3: a fee paid in the wrong token is refused", () => {
  const h = harness();
  const proof = validProof("listing");
  proof.token = "USDC";

  const response = postOffer(h, proof);

  assert.equal(response.status, 402);
  assert.equal(code(response), "FEE_WRONG_TOKEN");
  assert.match(message(response), /expected KOG/);
  assert.equal(h.registry.offers.size, 0);
  assert.equal(h.ledger.size, 0);
});

test("rule 4: a fee transaction that was already spent is refused", () => {
  const h = harness();
  const proof = validProof("listing");
  const first = postOffer(h, proof);
  assert.equal(first.status, 201);

  // A fresh transaction with the same hash is a replay, even if every field is rewritten.
  const replay = { ...proof, amount: LISTING_FEE, from: "0xsomeone-else" };
  const second = postOffer(h, replay);

  assert.equal(second.status, 402);
  assert.equal(code(second), "FEE_TX_CONSUMED");
  assert.match(message(second), /already used/);
  assert.equal(h.registry.offers.size, 1, "a replay may not create a second listing");
  assert.equal(h.ledger.size, 1);
});

test("rule 4: a listing fee cannot be reused to pay for a bid", () => {
  const h = harness();
  const proof = validProof("listing");
  assert.equal(postOffer(h, proof).status, 201);

  const borrowed = { ...proof, purpose: "bid" as const, amount: BID_FEE };
  const bidResponse = postBid(h, borrowed);

  assert.equal(bidResponse.status, 402);
  assert.equal(code(bidResponse), "FEE_TX_CONSUMED");
  assert.equal(h.registry.bids.get(JOB_ID)?.length, 0);
});

test("rule 5: a valid fee is accepted once and refused on reuse", () => {
  const h = harness();
  const proof = validProof("listing");

  const accepted = postOffer(h, proof);
  assert.equal(accepted.status, 201);
  assert.equal(h.registry.offers.size, 1);
  assert.equal(h.ledger.size, 1);

  const stored = [...h.registry.offers.values()][0];
  assert.equal(stored?.feeTx, proof.txHash, "the stored offer must record the fee that paid for it");
  assert.equal(h.ledger.isUnspent(proof.txHash), false);

  // Byte identical proof, second time: the ledger read and write happen in one turn.
  const reused = postOffer(h, proof);
  assert.equal(reused.status, 402);
  assert.equal(code(reused), "FEE_TX_CONSUMED");
  assert.equal(h.registry.offers.size, 1, "the reuse must not create a second listing");
  assert.equal(h.ledger.size, 1, "the ledger must keep exactly one entry per transaction");
});

test("rule 6: a bid with a valid fee is accepted once and refused on reuse", () => {
  const h = harness();
  const proof = validProof("bid");

  const accepted = postBid(h, proof);
  assert.equal(accepted.status, 201);
  assert.equal(h.registry.bids.get(JOB_ID)?.length, 1);

  const stored = h.registry.bids.get(JOB_ID)?.[0];
  assert.equal(stored?.feeTx, proof.txHash);
  assert.equal(stored?.settlement, "x402-base");

  const reused = postBid(h, proof);
  assert.equal(reused.status, 402);
  assert.equal(code(reused), "FEE_TX_CONSUMED");
  assert.equal(h.registry.bids.get(JOB_ID)?.length, 1);
});

test("invariant: a body rejected before the gate never consumes the fee", () => {
  const h = harness();
  const proof = validProof("bid");
  const overCeiling = { ...bidBody, priceUsdc: "31" };

  const response = h.registry.handle({
    method: "POST",
    path: `/jobs/${JOB_ID}/bids`,
    body: overCeiling,
    fee: proof,
  });

  assert.equal(response.status, 400);
  assert.match(String((response.body.errors as string[])[0]), /above the ceiling/);
  assert.equal(h.ledger.size, 0, "validation must run before settlement");

  // The untouched transaction still buys a valid bid.
  assert.equal(postBid(h, proof).status, 201);
});

test("the fee schedule renders with Latin digits and six decimals", () => {
  assert.equal(formatKog(25_000_000n), "25.000000");
  assert.equal(formatKog(1n), "0.000001");
});
