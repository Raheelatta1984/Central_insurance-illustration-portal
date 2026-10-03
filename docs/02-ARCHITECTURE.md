# 02 — Architecture

*Target: a modular, multi-tenant, multi-country insurance platform that a small team + agent fleet can actually build and operate. Decisions here are deliberately boring where boring wins.*

---

## 1. Shape of the system

**Modular monolith core, event-driven edges, service extraction when load demands it.**

```
                        ┌──────────────────────────────────────────┐
 Channels               │  Web apps: policyholder · intermediary ·  │
 (all API-first)        │  operator · onboarding kiosk · portal     │
                        └───────────────┬──────────────────────────┘
                                        │ REST/GraphQL + webhooks
                        ┌───────────────▼──────────────────────────┐
 Integration fabric     │ Gateway · authn/z · tenancy · entitlements │
                        │ Idempotency · rate limits · audit ledger  │
                        └───────────────┬──────────────────────────┘
                                        │ domain calls / events
   ┌────────────────────────────────────▼───────────────────────────────────┐
   │                        CORE DOMAIN (modular monolith)                  │
   │ party · product · quote · underwriting · policy · unit-linked · fund · │
   │ takaful · claims · reinsurance · billing · finance/GL · crm · regs ·   │
   │ documents · correspondence · workflow                                  │
   └───────┬───────────────┬───────────────┬───────────────┬────────────────┘
           │               │               │               │
      Event bus       Ingestion queue   Scheduler      Agent runtime
      (outbox→Kafka/  (files, Excel,    (valuations,   (governed actions,
       NATS/Postgres  text, API bulk)   billing runs,  human-in-the-loop,
       LISTEN)                          reminders)     full audit)
           │
   ┌───────▼───────────────────────────────────────────────────────────────┐
   │ Data: Postgres (OLTP, per-tenant schemas) · object store (docs/plans) │
   │ Warehouse: columnar lakehouse + star schemas · search: OpenSearch     │
   └───────────────────────────────────────────────────────────────────────┘
```

**Why a modular monolith first:** transactional integrity across policy ↔ fund ↔ ledger is non-negotiable in insurance. Distributed transactions across microservices would cost us correctness for fashion. Modules are separated by **explicit interfaces and an event contract**, so any module can be extracted later without rewriting its domain logic.

**Mandatory pattern everywhere:** command → domain service → **transaction** → **outbox event**. No module reads another module's tables; it consumes events or calls the interface.

## 2. Tenancy, entities and group finance

- **Tenant** = an operator (an insurer, a takaful operator, an MGA, a broker). Data isolation by tenant schema/RLS; per-tenant configuration, labels, rules packs, currencies, branding.
- **Entity (legal)** = a company inside a tenant: conventional insurer, takaful operator, holding, foreign branch, SPV. Each entity has its own chart of accounts, base currency, regulator, fiscal calendar.
- **Group** = a set of entities with consolidation, inter-company matching, eliminations, and group reporting currencies.
- **Fund** = a ring-fenced pool with its own accounting: **shareholder/operator fund**, **participant risk fund**, **participant investment fund**, and per-product sub-funds. Funds are first-class, not GL accounts with a naming convention.
- **Ledger**: one double-entry core, entity-scoped, multi-currency (base + foreign), with FX revaluation, realised/unrealised gain split, and sub-ledgers for receivable/payable, commission, claims, reinsurance and fund units. IFRS 17-relevant groupings are **data-driven dimensions** available to the warehouse.

## 3. The unit-linked and fund engine (our differentiator)

**Entities**

- `Fund` — currency, dealing calendar, valuation point, pricing basis (bid/offer or single), swing pricing flag, charges source, performance benchmark, Shariah screening status and screen audit.
- `FundValuation` — valuation date, per-unit price, gross/net asset value, units in issue, source batch, price basis, published flag, revision history.
- `PolicyAccount` — per policy per fund: units held, lock-in status, allocation %, premium redirection rules, target rebalancing, minimum value floor.
- `UnitTransaction` — allocate / cancel / switch-in / switch-out / charge-cancel / bonus / correction, each with the **valuation price actually used**, the dealing cut-off applied, and the reason.
- `ChargeSchedule` — COI, allocation, admin, fund management, switching, surrender, top-up, guarantee; both policy level and fund level, versioned, effective-dated.

