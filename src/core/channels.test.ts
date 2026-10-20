/**
 * The omni-channel: who may sell what, under what name, for what commission — and what comes back.
 *
 * These tests are the argument for the module. A tenant with no channel filed is told so rather than
 * being handed an empty dropdown; a partner cannot be enabled on a channel somebody switched off; a
 * commission cannot be filed above the ceiling the channel's contracts run inside; a clawback is money
 * returning, so it is computed on the commission that was actually paid, in exact decimal; and a
 * product's name on a partner's shelf is a filed alias, not a string pasted into a screen.
 *
 * The maths is pinned with figures a finance team would check with a calculator: 1,500 bps of a
 * 24,000.00 premium is 3,600.00, and a year-one cancellation gives the whole of it back.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { buildWorld, World } from './demo.js';
import { ChannelError, STANDARD_OMNI_CHANNELS } from './channels.js';
import { formatAmount, money } from './money.js';

function fresh(): World {
  return buildWorld();
}

/** A tenant that has decided to sell through more than its own counter. */
function setUp(w: World): void {
  w.erp.channels.bootstrap('2026-10-05T09:00:00Z', 'distribution-lead');
  w.erp.channels.upsertPartner({
    partnerId: 'GULF-BROKERS', name: 'Gulf Insurance Brokers', channelCode: 'BROKER',
    country: 'AE', settlementDays: 30, productIds: ['PROD-UL-GLOBAL', 'PROD-LIFE-TERM', 'PROD-CI-COMPREHENSIVE'],
    commissionBps: [1500, 500, 250], note: 'The panel agreement signed in 2026.',
    at: '2026-10-05T09:05:00Z', by: 'distribution-lead',
  });
}

describe('a tenant that has not set the omni-channel up', () => {
  it('is told, in the words the gate shows, and one action files the standard pattern', () => {
    const w = fresh();
    const status = w.erp.channels.status();
    expect(status.configured).toBe(false);
    expect(status.channelCount).toBe(0);
    expect(status.blockers.join(' ')).toMatch(/No omni-channel is set up/);

    const result = w.erp.channels.bootstrap('2026-10-05T09:00:00Z', 'distribution-lead');
    expect(result.skipped).toBe(false);
    expect(result.created).toEqual(STANDARD_OMNI_CHANNELS.map((c) => c.code));
    const after = w.erp.channels.status();
    expect(after.configured).toBe(true);
    expect(after.channelCount).toBe(STANDARD_OMNI_CHANNELS.length);
    expect(after.blockers).toEqual([]);
  });

  it('does not invent a second set of channels when they already exist', () => {
    const w = fresh();
    w.erp.channels.bootstrap();
    const again = w.erp.channels.bootstrap();
    expect(again.skipped).toBe(true);
    expect(again.created).toEqual([]);
    expect(w.erp.channels.listChannels().length).toBe(STANDARD_OMNI_CHANNELS.length);
  });

  it('files the ceilings and permissions as they are contracted, including a direct channel that pays nothing', () => {
    const w = fresh();
    w.erp.channels.bootstrap();
    const direct = w.erp.channels.channel('DIRECT-PORTAL')!;
    expect(direct.commissionCapBps).toBe(0);
    expect(direct.supports.bind).toBe(true);
    const broker = w.erp.channels.channel('BROKER')!;
    expect(broker.supports.bind).toBe(false);
    expect(broker.commissionCapBps).toBeGreaterThan(0);
    // The channel's own secondary name is what a customer sees on the door.
    expect(broker.secondaryName).toBe('Broker Panel');
  });
});

