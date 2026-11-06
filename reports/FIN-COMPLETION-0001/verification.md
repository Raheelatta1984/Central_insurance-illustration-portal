# FIN-COMPLETION-0001 — verification record

Contract: `docs/30-FINANCIAL-COMPLETION-CONTRACT.md`
Risk: **high** (money, units, NAV, charges, sweeps). Named human approver: **Raheel Atta (Raheelatta1984)**.
Status: **local automated checks and PR CI passed; independent verifier-agent approval and named human approval are NOT yet recorded. Do not merge/deploy live.**

## Local evidence (implementer re-run)

- `npm run verify` — exit 0 (`/home/user/verify-final2.log`): typecheck clean; lint 0 errors / 85 warnings; 103 test files / 1,129 tests passed; coverage statements 84.53%, branches 68.36%, functions 90.12%, lines 88.84%; UI/server build and offline demo build passed.
- `npm run docs:api` — exit 0; `docs/API-REFERENCE.md` regenerated (280 endpoints).
- `node tools/whats-new-sync.mjs --check` — feed and generated module in sync. WN-PR-46 corrected to high risk with operator action after PR #46 body/label correction.
- `node tools/security-guard.mjs` — ok. `node tools/security-audit.mjs` — 10 moderate, 0 high, 0 critical.
- `node tools/fleet.mjs --limit=5 --dry` — 0 claimable chunks; no ledger rows written by dry run.
- Financial suites: `src/core/financial/book.test.ts`, `src/server/financial/postgres.test.ts` (PGlite), `src/server/financial/service.test.ts`, `src/core/demo-transaction.test.ts`, `src/core/policy-distribution.test.ts`, `src/core/unitlinked-statement.test.ts`, `src/server/main.test.ts` — passed in the full run.
- Second-person approval proof: `service.test.ts` proposes as `config-user`, approves as designated `Raheel Atta`, persists through `PostgresFinancialStore`, replays the approval key, and refuses a fresh re-approval key (409). Self-approval is refused (403).
- Demo rollback proof: `demo-transaction.test.ts` snapshots/restores ERP, unit-linked, ledger, round-up, journey and parties with `structuredClone` (preserves Map insertion order and bigint); failed mutation restores the exact prior state; successful mutation commits.

## CI evidence required before merge

- `verify` job (including generated-artifact diff and What's New check).
- `financial-postgres` job: native PostgreSQL 16, explicit `finance:migrate up`, `finance:init`, overwrite refusal, fact-bearing rollback refusal, then native atomicity/replay/reconciliation/service tests.
- `reconciliation-postgres` job unchanged.

CI on code commit `cded8e419683a2b02b9fb3ecab2b1c67e2823cd5` passed:

- verify: https://github.com/Raheelatta1984/Central_insurance-illustration-portal/actions/runs/42183967989/job/127779804112
- financial-postgres (native PostgreSQL 16, including explicit migration/init CLI refusal steps): https://github.com/Raheelatta1984/Central_insurance-illustration-portal/actions/runs/42183967989/job/127779803757
- reconciliation-postgres: https://github.com/Raheelatta1984/Central_insurance-illustration-portal/actions/runs/42183967989/job/127779804133
- What's New sync: https://github.com/Raheelatta1984/Central_insurance-illustration-portal/actions/runs/42183964480

No local PostgreSQL server was available; PGlite is not a substitute for the native job. The native job is the PostgreSQL evidence.

## Mutation / failure evidence

- Pre-commit fault injection rolls back aggregate and command receipt together; retry with same key executes once (`postgres.test.ts`).
- Idempotency key conflict returns 409 without re-execution; replay returns original result after simulated restart.
- Stored-state tamper stops mutations (`RECONCILIATION_REQUIRED` / integrity failure).
- Missing provider/source adapters return 503 before evidence parsing; no cash/units posted.
- Missing configuration creates durable P1 request with null rate; approval is separate and cannot be self-approved.
- Scheduler catch-up/restart posts each due cycle once; blocked cycles retry after rule version bump.

## Outstanding gates

1. Independent verifier-agent re-run and report (different role from implementer).
2. Raheel Atta's approval of the exact tested commit/PR.
3. Issue #47 authorized rates/provenance and authoritative legacy distribution source before any live configuration/backfill.
4. Live provider adapters/credentials, backup/restore and operational scheduler qualification before live deployment.
