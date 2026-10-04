/**
 * UAE reinsurance rules, held as data and enforced on every placement.
 *
 * A rule here is not a paragraph in a policy manual that nobody reads until an examination: it is a
 * record with an instrument, a clause, a plain-English requirement, the Arabic wording of the same
 * requirement, the severity of a breach, and the documents an examiner will ask for. The engine
 * evaluates the rules that apply to a placement and answers with one of three things:
 *
 *  - **allow** — every rule that applies is met and the evidence is on file;
 *  - **escalate** — something is unproven (a rating nobody has seen, a certificate that has run out,
 *    a plan not reviewed inside the year) so a named human must decide, with the missing evidence
 *    written on the decision;
 *  - **refuse** — a rule that may not be broken is broken, and the placement does not proceed.
 *
 * The four instruments cited are the ones that govern a UAE carrier placing reinsurance:
 * Federal Decree-Law No. 48 of 2023 (carried forward by Federal Decree-Law No. 6 of 2025, in force
 * 16 September 2025 with a transition to 16 September 2026), and the CBUAE reinsurance regulations,
 * whose Article (18) classification requirement, Article (31) tender approval, Article (38)
 * facultative conditions and Article (39) treaty acceptance are all enforced below. Article numbers
 * and quotations are as published; the rule book names the clause on every decision so a reviewer can
 * check the wording against the current rulebook version, and an outdated citation is a finding
 * rather than an opinion. What this engine deliberately does not claim is that it reads the rulebook
 * for you: it holds the rules a UAE carrier has decided to enforce, and it says so on every decision.
 */
import { Basis, TreatyKind } from './reinsurance.js';
import { Money, formatAmount, gte } from './money.js';

export class UaeRuleError extends Error {}

/**
 * What happens when a rule is **breached**: `refuse` stops the placement, `escalate` holds it for a
 * named human who may accept it in writing, `disclose` never blocks but travels on the decision and
 * the return. A fact that cannot be shown at all is `unproven` and always goes to a named human,
 * whatever the severity: silence is never allowed to look like compliance.
 */
export type RuleSeverity = 'refuse' | 'escalate' | 'disclose';
export type RuleState = 'met' | 'breached' | 'unproven' | 'not-applicable';

export interface RuleInstrument {
  readonly title: string;
  readonly reference: string;
  readonly inForce: string;
  readonly note?: string;
}

/* ------------------------------------------------------------------ the instruments */

const LAW_48_2023: RuleInstrument = {
  title: 'Federal Decree-Law No. 48 of 2023 Regulating Insurance Activities',
  reference: 'Article (42)',
  inForce: '30 November 2023',
  note: 'replaced by Federal Decree-Law No. 6 of 2025 from 16 September 2025, with a transition to 16 September 2026',
};

const LAW_6_2025: RuleInstrument = {
  title: 'Federal Decree-Law No. 6 of 2025 on the Central Bank, the Regulation of Financial Institutions and Activities, and Insurance Business',
  reference: 'Article (82)',
  inForce: '16 September 2025',
  note: 'consolidates the insurance law into the CBUAE mandate; the reinsurance freedoms and controls of the 2023 law are carried forward',
};

const REINSURANCE_REGS: RuleInstrument = {
  title: 'CBUAE reinsurance regulations (Insurance Authority Board Decision No. 23 of 2019, carried into the CBUAE rulebook)',
  reference: 'Article (18)',
  inForce: '2019, as carried into the rulebook',
  note: 'Article (18) sets the classification requirement for reinsurers; Articles (31), (38) and (39) are cited by the rules that use them',
};

const PRUDENTIAL_REGS: RuleInstrument = {
  title: 'CBUAE financial regulations — capital, assets and technical provisions',
  reference: 'Minimum capital requirement',
  inForce: 'as carried into the rulebook',
};

/* ------------------------------------------------------------------ the facts */

export interface CounterpartyFacts {
  readonly name: string;
  readonly licensedIn: 'AE' | 'foreign' | 'free-zone' | 'unlicensed';
  readonly licenceClass?: string;              // 'life' | 'motor' | 'all' — what the licence lets it carry
  readonly rating?: string;                    // S&P/Fitch scale or Moody's, mapped below
  readonly ratingAgency?: string;
  readonly retakaful?: boolean;                // a Shariah-compliant retakaful operator or window
  readonly branchOfForeignCompany?: boolean;
  readonly bankGuarantee?: Money;              // lodged with the CBUAE by a foreign branch
}

