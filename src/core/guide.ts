/**
 * The AI guide: a sticky note at the top of every section of every screen.
 *
 * An operator who has never used this console faces nineteen closed sections, a claims workbench with
 * five gates and a master-settings hub with nine. The answer is not a manual they will not read; it is
 * a short note, in the place they are looking, saying what this section is for, what to do in it and
 * what to watch — with the live figures from the engine folded in, so the note says "4 of 19 sections
 * complete" rather than "complete the sections".
 *
 * The notes are held as data here rather than as prose in the components, for the same reason the tour
 * is: a test can prove every screen and every section has one, and a rename or a re-wording is an edit
 * to a table rather than a hunt through nine files. What the console adds is only what the console
 * knows — whether a section is open, how far through it the operator is, and what is still missing.
 *
 * The guide can be turned off. It is a helper, not a barrier: one switch at the top of the console
 * controls every note, the choice is remembered, and the change goes on the audit trail because a
 * compliance reviewer asking "was the operator shown the guidance?" deserves a factual answer.
 */
import type { World } from './demo.js';
import { CONSOLE_TABS } from './tour.js';

export type GuideTone = 'info' | 'ok' | 'warn' | 'bad';

/** What a human wrote about a screen or a section, before the engine adds the live figures. */
export interface GuideSeed {
  readonly headline: string;
  readonly body: string;
  readonly doThis: readonly string[];
  readonly watch?: string;
}

/** A composed note: the seed plus the facts the engine knows, ready to render. */
export interface GuideNote {
  readonly id: string;
  readonly tab: string;
  readonly tabLabel: string;
  readonly section: string | null;
  readonly title: string;
  readonly headline: string;
  readonly body: string;
  readonly doThis: readonly string[];
  readonly watch: string | null;
  readonly facts: readonly string[];
  readonly tone: GuideTone;
  /** True when a human wrote the playbook entry; false when the note was composed from the section's state. */
  readonly curated: boolean;
}

/* ------------------------------------------------------------------ the playbook: one note per screen */

