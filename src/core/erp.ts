/**
 * ERP Management & Master Settings Engine.
 *
 * Bridges the core actuarial, accounting, unit-linked, takaful, billing, underwriting, claims,
 * reinsurance, and party engines into a complete operational Insurance ERP:
 *  - Centralized Customer 360 (create, update, consent, duplicate merge)
 *  - Proposal / Quotation creation, underwriting assessment & authority decisioning
 *  - Proposal-to-Policy conversion & direct policy issuance across all 4 product lines
 *  - Policy Premium / Contribution receipt & allocation (Unit-Linked, Takaful, PAYG, Conventional)
 *  - Financial & Non-Financial Policy Alterations / Endorsements with full audit trail
 *  - Fund creation, Instrument & Market Price definition, and live NAV Injection
 *  - Full Claims lifecycle (Request -> Triage -> Case Reserve -> Approve/Decline Decision -> Settlement -> Recovery)
 *  - Reinsurer / Treaty registration & custom placement operations
 *  - Master Settings hub (Products, Manuals, Charge Schedules, Takaful Config, Authority Matrix, FX Rates, Vocabulary)
 */
import type { World } from './demo.js';
import { Money, add, applyBps, compare, formatAmount, money, parseAmount, scaleOf, sub, zero } from './money.js';
import { unitsFromDecimal, unitsToDecimal } from './units.js';
import { DEFAULT_CALENDAR, FundDef, Instrument, isBusinessDay, nextBusinessDay, singlePriceFund } from './fund.js';
import { ChargeSchedule, PolicyMeta } from './unitlinked.js';
import { TakafulProductConfig } from './takaful.js';
import { DecisionOutcome, OccupationClass, ProductLine, ProductRules, RiskProfile } from './underwriting.js';
import { Authority, ClaimCause, RecoveryType } from './claims.js';
import { Basis, Treaty, TreatyKind } from './reinsurance.js';
import { IdType, IdentityDocument, Party, matchParties } from './party.js';
import { posting } from './ledger.js';
import { Locale } from './labels.js';
import { INSURANCE_PRODUCT_CATALOGUE } from './product-catalogue.js';
import {
  EVIDENCE_PROFILES, EvidenceBandSpec, PRODUCT_CATALOGUE,
  ProductVariety, PolicyCategory, catalogueByLine, evidenceProfileFor, productVariety,
} from './products.js';
import { RegionalDesk, RegionalError, RegionalSnapshot, defaultRegional } from './regional.js';
import { RatePrice, RateRow, RateTables } from './rating.js';
import { OmniChannelRegistry } from './channels.js';
import { toDecimalString } from './money.js';

export class ErpError extends Error {}

/**
 * The four books a policy can belong to. Held in `src/core/products.ts` with the catalogue, because a
 * category is a property of a product variety and not of this manager; re-exported here so every
 * caller that has always read it from the ERP keeps working.
 */
export type { PolicyCategory };
export type PaymentFrequency = 'monthly' | 'quarterly' | 'semi-annual' | 'annual' | 'single' | 'payg';
export type PolicyStatus = 'in force' | 'active cover' | 'paid-up' | 'suspended' | 'surrendered' | 'cancelled';

export interface ProductMaster {
  readonly productId: string;
  readonly name: string;
  readonly category: PolicyCategory;
  readonly line: ProductLine;
  /** The variety inside the line: 'Level term', 'Decreasing term', 'Open cover', 'Multi-pay'. */
  readonly variety: string;
  /** One sentence on what the cover does — what a suitability review reads. */
  readonly blurb: string;
  /**
   * The omni-channel display name: what the plan is called on a shelf, in a partner's portal or in an
   * app store listing, as opposed to the registered name the filing carries. Empty means "no second
   * name is filed", in which case screens fall back to `name`. A channel or partner alias filed in
   * `channels.ts` wins over this one, because the partner contract is the nearer authority.
   */
  readonly secondaryName: string;
  readonly entityId: string;
  readonly currency: string;
  readonly defaultFunds: readonly string[];
  readonly rules: ProductRules;
  readonly takafulConfig?: TakafulProductConfig;
}

/**
 * One row of the product configuration grid, in the notation the sheet and the screen use: ages and
 * multiples as numbers, money as decimal strings. `defineProductMasters` validates and files them.
 */
export interface ProductRowInput {
  productId?: string;
  name?: string;
  secondaryName?: string;
  category?: string;
  line?: string;
  variety?: string;
  blurb?: string;
  currency?: string;
  minAge?: string | number;
  maxAge?: string | number;
  maxBmi?: string | number;
  baseRatePerThousand?: string | number;
  incomeMultiple?: string | number;
  automaticBindingLimit?: string | number;
  facultativeThreshold?: string | number;
  aiStraightThroughLimit?: string | number;
  acceptedCountries?: string[];
  defaultFunds?: string[];
}

/** A decimal amount written with separators, as a grid cell or a CSV column holds it. */
function numericAmount(value: unknown): number | null {
  if (value === undefined || value === null || String(value).trim() === '') return null;
  const n = Number(String(value).replace(/[^0-9.-]/g, ''));
  return Number.isFinite(n) ? n : null;
}

/** Tenant display and capture defaults; historical books and entity functional currencies are untouched. */
export interface TenantMasterSettings {
  readonly country: string;
  readonly region: string;
  readonly businessDate: string;
  readonly timeZone: string;
  readonly localCurrency: string;
  readonly foreignCurrency: string;
}

export interface ErpProposalMeta {
  readonly applicationId: string;
  readonly partyId: string;
  readonly productId: string;
  readonly productName: string;
  readonly category: PolicyCategory;
  readonly paymentFrequency: PaymentFrequency;
  readonly termYears: number;
  readonly beneficiary: { readonly name: string; readonly relationship: string; readonly sharePct: number };
  readonly targetFunds: readonly string[];
  readonly createdAt: string;
  convertedPolicyId?: string;
  convertedAt?: string;
}

export interface ErpPolicy {
  readonly policyId: string;
  readonly partyId: string;
  holderName: string;
  holderNameAr?: string;
  readonly productId: string;
  readonly productName: string;
  readonly category: PolicyCategory;
  readonly entityId: string;
  readonly currency: string;
  sumAssured: Money;
  annualPremium: Money;
  totalPremiumPaid: Money;
  paymentFrequency: PaymentFrequency;
  readonly commencement: string;
  status: PolicyStatus;
  beneficiary: { name: string; relationship: string; sharePct: number };
  readonly applicationId?: string;
  targetWeights?: ReadonlyArray<{ fundId: string; weightBps: number }>;
  autoRebalanceMonths?: number;
}

export interface PremiumReceipt {
  readonly id: string;
  readonly policyId: string;
  readonly partyId: string;
  readonly customerName: string;
  readonly category: PolicyCategory;
  readonly amount: Money;
  readonly fundId?: string;
  readonly unitsAllocated?: string;
  readonly pricePerUnit?: string;
  readonly feeDeducted?: Money;
  readonly at: string;
  readonly by: string;
  readonly paymentMethod: string;
  readonly journalIds: readonly string[];
  readonly note: string;
}

export type NonFinancialAlterationKind =
  | 'beneficiary-change'
  | 'contact-update'
  | 'name-update'
  | 'payment-frequency'
  | 'rebalance-weights'
  | 'status-change';

export type FinancialAlterationKind =
  | 'sum-assured-change'
  | 'fund-switch'
  | 'partial-withdrawal'
  | 'surrender'
  | 'policy-charge'
  | 'portfolio-rebalance';

export interface PolicyAlteration {
  readonly id: string;
  readonly policyId: string;
  readonly partyId: string;
  readonly category: 'financial' | 'non-financial';
  readonly type: 'financial' | 'non-financial';
  readonly kind: NonFinancialAlterationKind | FinancialAlterationKind;
  readonly before: string;
  readonly after: string;
  readonly summary: string;
  readonly amount?: Money;
  readonly fee?: Money;
  readonly journalIds: readonly string[];
  readonly at: string;
  readonly by: string;
  readonly reason: string;
}

export class ErpManager {
  private readonly products = new Map<string, ProductMaster>();
  /**
   * The rating grid (age band × gender × occupation × sum assured, premium and unit-linked mortality)
   * and the omni-channel registry (channels, partners, per-partner products, rates, commission and
   * clawback). Both are public because routes and the console read them directly — the rules they hold
   * are not the ERP's business, only its books' — but they are constructed here, after the regional
   * master, because a tariff row without a currency to be filed in is not a number.
   */
  readonly rating: RateTables;
  readonly channels: OmniChannelRegistry;
  /** Country, region, calendar, time zone, local currency and the foreign rate card. */
  private regional!: RegionalDesk;
  private readonly proposals = new Map<string, ErpProposalMeta>();
  private readonly policies = new Map<string, ErpPolicy>();
  private readonly receipts: PremiumReceipt[] = [];
  private readonly alterations: PolicyAlteration[] = [];
  private tenantSettings: TenantMasterSettings;
  private takafulConfig: TakafulProductConfig;
  private fxList: Array<{ from: string; to: string; numerator: bigint; denominator: bigint; asOf: string }> = [
    { from: 'USD', to: 'AED', numerator: 367n, denominator: 100n, asOf: '2026-09-01' },
    { from: 'MYR', to: 'AED', numerator: 82n, denominator: 100n, asOf: '2026-09-30' },
    { from: 'AUD', to: 'AED', numerator: 245n, denominator: 100n, asOf: '2026-09-01' },
    { from: 'SAR', to: 'AED', numerator: 98n, denominator: 100n, asOf: '2026-09-01' },
    { from: 'GBP', to: 'AED', numerator: 470n, denominator: 100n, asOf: '2026-09-01' },
  ];
  private receiptSeq = 0;
  private alterationSeq = 0;
  private policySeq = 100;
  private journalSeq = 0;

  constructor(w: World) {
    this.tenantSettings = {
      country: 'AE',
      region: 'Dubai',
      businessDate: w.asOf,
      timeZone: 'Asia/Dubai',
      localCurrency: w.entities[0]?.currency ?? 'AED',
      foreignCurrency: 'USD',
    };
    // The regional master is read while the products are seeded (it holds the local currency), so it
    // exists before `seedFromWorld` runs and is dated from the world, not from the wall clock.
    this.regional = defaultRegional(w.asOf, 'group-finance');
    this.takafulConfig = {
      productId: 'PROD-TKF-FAMILY',
      model: 'wakalah',
      wakalahFeeBps: 2000,
      mudarabahProfitShareBps: 0,
      tabarruBps: 3000,
      surplusParticipantShareBps: 7000,
      allowsSurplusToSavers: false,
      jurisdiction: 'AE',
    };
    this.rating = new RateTables(
      (productId) => {
        const product = this.products.get(productId);
        if (!product) return undefined;
        return {
          productId: product.productId, name: product.name, currency: product.currency,
          minAge: product.rules.minAge, maxAge: product.rules.maxAge, category: product.category,
          standardOccupations: product.rules.standardOccupations,
        };
      },
      () => this.regional.current.localCurrency,
    );
    this.channels = new OmniChannelRegistry(
      (productId) => {
        const product = this.products.get(productId);
        if (!product) return undefined;
        return {
          productId: product.productId, name: product.name, category: product.category,
          currency: product.currency, secondaryName: product.secondaryName,
        };
      },
      () => this.regional.current.localCurrency,
    );
    this.seedFromWorld(w);
  }

  /**
   * Turn a catalogue variety into underwriting rules: the line's base manual supplies what the
   * variety does not say, so a hull risk inherits the same occupation and country discipline as the
   * rest of the book unless the catalogue says otherwise. Amounts are parsed in the local currency,
   * which is why the regional master has to exist before any product does.
   */
  private rulesForVariety(variety: ProductVariety, currency: string, base: ProductRules): ProductRules {
    const profile = variety.evidenceProfile ?? evidenceProfileFor(variety.line);
    const specs: readonly EvidenceBandSpec[] | undefined = EVIDENCE_PROFILES[profile];
    // An unknown profile falls back to the base manual's own bands rather than to no evidence at all:
    // a product that silently stops asking for medicals is a product being mis-sold at scale.
    const evidenceBands = specs
      ? specs.map((b) => ({ fromAge: b.fromAge, fromSumAssuredMinor: parseAmount(b.fromSumAssured, currency).minor, requirements: [...b.requirements] }))
      : base.evidenceBands.map((b) => ({ ...b, requirements: [...b.requirements] }));
    return {
      ...base,
      productId: variety.productId,
      line: variety.line,
      minAge: variety.minAge,
      maxAge: variety.maxAge,
      referralMarginYears: variety.referralMarginYears ?? base.referralMarginYears,
      maxBmi: variety.maxBmi ?? base.maxBmi,
      // Territory: the variety's own list, or the manual it was derived from — and always the country
      // the tenant is operating in, because a tenant that switches its local market to Malaysia must
      // not find its own domestic book unable to write a Malaysian risk.
      acceptedCountries: [...new Set([...(variety.acceptedCountries ?? base.acceptedCountries), this.regional.current.country])],
      standardOccupations: [...base.standardOccupations],
      baseRatePerThousandMinor: parseAmount(variety.baseRatePerThousand, currency).minor,
      incomeMultiple: variety.incomeMultiple ?? base.incomeMultiple,
      automaticBindingLimitMinor: parseAmount(variety.automaticBindingLimit ?? '1,000,000.00', currency).minor,
      facultativeThresholdMinor: parseAmount(variety.facultativeThreshold ?? '2,000,000.00', currency).minor,
      evidenceBands,
      aiStraightThroughMinor: parseAmount(variety.aiStraightThroughLimit ?? '500,000.00', currency).minor,
    };
  }

