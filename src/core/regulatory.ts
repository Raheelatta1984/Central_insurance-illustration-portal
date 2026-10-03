/**
 * Regulatory packs.
 *
 * A pack is data: what must happen before a product may be sold, what an illustration must say,
 * what a takaful model may do, where data may live. Packs are versioned and effective-dated, and
 * a policy is always evaluated against the pack version in force at the relevant moment.
 */
export interface PreSaleContext {
  readonly productLine: 'life' | 'medical' | 'motor' | 'travel' | 'group' | 'unit-linked' | 'takaful';
  readonly hasNeedAnalysis: boolean;
  readonly hasNeedId: boolean;
  readonly surveyCompleted: boolean;
  readonly comparisonPresented: boolean;
  readonly customerIsResident: boolean;
  readonly consentCaptured: boolean;
}

export interface RegulatoryPack {
  readonly country: string;
  readonly name: string;
  readonly version: string;
  readonly effectiveFrom: string;
  readonly needAnalysisRequiredFor: ReadonlyArray<PreSaleContext['productLine']>;
  readonly illustration: { readonly mustShowScenarios: number; readonly wording: string; readonly coolingOffDays: number };
  readonly takaful: { readonly modelsAllowed: readonly string[]; readonly surplusToSaversAllowed: boolean; readonly fullValuationBeforeSurplus: boolean; readonly requiresShariahApproval: boolean };
  readonly dataResidency: { readonly country: string; readonly notes: string };
  readonly reporting: ReadonlyArray<{ code: string; name: string; frequency: string }>;
}

export const AE_PACK: RegulatoryPack = {
  country: 'AE',
  name: 'United Arab Emirates — CBUAE-flavoured pack',
  version: '2026.1',
  effectiveFrom: '2026-01-01',
  needAnalysisRequiredFor: ['life', 'medical', 'unit-linked', 'travel'],
  illustration: {
    mustShowScenarios: 3,
    wording: 'This illustration is not a forecast and does not constitute financial advice. Values may fall as well as rise.',
    coolingOffDays: 30,
  },
  takaful: { modelsAllowed: ['wakalah', 'mudarabah', 'waqf', 'hybrid'], surplusToSaversAllowed: false, fullValuationBeforeSurplus: true, requiresShariahApproval: true },
  dataResidency: { country: 'AE', notes: 'Customer data processed in-country unless an approved transfer framework applies.' },
  reporting: [
    { code: 'CBUAE-MONTHLY', name: 'Monthly regulatory return', frequency: 'monthly' },
    { code: 'CBUAE-ANNUAL', name: 'Annual financial return', frequency: 'annual' },
  ],
};

export const MY_PACK: RegulatoryPack = {
  country: 'MY',
  name: 'Malaysia — BNM-flavoured pack',
  version: '2026.1',
  effectiveFrom: '2026-01-01',
  needAnalysisRequiredFor: ['life', 'medical', 'unit-linked', 'takaful'],
  illustration: {
    mustShowScenarios: 3,
    wording: 'This illustration is for information only. Actual returns depend on future investment performance and are not guaranteed.',
    coolingOffDays: 15,
  },
  takaful: { modelsAllowed: ['wakalah', 'mudarabah', 'hybrid'], surplusToSaversAllowed: true, fullValuationBeforeSurplus: true, requiresShariahApproval: true },
  dataResidency: { country: 'MY', notes: 'Data stored in Malaysia for locally-licensed operators.' },
  reporting: [{ code: 'BNM-TAKAFUL', name: 'Takaful operational return', frequency: 'annual' }],
};

export const PACKS: Record<string, RegulatoryPack> = { AE: AE_PACK, MY: MY_PACK };

export interface PreSaleResult {
  readonly allowed: boolean;
  readonly blockers: string[];
  readonly requiredSteps: string[];
  readonly pack: string;
}

/** The gate in front of every sale — the UAE example: no health cover without a documented need. */
export function preSaleCheck(pack: RegulatoryPack, ctx: PreSaleContext): PreSaleResult {
  const blockers: string[] = [];
  const requiredSteps: string[] = [];
  if (pack.needAnalysisRequiredFor.includes(ctx.productLine)) {
    requiredSteps.push('Complete and store the need analysis');
    if (!ctx.hasNeedAnalysis) blockers.push(`A need analysis is mandatory before selling ${ctx.productLine} in ${pack.country}`);
    if (!ctx.hasNeedId) blockers.push(`No need-analysis identifier issued for this ${ctx.productLine} case`);
  }
  if (ctx.productLine === 'motor') {
    requiredSteps.push('Complete the pre-quote vehicle survey');
    requiredSteps.push('Present the insurer comparison matrix');
    if (!ctx.surveyCompleted) blockers.push('Motor cover cannot be quoted before the survey is completed');
    if (!ctx.comparisonPresented) blockers.push('Motor quotations must be presented in the comparison matrix format');
  }
  if (!ctx.consentCaptured) blockers.push('Customer consent for data processing has not been captured');
  if (!ctx.customerIsResident && ['medical', 'motor'].includes(ctx.productLine)) {
    blockers.push(`${ctx.productLine} cover for non-residents requires an exception approval in ${pack.country}`);
  }
  return { allowed: blockers.length === 0, blockers, requiredSteps, pack: `${pack.country} ${pack.version}` };
}

export interface QuoteOffer {
  readonly insurer: string;
  readonly product: string;
  readonly premium: number;
  readonly excess: number;
  readonly benefits: string[];
  readonly serviceRating: number;   // 1..5
  readonly complaintsPer10k: number;
}

export interface ComparisonRow extends QuoteOffer { readonly score: number; readonly rationale: string }

/**
 * The comparison matrix: every insurer on the same axes, the recommendation explained.
 * Ranking is deterministic and auditable — premium weight falls as the excess rises, and
 * service quality is never hidden behind a single "best" number.
 */
export function comparisonMatrix(offers: QuoteOffer[], weights = { premium: 0.5, service: 0.35, excess: 0.15 }): ComparisonRow[] {
  if (offers.length === 0) return [];
  const maxPremium = Math.max(...offers.map((o) => o.premium));
  const maxExcess = Math.max(...offers.map((o) => o.excess));
  const maxComplaints = Math.max(...offers.map((o) => o.complaintsPer10k), 1);
  return offers
    .map((o) => {
      const premiumScore = 1 - o.premium / maxPremium;
      const excessScore = maxExcess === 0 ? 1 : 1 - o.excess / maxExcess;
      const serviceScore = (o.serviceRating / 5) * (1 - o.complaintsPer10k / (maxComplaints * 2));
      const score = weights.premium * premiumScore + weights.excess * excessScore + weights.service * serviceScore;
      const rationale = [
        `premium ${o.premium.toLocaleString()} (${Math.round(premiumScore * 100)}% of best)`,
        `service rating ${o.serviceRating}/5 with ${o.complaintsPer10k} complaints per 10,000`,
        `excess ${o.excess.toLocaleString()}`,
      ].join('; ');
      return { ...o, score: Math.round(score * 10000) / 10000, rationale: `Ranked on ${rationale}.` };
    })
    .sort((a, b) => b.score - a.score);
}

export type { PreSaleContext as RegulatoryContext };
