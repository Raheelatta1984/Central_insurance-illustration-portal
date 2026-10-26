/**
 * The customer lifecycle journey: one sequence of gated sections, from onboarding to investment
 * progress.
 *
 * The rule this module exists to enforce is the one operators keep breaking in tabbed consoles: a
 * section is not "done" because somebody typed into it, and the next section does not open because
 * somebody clicked on it. Each stage declares its mandatory fields and its domain gates; a stage is
 * complete only when both are satisfied, and the stage after it unlocks only then. The machine also
 * says which section should be open *now* (`nextRecommended`), which is what lets the console keep
 * everything collapsed and open the right one by itself.
 *
 * This file is pure: it holds no engine, no money movement and no I/O, so the sequencing can be
 * tested on its own and the same gate the console obeys is the gate the API obeys. The side effects
 * live in `journeydesk.ts`.
 *
 * Sequence (and why it is in this order):
 *   1  identity        — who the customer is, verified, with consent        (KYC / golden record)
 *   2  profile         — contact, tax residence, duplicate check            (Customer 360)
 *   3  needs           — the needs-analysis questionnaire                   (regulatory, per country)
 *   4  recommendation  — the product/item list the need supports            (regulatory)
 *   5  coverage        — sum assured, term, frequency, premium              (illustration)
 *   6  loadings        — occupational and medical loadings, itemised        (underwriting manual)
 *   7  riders          — additional riders, with or without loading         (underwriting authority)
 *   8  medical         — medical requirements ordered, received, reviewed   (evidence)
 *   9  funds           — fund selection and allocation                      (unit-linked)
 *  10  beneficiaries   — who receives the proceeds                          (policy terms)
 *  11  uw-review       — underwriting & medical questionnaire review/update (decision)
 *  12  quotation       — quotation as a PDF, emailed to the customer        (disclosure)
 *  13  finalisation    — cooling-off, customer sign-off                     (free-look)
 *  14  payment         — buy online: cash, card, transfer, BNPL, branch     (money in)
 *  15  routing         — auto / manual / senior / freelance / reinsurance   (binding authority)
 *  16  conversion      — proposal becomes a policy                          (issue)
 *  17  allocation      — funds allocation and management in force           (stewardship)
 *  18  investment      — investment allocations and progress                (performance)
 *  19  servicing       — alterations and claims                             (the rest of the life)
 */
import { Money, compare, formatAmount, money, parseAmount, sub } from './money.js';
import { ProductCandidate, NeedsAnswer, NeedsEvaluation, Recommendation, evaluateNeeds, recommendProducts } from './needs.js';
import { AllocationPlan, BeneficiaryInput, BeneficiarySet, FundOption, RiskGrade, allocateInvestment, allocationProgress, validateBeneficiaries } from './allocation.js';
import { LoadingBreakdown, MedicalRequirementSet, RiderPricing, RiderSelection, loadingBreakdown, medicalRequirements, priceRiders } from './loadings.js';

import { DecisionOutcome, OccupationClass, ProductRules } from './underwriting.js';
import { PaymentMethod, Reconciliation } from './payments.js';
import { RoutingDecision, RoutingLimits, UnderwritingQueue } from './uwroute.js';
import type { PartnerScope } from './partner-portal.js';

export class JourneyError extends Error {}

export type JourneyStageId =
  | 'identity' | 'profile' | 'needs' | 'recommendation' | 'coverage' | 'loadings' | 'riders'
  | 'medical' | 'funds' | 'beneficiaries' | 'uw-review' | 'quotation' | 'finalisation'
  | 'payment' | 'routing' | 'conversion' | 'allocation' | 'investment' | 'servicing';

export type StageOwner = 'customer' | 'agent' | 'underwriter' | 'cashier' | 'back-office' | 'system';
export type FieldKind = 'text' | 'select' | 'date' | 'amount' | 'number' | 'percent' | 'boolean' | 'list' | 'signature' | 'questionnaire' | 'readonly';

export type Answers = Record<string, unknown>;

export interface StageFieldSpec {
  readonly id: string;
  readonly label: string;
  readonly kind: FieldKind;
  readonly mandatory: boolean;
  readonly editable: boolean;
  readonly options?: readonly string[];
  readonly hint?: string;
  readonly group?: string;
  /** A field that is only mandatory in some circumstances — the condition is part of the contract. */
  readonly mandatoryWhen?: (answers: Answers) => boolean;
}

export interface StageSpec {
  readonly id: JourneyStageId;
  readonly order: number;
  readonly title: string;
  readonly shortTitle: string;
  readonly purpose: string;
  readonly regulatoryBasis: string;
  readonly owner: StageOwner;
  readonly fields: readonly StageFieldSpec[];
  readonly produces: readonly string[];
  readonly detailTab: string;          // the console tab that shows this stage in full
}

const f = (id: string, label: string, kind: FieldKind, mandatory = true, extra: Partial<StageFieldSpec> = {}): StageFieldSpec =>
  ({ id, label, kind, mandatory, editable: kind !== 'readonly', ...extra });

/* ------------------------------------------------------------------ the catalogue */

