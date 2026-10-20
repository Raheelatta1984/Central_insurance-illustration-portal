# 14 — Review remediation (2026-10-20)

An external review of this repository (bugs, risky code, missing tests, documentation gaps,
developer-experience) produced the list below. This document records, item by item, what the
remediation change did, what it deliberately did differently, and what remains open — so the
state of the codebase is never better in the documents than it is in the code.

## Fixed in the remediation change

| # | Finding | Resolution |
| --- | --- | --- |
| 1 | No authentication/authorisation; `by`/`role`/`isAi` self-asserted; unauthenticated `POST /reset`; wildcard CORS | `src/server/auth.ts`: Bearer-token principals with roles from `PORTAL_AUTH_TOKENS`/`PORTAL_API_TOKEN`, a role table for claims/takaful/master/AI/reset routes, server-stamped audit actor, CORS allowlist (`PORTAL_CORS_ORIGIN`, closed by default when authenticated). No tokens ⇒ labelled demo mode; `NODE_ENV=production` refuses demo mode unless `PORTAL_ALLOW_DEMO=1`. Proven over real HTTP in `src/server/main.test.ts`. |
| 2 | Oversized bodies swallowed into `{}` and executed with demo defaults; malformed JSON → 500; char- not byte-counted limit | `src/server/main.ts`: byte-accurate limit → **413** (drained, not socket-destroyed), malformed JSON / non-object body → **400**. The executed-empty-body path no longer exists. |
| 3 | No request schema validation (283 `String(payload[…])` coercions; `"undefined"` claim ids; `Boolean("false") === true`; NaN → 500) | `src/core/validate.ts` boundary helpers, applied to previews, claims, takaful approvals, AI actions and party merge in `routes.ts`; `RequestValidationError` maps to 400 via `httpStatusForError`. Extending the helpers route-by-route is now a mechanical follow-up. |
| 4 | Tamper-evidence and buy tokens on 64-bit FNV; emailed buy link used the quotation id as its token | `src/core/hash.ts`: one SHA-256 (NIST known-answer tests incl. padding boundaries), HMAC, CSPRNG tokens, constant-work compare. `fingerprint()` is SHA-256; the buy token and buy link are CSPRNG values. Old FNV-sealed snapshots are refused as foreign-encoder and must be re-sealed (noted in `persistence.ts`). |
| 5 | PII masking secret a public constant with no way to supply a real one | `PII_VAULT_SECRET` env resolution in `pii-masking.ts`; production boot refuses the demo secret. |
| 6 | Console never sent `Idempotency-Key`; failed key-completion silent | `src/ui/api.ts` mints/sends a key per POST (reusable per intent via `ApiOptions`) and forwards a stored Bearer token; server logs any completion failure. The new HTTP tests also caught and fixed a real bug: `POST /reset` swapped the key register, defeating replay of the reset itself — the register now survives a reset. |
| 7 | Status codes guessed from error-class names; 500s leaked messages and were never logged | `httpStatusForError` (400 validation / 409 domain / 500 else); all plain-`Error` domain throws became named errors (`IngestError`, `UnitsError`, `ProductsError`, `WhatsNewError`, `PiiMaskingError`, `ProductConfigError`, `HashError`); 500s return a generic body with a request id and are logged with stack. |
| 8 | Missing tests: HTTP layer, most of the router, `journeydesk`/`decisioning`/`product-config`/`whatsnew`; no coverage | New suites: `hash`, `validate`, `csv`, `product-config`, `decisioning`, `whatsnew`, `routes` (opening reads + boundary refusals), and `src/server/main.test.ts` over a real socket. Coverage (v8) runs in `verify`/CI with ratchet thresholds (core ≈89% lines at the time of writing). `journeydesk` remains covered indirectly via the journey route suites — a dedicated unit suite is follow-up work (see below). |
| 9 | Product sheet couldn't round-trip its own export; no spreadsheet formula-injection guard; warehouse amounts silently zeroed | One codec, `src/core/csv.ts` (RFC-4180 quoting incl. embedded newlines, formula-cell disarming that still passes real negative numbers), used by product-config, rating and warehouse. `amountParts` now fails the export instead of writing `0.00`. |
| 10 | Silent catch-alls turning bugs into plausible zeros (extracts ceded share, demo seeding) | `extracts.ts` narrows the catch to the one expected `ReinsuranceError`; a failed seed now fails the boot loudly. |
| 13 | No lint/format/coverage/Node pinning; dead `eslint-disable` comments; Playwright unused for tests | ESLint flat config (correctness rules as errors — one real error found and fixed; ~60 warnings remain as a visible backlog), coverage in CI, `engines` + `.nvmrc` (Node 20), Dependabot, `tools/e2e-smoke.mjs` Playwright smoke (manual/nightly; the HTTP-level smoke runs in the suite via `npm run smoke`). |
| 14 | `npm run verify` dirtied the tree on every run; CI never checked demo drift | `offline-build.mjs` writes deterministically (re-stamps `capturedAt` only when an answer changed); CI regenerates the API reference and fails on any `demo/` or `docs/API-REFERENCE.md` drift. |
| 15 | Stale counts (654/51), stale "copy the CI file" instructions, duplicate workflow source, simulated fleet ledger cited as plain evidence; no LICENSE/SECURITY/CONTRIBUTING/API reference | Counts corrected to 701/60; `docs/ci-workflow.yml` deleted (the live workflow is the only source); the fleet ledger is labelled simulator/module-level evidence wherever its counts are cited; `LICENSE`, `SECURITY.md`, `CONTRIBUTING.md` added; `docs/API-REFERENCE.md` generated for all 178 endpoints. |
| — | Quick wins: theme upload rejecting newline-wrapped base64; no security headers/timeouts/gzip; `multiply()` float `RangeError`; batch parsing amounts with regex+float; nav accessibility | Base64 whitespace normalised; server sets `nosniff`/referrer headers, timeouts, gzip, immutable hashed-asset caching, asserted `dist/` confinement; `multiply` refuses non-integer factors with a `MoneyError`; batch labels parsed with `parseAmount`; console nav gained labels/`aria-current`/alert roles. Two wall clocks: `RuntimeState.now` is now injectable and the dispatcher uses it. |

