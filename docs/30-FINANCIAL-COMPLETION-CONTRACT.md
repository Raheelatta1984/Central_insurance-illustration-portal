# 30 — Financial completion contract (PR #46 / issue #47)

## Status and authority

This is the implementation contract for the unfinished financial work merged in PR #46.
Merge status is not evidence of completion. The designated human approver is **Raheel Atta
(GitHub: Raheelatta1984), administrator/configurator**, following the owner's instruction in
this task. Designation is not a signature on an unseen diff or on a charge rate. Release
approval must reference the tested commit and independent verification report.

Issue #47 was inspected, including its timeline: it contains a request, not approved values,
approval provenance, or legacy source records. Existing illustrative rates may be used only in
an explicitly identified demo/test fixture. They are never a live fallback or an approval.

## Boundary and alternatives

The existing console is an in-memory demonstration. Adding a durable key map to that world
would not make its policies, units or books durable. Reusing the simulated batch voucher counter
as a posting engine would compound the original defect. Instead:

1. Demo mutations are atomic, idempotent at the HTTP boundary, and explicitly simulated.
2. A separate PostgreSQL-backed financial book owns live policy state, holdings, receipts,
   immutable transactions/journals, approved rule versions, configuration requests, cycle
   completions, servicing records and provider-token references.
3. Authenticated legacy demo mutation routes are closed. The supported financial API uses the
   durable book; it cannot fall back to the demo world when storage is unavailable.
4. No public endpoint accepts a charge override, an approval identity, a simulated voucher, a raw
   PAN/CVV, or a process-local fingerprint as a provider token.

A single aggregate row is locked with `SELECT … FOR UPDATE` for each command. This deliberately
serializes financial writers across processes; it is not a distributed-lock approximation. The
state envelope and command result commit in the same SQL transaction. Unique command scope and
request fingerprint give durable replay/conflict detection. A lost connection destroys the pool
connection. An uncertain commit is resolved by replay, never by issuing a new operation.
The aggregate model is suited to a bounded initial book, not an unbounded retail transaction
volume; partitioning/normalization and load qualification remain deployment work.

## Invariants

- Money is integer minor units with explicit currency; units and NAV use the existing six-decimal
  integer representation. Allocation rounds units down and journals the exact residual. Unit
  cancellation rounds up and records the actual realised value, not a smaller requested amount.
- A command changes policy state, holdings, receipts, transactions, journals, alterations and
  cycle markers together or not at all. Every journal balances by currency. No holding is negative.
- Holdings equal the unit transaction log; receipts equal inflow transactions; policy premiums
  equal receipts; posted cycle markers reference their transactions. Reconciliation is read-only
  and reports discrepancies rather than repairing them silently.
- A retry with the same principal, operation and key returns the original result. Reusing that key
  for different input is refused. Keys do not expire from a bounded process cache.
- Rule versions are effective-dated and carry source/approval provenance. Exact category, product,
  channel, sub-channel and partner scope wins; only an explicit global fallback follows. Unknown
  distribution is not `NA`. Ambiguity, missing evidence and missing configuration block money.
- Missing configuration creates one durable open P1 request per distinct scope/kind, with a
  suggested structure and **null rate/basis**. Retries do not duplicate it. Filing a request is not
  approving it. Approval is a separate authenticated role and cannot be self-approval.
- Monthly cycles use the policy's IANA timezone and original commencement day, clamped per month.
  Catch-up enumerates missed due cycles; `(policy, cycle, rule kind)` is unique. A blocked cycle is
  retryable after configuration; a posted cycle is not processed again. Premium allocation requires
  verified cash evidence: the scheduler never invents a collected premium or bank debit.
- New policy IDs are `CATEGORY-CHANNEL-SUBCHANNEL-PARTNER-SEQUENCE`, with literal `NA` only for a
  recorded not-applicable dimension. Sequences are allocated under the same durable lock. Existing
  IDs are never rewritten. Backfill requires an exact existing policy/source link and a source
  digest; conflicting or missing evidence is flagged, not guessed.
- Statements reconcile selected funds and inception-to-current unit history. Missing NAV dates are
  unavailable, not zero. A recommendation must be a separately recorded artifact; equality with a
  customer selection is not a recommendation. Distinct recorded recommendations display for five
  seconds per activation and then hide.
