# 07 — The sixty-minute tour

*Generated from `src/core/tour.ts` — the same data the console's Tour tab runs. 20 steps, 60 minutes.*

> **Live app:** run `npm install && npm run build && npm start`, then open the console and start on the **Tour** tab. Every number you see is computed by an engine in `src/core`; nothing on the screen is seeded display text.

## Before you start

| # | Time | Tab | What you are doing |
| --- | --- | --- | --- |
| 1 | 00:00 | Overview | Land on the whole book in one screen |
| 2 | 00:04 | Customer journey | Walk a sale through nineteen closed sections |
| 3 | 00:08 | Master settings & ERP | Set the tenant: country, calendar, money, fields and products |
| 4 | 00:10 | Policyholder | Look through a unit-linked policy into real instruments |
| 5 | 00:14 | Decision theatre | Price a switch and a withdrawal before anything moves |
| 6 | 00:18 | Cover control | Pay for cover only while cover is on |
| 7 | 00:21 | Funds & NAV | Run the NAV engine and see the rules behind a price |
| 8 | 00:25 | Takaful | Run a takaful window that is structural, not cosmetic |
| 9 | 00:29 | Group finance | Consolidate three entities, two currencies, one set of books |
| 10 | 00:32 | Underwriting | Underwrite against a manual held as data |
| 11 | 00:36 | Claims | Pay a claim through authority, not through a spreadsheet |
| 12 | 00:40 | Reinsurance | Hand part of the risk to someone else, on the record |
| 13 | 00:43 | Funds accounting | Configure fund accounting per country and watch the vouchers write themselves |
| 14 | 00:46 | Super funds | Run a superannuation book: members, monthly charges and pro-rata income allocation |
| 15 | 00:49 | Data warehouse | Query the single warehouse, fingerprinted exports and governed Snowflake / Excel / Access connections |
| 16 | 00:52 | Batch processing | Run governed batch processing with event-based accounting and the terminal stop rule |
| 17 | 00:54 | Application theme | Re-skin the entire ERP globally or scope a brand to a partner and omni-channel |
| 18 | 00:56 | What's New | Read the plain-language release log and draft an entry from a commit |
| 19 | 00:57 | Durability | Prove the books, and the reporting registers, can be restored |
| 20 | 00:59 | Overview | The remainder of the hour: the fabric around the money |

## 1. 00:00 — Land on the whole book in one screen

**Tab:** Overview · **4 minutes**

Before touching anything: this is one tenant, two legal entities and a Malaysian subsidiary, and every number here is computed live from the engine, not seeded display text.

**Do this**

- Read the Tenant card: three entities, two currencies, two regulators.
- Read the sticky note at the top of the screen, then the one inside a section: what it is for, what to do in it, and the live figures behind the sentence. The ✳ AI guide switch in the header hides every note in the console.
- Note the unit-linked fund value, the sum assured, and "reproduced from log".
- Look at the Books card: both entity books report balanced.

**You should see**

- Fund value for UL-000123 is a live valuation, and the units reproduce from the transaction log alone.
- Takaful pools and the conventional book are separate; the books card proves it.
- The header carries the tenant’s own calendar and money: country, time zone with its UTC offset, the date and time in the tenant’s format, and the local currency.

*Endpoints: GET /api/world*

## 2. 00:04 — Walk a sale through nineteen closed sections

**Tab:** Customer journey · **4 minutes**

This is the front door of the whole ERP: onboarding, needs analysis, recommendation, cover, loadings, riders, medical evidence, funds, beneficiaries, the underwriting decision, a quotation PDF emailed to the customer, six ways to pay, the binding route, conversion — and then allocation and investment progress. Every section starts closed, and the next one opens itself only when the one before it is 100% complete on its mandatory fields.

**Do this**

- Read the rail: four sections ticked, section 5 (coverage & premium) open, everything behind it locked.
- Fill the coverage section and submit it — watch it close and the loadings section open itself.
- Reopen a completed section, clear a mandatory field and submit: the refusal names the field.
- Run the sequence to the quotation and fetch the PDF; then pay by card and convert the policy.

