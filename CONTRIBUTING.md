# Contributing

Workers (human or agent) follow [`AGENTS.md`](AGENTS.md) — the claim/evidence/risk-gate
contract. The short version for a code change:

## Setup

```bash
nvm use            # Node 22 (see .nvmrc / package.json engines)
npm install
npm run verify     # typecheck + lint + tests with coverage + build (must be clean)
npm start          # console + API on :8787 (demo mode unless PORTAL_AUTH_TOKENS is set)
```

## Rules that bite

- Money is `bigint` minor units via `src/core/money.ts` — never floats near money.
- CSV goes through `src/core/csv.ts`; hashing/tokens through `src/core/hash.ts`; request
  validation through `src/core/validate.ts`. Don't hand-roll a second one.
- Every new endpoint lands with a route in `src/core/routes.ts`, a test, and a regenerated
  API reference (`npm run docs:api`). CI fails if `demo/` or `docs/API-REFERENCE.md` drift.
- `npm run verify` regenerates the demo bundle deterministically; commit the regenerated
  `demo/` files when behaviour changed.
- One backlog chunk per PR; money/NAV/Shariah/regulatory changes need the human gate in
  `AGENTS.md` §4.

## What's New is automatic — write a good PR body

Do not edit `WHATS_NEW_SEED` for a new release. `.github/workflows/whats-new.yml` publishes the
What's New entry from your PR: proposed on open, shipped on merge into `main`. Use a
conventional-commit-style title (`feat:`, `fix:`, `security:`, `data:` …) or a `feature` / `fix`
/ `security` / `data` label, and write the body as:

```markdown
## Why
The operator problem this change solves.

## What changed
What the console/API does differently now.

## What you need to do
The action an operator should take after the merge.
```

Missing sections get documented template fallbacks; editing the PR body regenerates the note.
Add the `whats-new:skip` label for an internal/tooling PR. The generator writes
`backlog/whats-new-auto.json` and `src/core/whatsnew.auto.ts` and rebuilds the offline demo —
never edit the generated module by hand. `npm run whats-new:check` (also a CI step) fails if the
two files drift. Design: [`docs/28-AUTOMATIC-WHATS-NEW.md`](docs/28-AUTOMATIC-WHATS-NEW.md).

## Optional checks

```bash
npm run smoke      # HTTP-level server + transport tests only
npx playwright install chromium && npm run build && (npm start &) && npm run test:e2e
```
