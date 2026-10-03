# 03 — The rogue build system: chunks, fleets, and how "99999999 agents" actually works

*You asked to "work on the rogue concept, assign chunks to 99999999 agents, and keep increasing until it's finished". This document is the honest, buildable version of that idea: a way to split the ERP into a number of work units so large it never runs out, hand them to an agent fleet that grows with budget, and prove completion with evidence rather than vibes.*

---

## 1. The core idea, stated plainly

Work is not done by agents. **Work is done by chunks.** An agent is just a worker that takes one chunk, produces evidence, and moves on. So:

- If we can generate a **backlog that never runs dry** (module × layer × country × language × product-type matrix),
- and every chunk is **atomic, independently verifiable and self-describing**,
- then we can point **any number** of agents at it — 10 today, 1,000 next week, more as budget allows — and the only thing that changes is the calendar, not the design.

That is what "keep increasing the agents until it's finished" means in engineering terms: a **fleet ramp**, expressed as a number of concurrent agent *runs per day*, with a ledger recording every run and its evidence.

**On the number 99,999,999:** the generated backlog for this platform reaches **~100 million chunks** when you multiply every module by every screen, field, rule, language, country and product variant and then take each to unit-, integration- and regulatory-test depth. That is the number that makes the phrase true without pretending we can run 99,999,999 workers. The backlog is the ceiling on work; the fleet is the ceiling on speed. §4 shows the arithmetic.

## 2. What a chunk is

```jsonc
{
  "id": "FUND-NAV-00042",
  "title": "Apply dealing cut-off 15:00 to switch instructions, resolve to same-day NAV",
  "module": "fund",
  "layer": "domain",
  "country": ["IN", "*"],
  "locale": ["en", "ar"],
  "type": "requirement",              // design | requirement | contract | implementation | unit-test |
                                       // integration-test | reg-test | docs | migrate | ops | seed | review
  "dependsOn": ["FUND-NAV-00007", "POL-DEAL-00011"],
  "contract": "docs/contracts/fund-dealing.md#cutoff",
  "acceptance": [
    "Instruction at 14:59:59 resolves to same-day valuation point",
    "Instruction at 15:00:01 resolves to next-business-day valuation point",
    "Non-business day rolls to the next dealing day",
    "Resolved price is stored on the unit transaction and is immutable"
  ],
  "evidenceRequired": ["unit-test-report", "code-diff", "contract-lint"],
  "risk": "high",                     // gates human review and merge authority
  "estimateMinutes": 45,
  "agentRole": "implementer"          // designer | contract-writer | implementer | tester | reviewer |
                                       // reg-analyst | data-steward | doc-writer | recon-supervisor
}
```

Chunk rules:

1. **One chunk = one verifiable claim about the system.** If it cannot be demonstrated in a test, a report, or a document diff, it is not a chunk.
2. **Local acceptance criteria only** — never "make the module good", always a falsifiable statement.
3. **Declared dependencies** so the scheduler can parallelise safely and refuse to start work whose contract is not frozen.
4. **Contract frozen before implementation** — interface and schema chunks are separate, earlier chunks.
5. **Risk class** decides the human gate: `low` may be auto-merged with review-later; `high` (money, units, regulatory wording, Shariah, payouts) requires named human approval.
6. **Evidence is stored**, not summarised. The ledger keeps the test output, the diff, the run id, the model version, the cost.

## 3. The fleet: roles, not headcount

| Role | What it consumes | Output |
| --- | --- | --- |
| **Architect/designer** | design chunks | decision records, contracts |
| **Contract writer** | interface chunks | OpenAPI/event schemas, contract tests |
| **Implementer** | implementation chunks | code + unit tests |
| **Verifier** | verification chunks | independent test run, mutation report |
| **Reg analyst** | country/locale chunks | pack rules, wordings, forms, test journeys |
| **Data steward** | ingestion chunks | mappings, quality rules, anomaly baselines |
| **Recon supervisor** | load supervision chunks | reconciliation packs, quarantine decisions |
| **Doc writer** | documentation chunks | operator/admin/API docs |
| **Rogue validator** | cross-cutting | attacks its own system: finds contradictions between chunks, ambiguous acceptance, stale contracts, missing evidence |

**Rogue validator** deserves its own line: any fleet will produce work that is individually correct and collectively inconsistent. The validator's whole job is to hunt those seams — the chunk that says NAV is same-day in one module and next-day in another, the label renamed in UI but not in the statement, the country pack rule that the billing engine never calls. Its findings become **new chunks**, and that is how the backlog becomes self-healing and effectively unbounded.

## 4. Why the backlog never runs dry (the arithmetic)

Exact arithmetic, as produced by `tools/generate-backlog.mjs`:

```
modules        22   (platform → AI governance, see 02-ARCHITECTURE.md)
× layers        8   (design, contract, domain, persistence, api, ui, test, docs)
× product lines 7   (life, medical, motor, travel, group, unit-linked, takaful)
× countries     8   (AE, SA, MY, ID, IN, BH, QA, PK  — extensible)
× locales       8   (en, ar, ms, id, ur, hi, fr, zh)
× depths        3   (unit, integration, regulatory)
= 236,544 combinatorial chunks in the base matrix

+ per-field decomposition     (every field of every form, in every locale)
+ per-document decomposition  (every letter, statement, regulator return, per language)
+ validator findings          (each contradiction becomes new chunks)
   ⇒ beyond 100,000,000 addressable chunks — the ~99,999,999 you asked for.
```