export const JOURNEY_STAGES: readonly StageSpec[] = [
  {
    id: 'identity', order: 1, title: 'Customer onboarding & identity verification', shortTitle: 'Onboarding',
    purpose: 'Create the golden record from a verified identity document, in both languages, with the customer’s consent to process their data.',
    regulatoryBasis: 'KYC / CBUAE customer identification: a verified identity document and a recorded consent before any sale.',
    owner: 'agent', detailTab: 'parties', produces: ['Customer golden record (party id)', 'Identity document with verification source', 'Consent record'],
    fields: [
      f('kind', 'Customer kind', 'select', true, { options: ['person', 'organisation'], group: 'Who' }),
      f('nameEn', 'Name (English)', 'text', true, { group: 'Who' }),
      f('nameAr', 'Name (Arabic)', 'text', false, { group: 'Who', hint: 'Mandatory for a UAE golden record — the register is bilingual.' }),
      f('dateOfBirth', 'Date of birth / incorporation', 'date', true, { group: 'Who' }),
      f('idType', 'Identity document type', 'select', true, { options: ['emirates-id', 'passport', 'national-id', 'iqama', 'driving-licence', 'trade-licence'], group: 'Identity' }),
      f('idNumber', 'Identity document number', 'text', true, { group: 'Identity' }),
      f('idSource', 'Verification source', 'select', true, { options: ['chip', 'government-lookup', 'ocr', 'manual'], group: 'Identity' }),
      f('manualReason', 'Why the document was keyed manually', 'text', false, { group: 'Identity', mandatoryWhen: (a) => String(a['idSource'] ?? '') === 'manual', hint: 'Manual entry without a chip or government read needs a reason on file.' }),
      f('phone', 'Phone', 'text', true, { group: 'Contact' }),
      f('email', 'Email', 'text', true, { group: 'Contact' }),
      f('addressLine', 'Address', 'text', true, { group: 'Contact' }),
      f('city', 'City', 'text', true, { group: 'Contact' }),
      f('country', 'Country', 'select', true, { options: ['AE', 'MY', 'SA', 'OTHER'], group: 'Contact' }),
      f('consentTo', 'Consent granted to (partner / channel)', 'text', true, { group: 'Consent' }),
    ],
  },
  {
    id: 'profile', order: 2, title: 'Customer 360 profile, consent & duplicate check', shortTitle: 'Customer',
    purpose: 'Confirm the contact details, capture the consent scopes actually needed, check the register for a duplicate of this human being, and record tax residence.',
    regulatoryBasis: 'Data-protection and FATCA/CRS: purpose-limited consent, in-country residency of customer data, and tax residence on file.',
    owner: 'agent', detailTab: 'parties', produces: ['Consent scopes granted', 'Duplicate check result', 'Tax residence record'],
    fields: [
      f('contactConfirmed', 'Contact details confirmed with the customer', 'boolean', true),
      f('duplicateChecked', 'Register searched for a duplicate customer', 'boolean', true),
      f('duplicateResolution', 'What the possible duplicate turned out to be', 'select', false, {
        options: ['distinct-person', 'merged-into-existing'],
        mandatoryWhen: (a) => Number(a['__duplicateMatches'] ?? 0) > 0,
        hint: 'A match has to be resolved, not ignored: either two different people, or one record merged into the other.',
      }),
      f('duplicateNote', 'Why the match is not the same customer', 'text', false, { mandatoryWhen: (a) => Number(a['__duplicateMatches'] ?? 0) > 0 }),
      f('consentScopes', 'Consent scopes granted', 'list', true, { hint: 'e.g. customer.exists, customer.name, customer.contact, customer.holdings, marketing' }),
      f('dataResidency', 'Where this customer’s data is processed', 'select', true, { options: ['in-country', 'approved-transfer-framework'] }),
      f('taxResidence', 'Tax residence', 'text', true),
      f('taxId', 'Tax identification number', 'text', true),
      f('preferedChannel', 'Preferred service channel', 'select', false, { options: ['portal', 'email', 'phone', 'branch'] }),
    ],
  },
  {
    id: 'needs', order: 3, title: 'Needs-analysis questionnaire', shortTitle: 'Needs analysis',
    purpose: 'Ask the questions the country’s pack requires, and derive the protection gap and the premium the customer can actually afford.',
    regulatoryBasis: 'AE and MY packs: no life, medical, unit-linked or travel sale before a documented needs analysis with an identifier.',
    owner: 'customer', detailTab: 'regulatory', produces: ['Need analysis record with identifier', 'Protection gap and affordability ceiling', 'Customer attestation'],
    fields: [
      f('country', 'Country whose pack governs this sale', 'select', true, { options: ['AE', 'MY'] }),
      f('answers', 'Questionnaire answers', 'questionnaire', true, { hint: 'Every mandatory question must be answered before a product may be recommended.' }),
      f('attestationAgreed', 'Customer agrees to the needs-analysis attestation', 'boolean', true),
    ],
  },
  {
    id: 'recommendation', order: 4, title: 'Product / item recommendation list', shortTitle: 'Recommendation',
    purpose: 'Rank the catalogue against the evaluated need, show the customer the alternatives on the same axes, and record which product they chose.',
    regulatoryBasis: 'Suitability and comparison disclosure: the recommendation must answer the stated objective and the alternatives must be presented.',
    owner: 'agent', detailTab: 'regulatory', produces: ['Ranked recommendation list', 'Comparison presented to the customer', 'Chosen product'],
    fields: [
      f('productId', 'Product selected from the recommendation list', 'select', true),
      f('alternativesPresented', 'Alternative products were presented and discussed', 'boolean', true),
      f('customerAccepted', 'Customer accepts the recommendation', 'boolean', true),
      f('recommendationNote', 'Why this product answers the need', 'text', true),
    ],
  },
  {
    id: 'coverage', order: 5, title: 'Coverage & premium calculation', shortTitle: 'Coverage & premium',
    purpose: 'Set the sum assured, term and payment frequency, price the standard premium from the rate table, and test it against what the customer can afford.',
    regulatoryBasis: 'Illustration rules and financial underwriting: the sum assured is capped by income, and the premium must sit inside the affordability ceiling.',
    owner: 'agent', detailTab: 'underwriting', produces: ['Underwriting application', 'Standard premium from the rate table', 'Affordability test'],
    fields: [
      f('sumAssured', 'Sum assured', 'amount', true),
      f('termYears', 'Term (years)', 'number', true),
      f('paymentFrequency', 'Payment frequency', 'select', true, { options: ['monthly', 'quarterly', 'semi-annual', 'annual', 'single'] }),
      // The payment terms the customer selects: how many years they pay for, which is not always
      // how long they are covered for. Blank means "for the whole term".
      f('premiumPayingTermYears', 'Premium paying term (years)', 'number', false, { hint: 'how many years the customer pays for; blank = for the whole benefit term' }),
      // The illustration rates are filed per product, per omni-channel and per sub-channel, so the
      // case has to say which door it came through before the rates can be resolved.
      f('channelCode', 'Sold through (omni-channel)', 'select', false, { options: [], hint: 'blank = the product master’s own rates' }),
      f('subChannelCode', 'Sub-channel', 'select', false, { options: [], hint: 'blank = inherit from the omni-channel' }),
      f('annualIncome', 'Gross annual income', 'amount', true),
      f('age', 'Entry age', 'number', true),
      f('sex', 'Sex', 'select', true, { options: ['male', 'female'] }),
      f('smoker', 'Smoker', 'boolean', true),
      f('heightCm', 'Height (cm)', 'number', true),
      f('weightKg', 'Weight (kg)', 'number', true),
      f('residenceCountry', 'Residence country', 'text', true),
    ],
  },
  {
    id: 'loadings', order: 6, title: 'Occupational & medical loadings', shortTitle: 'Loadings',
    purpose: 'Apply the occupational debit and every medical, build, pursuit and family-history loading from the manual, itemised in basis points and money.',
    regulatoryBasis: 'Underwriting manual: a loaded premium must be itemised, and any loading given away must carry a named authoriser.',
    owner: 'underwriter', detailTab: 'underwriting', produces: ['Itemised loading breakdown', 'Exclusions', 'Evidence list'],
    fields: [
      f('occupationClass', 'Occupation class', 'select', true, { options: ['1', '2', '3', '4', '5'] }),
      f('occupationTitle', 'Occupation and duties', 'text', true),
      f('conditions', 'Declared medical conditions', 'list', false, { hint: 'Codes from the medical manual, e.g. diabetes-type-2, hypertension-controlled' }),
      f('pursuits', 'Hazardous pursuits', 'list', false, { hint: 'e.g. scuba-diving, motor-racing, mountaineering-above-6000m' }),
      f('familyHistory', 'Family history', 'list', false, { hint: 'e.g. early-cardiac-death, early-cancer-death' }),
      f('loadingReviewedBy', 'Loading reviewed by', 'signature', true),
      f('loadingAcknowledged', 'Customer told about the loading and the exclusions', 'boolean', true),
    ],
  },
  {
    id: 'riders', order: 7, title: 'Additional riders (with or without loading)', shortTitle: 'Riders',
    purpose: 'Attach the riders the need calls for, price each one, and record the authority for any rider attached without its loading.',
    regulatoryBasis: 'Product terms and underwriting authority: a waiver of loading is a decision with a name against it.',
    owner: 'underwriter', detailTab: 'underwriting', produces: ['Rider schedule with prices', 'Waivers of loading, authorised', 'Rider evidence requirements'],
    fields: [
      f('ridersConsidered', 'Riders considered with the customer', 'boolean', true, { hint: 'Recording "none needed" is a decision; leaving the section blank is not.' }),
      f('riders', 'Riders attached', 'list', false, { hint: 'Codes from the rider catalogue; leave empty if the base cover is enough' }),
      f('withoutLoading', 'Riders attached without loading', 'list', false),
      f('waiverBy', 'Waiver authorised by', 'signature', false, { mandatoryWhen: (a) => asList(a['withoutLoading']).length > 0 }),
      f('waiverReason', 'Reason the loading was waived', 'text', false, { mandatoryWhen: (a) => asList(a['withoutLoading']).length > 0 }),
      f('ridersAcknowledged', 'Customer accepts the rider terms and their cost', 'boolean', false, { mandatoryWhen: (a) => asList(a['riders']).length > 0 }),
    ],
  },
  {
    id: 'medical', order: 8, title: 'Medical requirements', shortTitle: 'Medical requirements',
    purpose: 'Work out what this risk has to prove, order it, receive it, and have a human review it — or record a named waiver.',
    regulatoryBasis: 'Evidence bands in the product manual: no acceptance without the evidence the band requires, unless a person waives it in writing.',
    owner: 'underwriter', detailTab: 'underwriting', produces: ['Medical requirement checklist', 'Results received and reviewed', 'Waivers with authority'],
    fields: [
      f('requirementsOrdered', 'Requirements ordered from the customer / clinic', 'boolean', false, { mandatoryWhen: (a) => a['__requirementsIssued'] === true }),
      f('results', 'Results received', 'list', false, { hint: 'One entry per requirement: label, status (ordered/received/reviewed/waived), date, reviewer' }),
      f('reviewedBy', 'Evidence reviewed by', 'signature', false, { mandatoryWhen: (a) => a['__requirementsIssued'] === true }),
      f('reviewNote', 'What the reviewer relied on', 'text', false, { mandatoryWhen: (a) => a['__requirementsIssued'] === true }),
    ],
  },
  {
    id: 'funds', order: 9, title: 'Fund investment selection & allocation', shortTitle: 'Funds & allocation',
    purpose: 'Choose the funds and their weights from the live NAV list, split the first contribution exactly, and test the mix against the customer’s risk appetite.',
    regulatoryBasis: 'Unit-linked disclosure: the allocation the customer signs is the allocation that is invested, and a Shariah arrangement may only hold screened funds.',
    owner: 'customer', detailTab: 'funds', produces: ['Signed target weights', 'First-contribution split by fund', 'Units to be allocated at the next valuation'],
    fields: [
      f('weights', 'Fund weights', 'list', true, { hint: 'Fund id and percentage; the weights must total exactly 100%' }),
      f('appetiteAcknowledged', 'Customer acknowledges where the mix sits against their stated appetite', 'boolean', true),
      f('dealingAcknowledged', 'Customer told which valuation date the units will be bought at', 'boolean', true),
    ],
  },
  {
    id: 'beneficiaries', order: 10, title: 'Beneficiary details', shortTitle: 'Beneficiaries',
    purpose: 'Record who receives the proceeds and in what shares, with a guardian for any minor, and confirm the designation with the customer.',
    regulatoryBasis: 'Policy terms: primary shares must total 100%, and a claim to a minor without a guardian cannot be settled.',
    owner: 'customer', detailTab: 'policyholder', produces: ['Beneficiary schedule', 'Share allocation', 'Customer confirmation'],
    fields: [
      f('beneficiaries', 'Beneficiaries and shares', 'list', true, { hint: 'Name, relationship, share %, primary or contingent, date of birth, guardian for a minor' }),
      f('customerConfirmed', 'Customer confirms the designation', 'boolean', true),
    ],
  },
  {
    id: 'uw-review', order: 11, title: 'Underwriting & medical questionnaire review', shortTitle: 'Underwriting review',
    purpose: 'Review and update the medical questionnaire against the evidence on file, then take the underwriting decision under the right authority.',
    regulatoryBasis: 'Authority matrix: an AI agent may accept or rate inside its limit and may never decline; declines and over-limit cases go to a named human.',
    owner: 'underwriter', detailTab: 'underwriting', produces: ['Underwriting decision', 'Waived referral points, named', 'Updated questionnaire'],
    fields: [
      f('questionnaireReviewed', 'Medical questionnaire reviewed against the evidence', 'boolean', true),
      f('questionnaireUpdatedBy', 'Reviewed / updated by', 'signature', true),
      f('questionnaireNotes', 'What changed and why', 'text', true),
      f('decisionOutcome', 'Decision', 'select', true, { options: ['standard', 'rated', 'excluded', 'postponed', 'declined', 'referred'] }),
      f('decidedBy', 'Decided by', 'signature', true),
      f('decidedByAi', 'Decision taken by an AI agent inside its straight-through limit', 'boolean', true),
      f('acceptedReferrals', 'Referral points explicitly accepted', 'list', false),
    ],
  },
  {
    id: 'quotation', order: 12, title: 'Quotation generation (PDF) & email to customer', shortTitle: 'Quotation',
    purpose: 'Assemble the quotation document with its itemised loadings, riders, allocation and mandated wording, write it as a PDF, and send it to the customer.',
    regulatoryBasis: 'Disclosure: the customer must receive the terms, the illustration wording and the free-look period before paying.',
    owner: 'agent', detailTab: 'underwriting', produces: ['Versioned quotation PDF with fingerprint', 'Email dispatch record', 'Validity window'],
    fields: [
      f('issue', 'Generate the quotation document', 'boolean', true),
      f('emailTo', 'Send the quotation to', 'text', true),
      f('emailLanguage', 'Email language', 'select', true, { options: ['both', 'en', 'ar'] }),
      f('sendEmail', 'Email the PDF to the customer', 'boolean', true),
      f('buyLinkSent', 'Secure buy-online link included', 'boolean', true),
    ],
  },
  {
    id: 'finalisation', order: 13, title: 'Customer review, cooling-off & sign-off', shortTitle: 'Finalisation',
    purpose: 'Give the customer the free-look position in writing, take their signature inside the validity window, and hand the case to buy-online.',
    regulatoryBasis: 'Free-look: the cooling-off period must be disclosed and the acceptance must fall inside the quotation’s validity.',
    owner: 'customer', detailTab: 'underwriting', produces: ['Customer signature and reference', 'Cooling-off statement', 'Buy-online token'],
    fields: [
      f('coolingOffAcknowledged', 'Customer acknowledges the free-look period', 'boolean', true),
      f('reviewedWithCustomer', 'Terms reviewed with the customer', 'boolean', true),
      f('signedBy', 'Signed by', 'signature', true),
      f('signedAt', 'Signed on', 'date', true),
    ],
  },
  {
    id: 'payment', order: 14, title: 'Buy online — payment options & capture', shortTitle: 'Payment',
    purpose: 'Take the first payment by whichever of the six methods the customer chooses, prove it, and reconcile it against the amount due.',
    regulatoryBasis: 'Money-in controls: no policy is issued on an uncleared transfer, card data is never stored, and a BNPL provider fee is disclosed.',
    owner: 'cashier', detailTab: 'policyholder', produces: ['Payment record with proof', 'Handling cost and net to insurer', 'Reconciliation against the amount due'],
    fields: [
      f('method', 'Payment method', 'select', true, { options: ['cash', 'credit-card', 'debit-card', 'bank-transfer', 'bnpl', 'branch-deposit'] }),
      f('amount', 'Amount paid', 'amount', true),
      f('pan', 'Card number', 'text', false, { mandatoryWhen: (a) => isCard(a['method']), hint: 'Validated and reduced to its last four digits; never stored.' }),
      f('expiry', 'Card expiry (MM/YY)', 'text', false, { mandatoryWhen: (a) => isCard(a['method']) }),
      f('authentication', 'Card authentication', 'select', false, { options: ['sca-3ds', 'contactless', 'none'], mandatoryWhen: (a) => isCard(a['method']) }),
      f('iban', 'IBAN', 'text', false, { mandatoryWhen: (a) => a['method'] === 'bank-transfer' }),
      f('bankName', 'Bank', 'text', false, { mandatoryWhen: (a) => a['method'] === 'bank-transfer' }),
      f('depositSlip', 'Deposit slip number', 'text', false, { mandatoryWhen: (a) => a['method'] === 'branch-deposit' }),
      f('branch', 'Branch', 'text', false, { mandatoryWhen: (a) => a['method'] === 'branch-deposit' || a['method'] === 'cash' }),
      f('bnplProvider', 'BNPL provider', 'select', false, { options: ['tabby', 'tamara', 'postpay'], mandatoryWhen: (a) => a['method'] === 'bnpl' }),
      f('bnplInstalments', 'Instalments', 'select', false, { options: ['3', '4', '6'], mandatoryWhen: (a) => a['method'] === 'bnpl' }),
    ],
  },
  {
    id: 'routing', order: 15, title: 'Underwriting route & binding authority', shortTitle: 'UW route',
    purpose: 'Decide who binds the risk: straight through, an in-house underwriter, a senior signature, a freelance underwriter hired to meet the promise, or the reinsurer’s underwriter first.',
    regulatoryBasis: 'Binding authority and reinsurance: a case at or above the facultative threshold is offered to the reinsurer before issue, not after.',
    owner: 'underwriter', detailTab: 'underwriting', produces: ['Routing decision with reasons', 'Freelance engagement and cost', 'Reinsurance assist request and answer'],
    fields: [
      f('routeConfirmed', 'Route accepted', 'boolean', true),
      f('confirmedBy', 'Confirmed by', 'signature', true),
      f('engageFreelance', 'Freelance underwriter engaged for this case', 'boolean', false, { mandatoryWhen: (a) => a['__freelanceOffered'] === true }),
      f('freelanceAcceptedBy', 'Engagement authorised by', 'signature', false, { mandatoryWhen: (a) => a['engageFreelance'] === true }),
      f('reinsuranceAssist', 'Reinsurer’s underwriter asked before issue', 'boolean', false, { mandatoryWhen: (a) => a['__reinsuranceAssist'] === true }),
      f('treatyId', 'Treaty the risk is offered under', 'text', false, { mandatoryWhen: (a) => a['reinsuranceAssist'] === true }),
      f('reinsuranceAnswer', 'Reinsurer’s answer', 'select', false, { options: ['accept', 'accept-with-conditions', 'decline', 'awaiting'], mandatoryWhen: (a) => a['reinsuranceAssist'] === true }),
      f('seniorSignOff', 'Senior underwriter sign-off', 'signature', false, { mandatoryWhen: (a) => a['__needsSenior'] === true }),
    ],
  },
  {
    id: 'conversion', order: 16, title: 'Policy conversion & issuance', shortTitle: 'Conversion',
    purpose: 'Turn the decided proposal into a policy, receipt the first payment into the chosen funds, and allocate the units at the published valuation.',
    regulatoryBasis: 'Issue controls: a policy may only be created on an accepted decision with cleared money and a signed allocation.',
    owner: 'back-office', detailTab: 'policyholder', produces: ['Policy number', 'First premium receipt and journal', 'Units allocated at the dealing valuation'],
    fields: [
      f('convert', 'Convert the proposal into a policy', 'boolean', true),
      f('convertedBy', 'Converted by', 'signature', true),
      f('commencement', 'Commencement date', 'date', true),
      f('initialFundId', 'Fund the first contribution is invested in', 'select', true),
    ],
  },
  {
    id: 'allocation', order: 17, title: 'Funds allocation & management in force', shortTitle: 'Allocation management',
    purpose: 'Keep the invested mix where the customer signed it: measure drift against the target weights, and rebalance, switch or top up when it moves.',
    regulatoryBasis: 'Stewardship and dealing rules: changes are priced at the published valuation on the dealing day the instruction falls in.',
    owner: 'back-office', detailTab: 'policyholder', produces: ['Drift report against signed targets', 'Rebalance, switch or top-up instruction', 'Dealing valuation used'],
    fields: [
      f('allocationReviewed', 'Allocation reviewed against the signed targets', 'boolean', true),
      f('reviewedBy', 'Reviewed by', 'signature', true),
      f('reviewedAt', 'Reviewed on', 'date', true),
      f('rebalanceRequested', 'Rebalance or switch requested', 'boolean', true),
      f('rebalanceNote', 'What was done, or why nothing was needed', 'text', true),
    ],
  },
  {
    id: 'investment', order: 18, title: 'Investment allocations & progress', shortTitle: 'Investment progress',
    purpose: 'Show the customer what their money did: contributions, current value, gain or loss, drift, and the date of the next review.',
    regulatoryBasis: 'Illustration honesty: progress is measured at published valuations with the disclaimer that values may fall as well as rise.',
    owner: 'customer', detailTab: 'policyholder', produces: ['Progress statement', 'Gain or loss against contributions', 'Next review date'],
    fields: [
      f('progressReviewed', 'Progress reviewed with the customer', 'boolean', true),
      f('statementSent', 'Progress statement sent', 'boolean', true),
      f('reviewedBy', 'Prepared by', 'signature', true),
    ],
  },
  {
    id: 'servicing', order: 19, title: 'Servicing: alterations & claims', shortTitle: 'Servicing',
    purpose: 'Hand the policy to servicing: what may be altered without a financial review, what needs one, and how a claim is registered and decided.',
    regulatoryBasis: 'Policy administration: every alteration and claim decision is auditable, with the reason and the authority recorded.',
    owner: 'back-office', detailTab: 'claims', produces: ['Servicing handover', 'Alteration routes', 'Claim registration route'],
    fields: [
      f('handoverAcknowledged', 'Servicing handover acknowledged', 'boolean', true),
      f('serviceChannel', 'Service channel agreed with the customer', 'select', true, { options: ['portal', 'email', 'phone', 'branch', 'broker'] }),
      f('handoverBy', 'Handed over by', 'signature', true),
    ],
  },
];

