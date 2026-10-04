/**
 * The demo world: one tenant, two entities (conventional + takaful window), real funds with
 * market look-through, a unit-linked policy that has been premium-paid, charged, switched and
 * partially withdrawn, a pay-as-you-go motor policy with start/stop cover, a takaful book with
 * a qard and a gated surplus run, a consented partner lookup, an ingestion load and an AI ledger.
 *
 * Everything the UI and the tests read comes from here, so the console and the tests can never
 * disagree about what the platform does.
 */
import { Ledger, posting } from './ledger.js';
import { buildChart, defineIntercompany } from './chart.js';
import { ClaimsEngine } from './claims.js';
import { ProductRules, RiskProfile, UnderwritingEngine } from './underwriting.js';
import { DatedFx, GroupConsolidator, RateTable, ConsolidatedReport } from './groupfinance.js';
import { Money, money, zero, formatAmount, toDecimalString, sub, abs as absMoney } from './money.js';
import { unitsFromDecimal, unitsToDecimal } from './units.js';
import { NavEngine, singlePriceFund, FundDef } from './fund.js';
import { DEFAULT_CHARGES, UnitLinkedEngine, PolicyMeta } from './unitlinked.js';
import { BillingEngine } from './billing.js';
import { TakafulEngine, TakafulProductConfig } from './takaful.js';
import { Party, PartyRegistry } from './party.js';
import { LabelRegistry, Locale } from './labels.js';
import { applyBps } from './money.js';
import { AE_PACK, comparisonMatrix, preSaleCheck, QuoteOffer } from './regulatory.js';
import { REINSURANCE_SEED, TreatyRegister } from './reinsurance.js';
import { ExtractEngine, IssuedExtract, formatCell } from './extracts.js';
import { PlacementFacts, UAE_RULES, UaeRuleBook, ratingRank } from './uae.js';
import { WordingBook, WordingDocument, WordingFacts } from './wording.js';
import { AE_FILING_WINDOWS, Submission, SubmissionPack, SubmissionRegister } from './submission.js';
import { IngestionFabric } from './ingest.js';
import { AgentRuntime } from './ai.js';
import { ExtractionResult, readChip, ocrDocument, onboard } from './onboarding.js';
import { DecisionTheatre } from './decisioning.js';

export interface World {
  readonly tenant: { id: string; name: string };
  readonly entities: Array<{ id: string; name: string; type: 'conventional' | 'takaful'; currency: string; regulator: string }>;
  readonly ledger: Ledger;
  readonly nav: NavEngine;
  readonly unitLinked: UnitLinkedEngine;
  readonly billing: BillingEngine;
  readonly takaful: TakafulEngine;
  readonly claims: ClaimsEngine;
  readonly takafulClaims: ClaimsEngine;
  readonly underwriting: UnderwritingEngine;
  readonly reinsurance: TreatyRegister;      // conventional treaties
  readonly retakaful: TreatyRegister;        // the takaful window's own treaties, kept apart
  readonly extracts: ExtractEngine;          // regulatory, actuarial and bordereau extracts, issued and kept
  readonly rules: UaeRuleBook;               // the UAE reinsurance rule book, and every decision taken under it
  readonly wording: WordingBook;             // generated letters and notices, with their mandated wording
  readonly submissions: SubmissionRegister;  // what was filed with the supervisor, and what came back
  readonly takafulSubmissions: SubmissionRegister;  // the window files its own return, from its own fund
  readonly takafulExtracts: ExtractEngine;   // the window files its own return, from its own fund

  readonly group: GroupConsolidator;
  readonly groupRates: RateTable;
  readonly parties: PartyRegistry;
  readonly labels: LabelRegistry;
  readonly ingest: IngestionFabric;
  readonly ai: AgentRuntime;
  readonly decider: DecisionTheatre;
  readonly asOf: string;
  readonly conventionalEntity: string;
  readonly takafulEntity: string;
  readonly malaysiaEntity: string;
  readonly groupPeriodStart: string;
  readonly consentId: string;
  readonly onboarding: { readonly chip: ExtractionResult; readonly ocr: ExtractionResult };
  readonly quotes: QuoteOffer[];
}

const DAYS = ['2026-09-29', '2026-09-30', '2026-10-01', '2026-10-02', '2026-10-05'];

