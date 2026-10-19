/**
 * The product catalogue: every variety this tenant may sell, held as data.
 *
 * A product is not a name in a dropdown. It is a set of numbers an engine will price, gate and route
 * against — entry ages, the base rate per 1,000 of sum assured, the income multiple, the automatic
 * binding limit, the facultative threshold, the straight-through limit an AI agent may work inside,
 * and the evidence a risk of a given age and size has to bring. Held here rather than in a screen, so
 * that:
 *
 *  - the console's product factory, the journey's recommendation list and the underwriting engine all
 *    read the same variety, and cannot disagree about it;
 *  - a new variety is a row, not a release: `ErpManager` seeds these as product masters and registers
 *    their rules with the underwriting engine on world build;
 *  - the terms are visible. Every variety says in one sentence what it covers, which is what a
 *    suitability review reads when it asks why this product was recommended.
 *
 * The catalogue is deliberately wide — term in five varieties, endowment in six, critical illness in
 * eight, medical, general, marine, home, travel, mortgage, hull and group — because an insurer that
 * can only illustrate one product per line cannot show a customer the alternative the regulator
 * insists was presented.
 */
import type { ProductLine } from './underwriting.js';
import { COUNTRIES } from './regional.js';

/** How a policy is administered and accounted for: the four books the ERP keeps. */
export type PolicyCategory = 'unit-linked' | 'takaful' | 'conventional' | 'motor-payg';

/** The four books a product can be administered and accounted for in, in the order the grid lists them. */
export const PRODUCT_CATEGORIES: readonly PolicyCategory[] = Object.freeze(['unit-linked', 'takaful', 'conventional', 'motor-payg'] as const);

/** Every country pack on file: the territory a worldwide line accepts without a referral. */
export const WORLDWIDE: readonly string[] = COUNTRIES.map((c) => c.code);

export interface EvidenceBandSpec {
  readonly fromAge: number;
  /** A decimal amount in the local currency, parsed by the ERP into minor units. */
  readonly fromSumAssured: string;
  readonly requirements: readonly string[];
}

/** The evidence profiles: what a risk of a given age and size has to bring, by kind of business. */
export const EVIDENCE_PROFILES: Readonly<Record<string, readonly EvidenceBandSpec[]>> = Object.freeze({
  life: [
    { fromAge: 40, fromSumAssured: '500,000', requirements: ['blood profile', 'urine analysis'] },
    { fromAge: 55, fromSumAssured: '100,000', requirements: ['ECG', 'treadmill test'] },
  ],
  medical: [
    { fromAge: 45, fromSumAssured: '100,000', requirements: ['attending physician statement'] },
    { fromAge: 60, fromSumAssured: '50,000', requirements: ['resting ECG', 'blood profile'] },
  ],
  'short-tail': [
    { fromAge: 0, fromSumAssured: '5,000,000', requirements: ['risk survey report'] },
    { fromAge: 0, fromSumAssured: '20,000,000', requirements: ['risk survey report', 'loss history for five years'] },
  ],
});

export interface ProductVariety {
  readonly productId: string;
  readonly name: string;
  readonly line: ProductLine;
  readonly category: PolicyCategory;
  /** The marketing variety inside the line: 'Level term', 'Decreasing term', 'Open cover' … */
  readonly variety: string;
  /** One sentence on what the cover does. This is what a suitability review reads. */
  readonly blurb: string;
  readonly minAge: number;
  readonly maxAge: number;
  /** Gross annual premium per 1,000 of sum assured (or sum insured), in the local currency. */
  readonly baseRatePerThousand: string;
  readonly incomeMultiple?: number;
  readonly maxBmi?: number;
  readonly referralMarginYears?: number;
  readonly automaticBindingLimit?: string;
  readonly facultativeThreshold?: string;
  readonly aiStraightThroughLimit?: string;
  readonly defaultFunds?: readonly string[];
  readonly acceptedCountries?: readonly string[];
  readonly evidenceProfile?: keyof typeof EVIDENCE_PROFILES | string;
  readonly paymentBasis?: 'regular' | 'single' | 'payg';
}

export interface ProductLineDef {
  readonly id: ProductLine;
  readonly label: string;
  /** How the console groups the lines: a protection sale and a commercial sale read differently. */
  readonly family: 'life & protection' | 'health' | 'savings & investment' | 'motor & travel' | 'general & commercial' | 'marine & aviation' | 'group & employee benefits';
  readonly blurb: string;
}

export const PRODUCT_LINES: readonly ProductLineDef[] = [
  { id: 'life', label: 'Term life', family: 'life & protection', blurb: 'Death and permanent disability cover for a term: level, decreasing, increasing, convertible and whole of life.' },
  { id: 'critical-illness', label: 'Critical illness', family: 'life & protection', blurb: 'A lump sum on diagnosis of a listed condition — standalone, comprehensive, early-stage, multi-pay, women-specific and children\u2019s.' },
  { id: 'income-protection', label: 'Lifestyle & income protection', family: 'life & protection', blurb: 'Lifestyle plans that replace income or service a debt when the customer cannot work.' },
  { id: 'mortgage', label: 'Mortgage protection', family: 'life & protection', blurb: 'Cover tied to a home loan: redemption, level protection, protection with critical illness, and payment protection.' },
  { id: 'personal-accident', label: 'Personal accident', family: 'life & protection', blurb: 'Accidental death and disablement, with weekly indemnity — sold on its own or wrapped into a lifestyle plan.' },
  { id: 'medical', label: 'Medical & health', family: 'health', blurb: 'Inpatient, outpatient, maternity, dental and optical, international cover with evacuation, and group schemes.' },
  { id: 'endowment', label: 'Endowment & savings', family: 'savings & investment', blurb: 'A savings contract with cover attached: capital-back, education, retirement, short-term and unit-linked.' },
  { id: 'motor', label: 'Motor', family: 'motor & travel', blurb: 'Comprehensive, third-party, fleet and the pay-as-you-drive book billed by the day.' },
  { id: 'travel', label: 'Travel', family: 'motor & travel', blurb: 'Single trip, annual multi-trip, Schengen visa, family, senior and business travel.' },
  { id: 'home', label: 'Home & contents', family: 'general & commercial', blurb: 'Buildings, contents, renters, landlord, valuables and home emergency assistance.' },
  { id: 'property', label: 'Property & fire', family: 'general & commercial', blurb: 'Commercial fire and perils, all-risks property, burglary and theft.' },
  { id: 'liability', label: 'Liability', family: 'general & commercial', blurb: 'Public, employer\u2019s, product, professional indemnity and directors & officers.' },
  { id: 'engineering', label: 'Engineering', family: 'general & commercial', blurb: 'Contractors\u2019 all risk, erection all risk, machinery breakdown and boiler inspection cover.' },
  { id: 'general', label: 'General miscellaneous', family: 'general & commercial', blurb: 'Fidelity guarantee, money, glass, cyber and other lines that do not fit a class of their own.' },
  { id: 'marine', label: 'Marine cargo', family: 'marine & aviation', blurb: 'Cargo by voyage, open cover, air, land transit, storage and terminal operators\u2019 liability.' },
  { id: 'hull', label: 'Hull & aviation', family: 'marine & aviation', blurb: 'Hull and machinery, hull war risks, yacht, aircraft hull, P&I and offshore energy.' },
  { id: 'group', label: 'Group & employee benefits', family: 'group & employee benefits', blurb: 'Employer schemes: group term, group accident, group medical and the group takaful window.' },
];

