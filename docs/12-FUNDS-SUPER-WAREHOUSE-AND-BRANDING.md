# Funds accounting, super funds, warehouse and branding

This release adds four operator surfaces around the existing policy, NAV and ledger engines. Each surface is backed by a registry in `src/core` and a route in `src/core/routes.ts`; these are not static mock pages.

## Funds accounting

The **Funds accounting** console tab holds:

- Country accounting profiles: ISO-2 country, accounting-standard label, ledger currency, fiscal year-end and description. The starter set is AE/IFRS17, SA/SOCPA, MY/BNM-MFRS17, AU/LOCAL-GAAP (AASB 17 overlay) and GB/IFRS17.
- Country × product-line × sub-product × fund treatment rules: GL prefix, valuation method and revenue-recognition treatment.
- Dynamic mappings across country, event, product, sub-product, partner, omni-channel, sub-channel and policy. The most dimension-specific matching mapping wins; an event mapping beats a fund-wide fallback, and lower numeric priority breaks ties.
- An event simulator for receipt/deposit, accrual, premium adjustment, investment allocation, gain/loss, partial/full withdrawal, sum-assured reduction, sum-at-risk change, monthly processing and income allocation.

Every accepted event produces a debit and credit voucher with an event-specific description, all available policy dimensions, a mapping ID and a ledger journal ID. GL account IDs can name an existing ledger account; a new mapping account is registered under the chosen entity and fund. The regular ledger validates the journal and its FX base amounts before the voucher is filed. An unsupported FX path is refused, rather than silently treated as 1:1.

Main routes: `GET /api/funds-accounting`, `GET /api/funds-accounting/vouchers`, `POST /api/funds-accounting/country`, `POST /api/funds-accounting/rule`, `POST /api/funds-accounting/mapping`, and `POST /api/funds-accounting/event`.

The country-standard names and sample FX rates are demo configuration. Finance and compliance teams must file the applicable local accounting treatment and dated rates for a production deployment.

## Super funds

The **Super funds** tab has accumulation, pension and transition-to-retirement product masters, member policies, contributions, monthly charges and income allocation. Monthly fees are split by currency and charged at most once per policy per calendar month. Charges are capped at the member balance. A period's gain or loss is allocated in exact minor units by member balance through the premium-post-adjustment method; the exact amount is then posted as an event voucher.

Routes: `GET /api/super-funds`, `POST /api/super-funds/product`, `POST /api/super-funds/policy`, `POST /api/super-funds/contribute`, `POST /api/super-funds/charge`, and `POST /api/super-funds/allocate`.

## Data warehouse

The **Data warehouse** tab materialises nine actual read datasets: policy, premium receipt, NAV, claims, treaty utilisation, distribution commission schedules, super member policies, voucher lines and member balances. Each reports grain, row count, source, sample rows, freshness and lineage. CSV and JSON exports contain all rows and record an FNV-1a-64 content fingerprint.

Dashboard definitions are rendered natively in the console. Power BI, Tableau, QlikView, Qlik Sense, Databricks and Data Fabric cards are connection recipes, not claims of live external authentication. Connecting them in a deployment needs the relevant identity, endpoint, network and data-residency setup. A commission schedule fact describes filed terms; it is not shown as cash earned when the premium receipt lacks partner attribution.

Routes: `GET /api/warehouse`, `GET /api/warehouse/datasets`, `POST /api/warehouse/export` (CSV or JSON).

## Entity, partner and omni-channel theme onboarding

The Master settings tab has separate theme onboarding sections for an entity, a partner and an omni-channel. Entity colour tokens apply globally. Partner/channel layers are scoped to Master settings' distribution surfaces, the Customer journey and Underwriting/quotation generation, with the entity layer remaining the base elsewhere. Uploads accept small PNG/JPEG/WebP/SVG assets for logo, header, footer and brand imagery. The browser samples dominant logo pixels for an AI-assisted palette suggestion; all colours remain editable before filing. No external generative-AI service is called by this demo.

The original dark console remains the fallback when a layer is disabled. Theme changes are auditable; uploads are size/type checked, and theme HTML is rendered as React rather than injected from an untrusted string.

Routes: `GET /api/themes`, `POST /api/themes/upload`, `POST /api/themes/toggle`, `POST /api/themes/remove`.

## Omni-channel sub-channels and master table sizing

The Omni-channel section now files child routes (for example, Broker → DIFC desk) beneath a parent channel, optionally links a partner on that same channel, and sets route capabilities and a commission override. Parent channels and partners cannot be removed while child routes depend on them. Voucher mappings can target the same sub-channel code.

Editable master grids now use auto table layout, wrapping headers, and controls constrained to their cells instead of forcing the former fixed input widths across a wide table. Tables still scroll within their own frame when the available viewport is narrower than their minimum content.