  private seedFromWorld(w: World): void {
    const currency = this.regional.current.localCurrency;
    const lifeRules = w.underwriting.rulesFor('PROD-LIFE-TERM');
    const medRules = w.underwriting.rulesFor('PROD-MEDICAL-GRP');

    /* Every variety in the catalogue becomes a product master, with its own rules registered in the
       underwriting engine — so the journey can recommend a marine open cover, an underwriter can
       assess a hull risk, and the console's product factory lists the same rows the engines read.
       The five the demo world has always run come out with the numbers they have always had, because
       the catalogue carries those numbers; nothing here is a second source of truth. */
    const seededProducts: ProductMaster[] = PRODUCT_CATALOGUE.map((variety) => {
      const rules = this.rulesForVariety(variety, currency, variety.line === 'medical' ? medRules : lifeRules);
      w.underwriting.defineProduct(rules);
      return {
        productId: variety.productId,
        name: variety.name,
        category: variety.category,
        line: variety.line,
        variety: variety.variety,
        blurb: variety.blurb,
        // A seeded variety has one name: the filed one. The secondary names are a distribution
        // decision, and a world that invented its own marketing names would be inventing a filing.
        secondaryName: '',
        entityId: variety.category === 'takaful' ? w.takafulEntity : w.conventionalEntity,
        currency,
        defaultFunds: [...(variety.defaultFunds ?? [])],
        rules,
        ...(variety.category === 'takaful' ? { takafulConfig: this.takafulConfig } : {}),
      };
    });
    for (const p of seededProducts) this.products.set(p.productId, p);
    this.seedRatingGrid(w);

    // Seed metadata for the 4 underwriting applications in buildWorld
    for (const app of w.underwriting.list()) {
      const prod = this.products.get(app.productId) ?? this.products.get('PROD-LIFE-TERM')!;
      this.proposals.set(app.id, {
        applicationId: app.id,
        partyId: app.partyId,
        productId: app.productId,
        productName: prod.name,
        category: prod.category,
        paymentFrequency: 'annual',
        termYears: 20,
        beneficiary: { name: 'Legal Heirs / Estate', relationship: 'family', sharePct: 100 },
        targetFunds: prod.defaultFunds,
        createdAt: app.at,
        ...(app.id === 'UW-000001' ? { convertedPolicyId: 'UL-000123', convertedAt: '2026-09-29' } : {}),
      });
    }

    // Seed the existing policies in the world
    const ahmed = w.parties.get('PTY-0001');
    const sara = w.parties.get('PTY-0002');
    this.policies.set('UL-000123', {
      policyId: 'UL-000123',
      partyId: 'PTY-0001',
      holderName: ahmed?.names.en ?? 'Ahmed Al Mansoori',
      holderNameAr: ahmed?.names.ar,
      productId: 'PROD-UL-GLOBAL',
      productName: 'Global Unit-Linked Plan',
      category: 'unit-linked',
      entityId: w.conventionalEntity,
      currency,
      sumAssured: money(250_000_00, currency),
      annualPremium: money(24_000_00, currency),
      totalPremiumPaid: money(24_000_00, currency),
      paymentFrequency: 'monthly',
      commencement: '2026-09-29',
      status: 'in force',
      beneficiary: { name: 'Mariam Al Mansoori', relationship: 'spouse', sharePct: 100 },
      applicationId: 'UW-000001',
      targetWeights: [{ fundId: 'FGLOBAL', weightBps: 7000 }, { fundId: 'FBAL', weightBps: 3000 }],
      autoRebalanceMonths: 6,
    });
    this.policies.set('MTR-0441', {
      policyId: 'MTR-0441',
      partyId: 'PTY-0001',
      holderName: ahmed?.names.en ?? 'Ahmed Al Mansoori',
      holderNameAr: ahmed?.names.ar,
      productId: 'PROD-MOTOR-PAYG',
      productName: 'Pay-as-you-drive Motor Cover',
      category: 'motor-payg',
      entityId: w.conventionalEntity,
      currency,
      sumAssured: money(250_000_00, currency),
      annualPremium: money(4_562_50, currency),
      totalPremiumPaid: money(500_00, currency),
      paymentFrequency: 'payg',
      commencement: '2026-10-01',
      status: 'active cover',
      beneficiary: { name: 'Ahmed Al Mansoori', relationship: 'self', sharePct: 100 },
    });
    this.policies.set('TK-9001', {
      policyId: 'TK-9001',
      partyId: 'PTY-0002',
      holderName: sara?.names.en ?? 'Sara Khalifa',
      holderNameAr: sara?.names.ar,
      productId: 'PROD-TKF-FAMILY',
      productName: 'Family Takaful Protection & Savings Plan',
      category: 'takaful',
      entityId: w.takafulEntity,
      currency,
      sumAssured: money(500_000_00, currency),
      annualPremium: money(6_000_00, currency),
      totalPremiumPaid: money(6_000_00, currency),
      paymentFrequency: 'monthly',
      commencement: '2026-09-25',
      status: 'in force',
      beneficiary: { name: 'Yousef Khalifa', relationship: 'child', sharePct: 100 },
    });

    // Seed initial premium receipt log from the seeded policy transactions
    this.receipts.push(
      {
        id: `RCP-${String(++this.receiptSeq).padStart(6, '0')}`,
        policyId: 'UL-000123',
        partyId: 'PTY-0001',
        customerName: 'Ahmed Al Mansoori',
        category: 'unit-linked',
        amount: money(12_000_00, currency),
        fundId: 'FGLOBAL',
        unitsAllocated: '1086.090624',
        pricePerUnit: '10.496361',
        feeDeducted: money(600_00, currency),
        at: '2026-09-29T09:40:00+04:00',
        by: 'cashier-desk',
        paymentMethod: 'bank-transfer',
        journalIds: ['UL-J-000001', 'UL-J-000002', 'UL-J-000003', 'UL-J-000004'],
        note: 'Initial premium allocated to FGLOBAL (500 bps allocation charge)',
      },
      {
        id: `RCP-${String(++this.receiptSeq).padStart(6, '0')}`,
        policyId: 'UL-000123',
        partyId: 'PTY-0001',
        customerName: 'Ahmed Al Mansoori',
        category: 'unit-linked',
        amount: money(12_000_00, currency),
        fundId: 'FBAL',
        unitsAllocated: '1084.565301',
        pricePerUnit: '10.511123',
        feeDeducted: money(600_00, currency),
        at: '2026-09-30T11:05:00+04:00',
        by: 'cashier-desk',
        paymentMethod: 'bank-transfer',
        journalIds: ['UL-J-000005', 'UL-J-000006', 'UL-J-000007', 'UL-J-000008'],
        note: 'Second instalment allocated to FBAL (500 bps allocation charge)',
      },
      {
        id: `RCP-${String(++this.receiptSeq).padStart(6, '0')}`,
        policyId: 'TK-9001',
        partyId: 'PTY-0002',
        customerName: 'Sara Khalifa',
        category: 'takaful',
        amount: money(6_000_00, currency),
        fundId: 'PRF / PIF',
        feeDeducted: money(1_200_00, currency),
        at: '2026-10-01T09:00:00+04:00',
        by: 'takaful-cashier',
        paymentMethod: 'direct-debit',
        journalIds: ['TKF-J-000001', 'TKF-J-000002', 'TKF-J-000003', 'TKF-J-000004'],
        note: 'Takaful contribution split: 20% Wakalah fee (OPF), 30% of net Tabarru (PRF), 70% Investment (PIF)',
      },
    );

    // Seed initial alteration history from UL-000123 switch & partial withdrawal
    this.alterations.push(
      {
        id: `ALT-${String(++this.alterationSeq).padStart(6, '0')}`,
        policyId: 'UL-000123',
        partyId: 'PTY-0001',
        category: 'financial',
        type: 'financial',
        kind: 'fund-switch',
        before: 'FGLOBAL holding prior to switch',
        after: 'Switched 3,000.00 AED from FGLOBAL into FBAL (100 bps fee)',
        summary: 'Switched 3,000.00 AED from FGLOBAL into FBAL (100 bps fee)',
        amount: money(3_000_00, currency),
        fee: money(30_00, currency),
        journalIds: ['UL-J-000015', 'UL-J-000016', 'UL-J-000017', 'UL-J-000018', 'UL-J-000019'],
        at: '2026-09-30T15:30:00+04:00',
        by: 'policy-servicing',
        reason: 'Policyholder portfolio rebalancing instruction',
      },
      {
        id: `ALT-${String(++this.alterationSeq).padStart(6, '0')}`,
        policyId: 'UL-000123',
        partyId: 'PTY-0001',
        category: 'financial',
        type: 'financial',
        kind: 'partial-withdrawal',
        before: 'FBAL holding prior to partial withdrawal',
        after: 'Withdrew 1,000.00 AED cash from FBAL (250 bps withdrawal fee)',
        summary: 'Withdrew 1,000.00 AED cash from FBAL (250 bps withdrawal fee)',
        amount: money(1_000_00, currency),
        fee: money(25_00, currency),
        journalIds: ['UL-J-000025', 'UL-J-000026', 'UL-J-000027', 'UL-J-000028'],
        at: '2026-10-01T10:15:00+04:00',
        by: 'policy-servicing',
        reason: 'Customer partial encashment request',
      },
    );
  }

  /* ========================================================= 1. CUSTOMERS */

  createCustomer(w: World, input: {
    id?: string;
    kind?: 'person' | 'organisation';
    nameEn: string;
    nameAr?: string;
    dateOfBirth?: string;
    idType?: IdType;
    idValue?: string;
    country?: string;
    idSource?: IdentityDocument['source'];
    phone?: string;
    email?: string;
    addressLine?: string;
    city?: string;
    roles?: string[];
    grantConsentTo?: string;
    consentScopes?: string[];
  }): { party: Party; consentId?: string; duplicateMatches: Array<{ partyId: string; score: number; reasons: string[] }> } {
    const nameEn = input.nameEn.trim();
    if (!nameEn) throw new ErpError('customer English name is required');
    const nextNum = w.parties.list().length + 1;
    const id = input.id?.trim() || `PTY-${String(nextNum).padStart(4, '0')}`;
    if (w.parties.get(id)) throw new ErpError(`customer ${id} already exists`);

    const country = (input.country?.trim() || 'AE').toUpperCase();
    const ids: IdentityDocument[] = [];
    if (input.idValue?.trim()) {
      ids.push({
        type: input.idType ?? 'emirates-id',
        value: input.idValue.trim(),
        country,
        source: input.idSource ?? 'manual',
        confidence: input.idSource === 'chip' ? 0.999 : input.idSource === 'government-lookup' ? 0.98 : 0.95,
      });
    }

    const candidate: Party = {
      id,
      kind: input.kind ?? 'person',
      names: { en: nameEn, ...(input.nameAr?.trim() ? { ar: input.nameAr.trim() } : {}) },
      ...(input.dateOfBirth?.trim() ? { dateOfBirth: input.dateOfBirth.trim() } : {}),
      ids,
      phones: input.phone?.trim() ? [input.phone.trim()] : [],
      emails: input.email?.trim() ? [input.email.trim()] : [],
      addresses: input.addressLine?.trim()
        ? [{ line: input.addressLine.trim(), ...(input.city?.trim() ? { city: input.city.trim() } : {}), country }]
        : [{ line: 'Sheikh Zayed Road', city: input.city?.trim() || 'Dubai', country }],
      roles: input.roles && input.roles.length > 0 ? input.roles : ['policyholder'],
    };

    const duplicateMatches = matchParties(candidate, w.parties.list(), 120);
    w.parties.upsert(candidate);
    if (w.parties.holdingsOf(id).length === 0) w.parties.recordHoldings(id, []);

    let consentId: string | undefined;
    if (input.grantConsentTo?.trim()) {
      const consent = w.parties.grantConsent({
        partyId: id,
        grantedTo: input.grantConsentTo.trim(),
        purpose: 'Centralized customer verification & policy servicing',
        scopes: input.consentScopes && input.consentScopes.length > 0
          ? input.consentScopes
          : ['customer.exists', 'customer.name', 'customer.contact', 'customer.holdings'],
        grantedAt: `${w.asOf}T10:00:00+04:00`,
        expiresAt: '2027-12-31T23:59:59+04:00',
        evidence: `e-consent-${id}`,
      });
      consentId = consent.id;
    }

    return { party: candidate, ...(consentId ? { consentId } : {}), duplicateMatches };
  }

  updateCustomer(w: World, input: {
    partyId: string;
    nameEn?: string;
    nameAr?: string;
    dateOfBirth?: string;
    phone?: string;
    email?: string;
    addressLine?: string;
    city?: string;
    country?: string;
    idType?: IdType;
    idValue?: string;
    roles?: string[];
  }): Party {
    const existing = w.parties.get(input.partyId);
    if (!existing) throw new ErpError(`unknown customer ${input.partyId}`);
    const ids = [...existing.ids];
    if (input.idValue?.trim()) {
      const type = input.idType ?? 'emirates-id';
      const val = input.idValue.trim();
      if (!ids.some((i) => i.type === type && i.value === val)) {
        ids.push({ type, value: val, country: input.country ?? 'AE', source: 'manual', confidence: 0.95 });
      }
    }
    const updated: Party = {
      ...existing,
      names: {
        en: input.nameEn?.trim() || existing.names.en,
        ...(input.nameAr !== undefined ? (input.nameAr.trim() ? { ar: input.nameAr.trim() } : {}) : (existing.names.ar ? { ar: existing.names.ar } : {})),
      },
      ...(input.dateOfBirth?.trim() ? { dateOfBirth: input.dateOfBirth.trim() } : (existing.dateOfBirth ? { dateOfBirth: existing.dateOfBirth } : {})),
      ids,
      phones: input.phone?.trim() ? [input.phone.trim(), ...existing.phones.filter((p) => p !== input.phone!.trim())] : existing.phones,
      emails: input.email?.trim() ? [input.email.trim(), ...existing.emails.filter((e) => e !== input.email!.trim())] : existing.emails,
      addresses: input.addressLine?.trim()
        ? [{ line: input.addressLine.trim(), city: input.city?.trim() || existing.addresses[0]?.city || 'Dubai', country: input.country?.trim() || existing.addresses[0]?.country || 'AE' }]
        : existing.addresses,
      roles: input.roles && input.roles.length > 0 ? input.roles : existing.roles,
    };
    w.parties.upsert(updated);
    // Sync holderName on any policies belonging to this party
    for (const pol of this.policies.values()) {
      if (pol.partyId === updated.id) {
        pol.holderName = updated.names.en;
        if (updated.names.ar) pol.holderNameAr = updated.names.ar;
      }
    }
    return updated;
  }

  /* ============================================= 2. PROPOSALS / QUOTATIONS */