describe('channels and partners', () => {
  let w: World;
  beforeEach(() => { w = fresh(); setUp(w); });

  it('will not file a partner on a channel that does not exist', () => {
    expect(() => w.erp.channels.upsertPartner({ partnerId: 'MY-BANK', name: 'My Bank', channelCode: 'BANKWALL' }))
      .toThrowError(/not a configured channel/);
  });

  it('will not enable a partner on a channel somebody switched off', () => {
    // The panel agreement goes first: a channel is only closable once nothing is trading on it.
    w.erp.channels.upsertPartner({ partnerId: 'GULF-BROKERS', name: 'Gulf Insurance Brokers', channelCode: 'BROKER', enabled: false, productIds: ['PROD-UL-GLOBAL', 'PROD-LIFE-TERM', 'PROD-CI-COMPREHENSIVE'], commissionBps: [1500, 500, 250] });
    w.erp.channels.upsertChannel({ code: 'BROKER', enabled: false });
    expect(() => w.erp.channels.upsertPartner({ partnerId: 'NEW-BROKER', name: 'New Broker', channelCode: 'BROKER' }))
      .toThrowError(/switched off/);
    // …but a suspended partner on a suspended channel is a legitimate filing.
    const partner = w.erp.channels.upsertPartner({ partnerId: 'NEW-BROKER', name: 'New Broker', channelCode: 'BROKER', enabled: false });
    expect(partner.enabled).toBe(false);
  });

  it('refuses to close a channel out from under its partners', () => {
    expect(() => w.erp.channels.upsertChannel({ code: 'BROKER', enabled: false })).toThrowError(/GULF-BROKERS/);
    expect(() => w.erp.channels.removeChannel('BROKER')).toThrowError(/remove them first/);
  });

  it('refuses a commission above the ceiling the channel is filed inside — and says which number moved', () => {
    const err = (() => {
      try {
        w.erp.channels.upsertPartner({ partnerId: 'GREEDY-BROKER', name: 'Greedy Broker', channelCode: 'BROKER', commissionBps: [4500] });
        return null;
      } catch (e) { return e; }
    })();
    expect(err).toBeInstanceOf(ChannelError);
    expect(String(err)).toContain('3000 bps');
    expect(String(err)).toContain('4500 bps');
  });

  it('refuses to pay a broker on the door that pays nobody', () => {
    expect(() => w.erp.channels.upsertPartner({ partnerId: 'WEB-DESK', name: 'Web desk', channelCode: 'DIRECT-PORTAL', commissionBps: [100] }))
      .toThrowError(/exceeds the 0 bps ceiling filed on DIRECT-PORTAL/);
  });

  it('only lets a partner sell products the factory holds', () => {
    expect(() => w.erp.channels.upsertPartner({ partnerId: 'X', name: 'X', channelCode: 'BROKER', productIds: ['PROD-LIFE-TERM', 'PROD-MY-FAVOURITE'] }))
      .toThrowError(/PROD-MY-FAVOURITE/);
  });

  it('takes a stale offer with it when a product comes off a partner’s shelf', () => {
    w.erp.channels.upsertOffer({ partnerId: 'GULF-BROKERS', productId: 'PROD-UL-GLOBAL', premiumUpliftBps: 300, secondaryName: 'Global Invest-Protect' });
    expect(w.erp.channels.offer('GULF-BROKERS', 'PROD-UL-GLOBAL')).toBeDefined();
    w.erp.channels.setPartnerProducts('GULF-BROKERS', ['PROD-LIFE-TERM']);
    expect(w.erp.channels.offer('GULF-BROKERS', 'PROD-UL-GLOBAL')).toBeUndefined();
    expect(w.erp.channels.partner('GULF-BROKERS')!.productIds).toEqual(['PROD-LIFE-TERM']);
  });

  it('records a trail of what was filed, by whom', () => {
    const trail = w.erp.channels.audit(5);
    expect(trail.some((t) => t.action === 'partner-created' && t.detail.includes('GULF-BROKERS'))).toBe(true);
    expect(trail.some((t) => t.action === 'channel-bootstrap')).toBe(true);
  });

  it('will not let a partner hop channels with its products still attached', () => {
    expect(() => w.erp.channels.upsertPartner({ partnerId: 'GULF-BROKERS', name: 'Gulf Insurance Brokers', channelCode: 'BANCASSURANCE' }))
      .toThrowError(/re-pointing the partner/);
  });
});