- Round-up live settings require a provider-issued token and mandate/consent references verified by
  a configured provider adapter. A local HMAC of a PAN is demo duplicate detection only. Provider
  collection events require authenticated, replay-protected verification before investment.

## Required release evidence

Automated checks include injected failures at every financial leg, rollback, concurrent writers,
restart/replay, request-key conflicts, month-end/leap-year/missed cycles, rule precedence/effective
dates, P1 deduplication, source-conflict backfill, statement/recommendation timing, authorization,
provider-token refusal and financial reconciliation. Native PostgreSQL and embedded PostgreSQL
tests are distinct evidence. CI results, the independent verifier and the named human's approval
of the exact commit must be linked in the PR before merge. Live deployment additionally requires
approved rules, migrated verified source data, a provider adapter/credentials, backup/restore and
operational scheduler qualification. Absence of any of these is reported as incomplete.

## Implementation status (this branch)

Delivered and locally exercised:

- Demo HTTP financial mutations require `Idempotency-Key`; the demo dispatcher wraps the listed
  financial mutation routes in an order-preserving snapshot/restore transaction and replays the
  original HTTP result through the server key map. Direct engine calls remain unwrapped.
- Authenticated legacy financial mutation routes are refused unless `PORTAL_ALLOW_DEMO=1` is
  explicit. `/finance/*` requires the durable service, authentication and a principal; storage or
  configuration failure returns 503 and never selects the demo world.
- PostgreSQL financial book: singleton locked aggregate, append-only command receipts, checksummed
  explicit migrations, empty-book initialization, integrity/reconciliation pre-checks, replay and
  key-conflict detection, and pre-commit failure rollback. PGlite tests pass; native PostgreSQL is
  exercised by the `financial-postgres` CI job, including the migration/init CLIs.
- Financial service: role gates, provider/source pre-checks before evidence parsing, verified cash
  before allocation, scoped/effective-dated rule resolution, durable P1 configuration requests,
  second-person approval (self-approval refused), monthly catch-up scheduler with versioned keys,
  read-only statements/reconciliation/configuration views, and round-up provider-token gates.
- Policy distribution validation/evidence helpers and structured new policy IDs; existing IDs are
  preserved. Batch output is explicitly `simulated-posted` with `voucherRef:null` and a simulation
  reference. Recorded recommendations are separate artifacts and display for 5000 ms in the UI.

Evidence: `reports/FIN-COMPLETION-0001/verification.md`, `src/core/financial/book.test.ts`,
`src/server/financial/postgres.test.ts`, `src/server/financial/service.test.ts`,
`src/core/demo-transaction.test.ts`, `src/core/policy-distribution.test.ts`,
`src/core/unitlinked-statement.test.ts`, `src/server/main.test.ts`, `.github/workflows/ci.yml`.

Configuration / source / provider work continuing under the owner's live-operations authorization:

- Issue #47 contains no authorized charge rates, approval provenance or authoritative legacy
  distribution records. Demo fixtures are synthetic and labelled; no live fallback was invented.
- Environment-configured `paymentVerifier`, `cardProvider` and distribution `sourceReader` adapters
  are shipped and wired into the runtime (`docs/31-RENDER-LIVE-OPERATIONS.md`). Live payments,
  round-up collection and backfill use them when their Render environment URLs/credentials are set;
  unset adapters still fail closed with 503 and never fall back to demo data.
- Authenticated mode has no durable equivalent of `/journey/submit`; it is blocked rather than
  silently using the demo world.
- Native PostgreSQL CLI/migration evidence passed in the `financial-postgres` CI job on PR #48; no local PostgreSQL server was available.
- Owner merge approval and a verifier-role re-run are recorded on PR #48. The owner has since
  authorized live financial operations and directed the work to continue through configuration,
  source and provider wiring on Render. The Render blueprint, idempotent bootstrap and
  environment-configured adapters are specified in `docs/31-RENDER-LIVE-OPERATIONS.md`.
- Known non-blocking debt: aggregate-row serialization is not load-qualified; PGlite harness is
  single-instance/serialized; the tamper test intentionally leaves its fixture corrupt; Vite bundle
  size warning remains; some batch strings are not yet label-registry keys; hyphenated distribution
  ID components are validated but parsing remains component-order based.
