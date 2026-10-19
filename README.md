# Central Insurance Illustration Portal

**An AI-native Insurance ERP** — term and whole-of-life, critical illness, income protection, endowment, mortgage, medical, motor, travel, home and contents, property, liability, engineering, marine cargo, hull and aviation, group benefits, unit-linked and **takaful** (96 filed varieties across 17 lines) — with a group finance core, an end-to-end fund management engine, and micro-duration cover (daily / pay-as-you-go / start-and-stop).

> **Status: the money spine runs, and the sale runs on rails.** The domain core (money, double-entry ledger, NAV and dealing rules, unit-linked engine, micro-duration billing, takaful pools with surplus gates, consent, ingestion, AI governance, **the guided customer lifecycle**), **tenant master settings** (country, calendar, currencies, field renaming, the product factory), **the AI guide on every section**, the API server and the operator console are implemented, typechecked, tested (530 cases) and building — and 1129 backlog chunks are claimed as done with evidence in `ledger/runs.jsonl` while the remaining 741 critical-path chunks stay honestly open.

```bash
npm install
npm run verify     # typecheck + 530 tests + build
npm run fleet      # work the backlog, one small chunk at a time
npm start          # serve the console and API on :8787
npm run tour:doc   # regenerate the guided tour from its data

# activate CI (needs a token with the `workflow` scope, or paste it in the GitHub UI):
mkdir -p .github/workflows && cp docs/ci-workflow.yml .github/workflows/ci.yml
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
| [`docs/06-QA-REPORT.md`](docs/06-QA-REPORT.md) | What is verified today, the bugs QA found and fixed, and what is still open |
| [`docs/ci-workflow.yml`](docs/ci-workflow.yml) | The CI pipeline (typecheck → tests → build → a small fleet pass). GitHub refuses to accept a workflow file from a token without the `workflow` scope, so it lives here verbatim; to activate it, copy it to `.github/workflows/ci.yml` (one command, below) or paste it in the GitHub web UI. |
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

### B — the live API server → Render (not Vercel)

`npm run build && npm start` runs one Node process serving both the SPA and the JSON API on a single port. It reads `PORT`, binds `0.0.0.0` and needs no secrets, so it is Render-ready as-is.

**Do not put this artifact on Vercel.** The server holds mutable state in a module-level `let state` — including the idempotency-key table and the append-only reporting store. Vercel's serverless model runs many short-lived instances, so a journey like `POST /claims/register` → `/claims/approve` → `/claims/settle` can land on three instances that never saw each other's writes, and settle returns `409` for an approval that does exist elsewhere. Reads still look perfect, because the demo world is deterministic — which is exactly what makes the failure quiet.

Render (or Railway, or Fly) gives the process the persistence its design assumes. The free tier spins down when idle, which is harmless here: the world rebuilds deterministically in about 36 ms.

### No database — Neon is not required

There is no SQL, no ORM, no driver and no `DATABASE_URL` anywhere in the codebase. The only environment variables read are `PORT` and `HOST`, and nothing under `src/` writes to disk. The demo world is built in memory by `buildWorld()` and reproduced byte-identically on every boot — verified by the durability drill (`POST /api/state/drill`), which reseals the books, restores them into a fresh ledger and confirms `fingerprintStable: true` with every entity balanced.

[`src/core/persistence.ts`](src/core/persistence.ts) is the seam where a database would go later, and it is deliberately not one yet: a canonical snapshot codec (bigint/Date/Map/Set-safe, FNV-1a fingerprinted, schema-versioned, with a migration planner) written so any future store — file, Postgres `jsonb`, an outbox — shares it. Add Neon when state must survive restarts or scale past one process, not before.

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

## Contributing / working here

Read `AGENTS.md` first. One chunk per change, evidence stored, contracts frozen before implementation, high-risk chunks (money, units, NAV, charges, claims payouts, regulatory wording, Shariah) require named human approval.

- `docs/08-COMMIT-ERROR-LEDGER.md` — every commit whose message admits an error or an open item, and where each one stands now, verified against the tree rather than the message.
