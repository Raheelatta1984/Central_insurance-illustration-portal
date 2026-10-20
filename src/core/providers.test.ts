/**
 * Multi-country providers: licence, branch, reinsurance, currency and the Conventional/Takaful
 * permission at every level of the route.
 *
 * The reason these tests matter is the failure they prevent. A carrier with only a home licence can
 * quote in another country and discover at claims time that the policy was never validly written; a
 * broker's call centre and agency desk are not the same distribution permission; and a sale in
 * sterling that is priced off a dirham product is a mis-stated premium. Each of those is a refusal
 * here, with a sentence naming the filing that is missing.
 */
import { describe, expect, it } from 'vitest';
import { buildWorld, worldSnapshot } from './demo.js';

const AT = '2026-10-05T12:00:00+04:00';

function channels(world = buildWorld()) {
  world.erp.channels.bootstrap(AT, 'distribution-test');
  return world;
}

describe('a provider may not sell without a branch, a country reinsurance and a currency', () => {
  it('refuses each missing filing in turn, then prices the sale in the country currency', () => {
    const w = channels();
    const gov = w.erp.providers;
    gov.upsertProvider({
      providerId: 'ACME', name: 'Acme Insurance', homeCountry: 'AE',
      productTypePermission: 'both', homeLicenceNumber: 'CBUAE-LIC-999', at: AT, by: 'test',
    });
    gov.attachProviderProduct({ providerId: 'ACME', country: 'AE', productId: 'PROD-LIFE-TERM', at: AT, by: 'test' });
    gov.upsertChannelCountry({
      channelCode: 'BROKER', country: 'AE', operatingName: 'Acme Brokers', licenceNumber: 'BR-LIC-1',
      providerIds: ['ACME'], at: AT, by: 'test',
    });

    const noBranch = gov.canSell({
      providerId: 'ACME', productId: 'PROD-LIFE-TERM', channelCode: 'BROKER', country: 'AE',
    });
    expect(noBranch.allowed).toBe(false);
    expect(noBranch.reasons.join(' ')).toContain('has no registered branch in AE');
    expect(noBranch.reasons.join(' ')).toContain('may only sell through a country in which it holds a registered, licensed branch');

    gov.registerBranch({
      providerId: 'ACME', country: 'AE', registrationNumber: 'CBUAE/BR/AE/999',
      licenceType: 'both', licenceStatus: 'licensed', at: AT, by: 'test',
    });
    const noReinsurance = gov.canSell({
      providerId: 'ACME', productId: 'PROD-LIFE-TERM', channelCode: 'BROKER', country: 'AE',
    });
    expect(noReinsurance.allowed).toBe(false);
    expect(noReinsurance.reasons.join(' ')).toContain('no reinsurance arrangement filed for AE');

    gov.fileReinsurance({
      providerId: 'ACME', country: 'AE', reinsurer: 'Emirates Re', kind: 'treaty', basis: 'quota-share',
      cessionBps: 2500, retention: '250,000.00', limit: '50,000,000.00', at: AT, by: 'test',
    });
    const allowed = gov.canSell({
      providerId: 'ACME', productId: 'PROD-LIFE-TERM', channelCode: 'BROKER', country: 'AE',
      action: 'quote', asOf: '2026-10-05',
    });
    expect(allowed.allowed).toBe(true);
    expect(allowed.reasons).toEqual([]);
    expect(allowed.context).toMatchObject({
      originCountry: 'AE', quoteCurrency: 'AED', premiumManagedIn: 'AE',
      investmentHeldIn: 'AE', capitalReportedTo: 'AE', book: 'conventional',
    });
    expect(allowed.context!.premiumManagedBy).toContain('CBUAE/BR/AE/999');
  });

  it('treats Takaful as a separate book: a conventional treaty is not retakaful', () => {
    const w = channels();
    const gov = w.erp.providers;
    gov.upsertProvider({ providerId: 'ACME', name: 'Acme Insurance', homeCountry: 'AE', productTypePermission: 'both', at: AT, by: 'test' });
    gov.registerBranch({
      providerId: 'ACME', country: 'AE', registrationNumber: 'BR/1', licenceType: 'both',
      licenceStatus: 'licensed', at: AT, by: 'test',
    });
    gov.attachProviderProduct({ providerId: 'ACME', country: 'AE', productId: 'PROD-TKF-FAMILY', at: AT, by: 'test' });
    gov.upsertChannelCountry({ channelCode: 'BROKER', country: 'AE', providerIds: ['ACME'], licenceNumber: 'L', at: AT, by: 'test' });
    gov.fileReinsurance({
      providerId: 'ACME', country: 'AE', reinsurer: 'Emirates Re', kind: 'treaty',
      cessionBps: 1000, retention: '10,000.00', limit: '100,000.00', at: AT, by: 'test',
    });

    const treatyOnly = gov.canSell({ providerId: 'ACME', productId: 'PROD-TKF-FAMILY', channelCode: 'BROKER', country: 'AE' });
    expect(treatyOnly.allowed).toBe(false);
    expect(treatyOnly.reasons.join(' ')).toContain('no retakaful arrangement filed for AE');

    gov.fileReinsurance({
      providerId: 'ACME', country: 'AE', reinsurer: 'Takaful Re', kind: 'retakaful',
      cessionBps: 2000, retention: '10,000.00', limit: '100,000.00', at: AT, by: 'test',
    });
    const withRetakaful = gov.canSell({ providerId: 'ACME', productId: 'PROD-TKF-FAMILY', channelCode: 'BROKER', country: 'AE' });
    expect(withRetakaful.allowed).toBe(true);
    expect(withRetakaful.reinsurance?.kind).toBe('retakaful');
  });
});

