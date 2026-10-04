# Central Insurance Illustration Portal

**An AI-native Insurance ERP** — life, medical, general, group, travel, unit-linked and **takaful** — with a group finance core, an end-to-end fund management engine, and micro-duration cover (daily / pay-as-you-go / start-and-stop).

> **Status: the money spine runs.** The domain core (money, double-entry ledger, NAV and dealing rules, unit-linked engine, micro-duration billing, takaful pools with surplus gates, consent, ingestion, AI governance), the API server and the operator console are implemented, typechecked, tested (145 cases) and building — and 1129 backlog chunks are claimed as done with evidence in `ledger/runs.jsonl` while the remaining 741 critical-path chunks stay honestly open.

```bash
npm install
npm run verify     # typecheck + 73 tests + build
npm run fleet      # work the backlog, one small chunk at a time
npm start          # serve the console and API on :8787
npm run tour:doc   # regenerate the guided tour from its data

# activate CI (needs a token with the `workflow` scope, or paste it in the GitHub UI):
mkdir -p .github/workflows && cp docs/ci-workflow.yml .github/workflows/ci.yml
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
| [`docs/07-TOUR.md`](docs/07-TOUR.md) | The sixty-minute guided tour of the live app, generated from `src/core/tour.ts` (the same data the console's Tour tab runs) |
| Deployment | **One click on Vercel:** [![Deploy with Vercel](https://vercel.com/button)](https://vercel.com/new/clone?repository-url=https://github.com/Raheelatta1984/Central_insurance-illustration-portal). The demo is static and self-contained — the console is the real application with the engine's recorded answers — so the build needs no dependencies, no database and no secrets. `vercel.json` runs `node tools/demo-site.mjs`, which assembles `site/` from files already in the repository. The same assembly is what the Pages workflow publishes, so the two hosts can never disagree. Locally: `npm run demo:site` then serve `site/` |
| [`docs/06-QA-REPORT.md`](docs/06-QA-REPORT.md) | What is verified today, the bugs QA found and fixed, and what is still open |
| [`docs/ci-workflow.yml`](docs/ci-workflow.yml) | The CI pipeline (typecheck → tests → build → a small fleet pass). GitHub refuses to accept a workflow file from a token without the `workflow` scope, so it lives here verbatim; to activate it, copy it to `.github/workflows/ci.yml` (one command, below) or paste it in the GitHub web UI. |
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
| Console, Tour | A sixty-minute guided walkthrough with a clock and a checklist, held as data in `src/core/tour.ts`: eleven steps, each saying where to go, what to press, what you should see and why it matters |
| Console, Group finance | Three entities in two currencies consolidated into one balance sheet: assets and liabilities at the closing rate, income and expenses at the period average, equity at the rate on the day it moved; the gap becomes a translation reserve on its own line instead of a rounding account; intercompany balances and trading are eliminated with anything that does not agree shown as in transit; a 30% minority is stated, not absorbed; and the whole thing balances in a group ledger that proves itself like any other |
| Console, Underwriting | Risk scoring from a manual held as data (age, build, occupation, pursuits, medical history, family history, financial underwriting and evidence bands), with the loading shown line by line; the case goes to a named human when the rules say refer; anything over the automatic binding limit is flagged for the reinsurer before issue; and an AI agent may accept or rate inside its own limit but never decline |
| Console, Claims | Triage decides straight-through, referral or decline; reserves are booked movements, not notes; approvals are checked against a real authority table (an AI agent is capped below any human); settlement releases the reserve, recoveries are posted as their own income and the position is read back from the ledger. In the takaful window the same workflow is wired to the participants' risk fund, so a pooled claim moves cash exactly once |
| Console, Reinsurance | The treaty register is the module: a quota share that takes its percentage of every risk, a surplus treaty that responds above a retention, catastrophe cover that responds only inside its band, and a facultative treaty that carries nothing until the reinsurer has accepted that named risk in writing. Cession posts ceded premium as an expense, the ceding commission as income and the reinsurer's share of a claim as a receivable — so the recoverable on the utilisation statement equals the account in the ledger. The takaful window has its own retakaful treaty and its own register: participant risk money offered to a conventional reinsurer is refused in code, not in a policy document | The same register holds the **security behind every counterparty's promise**: a recoverable plus the treaty's premium margin is what must be secured, cash and withheld premium are posted (restricted cash against a returnable security liability) while letters of credit are counted and disclosed rather than posted as money, a **cash call** asks for the shortfall and nothing more, releasing security that would leave an exposure unsecured needs a named approver — and interest on a retakaful counterparty's cash is refused outright, because it would be riba. The same tab carries the **reporting extracts**: the supervisory return in four schedules, the actuary's exhibits (technical provisions, cession and retention, loss ratios, and the month-by-month run-off), and a bordereau per counterparty. Every control names the ledger account it compares against, an extract that does not tie is refused issue, an issued extract is fingerprinted and immutable, and a reissue for the same period supersedes the last one with a written reason rather than editing it.
| Console, Decision theatre | "Switch today" and "withdraw today" priced with the live engine, plus labelled projection envelopes for the suggested portfolio — an illustration, never advice |
| Console, Cover control | Start/stop cover, see that nothing restarts by itself, advance the clock and watch only the days inside an active window get charged |
| Console, Takaful | Participant risk fund, investment fund and operator fund balances, qard hasan, and the surplus run blocked until the actuary, the Shariah Committee and the board have all signed |
| Console, Onboarding / Ingestion / Parties / Regulatory / AI / Books / Labels | Chip and OCR onboarding with a review queue, any-shape file ingestion with quarantine and reconciliation, consented cross-party lookup with an access log, pre-sale gates and a motor comparison matrix, the agent action ledger with prohibited actions refused, the double-entry books with their balance proof, and per-scope renaming for the takaful window |
| Console, Durability tab | Seals the books into a canonical, fingerprinted snapshot and runs a live restore drill — rebuild a fresh ledger from the text and prove the trial balances agree |
| API | `GET /api/health`, `/world`, `/ledger/proof`, `/units`, `/state`, `/claims`, `/underwriting`, `/group`; `POST /api/state/drill`, `/group/consolidate`, `/underwriting/decide`, `/claims/register`, `/claims/approve`, `/claims/settle`, `/preview/switch`, `/preview/withdrawal`, `/cover/start`, `/cover/stop`, `/cover/tick`, `/pre-sale`, `/onboarding/ocr`, `/partner/lookup`, `/ai/approve`, `/ai/execute`, `/ingest/submit`, `/ingest/commit`, `/takaful/approve`, `/reset` |

## Contributing / working here

Read `AGENTS.md` first. One chunk per change, evidence stored, contracts frozen before implementation, high-risk chunks (money, units, NAV, charges, claims payouts, regulatory wording, Shariah) require named human approval.