export function buildWorld(): World {
  const tenant = { id: 'alkhaleej', name: 'Al Khaleej Insurance Group' };
  const currency = 'AED';
  const ledger = new Ledger(currency);
  ledger.registerFx({ from: 'USD', to: 'AED', numerator: 367n, denominator: 100n, asOf: '2026-09-01' });
  ledger.registerFx({ from: 'MYR', to: 'AED', numerator: 82n, denominator: 100n, asOf: '2026-09-01' });

  const conventionalEntity = 'ALK-CONV';
  const takafulEntity = 'ALK-TKF';
  const convFunds = ['FGLOBAL', 'FBAL'];
  const tkfFunds = ['TKF-EQ'];
  const malaysiaEntity = 'ALK-MY';
  const convChart = buildChart(ledger, conventionalEntity, currency, convFunds);
  const tkfChart = buildChart(ledger, takafulEntity, currency, [...tkfFunds, 'PRF', 'PIF', 'OPF']);
  const myChart = buildChart(ledger, malaysiaEntity, 'MYR', []);
  defineIntercompany(ledger, conventionalEntity, currency, [takafulEntity, malaysiaEntity]);
  defineIntercompany(ledger, takafulEntity, currency, [conventionalEntity]);
  defineIntercompany(ledger, malaysiaEntity, 'MYR', [conventionalEntity]);

  /* Paid-up capital. An insurer with no capital is not an insurer: every entity here starts with
     the shareholders' money in, posted the way the regulator expects to see it. */
  ledger.post({
    id: 'CAP-CONV-2026', entityId: conventionalEntity, at: '2026-01-02T09:00:00+04:00', recordedAt: '2026-01-02T09:00:00+04:00',
    source: 'gl', sourceRef: 'CAP-2026', description: 'Paid-up share capital received',
    postings: [
      posting(convChart.cash(), 'debit', money(10_000_000_00, currency)),
      posting(convChart.shareCapital(), 'credit', money(10_000_000_00, currency)),
    ],
  });
  ledger.post({
    id: 'CAP-TKF-2026', entityId: takafulEntity, at: '2026-01-02T09:00:00+04:00', recordedAt: '2026-01-02T09:00:00+04:00',
    source: 'gl', sourceRef: 'CAP-2026', description: 'Operator capital contributed to the takaful window',
    postings: [
      posting(tkfChart.cash(), 'debit', money(3_000_000_00, currency)),
      posting(tkfChart.shareCapital(), 'credit', money(3_000_000_00, currency)),
    ],
  });
  ledger.post({
    id: 'CAP-MY-2026', entityId: malaysiaEntity, at: '2026-01-05T09:00:00+08:00', recordedAt: '2026-01-05T09:00:00+08:00',
    source: 'gl', sourceRef: 'CAP-MY-2026', description: 'Paid-up capital of the Malaysian subsidiary',
    postings: [
      // Capital came in at the 2026-01-01 rate of 0.85, which is why equity carries a
      // historical rate while the balance sheet is translated at 0.82.
      posting(myChart.cash(), 'debit', money(5_000_000_00, 'MYR'), money(4_250_000_00, currency)),
      posting(myChart.shareCapital(), 'credit', money(5_000_000_00, 'MYR'), money(4_250_000_00, currency)),
    ],
  });

  const nav = new NavEngine();
  nav.defineInstrument({ id: 'EMAAR', name: 'Emaar Properties', assetClass: 'equity', isin: 'AEE000301011', shariahScreened: true });
  nav.defineInstrument({ id: 'FAB', name: 'First Abu Dhabi Bank', assetClass: 'equity', isin: 'AEE000801020', shariahScreened: false });
  nav.defineInstrument({ id: 'SUKUK-AE', name: 'UAE Federal Sukuk 2030', assetClass: 'sukuk', shariahScreened: true });
  nav.defineInstrument({ id: 'GLD-ETF', name: 'Gold ETF (physical)', assetClass: 'commodity', shariahScreened: true });
  nav.defineInstrument({ id: 'US-EQ', name: 'Global Equity Index Fund', assetClass: 'equity', isin: 'IE00B4L5Y983', shariahScreened: false });
  const prices: Array<[string, number]> = [['EMAAR', 8.42], ['FAB', 13.15], ['SUKUK-AE', 101.2], ['GLD-ETF', 92.4], ['US-EQ', 78.9]];
  for (const day of DAYS) {
    for (const [instrumentId, base] of prices) {
      const wobble = (DAYS.indexOf(day) - 2) * 0.011;
      nav.recordMarketPrice({ instrumentId, asOf: day, price: Math.round(base * (1 + wobble) * 100) / 100, currency });
    }
  }

  const fundDefs: FundDef[] = [
    singlePriceFund('FGLOBAL', 'Global Growth Fund', currency, {
      benchmark: 'MSCI World', fmcBpsAnnual: 150,
      composition: [
        { instrumentId: 'US-EQ', weightBps: 5500 },
        { instrumentId: 'EMAAR', weightBps: 2000 },
        { instrumentId: 'FAB', weightBps: 1500 },
        { instrumentId: 'SUKUK-AE', weightBps: 1000 },
      ],
    }),
    singlePriceFund('FBAL', 'Balanced Income Fund', currency, {
      benchmark: '30% equity / 70% sukuk', fmcBpsAnnual: 110,
      composition: [
        { instrumentId: 'SUKUK-AE', weightBps: 6000 },
        { instrumentId: 'GLD-ETF', weightBps: 1500 },
        { instrumentId: 'EMAAR', weightBps: 1500 },
        { instrumentId: 'US-EQ', weightBps: 1000 },
      ],
    }),
    singlePriceFund('TKF-EQ', 'Al Khaleej Shariah Equity Fund', currency, {
      benchmark: 'FTSE Shariah UAE', fmcBpsAnnual: 140, shariahScreened: true,
      composition: [
        { instrumentId: 'EMAAR', weightBps: 4500 },
        { instrumentId: 'SUKUK-AE', weightBps: 3500 },
        { instrumentId: 'GLD-ETF', weightBps: 2000 },
      ],
    }),
  ];
  for (const f of fundDefs) nav.defineFund(f);

  // Units in issue and a starting asset base, then four published valuations that move with the market.
  const unitsFGLOBAL = unitsFromDecimal('118450.123456');
  const unitsFBAL = unitsFromDecimal('76210.500000');
  const unitsTKFEQ = unitsFromDecimal('42150.250000');
  const assetPath: Record<string, number[]> = {
    FGLOBAL: [1241050, 1246900, 1252100, 1258040, 1261890],
    FBAL: [800180, 801020, 801860, 802540, 803210],
    'TKF-EQ': [442100, 442980, 443910, 444620, 445110],
  };
  DAYS.forEach((day, i) => {
    nav.publishValuation({
      fundId: 'FGLOBAL', valuationDate: day, grossAssets: money(assetPath.FGLOBAL![i]!, currency),
      liabilities: money(3100, currency), unitsInIssue: unitsFGLOBAL, source: 'administrator file (fmc accrued)',
    });
    nav.publishValuation({
      fundId: 'FBAL', valuationDate: day, grossAssets: money(assetPath.FBAL![i]!, currency),
      liabilities: money(2200, currency), unitsInIssue: unitsFBAL, source: 'administrator file (fmc accrued)',
    });
    nav.publishValuation({
      fundId: 'TKF-EQ', valuationDate: day, grossAssets: money(assetPath['TKF-EQ']![i]!, currency),
      liabilities: money(1400, currency), unitsInIssue: unitsTKFEQ, source: 'administrator file (fmc accrued)',
    });
  });

  const unitLinked = new UnitLinkedEngine(nav, ledger, convChart, DEFAULT_CHARGES);
  const meta: PolicyMeta = {
    policyId: 'UL-000123', entityId: conventionalEntity, productId: 'PROD-UL-GLOBAL', currency,
    commencement: '2026-09-29', sumAssured: money(250000_00, currency),
    autoRebalanceMonths: 6,
    targetWeights: [{ fundId: 'FGLOBAL', weightBps: 7000 }, { fundId: 'FBAL', weightBps: 3000 }],
  };
  unitLinked.openPolicy(meta, [{ fundId: 'FGLOBAL' }, { fundId: 'FBAL' }]);
  unitLinked.payPremium({ policyId: 'UL-000123', premium: money(12000_00, currency), fundId: 'FGLOBAL', instructionAt: '2026-09-29T09:40:00+04:00' });
  unitLinked.payPremium({ policyId: 'UL-000123', premium: money(12000_00, currency), fundId: 'FBAL', instructionAt: '2026-09-30T11:05:00+04:00' });
  unitLinked.chargePolicy({ policyId: 'UL-000123', fundId: 'FGLOBAL', code: 'admin', amount: money(25_00, currency), instructionAt: '2026-09-30T12:00:00+04:00', basis: 'monthly administration fee' });
  unitLinked.chargePolicy({ policyId: 'UL-000123', fundId: 'FGLOBAL', code: 'coi', amount: money(187_50, currency), instructionAt: '2026-10-01T12:00:00+04:00', basis: '0.9 per mille of sum assured, monthly' });
  unitLinked.switchFund({ policyId: 'UL-000123', fromFundId: 'FGLOBAL', toFundId: 'FBAL', amount: money(3000_00, currency), instructionAt: '2026-09-30T15:30:00+04:00' });
  unitLinked.switchFund({ policyId: 'UL-000123', fromFundId: 'FGLOBAL', toFundId: 'FBAL', amount: money(1500_00, currency), instructionAt: '2026-10-01T16:20:00+04:00' });
  unitLinked.partialWithdraw({ policyId: 'UL-000123', fundId: 'FBAL', amount: money(1000_00, currency), instructionAt: '2026-10-01T10:15:00+04:00' });

  const billing = new BillingEngine(currency);
  billing.openWallet('MTR-0441', money(500_00, currency));
  const motorSegment = billing.createSegment({
    policyId: 'MTR-0441', productId: 'PROD-MOTOR-PAYG', mode: 'start-stop', dailyRate: money(12_50, currency),
    usageRatePerUnit: money(35, currency), tariffVersion: 'MOTOR-AE-2026.1', autoStart: false, graceDays: 3,
  });
  billing.startCover(motorSegment.id, '2026-10-01T08:00:00+04:00');
  billing.tick('2026-10-03T10:00:00+04:00');
  billing.recordUsage({ segmentId: motorSegment.id, units: 120, at: '2026-10-05T09:00:00+04:00', note: '120 km driven this week' });
  billing.stopCover(motorSegment.id, '2026-10-03T11:00:00+04:00');
  const scheduledSegment = billing.createSegment({
    policyId: 'MTR-0441', productId: 'PROD-MOTOR-PAYG', mode: 'daily', dailyRate: money(9_75, currency),
    tariffVersion: 'MOTOR-AE-2026.1', autoStart: true, graceDays: 2,
  });
  billing.scheduleStart(scheduledSegment.id, '2026-10-10T00:00:00+04:00');
  billing.scheduleStop(scheduledSegment.id, '2026-10-20T00:00:00+04:00');

  const takaful = new TakafulEngine(ledger, tkfChart, takafulEntity, currency);
  const tkfConfig: TakafulProductConfig = {
    productId: 'PROD-TKF-FAMILY', model: 'wakalah', wakalahFeeBps: 2000, mudarabahProfitShareBps: 0,
    tabarruBps: 3000, surplusParticipantShareBps: 7000, allowsSurplusToSavers: false, jurisdiction: 'AE',
  };
  takaful.contribute({ policyId: 'TK-9001', contribution: money(3000_00, currency), at: '2026-09-25T09:00:00+04:00', config: tkfConfig });
  takaful.contribute({ policyId: 'TK-9001', contribution: money(3000_00, currency), at: '2026-10-01T09:00:00+04:00', config: tkfConfig });
  takaful.payClaim({ claimId: 'CLM-TKF-77', amount: money(1500_00, currency), at: '2026-10-02T10:00:00+04:00' });
  takaful.contribute({ policyId: 'TK-9402', contribution: money(3000_00, currency), at: '2026-10-03T09:00:00+04:00', config: tkfConfig });
  takaful.repayQard({ qardId: (takaful.listQards()[0]?.id ?? 'TKF-QARD-000001'), amount: money(2000n, currency), at: '2026-10-03T15:00:00+04:00' });

  /* Claims. The live claim is routed through the same pool settler the takaful engine exposes,
     so a takaful claim keeps the workflow here and the money in the participants' risk fund. */
  const claims = new ClaimsEngine(ledger, convChart, conventionalEntity, currency);
  const motorClaim = claims.register({
    policyId: 'MTR-0441', cause: 'motor', lossDate: '2026-09-18', reportedAt: '2026-09-19',
    description: 'Rear-end collision on Sheikh Zayed Road; third-party report and photos attached',
  });
  claims.triage(motorClaim.id, { coverInForce: true, exclusionsApplied: [], daysLate: 1, fraudSignals: 0 });
  claims.setReserve(motorClaim.id, { amount: money(1200_00, currency), at: '2026-09-20T09:30:00+04:00', by: 'reserving-desk' });
  claims.approve(motorClaim.id, { amount: money(1150_00, currency), at: '2026-09-24T11:00:00+04:00', by: 'Fatima Al Zaabi', role: 'claims-officer' });
  claims.settle(motorClaim.id, { amount: money(1150_00, currency), at: '2026-09-26T10:00:00+04:00', by: 'finance-ops' });
  claims.recover(motorClaim.id, { type: 'salvage', amount: money(180_00, currency), at: '2026-10-01T09:00:00+04:00' });

  const ciClaim = claims.register({
    policyId: 'UL-000123', cause: 'critical-illness', lossDate: '2026-08-03', reportedAt: '2026-08-05',
    description: 'Critical illness notified; medical evidence requested from the treating hospital',
  });
  claims.triage(ciClaim.id, { coverInForce: true, exclusionsApplied: [], daysLate: 2, fraudSignals: 1 });
  claims.setReserve(ciClaim.id, { amount: money(15000_00, currency), at: '2026-08-08T09:00:00+04:00', by: 'claims-manager', rationale: 'Reserve set from the severity table pending medical evidence' });
  claims.approve(ciClaim.id, { amount: money(400_00, currency), at: '2026-08-09T09:00:00+04:00', by: 'agent/claims-triage', role: 'ai-straight-through', isAi: true });

  const takafulClaims = new ClaimsEngine(ledger, tkfChart, takafulEntity, currency, {
    poolSettler: (c, amount, at) => takaful.settlePoolClaim(c, amount, at),
  });
  const tkfClaim = takafulClaims.register({
    policyId: 'TK-9001', cause: 'medical', lossDate: '2026-09-28', reportedAt: '2026-09-29', fundId: 'PRF',
    description: 'Hospital admission for a participant; discharge summary and invoice attached',
  });
  takafulClaims.triage(tkfClaim.id, { coverInForce: true, exclusionsApplied: [], daysLate: 1, fraudSignals: 0 });
  takafulClaims.approve(tkfClaim.id, { amount: money(400_00, currency), at: '2026-10-01T09:00:00+04:00', by: 'agent/claims-triage', role: 'ai-straight-through', isAi: true });
  takafulClaims.settle(tkfClaim.id, { amount: money(400_00, currency), at: '2026-10-02T12:00:00+04:00', by: 'finance-ops' });

  /* Underwriting. Two manuals, four applications: a clean acceptance, a rated life, a case that
     reaches the reinsurer, and one an AI agent accepts inside its own limit — nothing more. */
  const LIFE_MANUAL: ProductRules = {
    productId: 'PROD-LIFE-TERM', line: 'life',
    minAge: 18, maxAge: 65, referralMarginYears: 5, maxBmi: 32,
    acceptedCountries: ['AE', 'MY', 'GB'], standardOccupations: [1, 2],
    baseRatePerThousandMinor: 3_000n, incomeMultiple: 20,
    automaticBindingLimitMinor: 1_000_000_00n, facultativeThresholdMinor: 2_000_000_00n,
    evidenceBands: [
      { fromAge: 40, fromSumAssuredMinor: 500_000_00n, requirements: ['blood profile', 'urine analysis'] },
      { fromAge: 55, fromSumAssuredMinor: 100_000_00n, requirements: ['ECG', 'treadmill test'] },
    ],
    aiStraightThroughMinor: 500_000_00n,
  };
  const MEDICAL_MANUAL: ProductRules = { ...LIFE_MANUAL, productId: 'PROD-MEDICAL-GRP', line: 'medical', incomeMultiple: 10 };
  const underwriting = new UnderwritingEngine(new Map([[LIFE_MANUAL.productId, LIFE_MANUAL], [MEDICAL_MANUAL.productId, MEDICAL_MANUAL]]), currency);

  const profileOf = (overrides: Partial<RiskProfile> = {}): RiskProfile => ({
    partyId: 'PTY-0001', age: 38, sex: 'male', smoker: false, heightCm: 178, weightKg: 78,
    occupationClass: 1, pursuits: [], conditions: [], familyHistory: [],
    residenceCountry: 'AE', annualIncome: money(30_000_00, currency), ...overrides,
  });

  const cleanApp = underwriting.register({ partyId: 'PTY-0001', productId: 'PROD-LIFE-TERM', sumAssured: money(250_000_00, currency), at: '2026-09-20T10:00:00+04:00', profile: profileOf() });
  underwriting.decide(cleanApp.id, { at: '2026-09-20T10:05:00+04:00', by: 'senior-underwriter' });

  const ratedApp = underwriting.register({
    partyId: 'PTY-0002', productId: 'PROD-LIFE-TERM', sumAssured: money(300_000_00, currency), at: '2026-09-22T10:00:00+04:00',
    profile: profileOf({ partyId: 'PTY-0002', smoker: true, conditions: ['diabetes-type-2'], occupationClass: 3 }),
  });
  underwriting.decide(ratedApp.id, { at: '2026-09-22T10:30:00+04:00', by: 'senior-underwriter' });

  const referralApp = underwriting.register({
    partyId: 'PTY-0003', productId: 'PROD-LIFE-TERM', sumAssured: money(2_500_000_00, currency), at: '2026-09-30T10:00:00+04:00',
    profile: profileOf({ partyId: 'PTY-0003', age: 57, conditions: ['cardiac-history'], occupationClass: 3, annualIncome: money(400_000_00, currency) }),
  });
  underwriting.assess(referralApp.id);   // assessed, waiting on a human and the reinsurance desk

  const aiApp = underwriting.register({
    partyId: 'PTY-0004', productId: 'PROD-LIFE-TERM', sumAssured: money(120_000_00, currency), at: '2026-10-01T10:00:00+04:00',
    profile: profileOf({ partyId: 'PTY-0004', age: 29 }),
  });
  underwriting.decide(aiApp.id, { at: '2026-10-01T10:00:05+04:00', by: 'agent/quote-bot', isAi: true });

  /* Reinsurance and retakaful. The company does not keep the whole risk: a quota share carries a
     quarter of it, a surplus treaty takes the lines above a 200,000 retention, a catastrophe cover
     stands behind the whole book, and the retakaful operator carries a fifth of the takaful window's
     risk. Every cession is posted, so the books show what was given away and what came back. */
  const reinsurance = new TreatyRegister(ledger, conventionalEntity, currency);
  for (const treaty of REINSURANCE_SEED) {
    if (treaty.basis === 'conventional') reinsurance.register({ ...treaty, currency });
  }
  const retakaful = new TreatyRegister(ledger, takafulEntity, currency);
  for (const treaty of REINSURANCE_SEED) {
    if (treaty.basis === 'takaful') retakaful.register({ ...treaty, currency });
  }
  // Regulatory and actuarial reporting. The window gets its own engine, so a return filed for the
  // participant risk fund can never report a dirham of the operator's money.
  const extracts = new ExtractEngine({
    ledger, entityId: conventionalEntity, currency, basis: 'conventional', jurisdiction: 'AE',
    register: reinsurance, claims,
  });
  const takafulExtracts = new ExtractEngine({
    ledger, entityId: takafulEntity, currency, basis: 'takaful', jurisdiction: 'AE',
    register: retakaful, claims: takafulClaims,
  });

  // The UAE reinsurance rule book. Every placement the desk makes goes past it, and what it answers
  // is kept: the five decisions below are the world as it stands — two allowed, one held for a human,
  // two refused — and each one names the rule, quotes the instrument and states its evidence.
  const rules = new UaeRuleBook();
  const onFile = [
    'home-state licence certificate', 'CBUAE licence extract', 'rating agency report',
    'approved retention and reinsurance plan', 'board minute of the annual review',
    'shariah committee approval', 'head office certificate', 'bank guarantee',
  ];
  const plan = { approved: true, reviewedAt: '2026-02-10' };
  rules.enforce({
    subject: 'QS-25-2026 cession of LIFE-0001 and the motor book',
    at: '2026-09-30', by: 'reinsurance/life-desk', basis: 'conventional',
    counterparty: { name: 'Emirates Re', licensedIn: 'AE', licenceClass: 'all', rating: 'A', ratingAgency: 'S&P' },
    cession: { treatyId: 'QS-25-2026', kind: 'quota-share', lineOfBusiness: 'life', shareBps: 2_500 },
    retentionPlan: plan, documents: onFile,
  });
  rules.enforce({
    subject: 'RTKF-QS-20 cession of TKF-0001',
    at: '2026-09-30', by: 'takaful/reinsurance-desk', basis: 'takaful',
    counterparty: { name: 'MENA Retakaful', licensedIn: 'foreign', licenceClass: 'all', rating: 'A-', ratingAgency: 'S&P', retakaful: true },
    cession: { treatyId: 'RTKF-QS-20', kind: 'quota-share', lineOfBusiness: 'life', shareBps: 2_000 },
    retentionPlan: plan, documents: onFile,
  });
  rules.enforce({
    subject: 'FAC-MOTOR facultative offer from Gulf Reinsurance PSC',
    at: '2026-10-02', by: 'reinsurance/motor-desk', basis: 'conventional',
    counterparty: { name: 'Gulf Reinsurance PSC', licensedIn: 'foreign', licenceClass: 'all' },
    cession: { treatyId: 'FAC-MOTOR', kind: 'facultative', lineOfBusiness: 'motor', shareBps: 4_000 },
    retentionPlan: plan, documents: ['home-state licence certificate', 'CBUAE licence extract', 'approved retention and reinsurance plan', 'board minute of the annual review'],
  });
  rules.enforce({
    subject: 'an attempt to place participant money with a conventional reinsurer',
    at: '2026-10-05', by: 'takaful/reinsurance-desk', basis: 'takaful',
    counterparty: { name: 'Emirates Re', licensedIn: 'AE', licenceClass: 'all', rating: 'A' },
    cession: { treatyId: 'RTKF-QS-20', kind: 'quota-share', lineOfBusiness: 'life', shareBps: 2_000 },
    retentionPlan: plan, documents: onFile,
  });
  rules.enforce({
    subject: 'an offshore placement offered on the strength of a letterhead',
    at: '2026-10-05', by: 'reinsurance/motor-desk', basis: 'conventional',
    counterparty: { name: 'Oriana Re (unlicensed)', licensedIn: 'unlicensed', rating: 'A' },
    cession: { treatyId: 'FAC-MOTOR', kind: 'facultative', lineOfBusiness: 'motor', shareBps: 4_000 },
    retentionPlan: plan, documents: ['approved retention and reinsurance plan', 'board minute of the annual review'],
  });

  // Filing with the supervisor. The register recomputes the return from the books before it accepts
  // a pack, so a return that has moved since it was issued cannot be filed in its old form.
  const submissions = new SubmissionRegister({
    windows: AE_FILING_WINDOWS,
    verify: (extractId) => extracts.verify(extractId),
  });
  const takafulSubmissions = new SubmissionRegister({
    windows: AE_FILING_WINDOWS,
    verify: (extractId) => takafulExtracts.verify(extractId),
  });

  // Wording, generated from the same label registry the screens read: a rename in the takaful scope
  // changes what a field is called in the letters that scope sends, and never a mandated paragraph.
  const wording = new WordingBook({
    resolve: (key, locale, scope) => labels.t(key, locale, undefined, scope === 'takaful' ? `${tenant.id}:${takafulEntity}` : 'default'),
  });

  const ratedDecision = underwriting.decisionFor(ratedApp.id)!;
  const cleanDecision = underwriting.decisionFor(cleanApp.id)!;

  // Quota share: a quarter of the rated life case, ceded at the premium actually charged.
  const quotaCession = reinsurance.cedePremium({
    treatyId: 'QS-25-2026', policyId: ratedApp.id, riskId: `LIFE-${ratedDecision.partyId}`,
    sumInsured: ratedDecision.sumAssured, premium: ratedDecision.loadedPremium,
    lineOfBusiness: 'life', at: '2026-09-30T09:00:00+04:00', basis: 'conventional', by: 'reinsurance/desk',
  });
  // Surplus: the clean case sits above the 200,000 retention, so the first line of the treaty takes it.
  const surplusCession = reinsurance.cedePremium({
    treatyId: 'SURPLUS-10', policyId: cleanApp.id, riskId: `LIFE-${cleanDecision.partyId}`,
    sumInsured: cleanDecision.sumAssured, premium: cleanDecision.standardPremium,
    lineOfBusiness: 'life', at: '2026-09-30T09:05:00+04:00', basis: 'conventional', by: 'reinsurance/desk',
  });
  // The motor book is inside the quota share too, so the claim on it comes back part-paid.
  const motorPremium = billing.statement('MTR-0441').total;
  const motorCession = reinsurance.cedePremium({
    treatyId: 'QS-25-2026', policyId: 'MTR-0441', riskId: 'MTR-0441',
    sumInsured: money(250_000_00, currency), premium: motorPremium,
    lineOfBusiness: 'motor', at: '2026-09-30T09:10:00+04:00', basis: 'conventional', by: 'reinsurance/desk',
  });
  const motorRecovery = reinsurance.recoverClaim({
    policyId: 'MTR-0441', claim: claims, claimId: motorClaim.id,
    paid: money(1150_00, currency), at: '2026-10-02T09:00:00+04:00', by: 'recovery-desk',
  });
  // A catastrophe: the motor book takes a 1,600,000 storm loss, the treaty's 1,000,000 retention is
  // ours and Emirates Re carries the next 600,000 of it. That cover is then reinstated — free, the
  // first one — and the second reinstatement would cost half the annual premium pro rata.
  const catastrophes = [
    { eventId: 'STORM-ALPHAI', loss: money(1_600_000_00, currency), at: '2026-09-15T10:00:00+04:00' },
  ];
  for (const event of catastrophes) {
    reinsurance.recoverEvent('XOL-CAT-5M', { ...event, by: 'catastrophe-desk' });
    reinsurance.reinstate('XOL-CAT-5M', { at: '2026-09-16T09:00:00+04:00', by: 'reinsurance/desk' });
  }
  // The aggregate stop loss is deposit accounted: the premium paid on account is an asset, not an
  // expense, and the period is settled later against the real subject premium at the agreed rate on
  // line. Two instalments are on account here; the settlement is left to the console, because a
  // screen that shows the return premium appear is worth more than a figure already baked in.
  reinsurance.openDeposit('AGG-SL-DEPOSIT', { amount: money(200_000_00, currency), at: '2026-01-12T10:00:00+04:00', instalment: 1 });
  reinsurance.openDeposit('AGG-SL-DEPOSIT', { amount: money(100_000_00, currency), at: '2026-07-01T10:00:00+04:00', instalment: 2 });

  // Emirates Re pays 450,000 of the 600,000 during September; the rest is still owed, and by the
  // time the console is opened it is past the treaty's 60-day terms. That is what ageing is for.
  const stormRecovery = reinsurance.eventRecoveryList()[0]!;
  reinsurance.settleRecovery({ recoveryId: stormRecovery.journalId, amount: money(450_000_00, currency), at: '2026-09-30T10:00:00+04:00', by: 'treasury' });

  // Security behind the reinsurers' promises. A quarter share of the ceded premium is withheld rather
  // than paid; behind the catastrophe treaty sit two letters of credit, one of which lapses inside
  // thirty days; and the retakaful operator posts cash, which earns no interest here and never will.
  // Emirates Re then turns out to be 60,000 short of what its own treaty requires — while it is already
  // six days late paying us 150,000 — and the desk calls for it.
  reinsurance.holdSecurity({
    counterparty: 'Gulf Reinsurance PSC', treatyId: 'QS-25-2026', kind: 'funds-withheld',
    amount: money(1_500_00, currency), at: '2026-10-01T09:00:00+04:00', reference: 'FUNDS-WITHHELD-Q3', by: 'treasury',
  });
  reinsurance.holdSecurity({
    counterparty: 'Emirates Re', treatyId: 'XOL-CAT-5M', kind: 'letter-of-credit',
    amount: money(60_000_00, currency), at: '2026-06-01T09:00:00+04:00', expiresAt: '2026-12-31', reference: 'LC-88213', by: 'treasury',
  });
  reinsurance.holdSecurity({
    counterparty: 'Emirates Re', treatyId: 'XOL-CAT-5M', kind: 'letter-of-credit',
    amount: money(30_000_00, currency), at: '2026-04-01T09:00:00+04:00', expiresAt: '2026-10-20', reference: 'LC-77420', by: 'treasury',
  });
  reinsurance.holdSecurity({
    counterparty: 'Emirates Re', treatyId: 'XOL-CAT-5M', kind: 'cash',
    amount: money(10_000_00, currency), at: '2026-01-05T09:00:00+04:00', reference: 'CASH-SECURITY-2026', by: 'treasury',
  });
  retakaful.holdSecurity({
    counterparty: 'Takaful Re International', treatyId: 'RTKF-QS-20', kind: 'cash', fundId: 'PRF',
    amount: money(90_00, currency), at: '2026-10-01T09:05:00+04:00', reference: 'RTKF-SECURITY-2026', by: 'treasury',
  });
  reinsurance.callSecurity({
    counterparty: 'Emirates Re', at: '2026-10-01T11:00:00+04:00',
    reason: 'the catastrophe recovery is unsecured beyond the letters of credit in force',
    by: 'treasury',
  });

  // Retakaful is ceded on the tabarru that went into the risk fund, and the journal carries the fund.
  const tabarru = applyBps(money(6000_00, currency), tkfConfig.tabarruBps);   // the two TK-9001 contributions
  const retakafulCession = retakaful.cedePremium({
    treatyId: 'RTKF-QS-20', policyId: 'TK-9001', riskId: 'TK-9001',
    sumInsured: money(500_000_00, currency), premium: tabarru,
    lineOfBusiness: 'life', at: '2026-10-03T09:15:00+04:00', basis: 'takaful', by: 'retakaful/desk', fundId: 'PRF',
  });

  /* A Malaysian subsidiary, reporting in ringgit, and the intercompany charges between the three
     entities — including one that the two books do not agree on, so the consolidation has to show
     it as in transit instead of pretending it evens out. Foreign postings carry their base amount,
     which is the ledger's own discipline. */
  ledger.post({
    id: 'MY-J-1', entityId: malaysiaEntity, at: '2026-09-12T09:00:00+08:00', recordedAt: '2026-09-12T09:00:00+08:00',
    source: 'unitlinked', sourceRef: 'MY-POL-1001', description: 'Contribution received MYR 200,000.00',
    postings: [
      posting(myChart.cash(), 'debit', money(200_000_00, 'MYR'), money(164_000_00, currency)),
      posting(myChart.premiumIncome(), 'credit', money(200_000_00, 'MYR'), money(164_000_00, currency)),
    ],
  });
  ledger.post({
    id: 'MY-J-2', entityId: malaysiaEntity, at: '2026-09-20T09:00:00+08:00', recordedAt: '2026-09-20T09:00:00+08:00',
    source: 'groupfinance', sourceRef: 'IC-MY-1', description: 'Intercompany management fee to the conventional carrier',
    postings: [
      posting(myChart.icExpense(conventionalEntity), 'debit', money(20_000_00, 'MYR'), money(16_400_00, currency)),
      posting(myChart.icPayable(conventionalEntity), 'credit', money(20_000_00, 'MYR'), money(16_400_00, currency)),
    ],
  });
  ledger.post({
    id: 'CONV-J-IC-1', entityId: conventionalEntity, at: '2026-09-20T09:00:00+04:00', recordedAt: '2026-09-20T09:00:00+04:00',
    source: 'groupfinance', sourceRef: 'IC-MY-1', description: 'Intercompany management fee receivable from the Malaysian subsidiary',
    postings: [
      // Deliberately short of the payable: the group must show the gap, not hide it.
      posting(convChart.icReceivable(malaysiaEntity), 'debit', money(4_600_00, currency)),
      posting(convChart.icIncome(malaysiaEntity), 'credit', money(4_600_00, currency)),
    ],
  });
  ledger.post({
    id: 'CONV-J-IC-2', entityId: conventionalEntity, at: '2026-09-25T09:00:00+04:00', recordedAt: '2026-09-25T09:00:00+04:00',
    source: 'groupfinance', sourceRef: 'IC-TKF-1', description: 'Management fee receivable from the takaful window',
    postings: [
      posting(convChart.icReceivable(takafulEntity), 'debit', money(2_500_00, currency)),
      posting(convChart.icIncome(takafulEntity), 'credit', money(2_500_00, currency)),
    ],
  });
  ledger.post({
    id: 'TKF-J-IC-1', entityId: takafulEntity, at: '2026-09-25T09:00:00+04:00', recordedAt: '2026-09-25T09:00:00+04:00',
    source: 'groupfinance', sourceRef: 'IC-TKF-1', description: 'Management fee payable to the conventional carrier',
    postings: [
      posting(tkfChart.icExpense(conventionalEntity), 'debit', money(2_500_00, currency)),
      posting(tkfChart.icPayable(conventionalEntity), 'credit', money(2_500_00, currency)),
    ],
  });

  /* Group finance: three entities, two currencies, one set of books at the top. The rate table is
     dated, because a consolidation needs a closing rate, an average rate and historical rates. */
  const groupRates = new RateTable(currency, [
    // A rate from the start of the year, so equity has a *historical* rate and the translation
    // reserve is a genuine number rather than a rounding scrap.
    { from: 'MYR', to: 'AED', numerator: 85n, denominator: 100n, asOf: '2026-01-01' },
    { from: 'MYR', to: 'AED', numerator: 84n, denominator: 100n, asOf: '2026-09-01' },
    { from: 'MYR', to: 'AED', numerator: 82n, denominator: 100n, asOf: '2026-09-30' },
    { from: 'USD', to: 'AED', numerator: 367n, denominator: 100n, asOf: '2026-09-01' },
  ] as DatedFx[]);
  const group = new GroupConsolidator(ledger, {
    groupCurrency: currency, groupEntityId: 'GRP',
    entities: [
      { entityId: conventionalEntity, name: 'Al Khaleej Insurance (conventional)', functionalCurrency: currency, ownershipPct: 100, chart: convChart },
      { entityId: takafulEntity, name: 'Al Khaleej Takaful Window', functionalCurrency: currency, ownershipPct: 100, chart: tkfChart },
      { entityId: malaysiaEntity, name: 'Al Khaleej Malaysia (subsidiary)', functionalCurrency: 'MYR', ownershipPct: 70, chart: myChart },
    ],
    rates: groupRates,
  });
  group.consolidate({ asOf: '2026-10-05', periodStart: '2026-09-01' });


  const parties = new PartyRegistry(tenant.id);
  const ahmed: Party = {
    id: 'PTY-0001', kind: 'person', names: { en: 'Ahmed Al Mansoori', ar: 'أحمد المنصوري' }, dateOfBirth: '1985-04-12',
    ids: [
      { type: 'emirates-id', value: '784-1985-1234567-1', country: 'AE', source: 'chip', confidence: 0.999 },
      { type: 'driving-licence', value: 'DL-AE-99120', country: 'AE', source: 'ocr', confidence: 0.94 },
    ],
    phones: ['+971 50 123 4567'], emails: ['ahmed.mansoori@example.ae'],
    addresses: [{ line: 'Villa 12, Al Barsha 2', city: 'Dubai', country: 'AE' }],
    roles: ['policyholder', 'life-assured'],
  };
  const sara: Party = {
    id: 'PTY-0002', kind: 'person', names: { en: 'Sara Khalifa', ar: 'سارة خليفة' }, dateOfBirth: '1990-11-02',
    ids: [{ type: 'emirates-id', value: '784-1990-7654321-9', country: 'AE', source: 'government-lookup', confidence: 0.98 }],
    phones: ['+971 55 987 6543'], emails: ['sara.khalifa@example.ae'],
    addresses: [{ line: 'Al Maryah Island, Tower 4', city: 'Abu Dhabi', country: 'AE' }], roles: ['policyholder'],
  };
  parties.upsert(ahmed); parties.upsert(sara);
  parties.recordHoldings('PTY-0001', [
    { policyId: 'UL-000123', productName: 'Global Unit-Linked Plan', entityId: conventionalEntity, status: 'in force', currency },
    { policyId: 'MTR-0441', productName: 'Pay-as-you-drive Motor', entityId: conventionalEntity, status: 'active cover', currency },
  ]);
  parties.recordHoldings('PTY-0002', [
    { policyId: 'TK-9001', productName: 'Family Takaful Plan', entityId: takafulEntity, status: 'in force', currency },
  ]);
  const consent = parties.grantConsent({
    partyId: 'PTY-0001', grantedTo: 'DXB-BROKER-01', purpose: 'Avoid creating a duplicate customer record',
    scopes: ['customer.exists', 'customer.name', 'customer.holdings'], grantedAt: '2026-09-20T08:00:00+04:00',
    expiresAt: '2027-09-20T08:00:00+04:00', evidence: 'signed e-consent CN-88213',
  });

  const labels = new LabelRegistry();
  labels.renameMany('alkhaleej', LabelRegistry.TAKAFUL_REnames('en'), 'system:takaful-window', '2026-09-01T00:00:00Z');
  labels.renameMany('alkhaleej:ALK-TKF', LabelRegistry.TAKAFUL_REnames('en'), 'system:takaful-window', '2026-09-01T00:00:00Z');

  const ingest = new IngestionFabric((load) => {
    const notes: string[] = [];
    if (load.result.stats.quarantined > 0) notes.push(`Supervisor: ${load.result.stats.quarantined} row(s) held back — data quality, not a system failure.`);
    return notes;
  });
  const csv = [
    'full_name,emirates_id,email,phone,date_of_birth',
    'Ahmed Al Mansoori,784-1985-1234567-1,ahmed.mansoori@example.ae,+971 50 123 4567,1985-04-12',
    'Sara Khalifa,784-1990-7654321-9,sara.khalifa@example.ae,+971 55 987 6543,1990-11-02',
    'Omar Hassan,784-1978-1112223-4,not-an-email,+971 52 111 2222,1978-06-21',
    ',784-1999-0000000-0,,,',
    'Ahmed Al Mansoori,784-1985-1234567-1,ahmed.mansoori@example.ae,+971 50 123 4567,1985-04-12',
  ].join('\n');
  ingest.submit({
    loadId: 'LOAD-2026-10-03-001', source: 'broker file (CSV)', submittedAt: '2026-10-03T07:30:00+04:00', text: csv,
    mapping: {
      source: 'DXB-BROKER-01', entityType: 'customer',
      fields: [
        { name: 'full_name', type: 'string', required: true },
        { name: 'emirates_id', type: 'id', required: true },
        { name: 'email', type: 'email', required: true },
        { name: 'phone', type: 'phone' },
        { name: 'date_of_birth', type: 'date' },
      ],
      naturalKeys: ['emirates_id'],
    },
  });
  ingest.commit('LOAD-2026-10-03-001', '2026-10-03T07:45:00+04:00');

  const ai = new AgentRuntime(tenant.id);
  ai.propose({
    agent: 'doc-intake-v3', module: 'onboarding', intent: 'classify-document', riskClass: 'low',
    at: '2026-10-03T08:00:00+04:00', inputs: { pages: 2, kind: 'emirates-id' },
    output: { documentKind: 'emirates-id', confidence: 0.97 }, dryRun: false, costUsd: 0.02,
  });
  const triage = ai.propose({
    agent: 'claims-triage-v2', module: 'claims', intent: 'suggest-reserve', riskClass: 'high',
    at: '2026-10-03T08:05:00+04:00', inputs: { claimId: 'CLM-TKF-77', benefit: 'death', age: 38 },
    output: { suggestedReserveMinor: 110000, basis: 'benefit schedule plus outstanding medicals' }, dryRun: false, costUsd: 0.11,
  });
  ai.propose({
    agent: 'rogue-validator', module: 'ingest', intent: 'approve-claim-payment', riskClass: 'high',
    at: '2026-10-03T08:06:00+04:00', inputs: { claimId: 'CLM-TKF-77' }, output: { amountMinor: 110000 }, dryRun: false, costUsd: 0.01,
  });

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const chip: ExtractionResult = readChip('emirates-id', {
    fullName: 'أحمد المنصوري', idNumber: '784-1985-1234567-1', nationality: 'United Arab Emirates',
    dateOfBirth: '1985-04-12', expiry: '2028-06-30', sponsor: '—',
  });
  const ocr: ExtractionResult = ocrDocument('driving-licence', {
    fullName: ['Ahmed Al Mansoori', 'Ahmed Al Mansoori', 'Ahmed Al Mansoori'],
    licenceNumber: ['DL-AE-99120', 'DL-AE-9912O', 'DL-AE-99120'],
    expiry: ['2027-03-15', '2027-03-15', '2027-03-15'],
  });
  onboard({ sessionId: 'OB-2026-10-03-9', documents: [chip, ocr], targetLocale: 'en', needAnalysisCompleted: true, consentCaptured: true });

  const quotes: QuoteOffer[] = [
    { insurer: 'Al Khaleej', product: 'Motor Comprehensive Plus', premium: 2450, excess: 500, benefits: ['agency repair', 'GCC cover', '24/7 roadside'], serviceRating: 5, complaintsPer10k: 3 },
    { insurer: 'Gulf Union', product: 'Motor Comprehensive', premium: 2210, excess: 750, benefits: ['agency repair', 'roadside'], serviceRating: 4, complaintsPer10k: 7 },
    { insurer: 'Orient Direct', product: 'Motor Third Party Plus', premium: 1350, excess: 1000, benefits: ['third party', 'fire and theft'], serviceRating: 3, complaintsPer10k: 12 },
  ];

  // Two letters on file: the conventional book's bordereau cover note, and the window's treaty note —
  // the second with the takaful scope's own words for a contribution, and the same mandated paragraph
  // about fund segregation in both languages.
  wording.generate({
    type: 'bordereau-cover',
    facts: {
      scope: 'conventional', locale: 'en', packVersion: AE_PACK.version, at: '2026-10-05T17:10:00+04:00',
      by: 'finance/reporting', entityName: 'Al Khaleej Insurance (conventional)', counterparty: 'Emirates Re',
      period: `${DAYS[DAYS.length - 1]!.slice(0, 4)}-01-01 to ${DAYS[DAYS.length - 1]}`,
      fields: [
        { key: 'policy.premium', required: true, value: formatAmount(money(3_819_63, currency)) },
        { key: 'policy.sumAssured', required: true, value: formatAmount(money(250_000_00, currency)) },
        { key: 'fund.value', required: false, value: formatAmount(money(10_627_173, currency)) },
      ],
      tiesTo: ['GET /api/extracts (RS-A, RS-D)', 'ALK-CONV:REINS:CEDED-PREMIUM'],
    },
  });
  wording.generate({
    type: 'treaty-note',
    facts: {
      scope: 'takaful', locale: 'en', packVersion: AE_PACK.version, at: '2026-10-05T17:20:00+04:00',
      by: 'takaful/reinsurance-desk', entityName: 'Al Khaleej Takaful Window', counterparty: 'MENA Retakaful',
      period: `${DAYS[DAYS.length - 1]!.slice(0, 4)}-01-01 to ${DAYS[DAYS.length - 1]}`,
      fields: [
        { key: 'policy.contribution', required: true, value: formatAmount(money(1_800_00, currency)) },
        { key: 'takaful.riskFund', required: true, value: 'Participant risk fund (segregated from the operator)' },
        { key: 'takaful.operator', required: true, value: 'Al Khaleej Takaful (operator)' },
      ],
      tiesTo: ['GET /api/extracts (the window files its own return)', 'ALK-TKF:REINS:CEDED-PREMIUM'],
    },
  });

  return {
    tenant, entities: [
      { id: conventionalEntity, name: 'Al Khaleej Insurance (conventional)', type: 'conventional', currency, regulator: 'CBUAE' },
      { id: takafulEntity, name: 'Al Khaleej Takaful Window', type: 'takaful', currency, regulator: 'CBUAE / Shariah Committee' },
    ],
    ledger, nav, unitLinked, billing, takaful, claims, takafulClaims, underwriting, reinsurance, retakaful,
    extracts, takafulExtracts, rules, wording, submissions, takafulSubmissions,
    group, groupRates, parties, labels, ingest, ai,
    decider: new DecisionTheatre(nav, unitLinked, DEFAULT_CHARGES),
    asOf: '2026-10-05', conventionalEntity, takafulEntity, malaysiaEntity, groupPeriodStart: '2026-09-01',
    consentId: consent.id, onboarding: { chip, ocr }, quotes,
  };
}