describe('the Marsh example: two sub-channels, two product permissions, three currencies', () => {
  const seeded = () => {
    const w = buildWorld();
    const result = w.erp.seedDistributionExample(w, { by: 'test' });
    return { w, result, gov: w.erp.providers };
  };

  it('files the carriers, branches, arrangements, country presences and permissions once', () => {
    const { w, result, gov } = seeded();
    expect(result.seeded).toBe(true);
    expect(result.created).toMatchObject({
      providers: 3, branches: 6, arrangements: 8, channelCountries: 3,
      permissions: 6, providerProducts: 12,
    });
    expect(result.created.localProducts).toContain('PROD-TKF-FAMILY-SG');
    expect(result.created.rateRows).toBeGreaterThan(0);
    expect(gov.stats()).toMatchObject({ providers: 3, branches: 6, licensedBranches: 6, countries: 3 });
    expect(gov.listProviders().map((p) => p.providerId)).toEqual(['AL-KHALEEJ', 'ETIQA', 'GULF-UNION']);
    expect(gov.snapshot().blockers).toEqual([]);

    const again = w.erp.seedDistributionExample(w);
    expect(again.seeded).toBe(false);
    expect(again.skipped).toBe(true);
  });

  it('allows the call centre to sell both books and narrows the agency desk to conventional only', () => {
    const { gov } = seeded();
    const callCentreTakaful = gov.canSell({
      providerId: 'AL-KHALEEJ', productId: 'PROD-TKF-FAMILY', country: 'AE',
      channelCode: 'MARSH-BROKER', subChannelCode: 'MARSH-CALL-CENTRE', partnerId: 'MARSH-AE',
    });
    expect(callCentreTakaful.allowed).toBe(true);
    expect(callCentreTakaful.book).toBe('takaful');
    expect(callCentreTakaful.permission.sources.map((s) => `${s.scope}:${s.permission}`)).toEqual([
      'channel:both', 'sub-channel:both', 'partner:both',
    ]);

    const agencyTakaful = gov.canSell({
      providerId: 'AL-KHALEEJ', productId: 'PROD-TKF-FAMILY', country: 'AE',
      channelCode: 'MARSH-BROKER', subChannelCode: 'MARSH-AGENCY', partnerId: 'MARSH-AE',
    });
    expect(agencyTakaful.allowed).toBe(false);
    expect(agencyTakaful.reasons.join(' ')).toContain('enabled for conventional only');
    expect(agencyTakaful.reasons.join(' ')).toContain('Enable the takaful checkbox');

    const agencyConventional = gov.canSell({
      providerId: 'AL-KHALEEJ', productId: 'PROD-LIFE-TERM', country: 'AE',
      channelCode: 'MARSH-BROKER', subChannelCode: 'MARSH-AGENCY', partnerId: 'MARSH-AE',
    });
    expect(agencyConventional.allowed).toBe(true);
  });

  it('prices each country in its own currency and keeps the investment in the origin country', () => {
    const { gov } = seeded();
    const uk = gov.canSell({
      providerId: 'AL-KHALEEJ', productId: 'PROD-LIFE-TERM-GB', country: 'GB',
      channelCode: 'MARSH-BROKER', partnerId: 'MARSH-GB',
    });
    expect(uk.allowed).toBe(true);
    expect(uk.currency).toBe('GBP');
    expect(uk.context).toMatchObject({
      originCountry: 'GB', quoteCurrency: 'GBP', investmentHeldIn: 'GB',
      premiumManagedIn: 'GB', capitalReportedTo: 'AE',
    });

    const singapore = gov.canSell({
      providerId: 'ETIQA', productId: 'PROD-TKF-FAMILY-SG', country: 'SG',
      channelCode: 'MARSH-BROKER', subChannelCode: 'MARSH-CALL-CENTRE', partnerId: 'MARSH-SG',
    });
    expect(singapore.allowed).toBe(true);
    expect(singapore.currency).toBe('SGD');
    expect(singapore.context).toMatchObject({
      originCountry: 'SG', quoteCurrency: 'SGD', investmentHeldIn: 'SG', capitalReportedTo: 'MY',
    });
  });

  it('refuses a Takaful product for a conventional-only carrier and names both limits', () => {
    const { gov } = seeded();
    const denied = gov.canSell({
      providerId: 'GULF-UNION', productId: 'PROD-TKF-FAMILY', country: 'AE',
      channelCode: 'MARSH-BROKER', partnerId: 'MARSH-AE',
    });
    expect(denied.allowed).toBe(false);
    const text = denied.reasons.join(' ');
    expect(text).toContain('not on GULF-UNION\'s AE shelf');
    expect(text).toContain('licensed for conventional business');
    expect(text).toContain('branch is licensed for conventional business');
  });

  it('intersects permissions: a partner cannot widen a channel that has been narrowed', () => {
    const { gov } = seeded();
    gov.setSellPermission({ scope: 'channel', scopeId: 'MARSH-BROKER', conventional: true, takaful: false, at: AT, by: 'test' });
    const effective = gov.effectivePermission({ channelCode: 'MARSH-BROKER', subChannelCode: 'MARSH-CALL-CENTRE', partnerId: 'MARSH-AE' });
    expect(effective.permission).toBe('conventional');
    expect(effective.takaful).toBe(false);
    const denied = gov.canSell({
      providerId: 'ETIQA', productId: 'PROD-TKF-FAMILY', country: 'AE',
      channelCode: 'MARSH-BROKER', subChannelCode: 'MARSH-CALL-CENTRE', partnerId: 'MARSH-AE',
    });
    expect(denied.allowed).toBe(false);
    expect(denied.reasons.join(' ')).toContain('enabled for conventional only');
    // Clearing the explicit row restores the inherited default: nothing is hard-coded off.
    gov.removeSellPermission('channel', 'MARSH-BROKER', AT, 'test');
    expect(gov.effectivePermission({ channelCode: 'MARSH-BROKER', partnerId: 'MARSH-AE' }).permission).toBe('both');
  });
});