export const STAGE_BY_ID: ReadonlyMap<JourneyStageId, StageSpec> = new Map(JOURNEY_STAGES.map((s) => [s.id, s]));

export function stageSpec(id: JourneyStageId): StageSpec {
  const spec = STAGE_BY_ID.get(id);
  if (!spec) throw new JourneyError(`unknown journey stage "${id}"`);
  return spec;
}

/* ------------------------------------------------------------------ the case */

export type JourneyStatus = 'draft' | 'in-progress' | 'quoted' | 'awaiting-payment' | 'bound' | 'in-force' | 'servicing' | 'declined' | 'abandoned';

export interface JourneyArtefacts {
  readonly partyId?: string;
  readonly consentId?: string;
  readonly needId?: string;
  readonly applicationId?: string;
  readonly quotationId?: string;
  readonly quotationVersion?: number;
  readonly emailMessageId?: string;
  readonly buyToken?: string;
  readonly paymentId?: string;
  readonly routeId?: string;
  readonly engagementId?: string;
  readonly reinsuranceRequestId?: string;
  readonly policyId?: string;
  readonly receiptId?: string;
}

export interface JourneyLogEntry {
  readonly at: string;
  readonly by: string;
  readonly stageId: JourneyStageId;
  readonly action: 'saved' | 'submitted' | 'refused' | 'reopened' | 'abandoned';
  readonly detail: string;
  readonly completeAfter: boolean;
}

/**
 * What the gates computed on the last pass: the needs evaluation, the loading breakdown, the rider
 * pricing, the medical checklist, the allocation plan and the beneficiary set. Later sections read
 * these instead of recomputing them, so one journey cannot disagree with itself between sections.
 */
export interface JourneyComputed {
  __needsEvaluation?: NeedsEvaluation;
  __loadingBreakdown?: LoadingBreakdown | null;
  __riderSelections?: RiderSelection[];
  __riderPricing?: RiderPricing | null;
  __medicalRequirements?: MedicalRequirementSet;
  __requirementsIssued?: boolean;
  __allocationPlan?: AllocationPlan | null;
  __beneficiaries?: BeneficiarySet;
  __routingFlags?: Answers;
  __allocationProgress?: Record<string, unknown>;
  [key: string]: unknown;
}

export interface JourneyCase {
  readonly caseId: string;
  readonly openedAt: string;
  readonly openedBy: string;
  /** Distribution attribution is set before routing and cannot be silently changed. */
  distribution?: PartnerScope;
  /** Mutable: the golden record names the journey, and the name arrives in the first section. */
  customerName: string;
  readonly currency: string;
  country: string;
  status: JourneyStatus;
  answers: Record<JourneyStageId, Answers>;
  /**
   * The sections that have been *submitted*, not merely typed into. A section is complete when its
   * gate passes and it has been committed: a draft saved by an operator who then walks away is not a
   * completed step, and the console must not tick it or open the one behind it.
   */
  submitted: JourneyStageId[];
  artefacts: JourneyArtefacts;
  readonly log: JourneyLogEntry[];
  /** Values the machine computed and the field conditions need (never edited by a form). */
  computed: JourneyComputed;
}

/**
 * What master settings may say about a field: whether the operator must fill it in, whether they may
 * edit it, and **what it is called**. The rename is a filed setting like the other two, so a tenant
 * that says "Contribution" rather than "Premium" says it on the form, in the missing-field checklist
 * and in the refusal message that names the field — three places that used to be able to disagree.
 */
export type JourneyFieldSettings = Readonly<Record<string, Readonly<Record<string, { mandatory: boolean; editable: boolean; label?: string }>>>>;

/** The label a field shows, taking master settings into account. */
export function fieldLabel(stageId: string, field: { id: string; label: string }, settings?: JourneyFieldSettings): string {
  const renamed = settings?.[stageId]?.[field.id]?.label;
  return renamed && renamed.trim() !== '' ? renamed : field.label;
}

export interface JourneyContext {
  readonly fieldSettings?: JourneyFieldSettings;
  readonly asOf: string;
  readonly currency: string;
  readonly tenantName: string;
  readonly pack: string;
  readonly packCountry: string;
  readonly coolingOffDays: number;
  readonly illustrationWording: string;
  readonly products: ReadonlyArray<ProductCandidate & { rules: ProductRules }>;
  readonly funds: readonly FundOption[];
  readonly limits: RoutingLimits;
  readonly queue: UnderwritingQueue;
  readonly offers: ReadonlyArray<{ insurer: string; product: string; premium: number; excess: number; benefits: string[]; serviceRating: number; complaintsPer10k: number }>;
  /** Facts the machine cannot compute for itself, supplied by the desk from the engines. */
  readonly application?: { readonly sumAssured: Money; readonly standardPremium: Money; readonly loadedPremium: Money; readonly extraMortalityBps: number; readonly outcome: DecisionOutcome; readonly referrals: readonly string[]; readonly exclusions: readonly string[]; readonly evidence: readonly string[]; readonly decidedBy: string; readonly decidedByAi: boolean } | null;
  readonly decision?: { readonly outcome: DecisionOutcome; readonly decidedBy: string; readonly decidedByAi: boolean; readonly extraMortalityBps: number; readonly loadedPremium: Money } | null;
  readonly routing?: RoutingDecision | null;
  readonly partnerRoutingBlocker?: string | null;
  readonly partnerConversionBlocker?: string | null;
  readonly payment?: Reconciliation | null;
  readonly quotation?: { readonly quotationId: string; readonly version: number; readonly status: string; readonly totalPayable: Money; readonly expiresAt: string; readonly dispatched: boolean; readonly finalised: boolean; readonly blockers: readonly string[] } | null;
  readonly policy?: { readonly policyId: string; readonly status: string; readonly contributionsToDate: Money; readonly commencement: string; readonly currentValue: Money; readonly holdings: ReadonlyArray<{ fundId: string; fundName: string; units: string; price: string; value: Money; priceAsOf: string }>; readonly targetWeights: ReadonlyArray<{ fundId: string; weightBps: number }> } | null;
  readonly servicing?: { readonly alterations: number; readonly openClaims: number; readonly settledClaims: number } | null;
}

/* ------------------------------------------------------------------ small helpers the gates share */

export function asList(value: unknown): string[] {
  if (Array.isArray(value)) return value.map((v) => (typeof v === 'string' ? v : JSON.stringify(v))).map((s) => s.trim()).filter(Boolean);
  if (typeof value === 'string') return value.split(',').map((s) => s.trim()).filter(Boolean);
  return [];
}

function isCard(method: unknown): boolean { return method === 'credit-card' || method === 'debit-card'; }

function filled(value: unknown, kind: FieldKind): boolean {
  if (value === undefined || value === null) return false;
  switch (kind) {
    case 'boolean': return value === true || value === false;
    case 'list': return Array.isArray(value) ? value.length > 0 : asList(value).length > 0;
    case 'number': case 'percent': return typeof value === 'number' ? Number.isFinite(value) : value !== '' && Number.isFinite(Number(String(value).replace(/,/g, '')));
    case 'amount': {
      // An amount is filled only when it parses and is positive: "0" on a payment is not a payment.
      const raw = typeof value === 'number' ? String(value) : String(value).trim().replace(/,/g, '').replace(/[A-Za-z]{3}$/, '').trim();
      if (raw === '') return false;
      const parsed = Number(raw);
      return Number.isFinite(parsed) && parsed > 0;
    }
    case 'signature': return String(value).trim().length >= 3;
    case 'questionnaire': return Array.isArray(value) ? value.length > 0 : Boolean(value);
    case 'readonly': return true;
    default: return String(value).trim() !== '';
  }
}