describe('the secondary name a product carries on each shelf', () => {
  let w: World;
  beforeEach(() => { w = fresh(); setUp(w); });

  it('prefers the partner’s own alias, then the channel’s, then the product’s, then the registered name', () => {
    w.erp.channels.upsertOffer({ partnerId: 'GULF-BROKERS', productId: 'PROD-UL-GLOBAL', secondaryName: 'Gulf Life Builder' });
    w.erp.channels.setChannelProductName({ productId: 'PROD-UL-GLOBAL', channelCode: 'BROKER', secondaryName: 'Broker Global Plan' });
    expect(w.erp.channels.secondaryNameFor('PROD-UL-GLOBAL', { channelCode: 'BROKER', partnerId: 'GULF-BROKERS' }))
      .toEqual({ name: 'Gulf Life Builder', source: 'the GULF-BROKERS shelf' });
    expect(w.erp.channels.secondaryNameFor('PROD-UL-GLOBAL', { channelCode: 'BROKER' }))
      .toEqual({ name: 'Broker Global Plan', source: 'the BROKER channel' });
    // A product filed with its own omni-channel name is shown by that name on a channel that has no alias.
    w.erp.defineProductMaster(w, { productId: 'PROD-UL-GLOBAL', name: 'Global Unit-Linked Plan', secondaryName: 'Global Invest-Protect' });
    expect(w.erp.channels.secondaryNameFor('PROD-UL-GLOBAL', { channelCode: 'AGENCY' }))
      .toEqual({ name: 'Global Invest-Protect', source: 'the product master' });
    // …and the standard channels have no channel alias for a product nobody renamed.
    expect(w.erp.channels.secondaryNameFor('PROD-LIFE-TERM').name).toBe('Level Term Life Protection');
  });

  it('refuses to name a product on a channel that does not exist, or a product that does not', () => {
    expect(() => w.erp.channels.setChannelProductName({ productId: 'PROD-UL-GLOBAL', channelCode: 'TELESELL', secondaryName: 'x' }))
      .toThrowError(/not a configured channel/);
    expect(() => w.erp.channels.setChannelProductName({ productId: 'PROD-GHOST', channelCode: 'BROKER', secondaryName: 'x' }))
      .toThrowError(/not filed in the product factory/);
  });

  it('clears an alias by filing a blank one, so the registered name shows again', () => {
    w.erp.channels.setChannelProductName({ productId: 'PROD-UL-GLOBAL', channelCode: 'BROKER', secondaryName: 'Temp Name' });
    w.erp.channels.setChannelProductName({ productId: 'PROD-UL-GLOBAL', channelCode: 'BROKER', secondaryName: '  ' });
    expect(w.erp.channels.secondaryNameFor('PROD-UL-GLOBAL', { channelCode: 'BROKER' }))
      .toEqual({ name: 'Global Unit-Linked Plan', source: 'the registered product name' });
  });
});