describe('the permission is a control on the price, not a label', () => {
  it('will not price a Takaful risk through an agency desk narrowed to conventional only', () => {
    const w = buildWorld();
    w.erp.seedDistributionExample(w);
    const allowed = w.erp.priceRisk(w, {
      productId: 'PROD-TKF-FAMILY', age: 35, gender: 'male', sumAssured: '100,000.00',
      providerId: 'AL-KHALEEJ', country: 'AE', channelCode: 'MARSH-BROKER',
      subChannelCode: 'MARSH-CALL-CENTRE', partnerId: 'MARSH-AE',
    });
    expect(allowed.price.priced).toBe(true);
    expect(allowed.sale?.allowed).toBe(true);
    expect(allowed.sale?.context?.quoteCurrency).toBe('AED');

    expect(() => w.erp.priceRisk(w, {
      productId: 'PROD-TKF-FAMILY', age: 35, gender: 'male', sumAssured: '100,000.00',
      providerId: 'AL-KHALEEJ', country: 'AE', channelCode: 'MARSH-BROKER',
      subChannelCode: 'MARSH-AGENCY', partnerId: 'MARSH-AE',
    })).toThrow(/Sale refused:.*enabled for conventional only/);
  });
});

describe('the files are checked, not assumed', () => {
  it('refuses a product in the wrong currency, a branch in the wrong currency and a channel presence in the wrong currency', () => {
    const { w, gov } = (() => {
      const world = buildWorld();
      world.erp.seedDistributionExample(world);
      return { w: world, gov: world.erp.providers };
    })();
    expect(w.erp.channels.channel('MARSH-BROKER')).toBeDefined();
    expect(() => gov.upsertChannelCountry({
      channelCode: 'MARSH-BROKER', country: 'GB', currency: 'AED', providerIds: ['AL-KHALEEJ'],
    })).toThrow(/GB is a GBP country/);
    expect(() => gov.registerBranch({
      providerId: 'AL-KHALEEJ', country: 'GB', registrationNumber: 'X-1', currency: 'AED',
    })).toThrow(/cannot be registered in AED/);
    expect(() => gov.attachProviderProduct({
      providerId: 'AL-KHALEEJ', country: 'GB', productId: 'PROD-LIFE-TERM',
    })).toThrow(/filed in AED.*GBP.*product master/s);
    expect(() => gov.attachProviderProduct({
      providerId: 'AL-KHALEEJ', country: 'GB', productId: 'NOT-A-PRODUCT',
    })).toThrow(/not filed in the product factory/);
  });

  it('refuses bad ids, unknown countries, unknown scopes and a retention above the limit', () => {
    const { gov } = (() => {
      const world = buildWorld();
      world.erp.seedDistributionExample(world);
      return { gov: world.erp.providers };
    })();
    expect(() => gov.upsertProvider({ providerId: 'bad id', homeCountry: 'AE' })).toThrow(/Provider ID must be/);
    expect(() => gov.upsertProvider({ providerId: 'ACME', homeCountry: 'ZZ' })).toThrow(/not a country pack/);
    expect(() => gov.setSellPermission({ scope: 'partner', scopeId: 'NOPE', conventional: true, takaful: true })).toThrow(/not a filed partner/);
    expect(() => gov.setSellPermission({ scope: 'branch', scopeId: 'X', conventional: true, takaful: true })).toThrow(/scope must be channel/);
    expect(() => gov.fileReinsurance({
      providerId: 'AL-KHALEEJ', country: 'AE', reinsurer: 'Too Small Re',
      retention: '900,000.00', limit: '100,000.00',
    })).toThrow(/above the limit/);
    expect(() => gov.removeProvider('AL-KHALEEJ')).toThrow(/is named by \d+ channel-country presence/);
  });

  it('reports an applied-for licence, central premium collection and a home-country investment as blockers', () => {
    const w = buildWorld();
    w.erp.seedDistributionExample(w);
    const gov = w.erp.providers;
    gov.registerBranch({
      providerId: 'GULF-UNION', country: 'AE', registrationNumber: 'CBUAE/BR/AE/0155',
      licenceStatus: 'applied', licenceType: 'conventional', at: AT, by: 'test',
    });
    const applied = gov.canSell({
      providerId: 'GULF-UNION', productId: 'PROD-LIFE-TERM', country: 'AE',
      channelCode: 'MARSH-BROKER', partnerId: 'MARSH-AE',
    });
    expect(applied.allowed).toBe(false);
    expect(applied.reasons.join(' ')).toContain('licence is applied');

    gov.registerBranch({
      providerId: 'GULF-UNION', country: 'AE', registrationNumber: 'CBUAE/BR/AE/0155',
      licenceStatus: 'licensed', licenceType: 'conventional', localPremiumCollection: false, at: AT, by: 'test',
    });
    const central = gov.canSell({
      providerId: 'GULF-UNION', productId: 'PROD-LIFE-TERM', country: 'AE',
      channelCode: 'MARSH-BROKER', partnerId: 'MARSH-AE',
    });
    expect(central.allowed).toBe(false);
    expect(central.reasons.join(' ')).toContain('Premium for GULF-UNION AE is collected centrally');

    gov.registerBranch({
      providerId: 'GULF-UNION', country: 'AE', registrationNumber: 'CBUAE/BR/AE/0155',
      licenceStatus: 'licensed', licenceType: 'conventional', localPremiumCollection: true,
      investmentResidence: 'home-country', at: AT, by: 'test',
    });
    const home = gov.canSell({
      providerId: 'GULF-UNION', productId: 'PROD-LIFE-TERM', country: 'AE',
      channelCode: 'MARSH-BROKER', partnerId: 'MARSH-AE',
    });
    expect(home.allowed).toBe(false);
    expect(home.reasons.join(' ')).toContain('files investment as home-country');
  });

  it('refuses a sub-channel and partner that do not belong to the named channel', () => {
    const w = buildWorld();
    w.erp.seedDistributionExample(w);
    const gov = w.erp.providers;
    expect(() => gov.effectivePermission({ channelCode: 'MARSH-BROKER', subChannelCode: 'NOPE' })).toThrow(/not a filed sub-channel/);
    expect(() => gov.effectivePermission({ channelCode: 'MARSH-BROKER', partnerId: 'GULF-BROKERS' })).toThrow(/not a filed partner/);
    const wrongPartner = gov.canSell({
      providerId: 'AL-KHALEEJ', productId: 'PROD-LIFE-TERM', country: 'AE',
      channelCode: 'BROKER', partnerId: 'MARSH-AE',
    });
    expect(wrongPartner.allowed).toBe(false);
    expect(wrongPartner.reasons.join(' ')).toContain('is filed on MARSH-BROKER, not BROKER');
  });
});

