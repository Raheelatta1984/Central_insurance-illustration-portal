# 26 — Reconciliation foundation contract (non-financial slice)

**Implementation scope:** an isolated, disabled-by-default foundation; **not approved for production use**. The requester has confirmed ownership of ReconIQ and authorized reuse for this project. Free-look, earning, commission, clawback, approval and AP business rules remain unprovided; this slice must not calculate entitlement, payables or payments.

The existing [ADR](23-PARTNER-COMMISSION-RECONCILIATION.md) governs the intended architecture. This contract permits only the reversible, non-financial groundwork described here. It does not approve an IdP, a production database role, a partner hierarchy transfer, an external file, a statement or any payment.

## Boundary

- The application has **no new HTTP routes, UI, upload endpoints or externally callable reconciliation workflow** in this slice. The feature flag is closed by default and remains unavailable even when requested until the release gates are implemented. Existing prototype routes are unchanged and are not claimed to be tenant-secure production routes.
- Database migration adds only tenant/configuration and *ownership metadata* for future policy, source-file, run, statement and payment-instruction records. It does not store a file, calculate a statement, create a payment instruction or mark anything paid. Each row's owner is constrained to the same insurer and root partner.
- The read repository requires a **server-verified**, transaction-bound subject and insurer. There is no identity provider in this slice: only a trusted caller may construct that context. Database session settings are a defense against missing query predicates, not credentials or a defense against an attacker who can issue arbitrary SQL or impersonate an authenticated application server.
- A private access grant permits its holder to view a specified partner; an additional explicit descendant grant is required to view children. Siblings and other insurers are never included merely because they share a parent. The application database role is read-only, non-owner and does not bypass RLS. It receives neither direct access to private grants/partner data nor permission to insert/update/delete the protected rows. Roles, grant provisioning, audit, write services and production IdP mapping remain future work.
- Partner roots and parent links cannot be changed by this slice. Reject self-parent, cross-insurer parent/root links and inconsistent ancestry. A later, audited and effective-dated transfer design must preserve historic ownership; do not silently reparent existing records.
- Channel and sub-channel **types** are insurer-owned database rows, not schema enums. Administration UI and audited writes are future work.
- Migrations use a direct Postgres connection, a transaction, an advisory lock and an immutable content checksum. A rollback refuses to delete any configured insurer, membership, type, partner or owned record. Database DDL is not connected to normal app startup.

## Pure source and identity matching

The pure, offline-only library can normalize policy numbers, propose safe column mappings and identify deterministic matches without opening files or computing amounts. It takes already scoped records and an explicit threshold for potential matches; it does not establish the caller's identity or grant data access. All input rows must carry exactly the same insurer, root partner, optional sub-partner and insurance class as the requested run or be rejected.

- Duplicate keys are findings and quarantined; they must not be arbitrarily selected.
- Exact canonical policy keys may match; zero-padding variants need a unique, one-to-one candidate with **present corroborating insured names**. Missing names are not evidence. This deliberately tightens the prototype's permissive missing-name behavior.
- Similar names/numbers create **proposals only**, never confirmed pairs; unconfirmed lines remain unmatched. No UI confirmation or persisted audit decision is present in this slice.
- The implementation must not calculate premium/commission variances, infer currencies, apply an FX rate, calculate an entitlement, free-look or clawback, generate a payable, submit a statement or issue a payment. These are separately gated work.

## Verification and release gates

Synthetic tests exercise scoped access under a non-owner, non-bypass Postgres role; explicit descendant grants; guessed IDs and scope tampering; cross-insurer parent/owner constraints; configuration-driven types; transaction-local context cleanup; migration replay/rollback; deterministic exact, variant, duplicate and tentative matching; and the disabled feature gate. Embedded Postgres tests are useful development evidence, not a substitute for production Postgres/RLS, identity, security, disaster-recovery and independent review.

No production enabling or real customer data is authorized. The missing approved financial rulebook, independent verification, human finance/security approvals, verified identity, secure storage, complete workflow and AP reconciliation remain mandatory gates.

## What exists in this slice

| Component | Implementation / intentional limit |
| --- | --- |
| Release lock | `src/core/reconciliation/feature-gate.ts` recognizes `PARTNER_COMMISSION_RECONCILIATION_ENABLED`, but **always returns disabled**. No reconciliation endpoint, worker or UI has been added. The lock is not connected to the existing demo routes. |
| SQL | `migrations/reconciliation/0001_scope.{up,down}.sql` creates private insurer/partner/grant tables, insurer-configured channel/subchannel types and ownership-only rows for five future object kinds. They contain no policy facts, file contents, statements, amounts or payment data. |
| Migration tooling | `src/server/reconciliation/migrations.ts` and `tools/reconciliation-migrate.mjs`: direct, explicitly invoked, transaction/advisory-lock controlled migrations, with checksums over both directions. No normal startup migration. |
| Read repository | `src/server/reconciliation/read-repository.ts` checks the effective role and RLS, sets verified subject/insurer transaction-locally, and permits only scoped reads of ownership metadata and reference types. It has no API integration or writer. |
| Identity matching | `src/core/reconciliation/identity-matching.ts`: offline-only, scope-checked exact/unique zero-padding matching and tentative suggestions. It does not authorize data or compute commission. |
| Mapping | `src/core/reconciliation/column-mapping.ts`: unconfirmed suggestions for policy number, insured name, insurer and insurance class only. It does not open files or infer financial fields. |
| Tests | `src/server/reconciliation/postgres.test.ts`, `src/core/reconciliation/*.test.ts`: synthetic fixtures. PGlite runs normally; a dedicated CI job also uses native Postgres 16. No real customer data is included. |

