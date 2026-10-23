import { FeeGate } from "./feeGate.js";
import type {
  BidBody,
  Job,
  OfferBody,
  RegistryRequest,
  RegistryResponse,
  StoredBid,
  StoredOffer,
} from "./types.js";

/**
 * An in memory store plus a thin request handler for the two write routes. This is the
 * reference implementation the tests drive; it is not Kognai's production registry.
 */
export class InMemoryRegistry {
  readonly offers = new Map<string, StoredOffer>();
  readonly jobs = new Map<string, Job>();
  readonly bids = new Map<string, StoredBid[]>();
  readonly gate: FeeGate;

  constructor(gate: FeeGate = new FeeGate()) {
    this.gate = gate;
  }

  addJob(job: Job): void {
    this.jobs.set(job.id, job);
    if (!this.bids.has(job.id)) this.bids.set(job.id, []);
  }

  handle(request: RegistryRequest): RegistryResponse {
    if (request.method !== "POST") {
      return { status: 405, body: { error: "method_not_allowed" } };
    }
    if (request.path === "/offers") return this.postOffer(request.body, request.fee);

    const match = /^\/jobs\/([^/]+)\/bids$/.exec(request.path);
    if (match) return this.postBid(decodeURIComponent(match[1] as string), request.body, request.fee);

    return { status: 404, body: { error: "not_found", path: request.path } };
  }

  private postOffer(raw: unknown, fee: unknown): RegistryResponse {
    const errors = validateOffer(raw);
    if (errors.length > 0) {
      return { status: 400, body: { error: "invalid_body", errors } };
    }
    const verdict = this.gate.settle(fee, "listing");
    if (!verdict.ok) return paymentRequired(verdict.code, verdict.message, this.gate, "listing");

    const body = raw as OfferBody;
    const id = `offer_${this.offers.size + 1}`;
    const record: StoredOffer = {
      id,
      agentDid: body.agentDid,
      capability: body.capability,
      priceUsdc: body.priceUsdc,
      feeTx: verdict.proof.txHash,
      createdAt: new Date().toISOString(),
    };
    this.offers.set(id, record);
    return { status: 201, body: { offer: record } };
  }

  private postBid(jobId: string, raw: unknown, fee: unknown): RegistryResponse {
    const job = this.jobs.get(jobId);
    if (!job) return { status: 404, body: { error: "not_found", jobId } };
    if (!job.open) return { status: 409, body: { error: "job_closed", jobId } };

    const errors = validateBid(raw, job);
    if (errors.length > 0) {
      return { status: 400, body: { error: "invalid_body", errors } };
    }
    const verdict = this.gate.settle(fee, "bid");
    if (!verdict.ok) return paymentRequired(verdict.code, verdict.message, this.gate, "bid");

    const body = raw as BidBody;
    const list = this.bids.get(jobId) as StoredBid[];
    const record: StoredBid = {
      id: `bid_${list.length + 1}`,
      jobId,
      agentDid: body.agentDid,
      priceUsdc: body.priceUsdc,
      deliveryDate: body.deliveryDate,
      approach: body.approach,
      settlement: body.settlement,
      feeTx: verdict.proof.txHash,
      createdAt: new Date().toISOString(),
    };
    list.push(record);
    return { status: 201, body: { bid: record } };
  }
}

function paymentRequired(
  code: string,
  message: string,
  gate: FeeGate,
  purpose: "listing" | "bid",
): RegistryResponse {
  const terms = gate.terms(purpose);
  return {
    status: 402,
    body: {
      error: "payment_required",
      code,
      message,
      accepts: {
        scheme: "exact",
        token: terms.token,
        amount: terms.amount.toString(),
        recipient: terms.recipient,
        chainId: terms.chainId,
      },
    },
  };
}

function nonEmpty(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function positiveDecimal(value: unknown): value is string {
  return typeof value === "string" && /^[0-9]+(\.[0-9]+)?$/.test(value) && Number(value) > 0;
}

export function validateOffer(raw: unknown): string[] {
  if (typeof raw !== "object" || raw === null) return ["body must be an object"];
  const body = raw as Record<string, unknown>;
  const errors: string[] = [];
  if (!nonEmpty(body.agentDid)) errors.push("agentDid is required");
  if (!nonEmpty(body.capability)) errors.push("capability is required");
  if (!positiveDecimal(body.priceUsdc)) errors.push("priceUsdc must be a positive decimal string");
  return errors;
}

export function validateBid(raw: unknown, job: Job): string[] {
  if (typeof raw !== "object" || raw === null) return ["body must be an object"];
  const body = raw as Record<string, unknown>;
  const errors: string[] = [];
  if (!nonEmpty(body.agentDid)) errors.push("agentDid is required");
  if (!positiveDecimal(body.priceUsdc)) {
    errors.push("priceUsdc must be a positive decimal string");
  } else if (Number(body.priceUsdc) > Number(job.ceilingUsdc)) {
    errors.push(`priceUsdc ${body.priceUsdc} is above the ceiling ${job.ceilingUsdc}`);
  }
  if (!nonEmpty(body.deliveryDate) || Number.isNaN(Date.parse(body.deliveryDate))) {
    errors.push("deliveryDate must be an ISO date");
  }
  if (!nonEmpty(body.approach) || body.approach.trim().length < 20) {
    errors.push("approach must be at least 20 characters");
  }
  if (body.settlement !== "x402-solana" && body.settlement !== "x402-base") {
    errors.push("settlement must be x402-solana or x402-base");
  }
  return errors;
}
