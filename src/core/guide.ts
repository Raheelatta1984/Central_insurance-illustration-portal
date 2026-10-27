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
  'access-doa': {
    headline: 'Role-driven RBAC, four authority tiers, AI advisor and live DOA routing',
    body: 'Every operator enters through the role security layer — from Administration (complete unrestricted access) through technical desks (Underwriting, Retention, Endorsement, Claims, Settlement, Reinsurance, Finance, Cost Control, Fund Config & Investment) to Agency, Marsh Broker, Bancassurance, Branch, Aggregator, Direct Customer and Referral Partners. These are roles, not user accounts: a future login layer will provision named users against them. AI recommends optimal Tabs, Sections and Sub-Sections with Segregation-of-Duties checks, while Entity × Channel × Sub-Channel mappings route out-of-limit actions to the right supervisor with instant approver notifications.',
    doThis: ['Switch between roles or launch the Pre-Load Role Gate to experience each role\u2019s tailored workspace and landing screen.', 'Run the AI Access & SoD Advisor on any role to inspect confidence scores, toxic-combination checks and one-click apply.', 'Test a DOA request above an officer\u2019s cap and watch the notification land in the mapped Supervisor / Manager inbox for approval or escalation.'],
    watch: 'Administration holds permanent complete access and cannot lock itself out; no requester may self-approve their own DOA request. Only supervisor- or manager-tier roles may change a DOA limit — an officer can only raise a limit-increase request.',
  },
  'role-matrix': {
    headline: 'Enable or disable any tab, section or sub-section — per role',
    body: 'This is the role-driven tree the console enforces: select a role, then switch each Tab, Section and Sub-Section between Full (visible and editable), Read-only (visible, not editable) and Hidden (not rendered in that role\u2019s navigation). Children inherit from their parent until you override them, and changing a parent re-seats the whole branch so a hidden section can never leak a visible sub-section. These are roles — the policy office, the underwriter, the branch officer — not user logins. Named user accounts, credentials and login will reference a role id when the user-profile layer lands.',
    doThis: ['Pick a role on the left and read its Officer / Supervisor / Manager tier: tier decides who may change access and DOA limits, not what the role sells or underwrites.', 'Toggle a tab to Hidden and watch its sections and sub-sections inherit the change; then grant one sub-section Read and see it appear as the only explicit exception.', 'Open the DOA limits section: supervisors and managers edit caps for lower-tier roles; officer-tier roles see a limit-increase request form instead of an editor.'],
    watch: 'Officer-tier roles cannot change section visibility or DOA limits at all, and nobody can grant more access than they hold themselves. Approval of an officer\u2019s limit-increase request is what moves the cap; the requester never moves it directly.',
  },
  journey: {
    headline: 'The sale on rails: nineteen sections, one open — with zero duplicate entry',
    body: 'This is the front door of the ERP. Every section starts closed; the one the engine recommends opens itself, and the next one opens only when this one is 100% complete on its mandatory fields and its domain gates. Previously provided customer data — DOB, actuarial age (Nearest / Next / Last), height, weight, smoker status, income and dependent riders/products — auto-picks automatically across sections.',
    doThis: ['Pick an existing customer or enter DOB once and watch age, build, contact and dependent riders auto-populate downstream.', 'Work the open section, then submit it and watch the next one open itself.', 'Reopen a completed section and clear a mandatory field: the refusal names the field.'],
    watch: 'Conditional, legal and regulatory requirements stay hard gates. Master settings can relax an ordinary required flag; they cannot relax a rule the pack insists on.',
  },
  master: {
    headline: 'Change what the whole system means, without a release',
    body: 'Master settings is where the tenant is configured: country, calendar, time zone and currencies, actuarial age auto-calculation (Age Nearest / Age Next / Age Last) with per-product overrides, dependent product & rider auto-pick rules, smart editable combo-box suggestions, the product shelf grid, rating tables, omni-channel and partner commissions, multi-country providers, unit-linked charges, takaful window, claims authority matrix, FX rate card and regulated vocabulary.',
    doThis: ['Set country, region, time zone, currencies and actuarial age calculation basis (ANB / ANxB / ALB) first: every quote and customer auto-pick reads them.', 'Define or re-file a product in the factory grid with smart combo-box names/descriptions and configure its auto-picked dependent riders.', 'If the omni-channel is not set up, the button files the six standard routes; then the partners, their shelves, commission and clawback are yours to file.', 'Rename a journey field or a vocabulary label and watch the change reach the screens that render it.'],
    watch: 'These settings are filed data with an audit trail, not preferences: a change here re-prices new business and re-words documents, so it is recorded with the actor and the time.',
  },
  'distribution-channels': {
    headline: 'One channel-wide commercial shelf, filed as data',
    body: 'This is the channel layer of distribution configuration. It assigns a product type, a product and its sub-products to one omni-channel, then files the commission schedule, premium uplift percentage, commission-disbursement terms and clawback rule that apply before any partner narrows them. Percentages are stored as integer basis points, so a quote and a commission statement agree.',
    doThis: ['Choose the channel, product type, product and sub-products, then read the channel commission ceiling before filing a schedule.', 'Enter commission and premium uplift as percentages, state when commission is disbursed and file the clawback recovery schedule.', 'Check the existing rows and edit or remove the row that owns this channel × product key.'],
    watch: 'A channel is the broadest distribution scope. A partner or sub-channel partner row filed for the same product is more specific and wins at read time; a commission above the channel ceiling is refused.',
  },
  'distribution-partners': {
    headline: 'Partner contract terms without another spreadsheet',
    body: 'The partner layer narrows a channel-wide shelf to one named partner. Products and sub-products, commission percentages, premium uplift, holdback, settlement frequency, payout trigger and clawback recovery are filed on one auditable row. The channel ceiling and the partner’s parent channel are checked before the row is accepted.',
    doThis: ['Select the parent channel and a partner filed on that channel, then assign the product type, product and sub-products.', 'File the commission schedule, premium uplift percentage, disbursement terms and clawback rule for the partner.', 'Compare the filed rows with the channel layer: a partner row overrides a channel row, but a sub-channel partner row overrides both.'],
    watch: 'A partner cannot be configured against a different parent channel, and a commission schedule above the channel or sub-channel ceiling is refused rather than clipped.',
  },
  'distribution-subchannels': {
    headline: 'The narrowest shelf: sub-channel × partner',
    body: 'Sub-channel partner configuration is the most specific layer. It is for a named partner desk, branch, feed or journey inside one channel, with its own product assignment, commission schedule, premium uplift, disbursement terms and clawback rule. Pricing, commission and clawback probes resolve this layer before partner or channel terms.',
    doThis: ['Pick the parent channel, partner and sub-channel; the sub-channel must belong to that channel and, where linked, to that partner.', 'Assign the product type, product and sub-products, then file the commercial and clawback terms.', 'Use the filed-rows table to verify inheritance: sub-channel partner beats partner, partner beats channel.'],
    watch: 'Scope is checked against the live channel, partner, sub-channel and product masters. A stale or mismatched scope is refused with the reason, never saved as an orphan.',
  },
  email: {
    headline: 'Each letter from the desk that owns it',
    body: 'Several sending accounts, each with its own address, display name, department, transport kind and the names of the environment settings that hold its credentials — and one route per business event saying which account sends it, to whom, with what subject, words and documents. Policy issuance leaves from the issuance desk, the information pack from information, the renewal request from retention, alterations from alterations, claims from claims and reinsurance from reinsurance.',
    doThis: ['Read the accounts first: an address belongs to one account, and a department may hold more than one mailbox.', 'Open an event route and check the sending account, recipients, subject and body against the wording the regulator expects for that letter.', 'Preview an event with a real context, then send a test through the attached transport and read the delivery answer.'],
    watch: 'Credentials are referenced by setting name and never stored here. A configured route is not a delivery: the transport still answers sent, failed or not-sent, and the answer is recorded against the document.',
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
  'funds-accounting': {
    headline: 'Make the accounting treatment explicit before money posts',
    body: 'A separate configuration surface for country standards, fund valuation and revenue treatment, plus dynamically resolved debit/credit mappings. Each event creates a balanced voucher with its policy context and a real ledger journal link.',
    doThis: ['Review country standard, functional currency and fiscal year end.', 'File a rule per country × line × fund and mappings by event, product, sub-product, partner, omni-channel, sub-channel and policy.', 'Post a premium, allocation, gain/loss or withdrawal event and inspect both the voucher and its journal.'],
    watch: 'Accounting standards are configurable reference settings, not a substitute for local finance or regulatory approval. A voucher with no valid FX rate or account is refused rather than forced through.',
  },
  'super-funds': {
    headline: 'Administer member investment policies and their monthly economics',
    body: 'Super accumulation, pension and transition-to-retirement products carry member balances, contributions, monthly admin/investment charges and pro-rata income or loss allocation via premium post-adjustment.',
    doThis: ['Review the super product currency, approved funds and monthly fee schedule.', 'Create a member policy or contribution, then run charges once for the month.', 'Allocate the period gain or loss and follow its funds-accounting voucher by member policy.'],
    watch: 'Runs are separated by currency and cannot be repeated for a policy in the same month; a short balance is never charged below zero.',
  },
  warehouse: {
    headline: 'One exportable read model for analysts, engineers and BI tools',
    body: 'Materialised policy, premium, NAV, claims, treaty, commission-schedule, super, voucher-line and member-balance datasets show their grain, source, sample rows and lineage. CSV and JSON exports contain the full dataset.',
    doThis: ['Pick a dataset and inspect the sample and source lineage.', 'Download a complete CSV or JSON export and record its row count and content fingerprint.', 'Review the connector recipes for Power BI, Tableau, Qlik, Databricks and Data Fabric.'],
    watch: 'External connectors are recipes, not authenticated sessions in this demo; production requires deployment credentials, identity, network and residency configuration.',
  },
  batch: {
    headline: 'Run the whole book on a schedule, with the accounting filed first',
    body: 'Quotation generation, illustration generation, policy issuance and every monthly-anniversary event — mortality, premium accrual, commission accrual and clawback, fund management charges and dividend distribution — are batch jobs here. Each event is set up once with its debit/credit accounts, schedule, basis and applicable statuses; a run then processes quotations and policies one by one and reports posted, skipped, duplicate and failed items with voucher references.',
    doThis: ['Review the event setup table with Finance before the first live run: no setup, no run.', 'Pick an event and a period (YYYY-MM for anniversaries, YYYY-MM-DD for generation jobs) and run it.', 'Read the run lines: terminal subjects must show skipped-terminal, and re-running the same period must show duplicate-skipped, never a second charge.'],
    watch: 'A policy leaves every batch the moment it lapses, is fully withdrawn or is surrendered. Clawback is the deliberate exception: it targets leavers to recover commission. Money-moving batches are high-risk under the AGENTS.md gate and need a named human approver outside this demo.',
  },
  theme: {
    headline: 'Brand the application, the partner and the channel — from one tab',
    body: 'The Application theme tab is the top-level home for the theme onboarding that used to be buried in Master settings. The entity layer applies globally; partner and omni-channel layers are scoped to partner detail, the customer journey and quotation generation. Upload a logo, header or footer, let the local palette assistant sample dominant colours, review the swatches, then generate and preview.',
    doThis: ['File the entity theme first: it is the base every tab renders on.', 'Add partner and channel layers for the surfaces their customers actually see.', 'Disable a layer to fall back instantly — nothing is deleted and the change is audited.'],
    watch: 'Partner and channel themes never leak outside their three scoped surfaces; if a scoped screen looks unbranded, check the layer is enabled and the owner id matches the partner or channel code.',
  },
  'whats-new': {
    headline: 'Every change, explained for operators — newest first',
    body: "What's New is the filed record of what shipped: each entry names its source (commit, PR or change request) and says why it exists, what changed, and what you need to do, in that order. Entries are filed by hand or generated from commit subjects and bodies in the same shape, so the tab stays readable long after the git log is forgotten.",
    doThis: ['Read the newest entries after every release, starting with anything marked security or breaking.', 'Follow the What-you-need-to-do line — that is the only action list that matters.', 'When you ship a change, write the commit body as why-then-what so an entry can be generated from it.'],
    watch: 'An entry is a record, not a promise: if an entry describes a tab you cannot see, say so — that is how the missing Application theme tab was found.',
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
  reconciliation: {
    headline: 'Unlocked non-financial partner reconciliation foundation',
    body: 'Scoped ownership metadata, insurer-owned configurable channel and sub-channel types, identity-only column mapping proposals requiring explicit human confirmation, deterministic policy matching (exact normalized keys and insured-corroborated zero-padding variants), duplicate quarantine, and human review of tentative fuzzy proposals. Financial commission, free-look, clawback, payable statement and AP payment rules remain locked until signed off.',
    doThis: ['Inspect the insurer channel/sub-channel catalogue and partner ownership hierarchy, or add a new insurer-owned channel/sub-channel type.', 'Propose identity columns from a partner CSV header row, verify non-identity/financial columns are ignored, and confirm the mapping explicitly.', 'Run a scoped partner-versus-insurer identity match and review quarantined duplicates and tentative proposals.'],
    watch: 'No premium, commission rate, clawback, tax, FX, payable statement or settlement entry is calculated on this foundation surface.',
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
  'master:products': { headline: 'The product factory: the whole shelf, editable as a table', body: 'Every variety this tenant may sell is on file with the numbers the engines read: entry ages, the base rate per 1,000, the income multiple, the automatic binding limit, the facultative threshold, the AI straight-through limit, the omni-channel name and the evidence bands. The shelf is a grid now: a cell is the field, **Copy line** starts a new variety as an exact twin of the row beside it, and saving files the batch in one audited bulk call \u2014 or you take the sample sheet away, fill in ninety rows and upload it back.', doThis: ['Filter by line or search an id, then edit the cell: the row in focus is the row the checklist above reads, so the two cannot disagree.', 'Copy a line, change the one thing that differs, save it \u2014 or use the server-side copy to bring the whole rating grid with the twin.', 'Read the refusal written into a red row: the good rows in the batch file anyway, and the reason names the cell.'], watch: 'A row is a draft until it is saved, and an unsaved draft survives a reload. A minimum entry age at or above the maximum, a facultative threshold below the binding limit, or an AI limit above it is refused, and a product with no underwriting rules cannot be quoted \u2014 the factory registers both together.' },
  'master:product-rating': { headline: 'The tariff: age band, gender, occupational rank and sum assured', body: 'A product\u2019s base rate is one number; a life is not one number. This is where the price is filed by band \u2014 premium per 1,000 of sum assured each year, and, for a unit-linked or takaful plan, the cost of insurance per 1,000 each policy month. Rows are matched on product, kind, gender, both ages, rank, sum band and scope, so uploading a band updates it instead of leaving two prices beside each other.', doThis: ['Pick the product and filter to mortality if you are reviewing the cost of insurance.', 'Copy a band, widen the ages or change the rate, and save the row \u2014 or download the sample sheet, fill it in and upload ninety rows at once.', 'Read the holes and the overlaps before you sign the tariff off: a life in an uncovered band cannot be quoted, only referred.'], watch: 'Rates are decimal money per 1,000, never a percentage: the engine divides by the currency\u2019s scale and rounds once, so 2.75 and 2.7500 are the same tariff and 2,75 is not.' },
  'master:omni-channel': { headline: 'Every route the plan is sold through, and what each partner is paid', body: 'Channels first, then the partners on them, then the terms each partner holds for each product: which plans are on its shelf, what the plan is called there, whether its rates differ from the filed tariff, and the commission and clawback schedules behind the sale. None of it exists until it is set up, and an unset-up omni-channel is why a distribution manager ends up with prices in a spreadsheet.', doThis: ['If the six standard channels are not filed yet, press the button \u2014 it creates the routes and nothing else.', 'File a partner against one channel, then put products on its shelf; the terms grid follows the shelf.', 'Keep commission schedules inside the ceiling on the channel, and say which period a clawback counts in.'], watch: 'A partner cannot be paid more than its channel\u2019s ceiling, a channel with partners on it cannot be deleted, and the clawback here is the master record only \u2014 the money a period actually owes is settled by the ERP\u2019s commission ledger, which this screen cannot reach.' },
  'email:accounts': { headline: 'The mailboxes, and the settings their credentials live in', body: 'Each account has one address, a display name, a reply-to, a department, a transport kind and a daily limit. Credential settings are named — GOOGLE_CLIENT_SECRET, SMTP_PASSWORD — and their values stay in the environment. Several accounts may share a department; one address may belong to only one account.', doThis: ['File the sending address and the department that owns it.', 'Name the environment settings the transport needs; never type a secret into this screen.', 'Disable an account rather than deleting it if events still point at it, or reassign those events first.'], watch: 'Removing an account that events still use is refused. A disabled account shows as a blocker on each of its events, which is deliberate: silence is how a customer letter goes missing.' },
  'email:event-routes': { headline: 'One business event, one sender, one set of words', body: 'Every event — quotation, policy issuance, information pack, renewal request, alteration, receipt, claim acknowledgement, claim settlement, reinsurance placement, welcome pack, lapse, surrender, complaint and fund statement — carries its own sending account, recipients, copy, subject, body, attachments and a service level. Templates use a closed list of placeholders, so a typo is refused at filing rather than printed as a blank.', doThis: ['Pick the account that owns the event, then check the recipient and copy lists.', 'Write the subject and body with the placeholders from the list; a queue:<department> recipient resolves to that department\u2019s enabled mailbox.', 'Set a service-level in hours where the letter promises an answer, and preview the rendered result before saving is trusted.'], watch: 'An unknown or unclosed placeholder is a refusal. The route can be disabled without deleting it, and a blocked route is shown as blocked on the event.' },
  'email:preview': { headline: 'See the envelope and the letter before a customer does', body: 'A preview resolves the event against a context — customer, policy, quotation, claim, renewal, amount — and shows the from address, the recipients, the subject, the body and the attachments. Nothing is sent. A missing placeholder is shown as an em dash and named in the warnings rather than silently disappearing.', doThis: ['Fill the context with the identifiers the event needs.', 'Read the from address and the recipients: they are the answer to \u201cwho wrote to me?\u201d.', 'Send a test only after the preview is ready; the transport\u2019s answer is the delivery record.'], watch: 'A preview is not a delivery and does not move the document. A route that resolves with no deliverable recipient is blocked.' },
  'master:providers': { headline: 'Who carries the risk, where they are licensed, and who reinsures them', body: 'An insurance provider is filed with its home country, home regulator, home licence and which books it may write. In every country it sells in, it needs a branch registered against that country\u2019s requirements, the country\u2019s own currency, local premium management and an investment held where the quotation was generated — and a separate reinsurance arrangement for that country, with retakaful where the business is Takaful. The home licence is not a licence to write abroad.', doThis: ['File the provider, then register its branch in each selling country with the registration number and regulator that country gave it.', 'File the country reinsurance arrangement: reinsurer, kind, basis, cession, retention, limit and the regulatory reference.', 'Attach the products the provider underwrites in each country, in that country\u2019s currency. Press the worked-example button to see the Marsh pattern in one go.'], watch: 'A branch that is applied for, suspended or withdrawn stops the sale. A product master in another currency is refused rather than relabelled, and a Takaful product needs retakaful, not the group\u2019s conventional treaty.' },
  'master:provider-selling': { headline: 'Conventional and Takaful are two checkboxes, narrowed down the route', body: 'The channel, the sub-channel and the partner each carry a Conventional and a Takaful checkbox. The effective permission is the intersection: a broker that sells both cannot widen an agency desk that has been narrowed to Conventional only. The same screen files the channel\u2019s presence in each country — its local licence, operating name, currency and appointed providers — and probes a sale before anyone quotes it.', doThis: ['Tick the boxes at the scope that actually decides: the channel for the whole route, the sub-channel for a desk, the partner for one entity.', 'File the country presence with the country\u2019s currency and the appointed providers.', 'Run the sellability probe with provider, country, channel, sub-channel and partner: every refusal names the missing filing, not just \u201cnot allowed\u201d.'], watch: 'A sale is priced in the country\u2019s currency, premium is managed by the local branch and the investment stays in the country where the quotation was generated. The provider\u2019s home country is recorded for capital reporting, not as the place the customer\u2019s money sits.' },
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
  'master:age-autopick': {
    headline: 'Actuarial age rules (Nearest / Next / Last), dependent products and smart combo suggestions',
    body: 'Choose how every date of birth becomes an insurance age across the tenant — Age Nearest Birthday (ANB), Age Next Birthday (ANxB) or Age Last Birthday (ALB) — file per-product overrides, and configure which dependent riders and linked cover products auto-pick when a base plan is selected.',
    doThis: ['Pick the tenant default age calculation basis (ANB, ANxB or ALB) and test any date of birth in the live side-by-side probe.', 'File per-product overrides where a line of business prices on a different birthday basis.', 'Configure auto-picked dependent riders and companion products so advisors never re-key them across screens.'],
    watch: 'Changing the age basis changes the rated age on new quotations from that moment forward; issued policies retain the age filed at underwriting.',
  },
  'access-doa:profile-directory': {
    headline: 'Security roles across governance, configuration, coordination and channel families',
    body: 'Every role — Administration (complete unrestricted access), Supervisor, Configuration Analyst, the three distribution coordinator templates, Underwriting, Retention, Endorsement, Claims, Settlement, Reinsurance, Bancassurance Ops, Fund Config, Accountant, Finance, Cost Controller, Fund Investment, Agents 1/2/Marsh/Supervisor, Banca 1/2/Supervisor, Branch Officer/Manager, Bank Manager, Aggregator, Direct Customer and Referral Partners 1/2 — has its own least-privilege workspace and DOA cap.',
    doThis: ['Filter by family or search any role, inspect its allowed tabs and DOA threshold, and click Switch Profile to enter that workspace immediately.', 'Clone a coordinator template to create a per-channel, per-partner or per-sub-channel variant with explicit scopes, without touching Administration.', 'Click Launch Pre-Load Profile Selector in the header whenever you want to return to the pre-load gate screen.'],
    watch: 'Administration holds permanent complete access to every tab, section, sub-section and approval gate so the platform can never lock itself out.',
  },
  'access-doa:ai-advisor': {
    headline: 'AI-recommended tabs, sections, sub-sections and Segregation-of-Duties checks',
    body: 'Select any profile or type a free-text role description to run the deterministic AI Access Advisor. It scores every tab, section and sub-section, recommends a decimal DOA cap and supervisor chain, flags toxic Segregation-of-Duties combinations, and logs every run on the AI ledger.',
    doThis: ['Select a profile or enter a custom role description and click Run AI Access Advisor.', 'Review confidence scores and any Segregation-of-Duties warnings (such as Claim Approval + Cash Settlement Release on one role).', 'Click Apply AI Recommendation to update the profile and record the change on both audit logs.'],
    watch: 'AI recommendations advise and apply only to non-admin roles; money-moving authority above DOA still requires human supervisor approval.',
  },
  'access-doa:matrix-editor': {
    headline: 'Three-tier permission control: Tab → Section → Sub-Section',
    body: 'Grant Full Read/Write, Read-Only or Hidden access at tab, section and sub-section granularity. Frontline channels stay clean and focused while technical and finance desks see only the exact sections their mandate requires.',
    doThis: ['Pick a profile and toggle Full, Read or None on any tab, section or sub-section.', 'Save changes and switch into that profile to verify the sidebar and section badges live.', 'Keep claim adjudication separate from settlement release on non-admin roles.'],
    watch: 'Lowering a tab permission automatically updates its sections unless explicitly overridden.',
  },
  'access-doa:supervision-map': {
    headline: 'Route approvals dynamically by Entity × Channel × Sub-Channel',
    body: 'Map every combination of Legal Entity (ALK-CONV, ALK-TKF, ALK-MY), Distribution Channel (AGENCY, BROKER-MARSH, BANCA, AGGREGATOR, DIRECT, REFERRAL, HEAD-OFFICE) and Sub-Channel (AGENCY-DESK-1, MARSH-AGENCY, BANCA-PREMIER-1, BRANCH-RETAIL-01, technical desks) to its first-line Supervisor and second-line Manager with explicit DOA caps.',
    doThis: ['Inspect how Marsh broker cases route to Agent Supervisor → Underwriter Manager while retail branch cases route to Branch Manager → Bank Manager.', 'Add or update a mapping row for a specific Entity, Channel and Sub-Channel.', 'Verify the routing immediately in the DOA Simulator below.'],
    watch: 'Specific Entity + Channel + Sub-Channel matches take priority over wildcard (*) rules.',
  },
  'role-matrix:role-directory': {
    headline: 'Roles, not user accounts — and the tier that governs them',
    body: 'Every row here is a role template (policy office, underwriter, branch officer, fund investment manager) with an authority tier. Officer roles do the operational work; supervisor roles approve first line; manager roles approve second line; Administration is the executive owner. Named user profiles and login credentials will be created later and will point at one of these role ids.',
    doThis: ['Filter by family or search to find the role you want to inspect.', 'Read the tier and DOA cap before changing anything: a higher-tier role cannot be edited by a lower one.', 'Switch the session into a role to see exactly which navigation items and sections it receives.'],
    watch: 'A role is a permission template, never a person: switching role changes what the console shows, but it does not create an account, password or identity.',
  },
  'role-matrix:access-tree': {
    headline: 'The Tab → Section → Sub-Section switchboard',
    body: 'Each tab is a branch; its sections are nodes under it and each section has its own sub-sections. Full means visible and editable, Read means visible but locked, Hidden means the node is not shown at all. A node without an explicit override shows "inherit" and follows its parent. Changing a tab clears child overrides so the whole branch moves together; granting a child afterwards creates one deliberate exception.',
    doThis: ['Choose the role first; the tree always edits that role, never the signed-in role by accident.', 'Use "Hidden" on a tab to remove it from the role\u2019s navigation entirely, then open a section and grant Read to keep one reporting view visible.', 'Watch the effective-level badge next to each node: it is what the engine will actually enforce, including inherited levels.'],
    watch: 'Hiding a node is not the same as refusing an API call; the API still applies the same role checks, and an officer cannot edit this tree at all.',
  },
  'role-matrix:doa-limits': {
    headline: 'DOA caps move at supervisor or manager level — officers request',
    body: 'A DOA cap is a decimal money limit with a currency. Supervisor- and manager-tier roles may change caps for lower-tier roles, but never above their own cap; Administration may set any finite cap and holds unlimited authority itself. An officer-tier role cannot edit a cap or this tree — it raises a tracked limit-increase request, routed through the Entity × Channel × Sub-Channel supervisor chain, and the approving supervisor/manager is what applies the new cap.',
    doThis: ['As a supervisor or manager, pick a lower-tier role, enter the new cap and save; read the refusal if it exceeds your own authority.', 'As an officer, use the request form: state the requested cap and the operational reason, then follow the tracked request in the approver inbox.', 'Approve a pending limit-increase request as the assigned supervisor and verify the role\u2019s cap, audit trail and requester notification all change together.'],
    watch: 'Self-approval is refused, an approver above their own cap auto-escalates, and an officer can never grant itself a higher limit by calling the API directly.',
  },
  'role-matrix:role-audit': {
    headline: 'Every access and DOA change leaves a name and a time',
    body: 'Role creation, tab/section/sub-section overrides, DOA action grants, cap changes and approved limit-increase requests are filed on an append-only security audit trail with the acting role, the target role and the exact change.',
    doThis: ['Filter the trail for a role before and after an edit to see the before/after state.', 'Cross-check a DOA limit-increase request against the approval history and the audit event that applied the new cap.', 'Export the trail with the tenant\u2019s audit evidence when a regulator asks who changed access.'],
    watch: 'The trail records authority, not just intent: an officer\u2019s refused attempt to change a cap is itself evidence that the control held.',
  },
  'access-doa:doa-queue': {
    headline: 'Delegation of Authority (DOA) approvals and real-time approver notifications',
    body: 'When any officer, advisor, branch desk or partner submits an action above their DOA limit, the engine creates a tracked DOA request and sends an instant notification to the mapped Supervisor/Manager (plus Administration visibility). Approvers can approve within their cap, escalate upward, or reject with reasons — notifying the requester immediately.',
    doThis: ['Simulate or raise a DOA request above an officer\u2019s cap and watch the Approver Notification count increment immediately.', 'Approve, Escalate or Reject within Administration or via the approver\u2019s workflow.', 'Check that an approver whose own DOA is exceeded automatically escalates to the next tier rather than breaching authority.'],
    watch: 'Access & DOA and Role access matrix tabs are restricted strictly to Administration; no non-admin profile can open either tab or approve its own DOA request.',
  },
  'reconciliation:scope-hierarchy': {
    headline: 'Insurer-owned channel types and immutable partner ownership scope',
    body: 'Every reconciliation run executes inside one insurer, one root channel partner, an optional sub-partner under that root, and one insurance class. Insurers add new channel and sub-channel codes as reference data without altering database enums.',
    doThis: ['Review the configured conventional and takaful channel/sub-channel codes and partner hierarchy.', 'Add a new channel or sub-channel type for an insurer and check the audit trail.'],
    watch: 'Cross-partner and cross-insurer sub-partner scopes are refused before matching starts.',
  },
  'reconciliation:column-mapping': {
    headline: 'Identity-only column suggestions, confirmed by a human',
    body: 'Source file headers are matched deterministically against four non-financial identity fields only: policyNumber, insuredName, insurer and insuranceClass. Colliding headers are flagged ambiguous, financial columns (premium, commission, rate, payable) are ignored, and every mapping stays unconfirmed until an operator confirms it.',
    doThis: ['Paste comma-separated partner file headers and click Propose identity columns.', 'Verify financial columns are listed as ignored non-identity headers, then confirm the mapping.'],
    watch: 'No header suggestion is ever auto-confirmed without a human confirmation step.',
  },
  'reconciliation:identity-matching': {
    headline: 'Deterministic policy matching and duplicate quarantine',
    body: 'Within a single validated scope, unique normalized policy numbers match deterministically, unique numeric zero-padding differences match only when normalized insured names corroborate, and duplicate normalized policy keys or uncorroborated variants are quarantined rather than silently paired.',
    doThis: ['Select insurer, root partner, optional sub-partner and insurance class.', 'Run identity matching on partner and insurer rows and inspect exact matches, safe variants and quarantined findings.'],
    watch: 'Duplicate policy keys are quarantined on both sides so neither row can auto-match by order of arrival.',
  },
  'reconciliation:proposal-review': {
    headline: 'Tentative proposals require explicit human confirmation or rejection',
    body: 'Remaining unmatched rows are compared within a bounded budget to produce tentative identity proposals. Proposals never count as reconciled matches until a human confirms or rejects them with an audit note.',
    doThis: ['Inspect pending tentative proposals and their similarity scores.', 'Confirm or reject a proposal with a written audit reason and review the append-only reconciliation audit log.'],
    watch: 'Confirming an identity proposal links policy identity only; financial commission calculations remain disabled.',
  },
  'distribution-channels:scope-directory': { headline: 'Choose the channel before the terms', body: 'The channel is the broadest scope. A coordinator can clone this role and set one channelScope, then file terms that apply to every partner on that route.', doThis: ['Select one filed channel.', 'Read its commission ceiling before entering a schedule.'], watch: 'A narrower partner or sub-channel partner row overrides this one.' },
  'distribution-channels:product-assignment': { headline: 'Assign a type, a product and its sub-products', body: 'Product type is the line from the product factory, product is the priced master, and sub-products are varieties in that line. References are checked at the API boundary.', doThis: ['Pick a product type.', 'Pick a product and at least one sub-product.'], watch: 'A row naming a product from another line is refused.' },
  'distribution-channels:commercial-terms': { headline: 'File percentages and payment terms together', body: 'Commission and premium uplift are percentages stored as basis points; disbursement frequency, payout trigger, settlement days and holdback describe when commission is actually paid.', doThis: ['Enter the commission schedule and premium uplift percentages.', 'State the disbursement trigger, frequency, settlement days and holdback.'], watch: 'Commission above the channel ceiling is refused rather than capped silently.' },
  'distribution-channels:clawback-rules': { headline: 'Write the recovery schedule on the record', body: 'The clawback rule names the trigger, policy-year or policy-month basis, and a declining recovery schedule for commission that must come back when cover does not persist.', doThis: ['Choose the trigger and basis.', 'File the recovery percentages for each period.'], watch: 'The last recovery percentage repeats for later periods.' },
  'distribution-partners:scope-directory': { headline: 'A partner belongs to one parent channel', body: 'Partner configuration is always checked against the partner’s filed channel. Clone the partner coordinator role and set partnerScope for a named partner desk.', doThis: ['Select the parent channel.', 'Select a partner filed on that channel.'], watch: 'A partner from another channel is refused.' },
  'distribution-partners:product-assignment': { headline: 'Narrow the shelf to what the contract allows', body: 'A partner row files the product type, product and sub-products that partner may sell, independently of the channel-wide shelf.', doThis: ['Pick the product type and product.', 'Select the licensed sub-products.'], watch: 'A sub-channel partner row is still more specific.' },
  'distribution-partners:commercial-terms': { headline: 'Partner commission, uplift and disbursement', body: 'These terms override channel terms for the same product, with the channel ceiling still enforced. The audit trail records who filed the row and when.', doThis: ['File commission and premium uplift percentages.', 'State disbursement frequency, trigger, settlement days and holdback.'], watch: 'Percentages are basis points on the record, never floating-point multipliers.' },
  'distribution-partners:clawback-rules': { headline: 'Clawback belongs beside the commission', body: 'The partner clawback rule travels with its commission terms, so a commission probe and a clawback probe resolve the same filed row.', doThis: ['Choose the trigger and basis.', 'Enter the recovery schedule.'], watch: 'No recovery schedule means no clawback configuration was filed.' },
  'distribution-subchannels:scope-directory': { headline: 'The narrowest distribution scope', body: 'A sub-channel partner row is keyed by channel, partner and sub-channel. Clone the sub-channel coordinator role and set subChannelScope and partnerScope for each desk.', doThis: ['Select channel, partner and sub-channel in that order.', 'Check the sub-channel’s parent and optional partner linkage.'], watch: 'A mismatched hierarchy is refused before the row is saved.' },
  'distribution-subchannels:product-assignment': { headline: 'Sub-products at the desk level', body: 'The most specific row can narrow the product shelf to the varieties a desk, branch, feed or embedded journey actually sells.', doThis: ['Pick the product type and product.', 'Select only the sub-products this desk sells.'], watch: 'A product variety outside the selected line is refused.' },
  'distribution-subchannels:commercial-terms': { headline: 'Sub-channel terms win last', body: 'Pricing, commission and clawback probes resolve this row before partner or channel terms when a sub-channel is supplied.', doThis: ['File commission and premium uplift percentages.', 'State the commission disbursement terms.'], watch: 'The sub-channel commission override, when filed, is the ceiling.' },
  'distribution-subchannels:clawback-rules': { headline: 'Clawback for the narrowest book', body: 'A desk-specific clawback schedule overrides a partner or channel clawback plan for policies attributed to this sub-channel partner.', doThis: ['Choose the trigger and basis.', 'File the recovery schedule percentages.'], watch: 'The same trigger and basis are used by commission and clawback probes.' },
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
  const accountingStats = w.fundsAccounting.stats();
  const superStats = w.superFunds.stats();
  const warehouseSnapshot = w.warehouse.snapshot(w);
  const distributionStats = w.distributionConfig.stats();
  const securitySnapshot = w.rbac.snapshot();

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
    'access-doa': [
      ...shared,
      `${w.rbac.listRoles().length} security roles configured across ${securitySnapshot.families.length} role families; active role: ${w.rbac.activeRole().name} (${w.rbac.activeRole().authorityLevel} tier, DOA cap ${securitySnapshot.roles.find((p) => p.id === w.rbac.activeRole().id)?.doaLimitLabel ?? 'Unlimited'}).`,
      `${w.rbac.snapshot().supervisionMappings.length} Entity × Channel × Sub-Channel supervision chains and ${w.rbac.snapshot().doaRequests.filter((r) => r.status === 'pending' || r.status === 'escalated').length} pending DOA approval(s) in queue.`,
    ],
    'role-matrix': [
      ...shared,
      `${w.rbac.listRoles().length} roles across 4 authority tiers (${w.rbac.snapshot().roles.filter((p) => p.authorityLevel === 'officer').length} officer, ${w.rbac.snapshot().roles.filter((p) => p.authorityLevel === 'supervisor').length} supervisor, ${w.rbac.snapshot().roles.filter((p) => p.authorityLevel === 'manager').length} manager, ${w.rbac.snapshot().roles.filter((p) => p.authorityLevel === 'executive').length} executive); active role: ${w.rbac.activeRole().name}.`,
      `${w.rbac.snapshot().catalogue.length} tabs in the visibility tree; roles are templates, not user logins — user accounts and credentials will reference a role id later.`,
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
    'distribution-channels': [
      ...shared,
      `${distributionStats.byScope['omni-channel']} channel-wide configuration row(s) on file, ${distributionStats.enabled} enabled across all three scopes.`,
      'Channel rows are the broadest commercial shelf: partner and sub-channel partner rows override them for the same product.',
    ],
    'distribution-partners': [
      ...shared,
      `${distributionStats.byScope.partner} partner configuration row(s) on file across ${new Set(products.map((p) => p.line)).size} product type(s).`,
      'A partner row is validated against its parent channel ceiling before it can price commission or premium uplift.',
    ],
    'distribution-subchannels': [
      ...shared,
      `${distributionStats.byScope['sub-channel-partner']} sub-channel partner configuration row(s) on file; ${distributionStats.products} distinct product(s) configured across distribution.`,
      'The narrowest enabled row wins for pricing, commission and clawback when a sub-channel is supplied.',
    ],
    email: [
      ...shared,
      `${w.emailConfig.stats().accounts} sending account(s), ${w.emailConfig.stats().enabledAccounts} enabled, across ${w.emailConfig.stats().departments} department(s).`,
      `${w.emailConfig.stats().events} business events configured; ${w.emailConfig.stats().enabledEvents} resolve to a ready route and ${w.emailConfig.stats().blockedEvents} are blocked.`,
    ],
    policyholder: [...shared, `${funds.length} funds, each with look-through into the instruments it holds and a price date per exposure.`],
    decisions: [...shared, 'Previews are priced by the same engine as live transactions: nothing on this screen has moved money.'],
    cover: [...shared, 'Micro-duration cover charges only between an explicit start and stop; auto-start is off unless it was elected.'],
    funds: [...shared, `${funds.length} funds published; ${funds.filter((f) => f.shariahScreened).length} of them Shariah-screened.`],
    'funds-accounting': [...shared, `${accountingStats.configs} country standards, ${accountingStats.rules} fund rules, ${accountingStats.mappings} mappings and ${accountingStats.vouchers} event vouchers on file; ${accountingStats.balanced ? 'all vouchers balance' : 'an unbalanced voucher needs review'}.`],
    'super-funds': [...shared, `${superStats.products} super products, ${superStats.active} active members, ${superStats.charges} monthly charge runs and ${superStats.allocations} income allocations.`],
    batch: [...shared, `${w.batch.stats().definitions} batch events set up (${w.batch.stats().enabled} enabled), ${w.batch.stats().runs} runs on file, ${w.batch.stats().postedLines} lines posted. Lapsed, fully-withdrawn and surrendered policies are skipped, never charged.`],
    theme: [...shared, `${w.themes.stats().total} theme layers on file (${w.themes.stats().entity} entity, ${w.themes.stats().partner} partner, ${w.themes.stats().omni} omni-channel), ${w.themes.stats().enabled} enabled. The entity layer is global; partner/channel layers cover partner detail, the journey and quotation.`],
    'whats-new': [...shared, `${w.whatsNew.stats().entries} filed entries, latest dated ${w.whatsNew.stats().latestAt ?? '—'}. Each says why, what changed and what you need to do.`],
    warehouse: [...shared, `${warehouseSnapshot.datasets.length} materialised datasets, ${warehouseSnapshot.dashboards.length} dashboard definitions, ${w.warehouse.stats().exports} exports. CSV/JSON exports are available; BI connector cards require deployment credentials.`],
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
    reconciliation: [
      ...shared,
      `${w.reconciliation.snapshot().partners.length} scoped partner/sub-partner node(s), ${w.reconciliation.snapshot().mappings.length} identity mapping(s) and ${w.reconciliation.snapshot().runs.length} non-financial identity run(s); financial calculations remain locked.`,
    ],
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