export function fieldGaps(stage: StageSpec, answers: Answers, settings?: JourneyFieldSettings): { missing: string[]; answered: number; total: number } {
  const missing: string[] = [];
  let answered = 0;
  let total = 0;
  for (const field of stage.fields) {
    const override = settings?.[stage.id]?.[field.id];
    // Conditional/legal requirements remain hard gates; master settings can relax only the ordinary required flag.
    const required = Boolean(field.mandatoryWhen?.(answers)) || (override?.mandatory ?? field.mandatory);
    if (!required) continue;
    total += 1;
    // The checklist names the field the way the tenant named it, so an operator looking for
    // "Contribution" is not told that "Premium" is missing.
    if (filled(answers[field.id], field.kind)) answered += 1;
    else missing.push(fieldLabel(stage.id, field, settings));
  }
  return { missing, answered, total };
}

export function amount(value: unknown, currency: string, fallback = 0n): Money {
  if (value === undefined || value === null || value === '') return money(fallback, currency);
  try {
    return parseAmount(String(value), currency);
  } catch {
    return money(fallback, currency);
  }
}

/* ------------------------------------------------------------------ stage review */

export interface SummaryRow { readonly label: string; readonly value: string; readonly tone?: 'ok' | 'warn' | 'bad' | 'info' }

export interface StageReview {
  readonly percent: number;
  readonly complete: boolean;
  readonly missing: readonly string[];
  readonly blockers: readonly string[];
  readonly warnings: readonly string[];
  readonly summary: readonly SummaryRow[];
  readonly artefacts: readonly string[];
}

export type StageStatus = 'locked' | 'ready' | 'in-progress' | 'complete' | 'blocked';

export interface StageState extends StageReview {
  readonly id: JourneyStageId;
  readonly order: number;
  readonly title: string;
  readonly shortTitle: string;
  readonly purpose: string;
  readonly regulatoryBasis: string;
  readonly owner: StageOwner;
  readonly detailTab: string;
  readonly fields: readonly StageFieldSpec[];
  readonly produces: readonly string[];
  readonly status: StageStatus;
  readonly submitted: boolean;
  readonly lockedBy: JourneyStageId | null;
  readonly lockedByTitle: string | null;
  /** What the console should do with this section: open it, and only it. */
  readonly autoOpen: boolean;
  readonly answers: Answers;
}

export interface JourneyProgress {
  readonly caseId: string;
  readonly customerName: string;
  readonly status: JourneyStatus;
  readonly stages: readonly StageState[];
  readonly completeStages: number;
  readonly totalStages: number;
  readonly percent: number;
  readonly nextRecommended: JourneyStageId | null;
  readonly nextRecommendedTitle: string | null;
  readonly headline: string;
  readonly blockers: readonly string[];
  readonly artefacts: JourneyArtefacts;
  readonly log: readonly JourneyLogEntry[];
}

