# 24 — Reconciliation delivery plan and open decisions

**Status: financial implementation blocked on business rules; limited non-financial foundation implemented.** The requester authorized its merge without an independent branch review on 2026-10-27; no such review is claimed. The [ADR](23-PARTNER-COMMISSION-RECONCILIATION.md) describes the target; the [reference map](25-RECONIQ-INTEGRATION-MAP.md) records the authorized reference and the [foundation contract](26-RECONCILIATION-FOUNDATION-CONTRACT.md) describes the inactive slice. No duration, rate, formula, limit, date convention or payment rule below is an approved value.

## Requested first input

Please provide the approved **free-look, commission eligibility and clawback rule document** (or the first such document, if they are separate). It should identify insurer, jurisdiction, product/insurance class, contract/channel scope, effective dates, rule owner and approval, and include worked boundary and paid-commission examples. Do not send real policyholder or banking data. Additional documents can follow one at a time.

On 2026-10-27 the requester stated they own ReconIQ and authorized its reuse for this project. Financial calculations remain blocked until the business decisions are resolved. Normal distribution/license review, production security and payment approvals are separate release gates.

## Open business decisions — all unanswered

The request supplies the mandatory exclusions and immutable-adjustment principles, **not** the values below. Confirm them per applicable insurer, jurisdiction, product, class, channel, partner and contract. Provide authoritative effective dates and examples, including when multiple rules could apply.

| Area | Decisions needed | Why it blocks |
| --- | --- | --- |
| Free-look | Duration and unit (calendar/business days), start-event basis, time zone, first/last-day inclusivity, weekends/holidays, amendments/renewals, what happens if no start/end date or rule exists, and the evaluation timestamp (statement cutoff/submission/payment). | Needed to identify the first and last excluded day and quarantine safely. Missing information must not become an entitlement. |
| Inside free-look events | Confirm cancellation, withdrawal and lapse event identity/effective date and handling where a legacy system already paid within free-look. | The request forbids entitlement, but the recovery and historical-payment procedure is not specified. |
| Earning/eligibility | The earning event and timing, premium basis (gross/net/collected), installments, endorsements, renewals, partial payments/refunds, rule precedence, eligible commission statuses and status transition authority per contract. | Determines which amounts, if any, can be earned and included. |
| Rates and arithmetic | Filed commission rates, effective date selection, precision and rounding mode/stage, currency scales, FX source/rate date and approval, tolerance/severity values and handling missing or disputed FX. | Prevents invented rates, rounding and cross-currency totals. |
| Post-free-look clawback | Full or prorated method and formula, recovery basis, time bands, partial events, cap/floor, policy event identity, prior partial recoveries, corrected/reversed events and any time limit. | The request requires configured recovery but supplies no algorithm. |
| Paid/advanced commission | Linkage to original payment, partial settlement and advance allocation, order of recoveries, negative net statements, carry-forward or collection procedure and prior-period corrections. | Prevents editing history, over-recovery and duplicate offsets. |
| Adjustments/tax | Who may approve adjustments, correction evidence, tax/VAT/withholding jurisdiction and basis, treatment of tax-exclusive/inclusive premiums, fees and rounding residuals. | Needed for transparent, reproducible component totals. |
| Periods | Weekly starting day, fortnightly anchor, half-year/annual calendar or fiscal start, insurer time zone/cutoff, date-end inclusivity, deadline and holiday handling, late and replacement/overlap policy, serialization scope. | Cadence names alone do not define unambiguous boundaries or duplicate rules. |
| Approval | Authorized role-to-action matrix; coordinator/manager requirements, threshold amount/currency/FX date, escalation and mandatory comments; rejection, dispute, return, correction, cancellation and replacement rules. | A state machine cannot infer actual authority or threshold. |
| Segregation of duties | Confirm whether partner approval is distinct from submission and whether manager approval/export authorization introduce additional distinct-actor constraints. At minimum, submitter, insurer approver and payment authorizer must be different people. | Prevents one person controlling a transaction end to end. |
| AP/remittance | Payee and bank-reference source/verification, tax identifier, batch grouping/currency, zero/negative amount behavior, export format/ownership, acknowledgment statuses, partial/failed/reversed payments, correction and reconciliation. | An instruction or export must not be mistaken for a confirmed payment. |
| Findings and resolution | Confirm the required exception catalogue, severity bands, which findings block submission, whether unconfirmed candidates may be displayed alongside excluded lines, and who can confirm them. The supplied engine defines 14 named categories, although its README/brief says 16. | Avoids inventing categories or treating an unresolved pair as payable. |
| Notifications | Which coordinator/manager roles are required, per-partner account-manager assignment, additional CC/consent, template content, failed-delivery handling, secure-link expiry and fallback. | A submission must have valid recipients and an auditable delivery outcome. |
| Ownership | Which legal entity is an insurer, how partner/sub-partner ownership is assigned, whether a sub-channel is an organizational partner, descendant visibility grants, transfer effective dates and finance/auditor scopes. | The existing sub-channel field is not a durable partner hierarchy. |

