# 07 — The sixty-minute tour

*Generated from `src/core/tour.ts` — the same data the console's Tour tab runs. 12 steps, 60 minutes.*

> **Live app:** run `npm install && npm run build && npm start`, then open the console and start on the **Tour** tab. Every number you see is computed by an engine in `src/core`; nothing on the screen is seeded display text.

## Before you start

| # | Time | Tab | What you are doing |
| --- | --- | --- | --- |
| 1 | 00:00 | Overview | Land on the whole book in one screen |
| 2 | 00:04 | Policyholder | Look through a unit-linked policy into real instruments |
| 3 | 00:10 | Decision theatre | Price a switch and a withdrawal before anything moves |
| 4 | 00:16 | Cover control | Pay for cover only while cover is on |
| 5 | 00:21 | Funds & NAV | Run the NAV engine and see the rules behind a price |
| 6 | 00:26 | Takaful | Run a takaful window that is structural, not cosmetic |
| 7 | 00:32 | Group finance | Consolidate three entities, two currencies, one set of books |
| 8 | 00:38 | Underwriting | Underwrite against a manual held as data |
| 9 | 00:43 | Claims | Pay a claim through authority, not through a spreadsheet |
| 10 | 00:48 | Reinsurance | Hand part of the risk to someone else, on the record |
| 11 | 00:53 | Durability | Prove the books can be restored |
| 12 | 00:56 | Overview | The remainder of the hour: the fabric around the money |

## 1. 00:00 — Land on the whole book in one screen

**Tab:** Overview · **4 minutes**

Before touching anything: this is one tenant, two legal entities and a Malaysian subsidiary, and every number here is computed live from the engine, not seeded display text.

**Do this**

- Read the Tenant card: three entities, two currencies, two regulators.
- Note the unit-linked fund value, the sum assured, and "reproduced from log".
- Look at the Books card: both entity books report balanced.

**You should see**

- Fund value for UL-000123 is a live valuation, and the units reproduce from the transaction log alone.
- Takaful pools and the conventional book are separate; the books card proves it.

*Endpoints: GET /api/world*

## 2. 00:04 — Look through a unit-linked policy into real instruments

**Tab:** Policyholder · **6 minutes**

This is the claim that beats ILAS: not just fund accounting, but genuine look-through into the instruments the fund actually holds, with a price date on every exposure.

**Do this**

- Read the fund value and the units held per fund.
- Read the penetration table: fund, instrument, weight, value, market price, price date.
- Scroll the transaction log and read the dealing rule under each movement.

**You should see**

- Each holding shows the instrument, its market price and the date that price was taken.
- Every transaction carries the valuation date and a sentence explaining which cut-off applied.

*Endpoints: GET /api/world · GET /api/units*

## 3. 00:10 — Price a switch and a withdrawal before anything moves

**Tab:** Decision theatre · **6 minutes**

A real decision theatre: units, price, valuation date, dealing rule, fees and lock-in blockers — all shown before the customer commits, with the illustration clearly labelled as an illustration.

**Do this**

- Set a switch amount, pick the funds, and read the preview: units out, units in, fee, net invested.
- Move the instruction time past the 15:00 cut-off and watch the valuation date move.
- Open the withdrawal preview: cash to customer, units realised, remaining value, and the rule that priced it.
- Read the projection envelopes — adverse, central, favourable — and the disclaimer wording.

**You should see**

- Crossing the cut-off changes the valuation date, not the amount.
- The illustration is labelled; the engine never presents a projection as a promise.

*Endpoints: POST /api/preview/switch · POST /api/preview/withdrawal*

## 4. 00:16 — Pay for cover only while cover is on

**Tab:** Cover control · **5 minutes**

Daily, pay-as-you-go and start/stop cover as a billing primitive: nothing restarts by itself, and a day is either paid or cover suspends — there is no halfway charge.

**Do this**

- Look at the segments: start, stop, daily rate, what has been charged.
- Stop cover, then advance the clock a few days and watch nothing accrue.
- Start cover again, advance the clock, and watch only the active days charge.
- Empty the wallet and tick again: cover suspends instead of going negative.

**You should see**

- Charges appear only for days inside an active window.
- After a stop, no day charges until someone explicitly starts again.

*Endpoints: POST /api/cover/start · POST /api/cover/stop · POST /api/cover/tick*

