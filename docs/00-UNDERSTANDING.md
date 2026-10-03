# 00 — What I understood from your brief

*Owner: Raheel. Written 2026-10-04. This document is the contract between your intent and the build. Correct anything wrong here before we go wide — everything downstream (architecture, backlog, agents) is generated from this file.*

---

## 1. The one-sentence version

Build a **complete, AI-native Insurance ERP** — life, medical, general, group, travel, unit-linked and takaful — that is modular, multi-country, multi-currency, bilingual with renaming, and centred on a **group finance core** and a **genuinely end-to-end fund management engine** (units → NAV → market → policyholder-facing transparency → withdrawals and switches), with a **Takaful window** that works either as a window inside a conventional insurer or as a standalone takaful entity — and make it better than ILAS (Centegy) and every AI-era core platform shipping today.

## 2. What "better" means, stated so it can be measured

| Benchmark | What they do well | What we must do that they do not |
| --- | --- | --- |
| **ILAS (Centegy)** — your first ERP as a consultant | Unit-linked policy handling, funds management, bancassurance, conventional **and** takaful in one core | Fund management **end to end**, not fund accounting plus headline figures: policyholder sees unit-level money, live NAV, and the *outcome* of a decision before making it |
| Guidewire / Duck Creek / Sapiens (2026 agentic cores) | Agentic AI bolted into policy, claims, billing; scale; filed-rate compliance | **Takaful-native**, **group finance**, **pay-as-you-go micro-duration cover**, and **operator-renamable labels** — none of which they treat as first-class |
| ULIP / ILAS retail platforms | Daily NAV, switching, partial withdrawal, illustrations | **Live decision theatre**: what a partial withdrawal or a fund move does to *your* money, at today's price, with future-value envelopes labelled as illustrations |
| Usage-based insurance (Hugo, Metromile, Milewise) | On-demand and per-mile pricing for motor | Start/stop **across all lines**, self-service, with a **scheduled** start/stop and no auto-start unless elected |

## 3. The module map I heard (this is the build order, not a wish list)

**Core domain**
1. **Party & Customer 360** — one customer record, many holdings, many intermediaries. Centralised so any third party selling any product that exists in our ERP can be told, by API, that the customer already exists with us.
2. **Product Factory** — products defined as data (coverage, riders, funds, charges, illustration rules, regulatory pack), cloned and versioned without code. Fully dynamic.
3. **Quotation & Illustration** — multi-line (life, medical, motor, travel, group) with **regulatory need-analysis** per country, gap analysis, comparison matrix across insurers, and a **projection/illustration engine** producing labelled future-value scenarios.
4. **Underwriting & Medical** — rules, evidence, referrals, reinsurance notification.
5. **Policy Administration** — issuance, financial and non-financial alterations (fund switches, allocations, riders, address, beneficiary, loans, partial withdrawals, top-ups), renewals, lapses, reinstatement, surrenders, maturity, endowment statements.
6. **Investment-Linked / Unit-Linked Core** — notional units per policy per fund, allocation and cancellation, bid/offer pricing, valuation points, switches, rebalancing, top-ups, premium redirection, charges (COI, allocation, admin, fund management, surrender), lock-ins, minimum remaining value. *This is where we beat ILAS.*
7. **Fund Management & NAV Engine** — real funds, real underlying market data, daily (or intraday where licensed) NAV, unit pricing, fund-level accounting, asset/liability, fund switching, and policyholder-visible penetration of every unit back to the market.
8. **Takaful Engine** — participant risk fund vs participant investment fund vs operator/shareholder fund, wakalah/mudarabah/waqf/cooperative models, tabarru', qard hasan with repayment tracking, surplus determination → Shariah board and actuary approval → distribution; standalone entity **or** window inside a conventional insurer.
9. **Centralised Finance / Group Finance** — one GL, multi-entity, multi-currency, inter-company, consolidation, cost centres, allocations, IFRS 17-aware structures (as data, not as a reporting afterthought), receivables/payables, commission and reinsurance accounting.
10. **Reinsurance / Retakaful** — treaties, facultative, cessions, recoveries, statements.
11. **Claims** — FNOL, adjudication, medical pre-auth, motor survey, fraud signals, reserves, payments, recoveries, subrogation.
12. **Billing, Collections & Payment** — induction, schedules, grace, dunning, receipts, partials, refunds, and the **flexible modes**: annual/instalment, **daily**, **pay-as-you-go**, **start/stop cover** with a scheduled start/stop and a rule that coverage does not auto-start at midnight unless the customer elected it.
13. **Customer Service / CRM / Care** — cases, SLAs, correspondence, complaints and regulator escalation.
14. **Consent & Data Sharing Ledger** — who may see what, mandated by law and by the customer, revocable, with an audit trail for every cross-party API call.
15. **Data Warehouse & Reporting** — star-schema warehouse, actuarial and regulatory extracts, dashboards, letter/reminder engine, scheduled reporting.
16. **Integration & Ingestion Fabric** — API-first on every model, plus bulk ingest from files, CSV, Excel, JSON, XML, text, email attachments, at any shape, processed **asynchronously**, idempotently, with validation and anomaly agents supervising the load.
17. **Regulatory Packs** — per-country rule sets (UAE/CBUAE, KSA/SAMA, Malaysia/BNM, Indonesia/OJK, India/IRDAI, Bahrain, Qatar, Pakistan, plus an extensible schema) covering need analysis, product approval, illustration wording, disclosure, storage of records, Takaful rules.
18. **Localisation** — every label and field stored with translations; a tenant (e.g. a takaful entity) can **rename any label** to its own regulated vocabulary without touching code.
19. **Smart Onboarding** — scan driving licence / Emirates ID / national ID / Aqama / passport: chip (NFC/ICAO 9303) where available, government data-source lookup where permitted, OCR as fallback, multi-lingual with **field-by-field translation**, confidence scoring and human review.
20. **AI Layer (cross-cutting)** — agents for intake, underwriting assist, claims triage, document intelligence, anomaly detection, correspondence, and a **rogue validation fleet** that supervises bulk ingestion and data quality.
21. **Analytics & Decisioning** — pricing, retention, cross-sell, fund performance attribution, embedded analytics in every module.
22. **Platform Services** — identity, tenancy, entitlements, audit, workflow/BPM, notifications, document generation, e-signature, sandbox/API keys.

