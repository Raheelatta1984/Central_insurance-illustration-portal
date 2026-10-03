# 06 — QA report

*Run `npm run verify` (typecheck → tests → build) for the current state. This report is updated as the fleet lands chunks; the numbers below are from the run recorded in `ledger/runs.jsonl`.*

## What is verified today

| Area | Evidence | Result |
| --- | --- | --- |
| Type safety | `npm run typecheck` over core, server and console | 0 errors |
| Money arithmetic | `src/core/money.test.ts` — rounding modes, basis-point percentages, currency conversion, a 200-iteration property check | pass |
| Double-entry ledger | `src/core/ledger.test.ts` — balancing, idempotency, reversal-only corrections, fund-boundary enforcement, cross-entity refusal, per-currency proof | pass |
| NAV and dealing rules | `src/core/fund.test.ts` — cut-off resolution (before/after/non-business day), floor pricing with explicit residual, revision history, staleness, look-through, Shariah composition warnings, FMC accrual | pass |
| Unit-linked engine | `src/core/unitlinked.test.ts` — allocation, unit-cancelling charges, atomic switch with one instruction id, partial withdrawal, surrender schedule, reproducibility from the log, no negative units | pass |
| Micro-duration cover | `src/core/billing.test.ts` — no charge before an explicit start, no self-restart after a stop, elected daily renewal, tick idempotency, scheduled start/stop with cancellation, PAYG rating, suspension instead of negative wallet, pro-rata refund | pass |
| Takaful | `src/core/takaful.test.ts` — contribution routing, claim from the risk fund, qard issuance on deficit, three approval gates, valuation/audit gates, jurisdiction restriction, distribution once only | pass |
| Parties and consent | `src/core/party.test.ts` — deterministic match scoring, merge without data loss, disclosure strictly within consented scopes, revocation and expiry, refusal logging | pass |
| Ingestion | `src/core/ingest.test.ts` — delimiter detection, majority schema inference, per-row quarantine with reasons, idempotent submit and commit, natural-key duplicate suppression, reconciliation anomalies | pass |
| Regulatory packs | `src/core/regulatory.test.ts` — motor survey and comparison gates, health need-analysis block, consent requirement, non-resident exception flag, UAE vs Malaysia takaful differences, explained comparison ranking | pass |
| Labels and renaming | `src/core/regulatory.test.ts` — per-scope renaming, Arabic fallback chain, coverage reporting, export | pass |
| Onboarding | `src/core/regulatory.test.ts` — chip read, government lookup, OCR consensus with review queue, transliteration that never invents a name, gating before product suggestion | pass |
| Durability | `src/core/persistence.test.ts` — bigint/Date/Map/Set codec, byte-stability under key-order changes, fingerprint determinism and tamper detection, codec-version refusal, schema migration planning and application, ledger snapshot/restore round trip, restore refuses unbalanced books and reused journal ids | pass |
| **Money proof** | `src/core/moneyproof.test.ts` — a simulated book of 40 policies over five valuation days: books balance, every policy reproduces from its transaction log, fund units equal the sum of holdings, a fresh valuation reconciles (units × price + residual = NAV), policy value agrees on independent recomputation, no negative units, charge income ties to the transaction log | pass |
| Two engines, one ledger | `src/core/moneyproof.test.ts` — unit-linked and takaful journals on a shared ledger stay distinct and both books balance | pass |

## Bugs this QA found and fixed (kept here on purpose)

0. **An id could be re-used for a quietly different journal.** `Ledger.post` treated an id as a retry when entity, source and postings matched, so a second journal with the same postings but a different timestamp, reference or description was swallowed as a duplicate — money-safe today, but it would have hidden a real duplicate-key bug. The identity check now covers entity, source, source reference, economic time, fund, reversal link, description and postings; the restore path double-checks the journal count so a collapsed journal cannot pass. Test: `persistence.test.ts` ("keeps the id-collision guard on restore").

1. **Journal id collision silently dropped money.** The unit-linked engine and the takaful engine each numbered journals from 1, so on a shared ledger the takaful entries reused ids the unit-linked engine had already posted, and the ledger's idempotency rule discarded them. Symptom: a takaful contribution reduced to a single cash movement — the tabarru, investment and operator legs vanished. Fix: ids are prefixed per module (`UL-…`, `TKF-…`) **and** `Ledger.post` now refuses an id reused for different content instead of silently returning the old entry. Regression tests: `ledger.test.ts` ("the silent-loss trap") and the "two engines, one ledger" money-proof case.
2. **Fractional basis points truncated to zero** in daily accruals (150 bps / 365 became 0 bps). `applyBps` now works to micro-basis-point precision.
3. **`nextBusinessDay` returned the same day** when the date given was already a business day, which made after-cut-off instructions price on the wrong day. Now strictly after, with the weekend-skip case asserted.
4. **Amount parsing rounded against the customer** for fractional digits beyond the currency scale (`1,234.567` became `1,234.13`). Now the beyond-scale digits round half-up as a whole.
5. **Fund amounts double-typed** (minor units vs micro-units) caught by tests before it reached the console — the unit conventions are now documented in `src/core/units.ts` and asserted.

## What is deliberately not covered yet

- Persistence: the domain runs in memory; Postgres schemas, migrations and the outbox are Phase 0/1 backlog chunks (open, and honestly reported as open by `tools/fleet.mjs`).
- Claims, reinsurance, underwriting, group consolidation and the warehouse are designed and backlogged, not yet implemented.
- Country packs beyond AE and MY; locales beyond en/ar.
- Load and performance testing at book scale (the money proof runs 40 policies; a 10,000-policy run is a Phase 1 gate).

## How the fleet proves its own claims

`node tools/fleet.mjs` claims a backlog chunk only when (a) its module is implemented, (b) its capability text matches something actually built, and (c) the evidence files exist and the module's test file passes. Everything else stays open — currently **972 chunks done, 898 still open** on the critical path alone (1,870 chunks). The ledger at `ledger/runs.jsonl` records every claimed chunk with its evidence and simulated cost, one row per chunk, and `backlog/status.jsonl` is the machine-readable state.