**You should see**

- A locked section explains which section holds it, instead of opening a form that cannot be submitted.
- The quotation section produces a real PDF with a fingerprint, and an email record with a masked address.
- A policy is issued only on money that has cleared, with the allocation and beneficiaries the customer signed.

*Endpoints: GET /api/journey · POST /api/journey/save · POST /api/journey/submit · POST /api/journey/quotation/pdf*

## 3. 00:08 — Set the tenant: country, calendar, money, fields and products

**Tab:** Master settings & ERP · **2 minutes**

Everything the console shows is filed somewhere. This is the screen where a tenant says where it operates, what it calls a premium, which fields are mandatory and which products exist — and every other screen reads those answers instead of hardcoding them.

**Do this**

- Open section 1 and read the regional card: country, operating region, IANA time zone, date and clock format, local currency, and the foreign rate card with the date each rate was quoted.
- Pick Malaysia: the country pack proposes Asia/Kuala_Lumpur, the ringgit and its states, and the rate card is rebased onto the new local currency rather than dropped.
- Open the journey field rules, rename “Sum assured” to “Amount of cover”, save, and then look at the customer journey: the new name is on the form and in the outstanding-field checklist.
- Open the product factory, filter the shelf to Hull & aviation, and pull Marine Hull & Machinery into the form.

**You should see**

- Ninety-odd filed varieties across seventeen lines, each with its own entry ages, tariff and reinsurance thresholds — including a hull risk the underwriting engine will price.
- A rename is filed wording with a trail: who changed it, from what, to what and when; an empty name restores the default.
- A rate quoted through the FX master lands on the same regional card, because there is one rate card and not two.

*Endpoints: GET /api/master/regional · POST /api/master/regional · POST /api/master/regional/currency · POST /api/journey/field-settings · POST /api/master/product*

## 4. 00:10 — Look through a unit-linked policy into real instruments

**Tab:** Policyholder · **4 minutes**

This is the claim that beats ILAS: not just fund accounting, but genuine look-through into the instruments the fund actually holds, with a price date on every exposure.

**Do this**

- Read the fund value and the units held per fund.
- Read the penetration table: fund, instrument, weight, value, market price, price date.
- Scroll the transaction log and read the dealing rule under each movement.

**You should see**

- Each holding shows the instrument, its market price and the date that price was taken.
- Every transaction carries the valuation date and a sentence explaining which cut-off applied.

*Endpoints: GET /api/world · GET /api/units*

## 5. 00:14 — Price a switch and a withdrawal before anything moves

**Tab:** Decision theatre · **4 minutes**

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

## 6. 00:18 — Pay for cover only while cover is on

**Tab:** Cover control · **3 minutes**

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

## 7. 00:21 — Run the NAV engine and see the rules behind a price

**Tab:** Funds & NAV · **4 minutes**

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

## 8. 00:25 — Run a takaful window that is structural, not cosmetic

**Tab:** Takaful · **4 minutes**

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

## 9. 00:29 — Consolidate three entities, two currencies, one set of books

**Tab:** Group finance · **3 minutes**

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

## 10. 00:32 — Underwrite against a manual held as data

**Tab:** Underwriting · **4 minutes**

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

## 11. 00:36 — Pay a claim through authority, not through a spreadsheet

**Tab:** Claims · **4 minutes**

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

## 12. 00:40 — Hand part of the risk to someone else, on the record

**Tab:** Reinsurance · **3 minutes**

An insurer that keeps every risk whole is one bad quarter from ruin. This is the treaty register and the utilisation statement behind it: a quota share on the life case, a surplus treaty over a 200,000 retention, catastrophe cover, and a retakaful treaty for the takaful window — with the participant-money segregation rule enforced in code, the security behind every counterparty's promise measured against what it owes us, and the reporting extracts — the supervisory return, the actuary's exhibits and a bordereau per counterparty — built from the same register and refused issue when they do not tie to the books.

