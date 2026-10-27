# 25 — ReconIQ-to-portal integration map

**Status: proposed mapping; see the [foundation contract](26-RECONCILIATION-FOUNDATION-CONTRACT.md) for the limited identity-matching slice.** Source: the user-supplied `uaebrokers-main.zip` (SHA-256 `53abb55c0e76956c518383b33d3c007f5c488cf29d1f884641abf2c14b943031`), inspected read-only. The archive is GPL-3.0; the target repository is proprietary. On 2026-10-27 the requester stated they own ReconIQ and authorized reuse; complete normal distribution/license review before release. All target paths in this document that do not already exist are suggestions, not claims of implementation.

## Reference modules to target responsibilities

| Reference | Behavior to preserve or assess | Proposed target location / boundary | Changes required |
| --- | --- | --- | --- |
| `reconiq/normalize.py` | Policy-key normalization and guarded variants; name/insurer normalization; date, money, percentage and currency parsing; endorsement-parent recognition. | A pure TypeScript normalization module under `src/core/reconciliation/`, using `src/core/money.ts` where its exact minor-unit representation is suitable. | Make locale/date/rate interpretation explicit; never default an ambiguous currency or infer a payable rate. Use currency-specific precision and approved exact FX, not hardcoded AED rates or float totals. |
| `reconiq/schema.py` | Canonical fields, header scoring, mapping confidence, explicit mapping confirmation; rate headers cannot be mistaken for commission amounts, VAT or tax. | Versioned canonical input types/mapping service under `src/core/reconciliation/`; persistent `SourceFile`/`ColumnMapping` via a scoped repository; partner mapping UI within `src/ui/partner-portal.tsx`. | Extend the fields below; authorization IDs come from trusted context, not uploaded cells. Low-confidence/ambiguous money fields require human confirmation. |
| `reconiq/ingest.py` | Delimited CSV/text, XLSX sheet/header discovery and text-based PDF table/position extraction; totals/empty rows excluded; scanned PDF is refused, not silently accepted. | Server-side ingestion adapters with bounded, typed tables and provenance; private document store and asynchronous scan/parse service, then pure domain records. | Validate bytes and MIME, limits and expansion, malicious spreadsheets/PDFs and malware; preserve full input hash and per-row provenance. Treat truncated/unsupported/OCR-needed files as non-payable until resolved. Select reviewed Node libraries only after dependency/security review. |
| `reconiq/engine.py` | Exact keys, safe variants, probable-match suggestions, comparisons, findings, duplicate/endorsement checks, insurer scoping and summaries. | `src/core/reconciliation/` pure domain service invoked by scoped partner/insurer services; persist runs, pairs and findings transactionally. | Partition by trusted insurer/partner/class; no probable match becomes confirmed without a recorded human action. Replace defaults, inferred identity and process-local output with approved, immutable, reproducible run context. |
| `tests/test_normalize.py`, `test_schema.py`, `test_ingest.py`, `test_engine.py` | Examples/regressions for parsing, mapping, ingestion, exception categories and tolerance sensitivity. | Vitest domain/service tests and synthetic Playwright journeys; DB authorization/integration tests on Postgres. | Use synthetic tests/fixtures only; add adversarial multi-tenant, financial boundary and concurrency tests. Reference demo FX/severity assumptions are not production expectations. |
| `app/main.py`, `app/static/` | Prototype-only upload/session/export UI. | Existing Node server, route catalogue and React partner shell; proposed insurer/admin/AP screens in the same application. | Do not copy public unauthenticated endpoints, session state or a parallel application. Add scoped persistent APIs and immutable exports instead. |

## Matching and finding safety differences

1. ReconIQ groups duplicate keys and keeps a first row for further matching; production must flag/quarantine ambiguous duplicates rather than silently choose a financial line.
2. Its variant matcher treats a missing insured name as `same_name = True`; this can accept a variant without corroborating name or premium. A production variant must have **present**, independent corroborating evidence and a unique candidate within the authorized insurer, ownership and insurance-class partition. Ambiguous cases remain unresolved.
3. Its probable stage labels pairs as `probable`, but includes them in a matched-pairs list and consumes them during the run. Preserve suggestions while ensuring an unconfirmed suggestion does not create a confirmed pair or payable evidence. A human confirmation must be attributable, scope checked and versioned.
4. ReconIQ can infer an insurer by labels or matching rows. Production authorization and owner assignment must use an authoritative insurer identifier and membership; inference may inform a review but never widen scope.
5. The reference's schema aliases include `netpremium` under `premium` and `netpayable` under `commission_amount`. Those concepts are not interchangeable for a payable calculation; map gross premium, net premium, commission and net payable separately and require explicit confirmation when ambiguous.
6. Prototype thresholds, indicative FX, AED defaults, day-first date handling, fraction/percent assumptions and float serialization are not approved financial policy. Resolve each from versioned insurer-controlled configuration, or hold the affected line/run when ambiguous.
7. The source `CATEGORIES` dictionary defines **14** named categories, despite the supplied README and brief describing 16. Preserve the 14 actually defined and ask the business owner to identify or approve any additional categories; do not invent them to satisfy a count.