const reviewers: Record<JourneyStageId, (c: JourneyCase, ctx: JourneyContext) => StageReview> = {
  identity: (c, ctx) => {
    const a = c.answers['identity'];
    const gaps = fieldGaps(stageSpec('identity'), a, ctx.fieldSettings);
    const blockers: string[] = [];
    const country = String(a['country'] ?? c.country ?? 'AE').toUpperCase();
    if (country === 'AE' && !String(a['nameAr'] ?? '').trim()) {
      blockers.push('A UAE golden record needs the customer’s name in Arabic as well as English');
    }
    if (String(a['idSource'] ?? '') === 'manual' && String(a['manualReason'] ?? '').trim().length < 12) {
      blockers.push('A manually keyed identity document needs a reason of at least 12 characters — the verification source is what the record is trusted on');
    }
    const email = String(a['email'] ?? '');
    if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) blockers.push(`"${email}" is not a deliverable email address; the quotation has to reach the customer`);
    const warnings: string[] = [];
    if (String(a['idSource'] ?? '') === 'ocr') warnings.push('OCR fields below the consensus threshold land in the review queue before the record is accepted');
    const summary: SummaryRow[] = [
      { label: 'Customer', value: String(a['nameEn'] ?? '—') },
      { label: 'Identity', value: `${a['idType'] ?? '—'} ${a['idNumber'] ?? ''}`.trim() },
      { label: 'Verification', value: String(a['idSource'] ?? '—') },
      { label: 'Golden record', value: c.artefacts.partyId ?? 'not created yet', tone: c.artefacts.partyId ? 'ok' : 'warn' },
    ];
    return finish(gaps, blockers, warnings, summary, ['Customer golden record (party id)']);
  },

  profile: (c, ctx) => {
    const a = c.answers['profile'];
    const gaps = fieldGaps(stageSpec('profile'), { ...a, __duplicateMatches: c.answers['profile']?.['__duplicateMatches'] ?? 0 }, ctx.fieldSettings);
    const blockers: string[] = [];
    const warnings: string[] = [];
    if (!c.artefacts.partyId) blockers.push('The golden record has not been created yet — submit the onboarding section first');
    const matches = Number(a['__duplicateMatches'] ?? 0);
    if (matches > 0) {
      const resolution = String(a['duplicateResolution'] ?? '');
      if (!resolution) {
        blockers.push(`${matches} possible duplicate(s) in the register: merge them into one golden record or record why they are two people`);
      } else if (resolution === 'merged-into-existing') {
        warnings.push('Recorded as merged into the existing golden record — run the merge in the Parties & consent tab so the audit trail carries it');
      } else {
        warnings.push(`${matches} match(es) reviewed and recorded as a different person: ${String(a['duplicateNote'] ?? '')}`);
      }
    }
    if (a['dataResidency'] === 'approved-transfer-framework' && !String(a['__transferBasis'] ?? '').trim()) {
      blockers.push(`${ctx.packCountry} data-residency rules need the approved transfer framework named before customer data leaves the country`);
    }
    const summary: SummaryRow[] = [
      { label: 'Party', value: c.artefacts.partyId ?? '—' },
      { label: 'Consent scopes', value: asList(a['consentScopes']).join(', ') || '—' },
      { label: 'Tax residence', value: `${a['taxResidence'] ?? '—'}${a['taxId'] ? ` (${a['taxId']})` : ''}` },
      { label: 'Data processed', value: String(a['dataResidency'] ?? '—') },
      { label: 'Duplicate search', value: matches > 0 ? `${matches} possible match(es) — ${String(a['duplicateResolution'] ?? 'unresolved')}` : 'no possible duplicate found', tone: matches > 0 && !a['duplicateResolution'] ? 'warn' : 'ok' },
    ];
    return finish(gaps, blockers, warnings, summary, ['Consent scopes granted', 'Duplicate check result', 'Tax residence record']);
  },

  needs: (c, ctx) => {
    const a = c.answers['needs'];
    const country = String(a['country'] ?? ctx.packCountry);
    const answers = (Array.isArray(a['answers']) ? a['answers'] : []) as NeedsAnswer[];
    const evaluation = evaluateNeeds({
      needId: c.artefacts.needId ?? `${c.caseId}-NEED`,
      country,
      answers,
      attestationAgreed: a['attestationAgreed'] === true,
    });
    c.computed['__needsEvaluation'] = evaluation;
    const gaps = fieldGaps(stageSpec('needs'), a, ctx.fieldSettings);
    const missing = [...new Set([...gaps.missing, ...evaluation.missing])];
    const total = gaps.total + Math.max(0, evaluation.missing.length);
    const answered = Math.max(0, total - missing.length);
    const percent = total === 0 ? 0 : Math.round((answered / total) * 100);
    const blockers = [...evaluation.blockers];
    if (evaluation.regulatory && !evaluation.regulatory.allowed) blockers.push(...evaluation.regulatory.blockers);
    const summary: SummaryRow[] = [
      { label: 'Need analysis', value: evaluation.needId, tone: evaluation.completed ? 'ok' : 'warn' },
      { label: 'Pack', value: evaluation.pack },
      { label: 'Questions answered', value: `${answered} of ${total} (${percent}%)` },
      { label: 'Suggested sum assured', value: evaluation.need.suggestedSumAssured ? formatAmount(evaluation.need.suggestedSumAssured) : '—' },
      { label: 'Affordability ceiling', value: evaluation.need.affordabilityCeiling ? formatAmount(evaluation.need.affordabilityCeiling) : '—' },
      { label: 'Pre-sale gate', value: evaluation.regulatory ? (evaluation.regulatory.allowed ? 'allowed' : 'blocked') : '—', tone: evaluation.regulatory?.allowed ? 'ok' : 'bad' },
    ];
    return {
      percent, complete: evaluation.completed && blockers.length === 0 && percent === 100,
      missing, blockers: [...new Set(blockers)], warnings: [], summary,
      artefacts: ['Need analysis record with identifier', 'Protection gap and affordability ceiling', 'Customer attestation'],
    };
  },

  recommendation: (c, ctx) => {
    const a = c.answers['recommendation'];
    const gaps = fieldGaps(stageSpec('recommendation'), a, ctx.fieldSettings);
    const evaluation = c.computed.__needsEvaluation ?? null;
    const blockers: string[] = [];
    const warnings: string[] = [];
    let ranked: Recommendation[] = [];
    if (evaluation) {
      ranked = recommendProducts({ evaluation, candidates: ctx.products });
      const chosen = String(a['productId'] ?? '');
      const picked = ranked.find((r) => r.productId === chosen);
      if (chosen && !picked) blockers.push(`"${chosen}" is not in the catalogue this tenant may sell`);
      else if (picked && !picked.fits) blockers.push(`${picked.name} does not fit the evaluated need: ${picked.disqualifiers.join('; ')}`);
      if (picked?.fits) warnings.push(...picked.reasons.map((r) => `Why it fits: ${r}`));
    } else {
      blockers.push('The needs analysis has not been evaluated yet — complete that section first');
    }
    if (String(a['recommendationNote'] ?? '').trim().length > 0 && String(a['recommendationNote'] ?? '').trim().length < 12) {
      blockers.push('The reason for the recommendation must be a sentence, not a word: it is what a suitability review reads');
    }
    const summary: SummaryRow[] = ranked.length === 0
      ? [{ label: 'Recommendation list', value: 'not ranked yet', tone: 'warn' }]
      : ranked.slice(0, 5).map((r) => ({
        label: `${r.fits ? '★' : '·'} ${r.name}`,
        value: `${r.scorePct}% fit · ${r.indicativePremiumLabel}${r.disqualifiers.length > 0 ? ` · ${r.disqualifiers[0]}` : ''}`,
        tone: (r.productId === String(a['productId'] ?? '') ? 'ok' : r.fits ? 'info' : 'warn') as SummaryRow['tone'],
      }));
    summary.push({ label: 'Chosen', value: String(a['productId'] ?? '—') });
    return finish(gaps, blockers, warnings, summary, ['Ranked recommendation list', 'Comparison presented to the customer', 'Chosen product']);
  },

  coverage: (c, ctx) => {
    const a = c.answers['coverage'];
    const gaps = fieldGaps(stageSpec('coverage'), a, ctx.fieldSettings);
    const blockers: string[] = [];
    const warnings: string[] = [];
    const productId = String(c.answers['recommendation']?.['productId'] ?? '');
    const product = ctx.products.find((p) => p.productId === productId);
    if (!product) {
      blockers.push('No product has been chosen in the recommendation section yet');
    }
    const sumAssured = amount(a['sumAssured'], ctx.currency);
    const income = amount(a['annualIncome'], ctx.currency);
    const age = Number(a['age'] ?? 0);
    if (product) {
      if (sumAssured.minor <= 0n) blockers.push('A sum assured of zero is not cover');
      if (age > 0 && (age < product.minAge || age > product.maxAge)) {
        blockers.push(`Entry age ${age} is outside ${product.name}’s range of ${product.minAge}–${product.maxAge}`);
      }
      if (income.minor > 0n && product.rules.incomeMultiple > 0) {
        const cap = money(income.minor * BigInt(product.rules.incomeMultiple), ctx.currency);
        if (compare(sumAssured, cap) > 0) {
          warnings.push(`Sum assured ${formatAmount(sumAssured)} is above the ${product.rules.incomeMultiple}× income cap of ${formatAmount(cap)} — financial underwriting will refer it`);
        }
      }
      const term = Number(a['termYears'] ?? 0);
      if (term <= 0) blockers.push('A term of zero years cannot be priced');
      if (age > 0 && term > 0 && age + term > 99) warnings.push(`The term runs to age ${age + term}; confirm the product allows cover that long`);
    }
    const evaluation = c.computed.__needsEvaluation;
    if (evaluation?.need.affordabilityCeiling && sumAssured.minor > 0n && product) {
      const standardPremium = money((sumAssured.minor * product.baseRatePerThousandMinor) / (1000n * 100n), ctx.currency);
      if (compare(standardPremium, evaluation.need.affordabilityCeiling) > 0) {
        blockers.push(`The standard premium of ${formatAmount(standardPremium)} is above the affordability ceiling of ${formatAmount(evaluation.need.affordabilityCeiling)} established in the needs analysis`);
      }
      if (evaluation.need.suggestedSumAssured && compare(sumAssured, evaluation.need.suggestedSumAssured) !== 0) {
        warnings.push(`The needs analysis suggested ${formatAmount(evaluation.need.suggestedSumAssured)}; ${formatAmount(sumAssured)} was chosen instead — record why`);
      }
    }
    const summary: SummaryRow[] = product ? [
      { label: 'Product', value: product.name },
      { label: 'Sum assured', value: formatAmount(sumAssured) },
      { label: 'Term', value: `${a['termYears'] ?? '—'} year(s), ${a['paymentFrequency'] ?? '—'}` },
      { label: 'Standard premium', value: formatAmount(money((sumAssured.minor * product.baseRatePerThousandMinor) / (1000n * 100n), ctx.currency)) },
      { label: 'Underwriting file', value: c.artefacts.applicationId ?? 'not opened yet', tone: c.artefacts.applicationId ? 'ok' : 'warn' },
    ] : [];
    return finish(gaps, blockers, warnings, summary, ['Underwriting application', 'Standard premium from the rate table', 'Affordability test']);
  },

  loadings: (c, ctx) => {
    const a = c.answers['loadings'];
    const cov = c.answers['coverage'];
    const gaps = fieldGaps(stageSpec('loadings'), a, ctx.fieldSettings);
    const blockers: string[] = [];
    const productId = String(c.answers['recommendation']?.['productId'] ?? '');
    const product = ctx.products.find((p) => p.productId === productId);
    const breakdown = product ? buildBreakdown(c, ctx, product.rules, product.category === 'takaful') : null;
    c.computed['__loadingBreakdown'] = breakdown;
    if (!breakdown) blockers.push('Coverage must be priced before loadings can be applied');
    if (breakdown && breakdown.reconciliation.agrees === false) blockers.push(breakdown.reconciliation.detail);
    const warnings = breakdown ? breakdown.components.filter((k) => k.referToHuman).map((k) => `${k.label} refers the case to a human underwriter`) : [];
    const summary: SummaryRow[] = breakdown ? [
      { label: 'Standard premium', value: formatAmount(breakdown.standardPremium) },
      ...breakdown.components.map((k) => ({ label: k.label, value: `${k.extraMortalityBps} bps = ${formatAmount(k.amount)}`, tone: (k.referToHuman ? 'warn' : 'info') as SummaryRow['tone'] })),
      { label: 'Loaded premium', value: formatAmount(breakdown.loadedPremium), tone: 'ok' },
      { label: 'Exclusions', value: breakdown.exclusions.join('; ') || 'none' },
      { label: 'Occupation', value: String(cov['occupationTitle'] ?? a['occupationTitle'] ?? '—') },
    ] : [];
    return finish(gaps, blockers, warnings, summary, ['Itemised loading breakdown', 'Exclusions', 'Evidence list']);
  },

  riders: (c, ctx) => {
    const a = c.answers['riders'];
    const gaps = fieldGaps(stageSpec('riders'), a, ctx.fieldSettings);
    const blockers: string[] = [];
    const warnings: string[] = [];
    const breakdown = c.computed.__loadingBreakdown;
    if (!breakdown) blockers.push('Loadings must be itemised before riders can be priced on top of them');
    const codes = asList(a['riders']);
    const withoutLoading = asList(a['withoutLoading']);
    const waiverBy = String(a['waiverBy'] ?? '').trim();
    const waiverReason = String(a['waiverReason'] ?? '').trim();
    for (const code of withoutLoading) {
      if (!codes.includes(code)) blockers.push(`"${code}" is marked as attached without loading but is not on the list of riders`);
      if (waiverBy.length < 3 || waiverReason.length < 12) {
        blockers.push(`A rider attached without loading needs a named authoriser and a reason: "${code}" has ${waiverBy || 'no name'} and ${waiverReason ? 'a reason that is too short' : 'no reason'}`);
      }
    }
    // Waivers are only passed to the pricing engine once they are complete: an incomplete waiver is a
    // gate to report, not an exception to throw at the operator.
    const selections: RiderSelection[] = codes.map((code) => (withoutLoading.includes(code) && waiverBy && waiverReason.length >= 12
      ? { code, loadingWaived: { by: waiverBy, at: ctx.asOf, reason: waiverReason } }
      : { code }));
    c.computed.__riderSelections = selections;
    const product = ctx.products.find((p) => p.productId === String(c.answers['recommendation']?.['productId'] ?? ''));
    let pricing: RiderPricing | null = null;
    if (breakdown) {
      try {
        pricing = priceRiders({
          basePremium: breakdown.loadedPremium,
          selections,
          age: Number(c.answers['coverage']?.['age'] ?? 35),
          shariahProduct: product?.category === 'takaful',
        });
      } catch (error) {
        blockers.push(error instanceof Error ? error.message : String(error));
      }
    }
    c.computed.__riderPricing = pricing;
    if (pricing) {
      blockers.push(...pricing.blockers);
      if (pricing.waivedLoadingBps > 0) warnings.push(`${pricing.waivedLoadingBps} bps of rider loading was given away, worth ${formatAmount(pricing.waivedLoadingValue)} — the authoriser is recorded against it`);
    }
    const summary: SummaryRow[] = pricing && pricing.lines.length > 0 ? [
      ...pricing.lines.map((l) => ({
        label: l.name,
        value: l.waived ? `attached without loading (${l.loadingBps} bps waived by ${l.waiver?.by ?? 'unnamed'})` : `${l.appliedBps} bps = ${formatAmount(l.amount)}`,
        tone: (l.waived ? 'warn' : 'info') as SummaryRow['tone'],
      })),
      { label: 'Rider premium', value: formatAmount(pricing.totalRiderPremium), tone: 'ok' },
      { label: 'Total payable', value: formatAmount(breakdown ? breakdown.totalPayable : pricing.totalRiderPremium) },
    ] : [{ label: 'Riders', value: 'none attached — the base cover stands alone', tone: 'info' }];
    return finish(gaps, blockers, warnings, summary, ['Rider schedule with prices', 'Waivers of loading, authorised', 'Rider evidence requirements']);
  },

  medical: (c, ctx) => {
    const a = c.answers['medical'];
    const product = ctx.products.find((p) => p.productId === String(c.answers['recommendation']?.['productId'] ?? ''));
    const breakdown = c.computed.__loadingBreakdown;
    if (!product) {
      return { percent: 0, complete: false, missing: ['A product must be chosen first'], blockers: ['No product on file, so the evidence bands cannot be applied'], warnings: [], summary: [], artefacts: [] };
    }
    const results = (Array.isArray(a['results']) ? a['results'] : []) as Array<Record<string, unknown>>;
    const set: MedicalRequirementSet = medicalRequirements({
      age: Number(c.answers['coverage']?.['age'] ?? 35),
      sumAssured: amount(c.answers['coverage']?.['sumAssured'], ctx.currency),
      rules: product.rules,
      conditions: asList(c.answers['loadings']?.['conditions']),
      pursuits: asList(c.answers['loadings']?.['pursuits']),
      occupationClass: (Number(c.answers['loadings']?.['occupationClass'] ?? 1) as OccupationClass),
      riders: asList(c.answers['riders']?.['riders']),
      results: results.map((r) => ({
        code: String(r['label'] ?? r['code'] ?? ''),
        status: (String(r['status'] ?? 'ordered') as 'ordered' | 'received' | 'reviewed' | 'waived'),
        at: r['at'] ? String(r['at']) : undefined,
        by: r['by'] ? String(r['by']) : undefined,
        waiverReason: r['waiverReason'] ? String(r['waiverReason']) : undefined,
      })),
    });
    c.computed['__medicalRequirements'] = set;
    c.computed['__requirementsIssued'] = set.requirements.length > 0;
    const gaps = fieldGaps(stageSpec('medical'), { ...a, __requirementsIssued: set.requirements.length > 0 }, ctx.fieldSettings);
    const blockers = [...set.blockers];
    if (set.requirements.some((r) => r.status === 'waived') && !String(a['reviewedBy'] ?? '').trim()) {
      blockers.push('A waived medical requirement needs the name of the person who waived it');
    }
    if (breakdown && breakdown.evidenceRequired.some((e) => !set.requirements.some((r) => r.label === e))) {
      blockers.push(`The loading breakdown requires evidence that is not on the checklist: ${breakdown.evidenceRequired.filter((e) => !set.requirements.some((r) => r.label === e)).join('; ')}`);
    }
    const summary: SummaryRow[] = set.requirements.length === 0
      ? [{ label: 'Requirements', value: 'none required for this age and sum assured', tone: 'ok' }]
      : set.requirements.map((r) => ({
        label: r.label, value: `${r.status} · ${r.source}${r.waiver ? ` · waived by ${r.waiver.by}: ${r.waiver.reason}` : ''}`,
        tone: (r.status === 'reviewed' ? 'ok' : r.status === 'waived' ? 'warn' : 'bad') as SummaryRow['tone'],
      }));
    const percent = set.requirements.length === 0 ? 100 : Math.min(set.percent, gaps.total === gaps.answered ? 100 : 99);
    return {
      percent: blockers.length > 0 ? Math.min(percent, 99) : percent,
      complete: set.complete && blockers.length === 0 && gaps.missing.length === 0,
      missing: gaps.missing, blockers, warnings: [], summary,
      artefacts: ['Medical requirement checklist', 'Results received and reviewed', 'Waivers with authority'],
    };
  },

  funds: (c, ctx) => {
    const a = c.answers['funds'];
    const gaps = fieldGaps(stageSpec('funds'), a, ctx.fieldSettings);
    const blockers: string[] = [];
    const evaluation = c.computed.__needsEvaluation;
    const product = ctx.products.find((p) => p.productId === String(c.answers['recommendation']?.['productId'] ?? ''));
    const investable = amount(c.answers['coverage']?.['sumAssured'], ctx.currency, 0n).minor > 0n
      ? firstContribution(c, ctx)
      : money(0n, ctx.currency);
    const weights = (Array.isArray(a['weights']) ? a['weights'] : []) as Array<Record<string, unknown>>;
    let plan: AllocationPlan | null = null;
    if (ctx.funds.length > 0 && weights.length > 0) {
      plan = allocateInvestment({
        investable,
        funds: ctx.funds,
        weights: weights.map((w) => ({
          fundId: String(w['fundId'] ?? ''),
          weightBps: w['weightBps'] !== undefined ? Number(w['weightBps']) : Math.round(Number(w['weightPct'] ?? 0) * 100),
        })),
        appetite: evaluation?.riskAppetite ?? undefined,
        shariahRequired: product?.category === 'takaful' || evaluation?.shariahPreferred === true,
      });
    }
    c.computed['__allocationPlan'] = plan;
    if (!plan) blockers.push('Choose at least one fund and its weight from the live fund list');
    if (plan) {
      blockers.push(...plan.blockers);
      if (!plan.shariahAgrees) blockers.push('A Shariah-compliant arrangement may only hold screened funds');
    }
    const summary: SummaryRow[] = plan ? [
      { label: 'First contribution', value: plan.investableLabel },
      ...plan.lines.map((l) => ({ label: `${l.name} (${l.fundId})`, value: `${l.weightPct.toFixed(2)}% = ${l.amountLabel} · ${l.units} units at ${l.navPerUnit} (${l.navDate})` })),
      { label: 'Weighted risk', value: `${plan.weightedRiskScore} of 2 against a "${plan.appetite ?? 'unstated'}" appetite`, tone: plan.appetiteAgrees === false ? 'warn' : 'ok' },
      { label: 'Weighted fund charge', value: `${(plan.weightedChargeBps / 100).toFixed(2)}% a year` },
    ] : [];
    const percent = plan ? (blockers.length === 0 && gaps.missing.length === 0 ? 100 : Math.min(99, Math.max(plan.percent, Math.round((gaps.answered / Math.max(1, gaps.total)) * 100)))) : Math.round((gaps.answered / Math.max(1, gaps.total)) * 100);
    return {
      percent, complete: Boolean(plan?.complete) && blockers.length === 0 && gaps.missing.length === 0,
      missing: gaps.missing, blockers, warnings: plan ? plan.warnings : [], summary,
      artefacts: ['Signed target weights', 'First-contribution split by fund', 'Units to be allocated at the next valuation'],
    };
  },

  beneficiaries: (c, ctx) => {
    const a = c.answers['beneficiaries'];
    const gaps = fieldGaps(stageSpec('beneficiaries'), a, ctx.fieldSettings);
    const raw = (Array.isArray(a['beneficiaries']) ? a['beneficiaries'] : []) as Array<Record<string, unknown>>;
    const list: BeneficiaryInput[] = raw.map((b) => ({
      name: String(b['name'] ?? ''),
      relationship: String(b['relationship'] ?? ''),
      sharePct: Number(b['sharePct'] ?? 0),
      kind: String(b['kind'] ?? 'primary') === 'contingent' ? 'contingent' : 'primary',
      dateOfBirth: b['dateOfBirth'] ? String(b['dateOfBirth']) : undefined,
      guardian: b['guardian'] ? String(b['guardian']) : undefined,
      idNumber: b['idNumber'] ? String(b['idNumber']) : undefined,
    }));
    const set: BeneficiarySet = validateBeneficiaries({ beneficiaries: list, proceeds: amount(c.answers['coverage']?.['sumAssured'], ctx.currency), asOf: ctx.asOf });
    c.computed['__beneficiaries'] = set;
    const summary: SummaryRow[] = list.length === 0
      ? [{ label: 'Beneficiaries', value: 'none designated', tone: 'bad' }]
      : [...set.primaries.map((b) => ({ label: `Primary — ${b.name}`, value: `${b.sharePct.toFixed(2)}% · ${b.relationship}${b.shareOfProceeds ? ` · ${formatAmount(b.shareOfProceeds)}` : ''}` })),
        ...set.contingents.map((b) => ({ label: `Contingent — ${b.name}`, value: `${b.sharePct.toFixed(2)}% · ${b.relationship}` })),
        { label: 'Primary total', value: `${(set.primaryTotalBps / 100).toFixed(2)}%`, tone: set.primaryTotalBps === 10_000 ? 'ok' : 'bad' }];
    return {
      percent: set.complete && gaps.missing.length === 0 ? 100 : Math.min(99, set.percent),
      complete: set.complete && gaps.missing.length === 0,
      missing: gaps.missing, blockers: [...set.blockers], warnings: [...set.warnings], summary,
      artefacts: ['Beneficiary schedule', 'Share allocation', 'Customer confirmation'],
    };
  },

  'uw-review': (c, ctx) => {
    const a = c.answers['uw-review'];
    const gaps = fieldGaps(stageSpec('uw-review'), a, ctx.fieldSettings);
    const blockers: string[] = [];
    const warnings: string[] = [];
    if (!c.artefacts.applicationId) blockers.push('No underwriting application exists yet — submit the coverage section first');
    const set = c.computed.__medicalRequirements;
    if (set && !set.complete) blockers.push(`Medical evidence is outstanding: ${set.blockers.join('; ')}`);
    const outcome = String(a['decisionOutcome'] ?? ctx.decision?.outcome ?? ctx.application?.outcome ?? '') as DecisionOutcome | '';
    if (outcome === 'declined' || outcome === 'postponed') {
      blockers.push(`The decision is "${outcome}": no quotation may be issued, and only a named human may record that outcome`);
    }
    if (outcome === 'referred') warnings.push('The case is still referred — a senior underwriter must decide it before a quotation can be issued');
    if (a['decidedByAi'] === true && String(a['decidedBy'] ?? '').trim() === '') {
      blockers.push('An AI decision still needs the agent identity that ran it recorded on the file');
    }
    const decision = ctx.decision ?? (ctx.application ? { outcome: ctx.application.outcome, decidedBy: ctx.application.decidedBy, decidedByAi: ctx.application.decidedByAi, extraMortalityBps: ctx.application.extraMortalityBps, loadedPremium: ctx.application.loadedPremium } : null);
    const summary: SummaryRow[] = decision ? [
      { label: 'Outcome', value: String(outcome || decision.outcome), tone: outcome === 'declined' || outcome === 'postponed' ? 'bad' : outcome === 'referred' ? 'warn' : 'ok' },
      { label: 'Decided by', value: `${decision.decidedBy || '—'}${decision.decidedByAi ? ' (AI agent)' : ''}` },
      { label: 'Extra mortality', value: `${decision.extraMortalityBps} bps` },
      { label: 'Loaded premium', value: formatAmount(decision.loadedPremium) },
      { label: 'Referrals', value: (ctx.application?.referrals ?? []).join(', ') || 'none' },
      { label: 'Exclusions', value: (ctx.application?.exclusions ?? []).join('; ') || 'none' },
    ] : [];
    return finish(gaps, blockers, warnings, summary, ['Underwriting decision', 'Waived referral points, named', 'Updated questionnaire']);
  },

  quotation: (c, ctx) => {
    const a = c.answers['quotation'];
    const gaps = fieldGaps(stageSpec('quotation'), a, ctx.fieldSettings);
    const blockers: string[] = [];
    const warnings: string[] = [];
    const q = ctx.quotation;
    const decision = ctx.decision ?? ctx.application;
    if (q) {
      // The document exists: the gate is now about whether it was sent and whether it stands.
      if (q.status === 'refused') blockers.push(...q.blockers);
      else if (!q.dispatched) blockers.push('The quotation has been generated but not sent to the customer');
    } else {
      // Nothing issued yet: the gate checks the preconditions the issue will be tested against.
      if (!decision) blockers.push('The case has not been assessed — no quotation can be issued on an unassessed risk');
      else if (decision.outcome === 'declined' || decision.outcome === 'postponed') blockers.push(`The decision is "${decision.outcome}": no quotation may be issued`);
      else if (decision.outcome === 'referred') blockers.push('The case is still referred; a decision under authority is needed before a quotation can be issued');
      const breakdown = c.computed.__loadingBreakdown;
      if (breakdown?.reconciliation.agrees === false) blockers.push(breakdown.reconciliation.detail);
      const plan = c.computed.__allocationPlan;
      if (plan && !plan.complete) blockers.push(`The fund allocation does not balance: ${plan.blockers.join('; ')}`);
      const beneficiaries = c.computed.__beneficiaries;
      if (beneficiaries && !beneficiaries.complete) blockers.push(`The beneficiary designation does not stand: ${beneficiaries.blockers.join('; ')}`);
      const medical = c.computed.__medicalRequirements;
      if (medical && !medical.complete) blockers.push(`Medical evidence is outstanding: ${medical.blockers.join('; ')}`);
      if (!c.computed.__needsEvaluation?.completed) blockers.push('The needs analysis is not complete, so the pack in force does not allow a quotation');
      if (a['alternativesPresented'] === undefined && c.answers['recommendation']?.['alternativesPresented'] !== true) {
        warnings.push('The comparison of alternatives will be reported as not presented on the compliance checks');
      }
    }
    const breakdown = c.computed.__loadingBreakdown;
    const summary: SummaryRow[] = q ? [
      { label: 'Quotation', value: `${q.quotationId} v${q.version}`, tone: q.status === 'refused' ? 'bad' : 'ok' },
      { label: 'Status', value: q.status },
      { label: 'Total payable', value: formatAmount(q.totalPayable) },
      { label: 'Valid until', value: q.expiresAt.slice(0, 10) },
      { label: 'Emailed', value: q.dispatched ? `yes, to ${String(a['emailTo'] ?? '—')}` : 'not sent', tone: q.dispatched ? 'ok' : 'warn' },
    ] : breakdown ? [
      { label: 'Will quote', value: `${formatAmount(breakdown.standardPremium)} standard + ${formatAmount(sub(breakdown.loadedPremium, breakdown.standardPremium))} loading = ${formatAmount(breakdown.totalPayable)} payable` },
      { label: 'Decision on file', value: decision ? `${decision.outcome} by ${decision.decidedBy || '—'}` : 'none' },
      { label: 'Document', value: 'not generated yet', tone: 'warn' },
    ] : [];
    return finish(gaps, blockers, warnings, summary, ['Versioned quotation PDF with fingerprint', 'Email dispatch record', 'Validity window']);
  },

  finalisation: (c, ctx) => {
    const a = c.answers['finalisation'];
    const gaps = fieldGaps(stageSpec('finalisation'), a, ctx.fieldSettings);
    const blockers: string[] = [];
    const q = ctx.quotation;
    if (!q || q.status === 'refused') blockers.push('There is no issued quotation for the customer to accept');
    else if (!q.dispatched) blockers.push('The customer cannot accept a quotation they have not been sent');
    else if (q.finalised) { /* signed */ } else if (a['signedBy'] === undefined) blockers.push('The customer’s signature has not been captured');
    if (q && ctx.asOf.slice(0, 10) > q.expiresAt.slice(0, 10)) blockers.push(`The quotation expired on ${q.expiresAt.slice(0, 10)}; re-issue it before acceptance`);
    const summary: SummaryRow[] = [
      { label: 'Free-look period', value: `${ctx.coolingOffDays} day(s) from delivery of the policy` },
      { label: 'Signed by', value: String(a['signedBy'] ?? '—') },
      { label: 'Signed on', value: String(a['signedAt'] ?? '—') },
      { label: 'Buy-online token', value: c.artefacts.buyToken ?? 'not issued yet', tone: c.artefacts.buyToken ? 'ok' : 'warn' },
    ];
    return finish(gaps, blockers, [], summary, ['Customer signature and reference', 'Cooling-off statement', 'Buy-online token']);
  },

  payment: (c, ctx) => {
    const a = c.answers['payment'];
    const gaps = fieldGaps(stageSpec('payment'), a, ctx.fieldSettings);
    const blockers: string[] = [];
    const warnings: string[] = [];
    const recon = ctx.payment;
    const due = ctx.quotation?.totalPayable ?? money(0n, ctx.currency);
    const captured = Boolean(recon && recon.payments.length > 0);
    // Do not collect a partner customer's payment while the signed application is awaiting
    // approval. Direct (unattributed) journeys have no partner blocker and are unchanged.
    if (!captured && ctx.partnerRoutingBlocker) blockers.push(ctx.partnerRoutingBlocker);
    if (due.minor === 0n) {
      blockers.push('There is no amount due yet — the quotation has to be issued first');
    } else if (!captured) {
      // Nothing taken yet: the gate checks what is about to be taken, not a receipt that does not exist.
      const entered = amount(a['amount'], ctx.currency);
      if (entered.minor > 0n && compare(entered, due) < 0) {
        blockers.push(`The amount entered (${formatAmount(entered)}) is short of the ${formatAmount(due)} due; a short first payment does not clear the quotation`);
      }
      warnings.push(`Nothing captured yet: submitting takes ${formatAmount(entered.minor > 0n ? entered : due)} by ${String(a['method'] ?? 'the chosen method')}`);
    } else if (recon) {
      if (!recon.clearsDue) {
        if (recon.paid.minor === 0n && recon.pending.minor > 0n) {
          blockers.push(`${formatAmount(recon.pending)} has been instructed but is still pending clearance; this section completes when the money is the insurer's, not when the customer says they sent it`);
        } else {
          blockers.push(`Paid ${formatAmount(recon.paid)} of ${formatAmount(recon.due)}; ${formatAmount(recon.shortfall)} is still outstanding`);
        }
      }
      if (recon.pending.minor > 0n && recon.clearsDue) warnings.push(`${formatAmount(recon.pending)} is pending clearance; the policy is issued when the money settles`);
      if (recon.overpayment.minor > 0n) warnings.push(`${formatAmount(recon.overpayment)} overpaid — held as an advance against the next instalment`);
    }
    const summary: SummaryRow[] = recon ? [
      { label: 'Amount due', value: formatAmount(recon.due) },
      { label: 'Captured', value: formatAmount(recon.paid), tone: recon.clearsDue ? 'ok' : 'bad' },
      { label: 'Pending', value: formatAmount(recon.pending), tone: recon.pending.minor > 0n ? 'warn' : 'info' },
      { label: 'Method', value: recon.payments.map((p) => `${p.methodLabel}${p.card ? ` ${p.card.maskedPan}` : ''} (${p.status})`).join(', ') || '—' },
      { label: 'Handling cost', value: formatAmount(recon.payments.reduce((acc, p) => ({ minor: acc.minor + p.fee.minor, currency: acc.currency }), money(0n, ctx.currency))) },
    ] : [{ label: 'Payment', value: 'not captured', tone: 'warn' }];
    return finish(gaps, blockers, warnings, summary, ['Payment record with proof', 'Handling cost and net to insurer', 'Reconciliation against the amount due']);
  },

  routing: (c, ctx) => {
    const a = c.answers['routing'];
    const routing = ctx.routing ?? null;
    const computed: Answers = {
      ...a,
      __freelanceOffered: Boolean(routing?.freelance),
      __reinsuranceAssist: Boolean(routing?.reinsuranceAssist),
      __needsSenior: routing ? routing.route === 'senior-review' || routing.route === 'senior-referral' || routing.route === 'reinsurance-assist' || routing.route === 'freelance-assist' : false,
    };
    c.computed['__routingFlags'] = computed;
    const gaps = fieldGaps(stageSpec('routing'), computed, ctx.fieldSettings);
    const blockers: string[] = [];
    const warnings: string[] = [];
    if (ctx.partnerRoutingBlocker) blockers.push(ctx.partnerRoutingBlocker);
    if (!routing) blockers.push('The route has not been decided yet — submit this section to route the case');
    if (routing) {
      if (a['reinsuranceAnswer'] === 'decline') blockers.push('The reinsurer declined the risk: it cannot be bound on this treaty');
      if (a['reinsuranceAnswer'] === 'awaiting') warnings.push('Waiting on the reinsurer’s underwriter; the case cannot be bound until the answer arrives');
      if (!routing.withinPromise) warnings.push(`The promised decision time of ${routing.promisedDecisionHours} hour(s) cannot be met in-house (about ${routing.expectedDecisionHours} hour(s))`);
      if (routing.freelance && a['engageFreelance'] !== true) warnings.push(`A panel underwriter is available for ${routing.freelance.costLabel} but has not been engaged`);
    }
    const summary: SummaryRow[] = routing ? [
      { label: 'Route', value: routing.route, tone: routing.automatic ? 'ok' : 'warn' },
      { label: 'Assigned to', value: routing.assignedTo },
      { label: 'Decision expected', value: routing.automatic ? 'immediately' : `${routing.expectedDecisionHours} working hour(s)`, tone: routing.withinPromise ? 'ok' : 'bad' },
      { label: 'External cost', value: routing.costEstimateLabel },
      ...routing.reasons.map((r) => ({ label: 'Why', value: r })),
    ] : [];
    return finish(gaps, blockers, warnings, summary, ['Routing decision with reasons', 'Freelance engagement and cost', 'Reinsurance assist request and answer']);
  },

  conversion: (c, ctx) => {
    const a = c.answers['conversion'];
    const gaps = fieldGaps(stageSpec('conversion'), a, ctx.fieldSettings);
    const blockers: string[] = [];
    if (c.artefacts.policyId) {
      return { percent: 100, complete: true, missing: [], blockers: [], warnings: [], summary: [
        { label: 'Policy', value: c.artefacts.policyId, tone: 'ok' },
        { label: 'Status', value: ctx.policy?.status ?? 'issued' },
        { label: 'First receipt', value: c.artefacts.receiptId ?? '—' },
      ], artefacts: ['Policy number', 'First premium receipt and journal', 'Units allocated at the dealing valuation'] };
    }
    const decision = ctx.decision ?? ctx.application;
    if (ctx.partnerConversionBlocker) blockers.push(ctx.partnerConversionBlocker);
    if (!decision) blockers.push('There is no underwriting decision to convert');
    else if (decision.outcome === 'declined' || decision.outcome === 'postponed') blockers.push(`The decision is "${decision.outcome}": the proposal cannot become a policy`);
    else if (decision.outcome === 'referred') blockers.push('The case is still referred; a decision under authority is needed before conversion');
    if (!ctx.payment?.clearsDue) blockers.push('The first payment has not cleared the amount due');
    else if (ctx.payment.pending.minor > 0n) blockers.push(`${formatAmount(ctx.payment.pending)} is still pending clearance; a policy is not issued on money the insurer does not have`);
    if (!c.artefacts.routeId) blockers.push('The binding route has not been recorded');
    if (!c.artefacts.quotationId) blockers.push('There is no quotation the customer accepted');
    else if (ctx.routing?.route === 'reinsurance-assist' && c.answers['routing']?.['reinsuranceAnswer'] !== 'accept' && c.answers['routing']?.['reinsuranceAnswer'] !== 'accept-with-conditions') {
      blockers.push('The reinsurer has not accepted the risk, so it cannot be bound');
    }
    const plan = c.computed.__allocationPlan;
    if (!plan?.complete) blockers.push('The signed fund allocation is incomplete, so the first contribution cannot be invested');
    const summary: SummaryRow[] = [
      { label: 'Application', value: c.artefacts.applicationId ?? '—' },
      { label: 'Decision', value: decision ? String(decision.outcome) : '—', tone: decision && decision.outcome !== 'referred' ? 'ok' : 'warn' },
      { label: 'Money cleared', value: ctx.payment?.clearsDue ? formatAmount(ctx.payment.paid) : 'no', tone: ctx.payment?.clearsDue ? 'ok' : 'bad' },
      { label: 'Route', value: ctx.routing?.route ?? '—' },
    ];
    return finish(gaps, blockers, [], summary, ['Policy number', 'First premium receipt and journal', 'Units allocated at the dealing valuation']);
  },

  allocation: (c, ctx) => {
    const a = c.answers['allocation'];
    const gaps = fieldGaps(stageSpec('allocation'), a, ctx.fieldSettings);
    const blockers: string[] = [];
    const warnings: string[] = [];
    if (!c.artefacts.policyId) blockers.push('There is no policy in force yet');
    if (!ctx.policy) blockers.push('The policy has no published valuation to manage against');
    let summary: SummaryRow[] = [];
    if (ctx.policy) {
      const report = allocationProgress({
        policyId: ctx.policy.policyId,
        contributionsToDate: ctx.policy.contributionsToDate,
        holdings: ctx.policy.holdings,
        targetWeights: ctx.policy.targetWeights,
        commencement: ctx.policy.commencement,
        asOf: ctx.asOf,
      });
      c.computed.__allocationProgress = {
        gainLossLabel: formatAmount(report.gainLoss),
        gainLossPct: report.gainLossPct,
        driftLabel: `${(report.maxDriftBps / 100).toFixed(2)}% against a tolerance of ${(report.driftToleranceBps / 100).toFixed(2)}%`,
        nextReview: report.nextReviewDate,
        overdue: report.reviewOverdue,
        withinTolerance: report.withinTolerance,
        rebalanceRecommended: report.rebalanceRecommended,
        rebalanceReason: report.rebalanceReason,
        monthsInForce: report.monthsInForce,
        contributions: formatAmount(report.contributionsToDate),
        currentValue: formatAmount(report.currentValue),
        holdings: report.holdings.map((h) => ({ fund: h.fundName, targetPct: h.targetBps / 100, actualPct: h.actualBps / 100, action: h.action })),
      };
      blockers.push(...report.blockers);
      warnings.push(...report.warnings);
      if (report.rebalanceRecommended && a['rebalanceRequested'] !== true) {
        warnings.push(`Drift of ${(report.maxDriftBps / 100).toFixed(2)}% is outside the tolerance: ${report.rebalanceReason}`);
      }
      if (report.reviewOverdue) warnings.push(`The periodic allocation review was due on ${report.nextReviewDate}`);
      summary = [
        { label: 'Policy', value: ctx.policy.policyId },
        { label: 'Status', value: ctx.policy.status },
        { label: 'Contributions to date', value: formatAmount(ctx.policy.contributionsToDate) },
        { label: 'Current fund value', value: formatAmount(ctx.policy.currentValue) },
        { label: 'Target weights', value: ctx.policy.targetWeights.map((t) => `${t.fundId} ${(t.weightBps / 100).toFixed(2)}%`).join(', ') || '—' },
        { label: 'Drift', value: `${(report.maxDriftBps / 100).toFixed(2)}% (tolerance ${(report.driftToleranceBps / 100).toFixed(2)}%)`, tone: report.withinTolerance ? 'ok' : 'warn' },
        { label: 'Next review', value: report.nextReviewDate, tone: report.reviewOverdue ? 'bad' : 'info' },
      ];
    }
    return finish(gaps, blockers, warnings, summary, ['Drift report against signed targets', 'Rebalance, switch or top-up instruction', 'Dealing valuation used']);
  },

  investment: (c, ctx) => {
    const a = c.answers['investment'];
    const gaps = fieldGaps(stageSpec('investment'), a, ctx.fieldSettings);
    const blockers: string[] = [];
    const warnings: string[] = [];
    if (!ctx.policy) blockers.push('There is no policy in force to report on');
    const progress = c.computed.__allocationProgress as { gainLossLabel?: string; driftLabel?: string; nextReview?: string; overdue?: boolean } | undefined;
    if (progress?.overdue) warnings.push(`The periodic allocation review was due on ${progress.nextReview}`);
    const summary: SummaryRow[] = ctx.policy ? [
      { label: 'Contributions to date', value: formatAmount(ctx.policy.contributionsToDate) },
      { label: 'Current value', value: formatAmount(ctx.policy.currentValue) },
      { label: 'Gain / loss', value: progress?.gainLossLabel ?? '—', tone: (progress?.gainLossLabel ?? '').startsWith('-') ? 'bad' : 'ok' },
      { label: 'Drift against targets', value: progress?.driftLabel ?? '—' },
      { label: 'Next review', value: progress?.nextReview ?? '—' },
      { label: 'Disclaimer', value: ctx.illustrationWording },
    ] : [];
    return finish(gaps, blockers, warnings, summary, ['Progress statement', 'Gain or loss against contributions', 'Next review date']);
  },

  servicing: (c, ctx) => {
    const a = c.answers['servicing'];
    const gaps = fieldGaps(stageSpec('servicing'), a, ctx.fieldSettings);
    const blockers: string[] = [];
    if (!c.artefacts.policyId) blockers.push('Servicing begins when the policy is issued');
    const s = ctx.servicing;
    const summary: SummaryRow[] = [
      { label: 'Policy', value: c.artefacts.policyId ?? '—' },
      { label: 'Alterations recorded', value: String(s?.alterations ?? 0) },
      { label: 'Claims', value: `${s?.openClaims ?? 0} open · ${s?.settledClaims ?? 0} settled` },
      { label: 'Service channel', value: String(a['serviceChannel'] ?? '—') },
    ];
    return finish(gaps, blockers, [], summary, ['Servicing handover', 'Alteration routes', 'Claim registration route']);
  },
};

