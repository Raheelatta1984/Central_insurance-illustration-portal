/**
 * The 60-minute tour.
 *
 * Held as data, not as prose in a readme, so the console can run it as a live walkthrough and the
 * tests can prove it still covers every tab and still adds up to an hour. Each step says what to
 * do, what you will see, and why that is the thing worth seeing.
 */
export interface TourStep {
  readonly at: string;          // "00:00" — when the step starts
  readonly minutes: number;     // how long it should take
  readonly tab: string;         // console tab id
  readonly title: string;
  readonly why: string;
  readonly doThis: readonly string[];
  readonly expect: readonly string[];
  readonly api?: readonly string[];
}

/** The console's tabs, in order. The console renders this list; the tour refers to its ids. */
export const CONSOLE_TABS = [
  { id: 'tour', label: 'Tour', icon: '◷' },
  { id: 'overview', label: 'Overview', icon: '◈' },
  { id: 'policyholder', label: 'Policyholder', icon: '◉' },
  { id: 'decisions', label: 'Decision theatre', icon: '⇄' },
  { id: 'cover', label: 'Cover control', icon: '⏻' },
  { id: 'funds', label: 'Funds & NAV', icon: '≣' },
  { id: 'takaful', label: 'Takaful', icon: '☾' },
  { id: 'group', label: 'Group finance', icon: '⌂' },
  { id: 'underwriting', label: 'Underwriting', icon: '⚖' },
  { id: 'claims', label: 'Claims', icon: '✚' },
  { id: 'reinsurance', label: 'Reinsurance', icon: '⛨' },
  { id: 'onboarding', label: 'Onboarding', icon: '⛨' },
  { id: 'ingest', label: 'Ingestion', icon: '⇥' },
  { id: 'parties', label: 'Parties & consent', icon: '⚖' },
  { id: 'regulatory', label: 'Regulatory', icon: '§' },
  { id: 'ai', label: 'AI ledger', icon: '✳' },
  { id: 'ledger', label: 'Books', icon: '∑' },
  { id: 'labels', label: 'Labels & rename', icon: '⌘' },
  { id: 'durability', label: 'Durability', icon: '⟲' },
] as const;

export type ConsoleTab = (typeof CONSOLE_TABS)[number]['id'];