export const TAB_GUIDES: Readonly<Record<string, GuideSeed>> = Object.freeze({
  tour: {
    headline: 'Sixty minutes, in the order the money moves',
    body: 'The tour is data, not prose: every step names a tab, what to press and what you should see, and the whole thing adds up to exactly one hour. Run it top to bottom on a fresh demo world and you will have touched every engine.',
    doThis: ['Start on Overview and read the tenant card before touching anything.', 'Follow each step on its own tab rather than reading ahead.', 'Reset the demo data at the end and run it again to see the same numbers come back.'],
    watch: 'The tour describes what the engine did, not what it will do for a different tenant: the figures come from the world in memory.',
  },
  overview: {
    headline: 'The whole book on one screen, computed live',
    body: 'One tenant, three legal entities, two currencies, two regulators — and every figure here is the engine answering, not a seeded string. Start here to see what exists, then use the buttons to jump into the screen that owns it.',
    doThis: ['Read the entity pills: conventional, takaful window and the Malaysian subsidiary, each with its own regulator and currency.', 'Check the books card: both entity books must report balanced.', 'Press the buttons along the top to walk into a journey, a proposal or a claim.'],
    watch: 'A figure that looks wrong here is wrong everywhere: it is the same snapshot every other screen reads.',
  },
  journey: {
    headline: 'The sale on rails: nineteen sections, one open',
    body: 'This is the front door of the ERP. Every section starts closed; the one the engine recommends opens itself, and the next one opens only when this one is 100% complete on its mandatory fields and its domain gates. The same gate runs in the API, so a script cannot walk past the sequence either.',
    doThis: ['Work the open section, then submit it and watch the next one open itself.', 'Reopen a completed section and clear a mandatory field: the refusal names the field.', 'Read each section\u2019s guide note before filling it in — that is what this banner is for.'],
    watch: 'Conditional, legal and regulatory requirements stay hard gates. Master settings can relax an ordinary required flag; they cannot relax a rule the pack insists on.',
  },
  master: {
    headline: 'Change what the whole system means, without a release',
    body: 'Master settings is where the tenant is configured: the product catalogue and its underwriting numbers, the charge schedule, the takaful window, the claims authority matrix, the FX rate card, the vocabulary, which journey fields are mandatory or editable and what they are called, and the country, region, calendar, time zone and currencies the whole console runs on.',
    doThis: ['Set country, region, time zone and currencies first: every date and every new product is read against them.', 'Define or re-file a product in the factory, then check it appears in the journey\u2019s recommendation list.', 'Rename a journey field or a vocabulary label and watch the change reach the screens that render it.'],
    watch: 'These settings are filed data with an audit trail, not preferences: a change here re-prices new business and re-words documents, so it is recorded with the actor and the time.',
  },
  policyholder: {
    headline: 'Look through the policy into the instruments it holds',
    body: 'Not just fund accounting: genuine look-through into what each fund owns, with a price and a price date on every exposure, and a transaction log where each movement carries the dealing rule that priced it. The policyholder view is the same data in the customer\u2019s own vocabulary.',
    doThis: ['Read the fund value and the units per fund, then the penetration table behind them.', 'Scroll the transactions and read the dealing rule under each one.', 'Switch the language to see the same screen in the takaful window\u2019s regulated vocabulary.'],
    watch: 'Market prices are shown for information only and may be delayed; the illustration is an illustration, never a forecast.',
  },
  decisions: {
    headline: 'Price the decision before the customer takes it',
    body: 'A switch, a withdrawal and a projection, each priced by the same rules the live engine uses, each showing the valuation date, the fee, the net figure and the sentence that explains which cut-off applied. Nothing moves until someone commits it.',
    doThis: ['Price a switch and read units out, units in, fee and net invested.', 'Move the instruction time past the cut-off and watch the valuation date move.', 'Read the projection envelopes — adverse, central, favourable — and the disclaimer under them.'],
    watch: 'A projection is not a promise. The disclaimer is part of the answer and travels with the document.',
  },
  cover: {
    headline: 'Pay for cover only while cover is on',
    body: 'Daily and pay-as-you-go cover as a billing primitive: a day is either paid or cover suspends, and nothing restarts by itself. The wallet, the segments and the statement are all here, and the charge for a stopped day is zero.',
    doThis: ['Read the segments: start, stop, daily rate, what has been charged.', 'Stop cover, advance the clock and watch nothing accrue.', 'Empty the wallet and tick again: cover suspends instead of going negative.'],
    watch: 'Auto-start is off unless the customer elected it in writing — a renewal nobody asked for is a complaint waiting to happen.',
  },
  funds: {
    headline: 'The NAV engine, with its rules visible',
    body: 'Cut-off times, the business-day calendar, the floor price and its named residual are all shown, and reconciliation is an assertion rather than a promise: units × price + residual = NAV, to the minor unit.',
    doThis: ['Read the valuation history per fund, including today.', 'Read the look-through composition and any Shariah composition warning.', 'Find the reconciliation line and check the residual is named, not buried in rounding.'],
    watch: 'A non-screened instrument inside a Shariah fund raises a warning; it never passes silently.',
  },
  takaful: {
    headline: 'A takaful window that is structural, not cosmetic',
    body: 'Three funds, a real wakalah fee, tabarru\u2019 into the participant risk fund, qard hasan when the pool is short, and a surplus that cannot be distributed until the actuary, the Shariah Committee and the board have all signed — with the UAE rule that participants never receive surplus applied on top.',
    doThis: ['Read the three pool balances and the operator fund.', 'Try to distribute the surplus and read the blockers one by one.', 'Sign as actuary, then Shariah, then board, and watch the blockers fall away.'],
    watch: 'Participant money and shareholder money stay apart. A posting that mixes them is refused, not adjusted.',
  },
  group: {
    headline: 'Three entities, two currencies, one set of books',
    body: 'Assets and liabilities at the closing rate, income and expenses at the average rate, equity at the rate on the day it moved, the gap shown as a translation reserve, intercompany eliminated, and a minority interest stated rather than absorbed.',
    doThis: ['Read the entity table: functional currency, ownership, net assets, result, translation reserve.', 'Read the intercompany table — one pair eliminates cleanly, the other shows in transit.', 'Run the consolidation twice and watch nothing new get posted.'],
    watch: 'A consolidation never invents a rate: a missing one is refused rather than estimated.',
  },
  underwriting: {
    headline: 'Rules, decision and authority — kept apart',
    body: 'The manual scores the risk; the decision says what the risk merits; the authority says who may sign it. An AI agent may accept, rate or exclude inside its own limit and may never decline one — a decline, a postponement or anything above the limit becomes a referral to a named human.',
    doThis: ['Register a proposal and read the reasons, each with the source that produced it.', 'Read the reinsurance line: automatic or facultative, and the threshold behind it.', 'Take the decision and check the authority that was allowed to take it.'],
    watch: 'Anything above the automatic binding limit is flagged for the reinsurer before issue — finding it after issue is how a treaty gets breached.',
  },
  claims: {
    headline: 'Pay a claim through authority, not through a spreadsheet',
    body: 'Request, triage, reserve, decision, settlement and recovery, each step recorded with who took it and what limit allowed them to. A payout above a limit routes to a named human; an AI agent may triage inside its own limit and may never approve one.',
    doThis: ['Register a claim and read the triage: cover in force, exclusions, days late, fraud signals.', 'Set a reserve with a rationale, then take the decision inside the authority table.', 'Settle and record a recovery, and check the journals each step produced.'],
    watch: 'Approving or paying a claim is on the AI prohibited list. A refused action stays refused and stays on the record.',
  },
  reinsurance: {
    headline: 'Hand part of the risk to someone else, on the record',
    body: 'The treaty register and the utilisation statement behind it: quota share, surplus over a retention, catastrophe cover and a retakaful treaty for the window — with the security behind every counterparty measured against what it owes us.',
    doThis: ['Cede a risk and watch the utilisation statement and the books move together.', 'Place a risk facultatively: the reinsurer accepts the named risk first, then the premium moves.', 'Read the security table for a shortfall or a surplus held.'],
    watch: 'Participant money offered to a conventional treaty is refused. So is naming the same risk twice.',
  },
  onboarding: {
    headline: 'Read the document, then say how sure you are',
    body: 'A chip read, a government lookup and an OCR consensus, each with its own confidence and its own field-level agreement — and anything the machine is not sure about lands in a review queue for a human, with the reason attached.',
    doThis: ['Read the chip extraction: every field, with its source.', 'Read the OCR consensus and the fields the readers disagreed on.', 'Open the review queue and see why each field is there.'],
    watch: 'A low-confidence field is never silently accepted as identity evidence.',
  },
  ingest: {
    headline: 'Submit a file of any shape and watch it map itself',
    body: 'Column mapping by inference, row-level quarantine with a reason per column, duplicate suppression rather than double counting, and a reconciliation that states what it committed and what it did not.',
    doThis: ['Submit a file and read the inferred column mapping.', 'Read the quarantined rows: each carries the column that failed and why.', 'Commit the load and read the reconciliation summary.'],
    watch: 'A quarantined row is not a lost row — it stays on file until someone rules on it.',
  },
  parties: {
    headline: 'One customer, one record, consent on every look',
    body: 'The party registry with duplicate matching and merging, consents with scopes and expiry, and a partner lookup that only answers when a consent covers the scopes asked for — with an access log recording who looked and what they were shown.',
    doThis: ['Run a partner lookup with a consent and read the disclosed fields.', 'Run it again without one and read the refusal.', 'Read the access log: every lookup is on it.'],
    watch: 'A merged party keeps both identities; nothing is deleted, because a customer history is evidence.',
  },
  regulatory: {
    headline: 'The rule book answers with the answer the desk gets',
    body: 'Pre-sale gates, the comparison matrix behind a quote, the UAE reinsurance rule book, the wording book that drafts letters with their mandated paragraphs in both languages, and the submission log with the supervisor\u2019s references — each returning one of three answers: allowed, held for a named human, or refused.',
    doThis: ['Run the pre-sale check for motor and for medical and compare the answers.', 'Put a placement past the rule book and read which rule caught it.', 'Generate a wording document and read the mandated paragraphs it carries.'],
    watch: 'Regulatory intent is never invented to unblock a case; a refusal names the rule and the missing evidence.',
  },
  ai: {
    headline: 'Agents propose, humans dispose',
    body: 'Every agent action is recorded with its inputs, output, model, cost and risk class. The prohibited list is enforced before an agent can try: no claim approval, no final pricing, no Shariah ruling, no actuarial certification, no ledger override, no surplus distribution.',
    doThis: ['Read the actions awaiting a human and approve or reject one.', 'Read the prohibited list, then try to get one of them executed and read the refusal.', 'Check the total cost the agents have run up.'],
    watch: 'A refused action stays refused, and the attempt stays on the record — that is the point of the ledger.',
  },
  ledger: {
    headline: 'The books prove themselves',
    body: 'Double-entry journals, a trial balance per entity, and a reproduction check: the unit-linked fund value is rebuilt from the transaction log alone and compared with the live holding. If the two disagree, the screen says so.',
    doThis: ['Read the trial balance and the debits-equal-credits proof per entity.', 'Read the recent journals with the engine that produced each one.', 'Read the unit audit: from the log, against the live holding, per fund.'],
    watch: 'The ledger is append-only. A correction is a reversal, never an edit.',
  },
  labels: {
    headline: 'Rename the vocabulary, keep the meaning, keep the trail',
    body: 'Every user-facing string is a key. A tenant — an insurer, or a takaful operator with its own regulated vocabulary — renames a key in a scope and the change flows through screens, documents and statements, with an audit trail of who changed what from what.',
    doThis: ['Read the vocabulary table in conventional wording, then in takaful wording.', 'Rename a label in one scope only and watch the other scope keep its own word.', 'Read the rename audit: key, scope, from, to, actor, date.'],
    watch: 'A rename changes the word, never the rule underneath it. Coverage gaps per locale are reported rather than hidden.',
  },
  durability: {
    headline: 'A demo that cannot survive a restart is not an ERP',
    body: 'The books are sealed into a canonical, fingerprinted snapshot and rebuilt from that text into a fresh world; the reporting registers are sealed, replayed and checked one by one, with a hash-chained outbox proving nothing was dropped between snapshots.',
    doThis: ['Read the snapshot summary: accounts, journals, size, fingerprint.', 'Run the durability drill and read the per-entity result.', 'Rebuild every register from the snapshot and read what came back.'],
    watch: 'The fingerprint is stable across runs, so a tampered payload would be caught — and a restore that disagrees halts the module.',
  },
});

