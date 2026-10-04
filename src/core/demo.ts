/**
 * The demo world: one tenant, two entities (conventional + takaful window), real funds with
 * market look-through, a unit-linked policy that has been premium-paid, charged, switched and
 * partially withdrawn, a pay-as-you-go motor policy with start/stop cover, a takaful book with
 * a qard and a gated surplus run, a consented partner lookup, an ingestion load and an AI ledger.
 *
 * Everything the UI and the tests read comes from here, so the console and the tests can never
 * disagree about what the platform does.
 */
import { Ledger } from './ledger.js';
import { buildChart } from './chart.js';
import { ClaimsEngine } from './claims.js';
import { Money, money, zero, formatAmount, toDecimalString } from './money.js';
import { unitsFromDecimal, unitsToDecimal } from './units.js';
import { NavEngine, singlePriceFund, FundDef } from './fund.js';
import { DEFAULT_CHARGES, UnitLinkedEngine, PolicyMeta } from './unitlinked.js';
import { BillingEngine } from './billing.js';
import { TakafulEngine, TakafulProductConfig } from './takaful.js';
import { Party, PartyRegistry } from './party.js';
import { LabelRegistry, Locale } from './labels.js';
import { AE_PACK, comparisonMatrix, preSaleCheck, QuoteOffer } from './regulatory.js';
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
  readonly parties: PartyRegistry;
  readonly labels: LabelRegistry;
  readonly ingest: IngestionFabric;
  readonly ai: AgentRuntime;
  readonly decider: DecisionTheatre;
  readonly asOf: string;
  readonly conventionalEntity: string;
  readonly takafulEntity: string;
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
  const convChart = buildChart(ledger, conventionalEntity, currency, convFunds);
  const tkfChart = buildChart(ledger, takafulEntity, currency, [...tkfFunds, 'PRF', 'PIF', 'OPF']);

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

  return {
    tenant, entities: [
      { id: conventionalEntity, name: 'Al Khaleej Insurance (conventional)', type: 'conventional', currency, regulator: 'CBUAE' },
      { id: takafulEntity, name: 'Al Khaleej Takaful Window', type: 'takaful', currency, regulator: 'CBUAE / Shariah Committee' },
    ],
    ledger, nav, unitLinked, billing, takaful, claims, takafulClaims, parties, labels, ingest, ai,
    decider: new DecisionTheatre(nav, unitLinked, DEFAULT_CHARGES),
    asOf: '2026-10-05', conventionalEntity, takafulEntity,
    consentId: consent.id, onboarding: { chip, ocr }, quotes,
  };
}

/* ------------------------------------------------------------ projections */

/* ------------------------------------------------------------ claims views */

function claimView(engine: ClaimsEngine, asOf: string) {
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
    claims: claimView(w.claims, asOf),
    takafulClaims: claimView(w.takafulClaims, asOf),
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