/* ------------------------------------------------------------ projections */

/** Underwriting, in the shape the console and the API both read. */
export function underwritingSnapshot(engine: UnderwritingEngine, asOf: string) {
  const book = engine.bookPremium();
  return {
    book: {
      policies: book.policies,
      standard: formatAmount(book.standard),
      loaded: formatAmount(book.loaded),
      extra: formatAmount(book.extra),
    },
    queue: engine.queue().map((q) => ({ ...q })),
    cession: engine.cessionSchedule().map((c) => ({ ...c, totalSumAssuredLabel: formatAmount(c.totalSumAssured) })),
    share: engine.reinsuranceShare(2_500).map((s) => ({ ...s, cededLabel: formatAmount(s.ceded), retainedLabel: formatAmount(s.retained) })),
    exposure: ['PTY-0001', 'PTY-0002', 'PTY-0003', 'PTY-0004'].map((partyId) => {
      const exposure = engine.aggregateExposure(partyId);
      return {
        partyId, policies: exposure.policies,
        totalSumAssured: formatAmount(exposure.totalSumAssured),
        withinAutomaticLimit: exposure.withinAutomaticLimit,
        facultativeRequired: exposure.facultativeRequired,
      };
    }),
    applications: engine.list().map((a) => {
      const assessment = a.decision ?? engine.assess(a.id);
      return {
        id: a.id, partyId: a.partyId, productId: a.productId, at: a.at,
        age: a.profile.age, smoker: a.profile.smoker, bmi: engine.bmi(a.profile),
        occupationClass: a.profile.occupationClass, conditions: [...a.profile.conditions], pursuits: [...a.profile.pursuits],
        sumAssured: formatAmount(a.sumAssured),
        outcome: assessment.outcome,
        decidedBy: assessment.decidedBy || null,
        decidedByAi: assessment.decidedByAi,
        extraMortalityBps: assessment.extraMortalityBps,
        standardPremium: formatAmount(assessment.standardPremium),
        loadedPremium: formatAmount(assessment.loadedPremium),
        exclusions: [...assessment.exclusions],
        evidence: [...assessment.evidence],
        referrals: [...assessment.referrals],
        reinsurance: { mode: assessment.reinsurance.mode, threshold: formatAmount(assessment.reinsurance.threshold), note: assessment.reinsurance.note },
        reasons: assessment.reasons.map((r) => ({ code: r.code, detail: r.detail, source: r.source, referral: r.referral === true })),
      };
    }),
    asOf,
  };
}