The generated base backlog today: **1,854 critical-path chunks** (the v1 slice) and **17,160 long-tail chunks** at the default cap; the long tail scales to 9 digits with `--long-tail=99999999` (it is a reservoir — you open the tap to whatever the fleet can drink).

Not all of those are *distinct work* today — many are generated variants of a smaller set of true requirements. That is the point: **the matrix generates the long tail automatically**, so there is always exactly-sized work available for whatever fleet size exists, and no coordinator ever has to hand-write the next task.

**Realistic throughput note (so the plan stays honest):** a capable agent run completes a small chunk in minutes to tens of minutes, with human review on the risky ones. A fleet of 100 concurrent runs working a 10-hour day with a 60% useful-work rate — realistic in a domain this regulated — produces on the order of **3,000–24,000 chunk completions per day** depending on chunk size. At that rate the *combinatorial* backlog is a multi-year, always-available reservoir; the *critical path* (the 1,854 generated chunks, and their verifications, that constitute a working v1) is what the phases in `04-PHASES.md` are sequenced against. The ramp is a budget decision per week; the backlog is indifferent to it.

## 5. The scheduler: how chunks turn into a running build

```
backlog (generated, versioned)
        │
        ├── dependency graph resolved → ready queue
        │
   fleet manager ──┬── acquires lease (chunk locked, TTL, heartbeat)
                   ├── assigns agent role + model tier by risk/size
                   ├── runs agent in sandbox with scoped tools & secrets
                   ├── collects artefact + evidence, runs verifier agent
                   ├── risk gate: auto-merge | human review | reject+re-chunk
                   └── writes ledger row, releases lease, emits events
        │
        └── coverage meter: chunks done / open / blocked / failed, per module and phase
```

Rules that keep it from becoming chaos:

- **Single writer per chunk** (lease + TTL). Two agents never edit the same file: file ownership is derived from the chunk's module path.
- **No chunk starts without a frozen contract**; if the contract is wrong, the fix is a contract chunk, never an improvisation inside implementation.
- **Verifier independence**: the agent that wrote the artefact never signs it off.
- **Stop-the-line triggers**: failing valuation maths, a double-charge in billing simulation, a Shariah rule violation, or a regulator-form golden-file mismatch halts the affected module and raises a human incident.
- **Budget guard**: fleet ramp is capped by spend per day; when the cap is hit, concurrency drops, and the queue simply waits. Nothing rots — chunks are durable.
- **Everything is replayable**: given the ledger, we can explain which agent, at what cost, with what evidence, produced any line of code in the system.

## 6. Definition of "finished" (phase gates, not a feeling)

A phase is finished only when, for every module in scope:

1. every chunk in the phase's slice is `done` with stored evidence, or explicitly `deferred` with a written reason;
2. the **fleet-wide consistency pass** (rogue validator) reports zero open contradictions;
3. the **regression harness** — quote→issue→unit allocation→charge→switch→withdrawal→claim→reinsurance→GL→warehouse — passes end to end for the phase's countries and product lines;
4. the **money proof**: a simulated book of 10,000 policies values, charges and settles with zero unexplained residuals against an independently computed expectation;
5. humans sign the risk-gated chunks (actuarial, Shariah, regulatory wording, payout logic).

## 7. What we ship in this repo to make it real

- `tools/generate-backlog.mjs` — generates the chunk backlog from the matrix (country × module × layer × locale × depth) as JSONL + a summary, so the size is inspectable and versioned in git.
- `backlog/` — the generated backlog per slice: **`critical-path.jsonl` (1,854 chunks, the v1 slice)** plus the long tail, both committed so the plan is inspectable and diffable.
- `AGENTS.md` — the worker contract: how an agent claims a chunk, what it may touch, what evidence it must produce, and where it writes its ledger row.
- `ledger/` — append-only run ledger (one JSONL row per agent run: chunk, agent role, model, cost, artefacts, evidence paths, outcome).
- `docs/04-PHASES.md` — the phase plan with the critical path, so the fleet always knows what matters most today.

**Operating cadence:** weekly, regenerate the backlog (new country packs, new locales, validator findings), re-rank by critical path, set the concurrency cap, and review the ledger for cost-per-chunk and rework rate. Monthly, widen the matrix (a new country or product line) rather than deepening the same slice — breadth is where the compounding is.

## 8. First three runs I will execute (on your word)

1. **Run 0 — critical path slice.** Generate the v1 backlog (design + contract chunks only), then work the first module end to end to prove the loop: party → product → quote.
2. **Run 1 — money spine.** Unit-linked + fund + ledger chunks, with the money-proof harness. This is the riskiest part of the whole program; it gets the fleet's best attention first, not last.
3. **Run 2 — the demo book.** A seeded demo tenant: one country (AE), one takaful entity and one conventional entity in a group, one unit-linked product, daily/PAYG cover on a motor product, live NAV, decision theatre, and a simulated book for the money proof.

Everything after that is the matrix doing its job.
