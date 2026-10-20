/**
 * Smart Auto-Pick Memory, Configurable Actuarial Age Calculation (Age Last / Age Nearest / Age Next),
 * Dependent Products Auto-Selection & Domain ComboBox Suggestions.
 *
 * Eliminates duplicate field entry across Customer 360, Guided Customer Journey, Underwriting Proposals,
 * Quotations, Illustrations and Policy Servicing while keeping every derived figure deterministic,
 * explainable and governed from Master Settings.
 */
import type { World } from './demo.js';
import { formatAmount } from './money.js';
import { RIDER_CATALOGUE, OCCUPATION_LABELS } from './loadings.js';
import { CONDITION_RULES, PURSUIT_RULES, FAMILY_HISTORY_RULES } from './underwriting.js';

export type AgeBasis = 'age-nearest' | 'age-next' | 'age-last';
export type HalfYearRule = 'six-months' | 'days';

export interface AgeBasisMeta {
  readonly id: AgeBasis;
  readonly code: 'ANB' | 'ANxB' | 'ALB';
  readonly label: string;
  readonly shortLabel: string;
  readonly summary: string;
}

export const AGE_BASIS_CATALOGUE: readonly AgeBasisMeta[] = Object.freeze([
  {
    id: 'age-nearest',
    code: 'ANB',
    label: 'Age Nearest Birthday (ANB — 6-month / half-year rule)',
    shortLabel: 'Age Nearest (ANB)',
    summary: 'Rounds to the closest birthday on the valuation date: adds 1 year once 6 months (or half the birthday year) have elapsed.',
  },
  {
    id: 'age-next',
    code: 'ANxB',
    label: 'Age Next Birthday (ANxB — upcoming birthday age)',
    shortLabel: 'Age Next (ANxB)',
    summary: 'Uses the age attained on the upcoming birthday (completed years + 1, or completed years if valued on the exact birthday).',
  },
  {
    id: 'age-last',
    code: 'ALB',
    label: 'Age Last Birthday (ALB — completed integer years)',
    shortLabel: 'Age Last (ALB)',
    summary: 'Uses exact completed years since date of birth as of the valuation date, with no upward rounding.',
  },
]);

export interface AgeCalculationResult {
  readonly dob: string;
  readonly valuationDate: string;
  readonly basis: AgeBasis;
  readonly basisCode: 'ANB' | 'ANxB' | 'ALB';
  readonly basisLabel: string;
  readonly effectiveAge: number;
  readonly ageLast: number;
  readonly ageNearest: number;
  readonly ageNext: number;
  readonly completedMonthsAfterBirthday: number;
  readonly daysSinceLastBirthday: number;
  readonly daysToNextBirthday: number;
  readonly exactBirthdayToday: boolean;
  readonly formulaNote: string;
}

export interface AgeCalculationAuditEntry {
  readonly at: string;
  readonly by: string;
  readonly summary: string;
}

export interface DependentProductItem {
  readonly code: string;
  readonly name: string;
  readonly kind: 'rider' | 'linked-product';
  readonly mandatory: boolean;
  readonly shariahEligible: boolean;
  readonly loadingBps: number;
  readonly reason: string;
}

export interface DependentProductRule {
  readonly baseProductId: string;
  readonly baseProductPattern?: 'unit-linked' | 'takaful' | 'conventional' | 'motor-payg';
  readonly autoPickCodes: readonly string[];
  readonly optionalCodes: readonly string[];
  readonly linkedProductIds: readonly string[];
  readonly note: string;
  readonly updatedAt: string;
  readonly updatedBy: string;
}

export class AutoPickConfigError extends Error {}

function parseIsoDateParts(iso: string): { year: number; month: number; day: number; utcMs: number } | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso.trim());
  if (!m) return null;
  const year = Number(m[1]);
  const month = Number(m[2]);
  const day = Number(m[3]);
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  const utcMs = Date.UTC(year, month - 1, day);
  const check = new Date(utcMs);
  if (check.getUTCFullYear() !== year || check.getUTCMonth() + 1 !== month || check.getUTCDate() !== day) {
    return null;
  }
  return { year, month, day, utcMs };
}