## Technical and operating decisions — all unanswered

- **Identity:** which existing corporate IdP, issuer, audiences, MFA/session standards, partner provisioning/deprovisioning and claims-to-membership mapping? The repository does not currently contain an integrated SSO provider.
- **Authoritative data:** systems/owners and read contracts for policy, endorsements, claims/status, commission, prior payments and policy event identifiers; update timing and reconciliation of corrections.
- **Hosting/data protection:** Postgres hosting and migrations, private object storage, key management, malware scanner, residency regions, retention/legal hold/deletion policies, backup and disaster recovery.
- **Operations:** notification provider, outbox worker runtime, monitoring, escalation/SLA ownership, allowed file types and limits, PDF/OCR policy, accessibility and supported languages.
- **AP/ERP:** external integration/interface and sandbox details, or a signed-off controlled export format and acknowledgment/import process.
- **Rights:** the requester stated they own ReconIQ and authorized reuse on 2026-10-27; complete any normal distribution/license review before release.

## Phases and evidence gates

Each phase is a separate contract-bound, reversible change set/PR with the feature disabled until the release gate. Ordering may be refined after the decisions above. On 2026-10-27 the requester waived separate independent reviews for branch merges; that waiver does not supply missing financial rules, constitute production acceptance, or replace the independently rerun insurer validation required in the eventual workflow.

| Phase | Proposed slice | Exit evidence |
| --- | --- | --- |
| 0. Decisions and contracts | Complete the ADR, integration map, approved rules and license decision; agree exact API/events, tenancy/role matrix and acceptance examples. | Named decision owners and versions, approved domain/API contracts, no invented financial defaults. |
| 1. Secure durable platform | Feature gate; Postgres driver/runner and expand/contract migrations; insurer, configurable channels, hierarchy, memberships/roles and administration views; scoped repository and RLS; audit/outbox/idempotency; IdP boundary. | Real Postgres migration/rollback and RLS tests, sibling/descendant and forged-ID tests, restart/concurrency tests, security acceptance. |
| 2. Documents and inputs | Private file store, upload/type/size/malware quarantine, CSV/XLSX/text-PDF adapters, detection/confirmation and versioned source mappings; synthetic examples only. | Safe parsing tests including malformed/scanned/encrypted PDFs, archive bombs, ambiguous mappings, isolated downloads and audit; no secrets or personal data in fixtures. |
| 3. Reconciliation | Typed, pure deterministic matching/findings, insurance-class partitions, human-confirmed probable matches, configured tolerances/FX, reproducibility and scoped run repository. Reuse is authorized by the requester; normal release/license review remains open. | Approved behavior/regression tests and deterministic replay; exact/variant/probable ambiguity, duplicates, endorsements, currencies and separate classes verified. No payable from a tentative pair. |
| 4. Approved financial rules | Effective-dated rule publication, free-look quarantine, status eligibility, earning and transparent component-based calculations, event-linked clawback/adjustments, decimal arithmetic. Only after written rule approval. | Human-approved worked examples, first/last-day tests, missing/overlapping rule refusals, historical/partial payment cases, idempotency and concurrency tests, and named human approval. |
| 5. Statements and notifications | Schedules, duplicate/overlap controls, immutable versions, partner approval/submission, contact directory, transactionally persisted in-app/email outbox and delivery attempts; partner React views. | DST/cutoff/calendar examples approved, version immutability and replacement tests, scoped export/download attacks, recipient/CC resolution and retry evidence. |
| 6. Insurer review | Independent authoritative rerun and comparisons, reviews/findings/exclusions, required comments, escalation, segregation of duties and insurer UI. | End-to-end partner versus insurer review; no self-approval or AP access from returned/disputed versions; concurrent transition tests and audit evidence. |
| 7. AP and remittance | Authorized idempotent ERP instructions or controlled export; acknowledgment/import/callback and remittance tracking; AP UI. | Repeat/concurrent export and callback tests, approved-only queue, component totals tie, failed/partial/reversed payment reconciliation, finance sign-off. |
| 8. Acceptance and rollout | Security/privacy/residency/operations reviews, synthetic E2E scenarios, monitoring, recovery and release documentation. | CI, migration forward/rollback or safe expand/contract, restore and failure drills, and named approvals. Only then consider enabling the flag per insurer. |