The 14 source keys are `premium_mismatch`, `commission_mismatch`, `sum_insured_mismatch`, `date_mismatch`, `name_mismatch`, `status_mismatch`, `currency_mismatch`, `missing_in_insurer`, `missing_in_broker`, `duplicate_in_statement`, `duplicate_in_broker`, `low_confidence_match`, `endorsement_not_in_book`, and `insurer_not_in_statements`. Names in the eventual contract may be modernized with an explicit mapping; the business meaning and source lineage must not be lost.

## Canonical fields

These are target *domain destinations*, not current database columns. Every uploaded value remains linked to its source file, row and confirmed mapping; authoritative ownership and reference identities are resolved server-side. Raw source text does not grant access or override the insurer's records.

### Existing reference fields

| ReconIQ field | Proposed canonical destination / notes |
| --- | --- |
| `policy_no` | `Policy.policyNumber` / source policy number; exact and normalized forms retained separately. |
| `insured_name` | Protected policy party/insured display field; used for evidence, never authorization. |
| `insurer` | Source insurer label; resolve to trusted `Insurer.id`, do not treat the label as authority. |
| `class_of_business` | Source label mapped to configured `InsuranceType.id`; unresolved labels quarantined. |
| `inception_date`, `expiry_date` | Policy coverage boundaries as local dates with provenance. |
| `sum_insured` | Exact amount and currency on policy/statement line. |
| `premium` | Separate source premium and mapped `grossPremium`/`netPremium` with explicit basis; ambiguity requires review. |
| `commission_pct` | Exact commission-rate representation and rate version; percent versus fraction confirmed. |
| `commission_amount` | Exact source commission amount and currency, **not** automatically a net payable. |
| `currency` | Explicit currency code from verified mapping/context; no silent default. |
| `status` | Policy status plus effective date/event, distinct from commission status. |
| `broker_ref` | External source/reference identifier and provenance, not a tenant key. |

### Required extensions

| Field(s) | Proposed target responsibility |
| --- | --- |
| `insurer_id`, `channel_partner_id`, `subpartner_id` | Server-derived insurer and ownership scope on policies, files, runs, statement versions/lines and payment instructions. Validate any imported identifiers against context. |
| `channel_type`, `subchannel_type` | IDs referencing insurer-managed configuration; no hardcoded enum/schema change to add types. |
| `insurance_type_id` | Class identifier on policy, run and line, with separately reconcilable partitions. |
| `contract_id`, `contract_version` | Immutable effective contract reference on rules, run and statement line. |
| `policy_issue_date`, `inception_date`, `expiry_date` | Authoritative policy dates plus source and time-zone/date interpretation. |
| `free_look_start`, `free_look_end`, `free_look_rule_version` | Approved derived boundaries/rule provenance; missing or ambiguous rules exclude rather than invent entitlement. |
| `policy_status`, `status_effective_date`, cancellation/withdrawal/lapse dates and reasons | Authoritative status and immutable `PolicyEvent` records. |
| `endorsement_number`, `parent_policy_number` | Explicit endorsement identity and parent link, not merely a guessed suffix. |
| `commission_status`, `commission_rule_version`, `commission_rate_version` | Contract-eligible status and applied approved rule/rate version. |
| `gross_premium`, `net_premium`, VAT/tax, currency, FX rate | Individually typed exact amounts and applied approved FX/version/rounding; no implicit currency aggregation. |
| `commission_amount`, `clawback_amount` | Separate exact components, event and prior-payment linkage, not an opaque net figure. |
| `statement_period`, `reconciliation_run_id` | Explicit start/end/timezone and links to immutable run and statement version. |
| source-system identifiers and provenance | Original system/file/hash, row and event IDs, mapping and authoritative data snapshot/version. |

## Existing target integration seams

- `src/core/routes.ts`, `src/core/route-catalogue.ts`, `src/server/main.ts`, `src/server/auth.ts`: preserve JSON/request-id/rate-limit conventions; introduce a real verified identity adapter and server-side, per-object checks. The current in-memory idempotency registry is not sufficient for payments.
- `src/core/channels.ts` and `src/core/partner-portal.ts`: migrate or bridge through reviewed interfaces; their fixed kind unions, flat partner shape, demo rates and process-local records are not the target security/financial model.
- `src/core/money.ts`: integrate its currency-aware bigint minor units only through an explicit, verified boundary. Use an audited arbitrary-precision decimal type for all reconciliation money, commission, rates and FX calculations; persist decimal strings/SQL `numeric`, never JS floating-point money.
- `src/core/mailer.ts` and `src/core/email-config.ts`: reuse transport and template concepts behind a durable outbox/contact directory. `not-sent`, provider-accepted and actual remittance are distinct outcomes.
- `src/ui/partner-portal.tsx`, `src/ui/api.ts`, `src/core/labels.ts`: extend the existing React shell and label registry only when server authorization and feature gates are in place; do not trust client role selection.
- `docs/partner-portal.openapi.json`, Vitest, Playwright and `.github/workflows/ci.yml`: extend the contract and test suites in their respective phases; add real Postgres/RLS and synthetic workflow checks. Do not silently lower coverage thresholds.
