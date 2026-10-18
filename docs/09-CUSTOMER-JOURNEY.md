# 09 — The guided customer lifecycle

*Nineteen closed sections, one open at a time, from onboarding to investment progress. This is the design record: what the sequence is, what "complete" means, why the gate lives in the core rather than in the console, and what was verified.*

---

## 1. The problem being fixed

The console rendered every panel's cards open at once. For a dashboard that is fine; for a process it is
actively harmful. An operator creating a customer faced nine open forms and nothing that said which one
came first, what was still missing, or whether the next step was even allowed yet. Quotation, conversion,
alterations, claims, medical requirements and loadings all had the same shape: a wall of inputs, no
sequence, no gate.

The fix is one rule, applied everywhere:

> **A section is closed until the section before it is 100% complete on its mandatory fields and its
> domain gates. The next section then opens itself.**

Nothing else about the console had to change for that to be true, because the rule is computed in the
domain core and the console only renders the answer.

## 2. The sequence

`src/core/journey.ts` holds the catalogue. The order is not cosmetic — each section produces something the
next one is gated on.

| # | Section | Owner | What it produces | Gate that opens the next one |
| --- | --- | --- | --- | --- |
| 1 | Customer onboarding & identity verification | agent | golden record, identity document with its verification source, consent | verified identity + bilingual name for AE + consent |
| 2 | Customer 360 profile, consent & duplicate check | agent | consent scopes, duplicate check result, tax residence | duplicate resolved (merged or recorded as two people) |
| 3 | Needs-analysis questionnaire | customer | need analysis with identifier, protection gap, affordability ceiling | every mandatory question answered and attested |
| 4 | Product / item recommendation list | agent | ranked list, comparison presented, chosen product | the chosen product fits the evaluated need |
| 5 | Coverage & premium calculation | agent | underwriting application, standard premium, affordability test | sum assured priced and inside the affordability ceiling |
| 6 | Occupational & medical loadings | underwriter | itemised loading breakdown, exclusions, evidence list | breakdown reconciles with the underwriting file |
| 7 | Additional riders (with or without loading) | underwriter | rider schedule, waivers with authority | every waiver carries a named authoriser and a reason |
| 8 | Medical requirements | underwriter | requirement checklist, results, waivers | nothing outstanding: reviewed, or waived by name |
| 9 | Fund investment selection & allocation | customer | signed target weights, first-contribution split, units | weights total exactly 100% and the money splits with nothing lost |
| 10 | Beneficiary details | customer | beneficiary schedule and shares | primary shares total exactly 100%; a minor has a guardian |
| 11 | Underwriting & medical questionnaire review | underwriter | decision, waived referral points, updated questionnaire | decided under authority; a declined risk stops here |
| 12 | Quotation generation (PDF) & email | agent | versioned PDF with fingerprint, email dispatch, validity window | issued (all compliance gates pass) **and** sent |
| 13 | Customer review, cooling-off & sign-off | customer | signature and reference, cooling-off statement, buy-online token | signed inside the validity window |
| 14 | Buy online — payment options & capture | cashier | payment record with proof, handling cost, reconciliation | the amount due is captured (and cleared, for a transfer) |
| 15 | Underwriting route & binding authority | underwriter | routing decision, freelance engagement, reinsurance assist | the route is recorded, with the sign-offs it requires |
| 16 | Policy conversion & issuance | back office | policy number, first receipt and journal, units allocated | decision accepted, money cleared, allocation signed |
| 17 | Funds allocation & management in force | back office | drift report, rebalance/switch/top-up instruction | reviewed against the signed targets |
| 18 | Investment allocations & progress | customer | progress statement, gain or loss, next review date | progress measured at published valuations |
| 19 | Servicing: alterations & claims | back office | servicing handover, alteration and claim routes | handover acknowledged |