## Required verification matrix

These are the **target** acceptance requirements; the limited foundation exercises only the ownership metadata and offline matching subset described in [the foundation contract](26-RECONCILIATION-FOUNDATION-CONTRACT.md). The broader workflows, external identity and production operating environment remain unverified.

| Acceptance concern | Required verification |
| --- | --- |
| Tenant isolation | Cross-insurer and partner A/B direct-object attacks on policies, files, mappings, runs, findings, statements, attachments, notifications, exports and payment instructions; forged request scopes; service/worker paths; RLS under the actual non-owner app role and a pooled connection. |
| Hierarchy and configuration | Parent without `VIEW_DESCENDANTS` denied, granted descendants visible, siblings denied, hierarchy cycle/cross-insurer edges rejected; new channel/sub-channel reference rows require no schema change. |
| Matching | Exact and unique guarded variants, absent corroborating names, ambiguity, duplicate keys, probable candidates requiring confirmation, insurer and insurance-class separation, tolerance boundaries, dates/names/currency, endorsements and cancelled-invoiced records. |
| Eligibility and clawback | Within free-look excluded from payable and only in labelled report; approved start/end-day boundaries, inside-period cancellations/withdrawals/lapses; approved post-period full/prorated cases; already-paid adjustment linked to source and applied once under retries/concurrency. |
| Rules and totals | Effective-date/contract resolution, missing or conflicting rule rejection, commission status eligibility, exact amounts and FX, zero/negative values, component and per-class/sub-partner totals tie to line and AP instructions. |
| Periods and versions | Weekly, fortnightly, monthly, semi-annual and annual boundaries under approved timezone/anchor/cutoff; late and concurrent duplicate/overlap submissions; immutable version, explicit correction/supersession. |
| Workflow and payment | Only partner approver submits; independent insurer rerun; required comment and manager thresholds; returned/disputed/rejected cannot pay; submitter/insurer approver/payment authorizer are distinct; AP-approved-only; stable idempotent batch/export, remittance handling and reconciliation. |
| Communication and audit | Configured To/CC and authorization, retries and failed delivery; no sensitive data in links/logs; append-only audit for all material operations and retention policy enforcement. |
| Operations | Forward/backward or safe expand/contract migration drills on real Postgres, scoped encrypted storage and malware failure tests, restore/outbox retry, CI typecheck/lint/coverage/build and synthetic Playwright journeys. |

## Baseline verification for this planning slice

On 2026-10-27, the unchanged application baseline was checked with Node 22: `npm ci` (0 reported vulnerabilities), `npm run typecheck` (pass), `npm run lint` (pass with 81 existing warnings), `npm run test:coverage` (79 files / 993 tests passed; 89.63% lines and 68.51% branches), `npm run build` (pass with an existing large-bundle warning), `npm run docs:api` with generated-output diff check (pass), and `node tools/fleet.mjs --limit=5 --dry` (pass; no claimable chunks). These are regression checks of the existing application, **not** acceptance tests for this proposed feature. Browser E2E was not run because a Chromium executable was not available. This is historical evidence for the earlier planning-only slice, not evidence for any later code. See the [foundation contract](26-RECONCILIATION-FOUNDATION-CONTRACT.md) for current scope.

## Rollout and rollback

Deploy expand-only schema and disabled routes first; exercise with synthetic data, verify isolation and recovery, then obtain explicit insurer-scoped enablement. Disabling the flag stops new feature operations but does **not** reverse a committed statement, sent notification, export or payment. Pause workers, reconcile in-flight instructions with AP, retain immutable evidence and use separately approved compensating actions. Never drop submitted histories or issued payment references as a rollback shortcut.
