# Reconciliation Foundation Contract

This unlocked foundation slice delivers **non-financial** data, matching, API and console groundwork for partner reconciliation. Financial commission, free-look, clawback, payable statement and AP payment rules remain locked and require approved insurer/regulatory specifications before implementation.

## Feature Gate

`reconciliationFeatureGate()` unlocks the non-financial foundation by default (`enabled: true`, `financialCalculationsEnabled: false`, `mode: 'non_financial_foundation'`, `reason: 'non_financial_foundation_unlocked'`). Setting `PARTNER_COMMISSION_RECONCILIATION_ENABLED=false` (or `0` / `off`) disables the foundation (`enabled: false`, `mode: 'disabled'`).

Financial calculations remain unconditionally `false`.

## Delivered Surface

1. **PostgreSQL ownership schema & RLS (`migrations/reconciliation/0001_scope.up.sql`, `src/server/reconciliation/`)**:
   - `reconciliation_insurers`
   - `reconciliation_channel_types`
   - `reconciliation_subchannel_types`
   - `reconciliation_partners`
   - `reconciliation_scope_records`
   - Insurer-owned configurable channel/sub-channel reference tables (no rigid SQL enums), immutable acyclic partner hierarchy, and `FORCE ROW LEVEL SECURITY` via `ReconciliationReadRepository`.
2. **Pure TypeScript identity helpers & workspace (`src/core/reconciliation/`)**:
   - `column-mapping.ts`: deterministic identity-only header suggestions (`policyNumber`, `insuredName`, `insurer`, `insuranceClass`) that never confirm automatically and never map financial columns.
   - `identity-matching.ts`: scoped exact normalized policy matching, insured-corroborated numeric zero-padding variant matching, duplicate quarantine (`duplicate_policy_key`, `ambiguous_variant`), and bounded tentative similarity proposals.
   - `workspace.ts`: `ReconciliationFoundationWorkspace` managing insurer/partner hierarchy, configurable channel/sub-channel reference additions, human confirmation of identity header mappings, scoped non-financial matching runs, auditable human confirmation/rejection of tentative proposals, and append-only audit trail.
3. **API & Console Tab (`src/core/routes.ts`, `src/ui/reconciliation-views.tsx`)**:
   - `GET /api/reconciliation`
   - `POST /api/reconciliation/channel-type`
   - `POST /api/reconciliation/columns/propose`
   - `POST /api/reconciliation/columns/confirm`
   - `POST /api/reconciliation/identity/match`
   - `POST /api/reconciliation/proposals/review`
   - Console tab `Partner reconciliation` (`reconciliation`) displaying non-financial status, hierarchy, identity mapping confirmation, deterministic run output, quarantine findings and proposal review.

## Deliberately Omitted (Locked Pending Sign-Off)

- Premium, commission, clawback, free-look, FX, tax, rounding, payable statement and AP payment tables, formulas, ledger postings and disbursements.
