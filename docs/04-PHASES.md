# 04 — Phases and the critical path

*Timeboxes assume a working agent fleet of 10–30 concurrent runs plus part-time human review. They are sequencing commitments, not calendar promises. Each phase ends with a demonstration, not a status report.*

---

## Phase 0 — Foundations (now → 2 weeks)

**Goal:** the repo can build, test, migrate and run the skeleton with a tenant, an entity, a fund and a chart of accounts in place.

- Regenerate: monorepo layout, TypeScript project references, lint/format/typecheck, CI (build + test + migrate + seed on every push).
- Platform services: identity, tenant, entity, RBAC, audit ledger, outbox, event bus (in-process first, Kafka-ready), scheduler, job queue, idempotency keys.
- Ledger core: double-entry, multi-currency, base + foreign, entity-scoped, trial balance; **money as decimal**.
- Fund core skeleton: `Fund`, `FundValuation`, `PolicyAccount`, `UnitTransaction`, `ChargeSchedule` tables + contracts + unit tests for dealing cut-offs.
- **Labeller**: label registry with locale + tenant override (this lands early because retrofitting renaming is brutal).
- Demo: a seeded tenant with two entities (conventional + takaful), one fund, one product, and a passing money-smoke test.

**Exit evidence:** `npm run verify` green; CI publishes the API contract bundle; the seed produces a trial balance that balances to zero.

## Phase 1 — The money spine (weeks 3–8)

**Goal:** a unit-linked policy can be issued, valued, charged, switched, partially withdrawn and surrendered, with every rupee/dirham/dollar traceable to a price and a rule.

- Product factory v1 (data-defined products, charges, riders, funds, illustration rules).
- Unit-linked engine: allocation, cancellation, switches, top-ups, redirection, rebalancing, charges, floors, lapse/partial-lapse outcomes.
- Fund management: NAV upload + vendor feed adapters, valuation calendar, dealing calendar, unit pricing, fund accounting, residual accounts.
- **Decision theatre v1**: current value, penetration of units to instruments, "switch today" and "withdraw today" outcomes, scenario envelopes labelled as illustrations.
- Billing v1: annual/instalment plus the **daily / PAYG / start-stop** segment engine with the no-auto-start rule and scheduled start/stop.
- Ledger integration for every money event; reconciliation reports.
- **Money proof**: 10,000 simulated policies, independent expectation model, zero unexplained residuals.
- Regulatory pack framework with the **UAE pack v1** (need analysis, motor survey, illustration wording, disclosure).

**Exit evidence:** the money proof runs in CI; the decision theatre shows a real withdrawal outcome on a demo policy; a switch instruction made after the cut-off provably prices at the next valuation point.

## Phase 2 — Risk, claims and reinsurance (weeks 9–16)

- Underwriting: rules, evidence, referrals, decisions, audit; reinsurance notification.
- Claims: FNOL (omni-channel + OCR), medical pre-auth, motor survey and assessment, reserves, payments, recoveries, subrogation, fraud signals; **human approval gates above thresholds**.
- Reinsurance: treaties, facultative, cessions, recoveries, statements, retro/re-takaful.
- Correspondence and document generation; e-signature; claims and policy letters per country.
- Customer service/care: cases, SLAs, complaints, regulator escalation tracking.

**Exit evidence:** end-to-end claim with reinsurance recovery, posted to GL, with a generated settlement letter in two languages.

## Phase 3 — Finance, group and takaful (weeks 17–24)

- Group finance: consolidation, inter-company, FX revaluation and translation, cost centres, allocations, budgeting, group reporting currencies.
- Takaful engine: model-driven funds, tabarru', wakalah/mudarabah fees, qard lifecycle, **surplus run with actuary + Shariah Committee + board gates**, per-jurisdiction rules (BNM-style, UAE restrictions, KSA cooperative).
- Takaful window operation: one tenant, conventional + takaful entities, separate funds and reporting, renamed terminology in UI, API, statements and warehouse.
- Actuarial valuation extracts; solvency input marts; IFRS 17-shaped groupings available to the warehouse (as data).
- First **second country pack** (choose: KSA or Malaysia) with its own regression journey.

**Exit evidence:** a surplus run produces a distribution proposal, blocked until approvals are recorded, then posted; the group consolidation balances with inter-company eliminated.

## Phase 4 — Scale, data and AI everywhere (weeks 25–34)

- Ingestion fabric complete: any-shape bulk import (CSV/Excel/JSON/XML/fixed-width/PDF-text/email), saved mappings, async, idempotent, replayable; **rogue validation fleet** supervising loads with anomaly scores and quarantine.
- Warehouse: CDC, star schemas per subject area, DBT models, regulatory marts, dashboards; actuarial and management reporting.
- Customer 360: golden record, matching/merge/split, and the **cross-party consent API** (`POST /v1/parties/match`) with partners onboarded.
- Smart onboarding: NFC chip read (ICAO 9303), government-source lookup adapters, multi-engine OCR with consensus, per-field translation, review queue.
- AI layer: agents in every module per `02-ARCHITECTURE.md` §12, with the governed action ledger, dry-run, and human gates; agent-action audit mart.
- Mobile/self-service policyholder app: cover control (start/stop), fund view, decision theatre, claims status, documents.

**Exit evidence:** a partner system is told, with consent, that a customer exists and what they hold; a dirty Excel file of 50,000 rows loads with quarantined suspects and a reconciliation pack; every AI action for a week is queryable with cost and outcome.

## Phase 5 — Country packs, hardening, first pilot (weeks 35–44)

- Country packs to the agreed road map, each with rule tests, forms and journeys.
- Performance and scale passes; DR and restore rehearsals; security review; penetration test; data-residency deployment.
- Multi-tenant SaaS operationalisation (if that is the business model): onboarding a new insurer in days, with configuration rather than code.
- Pilot: one real insurer (or takaful operator), one product, one channel, parallel-run against their existing system, then cut over.
- Migration toolkit if there is a legacy book (ILAS or otherwise).

**Exit evidence:** a pilot tenant using the system in production with reconciliation against the incumbent, and an incident/rollback runbook exercised.

## The critical path (what must never be blocked)

```
platform services → ledger core → fund core → unit-linked engine → billing segments
        → decision theatre → money proof → claims/reinsurance → group finance
        → takaful surplus → ingestion/warehouse → country packs → pilot
```

Everything else in the backlog can be re-ordered around it. When the fleet has spare capacity, it deepens the long tail (locales, fields, letters, reports); when capacity is tight, it only ever works the critical path.

## Risk register (top of mind)

| Risk | Mitigation |
| --- | --- |
| Unit/NAV arithmetic wrongness | Independent expectation model in CI; property-based tests; stop-the-line on residuals |
| Regulatory wording wrong per country | Country packs as versioned data with regression journeys and named human sign-off |
| Shariah model mis-applied | Model-driven funds; actuary + Shariah Committee gates; jurisdiction-specific rules |
| Agent fleet produces fast but inconsistent code | Frozen contracts, verifier independence, rogue validator, fleet-wide consistency pass per phase |
| Scope disease ("AI in every module") | Phases gate breadth; the matrix absorbs the long tail instead of the critical path |
| Run-cost overrun | Per-day concurrency cap; cost-per-chunk tracked in the ledger; re-rank weekly |
| Actuarial/regulatory dependency on humans | Recruit the human signatories early; their gates are modelled as workflow, not afterthoughts |