## 4. The build system you asked for ("rogue" agents)

- Chunked work orders: every deliverable is an atomic, independently verifiable **chunk** with a contract and a test.
- **Assign chunks to a very large fleet of agents and keep increasing until it is finished** — implemented as a *ledger + scheduler + concurrency ramp* that can grow the fleet as budget allows, not as a fixed headcount. `docs/03-ROGUE-BUILD-SYSTEM.md` defines it; `tools/generate-backlog.mjs` generates the chunks from a module × layer × country × language matrix, so the backlog grows combinatorially rather than being hand-written.
- Tiny details matter: every chunk carries acceptance criteria, evidence requirements and the regulatory pack it belongs to.

## 5. What I will not pretend

- **Software cannot grant regulatory approval.** Product filings, Shariah board rulings, actuarial sign-off, market-data licences and investment-distribution permissions are external, per country. The ERP models and enforces them; it cannot be them.
- **Illustrations are not advice.** Projected values, "best suggested funds", and dreaming figures are **illustrations** with prescribed disclaimers, never a personal recommendation, unless the operating entity is licensed to advise. We build the guardrails in from day one.
- **Real-time NAV depends on licensed feeds.** We build the pipeline, the valuation calendar and the pricing engine; the data licence is a commercial decision per market.
- **No literal 99,999,999 agents.** What scales without limit is the backlog and the number of agent *runs* over time, bounded by compute budget. The design makes that a knob, not a fantasy.
- **This is a large program.** With agent-driven delivery it is months, not weeks, to a credible core — and I will give you honest phase gates rather than claiming "finished".

## 6. Open questions I need answered (numbered so you can reply briefly)

1. **Legal entity model first**: which country is the first regulator pack (UAE/CBUAE assumed), and are we building for a **single insurer**, a **group**, or a **software vendor selling to many insurers** (multi-tenant SaaS)? This changes tenancy, pricing and the audit model.
2. **Takaful first or conventional-with-takaful-window first?** A takaful-only build is simpler to keep pure; a window exercises both from day one.
3. **Funds**: do you intend to be the **fund manager** (own funds, own NAV) or to consume **third-party fund NAVs** (fund houses, Bloomberg/Refinitiv feeds)? Both are supported, but the first is a licence and operations business.
4. **Payment rails** for daily/PAYG cover — cards, direct debit, wallets, telco billing? And is the micro-duration model **prepaid wallet** or **post-paid arrears**?
5. **Claims depth in v1**: straight-through for low-value motor/medical, or full manual workflow?
6. **Distribution**: direct, broker, bancassurance, aggregator, embedded/API partners — which channel is first-class in v1?
7. **Data residency** requirement per country, and whether on-prem/private-cloud is ever required.
8. **Existing data**: is there a book of business to migrate (from ILAS or another core)? That changes phase 1 materially.
9. **Team reality**: will humans review agent output, and who signs off actuarial and Shariah logic?
10. **Name and brand** for the product — I propose a codename now and you rename later; tell me if you have one.
11. **Budget envelope** for compute/agent runs per week, so the fleet ramp is real rather than rhetorical.
12. **Deadline that actually matters** (investor demo, first pilot, first regulator submission) — I will shape phases around it.

## 7. Definition of done for the whole program (draft)

A single insurer (or takaful operator) can, in one system: onboard a customer by ID scan in two languages, run a compliant need analysis, quote and illustrate across lines, issue a policy with units in real funds, take daily or pay-as-you-go premiums, let the customer start and stop cover, show them live unit-level fund performance and the modelled outcome of a withdrawal or switch, pay a claim, cede to reinsurance, consolidate the group's finances across currencies and entities, produce every regulatory and management report, and do all of it in their own vocabulary and language — with an audit trail for every decision and every AI action.