/* ------------------------------------------------------------------ the playbook: one note per section */

/**
 * Keyed `<tab>:<section id>` for the gated rails, and `<tab>:<slug of the card title>` for the plain
 * cards. A section with no entry still gets a note — composed from its own state and its screen's
 * note — so the promise "every section has a guide" does not depend on anyone remembering to write one.
 */
export const SECTION_GUIDES: Readonly<Record<string, GuideSeed>> = Object.freeze({
  /* Short notes for headings inside journey sections: context, not another full-screen manual. */
  'journey:what-the-engine-computed': { headline: 'Read the result with its inputs', body: 'These values come from this case and its current stage, not from a generic illustration. Check the inputs and any outstanding gate before using the result.', doThis: ['Compare the result with the answers above it.'] },
  'journey:the-need-and-the-assumptions-behind-it': { headline: 'The need drives the recommendation', body: 'Income replacement, debt and existing cover inform the suggested protection amount. The customer’s objective, budget and risk appetite are used when products are ranked later.', doThis: ['Check the assumptions against what the customer said before comparing products.'] },
  'journey:how-the-premium-is-built': { headline: 'See what changed the price', body: 'The standard premium, each loading and the final payable amount are shown separately so the customer can understand the price of the selected cover.', doThis: ['Compare each loading with its stated reason and check the reconciliation.'] },
  'journey:rider-schedule': { headline: 'Optional cover changes the quote', body: 'Riders have their own price and evidence requirements; they are not automatically part of the recommended base product.', doThis: ['Review the added cost and required evidence for each selected rider.'] },
  'journey:what-the-first-contribution-buys-at-the-published-valuation': { headline: 'Units depend on the published price', body: 'The allocation uses the fund weights and the displayed valuation date; a later dealing point can change the number of units bought.', doThis: ['Check the weights, fund risk grades and the valuation date.'] },
  'journey:who-receives-the-proceeds': { headline: 'Shares must agree with the customer', body: 'Primary and contingent beneficiaries are separate instructions. Check the names and shares with the customer rather than assuming the default.', doThis: ['Confirm the primary shares total 100% and review the contingent list.'] },
  'journey:the-document-and-the-compliance-checks-behind-it': { headline: 'Review the document before sending', body: 'The quote, expiry, PDF fingerprint and compliance checks belong to this case. A blocked check must be resolved before relying on the document.', doThis: ['Open the PDF and review the checks and expiry.'] },
  'journey:money-taken': { headline: 'Match payment with its reference', body: 'The payment method, fee, net amount and settlement status belong to this quotation; a capture is not the same as cleared funds.', doThis: ['Check the payment reference and settlement status.'] },
  'journey:capacity-and-who-the-case-goes-to-if-this-route-fails': { headline: 'See who can review the case', body: 'The queue and panel show available routes and authority. An escalation still needs an eligible reviewer and a recorded decision.', doThis: ['Check capacity, specialty and delegated limit before routing.'] },
  /* the nineteen sections of the sale */
  'journey:identity': { headline: 'Prove who the customer is before anything else', body: 'Identity is the gate everything behind it rests on: the name in both scripts, the date of birth, the Emirates ID or passport read from the chip where there is one, and the consent to pass the record to the broker. A duplicate found here is merged here, not discovered at claim stage. Verified age and residency also inform later product eligibility; they are not a product recommendation on their own.', doThis: ['Capture the document from the chip read where one exists — it carries a higher confidence than a typed number.', 'Check the duplicate match count before submitting; the engine will not submit a case it believes is a duplicate.', 'Record who the customer consented to be shared with.'], watch: 'A field the OCR was not sure about is in the review queue: resolve it there rather than retyping it here.' },
  'journey:profile': { headline: 'Contact, consent and tax residence, confirmed', body: 'The profile section turns a name into a customer of record: contact details confirmed with the customer, consent scopes captured with their expiry, data residency stated, and the tax residence and identifier that CRS reporting needs. The needs analysis and product recommendation come next: personal details establish the customer record, while suitability is assessed against the stated needs and the products on file.', doThis: ['Tick the contact-confirmed and duplicate-checked boxes only when they are true — they are attested, not decorative.', 'Choose the consent scopes the broker actually needs, not every scope on the list.', 'Record the tax residence and identifier.'], watch: 'Data residency is a hard rule in this pack: an out-of-country residency choice routes the case differently.' },
  'journey:needs': { headline: 'No sale before a documented needs analysis', body: 'The questionnaire is data per country pack, the evaluation is deterministic, and every number it produces carries the assumption behind it: replacement years, dependants, existing cover, outstanding debt, the affordability ceiling and the pre-sale gate.', doThis: ['Answer every mandatory question; the suggested sum assured and the affordability ceiling are computed from them.', 'Record the customer\u2019s stated objective and risk appetite — the recommendation is ranked against both.', 'Read the pre-sale gate result before moving on: a blocked gate stops the sale, not the screen.'], watch: 'The attestation is the customer\u2019s, not the agent\u2019s. It is retrievable years later with the pack version that required it.' },
  'journey:recommendation': { headline: 'Rank the catalogue and show the alternative', body: 'Every product this tenant may sell is ranked against the evaluated need, with the score explained point by point and anything that rules a product out written as a disqualifier rather than a silent zero. The comparison presented to the customer is a regulatory requirement, not a courtesy.', doThis: ['Read the ranked list and the reasons before choosing.', 'Choose a product that fits: one with a disqualifier cannot be submitted.', 'Write the reason for the recommendation as a sentence a suitability review can read.'], watch: 'A recommendation note of one word is refused. The customer\u2019s acceptance and the presentation of alternatives are both recorded.' },
  'journey:coverage': { headline: 'The sum assured, the term and the premium that follows', body: 'Coverage is where the sale becomes numbers: sum assured, term, payment frequency, and the physical and financial facts the underwriting engine scores — age, sex, smoker, height, weight, residence and income.', doThis: ['Enter the sum assured and term, then read the standard premium the engine computes.', 'Check the sum assured against the income multiple this product allows.', 'Confirm the payment frequency the customer will actually keep up.'], watch: 'A sum assured above the income multiple is a financial-underwriting referral, not a data-entry error to be corrected quietly.' },
  'journey:loadings': { headline: 'Loadings from the manual, with a breakdown that reconciles', body: 'Occupation class, medical conditions, pursuits and family history each carry a debit in basis points from the manual held as data. The breakdown is shown line by line and must reconcile with the underwriting file; a waiver needs a named authoriser.', doThis: ['Declare every condition and pursuit — the engine prices what it is told.', 'Read the loading breakdown and check it against the loaded premium.', 'Acknowledge the loading with a named reviewer.'], watch: 'A condition nobody has catalogued goes to a human instead of being guessed at. A waiver without an authoriser is refused.' },
  'journey:riders': { headline: 'Riders are priced, not appended', body: 'Each rider comes from the catalogue with its own loading, its own evidence requirements, its own age band and whether it is Shariah-eligible. Attaching one re-prices the contract and may add medical requirements.', doThis: ['Consider the rider list explicitly, even if the answer is none.', 'Read the extra loading and the evidence each chosen rider brings.', 'Acknowledge the rider set with the customer.'], watch: 'A rider nobody has catalogued is refused, and a rider that is not Shariah-eligible cannot be attached to a takaful plan.' },
  'journey:medical': { headline: 'Evidence ordered, received and read by a human', body: 'The evidence bands in the product manual decide what is required for this age and this sum assured. Requirements are issued, results are recorded against each one, and a named reviewer reads them against the manual.', doThis: ['Issue the requirements the engine lists — they come from the product\u2019s evidence bands.', 'Record each result with its date and reviewer.', 'Write the review note: it is what a second reader relies on.'], watch: 'Evidence ordered but not reviewed leaves the section incomplete; a reviewer name is mandatory, not optional.' },
  'journey:funds': { headline: 'Weights that total exactly one hundred per cent', body: 'For an investment-linked plan the customer\u2019s allocation is set here against the funds\u2019 published valuations, with the risk grade of each fund shown and the dealing rule that will price the first allocation stated.', doThis: ['Set the fund weights; they must total exactly 100%.', 'Check each fund\u2019s Shariah screening against what the customer asked for.', 'Acknowledge the dealing rule and the appetite statement.'], watch: 'Weights that do not total 100% are refused by the same gate the API applies — this is arithmetic, not a warning.' },
  'journey:beneficiaries': { headline: 'Who is paid, and in what shares', body: 'Beneficiaries with their relationship and share, primary and contingent, totalling exactly 100%. This is the section a family reads after the worst day of their lives, so it is recorded precisely and confirmed by the customer.', doThis: ['Name each beneficiary with their relationship and share.', 'Check the shares total 100%.', 'Record the customer\u2019s confirmation of the list.'], watch: 'A share total that is not 100% is refused, and an unnamed beneficiary defaults to the estate — which is rarely what the customer meant.' },
  'journey:uw-review': { headline: 'The questionnaire reviewed and the decision taken', body: 'A named underwriter reviews the questionnaire against the evidence on file, records anything undeclared, and takes the decision: standard, rated, excluded, postponed or declined. An agent may accept or rate inside its limit; it may never decline.', doThis: ['Read the questionnaire review notes and update anything that changed since capture.', 'Take the decision and record who took it.', 'Note whether the decision was taken by an agent inside its straight-through limit.'], watch: 'A declined or postponed risk cannot proceed to quotation — the refusal says so and names the outcome.' },
  'journey:quotation': { headline: 'A real document, with a fingerprint, sent to a real address', body: 'The quotation is issued as a PDF with a fingerprint, emailed in the language the customer chose, with the address masked on the record and a buy link that expires. The compliance checks and any blockers are printed on the same screen.', doThis: ['Issue the quotation and read the compliance checks line by line.', 'Send it to the customer\u2019s address and read the despatch record.', 'Fetch the PDF and check the fingerprint matches the record.'], watch: 'A quotation with an open hard compliance blocker will not issue; the blocker is named rather than waived.' },
  'journey:finalisation': { headline: 'Cooling-off, review and signature', body: 'The customer is told about the cooling-off period, the contract is reviewed with them, and the signature and date are recorded. The cooling-off end date is computed from the pack, not from a habit.', doThis: ['Record that the cooling-off terms were acknowledged.', 'Confirm the contract was reviewed with the customer.', 'Capture the signature and the date.'], watch: 'A signature of fewer than three characters is not a signature and the section will not complete.' },
  'journey:payment': { headline: 'Money cleared before cover, not after', body: 'Six ways to pay — cash, credit card, debit card, bank transfer, buy-now-pay-later and a branch deposit — each with its own fee, settlement period and proof. A card is authenticated and masked; a transfer is held pending until it settles.', doThis: ['Choose the method and read its cost and settlement period.', 'Enter the amount and, for a branch deposit, the branch.', 'Read the reconciliation: what was received, what was deducted, when it settles.'], watch: 'A policy is issued only on money that has cleared. A pending transfer holds the conversion, and the record says so.' },
  'journey:routing': { headline: 'Who is allowed to bind this risk', body: 'The binding route is computed from the sum assured, the loading and the decision: automatic, manual, senior, a freelance underwriter engaged to meet the promised decision time, or the reinsurer asked before issue.', doThis: ['Read the route the engine computed and the flags behind it.', 'Confirm the route and name who confirmed it.', 'Take the senior sign-off where the route requires one.'], watch: 'A route that requires the reinsurer cannot be confirmed without the assist answer on file.' },
  'journey:conversion': { headline: 'The proposal becomes a policy', body: 'Conversion creates the policy in the right book — unit-linked, takaful, conventional or the pay-as-you-go motor wallet — with the commencement date, the initial fund allocation and the beneficiary the customer signed.', doThis: ['Set the commencement date and the initial fund for an investment-linked plan.', 'Name who converted it.', 'Check the policy number and category that came back.'], watch: 'A referred proposal is decided as senior underwriter before it converts; a declined one cannot convert at all.' },
  'journey:allocation': { headline: 'Units bought at the dealing point that applied', body: 'The first allocation is executed against the published valuation: the premium net of charges buys units at the price for the dealing point that the instruction time fell into, and the result is compared with the signed target weights.', doThis: ['Read the allocation: units bought, price used, valuation date and the charge lines deducted.', 'Compare the executed weights with the signed target weights.', 'Note whether a rebalance was requested at issue.'], watch: 'Crossing the cut-off changes the valuation date, not the amount. The explanation on each line says which rule applied.' },
  'journey:investment': { headline: 'Progress reported, statement sent', body: 'The policy\u2019s investment progress since conversion — contributions to date, current fund value, holdings per fund with their price dates — and the statement sent to the customer.', doThis: ['Read the contributions to date and the current value.', 'Check each holding carries its price date.', 'Confirm the statement was sent and who reviewed it.'], watch: 'The value here is reproducible from the transaction log; a difference is investigated, not explained away.' },
  'journey:servicing': { headline: 'Handover to the people who will run it', body: 'The last section closes the sale and opens the service life: the channel the customer will use, who took the handover, and the alterations and claims that already exist on the policy.', doThis: ['Record the service channel the customer chose.', 'Name who took the handover.', 'Read the alteration and claim counts before acknowledging.'], watch: 'Acknowledging the handover does not end the audit trail: every later alteration and claim is recorded against this policy.' },

  /* master settings */
  'master:regional': { headline: 'Country, region, calendar, time zone and currency — set these first', body: 'Everything downstream reads this: which country and operating region the business is written in, the IANA time zone that decides what date and time it is there, the date and clock format the console prints, the local currency new products are filed in, and the foreign rate card the group consolidates against.', doThis: ['Pick the country — region, time zone, currency, date format and week start come with the pack.', 'Override only what genuinely differs, and let the trail record the override.', 'Quote each foreign currency with the date it was quoted at, and mark a peg as a peg.'], watch: 'Changing the local currency rebases the whole rate card on the rationals; if the new currency has no quote on file the card is dropped rather than guessed, and the trail says so.' },
  'master:journey-fields': { headline: 'Rename the fields, and decide which ones are mandatory', body: 'Two powers over the journey, both filed here: what a field is called, and whether the operator must fill it in. A rename reaches the section that renders the field, the missing-field checklist and the refusal message that names it.', doThis: ['Type a display name over any field and save — the original stays on file as the default.', 'Clear a name to go back to the default wording.', 'Relax a required flag only where the pack allows it.'], watch: 'Conditional, legal and regulatory requirements stay hard gates. A field marked optional here may still be required by an independent product, suitability or regulatory check — and a read-only calculated field can never be made editable.' },
  'master:products': { headline: 'The product factory, over a catalogue of filed varieties', body: 'Every variety this tenant may sell is on file with the numbers the engines read: entry ages, the base rate per 1,000, the income multiple, the automatic binding limit, the facultative threshold, the AI straight-through limit and the evidence bands. Naming a catalogue product id prefills all of it.', doThis: ['Filter the table by line to find a variety, then read its blurb — that is what a suitability review reads.', 'Re-file a product by naming its id and changing only what differs.', 'File a new variety with its own limits and check it reaches the journey\u2019s recommendation list.'], watch: 'A minimum entry age at or above the maximum is refused, and a product with no underwriting rules cannot be quoted — the factory registers both together.' },
  'master:charges': { headline: 'The charge schedule behind every unit-linked number', body: 'Allocation, top-up, switching and partial-withdrawal charges in basis points, the monthly cost of insurance per mille and the monthly administration fee. Change one and every later illustration, preview and transaction is priced with it.', doThis: ['Read each charge with the basis it is applied on.', 'Change a charge and re-price a switch on the decision theatre to see it land.', 'Keep the administration fee in minor units — it is money, not a percentage.'], watch: 'Charges are a high-risk setting: a double-charge in simulation halts the module rather than being rounded away.' },
  'master:takaful': { headline: 'The takaful window\u2019s filed parameters', body: 'Wakalah fee, tabarru\u2019 proportion, the participants\u2019 share of surplus and whether surplus may go to savers at all. These are the numbers the surplus gates are checked against, so they are filed data with a trail.', doThis: ['Read the wakalah fee and the tabarru\u2019 proportion the window runs on.', 'Check the participant surplus share against the jurisdiction\u2019s rule.', 'Leave "surplus to savers" off unless the pack allows it.'], watch: 'In the UAE participants never receive surplus: the setting is refused by the gate even if it is switched on here.' },
  'master:authority': { headline: 'Who may pay what, and whether an agent may pay at all', body: 'The claims authority matrix: a role, a limit, whether it is an AI agent, and which book it applies to. Every claim decision is checked against this table, and a decision above a limit routes to a named human.', doThis: ['Add a role with its limit and the book it covers.', 'Mark an AI role explicitly — it may triage but never approve a payout above its limit.', 'Read the table back and check the limits are ordered as intended.'], watch: 'A limit is money: it is parsed with its currency, never as a bare number.' },
  'master:fx-vocabulary': { headline: 'The rate card and the words the tenant uses', body: 'Two settings that both change what the system says: FX rates, registered with the ledger and the group rate table on the date quoted, and vocabulary renames, scoped to a tenant or a single entity so a takaful window can say Contribution where the conventional book says Premium.', doThis: ['Register a rate with the date it was quoted at — a rate without a date cannot be reproduced.', 'Rename a label in one scope and check the other scope kept its own word.', 'Read the rename audit: key, scope, from, to, actor, date.'], watch: 'A rate registered here also updates the regional rate card, so there is one card and not two disagreeing ones.' },
  'master:command': { headline: 'Where each operation actually happens', body: 'A map of the ERP: what exists right now — customers, proposals, policies, receipts, alterations, products, funds, claims — and the button that opens the screen that owns each one.', doThis: ['Read the counts to see what the world holds.', 'Use the numbered buttons to walk the operational sequence.', 'Come back here after a change to see the counts move.'], watch: 'The counts come from the same snapshot as every other screen: if one disagrees with another, that is a defect worth reporting.' },

  /* customers, proposals and policies */
  'parties:create': { headline: 'Create the party once, and let the registry catch the duplicate', body: 'A customer of record: names in both scripts, date of birth, identity documents, phones, emails, addresses and roles. The registry matches against what is already on file and reports the candidates rather than quietly creating a second person.', doThis: ['Capture at least one identity document with its type and number.', 'Read the duplicate matches before saving.', 'Record the consent the broker or agent is working under.'], watch: 'Merging later is possible and audited; creating a second record for one person is how a claim gets paid twice.' },
  'parties:update': { headline: 'Amend a record and keep the before and after', body: 'Every field change is recorded with what it was, what it became, who changed it and when — because a contact update made the week before a claim is exactly the kind of change a reviewer will ask about.', doThis: ['Change what needs changing and give a reason.', 'Read the alteration record that came back.', 'Check the identity documents still agree with the name on file.'], watch: 'Nothing is overwritten silently: the previous value stays on the trail.' },
  'parties:consent': { headline: 'Consent with scopes, a purpose and an expiry', body: 'A partner lookup only answers when a consent covers the scopes asked for. The consent carries its purpose, who it was granted to and when it expires, and every lookup writes to the access log whether it was allowed or refused.', doThis: ['Grant consent with the narrowest scopes the purpose needs.', 'Set the expiry deliberately rather than leaving it open.', 'Run a lookup and read the access log entry it produced.'], watch: 'A lookup without consent is refused and logged. The refusal is the feature, not a failure.' },
  'underwriting:proposal': { headline: 'Register the risk with the facts the manual scores', body: 'Party, product, sum assured and the risk profile: age, sex, smoker, build, occupation class, pursuits, conditions, family history, residence and income. The engine returns the standard premium, the loading and the outcome with a reason per point.', doThis: ['Choose a product from the catalogue and read its limits before quoting.', 'Enter the profile honestly — the engine prices what it is told.', 'Read the reasons and the reinsurance line before deciding.'], watch: 'A residence outside the product\u2019s accepted territory is a hard decline, not a loading.' },
  'underwriting:decision-conversion': { headline: 'Take the decision inside an authority, then convert', body: 'The decision is standard, rated, excluded, postponed, declined or referred — and it is recorded with who took it and whether they were an agent working inside a straight-through limit. Conversion then creates the policy in the right book, with the beneficiary and the allocation the customer signed.', doThis: ['Read the assessment before deciding, including the evidence required.', 'Decide with a named actor; an agent may accept or rate but never decline.', 'Convert with a commencement date and, for an investment-linked plan, an initial fund.'], watch: 'A referred case needs a human; converting a declined risk is refused, and a case above the binding limit is flagged to the reinsurer first.' },
  'policyholder:premium': { headline: 'Receive the premium and allocate it at the dealing point', body: 'A receipt is money with a journal behind it. For a unit-linked policy the premium net of allocation charge buys units at the price for the dealing point the instruction time fell into; for the takaful window it splits into tabarru\u2019 and the participant investment fund; for the motor wallet it tops up the balance cover is drawn from.', doThis: ['Enter the amount and the method, and read the journal ids that came back.', 'For a unit-linked policy, name the fund the premium is invested in.', 'Check the receipt appears in the log with its units and price.'], watch: 'An instruction after the cut-off is priced at the next valuation point — the explanation on the receipt says which rule applied.' },
  'policyholder:financial': { headline: 'Move money on a policy, with the fee and the journal', body: 'Sum assured changes, fund switches, partial withdrawals, surrenders, policy charges and portfolio rebalances: each is priced by the same engine that prices a new sale, and each posts to the books.', doThis: ['Choose the alteration and read the fee before committing it.', 'Check the before and after values on the record.', 'Read the journal ids the alteration produced.'], watch: 'A surrender is irreversible and is priced at the current valuation; a withdrawal below the minimum leaves the policy unviable and is refused.' },
  'policyholder:non-financial': { headline: 'Change the record without changing the money', body: 'Beneficiary, contact details, name, payment frequency, rebalance weights and policy status: no premium moves, but every change is still recorded with its before and after, because these are the changes a dispute is usually about.', doThis: ['Pick the change and enter the new value.', 'Give a reason — it is read later by someone who was not there.', 'Check the alteration log entry.'], watch: 'A status change to surrendered or cancelled is a financial event in disguise: use the financial alteration for it.' },
  'policyholder:receipts': { headline: 'Every receipt, with the journal behind it', body: 'The premium receipt log in reverse date order: policy, customer, book, amount, fund, units allocated, price per unit, fee deducted, method, actor and the journal ids.', doThis: ['Read the log against the policy\u2019s transaction list.', 'Follow a journal id into the books to see the double entry.', 'Check the units allocated reconcile with the fund value.'], watch: 'A receipt with no journal is a defect: money received must always be posted.' },
  'policyholder:alteration-log': { headline: 'What changed, who changed it, and what it cost', body: 'The alteration log for every policy: financial and non-financial, with the before value, the after value, a summary, any amount and fee, the journals, the actor and the reason.', doThis: ['Filter by policy to read one customer\u2019s history.', 'Read the reason on each entry, not just the amount.', 'Follow the journal ids into the books.'], watch: 'The log is append-only. A wrong entry is corrected by another entry, never removed.' },
  'funds:nav': { headline: 'Publish a valuation and reconcile it', body: 'A NAV injection takes gross assets, liabilities and units in issue at a valuation date and produces a price, a net asset value and a residual that is named rather than hidden. The dealing rule and the business-day calendar decide which date an instruction lands on.', doThis: ['Read each fund\u2019s latest valuation and its history.', 'Check the reconciliation: units × price + residual = NAV.', 'Read the fund management charge accrual.'], watch: 'A valuation that does not reconcile is a stop-the-line event, not a rounding difference to be absorbed.' },
  'funds:new-fund': { headline: 'Create a fund with its dealing rule attached', body: 'A fund is defined by its currency, its charge, its dealing rule and cut-off, its benchmark and whether it is Shariah-screened. Those are the parameters every later price and every instruction time is judged against.', doThis: ['Set the dealing rule and cut-off deliberately — they decide the valuation date of an instruction.', 'State the annual fund management charge in basis points.', 'Mark the Shariah screening honestly: it drives composition warnings.'], watch: 'A screened fund holding a non-screened instrument raises a composition warning that cannot be switched off.' },
  'funds:instrument': { headline: 'Define the instrument, then publish its market price', body: 'Instruments carry an ISIN, an asset class and a Shariah screen; market prices are published per instrument with the date they were taken. The look-through on the policyholder screen is only as good as this data.', doThis: ['Create the instrument with its asset class and screening.', 'Publish a price with the date it was observed.', 'Check the fund composition picks the new price up.'], watch: 'A stale price is reported as stale rather than used silently — the penetration table shows the age of every exposure.' },
  'claims:register': { headline: 'Register the claim, then triage it', body: 'A claim starts as a request with a cause, a date of loss and an estimate. Triage reads whether cover was in force, which exclusions apply, how late the notification is and what fraud signals exist — and routes accordingly.', doThis: ['Register with the policy, the cause and the date of loss.', 'Read the triage result before reserving.', 'Note the notification delay: it affects the decision, not just the record.'], watch: 'A claim on a policy that was not in force at the date of loss is a decline, and the reason is recorded.' },
  'claims:reserve': { headline: 'Reserve with a rationale someone can read later', body: 'The case reserve is the estimate the books carry until the claim settles. It is set, moved and released with a rationale and an actor, and it posts to the ledger rather than living in a spreadsheet.', doThis: ['Set the reserve from the severity table or the evidence in hand.', 'Write the rationale — an actuary will read it.', 'Move the reserve as the facts change rather than waiting for settlement.'], watch: 'A reserve with no rationale is an unexplained number in the financials.' },
  'claims:decide': { headline: 'Approve, decline or refer — inside an authority', body: 'The decision is checked against the authority matrix: a role, a limit, and whether that role is an AI agent. Above the limit it routes to a named human; an agent may never approve a payout above its own limit and may never decline.', doThis: ['Read the authority table before deciding.', 'Decide with a named actor and role.', 'Read the refusal if the amount is above the limit — it names the authority needed.'], watch: 'Approving or paying a claim is on the AI prohibited list; a refusal stays refused and stays on the record.' },
  'claims:settle': { headline: 'Pay it, then recover what someone else owes', body: 'Settlement posts the payment against the reserve and closes the case; recovery records salvage, subrogation or a reinsurance recovery, with the ageing that follows it. Both sides produce journals.', doThis: ['Settle the approved amount and read the journal.', 'Record a recovery with its type and amount.', 'Check the outstanding recovery appears in the reinsurance ageing.'], watch: 'A settlement above the approved amount is refused: the decision, not the payment, is the authority.' },
  'reinsurance:treaty': { headline: 'Register the counterparty and the treaty behind it', body: 'A treaty is filed with its kind, basis, line of business, cession, commission, settlement period, the security it requires and whether it is deposit-accounted. Retakaful treaties are registered separately from conventional ones and never carry interest.', doThis: ['Register the reinsurer with its rating and licence class.', 'File the treaty with its cession and commission.', 'Set the security requirement — it is measured against what the counterparty owes us.'], watch: 'A deposit-accounted treaty recognises no premium income and no claim expense: the balance sheet carries it until settlement.' },
  'reinsurance:register': { headline: 'Cede a risk, or place one facultatively', body: 'Ceding moves a share of a named risk onto a treaty and posts the premium, commission and recoverable. A facultative placement asks the reinsurer to accept the named risk first, and the premium only moves once they have.', doThis: ['Choose the treaty and read its basis and line of business.', 'Cede with the policy, sum insured and premium — naming the same risk twice is refused.', 'For a facultative placement, wait for the acceptance before the premium moves.'], watch: 'Participant money offered to a conventional treaty is refused: the two books stay apart by construction.' },
});

