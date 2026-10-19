# 10 — Tenant master settings, the product catalogue and the AI guide

*What a tenant is allowed to change about the platform without a code change, and the note that
explains each screen while they do it.*

Three things were added together because they answer the same question — **who is this installation
for?** — and each one is incomplete without the others:

1. **Regional master settings**: the country, operating region, IANA time zone, date and clock format,
   local currency and the foreign rate card. Everything downstream reads these.
2. **Field renaming**: a journey field's display name is a filed setting, alongside `mandatory` and
   `editable`, with an audit trail.
3. **The product catalogue**: 96 varieties across 17 lines, each one seeded as a product master with
   its own underwriting manual, so the engines can price and gate a hull risk as easily as a term life.

And, sitting on top of all of it, **the guide**: a sticky note at the top of every section of every
screen, with one switch in the header that hides them all.

---

## 1. The AI guide

### What it is

A note at the top of each screen and each section saying three things: what this section is for, what
to do in it, and what to watch — with the engine's live figures folded in, so the note reads
"96 product masters across 17 lines; 11 of them in the takaful window" rather than "several products".

The notes are **data, in `src/core/guide.ts`**, not prose in components:

- `TAB_GUIDES` — one entry per console tab (all 21).
- `SECTION_GUIDES` — one entry per curated section, keyed `<tab>:<section>` (all nineteen journey
  stages, the eight master-settings gates, and the gates of the claims, underwriting, policyholder,
  funds and reinsurance rails).
- `worldFacts(w)` — the live figures per tab, read from the world at snapshot time.

A section nobody curated still gets a note: `sectionGuide` composes one from the screen's note plus the
section's own state (status, percent, outstanding fields, blockers). "Every section has a guide" is
therefore structural, not a promise somebody has to keep.

### Where it renders

`src/ui/guide.tsx` provides `GuideProvider`, `<GuideBanner>` and `<ScreenGuide>`. The provider sits
above the tab body in `App`, so `SectionStack` (and therefore every rail: journey, claims, policy
administration, quotations, funds, reinsurance, master settings) puts a note inside the one section it
opens, and `Card` puts a compact note under its heading. The note is a `<details>`: the headline is
always visible, the working unfolds in place. It is `position: sticky`, so it stays with the operator
down a long form.

The provider is optional. A panel rendered without one — in a test, or embedded somewhere — simply has
no notes; nothing throws and nothing is faked.

### The switch

`✳ AI guide: on/off` in the console header, above every tab. It flips instantly (a switch that waits on
a round trip feels broken), then files `POST /api/guide/preference`. The desk records who changed it and
when, and the change is written to the AI ledger as a `guide` action at `low` risk, because "was this
operator shown the guidance at the time?" is a question a compliance reviewer asks and deserves a
factual answer to.

Turning the guide off hides the notes. It does not rewrite them, and it changes no rule: the gates,
the authority limits and the refusals are the engine's, and they run either way.

### What the guide is not

`GUIDE_LIMITATION` is printed in every note: the notes are guidance written by the people who built the
screens, refreshed with the engine's own figures — they are not advice, and they never override a rule
the engine enforces.

---

## 2. Regional master settings

`src/core/regional.ts` holds a `RegionalDesk`: the tenant's country pack, calendar and money.

| Setting | What it decides |
| --- | --- |
| `country` | One of 39 country packs, each filed with its regulator, regions, default time zone, currency, locale, date order and week start |
| `operatingRegion` | The emirate / state / region inside that country — validated against the pack |
| `timezone` | An IANA zone (44 on file). Every date and time the console prints is read through it |
| `dateFormat` | `DD/MM/YYYY`, `MM/DD/YYYY`, `YYYY-MM-DD`, `DD.MM.YYYY`, `D MMM YYYY`, `DD MMMM YYYY` |
| `timeFormat` | `12h` or `24h` |
| `weekStart` | `monday`, `sunday` or `saturday` |
| `locale` | The pack's locale, overridable |
| `localCurrency` | One of 36 currencies: the money new products are filed in, and the currency the rate card is read in |
| `foreignCurrencies` | The rate card: exact rationals, each with the date it was quoted and whether it is a peg |

