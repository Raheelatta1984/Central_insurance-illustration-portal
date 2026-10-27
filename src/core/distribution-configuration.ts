/**
 * Distribution configuration — the commercial shelf filed at one of three scopes.
 *
 * Master settings still owns the underlying channel, partner, sub-channel and tariff masters. This
 * registry is the configuration layer the distribution office asked for: a product type (line), a
 * product (master id), its sub-products (varieties), a commission schedule, a premium uplift,
 * commission-disbursement terms and a clawback rule, filed against:
 *
 *   omni-channel → partner → sub-channel partner
 *
 * Percentages are entered by people and stored as integer basis points. Money never passes through
 * this module: the existing `applyBps` arithmetic in `channels.ts` applies the filed schedule to a
 * decimal `Money`. Every row is auditable, and the most specific enabled row wins at read time.
 */
import type { ClawbackBasis, ClawbackTrigger } from './channels.js';
import { DISTRIBUTION_CONFIG_TAB_IDS, type DistributionScopeKind } from './tour.js';

export type { DistributionScopeKind } from './tour.js';
export type { DistributionConfigTabId } from './tour.js';

export class DistributionConfigurationError extends Error {}

export const DISTRIBUTION_SCOPE_KINDS = Object.keys(DISTRIBUTION_CONFIG_TAB_IDS) as readonly DistributionScopeKind[];

export const DISBURSEMENT_FREQUENCIES = [
  'on-premium-receipt', 'policy-issue', 'monthly', 'quarterly', 'annual',
] as const;
export type DisbursementFrequency = (typeof DISBURSEMENT_FREQUENCIES)[number];

export const DISBURSEMENT_PAYOUT_TRIGGERS = [
  'premium-received', 'policy-issued', 'free-look-expired', 'reconciliation-approved',
] as const;
export type DisbursementPayoutTrigger = (typeof DISBURSEMENT_PAYOUT_TRIGGERS)[number];

export const CLAWBACK_TRIGGERS = [
  'cancellation-or-lapse', 'cancellation', 'lapse', 'free-look',
] as const satisfies readonly ClawbackTrigger[];
export const CLAWBACK_BASES = ['policy-year', 'policy-month'] as const satisfies readonly ClawbackBasis[];

export interface CommissionDisbursementTerms {
  readonly frequency: DisbursementFrequency;
  readonly payoutTrigger: DisbursementPayoutTrigger;
  /** Days after the trigger before the commission statement is paid. */
  readonly settlementDays: number;
  /** Share of earned commission held back until the clawback window closes, in bps. */
  readonly holdbackBps: number;
  readonly note: string;
}

export interface DistributionClawbackRule {
  readonly trigger: ClawbackTrigger;
  readonly basis: ClawbackBasis;
  /** Share of commission recoverable in period 1, 2, …; the last figure repeats. */
  readonly recoveryBps: readonly number[];
  readonly note: string;
}

export interface DistributionConfiguration {
  readonly key: string;
  readonly scope: DistributionScopeKind;
  readonly tabId: string;
  readonly channelCode: string;
  readonly partnerId: string;
  readonly subChannelCode: string;
  /** The product line from the product factory, e.g. `life`, `motor` or `medical`. */
  readonly productType: string;
  readonly productId: string;
  /** Varieties inside the selected product type that this configuration makes sellable. */
  readonly subProducts: readonly string[];
  readonly enabled: boolean;
  /** Commission percentage schedule, as integer bps: 1500 = 15.00%. */
  readonly commissionBps: readonly number[];
  /** Premium uplift percentage, as integer bps: 250 = 2.50%. */
  readonly premiumUpliftBps: number;
  /** Unit-linked mortality-charge uplift; zero unless explicitly filed. */
  readonly mortalityUpliftBps: number;
  readonly disbursement: CommissionDisbursementTerms;
  readonly clawback: DistributionClawbackRule;
  readonly note: string;
  readonly updatedAt: string;
  readonly updatedBy: string;
}

export interface DistributionConfigurationInput {
  readonly scope: DistributionScopeKind;
  readonly channelCode: string;
  readonly partnerId?: string;
  readonly subChannelCode?: string;
  readonly productType: string;
  readonly productId: string;
  readonly subProducts: readonly string[];
  readonly enabled?: boolean;
  readonly commissionBps: readonly number[];
  readonly premiumUpliftBps: number;
  readonly mortalityUpliftBps?: number;
  readonly disbursement: CommissionDisbursementTerms;
  readonly clawback: DistributionClawbackRule;
  readonly note?: string;
  readonly at?: string;
  readonly by?: string;
}