/* ------------------------------------------------------------------ composing a note */

const STATUS_SENTENCE: Readonly<Record<string, string>> = Object.freeze({
  complete: 'This section is complete. Reopen it only to review or amend — the change is recorded either way.',
  'in-progress': 'This section is partly filled in. Finish the outstanding fields and submit it; the next section opens itself when this one reaches 100%.',
  ready: 'This section has not been started. It is open, so work it now: everything behind it stays closed until it is complete.',
  blocked: 'This section cannot be completed yet. Read the blockers — each one names the rule or the missing step that stopped it.',
  locked: 'This section is locked until the one before it is 100% complete. The same gate runs in the API, so nothing here can be submitted early.',
});

export function toneFor(status?: string): GuideTone {
  switch (status) {
    case 'complete': return 'ok';
    case 'blocked': return 'bad';
    case 'in-progress': return 'warn';
    default: return 'info';
  }
}

/** Turn a title into the key a curated note would be filed under. */
export function slug(title: string): string {
  return title.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}

export function tabLabel(tab: string): string {
  return CONSOLE_TABS.find((t) => t.id === tab)?.label ?? tab;
}

export interface SectionGuideInput {
  readonly tab: string;
  /** The section id for a gated rail, or the card's title slug for a plain card. */
  readonly section?: string;
  readonly title: string;
  readonly status?: string;
  readonly percent?: number;
  readonly missing?: readonly string[];
  readonly blockers?: readonly string[];
  /** Live facts for the screen, from the world snapshot. */
  readonly facts?: readonly string[];
}