export const TOUR: TourStep[] = [
  {
    at: '00:00', minutes: 4, tab: 'overview', title: 'Land on the whole book in one screen',
    why: 'Before touching anything: this is one tenant, two legal entities and a Malaysian subsidiary, and every number here is computed live from the engine, not seeded display text.',
    doThis: [
      'Read the Tenant card: three entities, two currencies, two regulators.',
      'Note the unit-linked fund value, the sum assured, and "reproduced from log".',
      'Look at the Books card: both entity books report balanced.',
    ],
    expect: [
      'Fund value for UL-000123 is a live valuation, and the units reproduce from the transaction log alone.',
      'Takaful pools and the conventional book are separate; the books card proves it.',
    ],
    api: ['GET /api/world'],
  },
  {
    at: '00:04', minutes: 6, tab: 'policyholder', title: 'Look through a unit-linked policy into real instruments',
    why: 'This is the claim that beats ILAS: not just fund accounting, but genuine look-through into the instruments the fund actually holds, with a price date on every exposure.',
    doThis: [
      'Read the fund value and the units held per fund.',
      'Read the penetration table: fund, instrument, weight, value, market price, price date.',
      'Scroll the transaction log and read the dealing rule under each movement.',
    ],
    expect: [
      'Each holding shows the instrument, its market price and the date that price was taken.',
      'Every transaction carries the valuation date and a sentence explaining which cut-off applied.',
    ],
    api: ['GET /api/world', 'GET /api/units'],
  },
  {
    at: '00:10', minutes: 6, tab: 'decisions', title: 'Price a switch and a withdrawal before anything moves',
    why: 'A real decision theatre: units, price, valuation date, dealing rule, fees and lock-in blockers — all shown before the customer commits, with the illustration clearly labelled as an illustration.',
    doThis: [
      'Set a switch amount, pick the funds, and read the preview: units out, units in, fee, net invested.',
      'Move the instruction time past the 15:00 cut-off and watch the valuation date move.',
      'Open the withdrawal preview: cash to customer, units realised, remaining value, and the rule that priced it.',
      'Read the projection envelopes — adverse, central, favourable — and the disclaimer wording.',
    ],
    expect: [
      'Crossing the cut-off changes the valuation date, not the amount.',
      'The illustration is labelled; the engine never presents a projection as a promise.',
    ],
    api: ['POST /api/preview/switch', 'POST /api/preview/withdrawal'],
  },
  {
    at: '00:16', minutes: 5, tab: 'cover', title: 'Pay for cover only while cover is on',
    why: 'Daily, pay-as-you-go and start/stop cover as a billing primitive: nothing restarts by itself, and a day is either paid or cover suspends — there is no halfway charge.',
    doThis: [
      'Look at the segments: start, stop, daily rate, what has been charged.',
      'Stop cover, then advance the clock a few days and watch nothing accrue.',
      'Start cover again, advance the clock, and watch only the active days charge.',
      'Empty the wallet and tick again: cover suspends instead of going negative.',
    ],
    expect: [
      'Charges appear only for days inside an active window.',
      'After a stop, no day charges until someone explicitly starts again.',
    ],
    api: ['POST /api/cover/start', 'POST /api/cover/stop', 'POST /api/cover/tick'],
  },
  {
    at: '00:21', minutes: 5, tab: 'funds', title: 'Run the NAV engine and see the rules behind a price',
    why: 'Fund managers and auditors argue about valuation points. Here the cut-off, the business-day calendar, the floor price and its named residual are all visible, and reconciliation is an assertion, not a promise.',
    doThis: [
      'Read the valuation history per fund, including today.',
      'Read the look-through composition and any Shariah composition warnings.',
      'Find the reconciliation line: units × price + residual = NAV.',
      'Check the fund management charge accrual.',
    ],
    expect: [
      'The reconciliation ties exactly, with the residual named rather than buried in rounding.',
      'A non-screened instrument inside a Shariah fund raises a warning instead of passing silently.',
    ],
    api: ['GET /api/world'],
  },
  {
    at: '00:26', minutes: 6, tab: 'takaful', title: 'Run a takaful window that is structural, not cosmetic',
    why: 'Three funds, a real wakalah fee, tabarru into the risk pool, qard hasan when the pool is short, and a surplus that cannot be distributed until the actuary, the Shariah Committee and the board have all signed — with the UAE rule that participants never receive surplus applied on top.',
    doThis: [
      'Read the three pool balances and the operator fund.',
      'Read the qard: who lent to whom, how much is outstanding, and how it is repaid.',
      'Try to distribute the surplus and read the blockers, one by one.',
      'Sign as actuary, then Shariah, then board, and watch the blockers fall away.',
    ],
    expect: [
      'The distribution is refused until every gate is satisfied, and the refusal names the missing one.',
      'The surplus stays inside its own pool; nothing leaks into the operator fund.',
    ],
    api: ['POST /api/takaful/approve'],
  },
  {
    at: '00:32', minutes: 6, tab: 'group', title: 'Consolidate three entities, two currencies, one set of books',
    why: 'The part most ERP demos fake: assets and liabilities at the closing rate, income and expenses at the average rate, equity at the rate on the day it moved, the gap shown as a translation reserve, intercompany eliminated, and a minority interest stated rather than absorbed.',
    doThis: [
      'Read the three entities: functional currency, ownership, net assets, result, translation reserve.',
      'Read the intercompany table: one pair agrees and eliminates cleanly, the other does not and shows in transit.',
      'Find the minority interest line: 30% of the Malaysian subsidiary, stated separately.',
      'Press "Run the consolidation" twice and watch nothing new get posted.',
    ],
    expect: [
      'The consolidated balance sheet balances, and the group ledger proves itself.',
      'Consolidating again is idempotent, and the entity books are untouched.',
    ],
    api: ['GET /api/group', 'POST /api/group/consolidate'],
  },
  {
    at: '00:38', minutes: 5, tab: 'underwriting', title: 'Underwrite against a manual held as data',
    why: 'Loadings are shown line by line with the reason and the evidence each one demands, referrals go to a named human, and anything above the automatic binding limit is flagged for the reinsurer before the policy is issued. An AI agent may accept or rate inside its own limit and may never decline.',
    doThis: [
      'Read the accepted book: standard premium against loaded premium.',
      'Open the 2.5m application and read the referral points.',
      'Press "Ask the AI agent to decide" and read the refusal and the referral.',
      'Press "Senior underwriter takes the case" and watch the referral points be recorded as waived, by name.',
    ],
    expect: [
      'Every loading and exclusion carries a reason code and a plain sentence.',
      'The AI cannot decline a risk; the referral is recorded with the role that owns it.',
    ],
    api: ['GET /api/underwriting', 'POST /api/underwriting/decide'],
  },
  {
    at: '00:43', minutes: 5, tab: 'claims', title: 'Pay a claim through authority, not through a spreadsheet',
    why: 'Triage decides straight-through, referral or decline; a reserve is a booked liability rather than a note; approval is checked against a real authority table; settlement releases the reserve and recoveries are posted as their own income. In the takaful window the same workflow draws on the participants risk fund.',
    doThis: [
      'Read the position: reserved, expense incurred, cash paid, recoveries, net cost.',
      'Open the settled motor claim and read its timeline, then its salvage recovery.',
      'Open the open critical-illness claim and press "Ask the AI to approve 25,000.00" — read the refusal.',
      'Open the takaful claim and read where the money came from.',
    ],
    expect: [
      'An AI approval above its straight-through limit is refused, and the limit is named.',
      'A pooled claim moves cash exactly once, from the risk fund, with qard hasan if the pool is short.',
    ],
    api: ['GET /api/claims', 'POST /api/claims/register', 'POST /api/claims/approve', 'POST /api/claims/settle'],
  },
  {
    at: '00:48', minutes: 5, tab: 'reinsurance', title: 'Hand part of the risk to someone else, on the record',
    why: 'An insurer that keeps every risk whole is one bad quarter from ruin. This is the treaty register and the utilisation statement behind it: a quota share on the life case, a surplus treaty over a 200,000 retention, catastrophe cover, and a retakaful treaty for the takaful window — with the participant-money segregation rule enforced in code, and the security behind every counterparty\'s promise measured against what it owes us.',
    doThis: [
      'Read the two statements: the conventional book and the takaful window, each with its own treaties.',
      'Press "Cede a further risk": the engine authorises the cession, prices it and posts it — and the utilisation statement moves. Naming the same risk twice is refused rather than double-counted.',
      'Press "Place a risk facultatively": the reinsurer accepts the named risk first, then the premium moves.',
      'Read "The refusals": a risk the reinsurer has not accepted, and participant money offered to a conventional treaty.',
      'Press "Claim a catastrophe event", then "Reinstate the catastrophe cover": the layer pays above the retention, the cover is eaten, and the first reinstatement is free.',
      'Read the deposit card: premium paid on account is an asset, and the period settles against the real subject premium.',
      'Press "Settle the outstanding recovery": what the reinsurer still owes turns into cash, and the ageing resets.',
      'Read "Security behind the reinsurers\' promises": Emirates Re carries a 50,000.00 shortfall while being six days late on the recovery it already owes — and Gulf Reinsurance PSC is holding 516.61 more security than its treaties require.',
      'Press "Answer the outstanding cash call": the shortfall is called, then answered, and the cover goes to 100.00% with the cash posted to restricted cash.',
      'Press "Release the security we no longer need": the surplus goes back, the payable returns to the books, and the release is journaled.',
      'Press "Credit the interest on their cash": interest earned on a counterparty\'s cash is theirs, and it is carried as more of what we owe them — a retakaful treaty refuses interest altogether.',
    ],
    expect: [
      'Ceded premium, commission, net retained premium and the recoverable appear in the books, not just on screen.',
      'Every cession names the journal it produced, and the recoverable on the statement equals the receivable in the ledger.',
      'A deposit-accounted treaty recognises no premium income and no claim expense at all — the balance sheet carries it until settlement.',
      'Cash security and withheld premium appear as restricted cash and as security owed back; a letter of credit is disclosed and never posted as cash.',
      'The cash call asks for the shortfall and nothing more, and a second call for the same gap is refused while the first is unanswered.',
    ],
    api: ['GET /api/reinsurance', 'GET /api/reinsurance/security', 'POST /api/reinsurance/cede', 'POST /api/reinsurance/facultative', 'POST /api/reinsurance/recover', 'POST /api/reinsurance/event', 'POST /api/reinsurance/reinstate', 'POST /api/reinsurance/deposit', 'POST /api/reinsurance/deposit/settle', 'POST /api/reinsurance/settle', 'POST /api/reinsurance/security/hold', 'POST /api/reinsurance/security/call', 'POST /api/reinsurance/security/call/settle', 'POST /api/reinsurance/security/release', 'POST /api/reinsurance/security/interest'],
  },
  {
    at: '00:53', minutes: 3, tab: 'durability', title: 'Prove the books can be restored',
    why: 'A demo that cannot survive a restart is not an ERP. This seals the books into a canonical, fingerprinted snapshot and rebuilds a fresh ledger from that text, comparing trial balances.',
    doThis: [
      'Read the snapshot summary: accounts, journals, size, fingerprint.',
      'Press "Run durability drill".',
      'Read the per-entity result: balanced, trial balance agrees, restore time.',
    ],
    expect: [
      'The restore reports the same journals and the same balances, in milliseconds.',
      'The fingerprint is stable across runs, so a tampered payload would be caught.',
    ],
    api: ['GET /api/state', 'POST /api/state/drill'],
  },
  {
    at: '00:56', minutes: 4, tab: 'overview', title: 'The remainder of the hour: the fabric around the money',
    why: 'The modules an insurer actually runs on — onboarding, ingestion, consent, regulatory packs, renaming and AI governance — each one wired to something you can press.',
    doThis: [
      'Onboarding: read the chip read, the government lookup and the OCR consensus, then find the field in the review queue.',
      'Ingestion: submit a file of any shape, watch it map its own columns, quarantine the bad rows and suppress the duplicate.',
      'Parties & consent: run a partner lookup with consent, then without it, and read the access log.',
      'Regulatory: read the pre-sale gates for motor and medical, and the comparison matrix behind a motor quote.',
      'Labels & rename: rename a label in one scope only and watch the other scope keep its own word.',
      'AI ledger: read the prohibited intents, then try to get one executed and read the refusal.',
      'Books: read the trial balance and the journal list for an entity.',
    ],
    expect: [
      'Quarantined rows carry a reason per column; duplicates are suppressed, not double-counted.',
      'A refused AI action stays refused, and the attempt is still on the record.',
    ],
    api: ['POST /api/ingest/submit', 'POST /api/ingest/commit', 'POST /api/partner/lookup', 'POST /api/pre-sale', 'POST /api/ai/approve', 'POST /api/ai/execute'],
  },
];

export function tourMinutes(steps: readonly TourStep[] = TOUR): number {
  return steps.reduce((total, step) => total + step.minutes, 0);
}

/** Steps grouped by the tab they happen on, in tour order. */
export function tourByTab(steps: readonly TourStep[] = TOUR): Array<{ tab: string; steps: TourStep[] }> {
  const groups: Array<{ tab: string; steps: TourStep[] }> = [];
  for (const step of steps) {
    const last = groups[groups.length - 1];
    if (last && last.tab === step.tab) last.steps.push(step);
    else groups.push({ tab: step.tab, steps: [step] });
  }
  return groups;
}
