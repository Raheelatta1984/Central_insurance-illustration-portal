# Central Insurance Illustration Portal

**An AI-native Insurance ERP** — life, medical, general, group, travel, unit-linked and **takaful** — with a group finance core, an end-to-end fund management engine, and micro-duration cover (daily / pay-as-you-go / start-and-stop).

> **Status: design phase.** The repository currently holds the full understanding, market analysis, architecture, phase plan and the generated work backlog. No application code yet — by design: the contracts come first, then the fleet builds against them (`docs/03-ROGUE-BUILD-SYSTEM.md`).

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

## Contributing / working here

Read `AGENTS.md` first. One chunk per change, evidence stored, contracts frozen before implementation, high-risk chunks (money, units, NAV, charges, claims payouts, regulatory wording, Shariah) require named human approval.