**Do this**

- Read the two statements: the conventional book and the takaful window, each with its own treaties.
- Press "Cede a further risk": the engine authorises the cession, prices it and posts it — and the utilisation statement moves. Naming the same risk twice is refused rather than double-counted.
- Press "Place a risk facultatively": the reinsurer accepts the named risk first, then the premium moves.
- Read "The refusals": a risk the reinsurer has not accepted, and participant money offered to a conventional treaty.
- Press "Claim a catastrophe event", then "Reinstate the catastrophe cover": the layer pays above the retention, the cover is eaten, and the first reinstatement is free.
- Read the deposit card: premium paid on account is an asset, and the period settles against the real subject premium.
- Press "Settle the outstanding recovery": what the reinsurer still owes turns into cash, and the ageing resets.
- Read "Security behind the reinsurers' promises": Emirates Re carries a 50,000.00 shortfall while being six days late on the recovery it already owes — and Gulf Reinsurance PSC is holding 516.61 more security than its treaties require.
- Press "Answer the outstanding cash call": the shortfall is called, then answered, and the cover goes to 100.00% with the cash posted to restricted cash.
- Press "Release the security we no longer need": the surplus goes back, the payable returns to the books, and the release is journaled.
- Press "Credit the interest on their cash": interest earned on a counterparty's cash is theirs, and it is carried as more of what we owe them — a retakaful treaty refuses interest altogether.
- Read "The supervisory return, issued": four schedules built from the register, eight controls each tied to a ledger account, and the issued fingerprint. A return that does not tie to the books cannot be issued at all.
- Open the actuary's exhibits and find the line that says what they do not claim to know: no IBNR, no discounting, no unexpired premium the ledger does not hold.
- Read "The window files its own return": the participant risk fund reports its own retakaful, in its own entity, with the wakalah fee shown as the operator's income rather than mixed in.
- Press "Reissue the return after a later event": a catastrophe is claimed, the figures move, and version 2 is issued against version 1 with the reason written down — nothing is quietly rewritten.

**You should see**

- Ceded premium, commission, net retained premium and the recoverable appear in the books, not just on screen.
- Every cession names the journal it produced, and the recoverable on the statement equals the receivable in the ledger.
- A deposit-accounted treaty recognises no premium income and no claim expense at all — the balance sheet carries it until settlement.
- Cash security and withheld premium appear as restricted cash and as security owed back; a letter of credit is disclosed and never posted as cash.
- The cash call asks for the shortfall and nothing more, and a second call for the same gap is refused while the first is unanswered.
- Each bordereau closes on the same figures the return carries for that counterparty, so a query lands on one number rather than three.
- An issued extract reproduces exactly when it is recomputed; once later transactions move the books, the old extract stays as issued and says so.

*Endpoints: GET /api/reinsurance · GET /api/reinsurance/security · GET /api/extracts · POST /api/extracts/issue · POST /api/extracts/verify · POST /api/reinsurance/cede · POST /api/reinsurance/facultative · POST /api/reinsurance/recover · POST /api/reinsurance/event · POST /api/reinsurance/reinstate · POST /api/reinsurance/deposit · POST /api/reinsurance/deposit/settle · POST /api/reinsurance/settle · POST /api/reinsurance/security/hold · POST /api/reinsurance/security/call · POST /api/reinsurance/security/call/settle · POST /api/reinsurance/security/release · POST /api/reinsurance/security/interest*

## 13. 00:43 — Configure fund accounting per country and watch the vouchers write themselves

**Tab:** Funds accounting · **3 minutes**

Every fund posts differently per country standard — IFRS 17 in the UAE, SOCPA in Saudi Arabia, BNM MFRS 17 in Malaysia, AASB 17 for Australian super — and every policy event (deposit, accrual, premium adjustment, allocation, gain, loss, withdrawal, sum-assured reduction, sum-at-risk) posts a balanced double-entry voucher whose description names the policy, product, partner, omni-channel, sub-channel and fund. The dynamic mapping is the rule: product → fund → GL accounts with priority so a partner-specific row wins over a product-generic one.

