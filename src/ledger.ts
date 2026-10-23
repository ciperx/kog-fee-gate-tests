import type { FeePurpose } from "./types.js";

/**
 * The set of fee transactions that have already bought a write.
 *
 * Consumption is a single synchronous check and set. That is the whole replay defence:
 * there is no await between the read and the write, so two requests carrying the same
 * transaction cannot both observe it unused.
 */
export class FeeLedger {
  readonly #spent = new Map<string, { purpose: FeePurpose; at: string }>();

  /** True when the transaction has never bought a write. */
  isUnspent(txHash: string): boolean {
    return !this.#spent.has(txHash);
  }

  /**
   * Mark a transaction as spent for a purpose.
   * Returns false when it was already spent, and never overwrites the first record.
   */
  consume(txHash: string, purpose: FeePurpose, at: string): boolean {
    if (this.#spent.has(txHash)) return false;
    this.#spent.set(txHash, { purpose, at });
    return true;
  }

  /** Read only view, used by tests and by the audit trail. */
  entries(): ReadonlyArray<readonly [string, { purpose: FeePurpose; at: string }]> {
    return [...this.#spent.entries()];
  }

  get size(): number {
    return this.#spent.size;
  }
}

export const feeLedger = new FeeLedger();
