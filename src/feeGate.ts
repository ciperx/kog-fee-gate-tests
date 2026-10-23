import { FeeLedger } from "./ledger.js";
import type {
  FeeAccepted,
  FeeProof,
  FeePurpose,
  FeeTerms,
  FeeVerdict,
  MicroKog,
  Refusal,
  RefusalCode,
} from "./types.js";

export interface FeeGateConfig {
  readonly listing: FeeTerms;
  readonly bid: FeeTerms;
}

/**
 * Reference fee schedule. The amounts, token id and treasury address are configuration,
 * not protocol truth: a deployment reads them from its own environment. They are fixed
 * here so the tests can prove an exact amount, a token and a recipient are enforced.
 */
export const DEFAULT_FEE_CONFIG: FeeGateConfig = {
  listing: {
    amount: 25_000_000n,
    token: "KOG",
    recipient: "kog-treasury",
    chainId: 8453,
    purpose: "listing",
  },
  bid: {
    amount: 5_000_000n,
    token: "KOG",
    recipient: "kog-treasury",
    chainId: 8453,
    purpose: "bid",
  },
};

const DECIMALS = 6n;

/** Render micro KOG as a plain decimal string with Latin digits. */
export function formatKog(amount: MicroKog): string {
  const whole = amount / 10n ** DECIMALS;
  const fraction = (amount % 10n ** DECIMALS).toString().padStart(Number(DECIMALS), "0");
  return `${whole}.${fraction}`;
}

function refuse(code: RefusalCode, message: string): Refusal {
  return { ok: false, status: 402, code, message };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function toAmount(value: unknown): MicroKog | null {
  if (typeof value === "bigint") return value >= 0n ? value : null;
  if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0) return BigInt(value);
  if (typeof value === "string" && /^[0-9]+$/.test(value)) return BigInt(value);
  return null;
}

function parseProof(raw: unknown, purpose: FeePurpose): FeeAccepted | Refusal {
  if (raw === undefined || raw === null) {
    return refuse("FEE_MISSING", `a ${purpose} fee is required`);
  }
  if (!isRecord(raw)) {
    return refuse("FEE_MALFORMED", "fee proof must be an object");
  }
  const amount = toAmount(raw.amount);
  if (
    typeof raw.txHash !== "string" ||
    raw.txHash.trim() === "" ||
    typeof raw.from !== "string" ||
    typeof raw.recipient !== "string" ||
    typeof raw.token !== "string" ||
    typeof raw.chainId !== "number" ||
    amount === null
  ) {
    return refuse("FEE_MALFORMED", "fee proof needs txHash, from, recipient, token, amount and chainId");
  }
  const claimed = raw.purpose;
  if (claimed !== undefined && claimed !== purpose) {
    return refuse("FEE_MALFORMED", `fee was paid for a ${String(claimed)}, not a ${purpose}`);
  }
  return {
    ok: true,
    proof: {
      txHash: raw.txHash,
      from: raw.from,
      recipient: raw.recipient,
      token: raw.token,
      amount,
      chainId: raw.chainId,
      purpose,
    },
  };
}

/**
 * A fee gate bound to one ledger. `check` is pure and `settle` is check plus consume, so
 * a request can be validated before anything is charged and a replay cannot slip between
 * the two steps.
 */
export class FeeGate {
  readonly #config: FeeGateConfig;
  readonly #ledger: FeeLedger;
  readonly #now: () => string;

  constructor(config: FeeGateConfig = DEFAULT_FEE_CONFIG, ledger: FeeLedger = new FeeLedger(), now: () => string = () => new Date().toISOString()) {
    this.#config = config;
    this.#ledger = ledger;
    this.#now = now;
  }

  get ledger(): FeeLedger {
    return this.#ledger;
  }

  terms(purpose: FeePurpose): FeeTerms {
    return purpose === "listing" ? this.#config.listing : this.#config.bid;
  }

  /** Validate a proof without spending it. Returns the first rule that refuses. */
  check(raw: unknown, purpose: FeePurpose): FeeVerdict {
    const parsed = parseProof(raw, purpose);
    if (!parsed.ok) return parsed;

    const proof = parsed.proof;
    const terms = this.terms(purpose);

    if (proof.chainId !== terms.chainId) {
      return refuse("FEE_WRONG_CHAIN", `fee was paid on chain ${proof.chainId}, expected ${terms.chainId}`);
    }
    if (proof.token !== terms.token) {
      return refuse("FEE_WRONG_TOKEN", `fee was paid in ${proof.token}, expected ${terms.token}`);
    }
    if (proof.recipient !== terms.recipient) {
      return refuse(
        "FEE_WRONG_RECIPIENT",
        `fee was paid to ${proof.recipient}, expected ${terms.recipient}`,
      );
    }
    if (proof.amount < terms.amount) {
      return refuse(
        "FEE_AMOUNT_SHORT",
        `fee ${formatKog(proof.amount)} KOG is below the ${formatKog(terms.amount)} KOG ${purpose} fee`,
      );
    }
    if (proof.amount > terms.amount) {
      return refuse(
        "FEE_AMOUNT_EXCESS",
        `fee ${formatKog(proof.amount)} KOG exceeds the exact ${formatKog(terms.amount)} KOG ${purpose} fee`,
      );
    }
    if (!this.#ledger.isUnspent(proof.txHash)) {
      return refuse("FEE_TX_CONSUMED", `fee transaction ${proof.txHash} was already used`);
    }
    return { ok: true, proof };
  }

  /**
   * Validate and then consume the transaction. A concurrent duplicate loses here: the
   * ledger read and write are in the same synchronous turn.
   */
  settle(raw: unknown, purpose: FeePurpose): FeeVerdict {
    const verdict = this.check(raw, purpose);
    if (!verdict.ok) return verdict;
    if (!this.#ledger.consume(verdict.proof.txHash, purpose, this.#now())) {
      return refuse("FEE_TX_CONSUMED", `fee transaction ${verdict.proof.txHash} was already used`);
    }
    return verdict;
  }
}
