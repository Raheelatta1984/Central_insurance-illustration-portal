# 11 — Product configuration, the rating tables and the omni-channel

*What the master settings screen lets a desk do now: edit the shelf as a table, price a life by age,
gender, occupational rank and sum assured, name a plan differently on every shelf, and set up the
channels and partners that sell it — with a sheet you can fill in offline and upload in one go.*

Five things were asked for and are implemented together, because they are one workflow: file a product,
price it, name it for the door it is sold through, and pay the partner who sold it.

---

## 1. The screens, and what each one is for

| Where | What it is |
| --- | --- |
| Master settings → **6. Product factory & underwriting manuals** | The whole filed shelf as an **editable grid**: 13 columns, a copy-line button, per-row save, add/remove/reorder, paging (25 a page), a search box, a line-of-business filter, and the sample sheet plus the upload. |
| Master settings → **7. Rating tables** | The tariff of one product: premium per 1,000 a year and the unit-linked cost of insurance per 1,000 a month, by age band, gender, occupational rank and sum band, with channel and partner overrides, a template download, a bulk upload, an overlap/gap report and a "price a life" probe. |
| Master settings → **8. Omni-channel setup** | Three grids that point at each other — channels, the partners on each channel, and the terms each partner holds per product — plus the shelf view of one product and a commission/clawback calculator. When nothing is set up it says so and offers one button. |

The grids are all built from the same primitives (`src/ui/grid.tsx`: `useGrid`, the four cell types,
`RowActions`, `GridBar`, `GridFrame`, `FileInput`, `downloadText`), so a row that is dirty, refused or
newly added looks and behaves the same on every one of them.

---

## 2. The product shelf as a table

`src/ui/product-grid.tsx` renders the ERP's own product masters as a draft grid.

* **Every cell is the master's field.** Money arrives in the notation the master prints (`1,000,000.00 AED`)
  and is edited as a plain decimal string; it is parsed by `parseAmount` in the core, never by `Number()`
  and never rounded twice. Ages and BMI are whole numbers; the income multiple is a count, not money.
* **Copy line** duplicates a row *in the draft*, and gives the copy a fresh id (`PROD-UL-GLOBAL-COPY`,
  `-COPY-1`, …) — a copy that kept its source's id would silently re-file the product it was copied from.
  The panel also offers the server-side copy (`POST /master/product/copy`), which is the one that matters
  for a unit-linked plan: it brings the whole rating grid with it, so the twin can be quoted immediately.
* **Saving is one bulk call** (`POST /master/product/bulk`, at most 500 rows). Each row that cannot be
  filed comes back with its index and its reasons, and the grid writes those reasons *into the row*, in red,
  while every good row in the batch files. One inverted age band never costs a desk ninety re-typed rows.
* **The grid drives the section.** The row in focus is pushed into the section's own `form` state, so the
  gate's checklist, its blockers and the cell being edited cannot disagree about what is about to be filed.
* Nothing is filed by typing. A row is a draft until it is saved; unsaved drafts survive a reload of the
  world underneath them; **Discard unsaved edits** puts the screen back to what is on file.

### The sheet

`src/core/product-config.ts` owns the sheet, and both directions read the same column table:

* `PRODUCT_COLUMNS` — 13 columns with `required` flags and the hint that becomes the cell's tooltip.
* `productTemplateCsv(sheet)` prints the header **and** this tenant's own filed masters, so a fill-in
  starts from numbers that exist rather than from placeholders. Because the header prints the labels, an
  upload with either ids or labels in the first line reads back.
* `readProductSheet(text, { limit })` checks shape and types only (unknown columns are ignored *with a
  warning*; a missing required column, a header nobody can read or more than 500 rows is a refusal that
  names the column), and returns rows for `defineProductMasters` — where the business rules still run, per
  row. The screen shows the sheet's report and the ERP's refusals side by side.
* `productExportCsv` prints what is on file, so a desk can take the live master away, edit it and bring it
  back. A refusal message quotes the column header a person is looking at (`Age from must be a whole
  number, not "not-an-age".`), never the internal field name.

### Secondary name, per omni-channel

`ProductMaster.secondaryName` is the product's own answer to "what is this plan called on a shelf". Over it
sit two filed overrides, resolved in this order by `OmniChannelRegistry.secondaryNameFor`:

1. the **partner's** shelf alias (the offer's `secondaryName`);
2. the **channel's** alias for this product (`POST /master/channels/product-name`);
3. the product master's `secondaryName`;
4. the registered name — with the *source* of the name returned alongside it, so a screen can say
   "shown as X, on the BROKER shelf" rather than leaving a desk to guess.

A channel's brand name and a partner's house name are deliberately **not** product names: they say who sold
it, not what it is.

---

## 3. The rating tables

`src/core/rating.ts` is a small tariff engine with strict matching rules, wired into the ERP as
`erp.rating` and seeded from what the tenant has already filed.

* A row is `(productId, kind, gender, ageFrom, ageTo, occupationClass, sumFrom, sumTo, channelCode,
  partnerId, ratePerThousand, currency, note)`. `kind` is `premium` (per year) or `mortality` (per month).
