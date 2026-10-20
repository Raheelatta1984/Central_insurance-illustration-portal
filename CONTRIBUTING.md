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

## Optional checks

```bash
npm run smoke      # HTTP-level server + transport tests only
npx playwright install chromium && npm run build && (npm start &) && npm run test:e2e
```