/**
 * The note for one section. A curated entry wins; without one the note is composed from the section's
 * own state and its screen's note, which is what makes "every section has a guide" true rather than
 * merely intended.
 */
export function sectionGuide(input: SectionGuideInput): GuideNote {
  const tab = TAB_GUIDES[input.tab] ?? TAB_GUIDES['overview']!;
  const key = input.section ? `${input.tab}:${input.section}` : `${input.tab}:${slug(input.title)}`;
  const seed = SECTION_GUIDES[key] ?? SECTION_GUIDES[`${input.tab}:${slug(input.title)}`];
  const title = input.title.replace(/^\d+\.\s*/, '');
  const facts = [...(input.facts ?? [])];

  if (input.status) facts.push(STATUS_SENTENCE[input.status] ?? STATUS_SENTENCE['ready']!);
  if (typeof input.percent === 'number' && input.status !== 'locked') facts.push(`${input.percent}% complete on its mandatory fields and gates.`);
  if (input.missing && input.missing.length > 0) facts.push(`Still outstanding: ${input.missing.slice(0, 6).join(', ')}${input.missing.length > 6 ? ` and ${input.missing.length - 6} more` : ''}.`);
  if (input.blockers && input.blockers.length > 0) facts.push(`Stopped by: ${input.blockers.slice(0, 3).join('; ')}.`);

  if (seed) {
    return {
      id: key, tab: input.tab, tabLabel: tabLabel(input.tab),
      section: input.section ?? slug(input.title), title,
      headline: seed.headline, body: seed.body,
      doThis: [...seed.doThis], watch: seed.watch ?? null,
      facts, tone: input.status ? toneFor(input.status) : 'info', curated: true,
    };
  }

  return {
    id: key, tab: input.tab, tabLabel: tabLabel(input.tab),
    section: input.section ?? slug(input.title), title,
    headline: tab.headline,
    body: `Review “${title}” on the ${tabLabel(input.tab)} screen against the live checks shown here. This note does not make or approve a decision.`,
    doThis: [
      `Check the current values and any blockers in “${title}” before continuing.`,
      ...tab.doThis.slice(0, 2),
    ],
    watch: tab.watch ?? null,
    facts,
    tone: input.status ? toneFor(input.status) : 'info',
    curated: false,
  };
}