function finish(
  gaps: { missing: string[]; answered: number; total: number },
  blockers: string[], warnings: string[], summary: SummaryRow[], artefacts: string[],
): StageReview {
  const unique = [...new Set(blockers)];
  const percent = gaps.total === 0 ? (unique.length === 0 ? 100 : 99) : Math.round((gaps.answered / gaps.total) * 100);
  return {
    percent: unique.length > 0 ? Math.min(percent, 99) : percent,
    complete: gaps.missing.length === 0 && unique.length === 0,
    missing: gaps.missing,
    blockers: unique,
    warnings: [...new Set(warnings)],
    summary,
    artefacts,
  };
}

/** The first contribution the allocation splits: the premium for the chosen frequency. */
export function firstContribution(c: JourneyCase, ctx: JourneyContext): Money {
  const cov = c.answers['coverage'];
  const sumAssured = amount(cov?.['sumAssured'], ctx.currency);
  const product = ctx.products.find((p) => p.productId === String(c.answers['recommendation']?.['productId'] ?? ''));
  if (!product || sumAssured.minor <= 0n) return money(0n, ctx.currency);
  const annual = money((sumAssured.minor * product.baseRatePerThousandMinor) / (1000n * 100n), ctx.currency);
  const breakdown = c.computed.__loadingBreakdown;
  const total = breakdown ? breakdown.totalPayable : annual;
  const frequency = String(cov?.['paymentFrequency'] ?? 'annual');
  const divisor = frequency === 'monthly' ? 12n : frequency === 'quarterly' ? 4n : frequency === 'semi-annual' ? 2n : 1n;
  return { minor: total.minor / divisor, currency: total.currency };
}