**Do this**

- Read the country configs: AE (IFRS17/CBUAE), SA (SOCPA), MY (BNM-MFRS17), AU (LOCAL-GAAP), GB (IFRS17) — each with currency and fiscal year end.
- Open the fund config table: country × product line × fund × valuation method × revenue recognition, then the dynamic mappings — fund → debit/credit accounts keyed by product, sub-product, partner, channel, sub-channel and policy with a priority.
- Use the event simulator: pick a policy, a product, a partner, a channel, a sub-channel, a fund and an event (e.g. premium-received → deposit-amount → accruals → premium adjustments → investment allocations → investment gain → partial withdrawal → reduced sum assured). Press Post — the voucher appears with the full description and the mapping it used.
- Read the voucher list: each line carries the GL accounts, the amount, the mapping id and the note — and the ledger proof beside it stays balanced.

**You should see**

- A country config cannot be created with a non-ISO country or currency; the refusal says so.
- A mapping that maps debit === credit is refused — a voucher must move money, not park it.
- The voucher description always names the policy, product, partner, channel, sub-channel and fund — and which mapping was resolved — so an auditor never asks “why did this account move”.
- All vouchers are balanced by construction and the total voucher count increments with each event.

*Endpoints: GET /api/funds-accounting · POST /api/funds-accounting/country · POST /api/funds-accounting/mapping · POST /api/funds-accounting/event*

## 14. 00:46 — Run a superannuation book: members, monthly charges and pro-rata income allocation

**Tab:** Super funds · **3 minutes**

Alongside life, medical, group life, motor, hull, home-contents and travel sits the super funds book — a unit-linked accumulation product with monthly processing charges (admin + investment fee) and investment income allocation via premium post-adjustment. The member balance, the charge run and the allocation artefact are all auditable.

**Do this**

- Read the super products: Accumulation (Balanced Growth), Pension (Conservative Income), TTR (Flexible Growth) — each with admin fee and investment-fee BPS.
- Open the member register: two members seeded, each with fund, balance, contributions, charges and income.
- Press “Run monthly charges”: the admin + pro-rated investment fee is deducted from each active member and the run appears in the history.
- Enter a fund (SUPER-BAL), a period (2026-10) and an investment gain, press “Allocate income” — the gain is split pro-rata to balances and credited via premium post-adjustment.

**You should see**

- A super product with a member policy cannot be deleted — the refusal names the holders.
- A contribution of zero or negative is refused.
- A charge run on a book with no active members is refused.
- Income allocation on a zero-balance book is refused, and the note carries the method: “premium post-adjustment”.

*Endpoints: GET /api/super-funds · POST /api/super-funds/product · POST /api/super-funds/policy · POST /api/super-funds/charge · POST /api/super-funds/allocate*

## 15. 00:49 — Query the single warehouse, fingerprinted exports and governed Snowflake / Excel / Access connections

**Tab:** Data warehouse · **3 minutes**

Data analysts, engineers and scientists read from one place: nine materialised datasets (policy, premium, fund, claim, reinsurance, commission schedule, super, voucher and member-balance facts), each with grain, source, row count, columns, masked sample rows and lineage. Five native dashboards render in the console, and Snowflake, Microsoft Excel and Microsoft Access connections enforce a signed data-breach agreement, SHA-256 fingerprint-only secrets, and rotating one-way PII masking.

**Do this**