  createProposal(w: World, input: {
    partyId: string;
    productId: string;
    sumAssured: string | number;
    paymentFrequency?: PaymentFrequency;
    termYears?: number;
    beneficiaryName?: string;
    beneficiaryRelationship?: string;
    targetFunds?: string[];
    age: number;
    sex?: 'male' | 'female';
    smoker?: boolean;
    heightCm?: number;
    weightKg?: number;
    occupationClass?: OccupationClass;
    pursuits?: string[];
    conditions?: string[];
    familyHistory?: string[];
    residenceCountry?: string;
    annualIncome?: string | number;
    at?: string;
  }) {
    const prod = this.products.get(input.productId);
    if (!prod) throw new ErpError(`unknown product ${input.productId} — define it in Master Settings first`);
    // Ensure product rules are registered in the underwriting engine
    w.underwriting.defineProduct(prod.rules);

    // Ensure party exists (if not in PartyRegistry yet, create a placeholder party record)
    if (!w.parties.get(input.partyId)) {
      this.createCustomer(w, { id: input.partyId, nameEn: `Customer ${input.partyId}` });
    }

    const sumAssured = parseAmount(String(input.sumAssured), 'AED');
    const annualIncome = input.annualIncome !== undefined
      ? parseAmount(String(input.annualIncome), 'AED')
      : money(360_000_00, 'AED');

    const profile: RiskProfile = {
      partyId: input.partyId,
      age: Number(input.age ?? 35),
      sex: input.sex ?? 'male',
      smoker: Boolean(input.smoker ?? false),
      heightCm: Number(input.heightCm ?? 175),
      weightKg: Number(input.weightKg ?? 75),
      occupationClass: (Number(input.occupationClass ?? 1) as OccupationClass),
      pursuits: (input.pursuits ?? []).filter(Boolean),
      conditions: (input.conditions ?? []).filter(Boolean),
      familyHistory: (input.familyHistory ?? []).filter(Boolean),
      residenceCountry: (input.residenceCountry?.trim() || 'AE').toUpperCase(),
      annualIncome,
    };

    const at = input.at ?? `${w.asOf}T10:30:00+04:00`;
    const app = w.underwriting.register({
      partyId: input.partyId,
      productId: prod.productId,
      sumAssured,
      at,
      profile,
    });
    const assessment = w.underwriting.assess(app.id);

    const meta: ErpProposalMeta = {
      applicationId: app.id,
      partyId: input.partyId,
      productId: prod.productId,
      productName: prod.name,
      category: prod.category,
      paymentFrequency: input.paymentFrequency ?? 'annual',
      termYears: Number(input.termYears ?? 20),
      beneficiary: {
        name: input.beneficiaryName?.trim() || 'Legal Heirs / Estate',
        relationship: input.beneficiaryRelationship?.trim() || 'family',
        sharePct: 100,
      },
      targetFunds: input.targetFunds && input.targetFunds.length > 0 ? input.targetFunds : prod.defaultFunds,
      createdAt: at,
    };
    this.proposals.set(app.id, meta);

    return {
      applicationId: app.id,
      partyId: app.partyId,
      customerName: w.parties.get(app.partyId)?.names.en ?? app.partyId,
      productId: prod.productId,
      productName: prod.name,
      category: prod.category,
      sumAssured: formatAmount(sumAssured),
      standardPremium: formatAmount(assessment.standardPremium),
      loadedPremium: formatAmount(assessment.loadedPremium),
      extraMortalityBps: assessment.extraMortalityBps,
      outcome: assessment.outcome,
      exclusions: assessment.exclusions,
      evidence: assessment.evidence,
      referrals: assessment.referrals,
      reasons: assessment.reasons,
      reinsurance: {
        mode: assessment.reinsurance.mode,
        threshold: formatAmount(assessment.reinsurance.threshold),
        note: assessment.reinsurance.note,
      },
    };
  }

  decideProposal(w: World, input: {
    applicationId: string;
    by?: string;
    isAi?: boolean;
    override?: DecisionOutcome;
    acceptReferralReasonCodes?: string[];
    at?: string;
  }) {
    const decision = w.underwriting.decide(input.applicationId, {
      at: input.at ?? `${w.asOf}T11:00:00+04:00`,
      by: input.by?.trim() || (input.isAi ? 'agent/quote-bot' : 'senior-underwriter'),
      isAi: Boolean(input.isAi ?? false),
      ...(input.override ? { override: input.override } : {}),
      ...(input.acceptReferralReasonCodes ? { acceptReferralReasonCodes: input.acceptReferralReasonCodes } : {}),
    });
    return {
      applicationId: decision.applicationId,
      outcome: decision.outcome,
      decidedBy: decision.decidedBy,
      decidedByAi: decision.decidedByAi,
      extraMortalityBps: decision.extraMortalityBps,
      standardPremium: formatAmount(decision.standardPremium),
      loadedPremium: formatAmount(decision.loadedPremium),
      exclusions: decision.exclusions,
      evidence: decision.evidence,
      referrals: decision.referrals,
      reasons: decision.reasons,
    };
  }

  /* =============================== 3. PROPOSAL -> POLICY & POLICY ISSUANCE */

  convertProposalToPolicy(w: World, input: {
    applicationId: string;
    policyId?: string;
    paymentFrequency?: PaymentFrequency;
    beneficiaryName?: string;
    beneficiaryRelationship?: string;
    targetWeights?: Array<{ fundId: string; weightBps: number }>;
    initialPremium?: string | number;
    initialFundId?: string;
    by?: string;
    at?: string;
  }): { policy: ErpPolicy; initialReceipt?: PremiumReceipt } {
    const app = w.underwriting.application(input.applicationId);
    let decision = app.decision;
    if (!decision || decision.outcome === 'referred') {
      // If a human converts a referred proposal directly, decide it as senior-underwriter first
      decision = w.underwriting.decide(app.id, {
        at: input.at ?? `${w.asOf}T11:15:00+04:00`,
        by: input.by?.trim() || 'senior-underwriter',
        isAi: false,
      });
    }
    if (decision.outcome === 'declined' || decision.outcome === 'postponed') {
      throw new ErpError(`proposal ${app.id} is ${decision.outcome} and cannot be converted into an active policy`);
    }

    const existingMeta = this.proposals.get(app.id);
    if (existingMeta?.convertedPolicyId && this.policies.has(existingMeta.convertedPolicyId)) {
      throw new ErpError(`proposal ${app.id} has already been converted to policy ${existingMeta.convertedPolicyId}`);
    }

    const prod = this.products.get(app.productId) ?? {
      productId: app.productId,
      name: app.productId,
      category: 'conventional' as PolicyCategory,
      line: 'life' as ProductLine,
      entityId: w.conventionalEntity,
      currency: 'AED',
      defaultFunds: ['FGLOBAL', 'FBAL'],
      rules: w.underwriting.rulesFor(app.productId),
    };

    const prefix = prod.category === 'unit-linked' ? 'UL'
      : prod.category === 'takaful' ? 'TK'
      : prod.category === 'motor-payg' ? 'MTR'
      : 'POL';
    const policyId = input.policyId?.trim() || `${prefix}-${String(++this.policySeq).padStart(6, '0')}`;
    if (this.policies.has(policyId)) throw new ErpError(`policy ${policyId} already exists`);

    const party = w.parties.get(app.partyId);
    const commencement = (input.at ?? w.asOf).slice(0, 10);
    const defaultWeights = input.targetWeights && input.targetWeights.length > 0
      ? input.targetWeights
      : prod.category === 'unit-linked'
        ? [{ fundId: 'FGLOBAL', weightBps: 7000 }, { fundId: 'FBAL', weightBps: 3000 }]
        : undefined;

    const policy: ErpPolicy = {
      policyId,
      partyId: app.partyId,
      holderName: party?.names.en ?? app.partyId,
      ...(party?.names.ar ? { holderNameAr: party.names.ar } : {}),
      productId: prod.productId,
      productName: prod.name,
      category: prod.category,
      entityId: prod.entityId,
      currency: prod.currency,
      sumAssured: decision.sumAssured,
      annualPremium: decision.loadedPremium,
      totalPremiumPaid: zero(prod.currency),
      paymentFrequency: input.paymentFrequency ?? existingMeta?.paymentFrequency ?? 'annual',
      commencement,
      status: prod.category === 'motor-payg' ? 'active cover' : 'in force',
      beneficiary: {
        name: input.beneficiaryName?.trim() || existingMeta?.beneficiary.name || 'Legal Heirs / Estate',
        relationship: input.beneficiaryRelationship?.trim() || existingMeta?.beneficiary.relationship || 'family',
        sharePct: 100,
      },
      applicationId: app.id,
      ...(defaultWeights ? { targetWeights: defaultWeights, autoRebalanceMonths: 6 } : {}),
    };

    // Provision inside the underlying domain engine
    if (policy.category === 'unit-linked') {
      const funds = w.nav.listFunds().filter((f) => !f.shariahScreened || f.id !== 'TKF-EQ').map((f) => ({ fundId: f.id }));
      const holdings = funds.length > 0 ? funds : [{ fundId: 'FGLOBAL' }, { fundId: 'FBAL' }];
      w.unitLinked.openPolicy({
        policyId: policy.policyId,
        entityId: policy.entityId,
        productId: policy.productId,
        currency: policy.currency,
        commencement: policy.commencement,
        sumAssured: policy.sumAssured,
        autoRebalanceMonths: policy.autoRebalanceMonths ?? 6,
        ...(policy.targetWeights ? { targetWeights: policy.targetWeights } : {}),
      }, holdings);
    } else if (policy.category === 'motor-payg') {
      w.billing.openWallet(policy.policyId, zero(policy.currency));
      w.billing.createSegment({
        policyId: policy.policyId,
        productId: policy.productId,
        mode: 'start-stop',
        dailyRate: money(12_50, policy.currency),
        usageRatePerUnit: money(35, policy.currency),
        tariffVersion: 'MOTOR-AE-2026.1',
        autoStart: false,
        graceDays: 3,
      });
    }

    this.policies.set(policy.policyId, policy);

    // Record holding on Party 360
    const currentHoldings = w.parties.holdingsOf(policy.partyId);
    w.parties.recordHoldings(policy.partyId, [
      ...currentHoldings.filter((h) => h.policyId !== policy.policyId),
      {
        policyId: policy.policyId,
        productName: policy.productName,
        entityId: policy.entityId,
        status: policy.status,
        currency: policy.currency,
      },
    ]);

    if (existingMeta) {
      existingMeta.convertedPolicyId = policy.policyId;
      existingMeta.convertedAt = input.at ?? `${w.asOf}T11:20:00+04:00`;
    } else {
      this.proposals.set(app.id, {
        applicationId: app.id,
        partyId: app.partyId,
        productId: prod.productId,
        productName: prod.name,
        category: prod.category,
        paymentFrequency: policy.paymentFrequency,
        termYears: 20,
        beneficiary: policy.beneficiary,
        targetFunds: prod.defaultFunds,
        createdAt: app.at,
        convertedPolicyId: policy.policyId,
        convertedAt: input.at ?? `${w.asOf}T11:20:00+04:00`,
      });
    }

    let initialReceipt: PremiumReceipt | undefined;
    if (input.initialPremium !== undefined && String(input.initialPremium).trim() !== '' && Number(String(input.initialPremium).replace(/,/g, '')) > 0) {
      initialReceipt = this.receivePremium(w, {
        policyId: policy.policyId,
        amount: input.initialPremium,
        fundId: input.initialFundId ?? defaultWeights?.[0]?.fundId ?? 'FGLOBAL',
        by: input.by ?? 'policy-issuance',
        at: input.at ?? `${w.asOf}T11:25:00+04:00`,
      });
    }

    return { policy, ...(initialReceipt ? { initialReceipt } : {}) };
  }

  createPolicy(w: World, input: {
    policyId?: string;
    partyId: string;
    productId: string;
    sumAssured: string | number;
    annualPremium?: string | number;
    paymentFrequency?: PaymentFrequency;
    beneficiaryName?: string;
    beneficiaryRelationship?: string;
    initialPremium?: string | number;
    initialFundId?: string;
    at?: string;
  }): { policy: ErpPolicy; initialReceipt?: PremiumReceipt } {
    const prod = this.products.get(input.productId);
    if (!prod) throw new ErpError(`unknown product ${input.productId}`);
    if (!w.parties.get(input.partyId)) {
      this.createCustomer(w, { id: input.partyId, nameEn: `Customer ${input.partyId}` });
    }
    const party = w.parties.get(input.partyId)!;
    const sumAssured = parseAmount(String(input.sumAssured), 'AED');
    const divisor = 1000n * 10n ** BigInt(scaleOf('AED'));
    const computedPremium = money((sumAssured.minor * prod.rules.baseRatePerThousandMinor) / divisor, 'AED');
    const annualPremium = input.annualPremium !== undefined && String(input.annualPremium).trim() !== ''
      ? parseAmount(String(input.annualPremium), 'AED')
      : computedPremium;

    const prefix = prod.category === 'unit-linked' ? 'UL'
      : prod.category === 'takaful' ? 'TK'
      : prod.category === 'motor-payg' ? 'MTR'
      : 'POL';
    const policyId = input.policyId?.trim() || `${prefix}-${String(++this.policySeq).padStart(6, '0')}`;
    if (this.policies.has(policyId)) throw new ErpError(`policy ${policyId} already exists`);

    const commencement = (input.at ?? w.asOf).slice(0, 10);
    const defaultWeights = prod.category === 'unit-linked'
      ? [{ fundId: 'FGLOBAL', weightBps: 7000 }, { fundId: 'FBAL', weightBps: 3000 }]
      : undefined;

    const policy: ErpPolicy = {
      policyId,
      partyId: input.partyId,
      holderName: party.names.en,
      ...(party.names.ar ? { holderNameAr: party.names.ar } : {}),
      productId: prod.productId,
      productName: prod.name,
      category: prod.category,
      entityId: prod.entityId,
      currency: prod.currency,
      sumAssured,
      annualPremium,
      totalPremiumPaid: zero(prod.currency),
      paymentFrequency: input.paymentFrequency ?? 'annual',
      commencement,
      status: prod.category === 'motor-payg' ? 'active cover' : 'in force',
      beneficiary: {
        name: input.beneficiaryName?.trim() || 'Legal Heirs / Estate',
        relationship: input.beneficiaryRelationship?.trim() || 'family',
        sharePct: 100,
      },
      ...(defaultWeights ? { targetWeights: defaultWeights, autoRebalanceMonths: 6 } : {}),
    };

    if (policy.category === 'unit-linked') {
      const holdings = w.nav.listFunds().map((f) => ({ fundId: f.id }));
      w.unitLinked.openPolicy({
        policyId: policy.policyId,
        entityId: policy.entityId,
        productId: policy.productId,
        currency: policy.currency,
        commencement: policy.commencement,
        sumAssured: policy.sumAssured,
        autoRebalanceMonths: 6,
        ...(defaultWeights ? { targetWeights: defaultWeights } : {}),
      }, holdings);
    } else if (policy.category === 'motor-payg') {
      w.billing.openWallet(policy.policyId, zero(policy.currency));
      w.billing.createSegment({
        policyId: policy.policyId,
        productId: policy.productId,
        mode: 'start-stop',
        dailyRate: money(12_50, policy.currency),
        usageRatePerUnit: money(35, policy.currency),
        tariffVersion: 'MOTOR-AE-2026.1',
        autoStart: false,
        graceDays: 3,
      });
    }

    this.policies.set(policy.policyId, policy);
    const currentHoldings = w.parties.holdingsOf(policy.partyId);
    w.parties.recordHoldings(policy.partyId, [
      ...currentHoldings.filter((h) => h.policyId !== policy.policyId),
      {
        policyId: policy.policyId,
        productName: policy.productName,
        entityId: policy.entityId,
        status: policy.status,
        currency: policy.currency,
      },
    ]);

    let initialReceipt: PremiumReceipt | undefined;
    if (input.initialPremium !== undefined && String(input.initialPremium).trim() !== '' && Number(String(input.initialPremium).replace(/,/g, '')) > 0) {
      initialReceipt = this.receivePremium(w, {
        policyId: policy.policyId,
        amount: input.initialPremium,
        fundId: input.initialFundId ?? 'FGLOBAL',
        at: input.at ?? `${w.asOf}T11:30:00+04:00`,
      });
    }
    return { policy, ...(initialReceipt ? { initialReceipt } : {}) };
  }