export interface PlacementFacts {
  readonly subject: string;
  readonly at: string;
  readonly by: string;
  readonly basis: Basis;
  readonly counterparty: CounterpartyFacts;
  readonly cession?: { readonly treatyId: string; readonly kind: TreatyKind; readonly lineOfBusiness: string; readonly shareBps?: number };
  readonly retentionPlan?: { readonly approved: boolean; readonly reviewedAt?: string };
  readonly inward?: { readonly directorGeneralApproved: boolean; readonly articlesPermit: boolean; readonly paidUpCapital: Money };
  readonly facultative?: { readonly withinRetentionOrTreaty: boolean; readonly recedesToThirdParty?: boolean; readonly cedingCompanyApproval?: boolean };
  readonly tender?: { readonly surplusCoveredByTreaty: boolean; readonly leadingReinsurerApproved?: boolean; readonly leadingReinsurerRating?: string };
  readonly branchCertificateAt?: string;
  readonly documents: readonly string[];
}

/* ------------------------------------------------------------------ the rules */

export interface UaeRule {
  readonly id: string;
  readonly title: string;
  readonly severity: RuleSeverity;
  readonly instrument: RuleInstrument;
  readonly clause: string;                     // the words of the instrument, quoted
  readonly requirement: string;                // what it asks of a UAE carrier, in plain English
  readonly requirementAr: string;              // the same requirement, in the Arabic the desk works in
  readonly evidence: readonly string[];        // what an examiner asks to see
  applies: (facts: PlacementFacts) => boolean;
  test: (facts: PlacementFacts) => { state: Exclude<RuleState, 'not-applicable'>; detail: string };
}

/** S&P/Fitch and Moody's scales on one ladder, so a mixed portfolio compares like with like. */
const RATING_RANK: Record<string, number> = {
  AAA: 20, 'AA+': 19, AA: 18, 'AA-': 17, 'A+': 16, A: 15, 'A-': 14,
  'BBB+': 13, BBB: 12, 'BBB-': 11, 'BB+': 10, BB: 9, 'BB-': 8, 'B+': 7, B: 6, 'B-': 5, CCC: 3,
  Aaa: 20, Aa1: 19, Aa2: 18, Aa3: 17, A1: 16, A2: 15, A3: 14,
  Baa1: 13, Baa2: 12, Baa3: 11, Ba1: 10, Ba2: 9, Ba3: 8, B1: 7, B2: 6, B3: 5,
};

/** BBB on the S&P/Fitch scale, Baa2 on Moody's: the floor the CBUAE guidance names for a reinsurer. */
export const MINIMUM_RATING_RANK = 12;
/** A treaty reinsurance acceptor: AED 350,000,000 of subscribed and paid-up capital, with the Director General's approval. */
export const INWARD_PAID_UP_CAPITAL = 350_000_000;
/** A foreign branch's irrevocable bank guarantee: AED 100m for insurance, AED 250m for reinsurance. */
export const FOREIGN_BRANCH_GUARANTEE = { insurance: 100_000_000, reinsurance: 250_000_000 };

export function ratingRank(rating?: string): number | null {
  if (!rating) return null;
  return RATING_RANK[rating.trim()] ?? null;
}

const monthsSince = (from: string, to: string): number => {
  const [fy = 0, fm = 0, fd = 0] = from.slice(0, 10).split('-').map(Number);
  const [ty = 0, tm = 0, td = 0] = to.slice(0, 10).split('-').map(Number);
  let months = (ty - fy) * 12 + (tm - fm);
  if (td < fd) months -= 1;
  return months;
};

const onFile = (facts: PlacementFacts, document: string): boolean => facts.documents.includes(document);
const missing = (facts: PlacementFacts, document: string): boolean => !onFile(facts, document);