* **The key** — `rateKey(...` over every matching dimension — is what makes a re-upload safe: two rows that
  name the same product, type, gender, ages, class, sum band and scope are the *same row*, so the importer
  replaces it instead of leaving two prices beside each other.
* `occupationClass 0` means every class; `sumTo` is exclusive and `null` means "and above"; ages are
  inclusive.
* **Specificity**: partner (+8) › channel (+4) › gender over unisex (+2) › named class over all (+1),
  ties broken by the narrowest bands. An override is a row that outranks a wider row — not a fudge factor
  multiplied afterwards.
* **Money**: `rate × sum assured ÷ 1,000`, computed as `roundRational` over `BigInt` with the divisor
  `1000n × 10^scale(currency)`. Rates take at most 3 decimal places so a 0.001 step in a 2-decimal
  currency stays exact.
* The grid is **seeded, not invented**: `erp.seedRatingGrid` derives each product's bands from its own filed
  tariff (`baseRatePerThousandMinor` times the shape factors for age and for size of cover). Mortality rows
  are only written for `unit-linked` and `takaful` books, from that product's own cost of insurance —
  `coiPerMilleMonthly` ÷ 100, by 5 age bands × gender (male 110%, female 92%) × class (1 → 100%,
  3 → 118%, 5 → 190%). 190 rows on 7 products, and no flat number anywhere near it.
* `ageGaps(productId, kind)` and `overlaps(productId, kind)` are the QA report: which ages inside the
  product's entry range nobody has priced, and which two rows say two things about one life. Two bands that
  merely *touch* at 250,000.00 are one tariff, not an overlap — matching is half-open and the report agrees.
* `importCsv(text, { mode: 'append' | 'replace', limit })` is resumable and forgiving in the right order:
  `#` lines are skipped (that is how the template carries its own instructions), each row is validated on
  its own, `replace` first clears each product the file names, and the report counts `read`, `applied`,
  `replaced`, `cleared`, `rejected` and `skipped`.
* `POST /master/rates/price` runs the same lookup the quote engine uses and answers with the amount, the row
  that priced it and the reasons the alternatives lost. `POST /master/rates/mortality` is the monthly cost of
  insurance **for a real policy**, taken from the grid with the age, sex and rank on the underwriting file it
  was converted from — so an increase in cover raises the charge without anyone remembering to re-key it.

---

## 4. The omni-channel

`src/core/channels.ts` — `OmniChannelRegistry(resolveProduct, defaultCurrency)` — holds three stores that
point at each other, and the guards that keep them honest.

| Store | Filed facts |
| --- | --- |
| Channel | code, name, `secondaryName`, kind, integration, enabled, **`commissionCapBps`**, what it supports (quote / bind / service / claim) |
| Partner | id, name, `secondaryName`, the channel it belongs to, country, currency, enabled, settlement days, the products on its shelf, **commission schedule in bps by policy year**, **clawback plan** (`basis`, `trigger`, `recoveryBps` per period) |
| Offer | partner × product: `secondaryName` on that shelf, enabled, `premiumUpliftBps`, `mortalityUpliftBps`, an absolute `ratePerThousand` where the contract filed one, and its own commission and clawback if they differ |

Rules the registry enforces, in the API and therefore in the screen:

* A partner may not be paid above its channel's ceiling: `upsert*` refuses and **names both figures**.
* A channel with enabled partners cannot be switched off, and a channel with partners cannot be deleted;
  a partner whose products are attached cannot be quietly re-pointed at another channel.
* An offer needs the product on that partner's shelf first. The grid files the shelf and then the terms, so
  a desk never has to know the order exists.
* Unknown products and unknown partners are refused rather than treated as empty.
* Commission is `applyBps(gross premium, bps)` for the year asked; clawback is `applyBps(commission earned,
  recoveryBps)` for the period asked. **Never compounded, never floated.** The settlement ledger stays in the
  ERP (`settleCommissionLedger`); this master only holds the structure, and the screen says so.
* `bootstrap()` creates exactly the six standard routes — `DIRECT-PORTAL` (0 bps), `AGENCY` (4000),
  `BROKER` (3000, bind-off), `BANCASSURANCE` (3500), `AGGREGATOR` (1200), `EMBEDDED` (1500) — files nothing
  else, and is idempotent: a second call returns `created: []` and says which ones it left alone.
* The registry starts **empty**. That is the "omni-channel is not set up" state the brief asked for: the gate
  shows the blocker in the checklist, the panel shows what it blocks and the one-button setup, and the
  snapshot's `configured: false` is the same fact the API reports.

---

## 5. The API

Twenty-seven cases, all in `src/core/routes.ts`, all audited, all reachable from the screens:

```
GET  /master/product/template?products=A,B     the fill-in sheet, header + this tenant's own rows
GET  /master/product/export                    what is on file, same columns
POST /master/product/bulk                      ≤500 rows, per-row refusals        {rows:[…], by}
POST /master/product/copy                      a twin, with or without its tariff  {sourceProductId, productId, copyRates}
POST /master/product/import                    read a sheet and file it            {csv, by}
GET  /master/rates?productId=&kind=            rows, stats, gaps, overlaps, trail
GET  /master/rates/template?products=&bands=   a sample tariff for the products asked for
GET  /master/rates/export?productId=           rows as CSV, in the same shape the importer reads
POST /master/rates/upsert                      one row
POST /master/rates/bulk                        many rows, refusals returned with their index
POST /master/rates/copy                        duplicate a filed row, changing cells
POST /master/rates/delete                      withdraw one row
POST /master/rates/clear                       clear one product's tariff
POST /master/rates/import                      {csv, mode:'append'|'replace', by}
POST /master/rates/price                       what a life costs, and which row said so
POST /master/rates/mortality                   a policy's monthly cost of insurance from the grid
GET  /master/channels                          the whole registry: channels, partners, offers, status
POST /master/channels / bootstrap / remove / product-name
POST /master/partners / products / remove
POST /master/offers / remove
POST /master/commission                        premium in, commission and clawback out
```

A domain refusal (`RateError`, `ChannelError`) is a **409 with the sentence the desk needs**; only a
malformed request is a 400. Every write takes `at` and `by` and appends to its own bounded trail, which the
snapshot carries.

---

## 6. And the screens fit the screen they are on

The layout now adapts instead of overflowing: the content column is `minmax(0, 1fr)`, the rail is a
`clamp()`d fraction of the viewport from 1180 to 1900px and becomes a drawer below 980px, wide grids scroll
sideways inside their own frame with the header pinned, and the whole thing is measured in `dvh` with an
`env(safe-area-inset-*)` allowance, `viewport-fit=cover`, a 16px minimum on focused inputs (Safari will not
zoom into those) and 44px targets on coarse pointers. Breakpoints: 1280 (13-inch MacBook), 980 (tablet and
narrow windows), 700 (phone), plus a landscape-phone and a `prefers-reduced-motion` rule.

---

## 7. What is verified

`npx tsc --noEmit` clean; `npx vitest run` → **615 tests over 44 files**; `npm run build` clean.

| Evidence | Covers |
| --- | --- |
| `src/core/rating.test.ts` (22) | the key, the ranking, exact money, gaps and overlaps, template→import round trip, replace vs append, the seeded grid, refusals |
| `src/core/channels.test.ts` (26) | bootstrap idempotence, the ceiling, the shelf-before-offer order, delete guards, names and their sources, commission and clawback on decimal money, the audit trail |
| `src/core/master.test.ts` (+14 of 25) | the sheet: template, export, import round trip, per-row refusals, the copy with its tariff; the tariff: bulk-file, partner override, clear, sample→upload; the channel master: setup, ceiling, terms, commission, per-channel names |
| `src/ui/master-grids.test.ts` (16) | all three grids rendered server-side against the real snapshot: a page of rows, a copy and a save on each, every column, the money notation, the not-set-up state and the set-up state, and one open section on the rail |
| `src/ui/guide.test.ts`, `src/ui/console.test.ts` | the product factory panel's contract with the section (form, gate, save), and that a stack of grids adds no `aria-expanded` |

Deliberately open: rates filed here are read by `POST /master/rates/price` and by a policy's monthly cost of
insurance; the quote, proposal and illustration paths still take their rate from the product master unless a
grid row prices them, so this change is **additive and audited** rather than a silent restatement of the
books — which is what a pricing change has to be.

---

## 8. Three dedicated distribution configuration tabs

The combined Master settings panel above remains the compatibility view of the channel, partner and
sub-channel masters. The commercial shelf now also has three top-level tabs:

- **Omni Channel configuration** (`distribution-channels`) — one channel-wide row.
- **Partner configuration** (`distribution-partners`) — one partner inside a parent channel.
- **Sub Channel Partners configuration** (`distribution-subchannels`) — the narrowest
  channel × partner × sub-channel row.

Each screen configures the type of products (product line), a product from the priced master, its
sub-products (varieties), a commission percentage schedule, premium uplift percentage, commission
disbursement terms (frequency, trigger, settlement days, holdback) and clawback rules (trigger, basis
and recovery schedule). Percentages are stored as integer basis points; the API validates them, the
live masters and the active role before filing a row.

The three rows resolve in most-specific-first order: sub-channel partner, then partner, then
omni-channel, then the legacy offer/partner defaults. `priceRisk`, `commissionFor` and `clawbackFor`
all read that order, so the configuration is not a disconnected form. These tabs are visible only to
Administration, the Configuration Analyst and the three scoped coordinator templates. See
[`docs/27-DISTRIBUTION-CONFIGURATION-AND-COORDINATOR-ROLES.md`](27-DISTRIBUTION-CONFIGURATION-AND-COORDINATOR-ROLES.md)
and [`docs/API-REFERENCE.md`](API-REFERENCE.md) for `/distribution/config`.

The historical test count in section 7 belongs to the rating-and-omni-channel release that added the
combined panel; the current whole-suite count is reported by `npm run verify`.