/** The consolidation, in the shape the console and the API read. */
export function groupSnapshot(w: World, post: boolean) {
  const report = w.group.consolidate({ asOf: w.asOf, periodStart: w.groupPeriodStart, post });
  return {
    asOf: report.asOf,
    periodStart: report.periodStart,
    groupCurrency: report.groupCurrency,
    entities: report.entities.map((e) => ({
      entityId: e.entityId, name: e.name, functionalCurrency: e.functionalCurrency, ownershipPct: e.ownershipPct,
      netAssets: formatAmount(e.netAssets), income: formatAmount(e.income), translationReserve: formatAmount(e.cta),
      closingRate: e.closingRate, averageRate: e.averageRate, accounts: e.lines.length,
    })),
    intercompany: {
      balances: report.intercompany.balances.map((b) => ({
        receivableEntity: b.receivableEntity, payableEntity: b.payableEntity,
        receivable: formatAmount(b.receivable), payable: formatAmount(b.payable),
        eliminated: formatAmount(b.eliminated), difference: formatAmount(b.difference),
        differenceAbs: formatAmount(absMoney(b.difference)),
        direction: b.difference.minor === 0n ? 'agrees' : (b.difference.minor > 0n ? 'receivable larger' : 'payable larger'),
      })),
      incomeAndExpense: report.intercompany.incomeAndExpense.map((p) => ({
        earningEntity: p.earningEntity, chargedEntity: p.chargedEntity,
        income: formatAmount(p.income), expense: formatAmount(p.expense),
        eliminated: formatAmount(p.eliminated), difference: formatAmount(p.difference),
      })),
    },
    nci: report.nci.map((n) => ({ ...n, shareOfNetAssets: formatAmount(n.shareOfNetAssets) })),
    eliminations: {
      journals: [...report.eliminations.journals],
      matched: formatAmount(report.eliminations.matched),
      inTransit: formatAmount(report.eliminations.inTransit),
      notes: [...report.eliminations.notes],
    },
    group: {
      totals: {
        assets: formatAmount(report.group.totals.assets),
        liabilities: formatAmount(report.group.totals.liabilities),
        equity: formatAmount(report.group.totals.equity),
        income: formatAmount(report.group.totals.income),
        expense: formatAmount(report.group.totals.expense),
        translationReserve: formatAmount(report.group.totals.translationReserve),
      },
      netAssets: formatAmount(report.group.netAssets),
      balanced: report.group.balanced,
      difference: formatAmount(report.group.difference),
      checks: report.group.checks.map((c) => ({ ...c })),
      attribution: { owners: formatAmount(report.group.attribution.owners), minority: formatAmount(report.group.attribution.minority) },
      trialBalance: report.group.trialBalance.map((l) => ({
        accountId: l.accountId, name: l.name, type: l.type, amount: formatAmount(l.amount),
      })),
    },
  };
}