export const UAE_RULES: readonly UaeRule[] = [
  {
    id: 'UAE-RI-01',
    title: 'Reinsure only with a company licensed to carry the class',
    severity: 'refuse',
    instrument: LAW_48_2023,
    clause: 'Article (42): The Company may not reinsure with another company unless the other company is licensed to carry out the insurance type entrusted to reinsure it.',
    requirement: 'The counterparty must be licensed for the class of business ceded — a UAE licence, or a home-state licence naming the class for a reinsurer abroad. A UAE carrier may reinsure inside or outside the State, but never with an unlicensed company.',
    requirementAr: 'لا يجوز للشركة أن تعيد التأمين لدى شركة أخرى ما لم تكن تلك الشركة مرخصة لمزاولة نوع التأمين المطلوب إعادة تأمينه.',
    evidence: ['home-state licence certificate', 'CBUAE licence extract'],
    applies: () => true,
    test: (f) => {
      const c = f.counterparty;
      if (c.licensedIn === 'unlicensed') {
        return { state: 'breached', detail: `${c.name} holds no licence to carry the class ceded — a policy placed on an unlicensed company is void, so this placement cannot stand` };
      }
      if (!c.licenceClass) {
        return { state: 'unproven', detail: `${c.name} is licensed in ${c.licensedIn === 'AE' ? 'the UAE' : c.licensedIn === 'free-zone' ? 'a financial free zone' : 'its home state'} but the class on that licence is not on file` };
      }
      const line = f.cession?.lineOfBusiness ?? 'the class ceded';
      if (c.licenceClass !== 'all' && !c.licenceClass.split(/[,\s]+/).includes(line)) {
        return { state: 'breached', detail: `${c.name} is licensed for ${c.licenceClass}, and this placement cedes ${line}` };
      }
      return { state: 'met', detail: `${c.name} holds a ${c.licenceClass} licence in ${c.licensedIn === 'AE' ? 'the UAE' : c.licensedIn === 'free-zone' ? 'a financial free zone' : 'its home state'}` };
    },
  },
  {
    id: 'UAE-RI-02',
    title: 'A counterparty at or above the rating floor, or board diligence on file',
    severity: 'refuse',   // below the floor with no board diligence is a breach; no rating at all is unproven and escalates
    instrument: REINSURANCE_REGS,
    clause: 'Article (18): acceptance of reinsurance business is conditional on the reinsurer meeting the classification stipulated, and business exceeding retention must be covered with reinsurers who have that classification, subject to the stated exceptions.',
    requirement: 'A reinsurance counterparty should hold a financial strength rating of BBB (S&P) or equivalent — Baa2 or better — or, if it does not, the placement needs documented board-level due diligence before it is bound.',
    requirementAr: 'يُشترط في شركة إعادة التأمين الحصول على تصنيف مالي لا يقل عن BBB أو ما يعادله، وإلا وجب توثيق العناية الواجبة على مستوى مجلس الإدارة.',
    evidence: ['rating agency report', 'board-diligence-minute'],
    applies: (f) => f.counterparty.licensedIn !== 'AE',
    test: (f) => {
      const rank = ratingRank(f.counterparty.rating);
      if (rank === null) {
        return onFile(f, 'rating agency report')
          ? { state: 'unproven', detail: `a rating report for ${f.counterparty.name} is on file but the rating itself was not captured on this placement` }
          : { state: 'unproven', detail: `no rating for ${f.counterparty.name} is on file` };
      }
      if (rank >= MINIMUM_RATING_RANK) {
        return { state: 'met', detail: `${f.counterparty.rating} (${f.counterparty.ratingAgency ?? 'agency not stated'}) is at or above the BBB floor` };
      }
      if (onFile(f, 'board-diligence-minute')) {
        return { state: 'met', detail: `${f.counterparty.rating} is below the floor, and the board's own due diligence on ${f.counterparty.name} is on file` };
      }
      return { state: 'breached', detail: `${f.counterparty.rating} is below the BBB floor and no board-level due diligence is on file` };
    },
  },
  {
    id: 'UAE-RI-03',
    title: 'Recoverables count as admissible assets only at or above the floor',
    severity: 'disclose',
    instrument: PRUDENTIAL_REGS,
    clause: 'Assets available to meet insurance liabilities may include reinsurance recoverables where the reinsurer is rated BBB or better.',
    requirement: 'Money due from a counterparty below the floor is not an admissible asset: the return must show the recoverable without credit for it, and the solvency position must be read with that in mind.',
    requirementAr: 'لا تُعد المبالغ المستحقة من معيد تأمين دون التصنيف المطلوب أصولاً مقبولة، ويجب بيانها دون احتساب رصيد لها.',
    evidence: ['solvency return extract', 'rating agency report'],
    applies: (f) => (f.counterparty.rating !== undefined || f.counterparty.licensedIn !== 'AE'),
    test: (f) => {
      const rank = ratingRank(f.counterparty.rating);
      if (rank === null) return { state: 'unproven', detail: `the recoverable from ${f.counterparty.name} cannot be given credit until its rating is on file` };
      if (rank >= MINIMUM_RATING_RANK) return { state: 'met', detail: `${f.counterparty.rating} means recoverables from ${f.counterparty.name} may be admitted` };
      return { state: 'breached', detail: `recoverables from ${f.counterparty.name} (${f.counterparty.rating}) must be shown without credit in the return` };
    },
  },
  {
    id: 'UAE-RI-04',
    title: 'Every cession sits inside the board-approved retention and reinsurance plan',
    severity: 'refuse',
    instrument: REINSURANCE_REGS,
    clause: 'The company shall prepare a three-year plan concerning retention and reinsurance for each type and class, approve it at the board, and review it annually during the three months before each year, covering retention and treaty limits, treaty types and facultative cessions.',
    requirement: 'A cession must be permitted by the plan the board approved, and the plan must have been reviewed inside the year before the placement. A cession outside the plan is refused; a plan whose review window has passed is escalated.',
    requirementAr: 'يجب أن تكون إعادة التأمين ضمن الخطة المعتمدة من مجلس الإدارة، وأن تُراجع الخطة سنوياً خلال الأشهر الثلاثة السابقة لكل سنة.',
    evidence: ['approved retention and reinsurance plan', 'board minute of the annual review'],
    applies: (f) => f.cession !== undefined,
    test: (f) => {
      const plan = f.retentionPlan;
      if (!plan || !plan.approved) return { state: 'breached', detail: 'no board-approved retention and reinsurance plan covers this cession' };
      if (!f.cession) return { state: 'met', detail: 'the placement is inside the approved plan' };
      if (!plan.reviewedAt) return { state: 'unproven', detail: 'the plan is approved but the date of its annual review is not on file' };
      const months = monthsSince(plan.reviewedAt, f.at);
      if (months > 12) {
        return { state: 'breached', detail: `the plan was last reviewed on ${plan.reviewedAt.slice(0, 10)}, ${months} months before this placement — the annual review has been missed` };
      }
      return { state: 'met', detail: `the plan was reviewed on ${plan.reviewedAt.slice(0, 10)}, ${months} month(s) before this placement` };
    },
  },
  {
    id: 'UAE-RI-05',
    title: 'A foreign branch files its head-office reinsurance certificate every year',
    severity: 'escalate',
    instrument: REINSURANCE_REGS,
    clause: 'A foreign insurance company operating in the State through a branch shall annually submit a certified certificate from its head office supporting that the business subscribed within the State and exceeding its retention is covered by reinsurance with reinsurers who have the classification stipulated in Article (18).',
    requirement: 'Where the counterparty is the branch of a foreign company, its annual certified certificate must be on file and no more than twelve months old.',
    requirementAr: 'على فرع شركة التأمين الأجنبية العاملة في الدولة أن يقدم سنوياً شهادة معتمدة من المركز الرئيسي تفيد بأن الأعمال التي تتجاوز حد الاحتفاظ مغطاة لدى معيدي تأمين حاصلين على التصنيف المطلوب.',
    evidence: ['head office certificate'],
    applies: (f) => f.counterparty.branchOfForeignCompany === true,
    test: (f) => {
      if (!f.branchCertificateAt) return { state: 'unproven', detail: `no head-office certificate is on file for ${f.counterparty.name}` };
      const months = monthsSince(f.branchCertificateAt, f.at);
      if (months > 12) return { state: 'breached', detail: `the certificate is dated ${f.branchCertificateAt.slice(0, 10)}, ${months} months before this placement` };
      return { state: 'met', detail: `the certificate is current, dated ${f.branchCertificateAt.slice(0, 10)}` };
    },
  },
  {
    id: 'UAE-RI-06',
    title: 'Accepting treaty reinsurance needs approval and capital',
    severity: 'refuse',
    instrument: REINSURANCE_REGS,
    clause: 'Article (39): in order to accept the treaty reinsurance business, the insurance company established in the State is required to obtain approval from the Director General, and the minimum subscribed and paid-up capital of the company shall not be less than AED 350,000,000.',
    requirement: 'Inward treaty business may only be accepted with the Director General\'s approval, articles that authorise accepting reinsurance, and at least AED 350,000,000 of subscribed and paid-up capital.',
    requirementAr: 'لا يجوز قبول أعمال إعادة التأمين الاتفاقي إلا بعد الحصول على موافقة المدير العام، وبألا يقل رأس المال المكتتب المدفوع عن 350,000,000 درهم.',
    evidence: ['director-general approval', 'articles of association', 'paid-up capital certificate'],
    applies: (f) => f.inward !== undefined,
    test: (f) => {
      const inward = f.inward!;
      if (!inward.directorGeneralApproved) return { state: 'breached', detail: 'the Director General has not approved the acceptance of treaty reinsurance business' };
      if (!inward.articlesPermit) return { state: 'breached', detail: 'the articles of association do not authorise accepting reinsurance business' };
      if (!gte(inward.paidUpCapital, { minor: BigInt(INWARD_PAID_UP_CAPITAL) * 100n, currency: inward.paidUpCapital.currency })) {
        return { state: 'breached', detail: `paid-up capital is ${formatAmount(inward.paidUpCapital)}, below the ${formatAmount({ minor: BigInt(INWARD_PAID_UP_CAPITAL) * 100n, currency: inward.paidUpCapital.currency })} required to accept treaty reinsurance` };
      }
      return { state: 'met', detail: `approved, authorised by the articles, and capital of ${formatAmount(inward.paidUpCapital)}` };
    },
  },
  {
    id: 'UAE-RI-07',
    title: 'Facultative acceptance only within retention or under a treaty',
    severity: 'refuse',
    instrument: REINSURANCE_REGS,
    clause: 'Article (38): the accepted liabilities shall be either within the company\'s retention or exceeding it, in which case the company must have a reinsurance treaty that protects the surplus and contains a provision allowing it to accept facultative reinsurance within determined limits; re-ceding that surplus facultatively needs the prior approval of the ceding company.',
    requirement: 'Facultative business may be accepted only inside the retention or under a treaty that protects the surplus and permits facultative acceptance; passing the surplus on needs the ceding company\'s prior approval.',
    requirementAr: 'لا يجوز قبول أعمال إعادة التأمين الاختياري إلا في حدود حد الاحتفاظ أو في وجود اتفاقية تحمي الفائض وتجيز القبول، مع الحصول على موافقة مسبقة من الشركة المتنازلة عند إعادة التنازل.',
    evidence: ['ceding company approval', 'treaty extract'],
    applies: (f) => f.facultative !== undefined,
    test: (f) => {
      const fac = f.facultative!;
      if (!fac.withinRetentionOrTreaty) return { state: 'breached', detail: 'the accepted liability is neither inside the retention nor protected by a treaty that permits it' };
      if (fac.recedesToThirdParty && !fac.cedingCompanyApproval) {
        return { state: 'breached', detail: 'the surplus is being re-ceded facultatively without the ceding company\'s prior approval' };
      }
      return { state: 'met', detail: fac.recedesToThirdParty ? 'inside the retention or protected, and the ceding company has approved the onward placement' : 'inside the retention or protected by a treaty that permits acceptance' };
    },
  },
  {
    id: 'UAE-RI-08',
    title: 'A tender is only offered with a leading reinsurer behind the surplus',
    severity: 'refuse',   // going to tender uncovered is a breach; an approval whose rating was not captured is unproven
    instrument: REINSURANCE_REGS,
    clause: 'Article (31): the company shall obtain approval, before submitting its offer, from a leading reinsurer that meets the conditions stipulated in Article (18), where the tender\'s cover is one for which the company has no reinsurance treaty covering the surplus above its retention.',
    requirement: 'Where a tender is not covered by treaty, written approval from a leading reinsurer that meets the classification requirement must be on file before the offer goes in.',
    requirementAr: 'يجب الحصول على موافقة من معيد تأمين رائد يستوفي شروط المادة (18) قبل تقديم العرض إذا لم تكن تغطية المناقصة مشمولة باتفاقية إعادة تأمين.',
    evidence: ['leading reinsurer approval'],
    applies: (f) => f.tender !== undefined,
    test: (f) => {
      const t = f.tender!;
      if (t.surplusCoveredByTreaty) return { state: 'met', detail: 'the surplus is covered by an existing treaty, so no tender approval is required' };
      if (!t.leadingReinsurerApproved) return { state: 'breached', detail: 'no leading reinsurer has approved the surplus and the tender is not covered by treaty' };
      const rank = ratingRank(t.leadingReinsurerRating);
      if (rank === null) return { state: 'unproven', detail: 'the leading reinsurer\'s approval is on file but its classification was not captured' };
      if (rank < MINIMUM_RATING_RANK) return { state: 'breached', detail: `the leading reinsurer is rated ${t.leadingReinsurerRating}, below the classification the Article (18) route requires` };
      return { state: 'met', detail: `a leading reinsurer rated ${t.leadingReinsurerRating} has approved the surplus before the offer` };
    },
  },
  {
    id: 'UAE-RI-09',
    title: 'Participant risk money goes to retakaful only',
    severity: 'refuse',
    instrument: LAW_48_2023,
    clause: 'Article (42), read with the takaful regulations: the class entrusted must be carried by the counterparty, and a takaful operator\'s participant risk fund may only be protected by retakaful.',
    requirement: 'A takaful window cedes only to a retakaful operator or a Shariah-compliant retakaful window. Participant risk money never enters a conventional pool — a breach is refused at the register, not corrected afterwards.',
    requirementAr: 'لا يجوز لصندوق مخاطر المشتركين في شركة تكافل أن يعيد التأمين إلا لدى معيد تكافل، ولا يجوز تحويل أموال المخاطر للمشتركين إلى صندوق تقليدي.',
    evidence: ['retakaful certificate', 'shariah committee approval'],
    applies: (f) => f.basis === 'takaful',
    test: (f) => {
      if (!f.counterparty.retakaful) {
        return { state: 'breached', detail: `${f.counterparty.name} is not a retakaful operator, and ${f.subject} is participant risk money` };
      }
      if (missing(f, 'shariah committee approval')) {
        return { state: 'unproven', detail: `${f.counterparty.name} is a retakaful operator but the Shariah Committee approval for this treaty is not on file` };
      }
      return { state: 'met', detail: `${f.counterparty.name} is a retakaful operator and the Shariah Committee has approved the treaty` };
    },
  },
  {
    id: 'UAE-RI-10',
    title: 'A free-zone company reinsures, and does nothing else outside the zone',
    severity: 'disclose',
    instrument: LAW_48_2023,
    clause: 'Article (64): insurance companies licensed to operate in the financial free zones may not carry out any activity outside such zones in the State, except for reinsurance.',
    requirement: 'A free-zone counterparty is a permitted reinsurer: the placement may stand, and the decision records the limit on what that company may do outside its zone.',
    requirementAr: 'لا يجوز لشركات التأمين المرخصة في المناطق المالية الحرة مزاولة أي نشاط خارج تلك المناطق داخل الدولة، باستثناء إعادة التأمين.',
    evidence: ['free-zone licence extract'],
    applies: (f) => f.counterparty.licensedIn === 'free-zone',
    test: (f) => ({ state: 'met', detail: `${f.counterparty.name} is zone-licensed; reinsurance is the activity it may write outside the zone` }),
  },
  {
    id: 'UAE-RI-11',
    title: 'A foreign branch lodges the bank guarantee its licence requires',
    severity: 'refuse',
    instrument: LAW_48_2023,
    clause: 'Article (50): the foreign insurance company\'s branch shall submit an irrevocable bank guarantee in favour of the CBUAE of not less than AED 100,000,000 where it carries on insurance activity, and not less than AED 250,000,000 where it carries on reinsurance activity.',
    requirement: 'Where the counterparty is a foreign branch writing reinsurance, an irrevocable bank guarantee of at least AED 250,000,000 (AED 100,000,000 for insurance) must be lodged with the CBUAE.',
    requirementAr: 'يقدم فرع شركة التأمين الأجنبية ضماناً مصرفياً غير قابل للإلغاء لصالح المصرف المركزي لا يقل عن 100,000,000 درهم لمزاولة التأمين و250,000,000 درهم لمزاولة إعادة التأمين.',
    evidence: ['bank guarantee'],
    applies: (f) => f.counterparty.branchOfForeignCompany === true && f.counterparty.bankGuarantee !== undefined,
    test: (f) => {
      const amount = f.counterparty.bankGuarantee!;
      const activity = f.cession ? 'reinsurance' : 'insurance';
      const floor = { minor: BigInt(FOREIGN_BRANCH_GUARANTEE[activity as 'insurance' | 'reinsurance']) * 100n, currency: amount.currency };
      if (!gte(amount, floor)) {
        return { state: 'breached', detail: `the guarantee lodged is ${formatAmount(amount)}, below the ${formatAmount(floor)} the licence requires for ${activity}` };
      }
      return { state: 'met', detail: `an irrevocable guarantee of ${formatAmount(amount)} is lodged, at or above the ${formatAmount(floor)} floor` };
    },
  },
  {
    id: 'UAE-RI-12',
    title: 'UAE risk insured at home, protected anywhere',
    severity: 'disclose',
    instrument: LAW_6_2025,
    clause: 'Article (82)(2): a UAE insurer may reinsure its business with reinsurers located in the UAE or outside the State; a policy may not be concluded with a company outside the State to cover money or property within the State.',
    requirement: 'The risk stays with a licensed UAE carrier and the reinsurance may be placed anywhere — the decision records which of the two this placement is.',
    requirementAr: 'يجوز لشركة التأمين في الدولة إعادة تأمين أعمالها لدى معيدي تأمين داخل الدولة أو خارجها، دون جواز إبرام وثيقة لدى شركة خارج الدولة لتغطية أموال أو ممتلكات داخل الدولة.',
    evidence: ['placement file'],
    applies: () => true,
    test: (f) => ({
      state: 'met',
      detail: f.cession
        ? `the risk is retained by a licensed UAE carrier and the reinsurance is placed with ${f.counterparty.name} (${f.cession.treatyId})`
        : `the risk is carried by a licensed UAE carrier and ${f.subject} is a direct placement`,
    }),
  },
];

