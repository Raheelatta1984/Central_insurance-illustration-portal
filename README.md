# Central Insurance Illustration Portal

**An AI-native Insurance ERP** — term and whole-of-life, critical illness, income protection, endowment, mortgage, medical, motor, travel, home and contents, property, liability, engineering, marine cargo, hull and aviation, group benefits, unit-linked and **takaful** (96 filed varieties across 17 lines) — with a group finance core, an end-to-end fund management engine, and micro-duration cover (daily / pay-as-you-go / start-and-stop).

> **Status: the money spine runs, and the sale runs on rails.** The domain core (money, double-entry ledger, NAV and dealing rules, unit-linked engine, micro-duration billing, takaful pools with surplus gates, consent, ingestion, AI governance, **the guided customer lifecycle**), **tenant master settings** (country, calendar, currencies, field renaming, the product factory as an editable grid, the rating tables by age/gender/occupation/sum assured, the omni-channel with partners, commission and clawback), **funds accounting, super funds, data warehouse with rotating PII masking, batch processing, What's New, and the live application theme engine**, **the AI guide on every section**, the API server and the operator console are implemented, typechecked, tested (941 cases over 75 files) and building — and the fleet simulator (`tools/fleet.mjs`) marks 1138 backlog chunks done in `ledger/runs.jsonl` against *module-level* test evidence (a planning signal, not per-chunk proof of each titled capability) while the remaining 732 critical-path chunks stay honestly open.

```bash
npm install
npm run verify     # typecheck + lint + 941 tests with coverage + build + offline bundle sync
npm run fleet      # work the backlog, one small chunk at a time
npm start          # serve the console and API on :8787
npm run tour:doc   # regenerate the guided tour from its data
npm run docs:api   # regenerate docs/API-REFERENCE.md from the dispatcher (178 endpoints)

# CI is live in .github/workflows/ci.yml (typecheck → lint → coverage → build → artefact sync → fleet).
```

## Why this exists