## Done differently, on purpose

- **Bundle splitting (#11).** The console is also shipped as a *single-file* offline bundle
  (`demo/offline.html`) that must open from `file://`; `React.lazy`/chunk splitting would
  break that artefact, which is a customer-facing demo channel. The remediation instead cuts
  transfer cost in the live path (gzip JSON/assets, immutable caching for hashed assets) and
  keeps one bundle. If the offline single-file constraint is ever dropped, split per tab.
  `GET /world` is still a monolithic snapshot — per-tab snapshots remain follow-up work.
- **Authorisation depth (#1).** A token→principal map is the seam, not the destination: a
  real deployment terminates SSO/OIDC in front of this process and maps identities to these
  principals/roles (or replaces `auth.ts` with JWT verification). Tenancy isolation is still
  process-per-tenant, as documented for the demo world.

## Still open (follow-up chunks)

- **Durable state (#16).** The seal/open codec and restore drills exist and are tested, but the
  server still boots the in-memory world. Wiring boot/mutation persistence (file or Postgres)
  is the largest remaining gap between demo and pilot; `/health` now states the posture.
- **God-file splits (#12).** The remediation extracted `hash.ts`, `csv.ts`, `validate.ts`,
  `server/auth.ts` and a testable server factory, but `routes.ts` (178-case switch),
  `erp-views.tsx`, `main.tsx` and `erp.ts` were not mechanically split — that is a
  behaviour-neutral refactor that deserves its own reviewed chunks, per `AGENTS.md`.
- **Per-route validation coverage (#3)** beyond the money/approval routes migrated here.
- **Dedicated `journeydesk` unit suite (#8)** and fuller route-table coverage.
- **Bilingual PDF fonts.** `pdf.ts` still encodes WinAnsi (Arabic → `?` in the PDF only; the
  email/on-screen versions carry full Arabic). Fixing this needs an embedded font asset and
  shaping — a product chunk, not a drive-by.
- **Dependency majors** (React 19, Vite 6+, Vitest 3+): left to Dependabot PRs so each is
  reviewed on its own; within-range updates were applied here.
- **Accessibility pass** on the custom grids (keyboard model + screen-reader semantics)
  beyond the nav/alert labelling done here.
- **Two GETs with catch-up side effects** (`/reporting/store`, `/reporting/outbox`) are now
  documented in the API reference rather than redesigned; make them read-only when the
  reporting store moves to durable storage.