  /* ============================================= 4. POLICY PREMIUM RECEIPT */

  receivePremium(w: World, input: {
    policyId: string;
    amount: string | number;
    fundId?: string;
    allocationChargeBps?: number;
    paymentMethod?: string;
    by?: string;
    at?: string;
  }): PremiumReceipt {
    const policy = this.policies.get(input.policyId);
    if (!policy) throw new ErpError(`unknown policy ${input.policyId}`);
    if (policy.status === 'cancelled' || policy.status === 'surrendered') {
      throw new ErpError(`cannot receive premium on ${policy.status} policy ${policy.policyId}`);
    }

    const premium = parseAmount(String(input.amount), policy.currency);
    if (premium.minor <= 0n) throw new ErpError('premium received must be greater than zero');
    // Default instruction time before 15:00 cut-off on w.asOf so the latest published valuation applies cleanly
    const at = input.at ?? `${w.asOf}T11:00:00+04:00`;
    const by = input.by?.trim() || 'cashier-desk';
    const paymentMethod = input.paymentMethod?.trim() || 'bank-transfer';

    let receipt: PremiumReceipt;

    if (policy.category === 'unit-linked') {
      const fundId = input.fundId?.trim() || policy.targetWeights?.[0]?.fundId || 'FGLOBAL';
      w.unitLinked.ensureFundHolding(policy.policyId, fundId);
      const txn = w.unitLinked.payPremium({
        policyId: policy.policyId,
        premium,
        fundId,
        instructionAt: at,
        ...(input.allocationChargeBps !== undefined ? { allocationChargeBps: Number(input.allocationChargeBps) } : {}),
      });
      const fee = txn.charges[0]?.amount ?? zero(policy.currency);
      receipt = {
        id: `RCP-${String(++this.receiptSeq).padStart(6, '0')}`,
        policyId: policy.policyId,
        partyId: policy.partyId,
        customerName: policy.holderName,
        category: policy.category,
        amount: premium,
        fundId,
        unitsAllocated: unitsToDecimal(txn.units),
        pricePerUnit: unitsToDecimal(txn.pricePerUnit.micro),
        feeDeducted: fee,
        at,
        by,
        paymentMethod,
        journalIds: txn.journalIds,
        note: txn.note,
      };
    } else if (policy.category === 'takaful') {
      const res = w.takaful.contribute({
        policyId: policy.policyId,
        contribution: premium,
        at,
        config: this.takafulConfig,
      });
      receipt = {
        id: `RCP-${String(++this.receiptSeq).padStart(6, '0')}`,
        policyId: policy.policyId,
        partyId: policy.partyId,
        customerName: policy.holderName,
        category: policy.category,
        amount: premium,
        fundId: 'PRF / PIF',
        feeDeducted: res.wakalahFee,
        at,
        by,
        paymentMethod,
        journalIds: res.journalIds,
        note: `Contribution split: Wakalah fee ${formatAmount(res.wakalahFee)} -> OPF, Tabarru ${formatAmount(res.tabarru)} -> PRF, Investment ${formatAmount(res.investment)} -> PIF`,
      };
    } else if (policy.category === 'motor-payg') {
      const ev = w.billing.topUpWallet(policy.policyId, premium, at);
      const jId = `ERP-J-${String(++this.journalSeq).padStart(6, '0')}`;
      w.ledger.post({
        id: jId,
        entityId: policy.entityId,
        at,
        source: 'billing',
        sourceRef: policy.policyId,
        description: `Wallet top-up / premium received for ${policy.policyId} (${formatAmount(premium)})`,
        postings: [
          posting(`${policy.entityId}:CASH`, 'debit', premium),
          posting(`${policy.entityId}:PREMIUM-INCOME`, 'credit', premium),
        ],
      });
      receipt = {
        id: `RCP-${String(++this.receiptSeq).padStart(6, '0')}`,
        policyId: policy.policyId,
        partyId: policy.partyId,
        customerName: policy.holderName,
        category: policy.category,
        amount: premium,
        at,
        by,
        paymentMethod,
        journalIds: [jId],
        note: `Credited ${formatAmount(premium)} to micro-duration cover wallet (${ev.id})`,
      };
    } else {
      const jId = `ERP-J-${String(++this.journalSeq).padStart(6, '0')}`;
      w.ledger.post({
        id: jId,
        entityId: policy.entityId,
        at,
        source: 'gl',
        sourceRef: policy.policyId,
        description: `Premium received for ${policy.policyId} (${formatAmount(premium)})`,
        postings: [
          posting(`${policy.entityId}:CASH`, 'debit', premium),
          posting(`${policy.entityId}:PREMIUM-INCOME`, 'credit', premium),
        ],
      });
      receipt = {
        id: `RCP-${String(++this.receiptSeq).padStart(6, '0')}`,
        policyId: policy.policyId,
        partyId: policy.partyId,
        customerName: policy.holderName,
        category: policy.category,
        amount: premium,
        at,
        by,
        paymentMethod,
        journalIds: [jId],
        note: `Conventional premium ${formatAmount(premium)} received and posted to ${policy.entityId}`,
      };
    }

    policy.totalPremiumPaid = add(policy.totalPremiumPaid, premium);
    this.receipts.push(receipt);
    return receipt;
  }

  /* ============================ 5. POLICY ALTERATIONS (FINANCIAL & NON-FIN) */

  alterPolicyNonFinancial(w: World, input: {
    policyId: string;
    kind: NonFinancialAlterationKind;
    beneficiaryName?: string;
    beneficiaryRelationship?: string;
    beneficiarySharePct?: number;
    phone?: string;
    email?: string;
    addressLine?: string;
    city?: string;
    nameEn?: string;
    nameAr?: string;
    paymentFrequency?: PaymentFrequency;
    autoRebalanceMonths?: number;
    targetWeights?: Array<{ fundId: string; weightBps: number }>;
    status?: PolicyStatus;
    reason?: string;
    by?: string;
    at?: string;
  }): PolicyAlteration {
    const policy = this.policies.get(input.policyId);
    if (!policy) throw new ErpError(`unknown policy ${input.policyId}`);
    const at = input.at ?? `${w.asOf}T12:00:00+04:00`;
    const by = input.by?.trim() || 'policy-servicing';
    const reason = input.reason?.trim() || 'Policyholder non-financial endorsement request';
    let before = '';
    let after = '';

    switch (input.kind) {
      case 'beneficiary-change': {
        before = `${policy.beneficiary.name} (${policy.beneficiary.relationship}, ${policy.beneficiary.sharePct}%)`;
        policy.beneficiary = {
          name: input.beneficiaryName?.trim() || policy.beneficiary.name,
          relationship: input.beneficiaryRelationship?.trim() || policy.beneficiary.relationship,
          sharePct: Number(input.beneficiarySharePct ?? 100),
        };
        after = `${policy.beneficiary.name} (${policy.beneficiary.relationship}, ${policy.beneficiary.sharePct}%)`;
        break;
      }
      case 'contact-update': {
        const party = w.parties.get(policy.partyId);
        before = party ? `${party.phones[0] ?? '—'} · ${party.emails[0] ?? '—'} · ${party.addresses[0]?.line ?? '—'}` : '—';
        const updated = this.updateCustomer(w, {
          partyId: policy.partyId,
          ...(input.phone ? { phone: input.phone } : {}),
          ...(input.email ? { email: input.email } : {}),
          ...(input.addressLine ? { addressLine: input.addressLine } : {}),
          ...(input.city ? { city: input.city } : {}),
        });
        after = `${updated.phones[0] ?? '—'} · ${updated.emails[0] ?? '—'} · ${updated.addresses[0]?.line ?? '—'}`;
        break;
      }
      case 'name-update': {
        before = `${policy.holderName}${policy.holderNameAr ? ` (${policy.holderNameAr})` : ''}`;
        const updated = this.updateCustomer(w, {
          partyId: policy.partyId,
          ...(input.nameEn ? { nameEn: input.nameEn } : {}),
          ...(input.nameAr !== undefined ? { nameAr: input.nameAr } : {}),
        });
        after = `${updated.names.en}${updated.names.ar ? ` (${updated.names.ar})` : ''}`;
        break;
      }
      case 'payment-frequency': {
        before = policy.paymentFrequency;
        if (!input.paymentFrequency) throw new ErpError('new paymentFrequency is required');
        policy.paymentFrequency = input.paymentFrequency;
        after = policy.paymentFrequency;
        break;
      }
      case 'rebalance-weights': {
        before = (policy.targetWeights ?? []).map((t) => `${t.fundId}:${t.weightBps / 100}%`).join(', ') || 'none';
        const weights = input.targetWeights ?? policy.targetWeights ?? [];
        const totalBps = weights.reduce((s, x) => s + x.weightBps, 0);
        if (weights.length > 0 && totalBps !== 10000) {
          throw new ErpError(`target weights must sum to 10,000 bps (100%), got ${totalBps} bps`);
        }
        policy.targetWeights = weights;
        if (input.autoRebalanceMonths !== undefined) policy.autoRebalanceMonths = Number(input.autoRebalanceMonths);
        if (w.unitLinked.hasPolicy(policy.policyId)) {
          w.unitLinked.updatePolicyMeta(policy.policyId, {
            ...(weights.length > 0 ? { targetWeights: weights } : {}),
            ...(policy.autoRebalanceMonths !== undefined ? { autoRebalanceMonths: policy.autoRebalanceMonths } : {}),
          });
        }
        after = `${weights.map((t) => `${t.fundId}:${t.weightBps / 100}%`).join(', ')} (every ${policy.autoRebalanceMonths ?? 6}m)`;
        break;
      }
      case 'status-change': {
        before = policy.status;
        if (!input.status) throw new ErpError('new policy status is required');
        policy.status = input.status;
        const holdings = w.parties.holdingsOf(policy.partyId).map((h) =>
          h.policyId === policy.policyId ? { ...h, status: policy.status } : h,
        );
        w.parties.recordHoldings(policy.partyId, holdings);
        after = policy.status;
        break;
      }
      default:
        throw new ErpError(`unsupported non-financial alteration kind: ${String(input.kind)}`);
    }

    const record: PolicyAlteration = {
      id: `ALT-${String(++this.alterationSeq).padStart(6, '0')}`,
      policyId: policy.policyId,
      partyId: policy.partyId,
      category: 'non-financial',
      type: 'non-financial',
      kind: input.kind,
      before,
      after,
      summary: `${before} → ${after}`,
      journalIds: [],
      at,
      by,
      reason,
    };
    this.alterations.push(record);
    return record;
  }