Sections 15 and 16 are the escalation chain the business asked for, made explicit: **auto** (straight
through inside the AI limit), **manual** (in-house underwriter), **senior** (review or referral — the only
route that may decline), **freelance** (capacity hired from the panel when the in-house queue cannot meet
the promised decision time, with the cost and authority limit recorded), and **reinsurance assist** (the
reinsurer's underwriter asked *before* issue once the facultative threshold is reached).

## 3. What "complete" means

Three conditions, all of them checked in `journey.ts`:

1. **Every mandatory field is filled.** Mandatory is data (`StageFieldSpec`), including fields that are
   only mandatory in some circumstances (`mandatoryWhen` — a waiver needs an authoriser *if* a rider is
   attached without loading; a card number is needed *if* the method is a card).
2. **Every domain gate passes.** Weights total 10,000 bps, beneficiaries total 10,000 bps, the itemised
   loading equals the underwriting engine's own basis points, no medical evidence is outstanding, the
   premium is inside the affordability ceiling the needs analysis established, the money has cleared.
3. **The section has been submitted.** A form filled in and abandoned is not a step taken. `JourneyCase.submitted`
   is what separates "typed" from "committed", and the console shows the difference (`submitted` badge).

A section behind an incomplete one is `locked`: it reports 0%, it will not open as a form, and clicking it
explains which section holds it. A section can therefore never be ticked out of order, however empty its
own gate is — a tick on section 7 while section 5 is open would be a lie.

`journeyProgress()` returns exactly one section with `autoOpen: true`: the first that is neither complete
nor locked. That single field is the whole contract between the core and the console; the console opens
that section, closes the others, and scrolls to it. When the operator completes it, the recommendation
moves and the next section opens by itself.

## 4. Where the gate lives, and why

**In the core, not the console.** `POST /api/journey/submit` runs the same `journeyProgress()` the screen
renders and refuses a section that is locked or incomplete, with the reason. Two consequences matter:

- the API and the screen cannot disagree about what "done" means, so a scripted or agent-driven sale is
  held to the same sequence as a human one;
- a refusal carries the missing fields and blockers by name, which is what the console prints.

Alternatives considered and rejected:

| Alternative | Why not |
| --- | --- |
| Gate in React state only | The API would accept any order; an agent or an integration would walk straight past the sequence, and the audit trail would not show what was skipped. |
| One wizard step per screen (no rail) | Operators need to see the whole journey and jump back to amend a completed section (the underwriting review screen exists precisely to update answers). A rail of closed sections keeps both. |
| Derive completion from artefacts only | A section with no artefact (loadings, riders, medical review) would be ungateable, and a section whose artefact is created *by* submitting it could never pass its own gate. Fields + gates + submitted covers all three cases. |
| Auto-scaling weights that do not total 100% | It would invest money the customer never allocated, and the signed document would not match the units bought. The plan reports itself incomplete instead. |

## 5. The modules this added

| Module | What it owns | Tests |
| --- | --- | --- |
| `src/core/journey.ts` | the stage catalogue, mandatory fields, gates, progress, locking, the next recommendation, the case record and its audit log | `journey.test.ts` (24) |
| `src/core/journeydesk.ts` | the side effects: runs the engines per section, builds the quotation facts, assembles the snapshot the console renders | `journeyroutes.test.ts` (12) |
| `src/core/needs.ts` | the needs-analysis questionnaire per country pack, its evaluation (protection gap, affordability ceiling, stated assumptions) and the ranked product recommendation | `needs.test.ts` (13) |
| `src/core/loadings.ts` | occupational and medical loadings itemised in bps and money and reconciled to the underwriting file, medical requirements with waivers, the rider catalogue and riders attached without loading | `loadings.test.ts` (15) |
| `src/core/allocation.ts` | fund selection and allocation (weights, exact money split, Shariah screen, appetite), beneficiary designation, and post-issue drift and investment progress | `allocation.test.ts` (18) |
| `src/core/quotation.ts` | the quotation as a controlled document: compliance gates, versioning and supersession, dispatch under consent with a masked audit copy, finalisation inside validity | `quotation.test.ts` (14) |
| `src/core/pdf.ts` | a minimal PDF 1.4 writer (base-14 Helvetica, real cross-reference table) and a structural verifier | `pdf.test.ts` (8) |
| `src/core/payments.ts` | the six ways to pay: card brand and Luhn, masking and fingerprinting, IBAN mod-97, BNPL schedules, settlement timing, idempotent capture, reconciliation | `payments.test.ts` (20) |
| `src/core/uwroute.ts` | the binding route, the queue arithmetic, the freelance panel and its engagements, the reinsurance assist request and answer | `uwroute.test.ts` (17) |
| `src/ui/sections.tsx` | the collapsible section rail: closed by default, one open, auto-advance with scroll, locked sections explaining themselves | rendered by every process panel |
| `src/ui/journey.tsx` | the journey console: 19 sections, the field editors, the quotation/PDF/email/payment/routing detail | `console.test.ts` (2) |

Two existing modules were extended rather than duplicated:

- `underwriting.ts` gained `amendProfile()` — the medical questionnaire review and update screen. Every
  change is recorded from → to with the person and a reason of at least 24 characters, and a decision
  taken on the old answers is **set aside** so the case must be decided again.
- `erp.ts` gained `listProductMasters()` / `productMaster()` so the journey can price and route from the
  master data the ERP owns, instead of re-deriving rates from formatted snapshot strings.

## 6. The API

| Endpoint | What it does |
| --- | --- |
| `GET /api/journey` | the catalogue, the choice lists (products, funds, riders, questionnaire, payment methods, freelance panel, manual codes) and every case with its full progress |
| `POST /api/journey/open` | open a case: every section closed, the first one recommended |
| `POST /api/journey/save` | save a draft — the section fills but does not complete |
| `POST /api/journey/submit` | run the gate, then the engine; returns `accepted`, the reason, the artefacts and the new progress |
| `POST /api/journey/abandon` | close a case with a reason of at least 24 characters |
| `POST /api/journey/quotation/pdf` | the issued document: base64, page count, fingerprint, and the text it carries |
| `POST /api/journey/payment/settle` | the bank confirmed the credit — pending becomes settled and the journey resumes |
| `POST /api/journey/payment/fail` | the transfer never arrived, or the cheque bounced (refused once the money was ours: that is a reversal) |
| `POST /api/journey/freelance/report` | the panel underwriter's recommendation, recorded against the engagement |
| `POST /api/journey/reinsurance/answer` | the reinsurer's answer to an assist request |
| `POST /api/underwriting/amend` | the questionnaire review and update, with the amendment trail and the re-assessment |

`GET /api/world` carries the same journey snapshot, so the console renders it with the one call it already
makes.

## 7. The same rail on the existing panels

`SectionStack` / `SectionGroup` are not journey-specific. The panels that are processes now use them, with
their own mandatory fields and blockers:

- **Parties & consent** — create golden record → update profile → consent governance and merge (a merge
  with the same record on both sides is a blocker; a UAE record without an Arabic name is a blocker).
- **Underwriting** — proposal and quotation → decision and conversion (an entry age outside the product's
  range, or a sum assured above the income multiple, stops the first section).
- **Policyholder** — premium receipt, financial alterations (a reason of at least 24 characters, because it
  moves money), non-financial alterations (a single beneficiary below 100% warns that the balance falls to
  the estate), with the registers as reference sections.
- **Claims** — register and triage → reserve → decide → settle and recover, in that order: a claim cannot
  be settled before it is decided, or decided before it is reserved.
- **Funds & NAV**, **Reinsurance**, **Master settings** — collapsed sections with their own gates (a
  facultative threshold below the automatic binding limit, a cession outside 1–10,000 bps, an AI authority
  limit above the binding limit, a fund id that already exists).

## 8. What was verified

- `src/core/journey.test.ts` — the catalogue and its order; every section explaining itself; the seeded
  world opening with sections 1–4 complete and only section 5 open; locked sections refused by name;
  missing mandatory fields named; a sum assured above the affordability ceiling refused; weights that do
  not total 100% refused and never re-scaled; beneficiaries refused for a short total and for a minor with
  no guardian; a declined risk refused at quotation; a rider given away without an authoriser refused; a
  possible duplicate held until the operator records what it turned out to be; "no riders needed" recorded
  as a decision rather than skipped; a form filled but never submitted **not** complete; the whole sequence
  moving the recommendation on one section at a time; a policy issued only after a bank transfer settles;
  and the audit trail of saves, submissions and refusals.
- `src/core/journeyroutes.test.ts` — the same acceptance criteria over `dispatchApiRoute`, the dispatcher
  both the Node server and the offline browser bundle use, including the quotation PDF fetched through the
  API and the amendment endpoint setting a decision aside.
- Live: `node tools/offline-record-journey.mjs` walks all nineteen sections against the running server and
  records the answers; the quotation PDF it produces was opened and read back by an independent parser
  (`pypdf`), which returned both pages, the metadata and the itemised premium.

## 9. Known limits, stated rather than hidden

- The quotation PDF is written in WinAnsi with base-14 Helvetica: a character outside Latin-1 (Arabic,
  Urdu, Chinese) degrades to `?`. The bilingual document is carried in full by the email body and the
  on-screen version. Embedding a font is a separate chunk.
- The freelance panel, its day rates and the in-house queue figures are operating data in
  `uwroute.ts` / `journeydesk.ts`, not a workforce system. Engagements are recorded and costed; nobody is
  actually rostered.
- Card and BNPL calls are modelled, not connected to an acquirer: the PAN is validated, identified,
  masked and fingerprinted, and the CVV is never held, but no authorisation is requested from a scheme.
- The needs-analysis replacement-years and affordability tables are tenant-editable assumptions. They are
  written down and every figure they produce carries the sentence that produced it; they are not
  actuarial advice.
- `demo/index.html` (the screenshot gallery) predates the journey tab and needs `npm run demo:pack` with a
  browser to refresh. `demo/offline.html` — the console itself — was rebuilt and carries the journey.