describe('commission and clawback', () => {
  let w: World;
  beforeEach(() => { w = fresh(); setUp(w); });

  it('pays the schedule’s year-one figure on the premium, in exact money', () => {
    const premium = money(2_400_000n, 'AED');            // 24,000.00
    const earned = w.erp.channels.commissionFor({ partnerId: 'GULF-BROKERS', productId: 'PROD-UL-GLOBAL', premium, policyYear: 1 });
    expect(earned.bps).toBe(1500);
    expect(formatAmount(earned.commission)).toBe('3,600.00 AED');
    expect(earned.basis).toContain('1500 bps of 24,000.00 AED');
    expect(earned.basis).toContain('GULF-BROKERS');
  });

  it('steps down to the renewal figure and keeps the last one for every later year', () => {
    const premium = money(2_400_000n, 'AED');
    expect(w.erp.channels.commissionFor({ partnerId: 'GULF-BROKERS', productId: 'PROD-UL-GLOBAL', premium, policyYear: 2 }).bps).toBe(500);
    expect(w.erp.channels.commissionFor({ partnerId: 'GULF-BROKERS', productId: 'PROD-UL-GLOBAL', premium, policyYear: 3 }).bps).toBe(250);
    expect(w.erp.channels.commissionFor({ partnerId: 'GULF-BROKERS', productId: 'PROD-UL-GLOBAL', premium, policyYear: 9 }).bps).toBe(250);
    expect(formatAmount(w.erp.channels.commissionFor({ partnerId: 'GULF-BROKERS', productId: 'PROD-UL-GLOBAL', premium, policyYear: 9 }).commission))
      .toBe('600.00 AED');
  });

  it('recovers the whole of a first-year commission when a policy cancels in the first period', () => {
    const commission = money(360_000n, 'AED');           // 3,600.00
    const back = w.erp.channels.clawbackFor({ partnerId: 'GULF-BROKERS', productId: 'PROD-UL-GLOBAL', commission, periodsSinceInception: 1 });
    expect(back.recoverableNow).toBe(true);
    expect(formatAmount(back.recoverable)).toBe('3,600.00 AED');
    expect(back.basis).toContain('10000 bps');
  });

  it('recovers less as the clawback window runs out, and nothing after it', () => {
    const commission = money(360_000n, 'AED');
    const year2 = w.erp.channels.clawbackFor({ partnerId: 'GULF-BROKERS', productId: 'PROD-UL-GLOBAL', commission, periodsSinceInception: 2 });
    expect(formatAmount(year2.recoverable)).toBe('1,800.00 AED');
    const year3 = w.erp.channels.clawbackFor({ partnerId: 'GULF-BROKERS', productId: 'PROD-UL-GLOBAL', commission, periodsSinceInception: 3 });
    expect(formatAmount(year3.recoverable)).toBe('900.00 AED');
    const year6 = w.erp.channels.clawbackFor({ partnerId: 'GULF-BROKERS', productId: 'PROD-UL-GLOBAL', commission, periodsSinceInception: 6 });
    expect(year6.recoverableNow).toBe(false);
    expect(formatAmount(year6.recoverable)).toBe('0.00 AED');
    expect(year6.basis).toContain('nothing');
  });

  it('lets one product’s terms differ from the partner’s, and says which set applied', () => {
    w.erp.channels.upsertOffer({
      partnerId: 'GULF-BROKERS', productId: 'PROD-CI-COMPREHENSIVE',
      commissionBps: [2000, 800], premiumUpliftBps: 150, mortalityUpliftBps: 200,
      clawback: { basis: 'policy-month', trigger: 'cancellation', recoveryBps: [10000, 7500, 5000, 2500], note: 'Four months of tapering recovery.' },
    });
    const premium = money(1_000_000n, 'AED');
    const ci = w.erp.channels.commissionFor({ partnerId: 'GULF-BROKERS', productId: 'PROD-CI-COMPREHENSIVE', premium });
    expect(formatAmount(ci.commission)).toBe('2,000.00 AED');
    expect(ci.basis).toContain('offer');
    const life = w.erp.channels.commissionFor({ partnerId: 'GULF-BROKERS', productId: 'PROD-LIFE-TERM', premium });
    expect(formatAmount(life.commission)).toBe('1,500.00 AED');
    expect(life.basis).toContain('partner defaults');

    const terms = w.erp.channels.termsFor('GULF-BROKERS', 'PROD-CI-COMPREHENSIVE');
    expect(terms.premiumUpliftBps).toBe(150);
    expect(terms.mortalityUpliftBps).toBe(200);
    expect(terms.clawback.recoveryBps).toEqual([10000, 7500, 5000, 2500]);
    // A month-two cancellation on the critical illness plan gives three quarters back, not the yearly half.
    const back = w.erp.channels.clawbackFor({ partnerId: 'GULF-BROKERS', productId: 'PROD-CI-COMPREHENSIVE', commission: money(200_000n, 'AED'), periodsSinceInception: 2 });
    expect(formatAmount(back.recoverable)).toBe('1,500.00 AED');
    expect(back.basis).toContain('policy-month');
  });

  it('refuses a clawback plan that could not be applied: no schedule, a bad basis, or a share above the whole', () => {
    expect(() => w.erp.channels.upsertOffer({
      partnerId: 'GULF-BROKERS', productId: 'PROD-UL-GLOBAL',
      clawback: { basis: 'policy-decade' as never, trigger: 'cancellation', recoveryBps: [10000], note: '' },
    })).toThrowError(/not one of/);
    expect(() => w.erp.channels.upsertOffer({
      partnerId: 'GULF-BROKERS', productId: 'PROD-UL-GLOBAL',
      clawback: { basis: 'policy-year', trigger: 'cancellation', recoveryBps: [], note: '' },
    })).toThrowError(/recovers nothing/);
    expect(() => w.erp.channels.upsertOffer({
      partnerId: 'GULF-BROKERS', productId: 'PROD-UL-GLOBAL',
      clawback: { basis: 'policy-year', trigger: 'cancellation', recoveryBps: [12000], note: '' },
    })).toThrowError(/not a share/);
  });

  it('refuses to price through a partner nobody filed, and to file an offer for a product off the shelf', () => {
    expect(() => w.erp.channels.commissionFor({ partnerId: 'GHOST', productId: 'PROD-UL-GLOBAL', premium: money(1000n, 'AED') }))
      .toThrowError(/no partner GHOST/);
    expect(() => w.erp.channels.upsertOffer({ partnerId: 'GULF-BROKERS', productId: 'PROD-MOTOR-PAYG' }))
      .toThrowError(/not licensed for PROD-MOTOR-PAYG/);
  });

  it('will not let a rate override or an uplift be something an engine cannot price with', () => {
    expect(() => w.erp.channels.upsertOffer({ partnerId: 'GULF-BROKERS', productId: 'PROD-UL-GLOBAL', ratePerThousand: '-5.00' }))
      .toThrowError(/cannot be negative/);
    expect(() => w.erp.channels.upsertOffer({ partnerId: 'GULF-BROKERS', productId: 'PROD-UL-GLOBAL', premiumUpliftBps: 99999 }))
      .toThrowError(/not a multiplier/);
    const offer = w.erp.channels.upsertOffer({ partnerId: 'GULF-BROKERS', productId: 'PROD-UL-GLOBAL', ratePerThousand: '45.50' });
    expect(offer.ratePerThousand).toBe('45.50');
  });
});