The 2026 market shipped agentic AI bolted onto twenty-year-old cores (Guidewire Qusar, Duck Creek's Agentic AI Platform, SapiensAIP). They are strong on P&C, weak on **life/unit-linked depth**, **takaful**, **multi-country/currency** and **day-priced cover**. ILAS-class systems (Centegy) do unit-linked policy administration and fund figures well — but they report the fund, they do not let a policyholder interrogate the decision.

This platform is built the other way round: **takaful-native, group-finance-native, unit-linked-deep, priced by the day, and agent-first from the first commit.**

## The guided customer lifecycle

The console's second tab, **Customer journey**, is the sale end to end in nineteen sections that are all
closed when you arrive. Onboarding → customer profile and consent → needs-analysis questionnaire →
product recommendation → coverage and premium → occupational and medical loadings → riders → medical
requirements → fund allocation → beneficiaries → underwriting and questionnaire review → quotation as a
PDF emailed to the customer → cooling-off and sign-off → payment (cash, credit or debit card, bank
transfer, BNPL, branch deposit) → the binding route (auto, manual, senior, a freelance underwriter hired
to meet the promise, the reinsurer asked before issue) → policy conversion → allocation management →
investment progress → servicing.

One section is open at a time, and it is open because the core says it is next: a section unlocks only when
every section before it is 100% complete on its mandatory fields *and* its domain gates — weights that
total exactly 100%, beneficiaries that total exactly 100%, a loading breakdown that reconciles with the
underwriting file, medical evidence received and reviewed, money actually cleared. The same gate runs in
`POST /api/journey/submit`, so a script or an agent cannot walk past the sequence either. Claims, policy
administration, quotations, funds, reinsurance and master settings use the same rail.

See [`docs/09-CUSTOMER-JOURNEY.md`](docs/09-CUSTOMER-JOURNEY.md) for the sequence, the gate contract, the
alternatives considered and what is verified.

## Omni-channel partner workspace

Open **`/partner-portal`** on the live server (or use the Partner workspace link in the console). It supports filed, enabled distribution partners and sub-channels, signed-application review by an eligible supervisor, manager or senior manager, routing and conversion gates, exact commission reconciliation, external settlement references, insurer conversations and scoped operational/commission reports. In demo mode the empty workspace offers **Create sample workspace**; its records are in memory and are lost on restart.

This is a **prototype**, not a payment, claims-settlement or insurer-integration service. Partner customers initially sign an indicative quotation subject to underwriting; underwriting is held until partner approval. Payment and cover require an accepting underwriting decision and, when terms change, a revised quotation and fresh recorded acceptance. Name entry is **not verified electronic signing** and a prepared email is not proof of delivery. Substantive risk changes require a new journey. Production identity, durable audit/replay, insurer communications, financial controls, independent verification and named human approval remain open. See [`docs/20-PARTNER-PORTAL.md`](docs/20-PARTNER-PORTAL.md), [`docs/21-CONDITIONAL-QUOTATION.md`](docs/21-CONDITIONAL-QUOTATION.md), the [production-readiness roadmap](docs/22-PARTNER-PRODUCTION-ROADMAP.md) and the [`OpenAPI contract`](docs/partner-portal.openapi.json).

## Pre-Load Security Gate, 36-Role RBAC, Authority Tiers, DOA Notifications & Smart Auto-Pick

- **Pre-Load Security & 36-Role Selection Layer (`src/core/rbac.ts`, `src/ui/rbac-views.tsx`)**: Opened prior to entering the ERP workspace across all **36** enterprise **roles** — permission templates, not user accounts; logins and individual user profiles are a later layer that references a role id. `administration` holds 100% unrestricted access across all **30** tabs, sections and sub-sections plus unlimited DOA authority, and the remaining 35 roles sit on four explicit authority tiers (**22 officer · 4 supervisor · 9 manager · 1 executive**): `supervisor`, `configurator`, `underwriter-officer`, `underwriter-manager`, `retention-officer`, `retention-manager`, `endorsement-officer`, `endorsement-supervisor`, `claim-officer`, `claim-manager`, `settlement-officer`, `settlement-manager`, `reinsurance-officer`, `reinsurance-manager`, `bancassurance-operations-officer`, `fund-configuration`, `accountant`, `finance`, `cost-controller`, `fund-investment-officer`, `fund-investment-manager`, `agent-1`, `agent-2`, `agent-marsh`, `agent-supervisor`, `banca-officer-1`, `banca-officer-2`, `banca-supervisor`, `aggregator`, `direct-customer`, `referral-partner-1`, `referral-partner-2`, `bank-manager`, `branch-officer` and `branch-manager`.
- **Role Authority Tiers, DOA Change Control & Officer Limit-Increase Requests**: DOA caps and access are changed at **supervisor or manager level only** — officer roles are refused by the registry (`changeRoleDoa`, `setRoleNodeAccess`) and by the API. An officer instead raises a tracked **DOA limit-increase request** (`POST /security/doa/limit-request`) that routes to its mapped supervisor, is never auto-approved, and applies the new cap only when an outranking approver decides (`POST /security/doa/decide`). Upward edits, edits at or above your own tier, caps above your own cap and self-approval are all rejected, and every attempt lands on the audit trail.
- **Role Access Matrix tab (`role-matrix`) — Tab → Section → Sub-Section enable/disable tree**: A dedicated console tab where each role's **tab → section → sub-section** tree is set to **Full — visible & editable**, **Read-only — visible, locked**, **Hidden — not in navigation**, or **inherit** from the parent. Sections and sub-sections store only explicit overrides, so inherited levels stay explainable and moving a tab moves its whole branch. Includes the 36-role directory with tier/scopes/DOA cap, a supervisor/manager DOA cap editor, the officer request form, and the access & DOA change audit trail. Officer roles never see the tab at all.
- **AI Access & SoD Advisor + Role Access & DOA Tab (`access-doa`)**: Recommends optimal 3-tier access (`Tab -> Section -> Sub-Section`), flags Segregation-of-Duties (SoD) conflicts, maps supervisor/manager chains by **Entity × Channel × Sub-Channel** (including Marsh Broker, Agency Desks, Bancassurance Desks, and Retail Bank Branches), and routes DOA approval requests with real-time approver notifications, self-approval blocks, escalations, and immutable audit trails.
- **Zero-Duplicate Smart Auto-Pick, Editable `<SmartComboBox />` & Master Age Rules (`src/core/autopick.ts`, `src/ui/combobox.tsx`)**: Auto-picks previously entered `dob`, `age`, `heightCm`, `weightKg` (and live BMI), `sex`, `smoker`, `occupationClass`, `annualIncome`, `beneficiary`, and `dependentProducts` (linked riders/companion covers); upgrades fields including **Product Name**, **Product Description**, and **Dependent Products** to editable + AI-suggested ComboBoxes; and auto-calculates Insurance Age from Date of Birth via Master Setup **`Age Nearest (ANB)`**, **`Age Next (ANxB)`**, or **`Age Last (ALB)`**.

See [`docs/17-RBAC-DOA-AUTOPICK-AND-SMART-COMBOBOX.md`](docs/17-RBAC-DOA-AUTOPICK-AND-SMART-COMBOBOX.md) for full architecture and API endpoints.

## Whose platform is this, and what does it sell?

The **Master settings & ERP** tab is where a tenant says who it is, and every other screen reads that
answer instead of hardcoding it:

- **Country, region, calendar and money.** 39 country packs (regulator, regions, IANA time zone,
  currency, locale, date order, week start), 44 time zones, 36 currencies. Pick Malaysia and the console
  header shows Kuala Lumpur at UTC+08:00 in ringgit; the foreign rate card is rebased onto the new local
  currency on exact rationals rather than dropped, and the ledger keeps its own base currency because
  every amount stays explicit about the money it is in. One rate card, quotable from either door.
- **Renaming.** A field's display name is a filed setting next to `mandatory` and `editable`: rename
  "Sum assured" to "Amount of cover" once and the form, the outstanding-field checklist and the refusal
  that names the field all say the new words, with who/when/from/to on the trail. The existing label
  registry does the same for the regulated vocabulary in both languages.
- **Products.** 96 varieties across 17 lines are seeded as product masters with their own underwriting
  manuals — entry ages, tariff, income multiple, binding limits, evidence bands, territories — so a hull
  risk prices and routes through the same engine as a term life, and the journey ranks all of them
  against the needs questionnaire by the objective each one answers.

## The guide on every section

Every screen and every section carries a sticky note: what it is for, what to do in it, what to watch,
and the engine's live figures folded in — so it says "96 product masters across 17 lines" rather than
"several products". The notes are data in `src/core/guide.ts` (one per tab, one per curated section, and
a composed note for any section nobody curated), rendered by `src/ui/guide.tsx` through a provider above
the tab body. One switch in the header hides them all, and the change is filed — on the guide's own
trail and on the AI ledger — because "was this operator shown the guidance?" deserves a factual answer.
The notes never override a rule: the gates and refusals run either way.

See [`docs/10-TENANT-MASTER-AND-GUIDE.md`](docs/10-TENANT-MASTER-AND-GUIDE.md).

## Multi-country carriers and the letter's sender

An insurance provider is filed as a carrier, not as a dropdown on a product: home country, home
regulator, which books it may write, a registered branch in every country it sells in, a country
reinsurance arrangement (retakaful for Takaful), and products filed in that country's own currency.
A sale check refuses a route with no branch, a lapsed licence, no country reinsurance, a product in
the wrong currency, or a book the route is not permitted to sell. Conventional and Takaful are two
checkboxes at channel, sub-channel and partner level, and the effective permission is the narrowest
of the three — so Marsh's call centre can sell both while its agency desk sells Conventional only.
Premium is managed by the local branch and the investment is held in the country where the quotation
was generated; the carrier's home country is carried for capital reporting. The worked example files
three carriers across the UAE, the UK and Singapore in AED, GBP and SGD from one button.

Email is its own tab and its own master: several sending accounts (Gmail API, SMTP, Microsoft Graph
or SES), each with a departmental address and the *names* of the environment settings holding its
credentials, and one route per business event — policy issuance from issuance, information packs from
info, renewal requests from retention, alterations, claims and reinsurance from their own desks.
Templates use a closed placeholder list, unknown tokens are refused at filing, a preview resolves the
envelope and the letter without sending, and the delivery test reports the transport's real answer.

See [`docs/16-MULTI-COUNTRY-PROVIDERS-AND-EMAIL.md`](docs/16-MULTI-COUNTRY-PROVIDERS-AND-EMAIL.md).

## Documents

| Document | What it covers |
| --- | --- |
| [`docs/00-UNDERSTANDING.md`](docs/00-UNDERSTANDING.md) | What was understood from the brief, module map, definition of done, **open questions to confirm** |
| [`docs/01-MARKET-LANDSCAPE.md`](docs/01-MARKET-LANDSCAPE.md) | 2026 competitive review, ILAS/unit-linked benchmark, takaful regulation, PAYG market, gap analysis and positioning |
| [`docs/02-ARCHITECTURE.md`](docs/02-ARCHITECTURE.md) | System shape, tenancy/entities/group finance, the unit-linked & NAV engine, takaful engine, regulatory packs, localisation & renaming, onboarding, ingestion fabric, billing segments, warehouse, AI governance, NFRs, stack choices |
| [`docs/03-ROGUE-BUILD-SYSTEM.md`](docs/03-ROGUE-BUILD-SYSTEM.md) | The chunk/fleet build system: what a chunk is, roles, the arithmetic behind the 9-digit backlog, scheduler rules, definition of finished |
| [`docs/04-PHASES.md`](docs/04-PHASES.md) | Phase 0–5 plan, critical path, risk register |
| [`AGENTS.md`](AGENTS.md) | The worker contract every agent follows: claiming, ownership, evidence, risk gates, ledger row |
| [`docs/05-DECISIONS.md`](docs/05-DECISIONS.md) | The decisions I took on your behalf, each with its rationale and how to reverse it |
| [`docs/07-TOUR.md`](docs/07-TOUR.md) | The sixty-minute guided tour of the live app, generated from `src/core/tour.ts` (the same data the console's Tour tab runs) |
| [`docs/09-CUSTOMER-JOURNEY.md`](docs/09-CUSTOMER-JOURNEY.md) | The guided customer lifecycle: the nineteen gated sections, what "complete" means, why the gate lives in the core, the API, and what was verified |
| [`docs/10-TENANT-MASTER-AND-GUIDE.md`](docs/10-TENANT-MASTER-AND-GUIDE.md) | Tenant master settings: the regional card (country, time zone, date order, local and foreign currency), renaming journey fields, the 96-variety product catalogue, and the AI guide with its switch — the API, the refusals and what is verified |
| [`docs/11-PRODUCT-CONFIG-RATING-AND-OMNI-CHANNEL.md`](docs/11-PRODUCT-CONFIG-RATING-AND-OMNI-CHANNEL.md) | The product shelf as an editable table with a copy-line and a bulk sheet, the rating grid (age × gender × occupational rank × sum assured, premium and unit-linked cost of insurance), per-channel secondary names, and the omni-channel master: channels, partners, per-partner products, rates, commission and clawback |
| [`docs/20-PARTNER-PORTAL.md`](docs/20-PARTNER-PORTAL.md) | Scoped partner applications, underwriting-routing gates, commission reconciliation, service requests, identity and prototype limitations. |
| [`docs/23-PARTNER-COMMISSION-RECONCILIATION.md`](docs/23-PARTNER-COMMISSION-RECONCILIATION.md) | Insurer-owned reconciliation ADR; financial implementation remains blocked. See the [delivery plan](docs/24-RECONCILIATION-DELIVERY-PLAN.md), [ReconIQ map](docs/25-RECONIQ-INTEGRATION-MAP.md) and inactive [foundation contract and runbook](docs/26-RECONCILIATION-FOUNDATION-CONTRACT.md). |
| [`docs/12-FUNDS-SUPER-WAREHOUSE-AND-BRANDING.md`](docs/12-FUNDS-SUPER-WAREHOUSE-AND-BRANDING.md) | Country-specific funds accounting, event-to-voucher mappings, super-fund member administration and charges, warehouse datasets/exports/connector recipes, theme scope and omni-channel sub-channels |
| [`docs/13-BATCH-WHATSNEW-WAREHOUSE-SECURITY-AND-THEME.md`](docs/13-BATCH-WHATSNEW-WAREHOUSE-SECURITY-AND-THEME.md) | Batch processing (quotation/illustration/issuance + monthly-anniversary mortality, premium/commission accrual, clawback, fund charges, dividends) with event-based accounting setups and the lapse/withdrawal/surrender stop rule; What's New generated from commits; Snowflake/Excel/Access warehouse connections with breach agreement, fingerprint-only secrets and rotating one-way PII masking; the Application theme tab |
| [`docs/06-QA-REPORT.md`](docs/06-QA-REPORT.md) | What is verified today, the bugs QA found and fixed, and what is still open |
| [`.github/workflows/ci.yml`](.github/workflows/ci.yml) | The live CI pipeline (typecheck → lint → tests with coverage → build → generated-artefact sync check → a small fleet pass). |
| [`docs/API-REFERENCE.md`](docs/API-REFERENCE.md) | Every one of the 231 API endpoints plus the transport contract (errors, idempotency, auth) — generated from the dispatcher by `npm run docs:api`. |
| [`docs/14-REVIEW-REMEDIATION.md`](docs/14-REVIEW-REMEDIATION.md) | The 2026-10-20 external review: what was fixed, what was consciously deferred, and why. |
| [`docs/15-QUOTATION-EMAIL-AND-ILLUSTRATION.md`](docs/15-QUOTATION-EMAIL-AND-ILLUSTRATION.md) | The quotation email that actually leaves the building (Gmail API OAuth2, honest failure, `npm run mail:smoke`), and the benefit illustration: three filed return scenarios, the customer's own benefit and payment terms, and the product / omni-channel / sub-channel cascade |
| [`docs/16-MULTI-COUNTRY-PROVIDERS-AND-EMAIL.md`](docs/16-MULTI-COUNTRY-PROVIDERS-AND-EMAIL.md) | Insurance providers as multi-country carriers: registered branches per country, per-country reinsurance and retakaful, the country's own currency, local premium and origin-country investment, and Conventional/Takaful selling permissions narrowed at channel, sub-channel and partner — plus the separate Email configuration tab: departmental accounts, fourteen event routes, placeholders, preview and honest delivery |
| [`docs/18-DATA-PLANE.md`](docs/18-DATA-PLANE.md) | The data plane as code: PgBouncer (budget arithmetic, pool modes, Neon's own pooler, prepared statements, `SHOW POOLS` triage), read replicas with lag budgets and read-your-writes pinning, memcached policy and generation invalidation, logical image shards with a weighted-rendezvous machine map, and the 64-bit `next_id` (41 + 13 + 10 bits) |
| [`backlog/SUMMARY.md`](backlog/SUMMARY.md) | Generated backlog counts, matrix arithmetic, per-module breakdown |

## Deployment

The repository ships **two independent deployable artifacts** with different hosting requirements. Putting the second one on the wrong host fails *silently*, so the choice is written down here rather than left to whoever deploys next.

### A — the static demo → Vercel (recommended)

[![Deploy with Vercel](https://vercel.com/button)](https://vercel.com/new/clone?repository-url=https://github.com/Raheelatta1984/Central_insurance-illustration-portal)

One click and nothing else: no environment variables, no secrets, no database, no provisioning. [`vercel.json`](vercel.json) is already committed and does the whole job.

| Setting | Value |
| --- | --- |
| Framework | `null` — deliberate, so Vercel does not guess |
| Install command | a no-op `echo`: the build needs **zero dependencies** |
| Build command | `node tools/demo-site.mjs` |
| Output directory | `site/` |

`tools/demo-site.mjs` assembles `site/` from four files that are already committed, so a host that only runs a build step produces the site without installing a single package:

| File | Size | What it is |
| --- | --- | --- |
| `index.html` | 6 KB | the landing page |
| `console.html` | 1.6 MB | **the real application**, running the engine in the browser |
| `gallery.html` | 1.7 MB | the module gallery (screenshots recorded before the journey tab; refresh with `npm run demo:pack`) |
| `tour.md` | 21 KB | the written sixty-minute tour |

3.3 MB total. The console is not a video or a mock-up — it carries the engine itself, so it answers live in the browser with no backend behind it.

[`.github/workflows/pages.yml`](.github/workflows/pages.yml) publishes the identical assembly to GitHub Pages, so the two hosts cannot disagree about what is online. Locally: `npm run demo:site`, then serve `site/`.

### Live versus offline execution

The normal UI sends requests only to `/api`. A network failure, non-JSON response, or
invalid JSON is an error, **not** permission to execute against a second local world.
If a mutation response is lost, its server outcome is unknown: reload/reconcile server
state before retrying. The browser-local engine is enabled only by the explicit
`window.__OFFLINE__` flag installed by the generated standalone demo; its changes are
local to that page and are discarded on reload.

Warehouse downloads are generated once per export. The returned fingerprint, byte
count, masking method, and audit record describe the exact downloaded content; the
audit history retains metadata, not a second copy of the download.

Money allocations interpret the decimal representation of finite, nonnegative weights
exactly (including scientific notation), conserve integer minor units, and break equal
remainders by input order. Negative amounts mirror the corresponding positive split.
A nonzero amount cannot be allocated to an empty list; all-zero or invalid weights are
refused rather than silently discarding value.

### B — the live API server → Render (not Vercel)

`npm run build && npm start` runs one Node process serving both the SPA and the JSON API on a single port. It reads `PORT`/`HOST` and binds `0.0.0.0`. **Demo mode needs no secrets** — the API is then open and says so at boot and in `GET /api/health`. A real deployment sets `PORTAL_AUTH_TOKENS` (Bearer tokens mapped to named principals and roles, see `src/server/auth.ts`) and `PII_VAULT_SECRET` (from the KMS/secret store); with `NODE_ENV=production` the server *refuses to start* without both unless you also set `PORTAL_ALLOW_DEMO=1` to run the open demo on purpose.

**Do not put this artifact on Vercel.** The server holds mutable state in a module-level `let state` — including the idempotency-key table and the append-only reporting store. Vercel's serverless model runs many short-lived instances, so a journey like `POST /claims/register` → `/claims/approve` → `/claims/settle` can land on three instances that never saw each other's writes, and settle returns `409` for an approval that does exist elsewhere. Reads still look perfect, because the demo world is deterministic — which is exactly what makes the failure quiet.

Render (or Railway, or Fly) gives the process the persistence its design assumes. The free tier spins down when idle, which is harmless here: the world rebuilds deterministically in about 36 ms.

### Letting the server email a customer

The quotation email is sent through the **Gmail API** (OAuth2), not SMTP. With no credentials the
server runs a `dry-run` transport: it records the message it *would* have sent and says so on the
boot line and on every screen that shows delivery, rather than pretending.

| Variable | Meaning |
| --- | --- |
| `MAIL_FROM` | the address quotations are sent from — nothing is sent without it |
| `MAIL_FROM_NAME` | display name, e.g. `Central Insurance quotations` |
| `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `GOOGLE_REFRESH_TOKEN` | the OAuth desktop client and the refresh token, scope `…/auth/gmail.send` |
| `GOOGLE_MAIL_USER` | `me` (default), or the mailbox when sending as a delegated user |
| `MAIL_DRY_RUN=1` | hold and record, even with credentials present |

`GET /api/mail/status` reports the transport, the from address, whether it is live, the session's
sent/failed/not-sent counts and which settings are present (never their values).
`npm run build:server && npm run mail:smoke` proves the whole path — journey to quotation, message
composed, PDF attached, provider refusal recorded — against a stand-in for Google, with no mailbox
involved. Full write-up: [`docs/15-QUOTATION-EMAIL-AND-ILLUSTRATION.md`](docs/15-QUOTATION-EMAIL-AND-ILLUSTRATION.md).

### No database in the demo — and a data plane you can review before buying one

**The demo still has no SQL, no ORM and no driver.** The world is built in memory by `buildWorld()` and
reproduced byte-identically on every boot — verified by the durability drill (`POST /api/state/drill`),
which reseals the books, restores them into a fresh ledger and confirms `fingerprintStable: true` with
every entity balanced. Nothing under `src/` writes to disk. [`src/core/persistence.ts`](src/core/persistence.ts)
remains the canonical snapshot codec (bigint/Date/Map/Set-safe, SHA-256 fingerprinted, schema-versioned,
with a migration planner) that a store will share.

What *is* now implemented is the **data plane as code** — the decisions a durable deployment has to make,
computed from configuration, refused when they would not work, and pinned by tests, so the topology can
be rehearsed before a database bill exists:

| Module | Decision it enforces |
| --- | --- |
| [`src/core/pgbouncer.ts`](src/core/pgbouncer.ts) | `instances × default_pool_size + reserved ≤ max_connections`, or the plan is refused; transaction pooling is refused when the application needs session state; **Neon's `-pooler` host is PgBouncer**, so a second pooler in front of it is refused; a Neon URL without TLS is refused; `pgbouncer.ini` is rendered **without a password**; `SHOW POOLS` samples are read as sentences (`cl_waiting`, `sv_idle_in_transaction`) |
| [`src/core/sqlclass.ts`](src/core/sqlclass.ts) | read / write / session / unknown — locks, sequences, `SELECT … INTO`, `SET`, `LISTEN`, advisory locks, unknown SQL and multi-statement strings go to the primary |
| [`src/core/readplane.ts`](src/core/readplane.ts) | replicas only inside the lag budget and a closed breaker; reads inside a write transaction or from a session that just wrote are pinned to the primary; fallback is the primary, never a stale answer; memcached never stores money, PII or auth material, never caches a clock-dependent read, and invalidates by generation counter |
| [`src/core/shardmap.ts`](src/core/shardmap.ts) | image blobs → a fixed logical shard (1–8,192) → a machine by weighted rendezvous hashing, with copies across zones, weights, drained machines, a rebalance plan that names every shard, and capacity counted per copy |
| [`src/core/idgen.ts`](src/core/idgen.ts) | `next_id`: **41 bits of ms + 13 bits of shard reference + 10 bits of counter**, monotonic under a backwards clock, 1,024 ids/ms/shard, sorted by construction |
| [`src/core/dataplane.ts`](src/core/dataplane.ts) | the only environment parser for all of the above, and the report behind `GET /api/infra/topology` and `POST /api/infra/ids` |

`npm run infra:plan` prints that report (and `-- --check` exits non-zero on any refusal). `deploy/` holds a
runnable reference: Postgres 16 primary, two streaming replicas, PgBouncer with the generated config, and
memcached. The variables, the arithmetic, the operating runbook and the honest list of what is *not* wired
yet (driver, migration runner, live lag monitor, memcached client, blob store, id backfill) are in
[`docs/18-DATA-PLANE.md`](docs/18-DATA-PLANE.md). `DATABASE_URL` is read **only** by that planner today;
it is not in the request path.

## The build system in one paragraph

Work is done by **chunks**, not by agents. `tools/generate-backlog.mjs` generates chunks from a matrix (22 modules × 8 layers × 7 product lines × 8 countries × 8 locales × 3 depths = **236,544 combinatorial chunks**, before per-field and per-document expansion takes it past **100 million**). Any number of agent runs can be pointed at the backlog; the fleet grows with budget, the backlog never runs dry. Every chunk is atomic, contract-bound, dependency-declared, risk-classed and evidence-producing, and every agent run appends to `ledger/runs.jsonl`.

```bash
node tools/generate-backlog.mjs --dry                  # counts only
node tools/generate-backlog.mjs                        # write critical-path + long tail
node tools/generate-backlog.mjs --long-tail=99999999   # open the tap fully (large)
```

## Headline capabilities targeted

- **Fund management end to end** — not just fund accounting: real units, real NAV, penetration of customer money into underlying market instruments, live "switch today / withdraw today" outcomes, and clearly-labelled projection ("dream") figures for suggested funds.
- **Takaful window or standalone entity** — participant risk fund, participant investment fund and operator fund segregation; wakalah/mudarabah/waqf/cooperative models; qard hasan; surplus runs gated by actuary, Shariah Committee and board.
- **Centralised finance with group finance** — multi-entity, multi-currency, inter-company, consolidation.
- **Micro-duration cover** — daily, pay-as-you-go and start/stop segments, with cover **not** auto-starting at midnight unless the customer elected it.
- **Centralised customer concept** — consented API that tells a third party "this customer already exists" before they create a duplicate.
- **Smart onboarding** — chip read of ID documents, government data lookup, multi-engine OCR with consensus, bilingual fields with per-field translation.
- **Any-shape ingestion** — files, Excel, text, JSON, XML, email, API; asynchronous, idempotent, supervised by a rogue validation fleet.
- **Per-country regulatory packs** — need analysis, product admission, illustration wording, disclosure, takaful rules, data residency, regulator returns.
- **Funds accounting by country and event** — standards, fund/product mappings and balanced debit/credit vouchers keyed by policy, partner, channel and sub-channel, posted into the ledger.
- **Super funds** — accumulation, pension and TTR member policies with monthly charges and exact pro-rata gain/loss allocation through premium post-adjustment.
- **Analyst warehouse** — nine lineage-bearing datasets, native dashboard definitions and full CSV/JSON exports for Power BI, Tableau, Qlik, Databricks and Data Fabric setup.
- **Brand onboarding** — global entity themes plus partner/channel-scoped themes and uploaded logo/header/footer assets, with a local dominant-colour palette assistant.
- **Every label translatable and renameable per tenant** — so the same ERP speaks a takaful entity's regulated vocabulary without code changes.

## What runs today

| Surface | What it does |
| --- | --- |
| Console, Policyholder tab | Live fund value, penetration of units into underlying instruments with market prices, and the full transaction log with the dealing rule that priced each movement |
| Console, Tour | A sixty-minute guided walkthrough with a clock and a checklist, held as data in `src/core/tour.ts`: eleven steps, each saying where to go, what to press, what you should see and why it matters |
| Console, Group finance | Three entities in two currencies consolidated into one balance sheet: assets and liabilities at the closing rate, income and expenses at the period average, equity at the rate on the day it moved; the gap becomes a translation reserve on its own line instead of a rounding account; intercompany balances and trading are eliminated with anything that does not agree shown as in transit; a 30% minority is stated, not absorbed; and the whole thing balances in a group ledger that proves itself like any other |
| Console, Underwriting | Risk scoring from a manual held as data (age, build, occupation, pursuits, medical history, family history, financial underwriting and evidence bands), with the loading shown line by line; the case goes to a named human when the rules say refer; anything over the automatic binding limit is flagged for the reinsurer before issue; and an AI agent may accept or rate inside its own limit but never decline |
| Console, Claims | Triage decides straight-through, referral or decline; reserves are booked movements, not notes; approvals are checked against a real authority table (an AI agent is capped below any human); settlement releases the reserve, recoveries are posted as their own income and the position is read back from the ledger. In the takaful window the same workflow is wired to the participants' risk fund, so a pooled claim moves cash exactly once |
| Console, Reinsurance | The treaty register is the module: a quota share that takes its percentage of every risk, a surplus treaty that responds above a retention, catastrophe cover that responds only inside its band, and a facultative treaty that carries nothing until the reinsurer has accepted that named risk in writing. Cession posts ceded premium as an expense, the ceding commission as income and the reinsurer's share of a claim as a receivable — so the recoverable on the utilisation statement equals the account in the ledger. The takaful window has its own retakaful treaty and its own register: participant risk money offered to a conventional reinsurer is refused in code, not in a policy document | The same register holds the **security behind every counterparty's promise**: a recoverable plus the treaty's premium margin is what must be secured, cash and withheld premium are posted (restricted cash against a returnable security liability) while letters of credit are counted and disclosed rather than posted as money, a **cash call** asks for the shortfall and nothing more, releasing security that would leave an exposure unsecured needs a named approver — and interest on a retakaful counterparty's cash is refused outright, because it would be riba. The same tab carries the **reporting extracts**: the supervisory return in four schedules, the actuary's exhibits (technical provisions, cession and retention, loss ratios, and the month-by-month run-off), and a bordereau per counterparty. Every control names the ledger account it compares against, an extract that does not tie is refused issue, an issued extract is fingerprinted and immutable, and a reissue for the same period supersedes the last one with a written reason rather than editing it.
| Console, Decision theatre | "Switch today" and "withdraw today" priced with the live engine, plus labelled projection envelopes for the suggested portfolio — an illustration, never advice |
| Console, Cover control | Start/stop cover, see that nothing restarts by itself, advance the clock and watch only the days inside an active window get charged |
| Console, Takaful | Participant risk fund, investment fund and operator fund balances, qard hasan, and the surplus run blocked until the actuary, the Shariah Committee and the board have all signed |
| Console, Onboarding / Ingestion / Parties / Regulatory / AI / Books / Labels | Chip and OCR onboarding with a review queue, any-shape file ingestion with quarantine and reconciliation, consented cross-party lookup with an access log, pre-sale gates and a motor comparison matrix, the UAE reinsurance rule book — twelve rules held as data, each citing its instrument, its clause and its Arabic wording, with every placement decided allowed, held for a named human or refused and the decision kept as evidence — and the wording book, which drafts the letters (bordereau cover note, return cover letter, treaty note, policyholder note) with their mandated paragraphs held as data in English and Arabic, refuses to produce one that is missing a paragraph its template requires, and lets the takaful scope rename a field without touching a paragraph — and the submission log, which files the return through the CBUAE channel with its cover letter, refuses a return that has moved since it was issued, supersedes the filing when the return is corrected, and reports what is still awaiting the supervisor's reference — the agent action ledger with prohibited actions refused, the double-entry books with their balance proof, and per-scope renaming for the takaful window |
| Console, Durability tab | Seals the books into a canonical, fingerprinted snapshot and runs a live restore drill — rebuild a fresh ledger from the text and prove the trial balances agree — and does the same for the reporting registers: returns, rule decisions, letters and filings are sealed into one versioned snapshot, replayed into a fresh world and checked record by record (a return must keep its fingerprint, a decision must follow again from its own facts, a letter must regenerate, a filing must carry the answer it got), with a hash-chained outbox proving nothing was dropped between snapshots — each record remembers how far the books had got when it was made, so the restore carries the books forward with the registers and re-proves a return against the books of its own moment — the registers' own actions travel with them, so a restart takes the cession, the catastrophe recovery and the settled deposit again through the registers that took them and the books come back journal for journal |
| API | `GET /api/health`, `/world`, `/ledger/proof`, `/units`, `/state`, `/claims`, `/underwriting`, `/group`; `POST /api/state/drill`, `/group/consolidate`, `/underwriting/decide`, `/claims/register`, `/claims/approve`, `/claims/settle`, `/preview/switch`, `/preview/withdrawal`, `/cover/start`, `/cover/stop`, `/cover/tick`, `/pre-sale`, `/onboarding/ocr`, `/partner/lookup`, `/ai/approve`, `/ai/execute`, `/ingest/submit`, `/ingest/commit`, `/takaful/approve`, `/reset` |
| API, data plane | `GET /api/infra/topology` reports the deployment this process's environment describes — pool mode and backend arithmetic, Neon's pooled versus direct host, replicas and their lag budget, the cache, the image shard map and the id layout — with every refusal as a sentence (`?ini=1` adds the generated `pgbouncer.ini`); `POST /api/infra/ids` mints 1–1,000 `next_id`s for one shard and shows their decoded 41/13/10-bit fields |

## Contributing / working here

Read `AGENTS.md` first. One chunk per change, evidence stored, contracts frozen before implementation, high-risk chunks (money, units, NAV, charges, claims payouts, regulatory wording, Shariah) require named human approval.

- `docs/08-COMMIT-ERROR-LEDGER.md` — every commit whose message admits an error or an open item, and where each one stands now, verified against the tree rather than the message.
