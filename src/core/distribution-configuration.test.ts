/**
 * Distribution configuration is a contract, not a form: exact percentages, auditable rows, scoped
 * precedence and the same terms the pricing and commission engines resolve.
 */
import { describe, expect, it } from 'vitest';
import { buildWorld, worldSnapshot, type World } from './demo.js';
import { formatAmount, money } from './money.js';
import {
  DEFAULT_DISTRIBUTION_TERMS, DistributionConfigurationError, DistributionConfigurationRegistry,
  bpsScheduleToPct, bpsToPct, pctScheduleToBps, pctToBps, type DistributionConfigurationInput,
  type DistributionReferenceIndex, type DistributionScopeKind,
} from './distribution-configuration.js';
import { DEFAULT_CLAWBACK } from './channels.js';

function preparedWorld() {
  const w = buildWorld();
  w.erp.channels.bootstrap('2026-10-27T10:00:00Z', 'distribution-test');
  const product = w.erp.listProductMasters().find((p) => p.productId === 'PROD-UL-GLOBAL')!;
  w.erp.channels.upsertPartner({
    partnerId: 'GULF-BROKERS', name: 'Gulf Brokers', channelCode: 'BROKER',
    productIds: [product.productId], commissionBps: [1000], settlementDays: 30,
    clawback: DEFAULT_CLAWBACK, by: 'distribution-test',
  });
  w.erp.channels.upsertSubChannel({
    code: 'BROKER-DIFC', name: 'DIFC desk', parentChannelCode: 'BROKER',
    partnerId: 'GULF-BROKERS', channelType: 'branch', commissionOverrideBps: 1000,
    by: 'distribution-test',
  });
  return { w, product };
}

function refsFor(w: World): DistributionReferenceIndex {
  return {
    channels: w.erp.channels.listChannels().map((c) => ({ code: c.code, commissionCapBps: c.commissionCapBps })),
    partners: w.erp.channels.listPartners().map((p) => ({ partnerId: p.partnerId, channelCode: p.channelCode })),
    subChannels: w.erp.channels.listSubChannels().map((s) => ({
      code: s.code,
      parentChannelCode: s.parentChannelCode,
      ...(s.partnerId ? { partnerId: s.partnerId } : {}),
      ...(s.commissionOverrideBps !== undefined ? { commissionOverrideBps: s.commissionOverrideBps } : {}),
    })),
    products: w.erp.listProductMasters().map((p) => ({ productId: p.productId, line: String(p.line), variety: p.variety })),
  };
}

function inputFor(
  product: { productId: string; line: string; variety: string },
  scope: DistributionScopeKind = 'omni-channel',
  commissionBps: readonly number[] = [1500, 500, 250],
): DistributionConfigurationInput {
  return {
    scope,
    channelCode: 'BROKER',
    ...(scope !== 'omni-channel' ? { partnerId: 'GULF-BROKERS' } : {}),
    ...(scope === 'sub-channel-partner' ? { subChannelCode: 'BROKER-DIFC' } : {}),
    productType: String(product.line),
    productId: product.productId,
    subProducts: [product.variety],
    commissionBps,
    premiumUpliftBps: 250,
    mortalityUpliftBps: 0,
    disbursement: {
      frequency: DEFAULT_DISTRIBUTION_TERMS.frequency,
      payoutTrigger: DEFAULT_DISTRIBUTION_TERMS.payoutTrigger,
      settlementDays: 30,
      holdbackBps: 0,
      note: 'Pay after the free-look window.',
    },
    clawback: {
      trigger: DEFAULT_DISTRIBUTION_TERMS.clawbackTrigger,
      basis: DEFAULT_DISTRIBUTION_TERMS.clawbackBasis,
      recoveryBps: [10000, 5000, 2500],
      note: 'Three-year declining recovery.',
    },
    note: 'Filed by the distribution office.',
    by: 'distribution-test',
    at: '2026-10-27T10:05:00Z',
  };
}

describe('percentage configuration stays exact', () => {
  it('converts percentages to integer basis points and back without floats', () => {
    expect(pctToBps('15.00')).toBe(1500);
    expect(pctToBps('0.25')).toBe(25);
    expect(pctToBps('-2.5')).toBe(-250);
    expect(bpsToPct(1500)).toBe('15.00');
    expect(bpsToPct(-250)).toBe('-2.50');
    expect(pctScheduleToBps('15, 5, 2.5')).toEqual([1500, 500, 250]);
    expect(bpsScheduleToPct([1500, 500, 250])).toBe('15.00, 5.00, 2.50');
    expect(() => pctToBps('1.234')).toThrow(DistributionConfigurationError);
    expect(() => pctToBps('twelve')).toThrow(DistributionConfigurationError);
  });
});

