# Batch processing, What's New, warehouse connection security and the Application theme tab

This document covers four changes shipped together. Each one also has a filed entry on the
console's **What's New** tab (`src/core/whatsnew.ts`), written in the Why / What / What-you-need-to-do
shape that tab exists to enforce.

## 1. Batch processing (new tab)

`src/core/batch.ts` · UI `src/ui/batch-views.tsx` · API `GET /api/batch`, `POST /api/batch/setup`, `POST /api/batch/run`

Nine events are set up once as **event-based accounting** definitions — debit account, credit
account, description template, schedule, basis, rate (bps), applicable subject statuses:

| Event | Applies to | Schedule |
| --- | --- | --- |
| Quotation generation | open quotations | daily + on-demand |
| Illustration generation | open quotations | daily + on-demand |
| Policy issuance | accepted/open quotations | daily + on-demand |
| Monthly anniversary — mortality / cost of insurance | in-force, paid-up policies | policy anniversary day |
| Monthly anniversary — premium accrual | in-force | policy anniversary day |
| Monthly anniversary — commission accrual | in-force, paid-up | policy anniversary day |
| Monthly anniversary — commission clawback | **lapsed, surrendered, fully-withdrawn** | monthly / on leaving |
| Monthly anniversary — fund management charge | in-force, paid-up | policy anniversary day (rate ÷ 12) |
| Monthly anniversary — dividend distribution | in-force, paid-up | after declaration |

Rules enforced in the registry, not in the UI:

- No setup, no run: an event with no filed debit/credit definition, or a disabled event, is refused.
- **Stop rule:** a quotation or policy is processed only while alive. Lapse, full withdrawal,
  surrender, maturity, claim-out, expired or declined subjects appear as `skipped-terminal` with
  the reason — they are never charged. Clawback is the single deliberate exception because its
  purpose is recovering commission from leavers.
- **Idempotency:** the key is `job + period + subject`. Re-running a period reports
  `duplicate-skipped`, never a second charge. A `failed` line can be retried without reprocessing
  successes.
- Amounts are integer minor units (`bigint`): `basisMinor × rateBps / 10,000` (÷ 12 for the
  annual fund management charge). Subjects are built from the live ERP policies/proposals
  (`batchSubjectsFromWorld`), plus visible demo leavers so the stop rule can be seen working.

High-risk note: these are money-moving jobs. Under `AGENTS.md` §4 they require named human
approval in production; the console run button is the operator surface, not the approver.

## 2. What's New (new final tab)

`src/core/whatsnew.ts` · UI `src/ui/whatsnew-views.tsx` · API `GET /api/whats-new`, `POST /api/whats-new`, `POST /api/whats-new/from-commits`

Every entry answers, in order: **Why** does this exist, **What** changed, **What you need to do** —
plus category, source (commit / PR / change request), the console area to open, and risk.
`generateFromCommits` drafts entries from commit records: a conventional-commit prefix
(`feat:`, `fix:`, `security:`, `data:`, breaking `!`) sets the category, the first body paragraph
becomes Why, the second becomes What, and the action line is templated by category. Drafting is
local and template-based (no external AI service is called); a deployment may put an LLM behind
the same interface, but the filed entry remains the auditable record. Entries that do not say
why/what/action are refused by the registry.

## 3. Data warehouse — Snowflake, Excel, Access, validated secrets, breach agreement, rotating PII masking

`src/core/warehouse.ts` (connections) + `src/core/pii-masking.ts` · UI: Data warehouse tab →
"5. Connections — Snowflake / Excel / Access + PII masking" · API
`POST /api/warehouse/connections`, `/validate`, `/suspend`, `/sync-preview`

Connection pipeline, in the order it is validated:

1. **Data-breach agreement first.** Registration is refused unless the current agreement
   (`DATA-BREACH-AGREEMENT-2026.1`, terms shown on the tab) is accepted, current, and names who
   accepted it. Terms cover masked-only receipt, 24-hour breach notification and suspension,
   no re-identification, no cross-transaction joining, secret-store custody with 90-day rotation,
   and certified deletion on termination.
2. **Secret validation without secret storage.** Snowflake secrets ≥ 16 chars, Excel/Access API
   keys ≥ 12, no whitespace, placeholders refused, raw connection strings with embedded
   passwords refused. Only a SHA-256 **fingerprint** and a masked preview are kept; the secret
   itself is discarded and appears in no snapshot, export or log line.
3. **Target validation per kind.** Snowflake needs `<org>.<account>` + warehouse/database/schema;
   Excel needs an `https://` SharePoint/OneDrive workbook + worksheet; Access needs an
   `.accdb/.mdb` (or https-hosted) database + table with no embedded password.
   `POST …/validate` re-checks the filed steps and issues a 72-hour validation expiry;
   `…/sync-preview` refuses anything not currently validated.
4. **PII masking on every surface.** `PiiMasker` (pure-TypeScript SHA-256, FIPS 180-4, verified
   against the `abc` test vector) applies a one-way keyed hash with a **per-transaction derived
   salt that is never exported**. Dataset samples, CSV/JSON exports and connection sync previews
   are masked by default. Five methods (keyed-hash token, truncated hash, keyed format-preserving,
   domain-blind token, full redaction) **rotate on every transaction**, so the same customer masks
   differently in every drop and masked extracts cannot be joined across transactions. There is
   deliberately **no decode/unmask function** anywhere in the codebase. The demo vault secret is
   a placeholder — production supplies it from the deployment KMS/secret store.

Honest limitation (unchanged from doc 12): these are governed connection *registrations and
masked pipelines inside the demo world*, not live authenticated Snowflake/Excel/Access sessions.
Production still needs deployment endpoints, network allow-listing and identity federation.

## 4. Application theme — new top-level tab

`src/ui/theme-tab.tsx` (wrapping the existing `src/ui/theme-views.tsx` panels)

The theme feature **did already exist** — entity, partner and omni-channel layers with logo/
header/footer upload, a local dominant-colour palette assistant, preview, enable/disable and
audited upserts, all scoped correctly (entity = global; partner/channel = partner detail,
customer journey and quotation). What was missing was discoverability: it lived only as three
sections inside Master settings, so it was reasonably reported as absent. The new
**Application theme** tab (second-to-last, before What's New) hosts the same three panels at the
top level; Master settings keeps its sections, and both render the same filed layers
(`GET /api/themes`, `POST /api/themes/upload|toggle|remove`).

## Verification

`npm run verify` (typecheck + full test suite + build). New coverage: `src/core/batch.test.ts`
(stop rule, clawback exception, idempotency, setup refusal, SHA-256 vector, rotating masking,
commit→What's-New generation), `src/core/warehouse-security.test.ts` (agreement/secret/target
refusals, fingerprint-only storage, masked-by-default exports, validated-only sync preview,
batch + What's-New API round-trips), and a render test for the three new tabs in
`src/ui/platform-features.test.ts`.