/* ------------------------------------------------------------ claims views */

export function claimsSnapshot(engine: ClaimsEngine, asOf: string) {
  const position = engine.position();
  return {
    position: {
      reserved: formatAmount(position.reserved),
      expenseIncurred: formatAmount(position.expenseIncurred),
      paidCash: formatAmount(position.paidCash),
      recovered: formatAmount(position.recovered),
      netCost: formatAmount(position.netCost),
      openClaims: position.openClaims,
    },
    authority: engine.authorityTable().map((a) => ({ role: a.role, limit: formatAmount(a.limit), limitMinor: a.limit.minor.toString(), isAi: a.isAi })),
    overdue: engine.overdue(asOf).map((c) => ({ id: c.id, policyId: c.policyId, cause: c.cause, reportedAt: c.reportedAt, status: c.status })),
    list: engine.list().map((c) => ({
      id: c.id, policyId: c.policyId, cause: c.cause, status: c.status, lossDate: c.lossDate, reportedAt: c.reportedAt,
      description: c.description, fundId: c.fundId ?? null, declinedReason: c.declinedReason ?? null,
      reserve: formatAmount(c.reserve), paid: formatAmount(c.paid), netCost: formatAmount(engine.netCost(c.id)),
      approved: engine.approvedAmount(c.id) ? formatAmount(engine.approvedAmount(c.id)!) : null,
      recoveries: c.recoveries.map((r) => ({ type: r.type, amount: formatAmount(r.amount), at: r.at, journalId: r.journalId })),
      decisions: c.decisions.map((d) => ({
        at: d.at, by: d.by, action: d.action, isAi: d.isAi, rationale: d.rationale,
        amount: d.amount ? formatAmount(d.amount) : null,
      })),
    })),
  };
}