describe('the snapshot the console reads', () => {
  it('starts empty and tells the operator so', () => {
    const w = buildWorld();
    const providers = worldSnapshot(w).erp.master.providers;
    expect(providers.stats.providers).toBe(0);
    expect(providers.stats.channelCountries).toBe(0);
    expect(providers.example.seeded).toBe(false);
    expect(providers.rules.branch).toContain('registered, licensed branch');
    expect(providers.countryChoices.length).toBeGreaterThanOrEqual(30);
  });

  it('carries each provider with its branches, products, arrangements, books and blockers', () => {
    const w = buildWorld();
    w.erp.seedDistributionExample(w);
    const providers = worldSnapshot(w).erp.master.providers;
    expect(providers.example.seeded).toBe(true);
    expect(providers.example.channelCode).toBe('MARSH-BROKER');
    const etiqa = providers.providers.find((p) => p.providerId === 'ETIQA')!;
    expect(etiqa.books).toEqual(['takaful']);
    expect(etiqa.branches.map((b) => b.country).sort()).toEqual(['AE', 'SG']);
    expect(etiqa.arrangements.every((a) => a.kind === 'retakaful')).toBe(true);
    expect(etiqa.products.map((p) => p.productId)).toContain('PROD-TKF-FAMILY-SG');
    expect(providers.effectivePermissions.find((r) => r.scopeId === 'MARSH-AGENCY')).toMatchObject({
      conventional: true, takaful: false, permission: 'conventional',
    });
    expect(providers.channelCountries.find((c) => c.country === 'GB')?.currency).toBe('GBP');
    expect(providers.audit.length).toBeGreaterThan(0);
  });
});