/** The note for a whole screen: the tab-level banner at the top of the console. */
export function tabGuide(tab: string, facts: readonly string[] = []): GuideNote {
  const seed = TAB_GUIDES[tab] ?? TAB_GUIDES['overview']!;
  const known = CONSOLE_TABS.some((t) => t.id === tab);
  return {
    id: `tab:${tab}`, tab, tabLabel: tabLabel(tab), section: null, title: tabLabel(tab),
    headline: seed.headline, body: seed.body, doThis: [...seed.doThis], watch: seed.watch ?? null,
    facts: [...facts], tone: 'info', curated: known,
  };
}

/* ------------------------------------------------------------------ live facts, from the world */

/**
 * What the engine can say about each screen right now. These are the sentences that make a note a
 * note rather than a paragraph of documentation: they are computed, so they cannot go stale, and they
 * are attached to the tab so every section banner on that screen carries the same context.
 */
export function worldFacts(w: World): Record<string, string[]> {
  const erp = w.erp;
  const regional = erp.regionalSettings().current;
  const products = erp.listProductMasters();
  const fieldSettings = w.journey.getFieldSettings();
  const renamed = Object.values(fieldSettings)
    .flatMap((stage) => Object.values(stage))
    .filter((setting) => typeof (setting as { label?: unknown }).label === 'string').length;
  const cases = w.journey.list();
  const openClaims = w.claims.position().openClaims + w.takafulClaims.position().openClaims;
  const awaiting = w.ai.awaitingHuman().length;
  const balanced = w.ledger.proof(w.conventionalEntity).balanced;
  const takafulBalanced = w.ledger.proof(w.takafulEntity).balanced;
  const funds = w.nav.listFunds();
  const labelCoverage = w.labels.coverage('ar');
  const parties = w.parties.list().filter((p) => !p.mergedInto).length;
  const qards = w.takaful.listQards().filter((q) => q.status !== 'repaid').length;

  // The local currency governs how the tenant quotes and files; the books keep the currency they were
  // written in. Saying "base currency MYR" over a ledger kept in dirhams would be a lie on every screen.
  const bookCurrency = w.entities.find((e) => e.id === w.conventionalEntity)?.currency ?? regional.localCurrency;
  const shared = [
    `Tenant ${w.tenant.name} · filing entities ${w.entities.map((e) => e.id).join(' and ')}${w.malaysiaEntity ? `, plus ${w.malaysiaEntity} consolidated in the group` : ''} · local currency ${regional.localCurrency}${regional.localCurrency === bookCurrency ? '' : `, with the books kept in ${bookCurrency}`}.`,
    `Calendar: ${regional.countryName} (${regional.operatingRegion}), ${regional.timezone} ${regional.utcOffsetLabel}, dates printed as ${regional.dateFormat} and times as ${regional.timeFormat === '12h' ? 'a 12-hour clock' : 'a 24-hour clock'}.`,
  ];

  return {
    tour: [...shared, `${CONSOLE_TABS.length} screens in the console; the tour is written to cover the money-moving ones in exactly sixty minutes.`],
    overview: [
      ...shared,
      `${parties} customers, ${products.length} products on file, ${funds.length} funds with published valuations.`,
      `Books: conventional ${balanced ? 'balanced' : 'OUT OF BALANCE'}, takaful window ${takafulBalanced ? 'balanced' : 'OUT OF BALANCE'}.`,
      openClaims > 0 ? `${openClaims} claim(s) open and ${awaiting} AI action(s) waiting on a human.` : `No claims open; ${awaiting} AI action(s) waiting on a human.`,
    ],
    journey: [
      ...shared,
      `${cases.length} journey case(s) in flight over 19 gated sections; ${products.length} products are rankable in the recommendation section.`,
      renamed > 0 ? `${renamed} field(s) carry a renamed display label from master settings.` : 'No journey field has been renamed yet — every field shows its default label.',
    ],
    master: [
      ...shared,
      `${products.length} product masters across ${new Set(products.map((p) => p.line)).size} lines; ${products.filter((p) => p.category === 'takaful').length} of them in the takaful window.`,
      `${regional.foreignCurrencies.length} foreign currency quote(s) on the rate card, last set by ${regional.updatedBy}.`,
      renamed > 0 ? `${renamed} journey field label(s) renamed on file.` : 'Journey fields all show their default labels.',
    ],
    policyholder: [...shared, `${funds.length} funds, each with look-through into the instruments it holds and a price date per exposure.`],
    decisions: [...shared, 'Previews are priced by the same engine as live transactions: nothing on this screen has moved money.'],
    cover: [...shared, 'Micro-duration cover charges only between an explicit start and stop; auto-start is off unless it was elected.'],
    funds: [...shared, `${funds.length} funds published; ${funds.filter((f) => f.shariahScreened).length} of them Shariah-screened.`],
    takaful: [...shared, `${w.takaful.listQards().length} qard(s) on file, ${qards} still outstanding; surplus distribution needs the actuary, the Shariah Committee and the board.`],
    group: [...shared, `${w.entities.length + 1} entities consolidated (including ${w.malaysiaEntity}), with the minority interest stated and intercompany balances eliminated.`],
    underwriting: [...shared, `${products.length} products carry underwriting rules; ${w.underwriting.list().length} application(s) registered in the demo world.`],
    claims: [...shared, `${openClaims} claim(s) open across the conventional book and the takaful window.`],
    reinsurance: [...shared, `${w.reinsurance.list().length} conventional treaty/treaties and ${w.retakaful.list().length} retakaful treaty/treaties on the register.`],
    onboarding: [...shared, 'Extractions carry a confidence per field; anything the readers disagreed on is queued for a human.'],
    ingest: [...shared, 'A load maps its own columns, quarantines bad rows with a reason and suppresses duplicates rather than double-counting them.'],
    parties: [...shared, `${parties} active parties, ${w.parties.list().length - parties} merged away; every lookup is written to the access log.`],
    regulatory: [...shared, `${w.submissions.submissions().length} submission(s) on the filing log; the rule book answers allowed, held for a human, or refused.`],
    ai: [...shared, `${w.ai.list().length} agent action(s) recorded, ${awaiting} awaiting a human, US$${w.ai.totalCost().toFixed(2)} of model cost.`],
    ledger: [...shared, `Conventional book ${balanced ? 'balanced' : 'OUT OF BALANCE'}; takaful window ${takafulBalanced ? 'balanced' : 'OUT OF BALANCE'}.`],
    labels: [...shared, `Arabic coverage ${labelCoverage.covered} of ${labelCoverage.total} default keys; ${w.labels.auditTrail().length} rename(s) on the audit trail.`],
    durability: [...shared, 'The drill seals the books and the registers, rebuilds them into a fresh world and compares record by record.'],
  };
}