### Ownership ERD (foundation metadata, not a workflow schema)

```text
private.insurer 1 ───── * reconciliation.channel_type 1 ───── * subchannel_type
       │
       ├── 1 ───── * private.partner ── parent ── private.partner
       │                    │
       │                    ├── 1 ───── * private.access_grant (subject + self/descendant rights)
       │                    │
       │                    └── 1 ───── * policy | source_file | reconciliation_run |
       │                                  statement | payment_instruction (ownership only)
       └────────────────────────────────── same-insurer and same-root foreign keys
```

A root has no parent and owns itself; all children have a pre-existing parent in the same insurer/root. Hierarchy identifiers cannot be updated in this slice. `owner_partner_id` is the root when `subpartner_id` is null and otherwise equals that subpartner. The five named object tables do **not** provide their eventual business meaning: in particular, an ownership row in `payment_instruction` is not a payment instruction and cannot be sent to AP.

### Matching semantics and limits

Identity keys use Unicode NFKC, uppercasing and whitespace normalization, while preserving punctuation and zeroes. Exact key matches are only within an explicitly supplied, already-authorized insurer/root/subpartner/insurance-class partition. A zero-padding variant is accepted only when it is one-to-one across **all** input rows (including already matched and duplicate rows) and both insured names are present and equal after normalization. Duplicate keys and ambiguous variants are quarantined. Other comparisons use the minimum of name/policy bigram similarity, a caller-supplied threshold and a mandatory bounded comparison count; every such pair is a proposal and stays unmatched. These policies and scores are implementation choices for an offline foundation, not insurer-approved identity rules, and require review before operational use. Inputs over 20,000 rows per side or the explicit comparison budget fail without silently truncating.

### Migration and test runbook

1. Use **only a disposable test database** for development. Do not connect this slice to production or real policyholder data. A trusted DBA must review migration SQL, role ownership and backups. No reader roles or business reference data are provisioned by the migration.
2. For reviewed test deployments, set `RECON_MIGRATION_DATABASE_URL` via an appropriate secret mechanism to a **direct** Postgres connection for the dedicated migration owner, with TLS/certificate settings suitable to the environment. Do not use application credentials or put connection strings in logs, Git or the command history. Invoke `npm run recon:migrate -- up`. It applies reviewed migrations transactionally, serializes deployers and verifies both up/down checksums. Repeating it is a no-op.
3. A deliberately separate, non-owner, non-superuser, non-`BYPASSRLS` reader role must have only schema `USAGE`, `SELECT` on the named reconciliation tables and `EXECUTE` on the two reviewed visibility functions. It must have no membership allowing a switch to a privileged role, no write privileges and no access to `reconciliation_private`. These grants are deliberately **not** created automatically. The read repository rejects several unsafe role/RLS configurations, but a full database privilege review is still required.
4. The trusted server must authenticate and authorize the subject/insurer before constructing `trustedReadContext`. Transaction-local settings are **not authentication**: anyone able to issue arbitrary SQL as the reader can set them to another subject. Do not expose raw SQL or allow untrusted callers to construct trusted context. There is no IdP integration in this slice.
5. `npm run recon:migrate -- down` reverses only the latest migration and refuses when any insurer, grant, partner, reference type or owned row exists. It uses no `CASCADE`, so unknown dependent objects also prevent rollback. The empty migration-history schema remains. For a populated or uncertain environment, stop and follow a separately approved backup/restore plan; never erase histories to force rollback.
6. `npm run test:coverage` runs embedded-Postgres and pure tests. For native checks, set `RECON_TEST_DATABASE_URL` to an **isolated disposable PostgreSQL test cluster** using a test administrator allowed to create/drop random temporary databases and roles, run `npm run build:server`, then `npx vitest run src/server/reconciliation/postgres.test.ts`. The test harness creates and drops only its own randomly named databases and its own created roles. Never point this at a shared or production cluster. CI provisions its own ephemeral Postgres 16 service. The native suite tests concurrent migration deployers and the CLI as well as RLS.

### Verification boundary

On 2026-10-27 the implementer exercised the synthetic isolation/migration suite locally against native PostgreSQL 16.14 and PGlite, including non-owner RLS, explicit descendants, sibling/cross-insurer denial, guessed IDs, immutable hierarchy, pooled-context cleanup, migration replay/refusal, concurrent deployers and CLI migration. This is implementation evidence, not an independent review or proof of deployed production security. Full CI results and repository-wide checks are recorded with the change. Production IdP, audit, data protection, workflow, finance, AP and release acceptance remain open.

Implementer regression results for this slice: `npm run verify` passed (82 files, 1,021 tests; 85.61% statements, 68.79% branches, 91.25% functions and 89.72% lines); lint retained 81 existing warnings and the UI build retained its existing large-chunk warning. The targeted matching/database run passed 45 tests across PGlite and native PostgreSQL 16.14, including the migration CLI. `npm audit`, API-document generation/diff, JSONL/link validation and the fleet dry run passed. No browser E2E was run because this slice adds no UI and the available environment has no Chromium. These are implementer-run results; they do **not** satisfy the required different-role verifier approval.
