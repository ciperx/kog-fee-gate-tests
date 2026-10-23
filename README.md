# kog-fee-gate-tests

Rule named tests for the KOG fee gate on the LAX registry write routes, plus the small
reference implementation they drive.

```
POST /offers            pay the listing fee, then the offer is stored
POST /jobs/<id>/bids    pay the bid fee, then the bid is stored
```

`node:test` with `tsx`. No network, no chain, no database, no key. Node 20 or newer.

```bash
npm ci
npm test
npx tsc --noEmit
```

## Scope, stated plainly

The job spec says the registry handler and its in memory store are provided, and that a
selected agent never sees Kognai's repository. No harness and no `tests_url` were supplied
with this job, so **`src/` is a reference implementation of the fee gate and the handler,
written from the spec, not Kognai's production code**. These tests prove the behaviour of
that reference implementation. They are not tests against the live registry, and passing
them is not evidence that Kognai's own handler is correct.

The reference is deliberately thin so it can be swapped:

| file | role |
| --- | --- |
| `src/types.ts` | the fee proof, the fee terms, refusal codes, request and response shapes |
| `src/feeGate.ts` | `FeeGate.check` (pure) and `FeeGate.settle` (check and consume) |
| `src/ledger.ts` | `FeeLedger`, one synchronous check and set per transaction hash |
| `src/registry.ts` | `InMemoryRegistry`, body validation and the two routes |
| `test/feeGate.test.ts` | the suite |

Pointing the suite at a real handler means satisfying the same `handle(request)` shape and
the same response contract; the tests import nothing else.

## The rules, and the test that kills each one

Each case asserts the refusal code and a fragment of the refusal message, not a bare
boolean, so a gate that returns 402 for the wrong reason still fails.

| rule | case | expected |
| --- | --- | --- |
| 1. no listing without a fee | `rule 1: a listing without a fee is refused and stores nothing` | 402 `FEE_MISSING`, 0 offers, ledger untouched |
| 1. no bid without a fee | `rule 1: a bid without a fee is refused and stores nothing` | 402 `FEE_MISSING`, 0 bids |
| 2. exact amount | `rule 2: a fee with the wrong amount is refused, short and excess alike` | 402 `FEE_AMOUNT_SHORT` for one micro unit under, `FEE_AMOUNT_EXCESS` for one over |
| 3. right recipient | `rule 3: a fee paid to the wrong recipient is refused` | 402 `FEE_WRONG_RECIPIENT`, names the treasury |
| 3. right token | `rule 3: a fee paid in the wrong token is refused` | 402 `FEE_WRONG_TOKEN`, names KOG |
| 4. no replay | `rule 4: a fee transaction that was already spent is refused` | 402 `FEE_TX_CONSUMED`, still one offer |
| 4. no cross route reuse | `rule 4: a listing fee cannot be reused to pay for a bid` | 402 `FEE_TX_CONSUMED`, 0 bids |
| 5. accepted once | `rule 5: a valid fee is accepted once and refused on reuse` | 201 then 402 `FEE_TX_CONSUMED`, one offer, one ledger entry |
| 6. bids too | `rule 6: a bid with a valid fee is accepted once and refused on reuse` | 201 then 402, one bid |
| invariant | `invariant: a body rejected before the gate never consumes the fee` | 400 before settlement, the same tx then buys a valid bid |

11 cases, 11 passing.

## Why the gate is shaped this way

**Validate before charge.** Body validation and the job lookup run before `settle`, so a
400 or 404 never costs the caller a payment. The invariant case holds the ledger empty
after a rejected body and then spends the same transaction successfully.

**One synchronous check and set.** `FeeLedger.consume` reads and writes without an await
between them, so two requests carrying the same transaction cannot both see it unused. A
replay is refused, not raced.

**Refusals are typed.** Every refusal carries a `RefusalCode`, so a caller can tell a
short fee from a wrong recipient, and a reviewer can tell a real refusal from a generic
402.

**Amounts are integer micro units**, 6 decimals, rendered as plain decimal strings with
Latin digits.

## Mutation check

The suite was run against two deliberately broken gates:

- recipient comparison removed: 10 pass, 1 fail (rule 3 recipient)
- ledger consumption result ignored: 7 pass, 4 fail (rules 4, 5, 6)

Both mutations are caught by name, which is the property the reviewer's planted bug needs.

## What this does not cover

Signature verification of the payment, chain confirmation depth, reorg handling, the LAX
offer schema beyond the three fields used here, PACT and settlement. Those belong to the
registry and the rail, not to this gate.

## License

MIT.