/* ------------------------------------------------------------------ the desk: the switch and its trail */

export interface GuidePreferenceChange { readonly at: string; readonly by: string; readonly enabled: boolean; readonly note: string }

export interface GuideSnapshot {
  readonly enabled: boolean;
  readonly setBy: string;
  readonly setAt: string;
  readonly tabs: ReadonlyArray<{ id: string; label: string; note: GuideNote }>;
  /** Curated section notes, keyed `<tab>:<section>`. */
  readonly sections: Readonly<Record<string, GuideNote>>;
  /** Live facts per tab, folded into every note on that screen. */
  readonly facts: Readonly<Record<string, string[]>>;
  readonly counts: { tabs: number; sections: number; curated: number };
  readonly audit: readonly GuidePreferenceChange[];
  readonly limitation: string;
}

export const GUIDE_LIMITATION = 'The notes are written by the people who built the screens and refreshed with the engine\u2019s own figures; they are guidance, not advice, and they never override a rule the engine enforces.';

export class GuideDesk {
  private enabled: boolean;
  private by: string;
  private at: string;
  private readonly audit: GuidePreferenceChange[] = [];

  constructor(input: { enabled?: boolean; by?: string; at?: string } = {}) {
    // On by default: an operator who has not asked for guidance is exactly the one who needs it, and
    // turning it off is one switch at the top of the console.
    this.enabled = input.enabled ?? true;
    this.by = input.by?.trim() || 'console-default';
    this.at = input.at?.trim() || '2026-10-05T12:00:00Z';
  }