## 5. 00:21 — Run the NAV engine and see the rules behind a price

**Tab:** Funds & NAV · **5 minutes**

Fund managers and auditors argue about valuation points. Here the cut-off, the business-day calendar, the floor price and its named residual are all visible, and reconciliation is an assertion, not a promise.

**Do this**

- Read the valuation history per fund, including today.
- Read the look-through composition and any Shariah composition warnings.
- Find the reconciliation line: units × price + residual = NAV.
- Check the fund management charge accrual.

**You should see**

- The reconciliation ties exactly, with the residual named rather than buried in rounding.
- A non-screened instrument inside a Shariah fund raises a warning instead of passing silently.

*Endpoints: GET /api/world*

## 6. 00:26 — Run a takaful window that is structural, not cosmetic

**Tab:** Takaful · **6 minutes**

Three funds, a real wakalah fee, tabarru into the risk pool, qard hasan when the pool is short, and a surplus that cannot be distributed until the actuary, the Shariah Committee and the board have all signed — with the UAE rule that participants never receive surplus applied on top.

**Do this**

- Read the three pool balances and the operator fund.
- Read the qard: who lent to whom, how much is outstanding, and how it is repaid.
- Try to distribute the surplus and read the blockers, one by one.
- Sign as actuary, then Shariah, then board, and watch the blockers fall away.

**You should see**

- The distribution is refused until every gate is satisfied, and the refusal names the missing one.
- The surplus stays inside its own pool; nothing leaks into the operator fund.

*Endpoints: POST /api/takaful/approve*

## 7. 00:32 — Consolidate three entities, two currencies, one set of books

**Tab:** Group finance · **6 minutes**

The part most ERP demos fake: assets and liabilities at the closing rate, income and expenses at the average rate, equity at the rate on the day it moved, the gap shown as a translation reserve, intercompany eliminated, and a minority interest stated rather than absorbed.

**Do this**

- Read the three entities: functional currency, ownership, net assets, result, translation reserve.
- Read the intercompany table: one pair agrees and eliminates cleanly, the other does not and shows in transit.
- Find the minority interest line: 30% of the Malaysian subsidiary, stated separately.
- Press "Run the consolidation" twice and watch nothing new get posted.

**You should see**

- The consolidated balance sheet balances, and the group ledger proves itself.
- Consolidating again is idempotent, and the entity books are untouched.

*Endpoints: GET /api/group · POST /api/group/consolidate*

## 8. 00:38 — Underwrite against a manual held as data

**Tab:** Underwriting · **5 minutes**

Loadings are shown line by line with the reason and the evidence each one demands, referrals go to a named human, and anything above the automatic binding limit is flagged for the reinsurer before the policy is issued. An AI agent may accept or rate inside its own limit and may never decline.

**Do this**

- Read the accepted book: standard premium against loaded premium.
- Open the 2.5m application and read the referral points.
- Press "Ask the AI agent to decide" and read the refusal and the referral.
- Press "Senior underwriter takes the case" and watch the referral points be recorded as waived, by name.

**You should see**

- Every loading and exclusion carries a reason code and a plain sentence.
- The AI cannot decline a risk; the referral is recorded with the role that owns it.

*Endpoints: GET /api/underwriting · POST /api/underwriting/decide*

## 9. 00:43 — Pay a claim through authority, not through a spreadsheet

**Tab:** Claims · **5 minutes**

Triage decides straight-through, referral or decline; a reserve is a booked liability rather than a note; approval is checked against a real authority table; settlement releases the reserve and recoveries are posted as their own income. In the takaful window the same workflow draws on the participants risk fund.

**Do this**

- Read the position: reserved, expense incurred, cash paid, recoveries, net cost.
- Open the settled motor claim and read its timeline, then its salvage recovery.
- Open the open critical-illness claim and press "Ask the AI to approve 25,000.00" — read the refusal.
- Open the takaful claim and read where the money came from.

**You should see**

- An AI approval above its straight-through limit is refused, and the limit is named.
- A pooled claim moves cash exactly once, from the risk fund, with qard hasan if the pool is short.

*Endpoints: GET /api/claims · POST /api/claims/register · POST /api/claims/approve · POST /api/claims/settle*

## 10. 00:48 — Hand part of the risk to someone else, on the record

**Tab:** Reinsurance · **5 minutes**