### What follows the setting

- **The console header** shows the country, the zone with its UTC offset, the date and time in the
  tenant's own format (ticking), the local currency and how many foreign quotes are on file.
- **The product factory** files new products in the local currency and labels its money inputs with it.
- **The FX master** (`POST /api/master/fx`) mirrors any quote that touches the local currency onto the
  same regional card — in either direction, and inverted exactly on the rationals. There is one rate
  card, not two that can disagree.
- **The ledger keeps its own base currency.** Changing `localCurrency` changes how the tenant quotes and
  files; it does not silently restate a book that was written in dirhams. Every amount stays explicit
  about the money it is in, which is the rule the whole core is built on.

### Changing the local currency

A rate card is read "units of local for one unit of foreign", so changing the local currency changes the
meaning of every number on it. The card is **rebased on the rationals**: the outgoing currency becomes a
foreign currency at the reciprocal of the incoming one's quote, and every other quote is divided through
by the same number. Nothing is rounded twice. If the incoming currency has no quote on file, the card is
dropped with a note saying so — an unquoted card is refused, never assumed.

### Refusals

Unknown country, time zone, currency, date format, time format or week start; an operating region that is
not in the chosen country's pack; a rate that is not a positive number; quoting the local currency
against itself; removing a currency that is not on the card. A refusal leaves the card exactly as it
was: a half-applied regional change would put the currency on one screen and the calendar on another.

---

## 3. Renaming a field

`JourneyFieldSettings` is `{ mandatory, editable, label? }` per stage per field. A label is filed
wording, so it is validated like filed data: trimmed, whitespace-normalised, at most 80 characters, no
markup (`<`, `>`, `{`, `}`), because a label is read aloud by a screen reader and printed on a schedule.
An empty label means "restore the default" — undoing a rename never depends on anybody remembering the
original wording.

The rename takes effect in every place the field is named:

- the form label in the journey section;
- the outstanding-field checklist ("Mandatory fields still outstanding");
- the refusal message when a locked field is written to (`Amount of cover is locked by master settings`);
- the read-only refusal for a calculated field.

Every change goes to the rename trail — `at`, `by`, stage, field, `from`, `to` — returned by
`GET /api/journey` as `fieldRenames` and editable on the master-settings screen, where the input sits in
the same row as the Required and Editable checkboxes with a "restore" button beside a renamed field.

---

## 4. The product catalogue

`src/core/products.ts` holds the varieties as data:

| Family | Lines | Examples |
| --- | --- | --- |
| Life & protection | term life, critical illness, lifestyle & income protection, mortgage protection, personal accident | level / decreasing / increasing / convertible / whole-of-life term; standalone, comprehensive, early-stage, multi-pay, women-specific and children's critical illness; lifestyle, bundle and loan-cover income protection; mortgage redemption, level, with CI, payment protection |
| Health | medical & health | individual, corporate, SME, outpatient, maternity, dental, international with evacuation |
| Savings & investment | endowment & savings | capital-back, education, retirement, short-term, unit-linked endowment and lifestyle |
| Motor & travel | motor, travel | comprehensive, third-party, fleet, pay-as-you-drive; single trip, annual multi-trip, Schengen visa, family, senior, business |
| General & commercial | home & contents, property & fire, liability, engineering, general | buildings, contents, renters, landlord, valuables, home emergency; fire, all-risks, burglary; public, employer's, product, professional indemnity, D&O; CAR, EAR, machinery breakdown, boiler; fidelity, money, glass, cyber |
| Marine & aviation | marine cargo, hull & aviation | voyage, open cover, air, land transit, storage, terminal operators; hull & machinery, hull war, yacht, aircraft hull, P&I, offshore energy |
| Group & employee benefits | group | group term, group accident, group medical, group takaful |