  alterPolicyFinancial(w: World, input: {
    policyId: string;
    kind: FinancialAlterationKind;
    newSumAssured?: string | number;
    amount?: string | number;
    fromFundId?: string;
    toFundId?: string;
    fundId?: string;
    chargeCode?: 'coi' | 'admin';
    policyYear?: number;
    reason?: string;
    by?: string;
    at?: string;
  }): PolicyAlteration {
    const policy = this.policies.get(input.policyId);
    if (!policy) throw new ErpError(`unknown policy ${input.policyId}`);
    const at = input.at ?? `${w.asOf}T11:30:00+04:00`;
    const by = input.by?.trim() || 'policy-servicing';
    const reason = input.reason?.trim() || 'Policyholder financial alteration instruction';

    let before = '';
    let after = '';
    let amount: Money | undefined;
    let fee: Money | undefined;
    let journalIds: readonly string[] = [];

    switch (input.kind) {
      case 'sum-assured-change': {
        if (input.newSumAssured === undefined) throw new ErpError('newSumAssured is required for sum-assured-change');
        const nextSa = parseAmount(String(input.newSumAssured), policy.currency);
        if (nextSa.minor <= 0n) throw new ErpError('sum assured must be positive');
        const oldSa = policy.sumAssured;
        const oldPrem = policy.annualPremium;
        before = `Sum assured ${formatAmount(oldSa)} · Annual premium ${formatAmount(oldPrem)}`;
        const nextPrem = oldSa.minor > 0n
          ? money((oldPrem.minor * nextSa.minor) / oldSa.minor, policy.currency)
          : oldPrem;
        policy.sumAssured = nextSa;
        policy.annualPremium = nextPrem;
        if (w.unitLinked.hasPolicy(policy.policyId)) {
          w.unitLinked.updatePolicyMeta(policy.policyId, { sumAssured: nextSa });
        }
        amount = nextSa;
        after = `Sum assured ${formatAmount(nextSa)} · Annual premium ${formatAmount(nextPrem)}`;
        break;
      }

      case 'fund-switch': {
        if (!w.unitLinked.hasPolicy(policy.policyId)) {
          throw new ErpError(`policy ${policy.policyId} is not a unit-linked policy`);
        }
        const fromFundId = input.fromFundId?.trim() || 'FGLOBAL';
        const toFundId = input.toFundId?.trim() || 'FBAL';
        const swAmount = parseAmount(String(input.amount ?? '1000.00'), policy.currency);
        w.unitLinked.ensureFundHolding(policy.policyId, toFundId);
        const beforeUnitsFrom = unitsToDecimal(w.unitLinked.unitsOf(policy.policyId, fromFundId));
        const beforeUnitsTo = unitsToDecimal(w.unitLinked.unitsOf(policy.policyId, toFundId));
        before = `${fromFundId}: ${beforeUnitsFrom} units · ${toFundId}: ${beforeUnitsTo} units`;
        const res = w.unitLinked.switchFund({
          policyId: policy.policyId,
          fromFundId,
          toFundId,
          amount: swAmount,
          instructionAt: at,
        });
        const afterUnitsFrom = unitsToDecimal(w.unitLinked.unitsOf(policy.policyId, fromFundId));
        const afterUnitsTo = unitsToDecimal(w.unitLinked.unitsOf(policy.policyId, toFundId));
        after = `${fromFundId}: ${afterUnitsFrom} units · ${toFundId}: ${afterUnitsTo} units (${res.instructionId})`;
        amount = swAmount;
        fee = res.out.charges[0]?.amount;
        journalIds = res.out.journalIds;
        break;
      }

      case 'partial-withdrawal': {
        if (!w.unitLinked.hasPolicy(policy.policyId)) {
          throw new ErpError(`policy ${policy.policyId} is not a unit-linked policy`);
        }
        const fundId = input.fundId?.trim() || 'FBAL';
        const wdAmount = parseAmount(String(input.amount ?? '500.00'), policy.currency);
        const beforeUnits = unitsToDecimal(w.unitLinked.unitsOf(policy.policyId, fundId));
        before = `${fundId}: ${beforeUnits} units`;
        const res = w.unitLinked.partialWithdraw({
          policyId: policy.policyId,
          fundId,
          amount: wdAmount,
          instructionAt: at,
        });
        after = `${fundId}: ${unitsToDecimal(res.remainingUnits)} units (${formatAmount(res.remainingValue)}) · Paid ${formatAmount(res.netToCustomer)}`;
        amount = wdAmount;
        fee = res.txn.charges[0]?.amount;
        journalIds = res.txn.journalIds;
        break;
      }

      case 'surrender': {
        if (!w.unitLinked.hasPolicy(policy.policyId)) {
          throw new ErpError(`policy ${policy.policyId} is not a unit-linked policy`);
        }
        const fundId = input.fundId?.trim() || 'FBAL';
        const beforeUnits = unitsToDecimal(w.unitLinked.unitsOf(policy.policyId, fundId));
        before = `${fundId}: ${beforeUnits} units · status ${policy.status}`;
        const res = w.unitLinked.surrender({
          policyId: policy.policyId,
          fundId,
          instructionAt: at,
          policyYear: Number(input.policyYear ?? 1),
        });
        const anyUnitsLeft = w.unitLinked.unitsHeld(policy.policyId).some((h) => h.units > 0n);
        if (!anyUnitsLeft) {
          policy.status = 'surrendered';
          const holdings = w.parties.holdingsOf(policy.partyId).map((h) =>
            h.policyId === policy.policyId ? { ...h, status: 'surrendered' } : h,
          );
          w.parties.recordHoldings(policy.partyId, holdings);
        }
        after = `${fundId}: 0 units · Paid ${formatAmount(res.paid)} · status ${policy.status}`;
        amount = res.paid;
        fee = res.charge;
        journalIds = res.txn.journalIds;
        break;
      }

      case 'policy-charge': {
        if (!w.unitLinked.hasPolicy(policy.policyId)) {
          throw new ErpError(`policy ${policy.policyId} is not a unit-linked policy`);
        }
        const fundId = input.fundId?.trim() || 'FGLOBAL';
        const code = input.chargeCode ?? 'admin';
        // A cost-of-insurance charge with no amount is priced from the rating grid — the insured's own
        // age, sex and occupational rank against the product's mortality table — rather than defaulted to
        // a flat figure, because a COI that ignores the risk is the wrong money on the wrong policy.
        const priced = code === 'coi' && input.amount === undefined && this.rating.count() > 0
          ? this.mortalityChargeForPolicy(w, policy.policyId)
          : null;
        const chgAmount = priced ? priced.amount : parseAmount(String(input.amount ?? '25.00'), policy.currency);
        const beforeUnits = unitsToDecimal(w.unitLinked.unitsOf(policy.policyId, fundId));
        before = `${fundId}: ${beforeUnits} units`;
        const txn = w.unitLinked.chargePolicy({
          policyId: policy.policyId,
          fundId,
          code,
          amount: chgAmount,
          instructionAt: at,
          basis: priced ? `${reason} — ${priced.basis}` : reason,
        });
        const afterUnits = unitsToDecimal(w.unitLinked.unitsOf(policy.policyId, fundId));
        after = `${fundId}: ${afterUnits} units (${code} charge deducted${priced ? ` · ${priced.basis}` : ''})`;
        amount = txn.value;
        fee = txn.value;
        journalIds = txn.journalIds;
        break;
      }

      case 'portfolio-rebalance': {
        if (!w.unitLinked.hasPolicy(policy.policyId)) {
          throw new ErpError(`policy ${policy.policyId} is not a unit-linked policy`);
        }
        const beforeSnap = w.unitLinked.valueOf(policy.policyId, at.slice(0, 10));
        before = beforeSnap.byFund.map((f) => `${f.fundId}: ${formatAmount(f.value)}`).join(' · ');
        const moves = w.unitLinked.rebalance({ policyId: policy.policyId, instructionAt: at });
        const afterSnap = w.unitLinked.valueOf(policy.policyId, at.slice(0, 10));
        after = afterSnap.byFund.map((f) => `${f.fundId}: ${formatAmount(f.value)}`).join(' · ') +
          ` (${moves.length} rebalance switch(es))`;
        break;
      }

      default:
        throw new ErpError(`unsupported financial alteration kind: ${String(input.kind)}`);
    }

    const record: PolicyAlteration = {
      id: `ALT-${String(++this.alterationSeq).padStart(6, '0')}`,
      policyId: policy.policyId,
      partyId: policy.partyId,
      category: 'financial',
      type: 'financial',
      kind: input.kind,
      before,
      after,
      summary: `${before} → ${after}`,
      ...(amount ? { amount } : {}),
      ...(fee ? { fee } : {}),
      journalIds,
      at,
      by,
      reason,
    };
    this.alterations.push(record);
    return record;
  }

  /* ======================================= 6. FUNDS, INSTRUMENTS & NAV INJECTION */

  createFund(w: World, input: {
    id: string;
    name: string;
    currency?: string;
    cutoff?: string;
    fmcBpsAnnual?: number;
    benchmark?: string;
    shariahScreened?: boolean;
    composition?: Array<{ instrumentId: string; weightBps: number }>;
    initialGrossAssets?: string | number;
    initialLiabilities?: string | number;
    initialUnits?: string;
    valuationDate?: string;
  }) {
    const id = input.id.trim().toUpperCase();
    const name = input.name.trim();
    if (!id || !name) throw new ErpError('fund id and name are required');
    const currency = (input.currency?.trim() || 'AED').toUpperCase();
    const shariahScreened = Boolean(input.shariahScreened ?? false);

    const defaultComp = shariahScreened
      ? [
          { instrumentId: 'SUKUK-AE', weightBps: 5000 },
          { instrumentId: 'EMAAR', weightBps: 3000 },
          { instrumentId: 'GLD-ETF', weightBps: 2000 },
        ]
      : [
          { instrumentId: 'US-EQ', weightBps: 5000 },
          { instrumentId: 'SUKUK-AE', weightBps: 3000 },
          { instrumentId: 'EMAAR', weightBps: 2000 },
        ];
    const composition = input.composition && input.composition.length > 0 ? input.composition : defaultComp;

    const fundDef: FundDef = singlePriceFund(id, name, currency, {
      dealingRule: { cutoff: input.cutoff?.trim() || '15:00', utcOffsetMinutes: 240, afterCutoff: 'next-business-day' },
      fmcBpsAnnual: Number(input.fmcBpsAnnual ?? 125),
      benchmark: input.benchmark?.trim() || (shariahScreened ? 'FTSE Shariah Index' : 'Composite Benchmark'),
      shariahScreened,
      composition,
    });
    w.nav.defineFund(fundDef);

    // Ensure segregated accounts exist in both conventional and takaful entities so any policy can invest
    for (const entityId of [w.conventionalEntity, w.takafulEntity]) {
      const fid = `${entityId}:${id}`;
      if (!w.ledger.hasAccount(`${fid}:INVESTMENTS`)) {
        w.ledger.defineAccount({ id: `${fid}:INVESTMENTS`, name: `Fund investments — ${id}`, type: 'asset', entityId, fundId: id, currency });
      }
      if (!w.ledger.hasAccount(`${fid}:PARTICIPANTS`)) {
        w.ledger.defineAccount({ id: `${fid}:PARTICIPANTS`, name: `Participants' funds — ${id}`, type: 'liability', entityId, fundId: id, currency });
      }
      if (!w.ledger.hasAccount(`${fid}:RESIDUAL`)) {
        w.ledger.defineAccount({ id: `${fid}:RESIDUAL`, name: `Rounding residual — ${id}`, type: 'equity', entityId, fundId: id, currency });
      }
    }

    // Register 0-unit holding slot on existing unit-linked policies so they can switch/allocate into it
    for (const pol of w.unitLinked.listPolicies()) {
      w.unitLinked.ensureFundHolding(pol.policyId, id);
    }

    // Publish initial NAV valuation so the fund is immediately dealable
    const rawDate = input.valuationDate?.trim() || w.asOf;
    const valDate = isBusinessDay(rawDate, DEFAULT_CALENDAR) ? rawDate : nextBusinessDay(rawDate, DEFAULT_CALENDAR);
    const grossAssets = parseAmount(String(input.initialGrossAssets ?? '5,000.00'), currency);
    const liabilities = parseAmount(String(input.initialLiabilities ?? '0.00'), currency);
    const unitsInIssue = unitsFromDecimal(input.initialUnits?.trim() || '50000.000000');

    const valuation = w.nav.publishValuation({
      fundId: id,
      valuationDate: valDate,
      grossAssets,
      liabilities,
      unitsInIssue,
      source: 'initial fund launch valuation',
    });

    return {
      fundId: id,
      pricePerUnit: unitsToDecimal(valuation.pricePerUnit.micro),
      netAssetValue: formatAmount(valuation.netAssetValue),
      fund: fundDef,
      valuation: {
        valuationDate: valuation.valuationDate,
        navPerUnit: unitsToDecimal(valuation.pricePerUnit.micro),
        netAssetValue: formatAmount(valuation.netAssetValue),
        unitsInIssue: unitsToDecimal(valuation.unitsInIssue),
        residual: formatAmount(valuation.residual),
      },
      warnings: w.nav.compositionWarnings(id),
    };
  }

  injectNav(w: World, input: {
    fundId: string;
    valuationDate?: string;
    grossAssets: string | number;
    liabilities?: string | number;
    unitsInIssue?: string;
    source?: string;
    revisionOf?: string;
  }) {
    const fund = w.nav.fund(input.fundId);
    const rawDate = input.valuationDate?.trim() || w.asOf;
    const valuationDate = isBusinessDay(rawDate, fund.calendar) ? rawDate : nextBusinessDay(rawDate, fund.calendar);
    const grossAssets = parseAmount(String(input.grossAssets), fund.currency);
    const liabilities = parseAmount(String(input.liabilities ?? '0.00'), fund.currency);
    const latest = w.nav.latestValuation(fund.id);
    const unitsInIssue = input.unitsInIssue?.trim()
      ? unitsFromDecimal(input.unitsInIssue.trim())
      : (latest?.unitsInIssue ?? unitsFromDecimal('50000.000000'));

    const valuation = w.nav.publishValuation({
      fundId: fund.id,
      valuationDate,
      grossAssets,
      liabilities,
      unitsInIssue,
      source: input.source?.trim() || 'manual NAV injection (console)',
      ...(input.revisionOf ? { revisionOf: input.revisionOf } : {}),
    });

    const reconcile = w.nav.reconcile(fund.id, valuationDate);
    return {
      fundId: fund.id,
      valuationDate: valuation.valuationDate,
      navPerUnit: unitsToDecimal(valuation.pricePerUnit.micro),
      pricePerUnit: unitsToDecimal(valuation.pricePerUnit.micro),
      grossAssets: formatAmount(valuation.grossAssets),
      liabilities: formatAmount(valuation.liabilities),
      netAssetValue: formatAmount(valuation.netAssetValue),
      unitsInIssue: unitsToDecimal(valuation.unitsInIssue),
      residual: formatAmount(valuation.residual),
      reconciled: reconcile.ok,
      reconcile,
    };
  }

  defineInstrumentAndPrice(w: World, input: {
    id: string;
    name: string;
    assetClass: string;
    isin?: string;
    shariahScreened?: boolean;
    price: number;
    asOf?: string;
    currency?: string;
  }) {
    const id = input.id.trim().toUpperCase();
    const name = input.name.trim();
    if (!id || !name) throw new ErpError('instrument id and name are required');
    const inst: Instrument = {
      id,
      name,
      assetClass: input.assetClass?.trim() || 'equity',
      ...(input.isin?.trim() ? { isin: input.isin.trim() } : {}),
      shariahScreened: Boolean(input.shariahScreened ?? false),
    };
    w.nav.defineInstrument(inst);
    const asOf = input.asOf?.trim() || w.asOf;
    const price = Number(input.price);
    if (!Number.isFinite(price) || price <= 0) throw new ErpError('market price must be positive');
    w.nav.recordMarketPrice({
      instrumentId: id,
      asOf,
      price,
      currency: input.currency?.trim() || 'AED',
    });
    return { instrument: inst, marketPrice: { instrumentId: id, asOf, price, currency: input.currency?.trim() || 'AED' } };
  }

  /* ============================================= 7. REINSURERS & TREATIES */