export interface DistributionReferenceIndex {
  readonly channels: readonly { readonly code: string; readonly commissionCapBps: number }[];
  readonly partners: readonly { readonly partnerId: string; readonly channelCode: string }[];
  readonly subChannels: readonly {
    readonly code: string;
    readonly parentChannelCode: string;
    readonly partnerId?: string;
    readonly commissionOverrideBps?: number;
  }[];
  readonly products: readonly {
    readonly productId: string;
    readonly line: string;
    readonly variety: string;
  }[];
}

export interface DistributionResolutionScope {
  readonly channelCode: string;
  readonly partnerId?: string | null;
  readonly subChannelCode?: string | null;
  readonly productId: string;
  /** The product's variety, used to check the configured sub-product list. */
  readonly subProduct?: string | null;
}

const upper = (value: string): string => value.trim().toUpperCase();
const lower = (value: string): string => value.trim().toLowerCase();
const clean = (value: string): string => value.trim();

function pctMatch(value: string | number): RegExpMatchArray {
  const raw = String(value).trim().replace(/%$/, '').trim();
  const match = /^(-)?(\d+)(?:\.(\d{1,2}))?$/.exec(raw);
  if (!match) throw new DistributionConfigurationError(`"${String(value)}" is not a percentage with at most two decimals`);
  return match;
}

/** Convert a human percentage such as `12.34` or `-2.5` into exact integer basis points. */
export function pctToBps(value: string | number): number {
  const match = pctMatch(value);
  const sign = match[1] === '-' ? -1 : 1;
  const whole = Number(match[2]);
  const fraction = Number((match[3] ?? '').padEnd(2, '0'));
  if (!Number.isSafeInteger(whole)) throw new DistributionConfigurationError(`"${String(value)}" is not a percentage`);
  return sign * (whole * 100 + fraction);
}

/** Print integer basis points as a two-decimal percentage without a `%` suffix. */
export function bpsToPct(bps: number): string {
  if (!Number.isInteger(bps)) throw new DistributionConfigurationError('basis points must be a whole number');
  const sign = bps < 0 ? '-' : '';
  const abs = Math.abs(bps);
  return `${sign}${Math.trunc(abs / 100)}.${String(abs % 100).padStart(2, '0')}`;
}

export function pctScheduleToBps(value: string | readonly (string | number)[]): number[] {
  const parts = typeof value === 'string'
    ? value.split(/[,;\s]+/).filter((part) => part.length > 0)
    : [...value];
  return parts.map(pctToBps);
}

export function bpsScheduleToPct(values: readonly number[]): string {
  return values.map(bpsToPct).join(', ');
}

export function distributionConfigKey(input: {
  readonly scope: DistributionScopeKind;
  readonly channelCode: string;
  readonly partnerId?: string | null;
  readonly subChannelCode?: string | null;
  readonly productId: string;
}): string {
  return [
    input.scope,
    upper(input.channelCode),
    upper(input.partnerId ?? ''),
    upper(input.subChannelCode ?? ''),
    upper(input.productId),
  ].join('|');
}

export function distributionTabForScope(scope: DistributionScopeKind): string {
  return DISTRIBUTION_CONFIG_TAB_IDS[scope];
}

/** The ceiling that applies to a configuration: a sub-channel override if filed, else the channel cap. */
export function distributionCommissionCap(
  input: { readonly channelCode: string; readonly subChannelCode?: string | null },
  refs: DistributionReferenceIndex,
): number {
  const channel = refs.channels.find((c) => c.code === upper(input.channelCode));
  if (!channel) throw new DistributionConfigurationError(`channel ${upper(input.channelCode)} is not filed`);
  const subChannelCode = upper(input.subChannelCode ?? '');
  const subChannel = subChannelCode ? refs.subChannels.find((s) => s.code === subChannelCode) : undefined;
  if (subChannelCode && !subChannel) throw new DistributionConfigurationError(`sub-channel ${subChannelCode} is not filed`);
  if (subChannel && subChannel.parentChannelCode !== channel.code) {
    throw new DistributionConfigurationError(`${subChannel.code} is not a route inside ${channel.code}`);
  }
  return subChannel?.commissionOverrideBps ?? channel.commissionCapBps;
}