- Read the nine datasets: policy-fact, premium-fact, fund-fact, claim-fact, reinsurance-fact, commission-fact, super-fact, voucher-fact and member-balance-fact — each with columns, masked sample rows and lineage back to the ledger, NAV or registry it came from.
- Open the dashboards: Premium & persistency (Power BI), Fund performance (Tableau), Claims & reinsurance (Qlik Sense), Finance & vouchers (Databricks/Data Fabric) and Distribution (QlikView) — with KPIs, filters and refresh cadence.
- Pick a dataset (e.g. voucher-fact) and press “Download complete CSV” — a fingerprinted export appears with rows, bytes and owner.
- Open tab 5 (Connections — Snowflake / Excel / Access + PII masking): register a governed connection with the data-breach agreement, validate it and run a masked sync preview.

**You should see**

- Every dataset states its grain, its source registry and its freshness date — and PII columns are masked one-way with a method that rotates every transaction.
- Registering a connection without accepting the current data-breach agreement or with a weak/placeholder secret is refused.
- Secrets are stored only as SHA-256 fingerprints and rotating masked previews — the raw secret is never returned.
- The lineage summary says in one sentence why there is a single book: every BI artefact is a derivative of the same ledger.

*Endpoints: GET /api/warehouse · POST /api/warehouse/export · POST /api/warehouse/connections · POST /api/warehouse/connections/validate · POST /api/warehouse/connections/sync-preview*

## 16. 00:52 — Run governed batch processing with event-based accounting and the terminal stop rule

**Tab:** Batch processing · **2 minutes**

Quotation generation, illustration generation, policy issuance and monthly anniversary runs (mortality, premium accrual, commission accrual, clawback, fund management charges and dividend distribution) run as repeatable batches over the book — stopping automatically when a policy lapses, is fully withdrawn or is surrendered.

**Do this**

- Read the nine filed batch event definitions: schedule, basis, rate in bps, debit account, credit account and applicable statuses.
- Select an event (e.g. Monthly anniversary — mortality or Commission clawback) and press “▶ Run batch” for period 2026-10.
- Inspect the latest run lines: active policies post balanced vouchers while lapsed/withdrawn/surrendered policies report skipped-terminal (and clawback targets leavers).

**You should see**

- Terminal policies are never charged on anniversary runs and are explicitly reported as skipped-terminal.
- Re-running the same event and period is idempotent: already-processed subjects report duplicate-skipped.

*Endpoints: GET /api/batch · POST /api/batch/setup · POST /api/batch/run*

## 17. 00:54 — Re-skin the entire ERP globally or scope a brand to a partner and omni-channel

**Tab:** Application theme · **2 minutes**

An insurer, a broker and a bank each carry their own visual identity. The entity theme applies globally across all 26 tabs; partner and omni-channel themes apply only to customer- and partner-facing surfaces (Partner settings, Customer journey, Underwriting/Quotation, Onboarding and Policyholder).

**Do this**

- Click any one-click brand preset (e.g. Royal Takaful Emerald & Gold, Gulf Sovereign Gold & Navy, or Executive Daylight) or click “Apply / Set active” on ALK-TKF in the Filed theme layers table.
- Upload a logo or press “✳ Generate AI-assisted theme” to derive a full 8-token WCAG-AA palette and watch the console shell, cards, tables and inputs re-skin immediately.
- Switch to Partner or Omni-channel theme, apply a palette, and open Customer journey to see the scoped brand banner and surface tokens in place.

**You should see**

- Entity themes update the global CSS variables on the root document immediately.
- Partner and omni-channel themes apply to scoped customer/partner surfaces without overwriting the global entity theme on back-office tabs.
- Every theme upload, preset application, activation and toggle is recorded on the theme audit trail and AI ledger.

*Endpoints: GET /api/themes · POST /api/themes/upload · POST /api/themes/activate · POST /api/themes/toggle*

## 18. 00:56 — Read the plain-language release log and draft an entry from a commit

**Tab:** What's New · **1 minutes**

Shipped changes should not hide in git history: every feature, fix, security gate and data change is filed newest-first with Why, What changed and What you need to do.

**Do this**

- Filter the feed by feature, security, data or fix and read the entries for PR #10, PR #11 and PR #12.
- Enter a commit subject and two-paragraph body in the generator form and press “Generate & file entry”.

**You should see**