Each variety carries: line, category (`conventional`, `unit-linked`, `takaful`, `motor-payg`), variety
name, blurb, entry ages, base rate per 1,000, income multiple, automatic binding limit, facultative
threshold, AI straight-through limit, accepted territories, default funds and an evidence profile.

### How a variety becomes something the engines read

`ErpManager.seedFromWorld` turns **every** variety into a `ProductMaster` and registers its rules in the
underwriting engine, deriving them from the manual for its line (medical for `medical`, life otherwise)
and the evidence profile for the line (`life`, `medical` or `short-tail`). The five products the demo
world has always run come out with exactly the numbers they have always had, because the catalogue
carries those numbers — there is no second source of truth.

So the consequences are real, not cosmetic:

- `productCatalogue(w)` in the journey desk ranks **all** of them against the needs questionnaire, with
  objectives mapped per line (a marine open cover answers `business-continuity`, never
  `family-protection`).
- `POST /api/underwriting/register` will assess a hull risk at 9.50 per 1,000 and route it against the
  commercial binding limits.
- `defineProductMaster` prefills from the catalogue: filing `PROD-CI-MULTIPAY` with a new rate keeps its
  name, variety, blurb, line, category, ages and limits, and a product filed with an id that is not on
  file still has to be given a name.

### The factory UI

The master-settings product gate lists the shelf (17 lines, 96 varieties, filterable by line, with the
variety and blurb columns), and a "filed variety" picker grouped by family that pulls a variety's own
manual into the form. The gate blocks before save on the mistakes that matter: an entry range that
admits nobody, a facultative threshold below the automatic binding limit, an AI straight-through limit
above it.

---

## 5. API

| Method | Path | What it does |
| --- | --- | --- |
| `GET` | `/api/guide` | The playbook: a note per tab, the curated section notes, the live facts, the switch state and its trail |
| `POST` | `/api/guide/preference` | Turn the notes on or off; recorded on the desk and on the AI ledger |
| `GET` | `/api/master/regional` | The regional card with the choices the tenant may pick from |
| `POST` | `/api/master/regional` | Set country, region, time zone, date/time format, week start, locale, local currency |
| `POST` | `/api/master/regional/currency` | Quote (or re-quote) a foreign currency, with its date and whether it is a peg |
| `POST` | `/api/master/regional/currency/remove` | Take a currency off the card |
| `POST` | `/api/master/product` | File or re-file a product; anything omitted is prefilled from the catalogue |
| `POST` | `/api/master/fx` | The older FX door; a quote touching the local currency mirrors onto the regional card |
| `POST` | `/api/journey/field-settings` | Mandatory, editable **and label** per stage per field; returns the rename trail |

---

## 6. Verified by

| Test file | What it proves |
| --- | --- |
| `src/core/regional.test.ts` | Country packs, time zones, date and clock formats, the rate card, rebasing onto a new local currency, refusals |
| `src/core/products.test.ts` | Ids and names are unique, every line has an alternative on it, the numbers are defensible, the five legacy products are unchanged, every variety is seeded with rules, a hull risk prices through the engine, the journey ranks the new lines |
| `src/core/guide.test.ts` | Every tab and every journey stage has a note, section keys resolve to real tabs, notes carry the engine's figures, an uncurated section is still guided, the switch hides the notes without rewriting them, the API serves and records the preference |
| `src/core/master.test.ts` | The three settings over HTTP: renames reaching the form, the checklist and the refusal; the regional card moving the whole tenant and refusing what is not on file; the product factory prefilling from the catalogue |
| `src/ui/guide.test.ts` | One note in the one open section, none when the provider is absent or the switch is off, a note per screen, and the master-settings panels rendering the regional card, the rename inputs and the whole shelf |
| `src/core/tour.test.ts` | The tour still adds up to exactly sixty minutes, now including the master-settings screen |