/** Reinsurance and retakaful, in the shape the console and the API both read. */
export function reinsuranceSnapshot(w: World) {
  const shape = (s: ReturnType<TreatyRegister['utilisation']>) => ({
    basis: s.basis,
    asOf: s.asOf,
    grossPremium: formatAmount(s.grossPremium),
    cededPremium: formatAmount(s.cededPremium),
    netRetainedPremium: formatAmount(s.netRetainedPremium),
    cessionPct: s.cessionBps / 100,
    commissionIncome: formatAmount(s.commissionIncome),
    recoveries: formatAmount(s.recoveries),
    recoverable: formatAmount(s.recoverable),
    notes: [...s.notes],
    treaties: s.treaties.map((t) => ({
      treatyId: t.treatyId, name: t.name, counterparty: t.counterparty, kind: t.kind, basis: t.basis,
      lineOfBusiness: t.lineOfBusiness, valid: t.valid, risks: t.risks,
      capacity: formatAmount(t.capacity), cededSumInsured: formatAmount(t.cededSumInsured),
      headroom: formatAmount(t.headroom), usedPct: t.usedBps / 100,
      premiumWritten: formatAmount(t.premiumWritten), premiumCeded: formatAmount(t.premiumCeded),
      premiumCededPct: t.premiumCededBps / 100,
      commissionEarned: formatAmount(t.commissionEarned), recoveries: formatAmount(t.recoveries),
      treatment: t.treatment,
      limit: formatAmount(t.cover.limit), consumed: formatAmount(t.cover.consumed),
      available: formatAmount(t.cover.available), exhausted: t.cover.exhausted,
      reinstatementsUsed: t.reinstatementsUsed, reinstatementsLeft: t.reinstatementsLeft,
    })),
    reinstatements: s.reinstatements.map((r) => ({
      treatyId: r.treatyId, sequence: r.sequence, restored: formatAmount(r.restored), premium: formatAmount(r.premium),
      free: r.free, at: r.at, available: formatAmount(r.available), journalId: r.journalId ?? null,
    })),
    deposits: s.deposits.map((d) => ({
      treatyId: d.treatyId, depositPaid: formatAmount(d.depositPaid),
      technicalPremium: d.technicalPremium ? formatAmount(d.technicalPremium) : null,
      settled: d.settled, treatment: d.treatment, assetRemaining: formatAmount(d.assetRemaining),
      adjustments: d.adjustments.map((a) => ({ at: a.at, kind: a.kind, amount: formatAmount(a.amount), journalId: a.journalId })),
    })),
  });
  return {
    conventional: shape(w.reinsurance.utilisation({ asOf: w.asOf, basis: 'conventional' })),
    takaful: shape(w.retakaful.utilisation({ asOf: w.asOf, basis: 'takaful' })),
    schedule: w.reinsurance.cessionSchedule().map((c) => ({
      policyId: c.policyId, ref: c.ref, treatyId: c.treatyId, riskId: c.riskId, sharePct: c.shareBps / 100,
      sumInsured: formatAmount(c.sumInsured), ceded: formatAmount(c.ceded),
      premium: formatAmount(c.premium), cededPremium: formatAmount(c.cededPremium),
      commission: formatAmount(c.commission), netRetained: formatAmount(c.netRetainedPremium),
      journalId: c.journalId, at: c.at, explanation: c.explanation,
    })),
    accepted: w.reinsurance.acceptedRisks('FAC-MOTOR'),
    facultativeRefusal: (() => {
      try {
        w.reinsurance.authoriseCession('FAC-MOTOR', {
          riskId: 'MTR-UNPLACED', sumInsured: money(400_000_00, 'AED'), lineOfBusiness: 'motor',
          at: `${w.asOf}T09:00:00+04:00`, basis: 'conventional',
        });
        return null;
      } catch (err) {
        return err instanceof Error ? err.message : String(err);
      }
    })(),
    segregationRefusal: (() => {
      try {
        // The control, demonstrated live: participant risk money offered to a conventional treaty.
        w.reinsurance.authoriseCession('QS-25-2026', {
          riskId: 'TKF-9001', sumInsured: money(500_000_00, 'AED'), lineOfBusiness: 'life',
          at: `${w.asOf}T09:00:00+04:00`, basis: 'takaful',
        });
        return null;
      } catch (err) {
        return err instanceof Error ? err.message : String(err);
      }
    })(),
    recoveries: w.reinsurance.recoveryList().map((r) => ({
      claimId: r.claimId, recoveryId: r.recoveryId, treatyId: r.treatyId, source: r.source,
      amount: formatAmount(r.amount), settled: formatAmount(r.settled), outstanding: formatAmount(r.outstanding),
      at: r.at, treatment: r.treatment,
    })),
    events: w.reinsurance.eventRecoveryList().map((e) => ({
      eventId: e.eventId, treatyId: e.treatyId, amount: formatAmount(e.amount), at: e.at, journalId: e.journalId,
    })),
    cover: w.reinsurance.coverState('XOL-CAT-5M'),
    ageing: (() => {
      const statement = w.reinsurance.ageing({ asOf: w.asOf });
      return {
        asOf: statement.asOf,
        outstanding: formatAmount(statement.outstanding),
        overdue: formatAmount(statement.overdue),
        oldestDays: statement.oldestDays,
        worstOverdue: [...statement.worstOverdue],
        buckets: statement.buckets.map((b) => ({ bucket: b.bucket, count: b.count, outstanding: formatAmount(b.outstanding) })),
        items: statement.items.map((i) => ({
          recoveryId: i.recoveryId, claimId: i.claimId, treatyId: i.treatyId,
          outstanding: formatAmount(i.outstanding), settled: formatAmount(i.settled), amount: formatAmount(i.amount),
          at: i.at, ageDays: i.ageDays, expectedBy: i.expectedBy, overdueDays: i.overdueDays, bucket: i.bucket,
        })),
      };
    })(),
    security: (() => {
      const statement = w.reinsurance.securityStatement({ asOf: w.asOf });
      const position = (p: (typeof statement.positions)[number]) => ({
        counterparty: p.counterparty, treaties: [...p.treaties],
        recoverable: formatAmount(p.recoverable), premiumRequirement: formatAmount(p.premiumRequirement),
        requirement: formatAmount(p.requirement), held: formatAmount(p.held),
        heldOnBalanceSheet: formatAmount(p.heldOnBalanceSheet), heldOffBalanceSheet: formatAmount(p.heldOffBalanceSheet),
        shortfall: formatAmount(p.shortfall), surplus: formatAmount(p.surplus), coverPct: p.coverBps / 100,
        secured: p.secured, notes: [...p.notes],
        instruments: p.instruments.map((i) => ({
          id: i.id, kind: i.kind, reference: i.reference, amount: formatAmount(i.amount),
          released: formatAmount(i.released), interest: formatAmount(i.interest),
          at: i.at, expiresAt: i.expiresAt ?? null, inForce: p.held.minor >= 0n && statement.asOf >= i.at.slice(0, 10)
            && (!i.expiresAt || i.expiresAt >= statement.asOf) && sub(i.amount, i.released).minor > 0n,
          onBalanceSheet: i.onBalanceSheet, journalId: i.journalId ?? null,
        })),
        calls: p.calls.map((c) => ({
          id: c.id, amount: formatAmount(c.amount), settled: formatAmount(c.settled),
          outstanding: formatAmount(sub(c.amount, c.settled)), status: c.status, reason: c.reason,
          at: c.at, dueBy: c.dueBy,
          settlements: c.settlements.map((x) => ({ at: x.at, amount: formatAmount(x.amount), kind: x.kind, instrumentId: x.instrumentId })),
        })),
      });
      return {
        asOf: statement.asOf,
        requirement: formatAmount(statement.requirement), held: formatAmount(statement.held),
        shortfall: formatAmount(statement.shortfall), unsecured: [...statement.unsecured],
        notes: [...statement.notes],
        ledger: {
          restrictedCash: formatAmount(statement.ledger.restrictedCash),
          receivedAsSecurity: formatAmount(statement.ledger.receivedAsSecurity),
          interestCredited: formatAmount(statement.ledger.interestCredited),
          offBalanceSheet: formatAmount(statement.ledger.offBalanceSheet),
        },
        findings: statement.findings.map((f) => ({ code: f.code, severity: f.severity, what: f.what, counterparty: f.counterparty ?? null })),
        positions: statement.positions.map(position),
        retakaful: w.retakaful.securityStatement({ asOf: w.asOf }).positions.map(position),
      };
    })(),
    reconciliation: (() => {
      const paid = w.claims.list().flatMap((c) => c.paid.minor > 0n ? [{ claimId: c.id, policyId: c.policyId, paid: c.paid, cause: c.cause }] : []);
      const statement = w.reinsurance.reconcile({
        asOf: w.asOf,
        claimsRecoveries: w.claims.list().flatMap((c) => c.recoveries.map((r) => ({ type: r.type, amount: r.amount }))),
      });
      const quality = w.reinsurance.dataQuality({ asOf: w.asOf, paidClaims: paid });
      return {
        asOf: statement.asOf, agrees: statement.agrees, differences: statement.differences,
        balanceSheet: {
          receivable: formatAmount(statement.balanceSheet.receivable),
          payable: formatAmount(statement.balanceSheet.payable),
          depositAsset: formatAmount(statement.balanceSheet.depositAsset),
          restrictedCash: formatAmount(statement.balanceSheet.restrictedCash),
          securityReceived: formatAmount(statement.balanceSheet.securityReceived),
        },
        lines: statement.lines.map((l) => ({
          kind: l.kind, what: l.what, register: formatAmount(l.register), ledger: formatAmount(l.ledger),
          difference: formatAmount(l.difference), status: l.status, note: l.note ?? null,
        })),
        quality: {
          errors: quality.errors, warnings: quality.warnings, checked: [...quality.checked],
          findings: quality.findings.map((f) => ({ severity: f.severity, code: f.code, subject: f.subject, detail: f.detail })),
        },
      };
    })(),
  };
}

/**
 * The reporting view: one issued return per entity (the year to date), the actuary's exhibits, and a
 * bordereau per counterparty — prepared live and then issued, so the console shows an issued document
 * rather than a draft that would be rebuilt differently the next time it is opened.
 */