/** Validate a row against the real masters, so a configuration cannot name a shelf that does not exist. */
export function assertDistributionReferences(input: DistributionConfigurationInput, refs: DistributionReferenceIndex): void {
  const channelCode = upper(input.channelCode);
  const channel = refs.channels.find((c) => c.code === channelCode);
  if (!channel) throw new DistributionConfigurationError(`channel ${channelCode} is not filed`);

  const partnerId = upper(input.partnerId ?? '');
  if (input.scope !== 'omni-channel' && !partnerId) {
    throw new DistributionConfigurationError('a partner configuration needs a partner id');
  }
  if (partnerId) {
    const partner = refs.partners.find((p) => p.partnerId === partnerId);
    if (!partner) throw new DistributionConfigurationError(`partner ${partnerId} is not filed`);
    if (partner.channelCode !== channelCode) {
      throw new DistributionConfigurationError(`${partnerId} is filed on ${partner.channelCode}, not ${channelCode}`);
    }
  }

  const subChannelCode = upper(input.subChannelCode ?? '');
  if (input.scope === 'sub-channel-partner' && !subChannelCode) {
    throw new DistributionConfigurationError('a sub-channel partner configuration needs a sub-channel code');
  }
  if (subChannelCode) {
    const subChannel = refs.subChannels.find((s) => s.code === subChannelCode);
    if (!subChannel) throw new DistributionConfigurationError(`sub-channel ${subChannelCode} is not filed`);
    if (subChannel.parentChannelCode !== channelCode) {
      throw new DistributionConfigurationError(`${subChannel.code} is not a route inside ${channelCode}`);
    }
    if (subChannel.partnerId && partnerId && subChannel.partnerId !== partnerId) {
      throw new DistributionConfigurationError(`${subChannel.code} is assigned to ${subChannel.partnerId}, not ${partnerId}`);
    }
  }

  const productId = upper(input.productId);
  const product = refs.products.find((p) => p.productId === productId);
  if (!product) throw new DistributionConfigurationError(`product ${productId} is not filed in the product factory`);
  const productType = lower(input.productType);
  if (productType !== lower(product.line)) {
    throw new DistributionConfigurationError(`${productId} belongs to product type ${product.line}, not ${input.productType}`);
  }
  const allowedSubProducts = new Set(refs.products.filter((p) => lower(p.line) === productType).map((p) => p.variety));
  for (const subProduct of input.subProducts) {
    if (!allowedSubProducts.has(subProduct)) {
      throw new DistributionConfigurationError(`"${subProduct}" is not a sub-product of ${productType}`);
    }
  }

  const cap = distributionCommissionCap({ channelCode, ...(subChannelCode ? { subChannelCode } : {}) }, refs);
  const highestCommission = Math.max(0, ...input.commissionBps);
  if (highestCommission > cap) {
    throw new DistributionConfigurationError(`${highestCommission} bps commission exceeds the ${cap} bps ceiling on ${subChannelCode || channelCode}`);
  }
}

function bpsList(values: readonly number[], label: string): number[] {
  const out = values.map(Number);
  if (out.length === 0) throw new DistributionConfigurationError(`${label} needs at least one percentage`);
  for (const value of out) {
    if (!Number.isInteger(value) || value < 0 || value > 10_000) {
      throw new DistributionConfigurationError(`${label} must be whole basis points between 0 and 10000`);
    }
  }
  return out;
}

function signedBps(value: number, label: string): number {
  const bps = Number(value);
  if (!Number.isInteger(bps) || bps < -10_000 || bps > 10_000) {
    throw new DistributionConfigurationError(`${label} must be whole basis points between -10000 and 10000`);
  }
  return bps;
}

interface AuditEntry {
  readonly at: string;
  readonly by: string;
  readonly action: 'created' | 'updated' | 'removed';
  readonly detail: string;
}

export class DistributionConfigurationRegistry {
  private readonly rows = new Map<string, DistributionConfiguration>();
  private readonly trail: AuditEntry[] = [];