An insurer that keeps every risk whole is one bad quarter from ruin. This is the treaty register and the utilisation statement behind it: a quota share on the life case, a surplus treaty over a 200,000 retention, catastrophe cover, and a retakaful treaty for the takaful window — with the participant-money segregation rule enforced in code.

**Do this**

- Read the two statements: the conventional book and the takaful window, each with its own treaties.
- Press "Cede a further risk": the engine authorises the cession, prices it and posts it — and the utilisation statement moves. Naming the same risk twice is refused rather than double-counted.
- Press "Place a risk facultatively": the reinsurer accepts the named risk first, then the premium moves.
- Read "The refusals": a risk the reinsurer has not accepted, and participant money offered to a conventional treaty.

**You should see**

- Ceded premium, commission, net retained premium and the recoverable appear in the books, not just on screen.
- Every cession names the journal it produced, and the recoverable on the statement equals the receivable in the ledger.

*Endpoints: GET /api/reinsurance · POST /api/reinsurance/cede · POST /api/reinsurance/facultative · POST /api/reinsurance/recover*

## 11. 00:53 — Prove the books can be restored

**Tab:** Durability · **3 minutes**

A demo that cannot survive a restart is not an ERP. This seals the books into a canonical, fingerprinted snapshot and rebuilds a fresh ledger from that text, comparing trial balances.

**Do this**

- Read the snapshot summary: accounts, journals, size, fingerprint.
- Press "Run durability drill".
- Read the per-entity result: balanced, trial balance agrees, restore time.

**You should see**

- The restore reports the same journals and the same balances, in milliseconds.
- The fingerprint is stable across runs, so a tampered payload would be caught.

*Endpoints: GET /api/state · POST /api/state/drill*

## 12. 00:56 — The remainder of the hour: the fabric around the money

**Tab:** Overview · **4 minutes**

The modules an insurer actually runs on — onboarding, ingestion, consent, regulatory packs, renaming and AI governance — each one wired to something you can press.

**Do this**

- Onboarding: read the chip read, the government lookup and the OCR consensus, then find the field in the review queue.
- Ingestion: submit a file of any shape, watch it map its own columns, quarantine the bad rows and suppress the duplicate.
- Parties & consent: run a partner lookup with consent, then without it, and read the access log.
- Regulatory: read the pre-sale gates for motor and medical, and the comparison matrix behind a motor quote.
- Labels & rename: rename a label in one scope only and watch the other scope keep its own word.
- AI ledger: read the prohibited intents, then try to get one executed and read the refusal.
- Books: read the trial balance and the journal list for an entity.

**You should see**

- Quarantined rows carry a reason per column; duplicates are suppressed, not double-counted.
- A refused AI action stays refused, and the attempt is still on the record.

*Endpoints: POST /api/ingest/submit · POST /api/ingest/commit · POST /api/partner/lookup · POST /api/pre-sale · POST /api/ai/approve · POST /api/ai/execute*

## If something refuses you

That is the product working, not a bug. The refusals worth trying on purpose:

- Ask an AI agent to approve above its straight-through limit — it names the limit and stays on the record.
- Try to distribute a takaful surplus before every gate has signed — it names the gate that is missing.
- Try to reduce a claim reserve without settling — refused, because reserves move deliberately or not at all.
- Stop micro-duration cover and advance the clock — no day charges until someone starts it again.

## What is not finished

This is an honest inventory, mirrored in `docs/06-QA-REPORT.md`: policy administration, the data warehouse and the customer-service modules are designed and backlogged, not yet built. `ledger/runs.jsonl` records every backlog chunk the fleet has claimed with its evidence; `node tools/fleet.mjs` prints how many are still open.

## Where the numbers live

| Surface | Where it is computed |
| --- | --- |
| Fund value, units, dealing rules | `src/core/unitlinked.ts`, `src/core/fund.ts` |
| Money and rounding | `src/core/money.ts` |
| Books, balances, proofs | `src/core/ledger.ts`, `src/core/chart.ts` |
| Takaful pools and gates | `src/core/takaful.ts` |
| Claims, authority, recoveries | `src/core/claims.ts` |
| Underwriting | `src/core/underwriting.ts` |
| Group consolidation | `src/core/groupfinance.ts` |
| Micro-duration cover | `src/core/billing.ts` |
| Snapshot and restore | `src/core/persistence.ts` |
