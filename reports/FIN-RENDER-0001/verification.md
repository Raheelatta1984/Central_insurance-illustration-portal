# FIN-RENDER-0001 — Render live operations and Pages publishing fix

Status: local automated verification passed; owner authorization recorded in the Arena session.

## Authority

Raheel Atta (`Raheelatta1984`) instructed: “Unblock and authorized the live financials operations don't
block or keep outstanding keep working towards configuration/source/providers not more gates.”
Follow-up: “Please proceed now and we are not deployed on vercel we are using render so keep hold on
vercel related issues.”

## Pages investigation

Failed run: https://github.com/Raheelatta1984/Central_insurance-illustration-portal/actions/runs/42199198736
Failed step: `actions/configure-pages@45bfe0192ca1faeb007ade9deae92b16b8254a0d`.
Annotations: `Get Pages site failed: Not Found`; `Create Pages site failed: Resource not accessible by integration`.
Repository Pages API returns 404; `has_pages=false`. Attempts to create/update the Pages site with the
available GitHub token return 403. The workflow therefore no longer attempts forbidden auto-creation;
it preflights, warns and skips until Settings → Pages → Source: GitHub Actions is set, then publishes.

## Render / live financial wiring

- `render.yaml`: Node web service + PostgreSQL 16, health `/api/health`, pre-deploy `finance:bootstrap`.
- `tools/financial-bootstrap.mjs`: idempotent migrate-up + empty-book initialization; environment
  mismatch and overwrite refused; no seeded rates/policies/NAVs/approvals.
- `src/server/financial/adapters.ts`: HTTPS payment verifier, card provider and source reader adapters;
  bearer auth, idempotency keys, timeout, fail-closed errors, no demo fallback, no raw PAN/CVV.
- Runtime wires adapters into `FinancialService`; scheduler remains durable/catch-up.
- Vercel was not changed.

## Local evidence

- `npm run verify`: exit 0 (`/home/user/verify-render-live.log`).
- `npm run docs:api`: exit 0; What's New `--check` in sync.
- `npx vitest run src/server/financial src/server/main.test.ts`: 4 files / 35 tests passed.
- `src/server/financial/adapters.test.ts`: 6 tests passed.
- `node tools/security-guard.mjs`: passed. `node tools/security-audit.mjs`: no high/critical.
- CI native PostgreSQL job extended to exercise `finance:bootstrap` idempotence and environment-mismatch refusal.