  /** File or replace one scope × product row. Re-filing the same key is an update, never a duplicate. */
  upsert(input: DistributionConfigurationInput, refs?: DistributionReferenceIndex): DistributionConfiguration {
    if (!DISTRIBUTION_SCOPE_KINDS.includes(input.scope)) {
      throw new DistributionConfigurationError(`unknown distribution scope "${input.scope}"`);
    }
    const scope = input.scope;
    const channelCode = upper(input.channelCode);
    if (!channelCode) throw new DistributionConfigurationError('a channel code is required');
    const partnerId = scope === 'omni-channel' ? '' : upper(input.partnerId ?? '');
    const subChannelCode = scope === 'sub-channel-partner' ? upper(input.subChannelCode ?? '') : '';
    const productId = upper(input.productId);
    const productType = lower(input.productType);
    if (!productId || !productType) throw new DistributionConfigurationError('a product type and product id are required');
    const subProducts = [...new Set(input.subProducts.map(clean).filter(Boolean))];
    if (subProducts.length === 0) throw new DistributionConfigurationError('select at least one sub-product');

    if (!DISBURSEMENT_FREQUENCIES.includes(input.disbursement.frequency)) {
      throw new DistributionConfigurationError(`unknown commission disbursement frequency "${input.disbursement.frequency}"`);
    }
    if (!DISBURSEMENT_PAYOUT_TRIGGERS.includes(input.disbursement.payoutTrigger)) {
      throw new DistributionConfigurationError(`unknown commission disbursement trigger "${input.disbursement.payoutTrigger}"`);
    }
    const settlementDays = Number(input.disbursement.settlementDays);
    if (!Number.isInteger(settlementDays) || settlementDays < 0 || settlementDays > 365) {
      throw new DistributionConfigurationError('commission disbursement settlement days must be a whole number from 0 to 365');
    }
    if (!CLAWBACK_TRIGGERS.includes(input.clawback.trigger as (typeof CLAWBACK_TRIGGERS)[number])) {
      throw new DistributionConfigurationError(`unknown clawback trigger "${input.clawback.trigger}"`);
    }
    if (!CLAWBACK_BASES.includes(input.clawback.basis as (typeof CLAWBACK_BASES)[number])) {
      throw new DistributionConfigurationError(`unknown clawback basis "${input.clawback.basis}"`);
    }

    const normalised: DistributionConfigurationInput = {
      ...input,
      scope, channelCode, partnerId, subChannelCode, productType, productId, subProducts,
      commissionBps: bpsList(input.commissionBps, 'commission schedule'),
      premiumUpliftBps: signedBps(input.premiumUpliftBps, 'premium uplift'),
      mortalityUpliftBps: signedBps(input.mortalityUpliftBps ?? 0, 'mortality uplift'),
      disbursement: {
        ...input.disbursement,
        settlementDays,
        holdbackBps: (() => {
          const holdback = Number(input.disbursement.holdbackBps);
          if (!Number.isInteger(holdback) || holdback < 0 || holdback > 10_000) {
            throw new DistributionConfigurationError('commission holdback must be whole basis points between 0 and 10000');
          }
          return holdback;
        })(),
        note: clean(input.disbursement.note),
      },
      clawback: {
        ...input.clawback,
        recoveryBps: bpsList(input.clawback.recoveryBps, 'clawback schedule'),
        note: clean(input.clawback.note),
      },
    };
    if (refs) assertDistributionReferences(normalised, refs);

    const key = distributionConfigKey({ scope, channelCode, partnerId, subChannelCode, productId });
    const existing = this.rows.get(key);
    const row: DistributionConfiguration = {
      key,
      scope,
      tabId: distributionTabForScope(scope),
      channelCode,
      partnerId,
      subChannelCode,
      productType,
      productId,
      subProducts,
      enabled: input.enabled ?? true,
      commissionBps: normalised.commissionBps,
      premiumUpliftBps: normalised.premiumUpliftBps,
      mortalityUpliftBps: normalised.mortalityUpliftBps ?? 0,
      disbursement: normalised.disbursement,
      clawback: normalised.clawback,
      note: clean(input.note ?? ''),
      updatedAt: input.at ?? '',
      updatedBy: input.by ?? 'distribution-configuration',
    };
    this.rows.set(key, row);
    this.record(existing ? 'updated' : 'created', `${key}: ${row.commissionBps.join('/')} bps commission, ${row.premiumUpliftBps} bps uplift`, row.updatedAt, row.updatedBy);
    return row;
  }