function isLeapYear(year: number): boolean {
  return (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
}

/** Resolve birthday in a given calendar year (mapping Feb 29 to Feb 28 in non-leap years). */
function birthdayInYear(year: number, birthMonth: number, birthDay: number): { month: number; day: number; utcMs: number } {
  const day = birthMonth === 2 && birthDay === 29 && !isLeapYear(year) ? 28 : birthDay;
  return { month: birthMonth, day, utcMs: Date.UTC(year, birthMonth - 1, day) };
}

const MS_PER_DAY = 86_400_000;

/**
 * Pure, deterministic actuarial age calculator supporting Age Last Birthday (ALB),
 * Age Nearest Birthday (ANB), and Age Next Birthday (ANxB).
 */
export function calculateActuarialAge(
  dob: string,
  valuationDate: string,
  basis: AgeBasis = 'age-nearest',
  halfYearRule: HalfYearRule = 'six-months',
): AgeCalculationResult {
  const birth = parseIsoDateParts(dob);
  if (!birth) throw new AutoPickConfigError(`invalid date of birth "${dob}" — expected YYYY-MM-DD`);
  const asOf = parseIsoDateParts(valuationDate);
  if (!asOf) throw new AutoPickConfigError(`invalid valuation date "${valuationDate}" — expected YYYY-MM-DD`);
  if (birth.utcMs > asOf.utcMs) {
    throw new AutoPickConfigError(`date of birth ${dob} cannot be after valuation date ${valuationDate}`);
  }

  const thisYearBday = birthdayInYear(asOf.year, birth.month, birth.day);
  const completedBirthdayThisYear = asOf.utcMs >= thisYearBday.utcMs;
  const ageLast = Math.max(0, asOf.year - birth.year - (completedBirthdayThisYear ? 0 : 1));

  const lastBdayYear = completedBirthdayThisYear ? asOf.year : asOf.year - 1;
  const lastBday = birthdayInYear(lastBdayYear, birth.month, birth.day);
  const nextBday = birthdayInYear(lastBdayYear + 1, birth.month, birth.day);

  const daysSinceLastBirthday = Math.round((asOf.utcMs - lastBday.utcMs) / MS_PER_DAY);
  const daysToNextBirthday = Math.round((nextBday.utcMs - asOf.utcMs) / MS_PER_DAY);
  const exactBirthdayToday = daysSinceLastBirthday === 0;

  let monthsAfter = (asOf.year - lastBdayYear) * 12 + (asOf.month - lastBday.month);
  if (asOf.day < lastBday.day) monthsAfter -= 1;
  const completedMonthsAfterBirthday = Math.max(0, monthsAfter);

  const roundsUpNearest = halfYearRule === 'days'
    ? daysSinceLastBirthday >= daysToNextBirthday
    : completedMonthsAfterBirthday >= 6;

  const ageNearest = roundsUpNearest ? ageLast + 1 : ageLast;
  const ageNext = exactBirthdayToday ? ageLast : ageLast + 1;

  const effectiveAge = basis === 'age-last'
    ? ageLast
    : basis === 'age-next'
      ? ageNext
      : ageNearest;

  const meta = AGE_BASIS_CATALOGUE.find((b) => b.id === basis) ?? AGE_BASIS_CATALOGUE[0]!;
  const formulaNote = `${meta.shortLabel} = ${effectiveAge} yrs on ${valuationDate} from DOB ${dob} `
    + `(ALB: ${ageLast}, ANB: ${ageNearest}, ANxB: ${ageNext}; ${completedMonthsAfterBirthday}m / ${daysSinceLastBirthday}d since last birthday, ${daysToNextBirthday}d to next).`;

  return {
    dob,
    valuationDate,
    basis,
    basisCode: meta.code,
    basisLabel: meta.label,
    effectiveAge,
    ageLast,
    ageNearest,
    ageNext,
    completedMonthsAfterBirthday,
    daysSinceLastBirthday,
    daysToNextBirthday,
    exactBirthdayToday,
    formulaNote,
  };
}

/** Safe helper that returns null instead of throwing when DOB is incomplete while typing. */
export function tryCalculateActuarialAge(
  dob: string | undefined,
  valuationDate: string,
  basis: AgeBasis = 'age-nearest',
  halfYearRule: HalfYearRule = 'six-months',
): AgeCalculationResult | null {
  if (!dob || !dob.trim()) return null;
  try {
    return calculateActuarialAge(dob.trim(), valuationDate, basis, halfYearRule);
  } catch {
    return null;
  }
}

export class AgeCalculationRegistry {
  private defaultBasis: AgeBasis = 'age-nearest';
  private halfYearRule: HalfYearRule = 'six-months';
  private autoSyncDobToAge = true;
  private readonly productOverrides = new Map<string, AgeBasis>([
    ['PROD-LIFE-TERM', 'age-nearest'],
    ['PROD-UL-GLOBAL', 'age-nearest'],
    ['PROD-TKF-FAMILY', 'age-next'],
    ['PROD-MTR-PAYG', 'age-last'],
  ]);
  private readonly auditLog: AgeCalculationAuditEntry[] = [];

  basisForProduct(productId?: string): AgeBasis {
    if (productId) {
      const clean = productId.trim().toUpperCase();
      const hit = this.productOverrides.get(clean);
      if (hit) return hit;
    }
    return this.defaultBasis;
  }

  calculate(dob: string, valuationDate: string, productId?: string): AgeCalculationResult {
    return calculateActuarialAge(dob, valuationDate, this.basisForProduct(productId), this.halfYearRule);
  }

  update(input: {
    defaultBasis?: AgeBasis;
    halfYearRule?: HalfYearRule;
    autoSyncDobToAge?: boolean;
    productOverrides?: Record<string, AgeBasis | '' | null>;
    by?: string;
    at?: string;
  }) {
    const validBases: readonly string[] = ['age-nearest', 'age-next', 'age-last'];
    if (input.defaultBasis !== undefined) {
      if (!validBases.includes(input.defaultBasis)) {
        throw new AutoPickConfigError(`unknown age basis "${String(input.defaultBasis)}" — expected age-nearest, age-next or age-last`);
      }
      this.defaultBasis = input.defaultBasis;
    }
    if (input.halfYearRule !== undefined) {
      if (input.halfYearRule !== 'six-months' && input.halfYearRule !== 'days') {
        throw new AutoPickConfigError(`unknown half-year rule "${String(input.halfYearRule)}"`);
      }
      this.halfYearRule = input.halfYearRule;
    }
    if (typeof input.autoSyncDobToAge === 'boolean') {
      this.autoSyncDobToAge = input.autoSyncDobToAge;
    }
    if (input.productOverrides && typeof input.productOverrides === 'object') {
      for (const [rawProd, rawBasis] of Object.entries(input.productOverrides)) {
        const prod = rawProd.trim().toUpperCase();
        if (!prod) continue;
        if (rawBasis === '' || rawBasis === null) {
          this.productOverrides.delete(prod);
        } else if (validBases.includes(rawBasis)) {
          this.productOverrides.set(prod, rawBasis);
        } else {
          throw new AutoPickConfigError(`invalid override basis "${String(rawBasis)}" for ${prod}`);
        }
      }
    }
    const by = input.by?.trim() || 'master-admin';
    const at = input.at?.trim() || '2026-10-05T12:00:00+04:00';
    this.auditLog.push({
      at,
      by,
      summary: `Default basis=${this.defaultBasis} (${this.halfYearRule}), autoSync=${this.autoSyncDobToAge}, overrides=${this.productOverrides.size}`,
    });
    return this.snapshot();
  }

  snapshot() {
    return {
      defaultBasis: this.defaultBasis,
      halfYearRule: this.halfYearRule,
      autoSyncDobToAge: this.autoSyncDobToAge,
      options: AGE_BASIS_CATALOGUE.map((b) => ({ ...b })),
      productOverrides: Object.fromEntries([...this.productOverrides.entries()].sort(([a], [b]) => a.localeCompare(b))),
      audit: this.auditLog.slice(-10),
    };
  }
}

export class DependentProductsRegistry {
  private readonly rules = new Map<string, DependentProductRule>();

  constructor() {
    const seededAt = '2026-10-05T09:00:00+04:00';
    const seeds: DependentProductRule[] = [
      {
        baseProductId: 'PROD-UL-GLOBAL',
        baseProductPattern: 'unit-linked',
        autoPickCodes: ['critical-illness', 'waiver-of-premium'],
        optionalCodes: ['accidental-death', 'hospital-cash', 'permanent-disability'],
        linkedProductIds: ['PROD-CRITICAL-ILLNESS', 'PROD-PA-EXEC'],
        note: 'Unit-linked wealth & protection plan auto-attaches Critical Illness Acceleration + Waiver of Premium on Disability.',
        updatedAt: seededAt,
        updatedBy: 'actuarial-seed',
      },
      {
        baseProductId: 'PROD-LIFE-TERM',
        baseProductPattern: 'conventional',
        autoPickCodes: ['accidental-death', 'waiver-of-premium'],
        optionalCodes: ['critical-illness', 'permanent-disability'],
        linkedProductIds: ['PROD-CRITICAL-ILLNESS'],
        note: 'Individual Level Term plan auto-picks Accidental Death Benefit + Waiver of Premium.',
        updatedAt: seededAt,
        updatedBy: 'actuarial-seed',
      },
      {
        baseProductId: 'PROD-TKF-FAMILY',
        baseProductPattern: 'takaful',
        autoPickCodes: ['critical-illness', 'waiver-of-premium'],
        optionalCodes: ['permanent-disability', 'hospital-cash'],
        linkedProductIds: ['PROD-TKF-SAVINGS'],
        note: 'Family Takaful plan auto-picks Shariah-screened Critical Illness Takaful Rider + Contribution Waiver.',
        updatedAt: seededAt,
        updatedBy: 'shariah-product-seed',
      },
      {
        baseProductId: 'PROD-MTR-PAYG',
        baseProductPattern: 'motor-payg',
        autoPickCodes: ['accidental-death'],
        optionalCodes: ['hospital-cash'],
        linkedProductIds: ['PROD-PA-DRIVER'],
        note: 'Pay-as-you-go Motor cover auto-picks Driver Personal Accident protection.',
        updatedAt: seededAt,
        updatedBy: 'motor-product-seed',
      },
    ];
    for (const s of seeds) this.rules.set(s.baseProductId, s);
  }

  upsertRule(input: {
    baseProductId: string;
    autoPickCodes: readonly string[];
    optionalCodes?: readonly string[];
    linkedProductIds?: readonly string[];
    note?: string;
    by?: string;
    at?: string;
  }): DependentProductRule {
    const id = input.baseProductId.trim().toUpperCase();
    if (!id) throw new AutoPickConfigError('baseProductId is required');
    const rule: DependentProductRule = {
      baseProductId: id,
      autoPickCodes: [...new Set(input.autoPickCodes.map((c) => c.trim()).filter(Boolean))],
      optionalCodes: [...new Set((input.optionalCodes ?? []).map((c) => c.trim()).filter(Boolean))],
      linkedProductIds: [...new Set((input.linkedProductIds ?? []).map((c) => c.trim().toUpperCase()).filter(Boolean))],
      note: input.note?.trim() || `Configured dependent products for ${id}`,
      updatedAt: input.at?.trim() || '2026-10-05T12:00:00+04:00',
      updatedBy: input.by?.trim() || 'master-admin',
    };
    this.rules.set(id, rule);
    return rule;
  }

  resolveForProduct(baseProductId: string, category?: string, shariahOnly = false): {
    rule: DependentProductRule;
    autoPicked: DependentProductItem[];
    optional: DependentProductItem[];
  } {
    const id = baseProductId.trim().toUpperCase();
    const direct = this.rules.get(id);
    const fallbackRule: DependentProductRule = direct ?? (
      category === 'takaful' || shariahOnly
        ? this.rules.get('PROD-TKF-FAMILY')!
        : category === 'unit-linked'
          ? this.rules.get('PROD-UL-GLOBAL')!
          : category === 'motor-payg'
            ? this.rules.get('PROD-MTR-PAYG')!
            : this.rules.get('PROD-LIFE-TERM')!
    );

    const toItems = (codes: readonly string[], mandatory: boolean): DependentProductItem[] => codes
      .map((code): DependentProductItem | null => {
        const rider = RIDER_CATALOGUE.find((r) => r.code === code);
        if (!rider) return null;
        if (shariahOnly && !rider.shariahEligible) return null;
        return {
          code: rider.code,
          name: rider.name,
          kind: 'rider',
          mandatory,
          shariahEligible: rider.shariahEligible,
          loadingBps: rider.loadingBps,
          reason: fallbackRule.note,
        };
      })
      .filter((item): item is DependentProductItem => Boolean(item));

    const autoPicked = toItems(fallbackRule.autoPickCodes, false);
    const linked: DependentProductItem[] = fallbackRule.linkedProductIds.map((pid) => ({
      code: pid,
      name: pid,
      kind: 'linked-product',
      mandatory: false,
      shariahEligible: category === 'takaful' || shariahOnly ? pid.includes('TKF') : true,
      loadingBps: 0,
      reason: `Linked companion cover for ${id || fallbackRule.baseProductId}`,
    }));
    return {
      rule: fallbackRule,
      autoPicked: [...autoPicked, ...linked],
      optional: toItems(fallbackRule.optionalCodes, false),
    };
  }

  snapshot() {
    return {
      rules: [...this.rules.values()].map((r) => ({ ...r })),
      riderCatalogue: RIDER_CATALOGUE.map((r) => ({
        code: r.code,
        name: r.name,
        loadingBps: r.loadingBps,
        shariahEligible: r.shariahEligible,
        note: r.note,
      })),
    };
  }
}

export interface ComboSuggestionItem {
  readonly value: string;
  readonly label: string;
  readonly category?: string;
  readonly description?: string;
  readonly badge?: string;
}

export function buildSmartSuggestions(w: World): {
  productNames: ComboSuggestionItem[];
  productDescriptions: ComboSuggestionItem[];
  dependentProducts: ComboSuggestionItem[];
  occupations: ComboSuggestionItem[];
  conditions: ComboSuggestionItem[];
  pursuits: ComboSuggestionItem[];
  familyHistory: ComboSuggestionItem[];
  relationships: ComboSuggestionItem[];
  cities: ComboSuggestionItem[];
  partnerIds: ComboSuggestionItem[];
} {
  const products = w.erp.listProductMasters();
  const productNames: ComboSuggestionItem[] = products.slice(0, 40).map((p) => ({
    value: p.name,
    label: `${p.name} (${p.productId})`,
    category: p.category,
    description: `Ages ${p.rules.minAge}–${p.rules.maxAge} · ${p.rules.line} · ${p.currency}`,
    badge: p.category,
  }));

  const productDescriptions: ComboSuggestionItem[] = [
    {
      value: 'Flexible unit-linked wealth & family protection plan with multi-fund look-through and optional CI/WOP riders',
      label: 'Unit-linked wealth & family protection blurb',
      category: 'unit-linked',
      badge: 'AI suggested',
    },
    {
      value: 'Shariah-screened Family Takaful protection & savings plan under Wakalah + Tabarru model',
      label: 'Family Takaful Wakalah + Tabarru blurb',
      category: 'takaful',
      badge: 'AI suggested',
    },
    {
      value: 'Level term life protection with guaranteed renewal rate card, accidental death and waiver of premium',
      label: 'Level Term Life shelf description',
      category: 'conventional',
      badge: 'AI suggested',
    },
    {
      value: 'Bancassurance premier wealth & mortgage protection plan with instant straight-through underwriting',
      label: 'Bancassurance Premier shelf description',
      category: 'bancassurance',
      badge: 'AI suggested',
    },
    {
      value: 'Pay-as-you-go micro-duration cover billed strictly during active start/stop protection segments',
      label: 'Micro-duration Pay-As-You-Go shelf description',
      category: 'motor-payg',
      badge: 'AI suggested',
    },
    {
      value: 'Multi-country corporate group protection & executive key-person cover across licensed branches',
      label: 'Corporate / Multi-country Broker shelf description',
      category: 'corporate',
      badge: 'AI suggested',
    },
  ];

  const dependentProducts: ComboSuggestionItem[] = [
    ...RIDER_CATALOGUE.map((r) => ({
      value: r.code,
      label: `${r.name} (${r.code})`,
      category: r.shariahEligible ? 'Conventional & Takaful' : 'Conventional only',
      description: `${r.loadingBps} bps · ${r.note}`,
      badge: 'Rider',
    })),
    ...products.slice(0, 12).map((p) => ({
      value: p.productId,
      label: `${p.name} (${p.productId})`,
      category: p.category,
      description: `Companion policy · ${p.rules.line}`,
      badge: 'Linked cover',
    })),
  ];

  const occupations: ComboSuggestionItem[] = Object.entries(OCCUPATION_LABELS).map(([cls, label]) => ({
    value: label,
    label: `Class ${cls} — ${label}`,
    category: `Class ${cls}`,
    badge: Number(cls) <= 2 ? 'Standard' : 'Loaded',
  }));

  const conditions: ComboSuggestionItem[] = CONDITION_RULES.map((c) => ({
    value: c.code,
    label: `${c.label} (${c.code})`,
    category: `${c.extraMortalityBps} bps`,
    description: c.evidence ? c.evidence.join(', ') : 'Standard underwriting review',
    badge: c.extraMortalityBps >= 10000 ? 'High loading' : 'Auto-rate',
  }));

  const pursuits: ComboSuggestionItem[] = PURSUIT_RULES.map((p) => ({
    value: p.code,
    label: `${p.code} (+${p.extraMortalityBps} bps)`,
    description: p.exclusion ?? 'Standard pursuit loading',
    badge: 'Pursuit',
  }));

  const familyHistory: ComboSuggestionItem[] = FAMILY_HISTORY_RULES.map((f) => ({
    value: f.code,
    label: `${f.code} (+${f.extraMortalityBps} bps)`,
    badge: 'Family hx',
  }));

  const relationships: ComboSuggestionItem[] = [
    { value: 'Spouse', label: 'Spouse (Primary family beneficiary)', badge: 'Insurable interest' },
    { value: 'Child / Son / Daughter', label: 'Child / Son / Daughter (Minor guardian check if < 18)', badge: 'Insurable interest' },
    { value: 'Parent / Father / Mother', label: 'Parent / Father / Mother', badge: 'Insurable interest' },
    { value: 'Legal Heirs / Estate', label: 'Legal Heirs / Estate (Statutory distribution)', badge: 'Standard' },
    { value: 'Employer / Key-Person Assignee', label: 'Employer / Key-Person Corporate Assignee', badge: 'Business cover' },
    { value: 'Mortgagee Bank Assignment', label: 'Mortgagee Bank Assignment (Bancassurance)', badge: 'Bank collateral' },
  ];

  const cities: ComboSuggestionItem[] = [
    { value: 'Dubai', label: 'Dubai (UAE)', badge: 'AE' },
    { value: 'Abu Dhabi', label: 'Abu Dhabi (UAE)', badge: 'AE' },
    { value: 'Sharjah', label: 'Sharjah (UAE)', badge: 'AE' },
    { value: 'Al Ain', label: 'Al Ain (UAE)', badge: 'AE' },
    { value: 'Kuala Lumpur', label: 'Kuala Lumpur (MY)', badge: 'MY' },
    { value: 'Riyadh', label: 'Riyadh (KSA)', badge: 'SA' },
    { value: 'Sydney', label: 'Sydney (NSW, AU)', badge: 'AU' },
  ];

  const partnerIds: ComboSuggestionItem[] = w.erp.channels.listPartners().map((p) => ({
    value: p.partnerId,
    label: `${p.partnerId} — ${p.name}`,
    category: p.channelCode,
    badge: p.channelCode,
  }));

  return {
    productNames,
    productDescriptions,
    dependentProducts,
    occupations,
    conditions,
    pursuits,
    familyHistory,
    relationships,
    cities,
    partnerIds,
  };
}

export interface AutoPickResolution {
  readonly partyId: string | null;
  readonly customerName: string | null;
  readonly nameAr: string | null;
  readonly dob: string | null;
  readonly ageCalculation: AgeCalculationResult | null;
  readonly age: number | null;
  readonly sex: 'male' | 'female' | null;
  readonly smoker: boolean | null;
  readonly heightCm: number | null;
  readonly weightKg: number | null;
  readonly bmi: number | null;
  readonly occupationClass: 1 | 2 | 3 | 4 | 5 | null;
  readonly occupationTitle: string | null;
  readonly annualIncome: string | null;
  readonly phone: string | null;
  readonly email: string | null;
  readonly addressLine: string | null;
  readonly city: string | null;
  readonly country: string | null;
  readonly beneficiaryName: string | null;
  readonly beneficiaryRelationship: string | null;
  readonly baseProductId: string | null;
  readonly autoPickedRiders: string[];
  readonly dependentProducts: DependentProductItem[];
  readonly optionalDependentProducts: DependentProductItem[];
  readonly targetFunds: string[];
  readonly sources: Record<string, string>;
}

/**
 * Resolves all previously supplied customer, underwriting, journey and product dependency facts
 * from one place so downstream forms auto-pick values instead of asking twice.
 */
export function resolveCustomerAutoPick(
  w: World,
  input: {
    partyId?: string;
    caseId?: string;
    dob?: string;
    productId?: string;
    valuationDate?: string;
  },
): AutoPickResolution {
  const sources: Record<string, string> = {};
  const valuationDate = input.valuationDate?.trim() || w.asOf;

  const journeyCase = input.caseId
    ? w.journey.list().find((c) => c.caseId === input.caseId)
    : undefined;

  const identityAns = journeyCase?.answers['identity'] ?? {};
  const needsAns = journeyCase?.answers['needs'] ?? {};
  const coverageAns = journeyCase?.answers['coverage'] ?? {};
  const loadingsAns = journeyCase?.answers['loadings'] ?? {};
  const recAns = journeyCase?.answers['recommendation'] ?? {};
  const ridersAns = journeyCase?.answers['riders'] ?? {};

  let resolvedPartyId = input.partyId?.trim() || journeyCase?.artefacts.partyId || null;
  if (!resolvedPartyId && identityAns['email']) {
    const byEmail = w.parties.list().find((p) => !p.mergedInto && p.emails.some((e) => e.toLowerCase() === String(identityAns['email']).toLowerCase()));
    if (byEmail) resolvedPartyId = byEmail.id;
  }
  const party = resolvedPartyId ? w.parties.goldenRecord(resolvedPartyId) ?? w.parties.get(resolvedPartyId) : undefined;

  // Previous underwriting application for this party, if one exists on file!
  const priorApp = resolvedPartyId
    ? [...w.underwriting.list()].reverse().find((a) => a.partyId === resolvedPartyId)
    : undefined;
  const erpSnap = w.erp.snapshot(w);
  const priorProposal = resolvedPartyId
    ? [...erpSnap.proposals].reverse().find((p) => p.partyId === resolvedPartyId)
    : undefined;

  const customerName = String(identityAns['nameEn'] ?? '') || party?.names.en || null;
  if (customerName) sources['customerName'] = identityAns['nameEn'] ? `Journey ${journeyCase!.caseId} (Identity)` : `Golden record ${party!.id}`;

  const nameAr = String(identityAns['nameAr'] ?? '') || party?.names.ar || null;
  if (nameAr) sources['nameAr'] = identityAns['nameAr'] ? `Journey ${journeyCase!.caseId} (Identity)` : `Golden record ${party!.id}`;

  const dob = input.dob?.trim() || String(identityAns['dateOfBirth'] ?? '').trim() || party?.dateOfBirth || null;
  if (dob) {
    sources['dob'] = input.dob?.trim()
      ? 'Entered date of birth'
      : identityAns['dateOfBirth']
        ? `Journey ${journeyCase!.caseId} (Identity)`
        : `Golden record ${party!.id}`;
  }

  const baseProductId = (
    input.productId?.trim()
    || String(recAns['productId'] ?? '').trim()
    || priorProposal?.productId
    || party?.dependentProducts?.[0]
    || null
  );
  if (baseProductId) {
    sources['baseProductId'] = input.productId?.trim()
      ? 'Selected product'
      : recAns['productId']
        ? `Journey ${journeyCase!.caseId} (Recommendation)`
        : `Prior proposal ${priorProposal?.applicationId ?? 'profile'}`;
  }

  const ageCalculation = dob
    ? tryCalculateActuarialAge(
      dob,
      valuationDate,
      w.erp.ageCalculation.basisForProduct(baseProductId ?? undefined),
      w.erp.ageCalculation.snapshot().halfYearRule,
    )
    : null;

  const needsAnswersList = Array.isArray(needsAns['answers'])
    ? (needsAns['answers'] as Array<{ questionId: string; value: unknown }>)
    : [];
  const findNeed = (qid: string) => needsAnswersList.find((a) => a.questionId === qid)?.value;

  const age = ageCalculation?.effectiveAge
    ?? (typeof coverageAns['age'] === 'number' ? coverageAns['age'] : undefined)
    ?? (typeof findNeed('age') === 'number' ? (findNeed('age') as number) : undefined)
    ?? priorApp?.profile.age
    ?? null;
  if (age !== null) {
    sources['age'] = ageCalculation
      ? `Auto-calculated (${ageCalculation.basisCode}) from DOB ${dob}`
      : priorApp
        ? `Underwriting file ${priorApp.id}`
        : 'Prior questionnaire answer';
  }

  const sex = (coverageAns['sex'] as 'male' | 'female' | undefined)
    ?? party?.sex
    ?? priorApp?.profile.sex
    ?? null;
  if (sex) sources['sex'] = party?.sex ? `Golden record ${party.id}` : priorApp ? `Underwriting file ${priorApp.id}` : 'Journey coverage';

  const needSmoker = findNeed('smoker');
  const smoker = typeof coverageAns['smoker'] === 'boolean'
    ? coverageAns['smoker']
    : typeof needSmoker === 'boolean'
      ? needSmoker
      : party?.smoker ?? priorApp?.profile.smoker ?? null;
  if (smoker !== null) {
    sources['smoker'] = typeof needSmoker === 'boolean'
      ? `Journey Needs Analysis`
      : party?.smoker !== undefined
        ? `Golden record ${party.id}`
        : priorApp
          ? `Underwriting file ${priorApp.id}`
          : 'Profile';
  }

  const heightCm = (typeof coverageAns['heightCm'] === 'number' ? coverageAns['heightCm'] : undefined)
    ?? party?.heightCm
    ?? priorApp?.profile.heightCm
    ?? null;
  if (heightCm !== null) {
    sources['heightCm'] = party?.heightCm !== undefined
      ? `Golden record ${party.id}`
      : priorApp
        ? `Underwriting file ${priorApp.id}`
        : 'Journey coverage';
  }

  const weightKg = (typeof coverageAns['weightKg'] === 'number' ? coverageAns['weightKg'] : undefined)
    ?? party?.weightKg
    ?? priorApp?.profile.weightKg
    ?? null;
  if (weightKg !== null) {
    sources['weightKg'] = party?.weightKg !== undefined
      ? `Golden record ${party.id}`
      : priorApp
        ? `Underwriting file ${priorApp.id}`
        : 'Journey coverage';
  }

  const bmi = heightCm && weightKg && heightCm > 0
    ? Math.round((weightKg / ((heightCm / 100) ** 2)) * 10) / 10
    : null;
  if (bmi !== null) sources['bmi'] = `Auto-computed from ${heightCm} cm / ${weightKg} kg`;

  const needOcc = findNeed('occupation-class');
  const rawOcc = loadingsAns['occupationClass'] ?? needOcc ?? party?.occupationClass ?? priorApp?.profile.occupationClass;
  const occupationClass = rawOcc ? (Math.min(5, Math.max(1, Number(rawOcc))) as 1 | 2 | 3 | 4 | 5) : null;
  if (occupationClass) {
    sources['occupationClass'] = needOcc !== undefined
      ? 'Journey Needs Analysis'
      : party?.occupationClass
        ? `Golden record ${party.id}`
        : `Underwriting file ${priorApp?.id ?? 'default'}`;
  }

  const occupationTitle = String(loadingsAns['occupationTitle'] ?? '')
    || party?.occupationTitle
    || (occupationClass ? OCCUPATION_LABELS[occupationClass] ?? null : null);
  if (occupationTitle) sources['occupationTitle'] = party?.occupationTitle ? `Golden record ${party.id}` : 'Occupation class lookup';

  const needIncome = findNeed('annual-income');
  const annualIncome = coverageAns['annualIncome']
    ? String(coverageAns['annualIncome'])
    : needIncome !== undefined
      ? Number(needIncome).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
      : party?.annualIncome
        ?? (priorApp ? formatAmount(priorApp.profile.annualIncome).replace(/\s+[A-Z]{3}$/, '') : null);
  if (annualIncome) {
    sources['annualIncome'] = needIncome !== undefined
      ? 'Journey Needs Analysis'
      : party?.annualIncome
        ? `Golden record ${party.id}`
        : `Underwriting file ${priorApp?.id ?? ''}`;
  }

  const phone = String(identityAns['phone'] ?? '') || party?.phones[0] || null;
  if (phone) sources['phone'] = identityAns['phone'] ? 'Journey Identity' : `Golden record ${party!.id}`;

  const email = String(identityAns['email'] ?? '') || party?.emails[0] || null;
  if (email) sources['email'] = identityAns['email'] ? 'Journey Identity' : `Golden record ${party!.id}`;

  const addressLine = String(identityAns['addressLine'] ?? '') || party?.addresses[0]?.line || null;
  const city = String(identityAns['city'] ?? '') || party?.addresses[0]?.city || null;
  const country = String(identityAns['country'] ?? '') || party?.addresses[0]?.country || null;

  const beneficiaryName = priorProposal?.beneficiary.name ?? party?.beneficiaryName ?? null;
  const beneficiaryRelationship = priorProposal?.beneficiary.relationship ?? party?.beneficiaryRelationship ?? null;
  if (beneficiaryName) sources['beneficiaryName'] = priorProposal ? `Prior proposal ${priorProposal.applicationId}` : `Golden record ${party?.id ?? ''}`;

  const chosenMaster = baseProductId ? w.erp.listProductMasters().find((m) => m.productId === baseProductId) : undefined;
  const dep = w.erp.dependentProducts.resolveForProduct(
    baseProductId ?? 'PROD-LIFE-TERM',
    chosenMaster?.category,
    chosenMaster?.category === 'takaful',
  );
  const existingRiders = Array.isArray(ridersAns['riders']) ? (ridersAns['riders'] as string[]) : [];
  const partyDeps = (party?.dependentProducts ?? []).filter((code) => RIDER_CATALOGUE.some((r) => r.code === code));
  const autoPickedRiders = existingRiders.length > 0
    ? existingRiders
    : [...new Set([...dep.autoPicked.filter((d) => d.kind === 'rider').map((d) => d.code), ...partyDeps])];
  sources['dependentProducts'] = existingRiders.length > 0
    ? `Journey Riders Stage`
    : `Master dependent-product rule (${dep.rule.baseProductId})`;

  const targetFunds = chosenMaster?.defaultFunds ? [...chosenMaster.defaultFunds] : ['FGLOBAL'];

  return {
    partyId: party?.id ?? resolvedPartyId,
    customerName,
    nameAr,
    dob,
    ageCalculation,
    age,
    sex,
    smoker,
    heightCm,
    weightKg,
    bmi,
    occupationClass,
    occupationTitle,
    annualIncome,
    phone,
    email,
    addressLine,
    city,
    country,
    beneficiaryName,
    beneficiaryRelationship,
    baseProductId,
    autoPickedRiders,
    dependentProducts: dep.autoPicked,
    optionalDependentProducts: dep.optional,
    targetFunds,
    sources,
  };
}