- Each entry names its commit/PR source, risk level, target console tab and operator action.
- Generating from a commit categorises the change and files it at the top of the feed.

*Endpoints: GET /api/whats-new · POST /api/whats-new · POST /api/whats-new/from-commits*

## 19. 00:57 — Prove the books, and the reporting registers, can be restored

**Tab:** Durability · **2 minutes**

A demo that cannot survive a restart is not an ERP. This seals the books into a canonical, fingerprinted snapshot and rebuilds a fresh ledger from that text — and does the same for the reporting registers: the returns, rule decisions, letters and filings are sealed together, replayed into a fresh world and checked one by one, with a hash-chained outbox proving nothing was dropped between snapshots.

**Do this**

- Read the snapshot summary: accounts, journals, size, fingerprint.
- Press "Run durability drill".
- Read the per-entity result: balanced, trial balance agrees, restore time.
- Read the reporting register card: how many returns, decisions, letters and filings it holds, and the outbox chain.
- Press "Rebuild every register from the snapshot" and read what came back.

**You should see**

- The restore reports the same journals and the same balances, in milliseconds.
- The fingerprint is stable across runs, so a tampered payload would be caught.
- Every reporting register replays: each return keeps its fingerprint, each rule decision follows again from its own facts, each letter regenerates from its own facts, and each filing carries the answer it got — with the outbox chaining from the beginning.
- The actions the registers took come back too: the catastrophe recovery is claimed again through the reinsurance register and posts the same journal, and the books return journal for journal, not just to the same totals.

*Endpoints: GET /api/state · POST /api/state/drill · GET /api/state/registers · POST /api/state/registers/drill*

## 20. 00:59 — The remainder of the hour: the fabric around the money

**Tab:** Overview · **1 minutes**

The modules an insurer actually runs on — onboarding, ingestion, consent, regulatory packs, the UAE reinsurance rule book, renaming and AI governance, the rule book with its three answers and the wording book that holds the mandated paragraphs, and the submission log with the supervisor’s references — each one wired to something you can press, and the rule book answers with the answer the desk actually gets: allowed, held for a named human, or refused.

**Do this**

- Onboarding: read the chip read, the government lookup and the OCR consensus, then find the field in the review queue.
- Ingestion: submit a file of any shape, watch it map its own columns, quarantine the bad rows and suppress the duplicate.
- Parties & consent: run a partner lookup with consent, then without it, and read the access log.
- Regulatory: read the pre-sale gates for motor and medical, the comparison matrix behind a motor quote, the UAE reinsurance rule book — put a placement past it and read the answer — the wording book, which drafts the letters with their mandated paragraphs in both languages, and the submission log — file the return, and record the reference that comes back.
- Labels & rename: rename a label in one scope only and watch the other scope keep its own word.
- Regulatory rule book: a clean placement is allowed and an unrated counterparty is held for a named human with the missing evidence listed — the two buttons give different answers on purpose.
- Filing: the return goes through the CBUAE channel with its cover letter attached, and the filing stays outstanding until the supervisor’s reference is recorded against it.
- Wording: the note to the policyholder is drafted with three mandated paragraphs in English and Arabic, and the window’s treaty note says Contribution where the conventional book says Premium — with the same segregation paragraph, word for word.
- AI ledger: read the prohibited intents, then try to get one executed and read the refusal.
- Books: read the trial balance and the journal list for an entity.

**You should see**

- Quarantined rows carry a reason per column; duplicates are suppressed, not double-counted.
- A refused AI action stays refused, and the attempt is still on the record.

*Endpoints: POST /api/ingest/submit · POST /api/ingest/commit · POST /api/partner/lookup · POST /api/pre-sale · GET /api/regulatory/uae-rules · POST /api/regulatory/uae/check · GET /api/wording · POST /api/wording/generate · GET /api/submissions · POST /api/submissions/file · POST /api/submissions/acknowledge · POST /api/ai/approve · POST /api/ai/execute*

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