  remove(input: {
    readonly scope: DistributionScopeKind;
    readonly channelCode: string;
    readonly partnerId?: string | null;
    readonly subChannelCode?: string | null;
    readonly productId: string;
    readonly at?: string;
    readonly by?: string;
  }): void {
    const key = distributionConfigKey({
      ...input,
      partnerId: input.scope === 'omni-channel' ? '' : (input.partnerId ?? ''),
      subChannelCode: input.scope === 'sub-channel-partner' ? (input.subChannelCode ?? '') : '',
    });
    if (!this.rows.has(key)) throw new DistributionConfigurationError(`no distribution configuration for ${key}`);
    this.rows.delete(key);
    this.record('removed', key, input.at ?? '', input.by ?? 'distribution-configuration');
  }

  get(key: string): DistributionConfiguration | undefined { return this.rows.get(key); }

  /** Most specific enabled row wins: sub-channel partner, then partner, then whole channel. */
  resolveFor(scope: DistributionResolutionScope): DistributionConfiguration | undefined {
    const channelCode = upper(scope.channelCode);
    const partnerId = upper(scope.partnerId ?? '');
    const subChannelCode = upper(scope.subChannelCode ?? '');
    const productId = upper(scope.productId);
    const subProduct = clean(scope.subProduct ?? '');
    const candidates = [...this.rows.values()].filter((row) =>
      row.enabled
      && row.channelCode === channelCode
      && row.productId === productId
      && (!subProduct || row.subProducts.includes(subProduct)));
    const priorities: readonly DistributionScopeKind[] = ['sub-channel-partner', 'partner', 'omni-channel'];
    for (const level of priorities) {
      const match = candidates.find((row) => {
        if (row.scope !== level) return false;
        if (level === 'sub-channel-partner') return Boolean(subChannelCode) && row.partnerId === partnerId && row.subChannelCode === subChannelCode;
        if (level === 'partner') return Boolean(partnerId) && row.partnerId === partnerId;
        return true;
      });
      if (match) return match;
    }
    return undefined;
  }

  stats() {
    const rows = [...this.rows.values()];
    const byScope = Object.fromEntries(DISTRIBUTION_SCOPE_KINDS.map((scope) => [scope, rows.filter((r) => r.scope === scope).length])) as Record<DistributionScopeKind, number>;
    const filedAt = rows.map((r) => r.updatedAt).filter(Boolean).sort();
    return {
      total: rows.length,
      enabled: rows.filter((r) => r.enabled).length,
      byScope,
      products: new Set(rows.map((r) => r.productId)).size,
      lastFiledAt: filedAt.at(-1) ?? null,
    };
  }

  audit(limit = 8): readonly AuditEntry[] { return this.trail.slice(-limit).reverse(); }

  snapshot() {
    const configurations = [...this.rows.values()].sort((a, b) =>
      a.channelCode.localeCompare(b.channelCode)
      || a.partnerId.localeCompare(b.partnerId)
      || a.subChannelCode.localeCompare(b.subChannelCode)
      || a.productId.localeCompare(b.productId));
    return {
      configurations,
      stats: this.stats(),
      catalogue: {
        scopes: DISTRIBUTION_SCOPE_KINDS,
        tabIds: DISTRIBUTION_CONFIG_TAB_IDS,
        disbursementFrequencies: DISBURSEMENT_FREQUENCIES,
        disbursementPayoutTriggers: DISBURSEMENT_PAYOUT_TRIGGERS,
        clawbackTriggers: CLAWBACK_TRIGGERS,
        clawbackBases: CLAWBACK_BASES,
      },
      trail: this.audit(8),
    };
  }

  private record(action: AuditEntry['action'], detail: string, at: string, by: string): void {
    this.trail.push({ at, by, action, detail });
    if (this.trail.length > 200) this.trail.splice(0, this.trail.length - 200);
  }
}

/** A starting row for the UI; nothing is active until an operator files it. */
export const DEFAULT_DISTRIBUTION_TERMS = Object.freeze({
  commissionPct: '15.00, 5.00, 2.50',
  premiumUpliftPct: '2.50',
  clawbackPct: '100.00, 50.00, 25.00',
  holdbackPct: '0.00',
  settlementDays: 30,
  frequency: 'monthly' as DisbursementFrequency,
  payoutTrigger: 'free-look-expired' as DisbursementPayoutTrigger,
  clawbackTrigger: 'cancellation-or-lapse' as ClawbackTrigger,
  clawbackBasis: 'policy-year' as ClawbackBasis,
});
