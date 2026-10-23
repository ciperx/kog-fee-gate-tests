/**
 * Types for the KOG fee gate that sits in front of the LAX registry write routes:
 * POST /offers (a listing) and POST /jobs/<id>/bids (a bid).
 */

export type FeePurpose = "listing" | "bid";

/** KOG is a token with 6 decimals, so amounts are integer micro units. */
export type MicroKog = bigint;

export interface FeeTerms {
  /** Exact amount due, in KOG micro units. */
  readonly amount: MicroKog;
  /** The only token that settles the fee. */
  readonly token: string;
  /** The only address that may receive the fee. */
  readonly recipient: string;
  /** The only chain the fee may settle on. */
  readonly chainId: number;
  /** Which write the fee buys. A fee cannot change purpose after it is paid. */
  readonly purpose: FeePurpose;
}

/**
 * What a caller presents as proof of payment. A real deployment would derive this from
 * the chain; here it is the set of facts the gate is allowed to trust, which is exactly
 * what the tests need to vary one field at a time.
 */
export interface FeeProof {
  txHash: string;
  from: string;
  recipient: string;
  token: string;
  amount: MicroKog;
  chainId: number;
  purpose: FeePurpose;
}

export type RefusalCode =
  | "FEE_MISSING"
  | "FEE_MALFORMED"
  | "FEE_WRONG_CHAIN"
  | "FEE_WRONG_TOKEN"
  | "FEE_WRONG_RECIPIENT"
  | "FEE_AMOUNT_SHORT"
  | "FEE_AMOUNT_EXCESS"
  | "FEE_TX_CONSUMED";

export interface Refusal {
  readonly ok: false;
  /** 402 is the x402 style payment refusal; 400 is a malformed body. */
  readonly status: 400 | 402;
  readonly code: RefusalCode;
  readonly message: string;
}

export interface FeeAccepted {
  readonly ok: true;
  readonly proof: FeeProof;
}

export type FeeVerdict = FeeAccepted | Refusal;

export interface OfferBody {
  readonly agentDid: string;
  readonly capability: string;
  readonly priceUsdc: string;
}

export interface BidBody {
  readonly agentDid: string;
  readonly priceUsdc: string;
  readonly deliveryDate: string;
  readonly approach: string;
  readonly settlement: "x402-solana" | "x402-base";
}

export interface StoredOffer extends OfferBody {
  readonly id: string;
  readonly feeTx: string;
  readonly createdAt: string;
}

export interface StoredBid extends BidBody {
  readonly id: string;
  readonly jobId: string;
  readonly feeTx: string;
  readonly createdAt: string;
}

export interface Job {
  readonly id: string;
  readonly ceilingUsdc: string;
  readonly open: boolean;
}

export interface RegistryResponse {
  readonly status: number;
  readonly body: Readonly<Record<string, unknown>>;
}

export interface RegistryRequest {
  readonly method: "POST";
  readonly path: string;
  readonly body: unknown;
  /** Raw fee proof, or undefined when the caller presented none. */
  readonly fee?: unknown;
}