**The dealing engine (correctness rules we must never break)**

1. Every monetary movement carries an **instruction timestamp**, a **dealing cut-off rule** from the product and market, and the **valuation point** it resolved to. No exceptions, ever — this is the audit spine regulators test first.
2. Prices are **effective-dated and reversible**: a corrected valuation produces compensating unit transactions, never silent edits.
3. Units are **never negative** in aggregate per policy-fund; a charge that would breach a floor triggers a defined outcome (lapse warning, partial lapse, fund switch, surrender) that the product declares as data.
4. Rounding policy (units to N decimals, money to currency minor units) is per fund, per product, and the residual is booked to a named residual account.
5. **Switch** = cancel in fund A + allocate in fund B at their respective prices, atomic, with a single customer-visible instruction id.
6. **Partial withdrawal** = cancel units to realise the requested amount *after* applying surrender/withdrawal charges and tax where applicable; remainder of cover preserved; the engine returns a full money trail.
7. **Top-up / premium redirection / rebalancing** are first-class transactions with their own rules.
8. Every policyholder value is **reproducible**: given the transaction log and the valuation history, the current value can be recomputed line by line. This is what makes the customer-facing transparency trustworthy.

**Market data**

- `Instrument` → `MarketPrice` (end-of-day, and intraday where licensed), FX rates, corporate actions (splits, dividends, mergers), and a **fund composition** model (weights per instrument, with look-through depth for funds-of-funds).
- Data adapters: licensed vendor feeds, custodian files, administrator Excel/CSV, or our own NAV upload. Ingestion is idempotent and versioned; stale prices raise blocking alerts rather than quietly pricing yesterday's number.

**The policyholder-facing decision theatre**

Given today's units and prices, compute and display, side by side:
- current value, and the **penetration** view: units → fund → underlying instruments → market price, with each step's freshness timestamp;
- **"if you switch today"**: outcome in the target fund at target allocation, charge impact, new unit balance, projected envelopes at 1/3/5/10 years under adverse / central / favourable assumptions;
- **"if you withdraw X% today"**: units cancelled, price used, charges, remaining units and cover, mortality/COI consequences, surrender-charge impact, and tax notes by country pack;
- **"what if you invest like our suggested portfolio"**: an explicitly labelled **illustration** (never advice) with prescribed regulatory wording, deterministic assumptions, and the option to compare against the customer's current allocation.

All projections are computed by the **same** calculation kernel used for policy accounting, so illustrations cannot drift from reality.

## 4. Takaful engine

- `TakafulModel` per product: wakalah / mudarabah / wakalah-mudarabah hybrid / waqf / cooperative (KSA), each declaring fund routing, fee basis, surplus-sharing ratio, and Shariah rules.
- `RiskFund` receives tabarru'; `ParticipantInvestmentFund` receives investment allocations; `OperatorFund` receives wakalah/mudarabah fees. **Segregation is enforced at the ledger level**, not by convention.
- `Qard` lifecycle: deficit detection → interest-free loan → repayment tracking → surplus distribution gates while outstanding.
- `SurplusRun`: actuarial valuation → surplus/deficit determination per risk fund and sub-fund → **actuary recommendation → Shariah Committee approval → board endorsement** (configurable per jurisdiction: BNM-style three-gate, or UAE restrictions) → distribution or retention per policy.
- Shariah screening of instruments in investment funds, with an audit record of the screen and purifications.
- A **takaful window** is an entity type inside a conventional tenant: shared customer and operations, **separate funds, separate ledgers, separate reporting, separate surplus runs**, and terminology renaming (see §6).

## 5. Regulatory packs (per country, as data)

A pack is a versioned, testable module of rules + wordings + forms:

```ts
interface RegulatoryPack {
  country: string;                       // "AE", "SA", "MY", "ID", "IN", "BH", "QA", "PK"
  needAnalysis?: RuleSet;                // mandatory questions, evidence, blocking rules
  productAdmission?: RuleSet;            // what must exist before a product can be sold
  illustration?: { wording: string; assumptions: AssumptionSet; disclaimers: string[] };
  disclosure?: RuleSet;                  // what must be shown, when, and to whom
  takaful?: TakafulRules;                // permitted models, surplus gates, disclosure
  dataResidency?: ResidencyRule;         // where data may be stored/processed
  reporting?: RegulatorReportSet;        // returns, formats, schedules
  audit?: RetentionRule;
}
```