describe('the scoped configuration registry', () => {
  it('files, updates and removes one row per scope × product, with an audit trail', () => {
    const { w, product } = preparedWorld();
    const input = inputFor(product);
    const row = w.distributionConfig.upsert(input, refsFor(w));
    expect(row.key).toBe('omni-channel|BROKER|||PROD-UL-GLOBAL');
    expect(row.commissionBps).toEqual([1500, 500, 250]);
    expect(w.distributionConfig.stats().byScope['omni-channel']).toBe(1);
    expect(worldSnapshot(w).distributionConfig.configurations).toHaveLength(1);

    const updated = w.distributionConfig.upsert({ ...input, premiumUpliftBps: 300, by: 'analyst-2' }, refsFor(w));
    expect(updated.premiumUpliftBps).toBe(300);
    expect(w.distributionConfig.stats().total).toBe(1);
    expect(w.distributionConfig.audit()[0]).toMatchObject({ action: 'updated', by: 'analyst-2' });

    w.distributionConfig.remove({
      scope: input.scope,
      channelCode: input.channelCode,
      productId: input.productId,
      by: 'analyst-2',
    });
    expect(w.distributionConfig.stats().total).toBe(0);
    expect(w.distributionConfig.audit()[0]).toMatchObject({ action: 'removed' });
  });

  it('resolves the most specific enabled row and refuses a commission above the filed ceiling', () => {
    const { w, product } = preparedWorld();
    const refs = refsFor(w);
    w.distributionConfig.upsert(inputFor(product, 'omni-channel', [1500]), refs);
    w.distributionConfig.upsert(inputFor(product, 'partner', [1200]), refs);
    w.distributionConfig.upsert(inputFor(product, 'sub-channel-partner', [900]), refs);
    const resolution = w.distributionConfig.resolveFor({
      channelCode: 'BROKER', partnerId: 'GULF-BROKERS', subChannelCode: 'BROKER-DIFC',
      productId: product.productId, subProduct: product.variety,
    });
    expect(resolution?.scope).toBe('sub-channel-partner');
    expect(resolution?.commissionBps).toEqual([900]);
    // The DIFC sub-channel overrides the BROKER cap at 1000 bps, so 1100 bps is refused.
    expect(() => w.distributionConfig.upsert(inputFor(product, 'sub-channel-partner', [1100]), refs)).toThrow(/ceiling/);
  });

  it('checks the real masters: scope hierarchy, product line and sub-products', () => {
    const { w, product } = preparedWorld();
    const refs = refsFor(w);
    expect(() => w.distributionConfig.upsert({
      ...inputFor(product, 'partner'),
      channelCode: 'AGENCY',
    }, refs)).toThrow(/filed on BROKER, not AGENCY/);
    expect(() => w.distributionConfig.upsert({
      ...inputFor(product), productType: 'motor',
    }, refs)).toThrow(/belongs to product type/);
    expect(() => w.distributionConfig.upsert({
      ...inputFor(product), subProducts: ['not-a-variety'],
    }, refs)).toThrow(/not a sub-product/);
    expect(() => w.distributionConfig.upsert({
      ...inputFor(product, 'sub-channel-partner'), subChannelCode: 'NO-SUCH-DESK',
    }, refs)).toThrow(/not filed/);
  });

  it('refuses impossible disbursement and clawback terms', () => {
    const { w, product } = preparedWorld();
    const input = inputFor(product);
    expect(() => w.distributionConfig.upsert({
      ...input,
      disbursement: { ...input.disbursement, settlementDays: 400 },
    }, refsFor(w))).toThrow(/settlement days/);
    expect(() => w.distributionConfig.upsert({
      ...input,
      clawback: { ...input.clawback, recoveryBps: [-1] },
    }, refsFor(w))).toThrow(/clawback schedule/);
  });

  it('feeds the same filed row into pricing, commission and clawback probes', () => {
    const { w, product } = preparedWorld();
    w.distributionConfig.upsert(inputFor(product, 'partner', [1500, 500, 250]), refsFor(w));
    const premium = money(100_000n, 'AED'); // 1,000.00
    const earned = w.erp.channels.commissionFor({
      partnerId: 'GULF-BROKERS', productId: product.productId, premium, policyYear: 1,
    });
    expect(earned.bps).toBe(1500);
    expect(formatAmount(earned.commission)).toBe('150.00 AED');
    expect(earned.basis).toContain('distribution configuration');
    const clawback = w.erp.channels.clawbackFor({
      partnerId: 'GULF-BROKERS', productId: product.productId, commission: earned.commission,
      periodsSinceInception: 1,
    });
    expect(clawback.recoveryBps).toBe(10000);
    const priced = w.erp.priceRisk(w, {
      productId: product.productId, age: 40, gender: 'unisex', occupationClass: 0,
      sumAssured: '100,000', channelCode: 'BROKER', partnerId: 'GULF-BROKERS',
    });
    expect(priced.basis).toContain('distribution configuration');
    expect(priced.basis).toContain('250 bps');
  });

  it('is deterministic when built fresh', () => {
    const registry = new DistributionConfigurationRegistry();
    expect(registry.snapshot()).toMatchObject({ configurations: [], stats: { total: 0, enabled: 0 } });
    expect(registry.snapshot().catalogue.scopes).toEqual(['omni-channel', 'partner', 'sub-channel-partner']);
  });
});
