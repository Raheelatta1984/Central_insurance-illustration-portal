# AGENTS.md — the worker contract

*Any agent (human-directed or autonomous) working in this repository follows this contract. It exists so that thousands of independent workers can produce one coherent system.*

---

## 1. Claiming work

1. Read `backlog/<slice>.jsonl`. Take a chunk whose `dependsOn` are all `done`.
2. Acquire the **lease**: append a claim row to `ledger/runs.jsonl` with `{chunkId, agentRole, startedAt}`. A chunk with an open lease is invisible to other workers.
3. Never work a chunk whose `contract` reference does not exist or is marked `draft`. Fix the contract first as its own chunk.

## 2. Ownership rules

- A chunk touches **only** the paths owned by its module (see `docs/02-ARCHITECTURE.md` §1 for the module map).
- Cross-module change = **new contract chunk** + two module chunks. Never reach into another module's tables or files.
- One writer per chunk. One chunk per branch/PR. No opportunistic refactors inside a feature chunk — raise a new chunk instead.

## 3. Required evidence

A chunk is not done until all of the following are stored and linked from its ledger row:

| Type | Evidence |
| --- | --- |
| design | decision record with alternatives considered |
| contract | schema/OpenAPI file + contract test proving both sides agree |
| implementation | diff + unit tests + typecheck clean |
| integration | test run reproducing the acceptance criteria end to end |
| reg / country pack | rule tests + example journey + generated form golden files |
| docs | the document itself + link from the module's README |
| verification | **independent** re-run by a different agent role, mutation report where applicable |

Evidence is a link or a path, never a summary sentence.

## 4. Risk gates

| Risk | Examples | Required |
| --- | --- | --- |
| low | docs, seeds, test scaffolding, dev tooling | auto-merge, review later |
| medium | single-module logic, APIs without money movement | verifier agent approval |
| high | money, units, NAV, charges, billing sweeps, regulatory wording, claims payouts, Shariah logic | **named human approval**, plus verifier agent |

Stop-the-line: a failing valuation calculation, a double-charge in simulation, a Shariah rule violation, or a regulator-form golden-file mismatch **halts that module** and raises a human incident. Do not route around it.

## 5. Writing rules

- Money is decimal, never float. Currency is explicit on every amount.
- Every state change is auditable and, where money is involved, **reproducible from the transaction log**.
- Every user-facing string comes from the label registry — **never** a literal in code.
- Every date/time decision states the timezone and the calendar (dealing day, business day, valuation day).
- Every list query is paginated; every external call is idempotent; every bulk operation is resumable.
- Tests state the *reason* the behaviour matters, not just the mechanic.

## 6. Ledger row (append-only)

```jsonc
{
  "chunkId": "FUND-NAV-00042",
  "agentRole": "implementer",
  "model": "…",
  "startedAt": "2026-10-04T09:12:00Z",
  "endedAt": "2026-10-04T09:41:00Z",
  "outcome": "done",            // done | blocked | failed | re-chunked
  "artefacts": ["packages/fund/src/dealing.ts"],
  "evidence": ["reports/FUND-NAV-00042/unit.xml"],
  "costUsd": 0.42,
  "notes": "cut-off rule read from product version, not hardcoded"
}
```

## 7. When blocked

Write a `blocked` ledger row with the exact missing input (a decision, a licence, a human signature, another chunk). Do **not** invent regulatory intent, Shariah rulings, or actuarial assumptions to unblock yourself. Escalate a chunk into the human queue; the scheduler will work something else.