- First pack: **UAE/CBUAE** (need analysis before health/motor/life sale; motor survey; mandated medical cover; illustration wording; takaful restrictions).
- Each pack ships with: rule unit tests, example customer journeys, generated forms, and a **regression suite** so a rule change is provably scoped.
- Packs are **versioned by effective date**; a policy is always evaluated against the pack version in force at the relevant event, and the historical evaluation is reproducible.

## 6. Localisation and renaming (every label, every field)

- All UI/message text lives in a **label registry**: `key → { locale: text }` with plural and gender variants and RTL support.
- Tenants may **override any label** (e.g. a takaful entity renaming "Premium" → "Contribution", "Policy" → "Certificate", "Sum insured" → "Tabarru' cover", "Insurer" → "Operator", "Surrender" → "Early termination") without code changes, versioned and auditable.
- Field-level renaming flows through APIs, documents, statements and the warehouse, so nothing in the system contradicts a regulated vocabulary.
- Languages: English + Arabic first (with RTL), then Bahasa Malaysia/Indonesia, Urdu, Hindi, French. Translations of *data* (e.g. a scanned ID) are held separately from *label* translations so an official name is never silently translated.

## 7. Customer 360 and the cross-party API

- `Party` (person/company) → `PartyRole` (policyholder, life assured, beneficiary, payer, broker, agent, service provider) → `Relationship`.
- `CustomerMaster` holds golden-record identity with **probabilistic + deterministic matching** (name transliterations, ID numbers, DOB, phone, email) and a merge/split history.
- **Cross-party lookup API** (the concept you described): a partner system, on creating a new customer, calls `POST /v1/parties/match` with consent proof. We answer with a confidence-scored match, the products the customer already holds with us, and a `consentId` scoping exactly what may be returned. No consent → no data, and the refusal is logged.
- **Consent ledger**: grant, scope, purpose, expiry, revocation, and every access. Legally required in every jurisdiction this will operate in, and it is also our commercial trust story.

## 8. Smart onboarding

```
ID document  →  (1) chip read (NFC, ICAO 9303) → (2) government data source (where licensed)
                 (3) OCR fallback with multi-engine consensus → (4) human review when confidence < threshold
                 → bilingual field extraction + per-field translation → identity record + consent capture
```

- Multi-engine OCR with **consensus scoring** per field; every field carries a source and confidence.
- Arabic/English documents natively; transliteration handled explicitly and reviewable.
- Regulatory hooks: UAE Emirates ID / residence visa validation, licence validation, sanctions/PEP screening, and country-specific need analysis triggered **before** any product suggestion.
- Everything is an async pipeline (queue + retries + dead-letter), so a slow government lookup never blocks a sales screen.

## 9. Integration and ingestion fabric

- **Every model is API-first**: OpenAPI for REST, event schemas (Avro/JSON) on the bus, webhooks for partners, GraphQL for bespoke portal reads.
- **Ingest anything**: CSV, TSV, Excel, JSON, XML, fixed-width, PDF text, email attachments, and raw text; schema inferred, mapped, previewed, then committed — with a saved mapping per partner.
- **Bulk, async, idempotent**: every load gets a `loadId`, natural-key dedupe, per-row validation, partial-success semantics, and a replayable error file.
- **Rogue validation fleet**: agent supervisors sample rows, detect anomalies (outliers, impossible combinations, duplicate identities, tariff drift), score confidence, quarantine suspects, and produce a human-readable reconciliation pack. Nothing is auto-committed above a risk threshold.
- **Partner data sharing** uses the same fabric in reverse: subscription feeds, consent-scoped extracts, and an audit of what was shared, with whom, under which consent.

## 10. Billing: daily, PAYG and start/stop cover

`CoverSegment` is the primitive: a policy has one or more **segments** with `startAt` and `endAt` (nullable = open), each generating charge events.