/* ------------------------------------------------------------------ the decision */

export interface RuleFinding {
  readonly ruleId: string;
  readonly title: string;
  readonly severity: RuleSeverity;
  readonly state: RuleState;
  readonly requirement: string;
  readonly requirementAr: string;   // the same requirement in Arabic: the desk reads both
  readonly detail: string;
  readonly clause: string;
  readonly instrument: string;
  readonly evidenceRequired: readonly string[];
  readonly evidenceOnFile: readonly string[];
  readonly evidenceMissing: readonly string[];
}

export interface RuleDecision {
  readonly id: string;
  readonly subject: string;
  readonly at: string;
  readonly by: string;
  readonly basis: Basis;
  readonly counterparty: string;
  readonly decision: 'allow' | 'escalate' | 'refuse';
  readonly findings: readonly RuleFinding[];
  readonly blocking: readonly RuleFinding[];
  readonly disclosures: readonly RuleFinding[];
  readonly instruments: readonly string[];
  readonly evidence: string;
}

export interface RuleStatement {
  readonly rules: number;
  readonly decisions: number;
  readonly allow: number;
  readonly escalate: number;
  readonly refuse: number;
  readonly byRule: ReadonlyArray<{ ruleId: string; title: string; severity: RuleSeverity; raised: number }>;
}