describe('what the console is shown', () => {
  let w: World;
  beforeEach(() => { w = fresh(); setUp(w); });

  it('lists the partners selling a product, with the terms that would be applied', () => {
    const rows = w.erp.channels.distributionFor('PROD-UL-GLOBAL');
    expect(rows.length).toBe(1);
    expect(rows[0]!.partnerId).toBe('GULF-BROKERS');
    expect(rows[0]!.channelCode).toBe('BROKER');
    expect(rows[0]!.commissionBps).toEqual([1500, 500, 250]);
    expect(formatAmount(rows[0]!.firstYearCommissionOn)).toBe('150.00 AED');   // 1,500 bps of 1,000.00
    expect(() => w.erp.channels.distributionFor('PROD-GHOST')).toThrowError(/not filed in the product factory/);
  });

  it('warns about a partner with nothing to sell and a channel with nobody on it', () => {
    w.erp.channels.upsertPartner({ partnerId: 'EMPTY-BROKER', name: 'Empty Broker', channelCode: 'BROKER', productIds: [] });
    const status = w.erp.channels.status();
    expect(status.warnings.join(' ')).toContain('EMPTY-BROKER has no products on its shelf');
    expect(status.next.join(' ')).toMatch(/AGENCY|AGGREGATOR|EMBEDDED/);
  });

  it('snapshots the whole registry for the screen, with the names resolved', () => {
    const snap = w.erp.channels.snapshot();
    expect(snap.channels.length).toBe(STANDARD_OMNI_CHANNELS.length);
    const broker = snap.channels.find((c) => c.code === 'BROKER')!;
    expect(broker.partners[0]!.products.length).toBe(3);
    expect(broker.partners[0]!.products[0]!.nameSource.length).toBeGreaterThan(3);
    expect(broker.partners[0]!.products.every((p) => p.commissionBps.length === 3)).toBe(true);
    expect(snap.partnerCount).toBe(1);
    expect(snap.unfiled.length).toBeGreaterThan(0);
  });
});