  isEnabled(): boolean { return this.enabled; }

  setPreference(input: { enabled: boolean; by?: string; at?: string }): GuidePreferenceChange {
    const change: GuidePreferenceChange = {
      at: input.at?.trim() || new Date().toISOString(),
      by: input.by?.trim() || 'console-operator',
      enabled: input.enabled,
      note: input.enabled
        ? 'Section guidance switched on: every screen and section carries its sticky note.'
        : 'Section guidance switched off: the screens keep their rules, only the notes are hidden.',
    };
    this.enabled = change.enabled;
    this.by = change.by;
    this.at = change.at;
    this.audit.push(change);
    return change;
  }

  snapshot(w: World): GuideSnapshot {
    const facts = worldFacts(w);
    const tabs = CONSOLE_TABS.map((t) => ({ id: t.id, label: t.label, note: tabGuide(t.id, facts[t.id] ?? []) }));
    const sections: Record<string, GuideNote> = {};
    for (const key of Object.keys(SECTION_GUIDES)) {
      const tab = key.slice(0, key.indexOf(':'));
      const section = key.slice(key.indexOf(':') + 1);
      sections[key] = sectionGuide({ tab, section, title: sectionTitle(key), facts: facts[tab] ?? [] });
    }
    return {
      enabled: this.enabled,
      setBy: this.by,
      setAt: this.at,
      tabs,
      sections,
      facts,
      counts: { tabs: tabs.length, sections: Object.keys(sections).length, curated: Object.keys(SECTION_GUIDES).length },
      audit: this.audit.slice(-8).map((c) => ({ ...c })),
      limitation: GUIDE_LIMITATION,
    };
  }
}

/** A readable title for a curated key: the section id or card slug, as words. */
function sectionTitle(key: string): string {
  const part = key.slice(key.indexOf(':') + 1);
  const words = part.split('-').filter(Boolean).join(' ');
  return words.charAt(0).toUpperCase() + words.slice(1);
}
