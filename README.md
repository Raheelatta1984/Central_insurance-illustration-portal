# Central Insurance Illustration Portal

**An AI-native Insurance ERP** — life, medical, general, group, travel, unit-linked and **takaful** — with a group finance core, an end-to-end fund management engine, and micro-duration cover (daily / pay-as-you-go / start-and-stop).

> **Status: the money spine runs.** The domain core (money, double-entry ledger, NAV and dealing rules, unit-linked engine, micro-duration billing, takaful pools with surplus gates, consent, ingestion, AI governance), the API server and the operator console are implemented, typechecked, tested (88 cases) and building — and 691 backlog chunks are claimed as done with evidence in `ledger/runs.jsonl` while the remaining critical path stays honestly open.

```bash
npm install
npm run verify     # typecheck + 73 tests + build
npm run fleet      # work the backlog, one small chunk at a time
npm start          # serve the console and API on :8787
```

## Why this exists

The 2026 market shipped agentic AI bolted onto twenty-year-old cores (Guidewire Qusar, Duck Creek's Agentic AI Platform, SapiensAIP). They are strong on P&C, weak on **life/unit-linked depth**, **takaful**, **multi-country/currency** and **day-priced cover**. ILAS-class systems (Centegy) do unit-linked policy administration and fund figures well — but they report the fund, they do not let a policyholder interrogate the decision.

This platform is built the other way round: **takaful-native, group-finance-native, unit-linked-deep, priced by the day, and agent-first from the first commit.**

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
| [`docs/06-QA-REPORT.md`](docs/06-QA-REPORT.md) | What is verified today, the bugs QA found and fixed, and what is still open |
| [`backlog/SUMMARY.md`](backlog/SUMMARY.md) | Generated backlog counts, matrix arithmetic, per-module breakdown |

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
| Console, Decision theatre | "Switch today" and "withdraw today" priced with the live engine, plus labelled projection envelopes for the suggested portfolio — an illustration, never advice |
| Console, Cover control | Start/stop cover, see that nothing restarts by itself, advance the clock and watch only the days inside an active window get charged |
| Console, Takaful | Participant risk fund, investment fund and operator fund balances, qard hasan, and the surplus run blocked until the actuary, the Shariah Committee and the board have all signed |
| Console, Onboarding / Ingestion / Parties / Regulatory / AI / Books / Labels | Chip and OCR onboarding with a review queue, any-shape file ingestion with quarantine and reconciliation, consented cross-party lookup with an access log, pre-sale gates and a motor comparison matrix, the agent action ledger with prohibited actions refused, the double-entry books with their balance proof, and per-scope renaming for the takaful window |
| Console, Durability tab | Seals the books into a canonical, fingerprinted snapshot and runs a live restore drill — rebuild a fresh ledger from the text and prove the trial balances agree |
| API | `GET /api/health`, `/world`, `/ledger/proof`, `/units`, `/state`; `POST /api/state/drill`, `/preview/switch`, `/preview/withdrawal`, `/cover/start`, `/cover/stop`, `/cover/tick`, `/pre-sale`, `/onboarding/ocr`, `/partner/lookup`, `/ai/approve`, `/ai/execute`, `/ingest/submit`, `/ingest/commit`, `/takaful/approve`, `/reset` |

## Contributing / working here

Read `AGENTS.md` first. One chunk per change, evidence stored, contracts frozen before implementation, high-risk chunks (money, units, NAV, charges, claims payouts, regulatory wording, Shariah) require named human approval.