  createTreaty(w: World, input: {
    id: string;
    name: string;
    counterparty: string;
    kind: TreatyKind;
    basis?: Basis;
    lineOfBusiness?: string;
    from?: string;
    to?: string;
    cessionBps?: number;
    retention?: string | number;
    lines?: number;
    attachment?: string | number;
    limit?: string | number;
    commissionBps?: number;
    settlementDays?: number;
    securityRequiredBps?: number;
    depositAccounted?: boolean;
  }): Treaty {
    const id = input.id.trim().toUpperCase();
    const name = input.name.trim();
    const counterparty = input.counterparty.trim();
    if (!id || !name || !counterparty) throw new ErpError('treaty id, name, and counterparty are required');
    const basis: Basis = input.basis === 'takaful' ? 'takaful' : 'conventional';
    const register = basis === 'takaful' ? w.retakaful : w.reinsurance;
    const currency = 'AED';

    const treaty: Treaty = {
      id,
      name,
      counterparty,
      kind: input.kind,
      basis,
      lineOfBusiness: input.lineOfBusiness?.trim() || 'all',
      currency,
      from: input.from?.trim() || '2026-01-01',
      ...(input.to?.trim() ? { to: input.to.trim() } : { to: '2026-12-31' }),
      ...(input.kind === 'quota-share' || input.kind === 'facultative'
        ? { cessionBps: Number(input.cessionBps ?? 2500) }
        : {}),
      ...(input.kind === 'surplus'
        ? {
            retention: parseAmount(String(input.retention ?? '200,000.00'), currency),
            lines: Number(input.lines ?? 5),
          }
        : {}),
      ...(input.kind === 'excess-of-loss'
        ? {
            attachment: parseAmount(String(input.attachment ?? '500,000.00'), currency),
            limit: parseAmount(String(input.limit ?? '2,000,000.00'), currency),
            reinstatements: 1,
            freeReinstatements: 1,
          }
        : {}),
      commissionBps: Number(input.commissionBps ?? 1500),
      settlementDays: Number(input.settlementDays ?? 60),
      securityRequiredBps: Number(input.securityRequiredBps ?? 3000),
      ...(input.depositAccounted ? { depositAccounted: true } : {}),
    };

    return register.register(treaty);
  }

  /* ------------------------------- the tariff grid a fresh world is priced from
   *
   * The grid is seeded, not invented: every band multiplies the product's own filed base rate per 1,000
   * (or the unit-linked charge schedule's own monthly cost of insurance) by a shape factor in basis
   * points. So `PROD-UL-GLOBAL` priced from its tariff before this grid existed is priced from the same
   * tariff now — a 25-year-old standard life on the base band lands on the filed figure, and the ages,
   * genders, ranks and sums around it are spread from it. A tenant overwrites any row it disagrees with,
   * in the grid or by bulk upload.
   */
  private seedRatingGrid(w: World): void {
    const currency = this.regional.current.localCurrency;
    const AGE_FACTORS = [5500, 8000, 12500, 21000, 36000];
    const SUM_FACTORS = [10000, 10500];
    const GENDER_FACTORS: Record<string, number> = { male: 11000, female: 9200 };
    const CLASS_FACTORS: Record<number, number> = { 1: 10000, 3: 11800, 5: 19000 };
    const seeds = [
      'PROD-UL-GLOBAL', 'PROD-UL-ENDOWMENT', 'PROD-UL-LIFESTYLE', 'PROD-LIFE-TERM',
      'PROD-TKF-FAMILY', 'PROD-CI-COMPREHENSIVE', 'PROD-MEDICAL-GRP',
    ];
    // The monthly cost of insurance the unit-linked engine already charges, as a filed decimal per 1,000.
    const coiLabel = (w.unitLinked.chargeSchedule().coiPerMilleMonthly / 100).toFixed(2);
    for (const productId of seeds) {
      const product = this.products.get(productId);
      if (!product) continue;
      const minAge = product.rules.minAge;
      const maxAge = product.rules.maxAge;
      const span = Math.max(1, maxAge - minAge);
      for (let band = 0; band < AGE_FACTORS.length; band++) {
        const from = minAge + Math.floor((span * band) / AGE_FACTORS.length);
        const to = band === AGE_FACTORS.length - 1 ? maxAge : minAge + Math.floor((span * (band + 1)) / AGE_FACTORS.length) - 1;
        for (let sums = 0; sums < SUM_FACTORS.length; sums++) {
          const minor = applyBps(
            applyBps(money(product.rules.baseRatePerThousandMinor, currency), AGE_FACTORS[band]!),
            SUM_FACTORS[sums]!,
          ).minor;
          this.rating.upsert({
            productId, kind: 'premium', gender: 'unisex', ageFrom: from, ageTo: to, occupationClass: 0,
            sumFrom: sums === 0 ? '0.00' : '250,000.00',
            sumTo: sums === 0 ? '250,000.00' : null,
            ratePerThousand: toDecimalString(money(minor, currency)),
            currency,
            note: sums === 0 ? `Seeded band ${band + 1}: up to 250,000 of cover` : `Seeded band ${band + 1}: 250,000 and above, 5% loading on the tariff`,
            by: 'tariff-seed',
          });
        }
        if (product.category !== 'unit-linked' && product.category !== 'takaful') continue;
        for (const gender of ['male', 'female'] as const) {
          for (const occupationClass of [1, 3, 5]) {
            const minor = applyBps(
              applyBps(
                applyBps(parseAmount(coiLabel, currency), AGE_FACTORS[band]!),
                GENDER_FACTORS[gender]!,
              ),
              CLASS_FACTORS[occupationClass]!,
            ).minor;
            this.rating.upsert({
              productId, kind: 'mortality', gender, ageFrom: from, ageTo: to, occupationClass,
              sumFrom: '0.00', sumTo: null,
              ratePerThousand: toDecimalString(money(minor, currency)),
              currency,
              note: `Cost of insurance per month, class ${occupationClass}, ${gender}, ages ${from}-${to}`,
              by: 'tariff-seed',
            });
          }
        }
      }
    }
  }

  /**
   * Save the product factory's grid in one call.
   *
   * A table of products is edited as a table, so it has to be saved as a table — and a table with one
   * bad row must not lose the twenty good ones. Each row is filed through `defineProductMaster` (the
   * same call the single-product form uses, so there is one path to a product's underwriting rules) and
   * every refusal is collected with the row number it came from, which is what the grid writes back
   * into the row's own cell.
   */
  defineProductMasters(w: World, rows: ProductRowInput[], options: { at?: string; by?: string } = {}): {
    saved: ProductMaster[];
    created: number;
    updated: number;
    rejected: Array<{ index: number; productId: string; reasons: string[] }>;
  } {
    const saved: ProductMaster[] = [];
    const rejected: Array<{ index: number; productId: string; reasons: string[] }> = [];
    let created = 0;
    rows.forEach((row, index) => {
      const productId = String(row.productId ?? '').trim().toUpperCase();
      const reasons: string[] = [];
      if (!productId) reasons.push('A row needs a Product ID before it can be filed.');
      if (productId && !String(row.name ?? '').trim() && !this.products.has(productId)) {
        reasons.push(`${productId} is not on file, so this row has to name the product it is filing.`);
      }
      const minAge = Number(row.minAge);
      const maxAge = Number(row.maxAge);
      if (Number.isFinite(minAge) && Number.isFinite(maxAge) && minAge >= maxAge) {
        reasons.push(`An entry range of ${minAge}–${maxAge} admits nobody.`);
      }
      const auto = numericAmount(row.automaticBindingLimit);
      const fac = numericAmount(row.facultativeThreshold);
      if (auto !== null && fac !== null && fac < auto) {
        reasons.push('The facultative threshold must be at or above the automatic binding limit, or every case goes to the reinsurer.');
      }
      const ai = numericAmount(row.aiStraightThroughLimit);
      if (ai !== null && auto !== null && ai > auto) {
        reasons.push('An AI straight-through limit above the automatic binding limit would let an agent bind what the treaty requires the reinsurer to see.');
      }
      if (reasons.length > 0) { rejected.push({ index, productId, reasons }); return; }
      try {
        const wasOnFile = this.products.has(productId);
        saved.push(this.defineProductMaster(w, {
          productId,
          ...(row.name !== undefined ? { name: String(row.name) } : {}),
          ...(row.secondaryName !== undefined ? { secondaryName: String(row.secondaryName) } : {}),
          ...(row.category !== undefined ? { category: String(row.category) as PolicyCategory } : {}),
          ...(row.line !== undefined ? { line: String(row.line) as ProductLine } : {}),
          ...(row.minAge !== undefined ? { minAge: Number(row.minAge) } : {}),
          ...(row.maxAge !== undefined ? { maxAge: Number(row.maxAge) } : {}),
          ...(row.maxBmi !== undefined ? { maxBmi: Number(row.maxBmi) } : {}),
          ...(row.baseRatePerThousand !== undefined ? { baseRatePerThousand: String(row.baseRatePerThousand) } : {}),
          ...(row.incomeMultiple !== undefined ? { incomeMultiple: Number(row.incomeMultiple) } : {}),
          ...(row.automaticBindingLimit !== undefined ? { automaticBindingLimit: String(row.automaticBindingLimit) } : {}),
          ...(row.facultativeThreshold !== undefined ? { facultativeThreshold: String(row.facultativeThreshold) } : {}),
          ...(row.aiStraightThroughLimit !== undefined ? { aiStraightThroughLimit: String(row.aiStraightThroughLimit) } : {}),
          ...(row.variety !== undefined ? { variety: String(row.variety) } : {}),
          ...(row.blurb !== undefined ? { blurb: String(row.blurb) } : {}),
          ...(row.currency !== undefined ? { currency: String(row.currency) } : {}),
          ...(row.acceptedCountries ? { acceptedCountries: row.acceptedCountries } : {}),
          ...(row.defaultFunds ? { defaultFunds: row.defaultFunds } : {}),
          by: options.by ?? 'product-factory-grid',
        }));
        if (!wasOnFile) created++;
      } catch (error) {
        rejected.push({ index, productId, reasons: [error instanceof Error ? error.message : String(error)] });
      }
    });
    return { saved, created, updated: saved.length - created, rejected };
  }

  /**
   * Copy a product and its tariff: the way a new variety is actually filed.
   *
   * `defineProductMaster` derives an unfiled product from the life manual, which is right for a term
   * plan and wrong for a marine open cover. A copy takes the source's filed rules *and* its rate rows,
   * so the new variety starts as an exact twin and the difference is what the operator then edits.
   */
  copyProductMaster(w: World, input: { sourceProductId: string; productId: string; name?: string; secondaryName?: string; copyRates?: boolean; by?: string }): {
    master: ProductMaster; copiedRateRows: number;
  } {
    const sourceId = input.sourceProductId.trim().toUpperCase();
    const targetId = input.productId.trim().toUpperCase();
    const source = this.products.get(sourceId);
    if (!source) throw new ErpError(`no product ${sourceId} to copy`);
    if (!targetId) throw new ErpError('the copy needs a new Product ID');
    if (this.products.has(targetId)) throw new ErpError(`${targetId} is already on file — copy to a new id rather than over ${targetId}`);
    const master = this.defineProductMaster(w, {
      productId: targetId,
      name: input.name?.trim() || `${source.name} (copy)`,
      secondaryName: input.secondaryName ?? source.secondaryName,
      category: source.category,
      line: source.line,
      variety: source.variety,
      blurb: source.blurb,
      currency: source.currency,
      minAge: source.rules.minAge,
      maxAge: source.rules.maxAge,
      referralMarginYears: source.rules.referralMarginYears,
      maxBmi: source.rules.maxBmi,
      incomeMultiple: source.rules.incomeMultiple,
      baseRatePerThousand: toDecimalString(money(source.rules.baseRatePerThousandMinor, source.currency)),
      automaticBindingLimit: toDecimalString(money(source.rules.automaticBindingLimitMinor, source.currency)),
      facultativeThreshold: toDecimalString(money(source.rules.facultativeThresholdMinor, source.currency)),
      aiStraightThroughLimit: toDecimalString(money(source.rules.aiStraightThroughMinor, source.currency)),
      acceptedCountries: [...source.rules.acceptedCountries],
      defaultFunds: [...source.defaultFunds],
      by: input.by ?? 'product-factory-copy',
    });
    let copiedRateRows = 0;
    if (input.copyRates !== false) {
      for (const row of this.rating.listFor({ productId: sourceId })) {
        this.rating.upsert({
          ...row, productId: targetId, rowId: undefined,
          note: row.note ? `Copied from ${sourceId}: ${row.note}` : `Copied from ${sourceId}`,
          by: input.by ?? 'product-factory-copy',
        });
        copiedRateRows++;
      }
    }
    return { master, copiedRateRows };
  }