export function lineDef(line: ProductLine): ProductLineDef {
  const found = PRODUCT_LINES.find((l) => l.id === line);
  if (!found) throw new Error(`unknown product line "${line}" — ${PRODUCT_LINES.length} lines are catalogued`);
  return found;
}

/** The default evidence profile for a line: life business asks for medicals, short-tail for a survey. */
export function evidenceProfileFor(line: ProductLine): string {
  switch (line) {
    case 'life': case 'endowment': case 'critical-illness': case 'income-protection':
    case 'mortgage': case 'personal-accident': case 'group':
      return 'life';
    case 'medical': return 'medical';
    default: return 'short-tail';
  }
}

/* ------------------------------------------------------------------ the catalogue */

const LIFE = Object.freeze({ automaticBindingLimit: '1,000,000.00', facultativeThreshold: '2,000,000.00', aiStraightThroughLimit: '500,000.00' });
const COMMERCIAL = Object.freeze({ automaticBindingLimit: '5,000,000.00', facultativeThreshold: '10,000,000.00', aiStraightThroughLimit: '1,000,000.00' });
const SMALL = Object.freeze({ automaticBindingLimit: '250,000.00', facultativeThreshold: '750,000.00', aiStraightThroughLimit: '100,000.00' });

export const PRODUCT_CATALOGUE: readonly ProductVariety[] = Object.freeze([
  /* ---- the five the demo world has always run: same ids, same names, same numbers ---- */
  { productId: 'PROD-UL-GLOBAL', name: 'Global Unit-Linked Plan', line: 'life', category: 'unit-linked', variety: 'Unit-linked', blurb: 'Regular-premium unit-linked plan invested across the global growth and balanced funds, with life cover charged per mille each month.', minAge: 18, maxAge: 65, baseRatePerThousand: '48.00', incomeMultiple: 25, defaultFunds: ['FGLOBAL', 'FBAL'], ...LIFE },
  { productId: 'PROD-LIFE-TERM', name: 'Level Term Life Protection', line: 'life', category: 'conventional', variety: 'Level term', blurb: 'A level sum assured for a fixed term: the sum assured does not fall and neither does the premium.', minAge: 18, maxAge: 65, baseRatePerThousand: '30.00', incomeMultiple: 20, ...LIFE },
  { productId: 'PROD-MEDICAL-GRP', name: 'Comprehensive Medical Cover', line: 'medical', category: 'conventional', variety: 'Group medical', blurb: 'Inpatient and outpatient treatment on a recognised network, with pre-authorisation for elective procedures.', minAge: 18, maxAge: 65, baseRatePerThousand: '30.00', incomeMultiple: 10, ...LIFE },
  { productId: 'PROD-TKF-FAMILY', name: 'Family Takaful Protection & Savings Plan', line: 'life', category: 'takaful', variety: 'Family takaful', blurb: 'Wakalah-based family takaful: part of each contribution is tabarru\u2019 into the participant risk fund, the rest is invested in the Shariah-screened equity fund.', minAge: 18, maxAge: 65, baseRatePerThousand: '36.00', incomeMultiple: 20, defaultFunds: ['TKF-EQ'], ...LIFE },
  { productId: 'PROD-MOTOR-PAYG', name: 'Pay-as-you-drive Motor Cover', line: 'motor', category: 'motor-payg', variety: 'Pay-as-you-drive', blurb: 'Micro-duration motor cover billed by the day and by the kilometre, charged only between an explicit start and stop.', minAge: 18, maxAge: 75, baseRatePerThousand: '20.00', incomeMultiple: 15, paymentBasis: 'payg', ...SMALL },

  /* ---- term life: the remaining varieties ---- */
  { productId: 'PROD-TERM-DECREASING', name: 'Decreasing Term Assurance', line: 'life', category: 'conventional', variety: 'Decreasing term', blurb: 'A sum assured that falls on a capital-repayment schedule, priced for a customer covering an amortising loan.', minAge: 20, maxAge: 70, baseRatePerThousand: '18.00', incomeMultiple: 25, ...LIFE },
  { productId: 'PROD-TERM-INCREASING', name: 'Index-Linked Increasing Term', line: 'life', category: 'conventional', variety: 'Increasing term', blurb: 'A sum assured that rises each year with a published index, so the cover keeps pace with the cost of living.', minAge: 18, maxAge: 65, baseRatePerThousand: '34.00', incomeMultiple: 20, ...LIFE },
  { productId: 'PROD-TERM-CONVERTIBLE', name: 'Convertible Term Assurance', line: 'life', category: 'conventional', variety: 'Convertible term', blurb: 'Level term carrying a contractual right to convert to a whole-life or endowment plan without fresh medical evidence.', minAge: 18, maxAge: 60, baseRatePerThousand: '32.00', incomeMultiple: 20, ...LIFE },
  { productId: 'PROD-TERM-WHOLE', name: 'Whole of Life Protection', line: 'life', category: 'conventional', variety: 'Whole of life', blurb: 'Cover that pays whenever death occurs, with a reviewable premium after the guaranteed period.', minAge: 18, maxAge: 75, baseRatePerThousand: '52.00', incomeMultiple: 15, ...LIFE },
  { productId: 'PROD-TERM-JOINT', name: 'Joint Life Term Cover', line: 'life', category: 'conventional', variety: 'Joint life', blurb: 'One sum assured over two lives, payable on the first death (or the second, if elected at issue).', minAge: 18, maxAge: 70, baseRatePerThousand: '44.00', incomeMultiple: 20, ...LIFE },
  { productId: 'PROD-TKF-TERM', name: 'Family Term Takaful', line: 'life', category: 'takaful', variety: 'Term takaful', blurb: 'Pure protection takaful: the whole contribution less wakalah fee goes to the participant risk fund as tabarru\u2019.', minAge: 18, maxAge: 65, baseRatePerThousand: '27.00', incomeMultiple: 20, acceptedCountries: ['AE', 'MY', 'SA', 'QA', 'KW', 'BH', 'OM', 'GB'], ...LIFE },

  /* ---- endowment & savings ---- */
  { productId: 'PROD-END-CAPITAL', name: 'Capital-Back Endowment Plan', line: 'endowment', category: 'conventional', variety: 'Capital back', blurb: 'A savings contract that returns the sum assured at maturity, with survival benefits paid at intervals along the way.', minAge: 18, maxAge: 60, baseRatePerThousand: '62.00', incomeMultiple: 15, paymentBasis: 'regular', ...LIFE },
  { productId: 'PROD-END-EDUCATION', name: 'Children\u2019s Education Endowment', line: 'endowment', category: 'conventional', variety: 'Education', blurb: 'A fund built to a child\u2019s university dates, with a waiver so the plan completes even if the paying parent dies.', minAge: 0, maxAge: 18, baseRatePerThousand: '70.00', incomeMultiple: 10, maxBmi: 40, ...SMALL },
  { productId: 'PROD-END-RETIREMENT', name: 'Retirement Endowment with Profits', line: 'endowment', category: 'conventional', variety: 'Retirement', blurb: 'A with-profits endowment that converts to an annuity or pays a lump sum at the elected retirement date.', minAge: 25, maxAge: 55, baseRatePerThousand: '68.00', incomeMultiple: 15, ...LIFE },
  { productId: 'PROD-END-SHORT', name: 'Five-Year Short Endowment', line: 'endowment', category: 'conventional', variety: 'Short endowment', blurb: 'A five-year savings contract with a single or regular premium and a guaranteed maturity value.', minAge: 18, maxAge: 70, baseRatePerThousand: '95.00', incomeMultiple: 10, paymentBasis: 'single', ...SMALL },
  { productId: 'PROD-END-MONEYBACK', name: 'Money-Back Endowment Plan', line: 'endowment', category: 'conventional', variety: 'Money back', blurb: 'A proportion of the sum assured is paid at each survival interval, the balance with bonuses at maturity.', minAge: 18, maxAge: 60, baseRatePerThousand: '74.00', incomeMultiple: 12, ...LIFE },
  { productId: 'PROD-UL-ENDOWMENT', name: 'Unit-Linked Wealth Endowment', line: 'endowment', category: 'unit-linked', variety: 'Unit-linked endowment', blurb: 'An endowment whose maturity value is the fund: units allocated at each dealing point, with a minimum death benefit guaranteed.', minAge: 18, maxAge: 65, baseRatePerThousand: '48.00', incomeMultiple: 25, defaultFunds: ['FGLOBAL', 'FBAL'], ...LIFE },
  { productId: 'PROD-TKF-ENDOWMENT', name: 'Takaful Education Savings Plan', line: 'endowment', category: 'takaful', variety: 'Education takaful', blurb: 'A Shariah-compliant education fund built in the participant investment fund, with tabarru\u2019 cover on the paying parent.', minAge: 18, maxAge: 60, baseRatePerThousand: '60.00', incomeMultiple: 12, defaultFunds: ['TKF-EQ'], acceptedCountries: ['AE', 'MY', 'SA', 'QA', 'KW', 'BH', 'OM', 'GB'], ...LIFE },

  /* ---- critical illness, in the varieties the market actually files ---- */
  { productId: 'PROD-CI-STANDALONE', name: 'Standalone Critical Illness Cover', line: 'critical-illness', category: 'conventional', variety: 'Standalone', blurb: 'A lump sum on first diagnosis of a condition on the filed schedule, independent of any life cover.', minAge: 18, maxAge: 65, baseRatePerThousand: '46.00', incomeMultiple: 15, ...LIFE },
  { productId: 'PROD-CI-COMPREHENSIVE', name: 'Comprehensive Critical Illness Cover', line: 'critical-illness', category: 'conventional', variety: 'Comprehensive', blurb: 'The widest filed condition schedule, including major organ failure, stroke and coronary artery bypass.', minAge: 18, maxAge: 65, baseRatePerThousand: '62.00', incomeMultiple: 15, ...LIFE },
  { productId: 'PROD-CI-EARLY', name: 'Early-Stage Critical Illness Cover', line: 'critical-illness', category: 'conventional', variety: 'Early stage', blurb: 'Pays a proportion of the sum assured at an early stage of a listed condition, and again at an advanced stage.', minAge: 18, maxAge: 60, baseRatePerThousand: '74.00', incomeMultiple: 12, ...LIFE },
  { productId: 'PROD-CI-MULTIPAY', name: 'Multi-Pay Critical Illness Cover', line: 'critical-illness', category: 'conventional', variety: 'Multi-pay', blurb: 'Pays once per condition group up to a stated number of claims, with a survival period between them.', minAge: 18, maxAge: 60, baseRatePerThousand: '88.00', incomeMultiple: 12, ...LIFE },
  { productId: 'PROD-CI-WOMEN', name: 'Women\u2019s Specific Critical Illness Cover', line: 'critical-illness', category: 'conventional', variety: 'Women-specific', blurb: 'Conditions specific to women, including the listed gynaecological cancers and complications of pregnancy.', minAge: 18, maxAge: 65, baseRatePerThousand: '54.00', incomeMultiple: 15, ...LIFE },
  { productId: 'PROD-CI-CHILD', name: 'Children\u2019s Critical Illness Cover', line: 'critical-illness', category: 'conventional', variety: 'Children', blurb: 'A lump sum on a child\u2019s diagnosis, with a parental accommodation benefit while the child is hospitalised.', minAge: 0, maxAge: 17, baseRatePerThousand: '38.00', incomeMultiple: 10, maxBmi: 40, ...SMALL },
  { productId: 'PROD-CI-TERM-BUNDLE', name: 'Term Life with Critical Illness Bundle', line: 'critical-illness', category: 'conventional', variety: 'Bundled rider', blurb: 'Level term life with critical illness cover attached as a rider, priced as one contract and one premium.', minAge: 18, maxAge: 65, baseRatePerThousand: '40.00', incomeMultiple: 20, ...LIFE },
  { productId: 'PROD-TKF-CI', name: 'Critical Illness Takaful', line: 'critical-illness', category: 'takaful', variety: 'Critical illness takaful', blurb: 'Wakalah-based critical illness cover out of the participant risk fund, with a Shariah-compliant condition schedule.', minAge: 18, maxAge: 65, baseRatePerThousand: '44.00', incomeMultiple: 15, acceptedCountries: ['AE', 'MY', 'SA', 'QA', 'KW', 'BH', 'OM', 'GB'], ...LIFE },

  /* ---- lifestyle & income protection ---- */
  { productId: 'PROD-IP-LIFESTYLE', name: 'Lifestyle Income Protection', line: 'income-protection', category: 'conventional', variety: 'Lifestyle income protection', blurb: 'A monthly benefit after a deferred period when illness or injury stops the customer working, to a stated retirement age.', minAge: 18, maxAge: 60, baseRatePerThousand: '30.00', incomeMultiple: 12, ...LIFE },
  { productId: 'PROD-IP-LOAN', name: 'Lifestyle Loan Protection', line: 'income-protection', category: 'conventional', variety: 'Loan protection', blurb: 'Services a named personal loan while the customer cannot work, up to the outstanding balance and a monthly cap.', minAge: 21, maxAge: 65, baseRatePerThousand: '12.00', incomeMultiple: 15, ...SMALL },
  { productId: 'PROD-IP-BUNDLE', name: 'Lifestyle Protection Plan', line: 'income-protection', category: 'conventional', variety: 'Lifestyle bundle', blurb: 'One plan carrying death, critical illness and income replacement, so a household is covered on all three axes.', minAge: 18, maxAge: 60, baseRatePerThousand: '58.00', incomeMultiple: 15, ...LIFE },
  { productId: 'PROD-UL-LIFESTYLE', name: 'Lifestyle Wealth Plan (Unit-Linked)', line: 'income-protection', category: 'unit-linked', variety: 'Lifestyle unit-linked', blurb: 'A lifestyle plan whose savings leg is invested in units, with the protection leg charged per mille from the fund.', minAge: 21, maxAge: 60, baseRatePerThousand: '46.00', incomeMultiple: 20, defaultFunds: ['FGLOBAL', 'FBAL'], ...LIFE },
  { productId: 'PROD-TKF-LIFESTYLE', name: 'Lifestyle Takaful Plan', line: 'income-protection', category: 'takaful', variety: 'Lifestyle takaful', blurb: 'A wakalah family takaful plan combining savings in the participant investment fund with tabarru\u2019 protection.', minAge: 18, maxAge: 60, baseRatePerThousand: '42.00', incomeMultiple: 18, defaultFunds: ['TKF-EQ'], acceptedCountries: ['AE', 'MY', 'SA', 'QA', 'KW', 'BH', 'OM', 'GB'], ...LIFE },

  /* ---- mortgage ---- */
  { productId: 'PROD-MTG-REDUCTION', name: 'Mortgage Redemption Plan', line: 'mortgage', category: 'conventional', variety: 'Mortgage redemption', blurb: 'A decreasing sum assured matched to the lender\u2019s amortisation schedule, assigned to the bank at issue.', minAge: 21, maxAge: 65, baseRatePerThousand: '14.00', incomeMultiple: 25, ...LIFE },
  { productId: 'PROD-MTG-PROTECTION', name: 'Mortgage Protection (Level)', line: 'mortgage', category: 'conventional', variety: 'Mortgage protection', blurb: 'A level sum assured over the mortgage term for a customer on an interest-only or bullet facility.', minAge: 21, maxAge: 65, baseRatePerThousand: '16.50', incomeMultiple: 25, ...LIFE },
  { productId: 'PROD-MTG-CI', name: 'Mortgage Protection with Critical Illness', line: 'mortgage', category: 'conventional', variety: 'Mortgage + critical illness', blurb: 'Mortgage protection that also clears the loan on a listed diagnosis, not only on death.', minAge: 21, maxAge: 60, baseRatePerThousand: '26.00', incomeMultiple: 20, ...LIFE },
  { productId: 'PROD-MTG-PAYMENT', name: 'Mortgage Payment Protection', line: 'mortgage', category: 'conventional', variety: 'Payment protection', blurb: 'Pays the mortgage instalment for a limited number of months after involuntary unemployment, illness or accident.', minAge: 21, maxAge: 60, baseRatePerThousand: '11.00', incomeMultiple: 15, ...SMALL },
  { productId: 'PROD-TKF-MORTGAGE', name: 'Mortgage Takaful Plan', line: 'mortgage', category: 'takaful', variety: 'Mortgage takaful', blurb: 'A decreasing takaful cover over a Shariah-compliant home finance facility, assigned to the financier.', minAge: 21, maxAge: 65, baseRatePerThousand: '13.50', incomeMultiple: 25, acceptedCountries: ['AE', 'MY', 'SA', 'QA', 'KW', 'BH', 'OM', 'GB'], ...LIFE },

  /* ---- medical & health ---- */
  { productId: 'PROD-MED-INDIVIDUAL', name: 'Individual Inpatient Medical', line: 'medical', category: 'conventional', variety: 'Individual inpatient', blurb: 'Hospital admission, surgery and day-case treatment on the network, with a stated room category.', minAge: 0, maxAge: 69, baseRatePerThousand: '42.00', incomeMultiple: 10, maxBmi: 40, ...SMALL },
  { productId: 'PROD-MED-OUTPATIENT', name: 'Outpatient & Inpatient Medical', line: 'medical', category: 'conventional', variety: 'Outpatient + inpatient', blurb: 'Inpatient cover plus consultations, diagnostics and pharmacy on the outpatient side, subject to a co-pay.', minAge: 0, maxAge: 69, baseRatePerThousand: '58.00', incomeMultiple: 10, maxBmi: 40, ...SMALL },
  { productId: 'PROD-MED-MATERNITY', name: 'Maternity & Newborn Cover', line: 'medical', category: 'conventional', variety: 'Maternity', blurb: 'Antenatal care, delivery and newborn care, with a waiting period before the first claim is payable.', minAge: 18, maxAge: 45, baseRatePerThousand: '66.00', incomeMultiple: 10, maxBmi: 40, ...SMALL },
  { productId: 'PROD-MED-DENTAL', name: 'Dental & Optical Care Plan', line: 'medical', category: 'conventional', variety: 'Dental & optical', blurb: 'Routine and major dental treatment plus optical correction, on an annual limit per discipline.', minAge: 0, maxAge: 75, baseRatePerThousand: '24.00', incomeMultiple: 8, maxBmi: 45, ...SMALL },
  { productId: 'PROD-MED-INTL', name: 'International Medical with Evacuation', line: 'medical', category: 'conventional', variety: 'International', blurb: 'Worldwide treatment including medical evacuation and repatriation, for a customer who travels or is posted abroad.', minAge: 0, maxAge: 75, baseRatePerThousand: '74.00', incomeMultiple: 10, acceptedCountries: WORLDWIDE, ...COMMERCIAL },
  { productId: 'PROD-MED-SME', name: 'SME Group Medical Scheme', line: 'medical', category: 'conventional', variety: 'Group medical (SME)', blurb: 'A staff medical scheme for a small employer, rated on the group\u2019s age profile rather than individual evidence.', minAge: 18, maxAge: 69, baseRatePerThousand: '34.00', incomeMultiple: 10, ...COMMERCIAL },
  { productId: 'PROD-MED-CORPORATE', name: 'Corporate Group Medical Scheme', line: 'medical', category: 'conventional', variety: 'Group medical (corporate)', blurb: 'A large-group scheme with a network tier per employee grade, experience-rated at renewal.', minAge: 18, maxAge: 69, baseRatePerThousand: '28.00', incomeMultiple: 10, ...COMMERCIAL },
  { productId: 'PROD-TKF-HEALTH', name: 'Health Takaful Plan', line: 'medical', category: 'takaful', variety: 'Health takaful', blurb: 'A wakalah health plan with claims paid from the participant risk fund and surplus shared back under the filed gates.', minAge: 0, maxAge: 69, baseRatePerThousand: '40.00', incomeMultiple: 10, acceptedCountries: ['AE', 'MY', 'SA', 'QA', 'KW', 'BH', 'OM', 'GB'], ...COMMERCIAL },

  /* ---- motor ---- */
  { productId: 'PROD-MOTOR-COMP', name: 'Comprehensive Motor Cover', line: 'motor', category: 'conventional', variety: 'Comprehensive', blurb: 'Own-damage and third-party cover for a private vehicle, with agency repair for the first years.', minAge: 18, maxAge: 75, baseRatePerThousand: '45.00', incomeMultiple: 10, evidenceProfile: 'short-tail', ...SMALL },
  { productId: 'PROD-MOTOR-TPL', name: 'Third-Party Liability Motor', line: 'motor', category: 'conventional', variety: 'Third-party liability', blurb: 'The statutory minimum: third-party bodily injury and property damage, with no own-damage cover.', minAge: 18, maxAge: 75, baseRatePerThousand: '15.00', incomeMultiple: 10, evidenceProfile: 'short-tail', ...SMALL },
  { productId: 'PROD-MOTOR-FLEET', name: 'Commercial Fleet Motor', line: 'motor', category: 'conventional', variety: 'Fleet', blurb: 'A whole fleet on one policy and one renewal date, rated on the schedule of vehicles and the claims history.', minAge: 21, maxAge: 70, baseRatePerThousand: '38.00', incomeMultiple: 10, evidenceProfile: 'short-tail', ...COMMERCIAL },

  /* ---- travel ---- */
  { productId: 'PROD-TRAVEL-SINGLE', name: 'Single-Trip Travel Cover', line: 'travel', category: 'conventional', variety: 'Single trip', blurb: 'Emergency medical, repatriation, cancellation and baggage for one journey, from the day of departure.', minAge: 0, maxAge: 85, baseRatePerThousand: '22.00', incomeMultiple: 8, acceptedCountries: WORLDWIDE, evidenceProfile: 'short-tail', paymentBasis: 'single', ...SMALL },
  { productId: 'PROD-TRAVEL-ANNUAL', name: 'Annual Multi-Trip Travel Cover', line: 'travel', category: 'conventional', variety: 'Annual multi-trip', blurb: 'Unlimited trips inside a twelve-month period, each up to a stated number of days.', minAge: 0, maxAge: 79, baseRatePerThousand: '34.00', incomeMultiple: 8, acceptedCountries: WORLDWIDE, evidenceProfile: 'short-tail', ...SMALL },
  { productId: 'PROD-TRAVEL-SCHENGEN', name: 'Schengen Visa Travel Cover', line: 'travel', category: 'conventional', variety: 'Schengen visa', blurb: 'The minimum medical and repatriation limit a Schengen visa application requires, with the certificate issued at once.', minAge: 0, maxAge: 85, baseRatePerThousand: '18.00', incomeMultiple: 8, acceptedCountries: WORLDWIDE, evidenceProfile: 'short-tail', paymentBasis: 'single', ...SMALL },
  { productId: 'PROD-TRAVEL-FAMILY', name: 'Family Travel Cover', line: 'travel', category: 'conventional', variety: 'Family', blurb: 'One policy for two adults and their dependent children travelling together, at a family rate.', minAge: 0, maxAge: 79, baseRatePerThousand: '30.00', incomeMultiple: 8, acceptedCountries: WORLDWIDE, evidenceProfile: 'short-tail', ...SMALL },
  { productId: 'PROD-TRAVEL-SENIOR', name: 'Senior Traveller Cover', line: 'travel', category: 'conventional', variety: 'Senior', blurb: 'Travel cover for the over-65s with a declared-condition questionnaire and a higher medical limit.', minAge: 65, maxAge: 85, baseRatePerThousand: '68.00', incomeMultiple: 6, acceptedCountries: WORLDWIDE, evidenceProfile: 'medical', ...SMALL },
  { productId: 'PROD-TRAVEL-BUSINESS', name: 'Business Travel & Accident Cover', line: 'travel', category: 'conventional', variety: 'Business', blurb: 'Corporate travel with accident benefits, equipment cover and a political-evacuation extension.', minAge: 18, maxAge: 75, baseRatePerThousand: '28.00', incomeMultiple: 10, acceptedCountries: WORLDWIDE, evidenceProfile: 'short-tail', ...COMMERCIAL },
  { productId: 'PROD-TKF-TRAVEL', name: 'Travel Takaful Plan', line: 'travel', category: 'takaful', variety: 'Travel takaful', blurb: 'A short-period travel takaful certificate with the contribution treated as tabarru\u2019 into the participant risk fund.', minAge: 0, maxAge: 79, baseRatePerThousand: '20.00', incomeMultiple: 8, acceptedCountries: WORLDWIDE, evidenceProfile: 'short-tail', ...SMALL },

  /* ---- personal accident ---- */
  { productId: 'PROD-PA-STANDARD', name: 'Personal Accident Cover', line: 'personal-accident', category: 'conventional', variety: 'Standard', blurb: 'Accidental death and permanent disablement on a scheduled scale, with a weekly indemnity while off work.', minAge: 18, maxAge: 65, baseRatePerThousand: '12.00', incomeMultiple: 15, ...SMALL },
  { productId: 'PROD-PA-EXECUTIVE', name: 'Executive Personal Accident', line: 'personal-accident', category: 'conventional', variety: 'Executive', blurb: 'Worldwide 24-hour accident cover for a named executive, with medical expenses and repatriation included.', minAge: 21, maxAge: 70, baseRatePerThousand: '18.00', incomeMultiple: 15, acceptedCountries: WORLDWIDE, ...COMMERCIAL },

  /* ---- general miscellaneous ---- */
  { productId: 'PROD-GEN-FIDELITY', name: 'Fidelity Guarantee', line: 'general', category: 'conventional', variety: 'Fidelity guarantee', blurb: 'Direct financial loss from an employee\u2019s dishonesty, named or on a blanket basis with a per-claim limit.', minAge: 18, maxAge: 99, baseRatePerThousand: '8.00', incomeMultiple: 5, evidenceProfile: 'short-tail', ...COMMERCIAL },
  { productId: 'PROD-GEN-MONEY', name: 'Money Insurance', line: 'general', category: 'conventional', variety: 'Money', blurb: 'Cash in transit and cash in safe, with an infidelity extension for a named custodian.', minAge: 18, maxAge: 99, baseRatePerThousand: '6.00', incomeMultiple: 5, evidenceProfile: 'short-tail', ...SMALL },
  { productId: 'PROD-GEN-GLASS', name: 'Plate Glass Cover', line: 'general', category: 'conventional', variety: 'Glass', blurb: 'Shopfront and signage glass on an all-risks basis, including the cost of temporary boarding up.', minAge: 18, maxAge: 99, baseRatePerThousand: '4.00', incomeMultiple: 5, evidenceProfile: 'short-tail', ...SMALL },
  { productId: 'PROD-GEN-CYBER', name: 'Cyber & Data Breach Cover', line: 'general', category: 'conventional', variety: 'Cyber', blurb: 'First-party incident response and business interruption, plus third-party liability for a data breach.', minAge: 18, maxAge: 99, baseRatePerThousand: '14.00', incomeMultiple: 5, evidenceProfile: 'short-tail', acceptedCountries: WORLDWIDE, ...COMMERCIAL },

  /* ---- property & fire ---- */
  { productId: 'PROD-PROP-FIRE', name: 'Fire & Perils Commercial Property', line: 'property', category: 'conventional', variety: 'Fire & perils', blurb: 'Buildings, plant and stock against fire and the named perils, at reinstatement or indemnity value as elected.', minAge: 18, maxAge: 99, baseRatePerThousand: '3.20', incomeMultiple: 5, evidenceProfile: 'short-tail', ...COMMERCIAL },
  { productId: 'PROD-PROP-ALLRISK', name: 'Property All-Risks Cover', line: 'property', category: 'conventional', variety: 'All risks', blurb: 'All-risks cover on scheduled property, with the standard exclusions and a per-item limit.', minAge: 18, maxAge: 99, baseRatePerThousand: '5.40', incomeMultiple: 5, evidenceProfile: 'short-tail', ...COMMERCIAL },
  { productId: 'PROD-PROP-BURGLARY', name: 'Burglary & Housebreaking Cover', line: 'property', category: 'conventional', variety: 'Burglary', blurb: 'Stock and contents lost to forcible and violent entry, with a warranty on the alarm and locks.', minAge: 18, maxAge: 99, baseRatePerThousand: '4.80', incomeMultiple: 5, evidenceProfile: 'short-tail', ...SMALL },

  /* ---- liability ---- */
  { productId: 'PROD-LIAB-PUBLIC', name: 'Public Liability', line: 'liability', category: 'conventional', variety: 'Public liability', blurb: 'Legal liability to third parties for bodily injury and property damage arising from the business.', minAge: 18, maxAge: 99, baseRatePerThousand: '7.50', incomeMultiple: 5, evidenceProfile: 'short-tail', ...COMMERCIAL },
  { productId: 'PROD-LIAB-EMPLOYER', name: 'Employer\u2019s Liability', line: 'liability', category: 'conventional', variety: 'Employer\u2019s liability', blurb: 'Liability for an employee\u2019s injury or disease arising out of employment, to the statutory limit.', minAge: 18, maxAge: 99, baseRatePerThousand: '6.20', incomeMultiple: 5, evidenceProfile: 'short-tail', ...COMMERCIAL },
  { productId: 'PROD-LIAB-PROFESSIONAL', name: 'Professional Indemnity', line: 'liability', category: 'conventional', variety: 'Professional indemnity', blurb: 'Negligent advice, design or supervision, on a claims-made basis with a stated retroactive date.', minAge: 21, maxAge: 99, baseRatePerThousand: '12.00', incomeMultiple: 5, evidenceProfile: 'short-tail', acceptedCountries: WORLDWIDE, ...COMMERCIAL },
  { productId: 'PROD-LIAB-PRODUCT', name: 'Product Liability', line: 'liability', category: 'conventional', variety: 'Product liability', blurb: 'Liability for injury or damage caused by a product supplied, with a recall extension available.', minAge: 18, maxAge: 99, baseRatePerThousand: '9.00', incomeMultiple: 5, evidenceProfile: 'short-tail', acceptedCountries: WORLDWIDE, ...COMMERCIAL },
  { productId: 'PROD-LIAB-DIRECTORS', name: 'Directors & Officers Liability', line: 'liability', category: 'conventional', variety: 'Directors & officers', blurb: 'Defence costs and damages for a wrongful act by a director or officer, with entity cover for securities claims.', minAge: 21, maxAge: 99, baseRatePerThousand: '15.00', incomeMultiple: 5, evidenceProfile: 'short-tail', acceptedCountries: WORLDWIDE, ...COMMERCIAL },

  /* ---- engineering ---- */
  { productId: 'PROD-ENG-CAR', name: 'Contractors\u2019 All Risk', line: 'engineering', category: 'conventional', variety: 'Contractors\u2019 all risk', blurb: 'The works, temporary works and materials on a construction site, with a maintenance period extension.', minAge: 18, maxAge: 99, baseRatePerThousand: '6.80', incomeMultiple: 5, evidenceProfile: 'short-tail', ...COMMERCIAL },
  { productId: 'PROD-ENG-EAR', name: 'Erection All Risk', line: 'engineering', category: 'conventional', variety: 'Erection all risk', blurb: 'Machinery and steelwork during erection, testing and commissioning, including the cost of re-erection.', minAge: 18, maxAge: 99, baseRatePerThousand: '7.60', incomeMultiple: 5, evidenceProfile: 'short-tail', ...COMMERCIAL },
  { productId: 'PROD-ENG-MACHINERY', name: 'Machinery Breakdown', line: 'engineering', category: 'conventional', variety: 'Machinery breakdown', blurb: 'Sudden and unforeseen physical damage to plant, with consequential loss available as an extension.', minAge: 18, maxAge: 99, baseRatePerThousand: '8.40', incomeMultiple: 5, evidenceProfile: 'short-tail', ...COMMERCIAL },
  { productId: 'PROD-ENG-BOILER', name: 'Boiler & Pressure Vessel Cover', line: 'engineering', category: 'conventional', variety: 'Boiler & pressure vessel', blurb: 'Inspection and explosion cover on boilers and pressure vessels, tied to the statutory inspection cycle.', minAge: 18, maxAge: 99, baseRatePerThousand: '5.20', incomeMultiple: 5, evidenceProfile: 'short-tail', ...COMMERCIAL },

  /* ---- marine cargo ---- */
  { productId: 'PROD-MAR-VOYAGE', name: 'Marine Cargo — Single Voyage', line: 'marine', category: 'conventional', variety: 'Voyage policy', blurb: 'One consignment on one voyage, on Institute Cargo Clauses A, B or C as elected.', minAge: 18, maxAge: 99, baseRatePerThousand: '3.60', incomeMultiple: 5, evidenceProfile: 'short-tail', acceptedCountries: WORLDWIDE, paymentBasis: 'single', ...COMMERCIAL },
  { productId: 'PROD-MAR-OPEN', name: 'Marine Cargo — Annual Open Cover', line: 'marine', category: 'conventional', variety: 'Open cover', blurb: 'All shipments declared under an annual contract, with a per-conveyance limit and monthly bordereaux.', minAge: 18, maxAge: 99, baseRatePerThousand: '2.90', incomeMultiple: 5, evidenceProfile: 'short-tail', acceptedCountries: WORLDWIDE, ...COMMERCIAL },
  { productId: 'PROD-MAR-AIR', name: 'Air Cargo Cover', line: 'marine', category: 'conventional', variety: 'Air cargo', blurb: 'Airfreight consignments on Institute Cargo Clauses (Air), including warehouse-to-warehouse transit.', minAge: 18, maxAge: 99, baseRatePerThousand: '3.20', incomeMultiple: 5, evidenceProfile: 'short-tail', acceptedCountries: WORLDWIDE, ...COMMERCIAL },
  { productId: 'PROD-MAR-LAND', name: 'Land Transit Cargo Cover', line: 'marine', category: 'conventional', variety: 'Land transit', blurb: 'Road and rail transit inside the country and across borders, with a conveyance warranty.', minAge: 18, maxAge: 99, baseRatePerThousand: '3.00', incomeMultiple: 5, evidenceProfile: 'short-tail', acceptedCountries: WORLDWIDE, ...COMMERCIAL },
  { productId: 'PROD-MAR-STORAGE', name: 'Cargo Storage Cover', line: 'marine', category: 'conventional', variety: 'Storage', blurb: 'Goods held in a warehouse or free zone between transits, on a stock-declaration basis.', minAge: 18, maxAge: 99, baseRatePerThousand: '2.40', incomeMultiple: 5, evidenceProfile: 'short-tail', acceptedCountries: WORLDWIDE, ...COMMERCIAL },
  { productId: 'PROD-MAR-TERMINAL', name: 'Terminal Operators\u2019 Liability', line: 'marine', category: 'conventional', variety: 'Terminal operators', blurb: 'Legal liability of a terminal or stevedore for cargo in its care, custody and control.', minAge: 18, maxAge: 99, baseRatePerThousand: '5.50', incomeMultiple: 5, evidenceProfile: 'short-tail', acceptedCountries: WORLDWIDE, ...COMMERCIAL },
  { productId: 'PROD-TKF-MARINE', name: 'Marine Cargo Takaful', line: 'marine', category: 'takaful', variety: 'Cargo takaful', blurb: 'Cargo cover written as takaful, with claims met from the participant risk fund and a wakalah fee to the operator.', minAge: 18, maxAge: 99, baseRatePerThousand: '3.40', incomeMultiple: 5, evidenceProfile: 'short-tail', acceptedCountries: WORLDWIDE, ...COMMERCIAL },

  /* ---- hull & aviation ---- */
  { productId: 'PROD-HULL-MARINE', name: 'Marine Hull & Machinery', line: 'hull', category: 'conventional', variety: 'Hull & machinery', blurb: 'The vessel itself, her machinery and equipment, on Institute Hull Clauses with a named deductible.', minAge: 18, maxAge: 99, baseRatePerThousand: '9.50', incomeMultiple: 5, evidenceProfile: 'short-tail', acceptedCountries: WORLDWIDE, ...COMMERCIAL },
  { productId: 'PROD-HULL-WAR', name: 'Hull War Risks', line: 'hull', category: 'conventional', variety: 'Hull war', blurb: 'War, strikes and related perils on the hull, written separately from the hull policy and cancellable at short notice.', minAge: 18, maxAge: 99, baseRatePerThousand: '4.20', incomeMultiple: 5, evidenceProfile: 'short-tail', acceptedCountries: WORLDWIDE, ...COMMERCIAL },
  { productId: 'PROD-HULL-YACHT', name: 'Yacht & Pleasure Craft Hull', line: 'hull', category: 'conventional', variety: 'Yacht hull', blurb: 'Hull, machinery and third-party liability for a pleasure craft, with a navigation warranty.', minAge: 18, maxAge: 99, baseRatePerThousand: '12.00', incomeMultiple: 5, evidenceProfile: 'short-tail', acceptedCountries: WORLDWIDE, ...SMALL },
  { productId: 'PROD-HULL-AIRCRAFT', name: 'Aircraft Hull Cover', line: 'hull', category: 'conventional', variety: 'Aircraft hull', blurb: 'Hull and spares for a fixed-wing or rotary aircraft, with a pilot-warranty and a grounded-risk option.', minAge: 18, maxAge: 99, baseRatePerThousand: '14.50', incomeMultiple: 5, evidenceProfile: 'short-tail', acceptedCountries: WORLDWIDE, ...COMMERCIAL },
  { productId: 'PROD-HULL-PANDI', name: 'Protection & Indemnity (P&I)', line: 'hull', category: 'conventional', variety: 'P&I', blurb: 'A shipowner\u2019s liability to crew, passengers, cargo interests and the environment, including wreck removal.', minAge: 18, maxAge: 99, baseRatePerThousand: '7.80', incomeMultiple: 5, evidenceProfile: 'short-tail', acceptedCountries: WORLDWIDE, ...COMMERCIAL },
  { productId: 'PROD-HULL-OFFSHORE', name: 'Offshore Energy Hull Cover', line: 'hull', category: 'conventional', variety: 'Offshore energy', blurb: 'Mobile offshore units, jack-ups and support vessels, with a well-control extension available.', minAge: 18, maxAge: 99, baseRatePerThousand: '11.00', incomeMultiple: 5, evidenceProfile: 'short-tail', acceptedCountries: WORLDWIDE, ...COMMERCIAL },

  /* ---- home & contents ---- */
  { productId: 'PROD-HOME-CONTENTS', name: 'Home Contents Cover', line: 'home', category: 'conventional', variety: 'Contents', blurb: 'Household contents against fire, theft, water damage and the named perils, with a single-article limit.', minAge: 18, maxAge: 99, baseRatePerThousand: '5.60', incomeMultiple: 5, evidenceProfile: 'short-tail', ...SMALL },
  { productId: 'PROD-HOME-COMPREHENSIVE', name: 'Homeowner\u2019s Comprehensive Cover', line: 'home', category: 'conventional', variety: 'Building + contents', blurb: 'The building and its contents on one policy, with alternative accommodation while the home is uninhabitable.', minAge: 18, maxAge: 99, baseRatePerThousand: '4.80', incomeMultiple: 5, evidenceProfile: 'short-tail', ...SMALL },
  { productId: 'PROD-HOME-RENTER', name: 'Renter\u2019s Contents Cover', line: 'home', category: 'conventional', variety: 'Renters', blurb: 'Contents cover for a tenant, with tenant\u2019s liability for damage to the landlord\u2019s property.', minAge: 18, maxAge: 99, baseRatePerThousand: '6.40', incomeMultiple: 5, evidenceProfile: 'short-tail', ...SMALL },
  { productId: 'PROD-HOME-LANDLORD', name: 'Landlord Building Cover', line: 'home', category: 'conventional', variety: 'Landlord', blurb: 'A let property\u2019s building and the landlord\u2019s liability, with a loss-of-rent extension.', minAge: 21, maxAge: 99, baseRatePerThousand: '4.20', incomeMultiple: 5, evidenceProfile: 'short-tail', ...SMALL },
  { productId: 'PROD-HOME-VALUABLES', name: 'Valuables & Jewellery All-Risk', line: 'home', category: 'conventional', variety: 'Valuables', blurb: 'Scheduled jewellery, watches and art on an all-risks basis, with a valuation certificate required per item.', minAge: 18, maxAge: 99, baseRatePerThousand: '12.50', incomeMultiple: 5, evidenceProfile: 'short-tail', acceptedCountries: WORLDWIDE, ...SMALL },
  { productId: 'PROD-HOME-EMERGENCY', name: 'Home Emergency Assistance', line: 'home', category: 'conventional', variety: 'Home emergency', blurb: 'Call-out and repair for a plumbing, electrical or air-conditioning failure, on an annual limit per trade.', minAge: 18, maxAge: 99, baseRatePerThousand: '3.80', incomeMultiple: 5, evidenceProfile: 'short-tail', ...SMALL },
  { productId: 'PROD-TKF-HOME', name: 'Home Takaful Plan', line: 'home', category: 'takaful', variety: 'Home takaful', blurb: 'Building and contents cover written as takaful, with the contribution split between tabarru\u2019 and wakalah fee.', minAge: 18, maxAge: 99, baseRatePerThousand: '5.00', incomeMultiple: 5, evidenceProfile: 'short-tail', acceptedCountries: ['AE', 'MY', 'SA', 'QA', 'KW', 'BH', 'OM', 'GB'], ...SMALL },

  /* ---- group & employee benefits ---- */
  { productId: 'PROD-GRP-TERM', name: 'Group Term Life Scheme', line: 'group', category: 'conventional', variety: 'Group term', blurb: 'A free-cover limit per member with a scheme rate on the group\u2019s age profile, and a dependent option.', minAge: 18, maxAge: 65, baseRatePerThousand: '22.00', incomeMultiple: 20, ...COMMERCIAL },
  { productId: 'PROD-GRP-PA', name: 'Group Personal Accident Scheme', line: 'group', category: 'conventional', variety: 'Group accident', blurb: 'Accident benefits for a defined employee group, rated flat per head with no individual evidence.', minAge: 18, maxAge: 70, baseRatePerThousand: '9.00', incomeMultiple: 15, ...COMMERCIAL },
  { productId: 'PROD-GRP-CI', name: 'Group Critical Illness Scheme', line: 'group', category: 'conventional', variety: 'Group critical illness', blurb: 'A uniform critical illness sum assured for every member of the group, paid on first diagnosis.', minAge: 18, maxAge: 65, baseRatePerThousand: '32.00', incomeMultiple: 15, ...COMMERCIAL },
  { productId: 'PROD-TKF-GROUP', name: 'Group Family Takaful Scheme', line: 'group', category: 'takaful', variety: 'Group takaful', blurb: 'An employee takaful scheme: contributions are tabarru\u2019 into a scheme-specific participant risk fund.', minAge: 18, maxAge: 65, baseRatePerThousand: '20.00', incomeMultiple: 18, acceptedCountries: ['AE', 'MY', 'SA', 'QA', 'KW', 'BH', 'OM', 'GB'], ...COMMERCIAL },
]);

/** The varieties of one line, in catalogue order. */
export function varietiesFor(line: ProductLine): ProductVariety[] {
  return PRODUCT_CATALOGUE.filter((p) => p.line === line);
}

export function productVariety(productId: string): ProductVariety | undefined {
  const key = productId.trim().toUpperCase();
  return PRODUCT_CATALOGUE.find((p) => p.productId === key);
}

/** How many varieties the catalogue holds per line — what the master-settings screen reports. */
export function catalogueByLine(): Array<{ line: ProductLine; label: string; family: string; count: number; productIds: string[] }> {
  return PRODUCT_LINES.map((l) => {
    const varieties = varietiesFor(l.id);
    return { line: l.id, label: l.label, family: l.family, count: varieties.length, productIds: varieties.map((v) => v.productId) };
  });
}

export const CATALOGUE_LIMITS = Object.freeze({ life: LIFE, commercial: COMMERCIAL, small: SMALL });