/**
 * The rule book, and the record of every decision taken under it. Decisions are append-only and
 * frozen: a later event is answered with a new decision that references the earlier one, never by
 * editing it — exactly what an examiner asks for when they want to see what was known on the day.
 */
export class UaeRuleBook {
  private readonly log: RuleDecision[] = [];
  private seq = 0;

  constructor(private readonly options: { readonly limit?: number } = {}) {}

  rules(): readonly UaeRule[] { return UAE_RULES; }

  rule(id: string): UaeRule {
    const rule = UAE_RULES.find((r) => r.id === id);
    if (!rule) throw new UaeRuleError(`no rule ${id} in the UAE rule book`);
    return rule;
  }

  enforce(facts: PlacementFacts): RuleDecision {
    const limit = this.options.limit ?? 500;
    if (this.log.length >= limit) throw new UaeRuleError(`the decision log is full at ${limit} decisions`);
    const findings: RuleFinding[] = [];
    for (const rule of UAE_RULES) {
      if (!rule.applies(facts)) continue;
      const outcome = rule.test(facts);
      const evidenceIfNeeded = outcome.state === 'met' ? [] : rule.evidence;
      findings.push({
        ruleId: rule.id, title: rule.title, severity: rule.severity, state: outcome.state,
        requirement: rule.requirement, requirementAr: rule.requirementAr, detail: outcome.detail,
        clause: `${rule.instrument.reference} — ${rule.instrument.title}`,
        instrument: rule.instrument.title,
        evidenceRequired: evidenceIfNeeded,
        evidenceOnFile: evidenceIfNeeded.filter((d) => onFile(facts, d)),
        evidenceMissing: evidenceIfNeeded.filter((d) => missing(facts, d)),
      });
    }
    const refused = findings.filter((f) => f.state === 'breached' && f.severity === 'refuse');
    const held = findings.filter((f) => f.severity !== 'disclose' && (f.state === 'unproven' || (f.state === 'breached' && f.severity === 'escalate')));
    const decision: RuleDecision = Object.freeze({
      id: `UAE-RULE-${String(++this.seq).padStart(6, '0')}`,
      subject: facts.subject, at: facts.at, by: facts.by, basis: facts.basis,
      counterparty: facts.counterparty.name,
      decision: refused.length > 0 ? 'refuse' : held.length > 0 ? 'escalate' : 'allow',
      findings: Object.freeze(findings.map((f) => Object.freeze({ ...f }))),
      blocking: Object.freeze([...refused, ...held]),
      disclosures: Object.freeze(findings.filter((f) => f.severity === 'disclose' && f.state !== 'met')),
      instruments: Object.freeze([...new Set(findings.map((f) => f.clause))]),
      evidence: this.summarise(facts, refused, held, findings),
    });
    this.log.push(decision);
    return decision;
  }