function buildBreakdown(c: JourneyCase, ctx: JourneyContext, rules: ProductRules, shariah: boolean): LoadingBreakdown | null {
  const cov = c.answers['coverage'];
  const load = c.answers['loadings'];
  const product = ctx.products.find((p) => p.productId === String(c.answers['recommendation']?.['productId'] ?? ''));
  if (!product) return null;
  const sumAssured = amount(cov?.['sumAssured'], ctx.currency);
  const standardPremium = money((sumAssured.minor * product.baseRatePerThousandMinor) / (1000n * 100n), ctx.currency);
  const heightCm = Number(cov?.['heightCm'] ?? 175);
  const weightKg = Number(cov?.['weightKg'] ?? 75);
  const bmi = heightCm > 0 ? Math.round((weightKg / ((heightCm / 100) ** 2)) * 10) / 10 : undefined;
  const selections = (c.computed.__riderSelections as RiderSelection[] | undefined) ?? asList(c.answers['riders']?.['riders']).map((code) => {
    const waived = asList(c.answers['riders']?.['withoutLoading']).includes(code);
    const waiverBy = String(c.answers['riders']?.['waiverBy'] ?? '').trim();
    const waiverReason = String(c.answers['riders']?.['waiverReason'] ?? '').trim();
    return waived && waiverBy && waiverReason.length >= 12
      ? { code, loadingWaived: { by: waiverBy, at: ctx.asOf, reason: waiverReason } }
      : { code };
  });
  return loadingBreakdown({
    standardPremium,
    rules,
    age: Number(cov?.['age'] ?? 35),
    smoker: cov?.['smoker'] === true || String(cov?.['smoker'] ?? '') === 'yes',
    bmi,
    occupationClass: (Number(load?.['occupationClass'] ?? 1) as OccupationClass),
    conditions: asList(load?.['conditions']),
    pursuits: asList(load?.['pursuits']),
    familyHistory: asList(load?.['familyHistory']),
    riders: selections,
    shariahProduct: shariah,
  });
}