/**
 * Reading the world must never issue anything twice: a reporting view that mutated the register every
 * time it was opened would be a reporting view nobody could trust. The first read issues; every read
 * after that returns exactly what was issued.
 */
export function ensureExtract(
  w: World, engine: ExtractEngine,
  kind: 'regulatory-return' | 'actuarial-exhibits' | 'treaty-bordereau', by: string, counterparty?: string,
): IssuedExtract {
  const year = { from: `${w.asOf.slice(0, 4)}-01-01`, to: w.asOf };
  const already = engine.history(kind, year, counterparty).at(-1);
  if (already) return engine.get(already.id);
  return engine.issue({
    kind, period: year, asOf: w.asOf, by, at: `${w.asOf}T17:00:00+04:00`,
    ...(counterparty ? { counterparty } : {}),
  }).extract;
}

export function extractSnapshot(w: World) {
  const year = { from: `${w.asOf.slice(0, 4)}-01-01`, to: w.asOf };
  const ensure = (engine: ExtractEngine, kind: 'regulatory-return' | 'actuarial-exhibits' | 'treaty-bordereau', by: string, counterparty?: string) =>
    ensureExtract(w, engine, kind, by, counterparty);
  const conventionalReturn = ensure(w.extracts, 'regulatory-return', 'finance/reporting');
  const takafulReturn = ensure(w.takafulExtracts, 'regulatory-return', 'finance/takaful');
  ensure(w.extracts, 'actuarial-exhibits', 'actuarial');
  ensure(w.takafulExtracts, 'actuarial-exhibits', 'actuarial');
  const counterparties = [...new Set(w.reinsurance.list().map((t) => t.counterparty))].sort();
  const bordereaux = counterparties.map((counterparty) => ensure(w.extracts, 'treaty-bordereau', 'reinsurance/desk', counterparty));

  const shape = (e: IssuedExtract) => ({
    id: e.id, kind: e.kind, title: e.title, entityId: e.entityId, basis: e.basis, jurisdiction: e.jurisdiction,
    counterparty: e.counterparty ?? null, period: e.period, asOf: e.asOf, preparedBy: e.preparedBy,
    version: e.version, fingerprint: e.fingerprint, issuedAt: e.issuedAt, supersedes: e.supersedes,
    changesSummary: e.changesSummary, differencesAccepted: e.differencesAccepted, tiesToBooks: e.tiesToBooks,
    tables: e.tables.map((t) => ({
      code: t.code, title: t.title, columns: [...t.columns], source: t.source,
      rows: t.rows.map((r) => ({ code: r.code, line: r.line, note: r.note ?? null, values: r.values.map((v) => formatCell(v)) })),
      totals: t.totals ? t.totals.map((v) => formatCell(v)) : null,
    })),
    controls: e.controls.map((c) => ({ code: c.code, what: c.what, state: c.state, detail: c.detail })),
    notes: [...e.notes], limitations: [...e.limitations],
  });
  return {
    asOf: w.asOf,
    conventional: shape(conventionalReturn),
    takaful: shape(takafulReturn),
    bordereaux: bordereaux.map(shape),
    history: w.extracts.history('regulatory-return', year).map((h) => ({ id: h.id, version: h.version, issuedAt: h.issuedAt, asOf: h.asOf, tiesToBooks: h.tiesToBooks, differences: h.differences })),
    verify: w.extracts.verify(conventionalReturn.id),
    issued: w.extracts.list().length + w.takafulExtracts.list().length,
  };
}

/**
 * The rule book as the console reads it: the rules themselves (with both languages), every decision
 * taken under them, and a placement a controller can run now to see what the desk would be told.
 */
export function uaeRuleSnapshot(w: World) {
  const statement = w.rules.statement();
  return {
    country: 'AE',
    rules: UAE_RULES.map((r) => ({
      id: r.id, title: r.title, severity: r.severity,
      instrument: `${r.instrument.reference} — ${r.instrument.title}`,
      inForce: r.instrument.inForce,
      note: r.instrument.note ?? null,
      clause: r.clause,
      requirement: r.requirement,
      requirementAr: r.requirementAr,
      evidence: [...r.evidence],
    })),
    decisions: w.rules.decisions().map((d) => ({
      id: d.id, subject: d.subject, at: d.at, by: d.by, basis: d.basis, counterparty: d.counterparty,
      decision: d.decision,
      evidence: d.evidence,
      blocking: d.blocking.map((f) => ({ ruleId: f.ruleId, state: f.state, severity: f.severity, detail: f.detail, missing: [...f.evidenceMissing] })),
      findings: d.findings.map((f) => ({
        ruleId: f.ruleId, title: f.title, state: f.state, severity: f.severity,
        detail: f.detail, clause: f.clause, requirement: f.requirement, requirementAr: f.requirementAr,
        evidenceRequired: [...f.evidenceRequired], evidenceOnFile: [...f.evidenceOnFile], evidenceMissing: [...f.evidenceMissing],
      })),
    })),
    statement,
    limitation: w.rules.limitation(),
  };
}

/**
 * The wording book as the console reads it: the templates and the mandated paragraphs as data, and
 * every letter generated from them — with both languages on every block and the pack version that
 * produced it written on its face.
 */
export function wordingSnapshot(w: World) {
  const catalogue = w.wording.catalogue();
  return {
    templates: catalogue.templates.map((t) => ({
      type: t.type, title: t.title, titleAr: t.titleAr, purpose: t.purpose, purposeAr: t.purposeAr,
      labels: [...t.labels], required: [...t.disclaimers],
    })),
    disclaimers: catalogue.disclaimers.map((d) => ({
      id: d.id, kind: d.kind, instrument: d.instrument ?? null, text: d.text, textAr: d.textAr, appliesTo: [...d.appliesTo],
    })),
    documents: w.wording.documents().map((d) => ({
      id: d.id, version: d.version, type: d.type, scope: d.scope, locale: d.locale,
      title: d.title, titleAr: d.titleAr, packVersion: d.packVersion, fingerprint: d.fingerprint,
      generatedAt: d.generatedAt, by: d.by, tiesTo: [...d.tiesTo], limitation: d.limitation,
      supersedes: d.supersedes ?? null, changesSummary: d.changesSummary ?? null,
      disclaimers: d.disclaimers.map((x) => ({ id: x.id, instrument: x.instrument ?? null })),
      fields: d.fields.map((f) => ({ ...f })),
      blocks: d.blocks.map((b) => ({ id: b.id, kind: b.kind, en: b.en, ar: b.ar, instrument: b.instrument ?? null })),
    })),
    verify: w.wording.documents().map((d) => w.wording.verify(d.id)),
  };
}

/**
 * The submission log as the console reads it: what was filed, through which channel, on whose
 * authority, under what reference — and what is still outstanding, because that is the part a
 * controller actually watches.
 */
/**
 * The filing journey, standing up the returns it files: the September return filed and acknowledged,
 * and the window's own return filed and still awaiting the supervisor's reference. Like the extracts
 * themselves, this happens once — a read of the world files nothing a second time.
 */
export function ensureFilings(w: World): void {
  const septemberReturn = ensureExtract(w, w.extracts, 'regulatory-return', 'finance/reporting');
  if (w.submissions.submissions().length === 0) {
    const pack = w.submissions.pack({
      extract: septemberReturn, returnCode: 'CBUAE-MONTHLY',
      coverLetterId: w.wording.documents().find((d) => d.type === 'return-cover')?.id ?? 'W-RETU-00001',
      ruleDecisions: w.rules.decisions().slice(0, 3).map((d) => d.id),
    });
    const filed = w.submissions.file({ pack, at: `${w.asOf}T18:30:00+04:00`, by: 'finance/reporting' });
    w.submissions.acknowledge(filed.id, {
      at: `${w.asOf}T19:15:00+04:00`, by: 'compliance/records', supervisorReference: 'CBUAE-ACK-2026-10488',
    });
  }
  const takafulReturn = ensureExtract(w, w.takafulExtracts, 'regulatory-return', 'takaful/compliance');
  if (w.takafulSubmissions.submissions().length === 0) {
    const pack = w.takafulSubmissions.pack({
      extract: takafulReturn, returnCode: 'CBUAE-MONTHLY',
      coverLetterId: w.wording.documents().find((d) => d.type === 'treaty-note')?.id ?? 'W-TREA-00002',
      ruleDecisions: w.rules.decisions().filter((d) => d.basis === 'takaful').map((d) => d.id),
    });
    w.takafulSubmissions.file({ pack, at: `${w.asOf}T18:40:00+04:00`, by: 'takaful/compliance' });
  }
}

export function submissionSnapshot(w: World, at: string = w.asOf) {
  ensureFilings(w);
  const shape = (register: SubmissionRegister, entity: string) => ({
    entity,
    statement: register.statement(at),
    submissions: register.submissions().map((s: Submission) => ({
      id: s.id, reference: s.reference, returnCode: s.returnCode, period: s.period, asOf: s.asOf,
      filedAt: s.filedAt, filedBy: s.filedBy, channel: s.channel, status: s.status, onTime: s.onTime,
      lateApprovedBy: s.lateApprovedBy, lateReason: s.lateReason,
      acknowledgedAt: s.acknowledgedAt, acknowledgedBy: s.acknowledgedBy, supervisorReference: s.supervisorReference,
      rejectionReason: s.rejectionReason, rejectedAt: s.rejectedAt, rejectedBy: s.rejectedBy,
      resubmissionOf: s.resubmissionOf, extractId: s.extractId, extractVersion: s.extractVersion,
      manifest: s.pack.manifest, coverLetterId: s.pack.coverLetterId,
      controls: { total: s.pack.controls.length, disagreeing: s.pack.controls.filter((c) => c.state !== 'agrees' && c.state !== 'informational').length },
      ruleDecisions: [...s.pack.ruleDecisions],
    })),
    awaiting: register.awaitingAcknowledgement(at).map((a) => ({ id: a.submission.id, reference: a.submission.reference, days: a.days, overdue: a.overdue })),
    findings: register.findings(at).map((f) => ({ ...f })),
    window: w.submissions.statement(at).window,
  });
  return {
    conventional: shape(w.submissions, w.conventionalEntity),
    takaful: shape(w.takafulSubmissions, w.takafulEntity),
    limitation: w.submissions.statement(at).limitation,
  };
}