  /** The placement path calls this: a refusal stops the transaction, an escalation needs a name on it. */
  require(facts: PlacementFacts, options: { readonly escalatedTo?: string } = {}): RuleDecision {
    const decision = this.enforce(facts);
    if (decision.decision === 'refuse') {
      throw new UaeRuleError(`${decision.subject} refused under ${decision.blocking.map((f) => f.ruleId).join(', ')}: ${decision.blocking[0]!.detail}`);
    }
    if (decision.decision === 'escalate' && !options.escalatedTo) {
      throw new UaeRuleError(`${decision.subject} needs a human decision under ${decision.blocking.map((f) => f.ruleId).join(', ')}: ${decision.blocking[0]!.detail}`);
    }
    return decision;
  }

  decisions(): readonly RuleDecision[] { return this.log; }

  decision(id: string): RuleDecision {
    const found = this.log.find((d) => d.id === id);
    if (!found) throw new UaeRuleError(`no decision ${id} in the UAE rule log`);
    return found;
  }

  statement(): RuleStatement {
    const raised = new Map<string, number>();
    for (const decision of this.log) for (const finding of decision.blocking) raised.set(finding.ruleId, (raised.get(finding.ruleId) ?? 0) + 1);
    return {
      rules: UAE_RULES.length,
      decisions: this.log.length,
      allow: this.log.filter((d) => d.decision === 'allow').length,
      escalate: this.log.filter((d) => d.decision === 'escalate').length,
      refuse: this.log.filter((d) => d.decision === 'refuse').length,
      byRule: UAE_RULES.map((r) => ({ ruleId: r.id, title: r.title, severity: r.severity, raised: raised.get(r.id) ?? 0 })),
    };
  }