- **Modes per product**: annual, instalment, monthly, **daily**, **pay-as-you-go** (usage events), **start/stop** (on-demand), and hybrid (base + usage).
- **The midnight rule**: coverage does **not** auto-start at 00:00 unless the customer elected auto-start. Default behaviour is *paused*; the customer starts it (or schedules it), and the engine bills only between start and stop. Scheduled starts/stops are first-class with reminders and confirmations, and can be cancelled or amended.
- Rating: a tarif table per product/segment/territory/usage band, versioned by effective date; every charge event stores the tariff version used.
- Money: wallet (prepaid) and arrears (post-paid) both supported, with credit limits, grace, suspension, reinstatement, refunds and rounding rules per currency.
- Mid-term adjustments produce **pro-rata or short-rate** calculations, with the rule declared by the product, not hard-coded.
- Every statement, reminder and dunning letter is generated through the correspondence engine (§11) and stored with its delivery evidence.

## 11. Correspondence, reminders and the data warehouse

- **Document/correspondence engine**: templates as data (locale-aware, tenant-renamable), merge fields from any domain object, batch + on-demand, email/SMS/print/portal delivery, stored immutably with delivery status.
- **Reminders/scheduler**: cron-like schedules with business-day calendars, escalation ladders, and a suppression model (do-not-contact, complaint in progress, regulatory blackout).
- **Warehouse**: CDC from OLTP → lakehouse → star schemas per subject area (policy, unit, fund, claim, billing, finance, consent, agent actions). Reporting is served from marts, never from OLTP.
- **Actuarial + regulatory marts** first-class: valuation extracts, surplus runs, solvency inputs, and regulator report packs (UAE, KSA, MY, …).
- **AI analytics**: retention/churn, cross-sell, fund performance attribution, claims anomaly, tariff drift, and an **agent-action audit mart** so every AI decision is queryable like any other event.

## 12. AI layer (governed, not decorative)

- **Agent runtime** with: tool contracts (never raw DB), scoped credentials, per-action policy checks, dry-run/preview mode, action ledger (who/what/why/inputs/outputs/model version), rollback where reversible, and human-in-the-loop gates by risk class.
- **Where agents work**: document intake, OCR reconciliation, need-analysis assistance, underwriting evidence assembly, claims triage and reserve suggestion (**never** the final payout decision without human approval above thresholds), correspondence drafting, data-quality supervision, bulk-ingest anomaly detection, reconciliation, and test generation.
- **Where they must not**: final pricing approval, Shariah rulings, actuarial certification, payout decisions above limits, and anything a regulator requires a named human to sign.

## 13. Non-functional requirements (fixed from day one)

| Area | Requirement |
| --- | --- |
| Correctness | Money is decimal, never float. Every money movement is double-entry, idempotent and reproducible. |
| Audit | Append-only audit for every state change, every AI action, every consent, every data share. |
| Security | Tenant isolation (RLS), field-level encryption for identity data, secret management, least privilege, full access logging. |
| Performance | Quote/illustration p95 < 400 ms; policy transaction p95 < 800 ms; valuation run per 100k policies within the dealing window. |
| Availability | 99.9% core; valuation and billing runs are **restartable and idempotent**; no partial-day double charging. |
| Scale | 5M policies per tenant, 20M unit transactions/year, 100M events/month without re-architecture. |
| Reporting | Warehouse queries never touch OLTP; regulator extracts reproducible for any historical date. |
| Deployability | Single-tenant private cloud **and** multi-tenant SaaS from the same codebase; on-prem option for data-residency markets. |
| Compliance | Country packs, consent ledger, data residency, retention, e-signature evidence, and PII minimisation by design. |

## 14. Technology choices (proposed, reversible)

- **Language**: TypeScript end-to-end for the platform and portals (one language, huge agent productivity), with **Python** for actuarial/data-science and **SQL/DBT** for warehouse models.
- **OLTP**: PostgreSQL (schemas per tenant, RLS, outbox, LISTEN/NOTIFY for light events). **Bus**: Kafka or NATS JetStream when volume demands (outbox makes the swap local).
- **Warehouse**: Parquet/Iceberg on object storage + DuckDB/ClickHouse for marts; DBT for transformation.
- **Runtime**: containers on managed Kubernetes; IaC from the first commit; environment parity dev/stage/prod; **the whole stack must run on one machine** for local development and demos.
- **Testing**: contract tests at every module boundary, property-based tests for money/units, golden-file tests for regulatory forms, and a **policy simulation harness** that replays a book of business to prove no regression.

*Rationale: TypeScript + Postgres + events is the stack where a large agent fleet produces the smallest number of integration surprises. Actuarial Python and SQL warehouse tooling stay in their lanes.*