/* ------------------------------------------------------------------ sequencing */

/**
 * Review one section. A reviewer reports; it never throws. An operator typing into a half-finished
 * form has to see what is missing, not an exception — so anything a domain module refuses on bad
 * input is caught here and turned into a blocker on the section that caused it.
 */
export function reviewStage(caze: JourneyCase, stageId: JourneyStageId, ctx: JourneyContext): StageReview {
  const stage = stageSpec(stageId);
  try {
    return reviewers[stageId](caze, ctx);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const gaps = fieldGaps(stage, caze.answers[stageId], ctx.fieldSettings);
    return {
      percent: Math.min(99, gaps.total === 0 ? 0 : Math.round((gaps.answered / gaps.total) * 100)),
      complete: false,
      missing: gaps.missing,
      blockers: [message],
      warnings: [],
      summary: [],
      artefacts: [...stage.produces],
    };
  }
}

export interface ProgressOptions {
  /**
   * Set while submitting a section: that section's own "not submitted yet" state is ignored so the
   * gate can decide whether it *may* be submitted. Without it, no section could ever be submitted.
   */
  readonly ignoreSubmittedFor?: JourneyStageId;
}

/**
 * The whole journey as the console renders it: every section closed, every gate evaluated, and one
 * section marked `autoOpen` — the first one that is not complete and not locked.
 */
export function journeyProgress(caze: JourneyCase, ctx: JourneyContext, options: ProgressOptions = {}): JourneyProgress {
  const reviews = new Map<JourneyStageId, StageReview>();
  for (const stage of JOURNEY_STAGES) reviews.set(stage.id, reviewStage(caze, stage.id, ctx));

  const states: StageState[] = [];
  let firstIncomplete: JourneyStageId | null = null;
  let blockedBy: JourneyStageId | null = null;

  for (const stage of JOURNEY_STAGES) {
    const review = reviews.get(stage.id)!;
    const locked = blockedBy !== null;
    const submitted = caze.submitted.includes(stage.id) || options.ignoreSubmittedFor === stage.id;
    // A section behind a locked one is never reported as done, however empty its own gate is: the
    // journey is a sequence, and a tick on section 7 while section 5 is open would be a lie. A
    // section that has not been submitted is not done either, however complete its fields look.
    const complete = review.complete && !locked && submitted;
    if (!complete && firstIncomplete === null) firstIncomplete = stage.id;
    const status: StageStatus = locked
      ? 'locked'
      : complete ? 'complete'
      : review.complete ? 'in-progress'          // the gate passes; it is waiting to be submitted
      : review.blockers.length > 0 && review.percent > 0 ? 'blocked'
      : review.percent > 0 ? 'in-progress'
      : 'ready';
    states.push({
      id: stage.id, order: stage.order, title: stage.title, shortTitle: stage.shortTitle,
      purpose: stage.purpose, regulatoryBasis: stage.regulatoryBasis, owner: stage.owner,
      detailTab: stage.detailTab, fields: stage.fields.map((fd) => ({
        ...fd,
        label: fieldLabel(stage.id, fd, ctx.fieldSettings),
        mandatory: ctx.fieldSettings?.[stage.id]?.[fd.id]?.mandatory ?? fd.mandatory,
        editable: ctx.fieldSettings?.[stage.id]?.[fd.id]?.editable ?? fd.editable,
      })), produces: stage.produces,
      ...review, complete, percent: complete ? 100 : locked ? 0 : review.percent, status, submitted,
      lockedBy: blockedBy,
      lockedByTitle: blockedBy ? stageSpec(blockedBy).title : null,
      autoOpen: false,
      answers: { ...caze.answers[stage.id], ...pickComputed(caze, stage.id) },
    });
    if (!complete) blockedBy = blockedBy ?? stage.id;
  }

  const recommended = states.find((s) => !s.complete && s.status !== 'locked') ?? null;
  const withAutoOpen = states.map((s) => ({ ...s, autoOpen: recommended !== null && s.id === recommended.id }));
  const completeStages = states.filter((s) => s.complete).length;
  const percent = Math.round((completeStages / JOURNEY_STAGES.length) * 100);
  const blockers = states.filter((s) => s.status !== 'locked').flatMap((s) => s.blockers.map((b) => `${s.shortTitle}: ${b}`));

  return {
    caseId: caze.caseId,
    customerName: caze.customerName,
    status: caze.status,
    stages: withAutoOpen,
    completeStages,
    totalStages: JOURNEY_STAGES.length,
    percent,
    nextRecommended: recommended?.id ?? null,
    nextRecommendedTitle: recommended?.title ?? null,
    headline: completeStages === JOURNEY_STAGES.length
      ? 'Every section is complete: the policy is in force and being serviced.'
      : recommended
        ? `Section ${recommended.order} of ${JOURNEY_STAGES.length} — ${recommended.title}. Everything after it stays closed until this one is 100% complete.`
        : 'The journey is blocked; see the outstanding items below.',
    blockers: [...new Set(blockers)],
    artefacts: caze.artefacts,
    log: [...caze.log].reverse(),
  };
}

/** The computed values a section’s form needs to render (evaluations, plans, flags) — read-only. */
function pickComputed(caze: JourneyCase, stageId: JourneyStageId): Answers {
  const out: Answers = {};
  if (stageId === 'needs' && caze.computed.__needsEvaluation) out['evaluation'] = caze.computed.__needsEvaluation;
  if (stageId === 'loadings' && caze.computed.__loadingBreakdown) out['breakdown'] = caze.computed.__loadingBreakdown;
  if (stageId === 'riders' && caze.computed.__riderPricing) out['pricing'] = caze.computed.__riderPricing;
  if (stageId === 'medical') {
    const set = caze.computed.__medicalRequirements;
    if (set) { out['requirements'] = set.requirements; out['__requirementsIssued'] = set.requirements.length > 0; }
  }
  if (stageId === 'funds' && caze.computed.__allocationPlan) out['plan'] = caze.computed.__allocationPlan;
  if (stageId === 'beneficiaries' && caze.computed.__beneficiaries) out['set'] = caze.computed.__beneficiaries;
  if (stageId === 'routing' && caze.computed.__routingFlags) return { ...caze.computed.__routingFlags };
  if ((stageId === 'allocation' || stageId === 'investment') && caze.computed.__allocationProgress) {
    out['progressReport'] = caze.computed.__allocationProgress;
  }
  return out;
}

export function emptyAnswers(): Record<JourneyStageId, Answers> {
  const out = {} as Record<JourneyStageId, Answers>;
  for (const stage of JOURNEY_STAGES) out[stage.id] = {};
  return out;
}

/** The next stage a section should open once the current one is 100% complete. */
export function stageAfter(stageId: JourneyStageId): JourneyStageId | null {
  const spec = stageSpec(stageId);
  return JOURNEY_STAGES.find((s) => s.order === spec.order + 1)?.id ?? null;
}

export function stageBefore(stageId: JourneyStageId): JourneyStageId | null {
  const spec = stageSpec(stageId);
  return JOURNEY_STAGES.find((s) => s.order === spec.order - 1)?.id ?? null;
}

export type { Money, PaymentMethod };