  /**
   * Price a named life from the grid, then apply what the partner contract says.
   *
   * The tariff answers "what does this risk cost"; the offer answers "what does this partner sell it
   * for" — an absolute rate per 1,000 where the contract filed one, otherwise an uplift in basis
   * points on the premium or on the monthly cost of insurance. Both steps are exact: an uplift is
   * `applyBps` on money, never a float multiply, and the basis string names the row that priced it.
   */
  priceRisk(w: World, input: {
    productId: string;
    age: number;
    gender?: string;
    occupationClass?: number;
    sumAssured?: string;
    kind?: 'premium' | 'mortality';
    channelCode?: string | null;
    partnerId?: string | null;
  }): {
    price: RatePrice;
    partner: { partnerId: string; name: string; channelCode: string; commissionBps: readonly number[] } | null;
    basis: string;
  } {
    const kind = input.kind ?? 'premium';
    const partnerId = (input.partnerId ?? '').trim().toUpperCase();
    const partner = partnerId ? this.channels.partner(partnerId) : null;

    /** One lookup in the tariff store; `specific` asks for the partner's own rows first. */
    const lookup = (specific: boolean) => this.rating.price({
      productId: input.productId, kind, age: Number(input.age),
      gender: input.gender, occupationClass: input.occupationClass, sumAssured: input.sumAssured,
      channelCode: input.channelCode ?? (specific ? partner?.channelCode ?? null : null),
      partnerId: specific ? partnerId : null,
    });
    // A life sold through a partner is priced from that partner's rows when the tariff holds any, and
    // from the base tariff underneath when it does not: the override is a row, not a fudge afterwards.
    const throughPartner = partnerId ? lookup(true) : null;
    const base = throughPartner && throughPartner.priced ? throughPartner : lookup(false);
    if (!partnerId) {
      return {
        price: base, partner: null,
        basis: base.priced ? `${base.basis} — the base tariff, no partner terms applied` : base.basis,
      };
    }
    if (!partner) throw new ErpError(`no partner ${partnerId} — file the partner on its channel before pricing through it`);
    const terms = this.channels.termsFor(partnerId, input.productId);
    let amount = base.amount;
    let basis = base.basis;
    if (!base.priced) {
      throw new ErpError(`${input.productId.toUpperCase()} cannot be priced for ${partnerId}: ${base.reasons[0] ?? 'no tariff row matched'}`);
    }
    const currency = base.amount.currency;
    if (kind === 'premium' && terms.ratePerThousand !== null) {
      const sumMinor = base.sumAssured.minor;
      const rateMinor = parseAmount(terms.ratePerThousand, currency).minor;
      amount = money((sumMinor * rateMinor) / (1000n * 10n ** BigInt(scaleOf(currency))), currency);
      basis = `${terms.ratePerThousand} per 1,000 (the ${partnerId} contract's own rate) on ${formatAmount(base.sumAssured)}`;
    } else {
      const uplift = kind === 'mortality' ? terms.mortalityUpliftBps : terms.premiumUpliftBps;
      if (uplift !== 0) {
        amount = applyBps(amount, 10000 + uplift);
        basis = `${basis} · ${uplift > 0 ? '+' : ''}${uplift} bps ${kind} uplift from ${terms.source}`;
      } else {
        basis = `${basis} · no uplift on ${terms.source}`;
      }
    }
    return {
      price: { ...base, amount, basis },
      partner: { partnerId: partner.partnerId, name: partner.name, channelCode: partner.channelCode, commissionBps: terms.commissionBps },
      basis,
    };
  }

  /**
   * The monthly cost of insurance a unit-linked policy is charged, taken from the grid rather than from
   * the flat schedule. The insured's age, sex and occupational rank come from the underwriting file the
   * policy was converted from — the risk the decision was taken on, not a guess at it — and the sum
   * assured is the policy's own, so an increase in cover raises the charge without anyone remembering
   * to re-key it.
   */
  mortalityChargeForPolicy(w: World, policyId: string, options: { fallBackToSchedule?: boolean } = {}): {
    amount: Money; basis: string; fromTable: boolean; row: RateRow | null;
  } {
    const policy = this.policies.get(policyId);
    if (!policy) throw new ErpError(`unknown policy ${policyId}`);
    const application = policy.applicationId ? w.underwriting.list().find((a) => a.id === policy.applicationId) : undefined;
    const profile = application?.profile;
    const price = this.rating.price({
      productId: policy.productId, kind: 'mortality',
      age: profile?.age ?? Math.min(45, Math.max(18, policy.commencement ? 45 : 45)),
      gender: profile?.sex ?? 'unisex',
      occupationClass: profile?.occupationClass ?? 0,
      sumAssuredMinor: policy.sumAssured.minor,
    });
    if (price.priced) {
      return { amount: price.amount, basis: price.basis, fromTable: true, row: price.row };
    }
    if (options.fallBackToSchedule === false) {
      throw new ErpError(`${policyId}: ${price.reasons.join(' ')}`);
    }
    const schedule = w.unitLinked.chargeSchedule();
    const perMille = parseAmount((schedule.coiPerMilleMonthly / 100).toFixed(2), policy.currency);
    const amount = money((policy.sumAssured.minor * perMille.minor) / (1000n * 10n ** BigInt(scaleOf(policy.currency))), policy.currency);
    return {
      amount, fromTable: false, row: null,
      basis: `flat schedule: ${toDecimalString(perMille)} per 1,000 of ${formatAmount(policy.sumAssured)} each month (no grid row covers this life)`,
    };
  }

  /* ============================================= 8. MASTER SETTINGS */

  /**
   * Define a product, or re-define one that is already on file.
   *
   * Naming a product id that is in the catalogue prefills every number the catalogue holds for it, so
   * "seed the hull varieties into this tenant" is one call rather than eighty fields typed in. Anything
   * passed explicitly wins, which is how a tenant files its own version of a catalogue product. The
   * currency is the regional master's local currency unless the caller names another one: an amount
   * without a currency is the one thing this codebase refuses to hold.
   */
  defineProductMaster(w: World, input: {
    productId: string;
    name?: string;
    /** The omni-channel display name, filed with the product. Empty string clears it. */
    secondaryName?: string;
    category?: PolicyCategory;
    line?: ProductLine;
    variety?: string;
    blurb?: string;
    currency?: string;
    minAge?: number;
    maxAge?: number;
    referralMarginYears?: number;
    maxBmi?: number;
    baseRatePerThousand?: string | number;
    incomeMultiple?: number;
    automaticBindingLimit?: string | number;
    facultativeThreshold?: string | number;
    aiStraightThroughLimit?: string | number;
    acceptedCountries?: string[];
    evidenceProfile?: string;
    defaultFunds?: string[];
    by?: string;
  }): ProductMaster {
    const productId = input.productId.trim().toUpperCase();
    if (!productId) throw new ErpError('productId is required');
    const onFile = productVariety(productId);
    const existing = this.products.get(productId);
    const name = (input.name ?? onFile?.name ?? existing?.name ?? '').trim();
    if (!name) throw new ErpError('productId and name are required');
    const currency = (input.currency?.trim().toUpperCase() || this.regional.current.localCurrency);
    const category: PolicyCategory = input.category ?? onFile?.category ?? existing?.category ?? 'conventional';
    const line: ProductLine = input.line ?? onFile?.line ?? existing?.line ?? 'life';
    const varietyInput: ProductVariety = {
      ...(onFile ?? {
        productId, name, line, category,
        variety: name, blurb: 'Defined through the master settings product factory.',
        minAge: Number(input.minAge ?? 18), maxAge: Number(input.maxAge ?? 65),
        baseRatePerThousand: String(input.baseRatePerThousand ?? '30.00'),
      }),
      productId,
      name,
      line,
      category,
      variety: (input.variety ?? onFile?.variety ?? name).trim(),
      blurb: (input.blurb ?? onFile?.blurb ?? '').trim() || 'No product wording filed against this variety yet.',
      ...(input.minAge !== undefined ? { minAge: Number(input.minAge) } : {}),
      ...(input.maxAge !== undefined ? { maxAge: Number(input.maxAge) } : {}),
      ...(input.referralMarginYears !== undefined ? { referralMarginYears: Number(input.referralMarginYears) } : {}),
      ...(input.maxBmi !== undefined ? { maxBmi: Number(input.maxBmi) } : {}),
      ...(input.baseRatePerThousand !== undefined ? { baseRatePerThousand: String(input.baseRatePerThousand) } : {}),
      ...(input.incomeMultiple !== undefined ? { incomeMultiple: Number(input.incomeMultiple) } : {}),
      ...(input.automaticBindingLimit !== undefined ? { automaticBindingLimit: String(input.automaticBindingLimit) } : {}),
      ...(input.facultativeThreshold !== undefined ? { facultativeThreshold: String(input.facultativeThreshold) } : {}),
      ...(input.aiStraightThroughLimit !== undefined ? { aiStraightThroughLimit: String(input.aiStraightThroughLimit) } : {}),
      ...(input.acceptedCountries && input.acceptedCountries.length > 0 ? { acceptedCountries: input.acceptedCountries.map((c) => c.trim().toUpperCase()) } : {}),
      ...(input.evidenceProfile ? { evidenceProfile: input.evidenceProfile } : {}),
    };
    if (varietyInput.minAge >= varietyInput.maxAge) {
      throw new ErpError(`entry age ${varietyInput.minAge} cannot be at or above the maximum ${varietyInput.maxAge}`);
    }
    const base = line === 'medical'
      ? (w.underwriting.listProducts().find((r) => r.productId === 'PROD-MEDICAL-GRP') ?? this.rulesFor(varietyInput.productId))
      : this.rulesFor(varietyInput.productId);
    const rules = this.rulesForVariety(varietyInput, currency, base);

    w.underwriting.defineProduct(rules);
    const master: ProductMaster = {
      productId,
      name,
      category,
      line,
      variety: varietyInput.variety,
      blurb: varietyInput.blurb,
      secondaryName: (input.secondaryName ?? existing?.secondaryName ?? '').trim(),
      entityId: category === 'takaful' ? w.takafulEntity : w.conventionalEntity,
      currency,
      defaultFunds: input.defaultFunds && input.defaultFunds.length > 0
        ? input.defaultFunds
        : varietyInput.defaultFunds && varietyInput.defaultFunds.length > 0
          ? [...varietyInput.defaultFunds]
          : category === 'unit-linked' ? ['FGLOBAL', 'FBAL'] : category === 'takaful' ? ['TKF-EQ'] : [],
      rules,
      ...(category === 'takaful' ? { takafulConfig: this.takafulConfig } : {}),
    };
    this.products.set(productId, master);
    return master;
  }

  /** Rules to derive a new product from: the product's own if it is on file, else the life manual. */
  private rulesFor(productId: string): ProductRules {
    try {
      return this.productMaster(productId).rules;
    } catch {
      const life = this.products.get('PROD-LIFE-TERM')?.rules;
      if (life) return life;
      throw new ErpError(`no manual on file to derive ${productId} from — pass the rate and limits explicitly`);
    }
  }

  updateChargesMaster(w: World, patch: Partial<ChargeSchedule>): ChargeSchedule {
    return w.unitLinked.updateCharges(patch);
  }

  updateTakafulMaster(patch: Partial<TakafulProductConfig>): TakafulProductConfig {
    this.takafulConfig = { ...this.takafulConfig, ...patch };
    return this.takafulConfig;
  }

  /**
   * The product master as the ERP holds it, rules included. Anything that has to price, gate or
   * route a product reads it here rather than re-deriving rates from formatted snapshot strings.
   */
  listProductMasters(): ProductMaster[] { return [...this.products.values()]; }

  /**
   * The filed masters in the notation the configuration grid and its sheet use: money as plain decimals
   * rather than as a currency-labelled figure, so a row can be downloaded, edited in a spreadsheet and
   * uploaded back without anybody parsing a string that has " AED" on the end of it.
   */
  productSheet(): Array<{
    productId: string; name: string; secondaryName: string; category: string; line: string;
    minAge: number; maxAge: number; maxBmi: number | null; baseRatePerThousand: string;
    incomeMultiple: number | null; automaticBindingLimit: string; facultativeThreshold: string; aiStraightThroughLimit: string;
  }> {
    return [...this.products.values()].map((p) => ({
      productId: p.productId,
      name: p.name,
      secondaryName: p.secondaryName,
      category: p.category,
      line: p.line,
      minAge: p.rules.minAge,
      maxAge: p.rules.maxAge,
      maxBmi: p.rules.maxBmi ?? null,
      baseRatePerThousand: toDecimalString(money(p.rules.baseRatePerThousandMinor, p.currency)),
      incomeMultiple: p.rules.incomeMultiple ?? null,
      automaticBindingLimit: toDecimalString(money(p.rules.automaticBindingLimitMinor, p.currency)),
      facultativeThreshold: toDecimalString(money(p.rules.facultativeThresholdMinor, p.currency)),
      aiStraightThroughLimit: toDecimalString(money(p.rules.aiStraightThroughMinor, p.currency)),
    }));
  }

  productMaster(productId: string): ProductMaster {
    const product = this.products.get(productId);
    if (!product) throw new ErpError(`unknown product ${productId} — define it in Master Settings first`);
    return product;
  }

  getTakafulConfig(): TakafulProductConfig {
    return this.takafulConfig;
  }

  /** Save tenant capture/display defaults without restating entity books or historical transactions. */
  updateTenantSettings(input: Partial<TenantMasterSettings>): TenantMasterSettings {
    const next: TenantMasterSettings = {
      country: input.country === undefined ? this.tenantSettings.country : input.country.trim().toUpperCase(),
      region: input.region === undefined ? this.tenantSettings.region : input.region.trim(),
      businessDate: input.businessDate === undefined ? this.tenantSettings.businessDate : input.businessDate.trim(),
      timeZone: input.timeZone === undefined ? this.tenantSettings.timeZone : input.timeZone.trim(),
      localCurrency: input.localCurrency === undefined ? this.tenantSettings.localCurrency : input.localCurrency.trim().toUpperCase(),
      foreignCurrency: input.foreignCurrency === undefined ? this.tenantSettings.foreignCurrency : input.foreignCurrency.trim().toUpperCase(),
    };

    if (!/^[A-Z]{2}$/.test(next.country)) throw new ErpError('country must be an ISO 3166-1 alpha-2 code, such as AE or AU');
    if (!next.region) throw new ErpError('region is required');
    const parsedDate = new Date(`${next.businessDate}T00:00:00.000Z`);
    if (!/^[0-9]{4}-[0-9]{2}-[0-9]{2}$/.test(next.businessDate) || Number.isNaN(parsedDate.getTime()) || parsedDate.toISOString().slice(0, 10) !== next.businessDate) {
      throw new ErpError('business date must be a valid calendar date in YYYY-MM-DD format');
    }
    try {
      new Intl.DateTimeFormat('en', { timeZone: next.timeZone }).format(new Date(`${next.businessDate}T00:00:00.000Z`));
    } catch {
      throw new ErpError(`unknown IANA time zone ${next.timeZone}`);
    }
    if (!/^[A-Z]{3}$/.test(next.localCurrency)) throw new ErpError('local currency must be a three-letter ISO 4217 code');
    if (!/^[A-Z]{3}$/.test(next.foreignCurrency)) throw new ErpError('foreign currency must be a three-letter ISO 4217 code');

    this.tenantSettings = next;
    return { ...next };
  }

  updateClaimsAuthorityMaster(w: World, input: { role: string; limit: string | number; isAi?: boolean; book?: 'conventional' | 'takaful' | 'both' }) {
    const role = input.role.trim();
    if (!role) throw new ErpError('authority role is required');
    const limitMinor = parseAmount(String(input.limit), 'AED').minor;
    const entry: Authority = { role, limitMinor, isAi: Boolean(input.isAi ?? false) };
    if (input.book !== 'takaful') w.claims.upsertAuthority(entry);
    if (input.book !== 'conventional') w.takafulClaims.upsertAuthority(entry);
    return w.claims.authorityTable().map((a) => ({ role: a.role, limit: formatAmount(a.limit), isAi: a.isAi }));
  }