describe('the illustration rates a quotation may assume', () => {
  /** The pack in force for the UAE: 4% / 8% / 12%, filed in the regulatory module rather than here. */
  const PACK = { lowBps: 400, midBps: 800, highBps: 1200 };

  /** A tenant with the standard channels and one bancassurance counter filed. */
  function world(): World {
    const w = fresh();
    w.erp.channels.bootstrap('2026-10-05T09:00:00Z', 'distribution-lead');
    w.erp.channels.upsertSubChannel({
      code: 'BANCA-COUNTER', name: 'Bank branch counter', parentChannelCode: 'BANCASSURANCE',
      channelType: 'bancassurance-counter', enabled: true, at: '2026-10-05T09:10:00Z', by: 'distribution-lead',
    });
    return w;
  }

  it('falls back from the sub-channel to the channel, the product, the pack and the built-in floor', () => {
    const w = world();
    const product = 'PROD-UL-GLOBAL';

    expect(w.erp.channels.illustrationRatesFor(product, {}, PACK).level).toBe('pack');
    expect(w.erp.channels.illustrationRatesFor(product, {}, PACK).rates).toEqual(PACK);

    // A product row narrows the pack …
    w.erp.channels.setIllustrationRates({ productId: product, midBps: 600, by: 'pricing-actuary' });
    const byProduct = w.erp.channels.illustrationRatesFor(product, {}, PACK);
    expect(byProduct.level).toBe('product');
    expect(byProduct.rates.midBps).toBe(600);
    expect(byProduct.rates.lowBps).toBe(400);                 // untouched: still the pack's

    // … an omni-channel row narrows the product row …
    w.erp.channels.setIllustrationRates({ productId: product, channelCode: 'BANCASSURANCE', highBps: 1000, by: 'pricing-actuary' });
    const byChannel = w.erp.channels.illustrationRatesFor(product, { channelCode: 'BANCASSURANCE' }, PACK);
    expect(byChannel.level).toBe('channel');
    expect(byChannel.rates).toEqual({ lowBps: 400, midBps: 600, highBps: 1000 });

    // … and a sub-channel row narrows the channel row, inheriting whatever it leaves out.
    w.erp.channels.setIllustrationRates({
      productId: product, channelCode: 'BANCASSURANCE', subChannelCode: 'BANCA-COUNTER', lowBps: 200, by: 'pricing-actuary',
    });
    const bySub = w.erp.channels.illustrationRatesFor(product, { channelCode: 'BANCASSURANCE', subChannelCode: 'BANCA-COUNTER' }, PACK);
    expect(bySub.level).toBe('sub-channel');
    expect(bySub.rates).toEqual({ lowBps: 200, midBps: 600, highBps: 1000 });
    // Every figure says which row it came from, so a quotation can be defended figure by figure.
    expect(bySub.sources.lowBps).toMatch(/sub-channel/);
    expect(bySub.sources.midBps).toMatch(/product/);
    expect(bySub.sources.highBps).toMatch(/omni-channel/);
  });

  it('falls through to the built-in floor when even the pack is silent', () => {
    const w = world();
    const rates = w.erp.channels.illustrationRatesFor('PROD-UL-GLOBAL', {});
    expect(rates.level).toBe('built-in');
    expect(rates.rates.midBps).toBeGreaterThan(0);
    expect(rates.sources.midBps).toMatch(/built-in/);
  });

  it('refuses a product the factory does not hold, and a channel the tenant has not filed', () => {
    const w = world();
    expect(() => w.erp.channels.setIllustrationRates({ productId: 'PROD-NOT-FILED', midBps: 600 }))
      .toThrowError(/not filed in the product factory/);
    expect(() => w.erp.channels.setIllustrationRates({ productId: 'PROD-UL-GLOBAL', channelCode: 'BANKWALL', midBps: 600 }))
      .toThrowError(/is not filed on this tenant/);
    expect(() => w.erp.channels.setIllustrationRates({ productId: 'PROD-UL-GLOBAL', subChannelCode: 'NO-SUCH-COUNTER', midBps: 600 }))
      .toThrowError(/is not filed on this tenant/);
  });

  it('removes a row when every figure is left blank, and leaves an audit trail of the filings', () => {
    const w = world();
    w.erp.channels.setIllustrationRates({ productId: 'PROD-UL-GLOBAL', midBps: 600, by: 'pricing-actuary', at: '2026-10-05T09:20:00Z' });
    expect(w.erp.channels.listIllustrationRates()).toHaveLength(1);

    // Filing nothing at all is "stop overriding", not "override with nothing".
    w.erp.channels.setIllustrationRates({ productId: 'PROD-UL-GLOBAL', by: 'pricing-actuary', at: '2026-10-05T09:25:00Z' });
    expect(w.erp.channels.listIllustrationRates()).toHaveLength(0);
    expect(w.erp.channels.illustrationRatesFor('PROD-UL-GLOBAL', {}, PACK).level).toBe('pack');

    w.erp.channels.setIllustrationRates({ productId: 'PROD-UL-GLOBAL', lowBps: 300, by: 'pricing-actuary', at: '2026-10-05T09:30:00Z' });
    expect(w.erp.channels.clearIllustrationRates({ productId: 'PROD-UL-GLOBAL', by: 'pricing-actuary' })).toBe(true);
    expect(w.erp.channels.clearIllustrationRates({ productId: 'PROD-UL-GLOBAL', by: 'pricing-actuary' })).toBe(false);
    const trail = w.erp.channels.illustrationRateAudit(10).map((entry) => entry.detail).join(' | ');
    expect(trail).toMatch(/filed Mid 6\.00%/);
    expect(trail).toMatch(/removed; this scope now inherits from its parent/);
  });
});