export function worldSnapshot(w: World) {
  const latest = DAYS[DAYS.length - 1]!;
  const asOf = w.asOf;
  const value = w.unitLinked.valueOf('UL-000123', latest);
  const penetration = w.decider.penetration('UL-000123', latest);
  const switchPreview = w.decider.previewSwitch({
    policyId: 'UL-000123', fromFundId: 'FGLOBAL', toFundId: 'FBAL', amount: money(2000_00, 'AED'),
    instructionAt: '2026-10-05T11:10:00+04:00', disclaimer: AE_PACK.illustration.wording,
  });
  const withdrawalPreview = w.decider.previewWithdrawal({
    policyId: 'UL-000123', fundId: 'FBAL', amount: money(1500_00, 'AED'),
    instructionAt: '2026-10-05T10:15:00+04:00', disclaimer: AE_PACK.illustration.wording,
  });
  const dream = w.decider.dreamProjection({
    amount: value.total, monthlyContribution: money(1000_00, 'AED'), years: 10, disclaimer: AE_PACK.illustration.wording,
  });
  const motorSegments = w.billing.segmentsFor('MTR-0441').map((s) => ({ ...s }));
  const motorStatement = w.billing.statement('MTR-0441');
  const tkfProposal = w.takaful.surplusRun({
    riskFundId: 'PRF', determinedAt: '2026-10-03', assets: money(3050_00, 'AED'), liabilities: money(1800_00, 'AED'),
    config: { productId: 'PROD-TKF-FAMILY', model: 'wakalah', wakalahFeeBps: 2000, mudarabahProfitShareBps: 0, tabarruBps: 3000, surplusParticipantShareBps: 7000, allowsSurplusToSavers: false, jurisdiction: 'AE' },
    isFullValuation: true, auditedResultsAvailable: true,
  });
  const partnerLookup = w.parties.lookup({
    partyId: 'PTY-0001', consentId: w.consentId, requestedBy: 'DXB-BROKER-01',
    scopes: ['customer.exists', 'customer.name', 'customer.holdings'], at: '2026-10-05T09:00:00+04:00',
  });
  const partnerLookupDenied = w.parties.lookup({
    partyId: 'PTY-0001', requestedBy: 'DXB-BROKER-01', scopes: ['customer.exists'], at: '2026-10-05T09:01:00+04:00',
  });
  return {
    tenant: w.tenant,
    entities: w.entities,
    asOf,
    policy: {
      id: 'UL-000123',
      holder: 'PTY-0001',
      holderName: w.parties.get('PTY-0001')!.names.en,
      currency: 'AED',
      sumAssured: formatAmount(money(250000_00, 'AED')),
      value: {
        total: formatAmount(value.total),
        byFund: value.byFund.map((f) => ({ ...f, valueLabel: formatAmount(f.value) })),
      },
      penetration: penetration.map((p) => ({
        fundId: p.fundId, fundName: p.fundName, units: p.unitsLabel, price: p.price, value: formatAmount(p.value), priceAsOf: p.priceAsOf, stale: p.staleDays,
        holdings: p.lookThrough.map((l) => ({ instrument: l.instrument.name, assetClass: l.instrument.assetClass, weightPct: l.weightBps / 100, value: formatAmount(l.value), marketPrice: l.marketPrice, asOf: l.marketAsOf, shariah: l.instrument.shariahScreened })),
      })),
      transactions: w.unitLinked.transactions('UL-000123').map((t) => ({
        id: t.id, type: t.type, fund: t.fundId, units: unitsToDecimal(t.units), price: unitsToDecimal(t.pricePerUnit.micro),
        value: formatAmount(t.value), at: t.instructionAt, valuationDate: t.dealingPoint.valuationDate, explanation: t.dealingPoint.explanation,
        charges: t.charges.map((c) => ({ code: c.code, amount: formatAmount(c.amount), basis: c.basis })), note: t.note,
      })),
      reproduce: w.unitLinked.reproduce('UL-000123'),
    },
    switchPreview: {
      ...switchPreview,
      from: { ...switchPreview.from, valueLabel: formatAmount(switchPreview.from.value) },
      feeLabel: formatAmount(switchPreview.fee), netLabel: formatAmount(switchPreview.netInvested),
      illustration: { ...switchPreview.illustration, rows: switchPreview.illustration.rows.map((r) => ({ year: r.year, adverse: formatAmount(r.adverse), central: formatAmount(r.central), favourable: formatAmount(r.favourable) })) },
    },
    withdrawalPreview: {
      ...withdrawalPreview,
      requestedLabel: formatAmount(withdrawalPreview.requested), feeLabel: formatAmount(withdrawalPreview.fee),
      cashLabel: formatAmount(withdrawalPreview.cashToCustomer), remainingValueLabel: formatAmount(withdrawalPreview.remainingValue),
    },
    dream: { ...dream, rows: dream.rows.map((r) => ({ year: r.year, adverse: formatAmount(r.adverse), central: formatAmount(r.central), favourable: formatAmount(r.favourable), contributions: formatAmount(r.contributionsToDate) })) },
    cover: {
      policyId: 'MTR-0441',
      segments: motorSegments.map((s) => ({ ...s, dailyRateLabel: formatAmount(s.dailyRate), usageLabel: s.usageRatePerUnit ? formatAmount(s.usageRatePerUnit) + ' / km' : '—' })),
      events: motorStatement.events.map((e) => ({ ...e, amountLabel: formatAmount(e.amount) })),
      total: formatAmount(motorStatement.total),
      balance: formatAmount(motorStatement.balance),
    },
    funds: w.nav.listFunds().map((f) => {
      const v = w.nav.latestValuation(f.id)!;
      const prev = w.nav.valuationHistory(f.id).at(-2);
      return {
        id: f.id, name: f.name, currency: f.currency, shariah: f.shariahScreened, fmcBps: f.fmcBpsAnnual,
        dealing: f.dealingRule.cutoff, url: f.benchmark ?? '—',
        nav: unitsToDecimal(v.pricePerUnit.micro), navDate: v.valuationDate, units: unitsToDecimal(v.unitsInIssue),
        navValue: formatAmount(v.netAssetValue), residual: formatAmount(v.residual),
        dayChangePct: prev ? Math.round(((Number(v.pricePerUnit.micro) - Number(prev.pricePerUnit.micro)) / Number(prev.pricePerUnit.micro)) * 10000) / 100 : 0,
        composition: f.composition.map((c) => ({ instrument: w.nav.instrument(c.instrumentId).name, weightPct: c.weightBps / 100 })),
        warnings: w.nav.compositionWarnings(f.id),
      };
    }),
    takaful: {
      pools: [
        { fund: 'PRF', label: w.labels.t('takaful.riskFund', 'en', undefined, 'alkhaleej:ALK-TKF'), balance: formatAmount(w.takaful.balance('PRF')) },
        { fund: 'PIF', label: 'Participant investment fund', balance: formatAmount(w.takaful.balance('PIF')) },
        { fund: 'OPF', label: w.labels.t('takaful.operator', 'en', undefined, 'alkhaleej:ALK-TKF'), balance: formatAmount(w.takaful.balance('OPF')) },
      ],
      qards: w.takaful.listQards().map((q) => ({ id: q.id, amount: formatAmount(q.amount), repaid: formatAmount(q.repaid), outstanding: formatAmount(money(q.amount.minor - q.repaid.minor >= 0n ? q.amount.minor - q.repaid.minor : 0n, 'AED')), status: q.status, reason: q.reason })),
      proposal: {
        id: tkfProposal.id, grossSurplus: formatAmount(tkfProposal.grossSurplus), distributable: formatAmount(tkfProposal.distributable),
        participantShare: formatAmount(tkfProposal.participantShare), operatorShare: formatAmount(tkfProposal.operatorShare),
        approvals: tkfProposal.approvals, blockers: tkfProposal.blockers, ready: tkfProposal.ready, notes: tkfProposal.notes,
      },
      model: 'wakalah',
    },
    labels: {
      en: w.labels.export('en', 'alkhaleej'),
      ar: w.labels.export('ar', 'alkhaleej'),
      takafulEn: w.labels.export('en', 'alkhaleej:ALK-TKF'),
      audit: w.labels.auditTrail().slice(-8),
      coverageAr: w.labels.coverage('ar'),
    },
    parties: {
      list: w.parties.list().map((p) => ({ id: p.id, name: p.names.en, nameAr: p.names.ar, dob: p.dateOfBirth, ids: p.ids, phones: p.phones, emails: p.emails, roles: p.roles, holdings: w.parties.holdingsOf(p.id) })),
      consent: (() => { const c = w.parties.consent(w.consentId)!; return { id: c.id, scopes: [...c.scopes], expiresAt: c.expiresAt, purpose: c.purpose, grantedTo: c.grantedTo }; })(),
      partnerLookup: { outcome: partnerLookup.outcome, reason: partnerLookup.reason, disclosed: partnerLookup.disclosed, match: partnerLookup.match },
      partnerLookupDenied: { outcome: partnerLookupDenied.outcome, reason: partnerLookupDenied.reason },
      accessLog: w.parties.accessLogEntries().slice(-6),
    },
    onboarding: {
      chip: { method: w.onboarding.chip.method, fields: w.onboarding.chip.fields },
      ocr: { method: w.onboarding.ocr.method, fields: w.onboarding.ocr.fields, reviewQueue: w.onboarding.ocr.reviewQueue, notes: w.onboarding.ocr.notes },
    },
    ingest: (() => {
      const rec = w.ingest.reconciliation('LOAD-2026-10-03-001');
      return {
        summary: rec.summary, anomalies: rec.anomalies, supervisorNotes: rec.supervisorNotes,
        quarantine: rec.quarantine.map((q) => ({ row: q.row, data: q.data, errors: q.errors })),
        committed: rec.load.committed, loadId: rec.load.loadId,
      };
    })(),
    ai: {
      actions: w.ai.list().map((a) => ({ id: a.id, agent: a.agent, module: a.module, intent: a.intent, riskClass: a.riskClass, status: a.status, note: a.note, cost: a.costUsd, at: a.at })),
      awaiting: w.ai.awaitingHuman().length, totalCost: w.ai.totalCost(),
    },
    regulatory: {
      pack: AE_PACK.name,
      preSaleMotor: preSaleCheck(AE_PACK, { productLine: 'motor', hasNeedAnalysis: true, hasNeedId: true, surveyCompleted: true, comparisonPresented: true, customerIsResident: true, consentCaptured: true }),
      preSaleHealthBlocked: preSaleCheck(AE_PACK, { productLine: 'medical', hasNeedAnalysis: false, hasNeedId: false, surveyCompleted: false, comparisonPresented: false, customerIsResident: true, consentCaptured: true }),
      comparison: comparisonMatrix(w.quotes).map((c) => ({ ...c, premiumLabel: formatAmount(money(BigInt(c.premium) * 100n, 'AED')), scorePct: Math.round(c.score * 100) })),
    },
    underwriting: underwritingSnapshot(w.underwriting, asOf),
    reinsurance: reinsuranceSnapshot(w),
    extracts: extractSnapshot(w),
    uaeRules: uaeRuleSnapshot(w),
    wording: wordingSnapshot(w),
    submissions: submissionSnapshot(w),
    group: groupSnapshot(w, false),
    claims: claimsSnapshot(w.claims, asOf),
    takafulClaims: claimsSnapshot(w.takafulClaims, asOf),
    ledger: {
      proof: w.ledger.proof(w.conventionalEntity),
      proofTakaful: w.ledger.proof(w.takafulEntity),
      trialBalance: w.ledger.trialBalance(w.conventionalEntity).map((t) => ({ account: t.account.name, balance: formatAmount(t.balance) })),
      journals: w.ledger.entriesFor(w.conventionalEntity).slice(-8).map((e) => ({ id: e.id, at: e.at, description: e.description, source: e.source, fundId: e.fundId ?? '—' })),
    },
    motorPolicy: { policyId: 'MTR-0441', holder: 'Ahmed Al Mansoori' },
    days: DAYS,
    generatedAt: new Date().toISOString(),
  };
}

export type WorldSnapshot = ReturnType<typeof worldSnapshot>;
export { zero, toDecimalString };