  registerFxMaster(w: World, input: { from: string; to?: string; rate: number; asOf?: string; by?: string }) {
    const from = input.from.trim().toUpperCase();
    // The default target is whatever this tenant calls its local currency, not a hardcoded AED: a
    // book run out of Kuala Lumpur quotes into ringgit, and a rate quoted into the wrong currency is
    // worse than no rate at all.
    const to = (input.to?.trim() || this.regional.current.localCurrency).toUpperCase();
    const rate = Number(input.rate);
    if (!from || !Number.isFinite(rate) || rate <= 0) throw new ErpError('valid currency code and positive rate required');
    const asOf = input.asOf?.trim() || w.asOf;
    const numerator = BigInt(Math.round(rate * 10000));
    const denominator = 10000n;
    w.ledger.registerFx({ from, to, numerator, denominator, asOf });
    w.groupRates.register({ from, to, numerator, denominator, asOf });
    this.fxList.push({ from, to, numerator, denominator, asOf });
    /* One rate card, not two: a quote through this door also updates the regional master, so the
       conversion an operator sees on the settings screen is the rate the group consolidation used.
       Either direction is accepted, and the reciprocal is mirrored exactly — a card that only mirrors
       one way would show a rate the ledger has never heard of. */
    const local = this.regional.current.localCurrency;
    const by = input.by?.trim() || 'fx-master';
    if (from !== to && (to === local || from === local)) {
      const code = to === local ? from : to;
      const quoted = to === local ? { numerator, denominator } : { numerator: denominator, denominator: numerator };
      this.regional.setForeignCurrencyRational({ code, ...quoted, asOf, by });
    }
    return { from, to, rate, asOf };
  }

  /* ------------------------------------------- regional master: country, calendar and currencies */

  /** The regional master itself, for anything that has to read the tenant's calendar or currency. */
  regionalSettings(): RegionalDesk { return this.regional; }

  updateRegionalMaster(input: {
    country?: string; region?: string; operatingRegion?: string; timezone?: string;
    dateFormat?: string; timeFormat?: string; weekStart?: string; locale?: string; localCurrency?: string;
    by?: string; at?: string;
  }): RegionalSnapshot {
    try {
      this.regional.update(input);
      return this.regionalSnapshot();
    } catch (error) {
      if (error instanceof RegionalError) throw new ErpError(error.message);
      throw error;
    }
  }

  setRegionalForeignCurrencyMaster(input: { code: string; rate: number | string; asOf?: string; kind?: 'pegged' | 'floating'; by?: string }): RegionalSnapshot {
    try {
      this.regional.setForeignCurrency(input);
    } catch (error) {
      if (error instanceof RegionalError) throw new ErpError(error.message);
      throw error;
    }
    return this.regionalSnapshot();
  }

  removeRegionalForeignCurrencyMaster(input: { code: string; by?: string }): RegionalSnapshot {
    try {
      this.regional.removeForeignCurrency(input.code, { by: input.by });
    } catch (error) {
      if (error instanceof RegionalError) throw new ErpError(error.message);
      throw error;
    }
    return this.regionalSnapshot();
  }

  /** The regional view with the product catalogue's line summary attached, as the console reads it. */
  regionalSnapshot(): RegionalSnapshot {
    const snapshot = this.regional.snapshot();
    return { ...snapshot, lines: catalogueByLine().map((l) => ({ line: l.line, label: l.label, family: l.family, count: l.count })) };
  }

  renameLabelMaster(w: World, input: { scope?: string; key: string; locale?: Locale; text: string; by?: string }) {
    const tenantId = input.scope?.trim() || 'alkhaleej';
    const key = input.key.trim();
    const text = input.text.trim();
    const locale: Locale = input.locale ?? 'en';
    if (!key || !text) throw new ErpError('label key and replacement text are required');
    w.labels.rename({
      tenantId,
      key,
      locale,
      text,
      actor: input.by?.trim() || 'master-settings',
      at: `${w.asOf}T12:00:00+04:00`,
    });
    return { scope: tenantId, key, locale, text };
  }

  /* ============================================= 9. SNAPSHOT FOR UI & API */

  snapshot(w: World) {
    const latestDate = w.nav.listFunds().reduce((max, f) => {
      const d = w.nav.latestValuation(f.id)?.valuationDate ?? w.asOf;
      return d > max ? d : max;
    }, w.asOf);

    const policies = [...this.policies.values()].map((p) => {
      let fundValueLabel: string | null = null;
      let fundHoldings: Array<{ fundId: string; fundName: string; units: string; price: string; value: string; priceAsOf: string }> = [];
      let walletBalance: string | null = null;
      if (p.category === 'unit-linked' && w.unitLinked.hasPolicy(p.policyId)) {
        const val = w.unitLinked.valueOf(p.policyId, latestDate);
        fundValueLabel = formatAmount(val.total);
        fundHoldings = val.byFund.map((f) => ({
          fundId: f.fundId,
          fundName: f.fundName,
          units: f.unitsLabel,
          price: f.price,
          value: formatAmount(f.value),
          priceAsOf: f.priceAsOf,
        }));
      } else if (p.category === 'motor-payg') {
        try {
          walletBalance = formatAmount(w.billing.wallet(p.policyId).balance);
        } catch {
          walletBalance = '0.00 AED';
        }
      }
      return {
        policyId: p.policyId,
        partyId: p.partyId,
        holderName: p.holderName,
        holderNameAr: p.holderNameAr ?? null,
        productId: p.productId,
        productName: p.productName,
        category: p.category,
        entityId: p.entityId,
        currency: p.currency,
        sumAssured: formatAmount(p.sumAssured),
        annualPremium: formatAmount(p.annualPremium),
        totalPremiumPaid: formatAmount(p.totalPremiumPaid),
        paymentFrequency: p.paymentFrequency,
        commencement: p.commencement,
        status: p.status,
        beneficiary: { ...p.beneficiary },
        beneficiaryName: p.beneficiary.name,
        beneficiaryRelationship: p.beneficiary.relationship,
        beneficiarySharePct: p.beneficiary.sharePct,
        alterationCount: this.alterations.filter((a) => a.policyId === p.policyId).length,
        applicationId: p.applicationId ?? null,
        targetWeights: p.targetWeights ? p.targetWeights.map((t) => ({ ...t })) : [],
        autoRebalanceMonths: p.autoRebalanceMonths ?? null,
        fundValue: fundValueLabel,
        fundHoldings,
        walletBalance,
      };
    });

    const proposals = w.underwriting.list().map((a) => {
      const meta = this.proposals.get(a.id);
      const assessment = a.decision ?? w.underwriting.assess(a.id);
      const party = w.parties.get(a.partyId);
      return {
        applicationId: a.id,
        partyId: a.partyId,
        customerName: party?.names.en ?? a.partyId,
        productId: a.productId,
        productName: meta?.productName ?? a.productId,
        category: meta?.category ?? 'conventional',
        paymentFrequency: meta?.paymentFrequency ?? 'annual',
        termYears: meta?.termYears ?? 20,
        beneficiary: meta?.beneficiary ?? { name: 'Legal Heirs', relationship: 'family', sharePct: 100 },
        sumAssured: formatAmount(a.sumAssured),
        standardPremium: formatAmount(assessment.standardPremium),
        loadedPremium: formatAmount(assessment.loadedPremium),
        extraMortalityBps: assessment.extraMortalityBps,
        outcome: assessment.outcome,
        decided: Boolean(a.decision),
        decidedBy: assessment.decidedBy || null,
        decidedByAi: assessment.decidedByAi,
        convertedPolicyId: meta?.convertedPolicyId ?? null,
        convertedAt: meta?.convertedAt ?? null,
        canConvert: (assessment.outcome === 'standard' || assessment.outcome === 'rated' || assessment.outcome === 'excluded') && !meta?.convertedPolicyId,
      };
    });

    const receipts = [...this.receipts].reverse().map((r) => ({
      id: r.id,
      policyId: r.policyId,
      partyId: r.partyId,
      customerName: r.customerName,
      category: r.category,
      amount: formatAmount(r.amount),
      fundId: r.fundId ?? '—',
      unitsAllocated: r.unitsAllocated ?? '—',
      pricePerUnit: r.pricePerUnit ?? '—',
      feeDeducted: r.feeDeducted ? formatAmount(r.feeDeducted) : '0.00 AED',
      at: r.at,
      by: r.by,
      paymentMethod: r.paymentMethod,
      journalIds: [...r.journalIds],
      note: r.note,
    }));

    const alterations = [...this.alterations].reverse().map((a) => ({
      id: a.id,
      policyId: a.policyId,
      partyId: a.partyId,
      category: a.category,
      type: a.type,
      kind: a.kind,
      before: a.before,
      after: a.after,
      summary: a.summary,
      amount: a.amount ? formatAmount(a.amount) : null,
      fee: a.fee ? formatAmount(a.fee) : null,
      journalIds: [...a.journalIds],
      at: a.at,
      by: a.by,
      reason: a.reason,
    }));

    const products = [...this.products.values()].map((p) => ({
      productId: p.productId,
      name: p.name,
      secondaryName: p.secondaryName,
      category: p.category,
      line: p.line,
      variety: p.variety,
      blurb: p.blurb,
      /** How the plan is shown on each channel's shelf, resolved through partner alias > channel alias >
          the product's own secondary name > the registered name. */
      channelNames: this.channels.channelsForProduct(p.productId).map((c) => ({
        channelCode: c.channel.code, channelName: c.channel.name, partners: c.partners, secondaryName: c.secondaryName,
      })),
      partners: this.channels.partnersForProduct(p.productId).map((partner) => ({
        partnerId: partner.partnerId, name: partner.name, channelCode: partner.channelCode, enabled: partner.enabled,
      })),
      /** The tariff grid filed against this product, and where it has holes. */
      rateRows: this.rating.listFor({ productId: p.productId }).length,
      rateGaps: this.rating.ageGaps(p.productId, 'premium').flatMap((g) => g.gaps.map((gap) => ({
        gender: g.gender, occupationClass: g.occupationClass, from: gap.from, to: gap.to,
      }))),
      entityId: p.entityId,
      currency: p.currency,
      defaultFunds: [...p.defaultFunds],
      minAge: p.rules.minAge,
      maxAge: p.rules.maxAge,
      maxBmi: p.rules.maxBmi,
      incomeMultiple: p.rules.incomeMultiple,
      baseRatePerThousand: formatAmount(money(p.rules.baseRatePerThousandMinor, p.currency)),
      automaticBindingLimit: formatAmount(money(p.rules.automaticBindingLimitMinor, p.currency)),
      facultativeThreshold: formatAmount(money(p.rules.facultativeThresholdMinor, p.currency)),
      aiStraightThroughLimit: formatAmount(money(p.rules.aiStraightThroughMinor, p.currency)),
    }));

    const instruments = w.nav.listInstruments().map((inst) => {
      const prices = w.nav.marketPricesList().filter((p) => p.instrumentId === inst.id);
      const latest = prices.at(-1);
      return {
        id: inst.id,
        name: inst.name,
        assetClass: inst.assetClass,
        isin: inst.isin ?? '—',
        shariahScreened: inst.shariahScreened,
        latestPrice: latest?.price ?? 0,
        latestAsOf: latest?.asOf ?? w.asOf,
        currency: latest?.currency ?? 'AED',
      };
    });

    const charges = w.unitLinked.chargeSchedule();

    return {
      summary: {
        customers: w.parties.list().filter((p) => !p.mergedInto).length,
        proposals: proposals.length,
        policies: policies.length,
        receipts: receipts.length,
        alterations: alterations.length,
        funds: w.nav.listFunds().length,
        instruments: instruments.length,
        products: products.length,
        treaties: w.reinsurance.list().length + w.retakaful.list().length,
        claimsOpen: w.claims.position().openClaims + w.takafulClaims.position().openClaims,
      },
      policies,
      proposals,
      receipts,
      alterations,
      master: {
        products,
        productCatalogue: INSURANCE_PRODUCT_CATALOGUE.map((template) => ({ ...template })),
        tenantSettings: { ...this.tenantSettings },
        regional: this.regionalSnapshot(),
        productLines: catalogueByLine().map((l) => ({ line: l.line, label: l.label, family: l.family, count: l.count, productIds: l.productIds })),
        /** The rating grid: the rows, the statistics the screen heads with, and the file trail. */
        rating: {
          rows: this.rating.list(),
          stats: this.rating.stats(),
          trail: this.rating.audit(6),
          template: this.rating.template(['PROD-UL-GLOBAL', 'PROD-LIFE-TERM', 'PROD-TKF-FAMILY']),
        },
        /** The omni-channel: channels with their partners, and each partner's products and terms. */
        channels: this.channels.snapshot(),
        catalogueSize: PRODUCT_CATALOGUE.length,
        charges: {
          allocationChargeBps: charges.allocationChargeBps,
          topupChargeBps: charges.topupChargeBps,
          switchingFeeBps: charges.switchingFeeBps,
          partialWithdrawalFeeBps: charges.partialWithdrawalFeeBps,
          coiPerMilleMonthly: charges.coiPerMilleMonthly,
          adminFeeMonthly: formatAmount(money(BigInt(charges.adminFeeMonthlyMinor), 'AED')),
          adminFeeMonthlyMinor: charges.adminFeeMonthlyMinor,
        },
        unitLinkedCharges: {
          allocationChargeBps: charges.allocationChargeBps,
          topupChargeBps: charges.topupChargeBps,
          switchingFeeBps: charges.switchingFeeBps,
          partialWithdrawalFeeBps: charges.partialWithdrawalFeeBps,
          coiPerMilleMonthly: charges.coiPerMilleMonthly,
          adminFeeMonthly: formatAmount(money(BigInt(charges.adminFeeMonthlyMinor), 'AED')),
          adminFeeMonthlyMinor: charges.adminFeeMonthlyMinor,
        },
        claimsAuthority: w.claims.authorityTable().map((a) => ({
          role: a.role,
          limit: formatAmount(a.limit),
          isAi: a.isAi,
        })),
        takafulConfig: { ...this.takafulConfig },
        instruments,
        fxRates: this.fxList.map((f) => ({
          from: f.from,
          to: f.to,
          rate: (Number(f.numerator) / Number(f.denominator)).toFixed(4),
          asOf: f.asOf,
        })),
      },
    };
  }
}