  /** What the rule book claims, and where its claims stop — written on the face of every statement. */
  limitation(): string {
    return `The rule book holds ${UAE_RULES.length} rules as data, each citing its instrument and clause as published on `
      + `${UAE_RULES[0]!.instrument.inForce}; Article numbers are not re-read from the rulebook by this engine, and a citation that has moved `
      + 'shows up as a finding to update rather than as silence. Decisions are append-only: a later placement is answered with a new decision.';
  }

  private summarise(facts: PlacementFacts, refused: readonly RuleFinding[], held: readonly RuleFinding[], findings: readonly RuleFinding[]): string {
    const decisive = refused.length > 0 ? refused : held;
    const lines: string[] = [];
    lines.push(refused.length > 0
      ? `Refused: ${refused.map((f) => `${f.ruleId} (${f.detail})`).join('; ')}`
      : held.length > 0
        ? `Held for a named human: ${held.map((f) => `${f.ruleId} (${f.detail})`).join('; ')}`
        : `Allowed: every rule that applies to ${facts.subject} with ${facts.counterparty.name} is met with the evidence on file`);
    const rests = [...new Set((decisive.length > 0 ? decisive : findings).map((f) => f.clause))];
    lines.push(`Rests on ${rests.slice(0, 2).join('; ')}${rests.length > 2 ? ` and ${rests.length - 2} further citation(s)` : ''}`);
    lines.push(`Decided by ${facts.by} at ${facts.at}`);
    return lines.join('. ');
  }
}
