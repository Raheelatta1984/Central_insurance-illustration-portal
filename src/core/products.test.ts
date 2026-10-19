/**
 * The product catalogue: the varieties on file, and the proof that the engines read them.
 *
 * A catalogue that is merely a list is decoration. What matters is that every variety carries numbers
 * an underwriter can defend, that every line has an alternative on it (so a recommendation can present
 * one), and that a product on the list can actually be registered, assessed and priced — which is what
 * the last group of tests does, through the same engine the API uses.
 */
import { describe, expect, it } from 'vitest';
import { buildWorld } from './demo.js';
import { money, parseAmount } from './money.js';
import {
  EVIDENCE_PROFILES, PRODUCT_CATALOGUE, PRODUCT_LINES, WORLDWIDE, catalogueByLine,
  evidenceProfileFor, lineDef, productVariety, varietiesFor,
} from './products.js';
import { productCatalogue } from './journeydesk.js';
import { recommendProducts, evaluateNeeds } from './needs.js';
import { UnderwritingError } from './underwriting.js';

/** One complete AE questionnaire, with the objective swapped: the catalogue is ranked against it. */
function answers(objective: string, overrides: Record<string, string | number | boolean> = {}) {
  const base: Record<string, string | number | boolean> = {
    'residence-country': 'AE', dependants: 2, 'annual-income': 480000, 'existing-cover': 0,
    'outstanding-debt': 600000, 'premium-budget': 90000, objective, 'risk-appetite': 'balanced',
    'shariah-preferred': false, age: 44, smoker: false, 'medical-conditions': false, 'occupation-class': '2',
  };
  return Object.entries({ ...base, ...overrides }).map(([questionId, value]) => ({ questionId, value }));
}

const world = buildWorld();

describe('the catalogue itself', () => {
  it('holds every product id once, and every name once', () => {
    const ids = PRODUCT_CATALOGUE.map((p) => p.productId);
    expect(new Set(ids).size, 'duplicate product ids').toBe(ids.length);
    const names = PRODUCT_CATALOGUE.map((p) => p.name);
    expect(new Set(names).size, 'duplicate product names').toBe(names.length);
    for (const id of ids) expect(id, id).toMatch(/^PROD-[A-Z0-9-]+$/);
  });

  it('is wide: term, endowment, lifestyle, critical illness, medical, general, marine, home, travel, mortgage and hull', () => {
    for (const line of ['life', 'endowment', 'income-protection', 'critical-illness', 'medical', 'general', 'marine', 'home', 'travel', 'mortgage', 'hull'] as const) {
      expect(varietiesFor(line).length, `${line} varieties`).toBeGreaterThanOrEqual(3);
    }
    expect(PRODUCT_CATALOGUE.length).toBeGreaterThanOrEqual(60);
  });

  it('gives every line at least two varieties, so a recommendation always has an alternative to present', () => {
    for (const line of PRODUCT_LINES) {
      const varieties = varietiesFor(line.id);
      expect(varieties.length, `${line.id} needs an alternative on it`).toBeGreaterThanOrEqual(2);
    }
    // And the two lists agree: no line in the metadata that nothing is filed under, and no product on
    // a line nobody has described.
    const catalogued = new Set(PRODUCT_CATALOGUE.map((p) => p.line));
    for (const line of PRODUCT_LINES) expect(catalogued.has(line.id), `no products on ${line.id}`).toBe(true);
    for (const line of catalogued) expect(PRODUCT_LINES.some((l) => l.id === line), `${line} is not described`).toBe(true);
    expect(catalogueByLine().reduce((total, l) => total + l.count, 0)).toBe(PRODUCT_CATALOGUE.length);
  });

  it('carries numbers an underwriter can defend on every variety', () => {
    for (const p of PRODUCT_CATALOGUE) {
      expect(p.minAge, `${p.productId} min age`).toBeGreaterThanOrEqual(0);
      expect(p.maxAge, `${p.productId} max age`).toBeLessThanOrEqual(99);
      expect(p.minAge, `${p.productId} entry range`).toBeLessThan(p.maxAge);
      const rate = parseAmount(p.baseRatePerThousand, 'AED');
      expect(rate.minor > 0n, `${p.productId} rate`).toBe(true);
      // A rate above 20 per cent of the sum assured a year is a savings contract, not insurance.
      expect(rate.minor < 20_000n, `${p.productId} rate ${p.baseRatePerThousand}`).toBe(true);
      expect(p.automaticBindingLimit, `${p.productId} binding limit`).toBeDefined();
      expect(parseAmount(p.facultativeThreshold!, 'AED').minor, `${p.productId} facultative above binding`)
        .toBeGreaterThanOrEqual(parseAmount(p.automaticBindingLimit!, 'AED').minor);
      expect(parseAmount(p.aiStraightThroughLimit!, 'AED').minor, `${p.productId} AI limit inside binding`)
        .toBeLessThanOrEqual(parseAmount(p.automaticBindingLimit!, 'AED').minor);
      expect(p.blurb.length, `${p.productId} blurb`).toBeGreaterThan(40);
      expect(p.variety.length, `${p.productId} variety`).toBeGreaterThan(1);
    }
  });

  it('keeps the books honest: takaful varieties are takaful, unit-linked varieties hold funds', () => {
    const takaful = PRODUCT_CATALOGUE.filter((p) => p.category === 'takaful');
    expect(takaful.length).toBeGreaterThanOrEqual(6);
    for (const p of takaful) {
      expect(`${p.name} ${p.blurb}`.toLowerCase(), `${p.productId} must say what makes it takaful`)
        .toMatch(/takaful|tabarru|wakalah/);
    }
    for (const p of PRODUCT_CATALOGUE.filter((x) => x.category === 'unit-linked')) {
      expect((p.defaultFunds ?? []).length, `${p.productId} needs funds to invest in`).toBeGreaterThan(0);
    }
    // A pay-as-you-go motor book is the only one billed by the day.
    expect(PRODUCT_CATALOGUE.filter((p) => p.category === 'motor-payg').map((p) => p.productId)).toEqual(['PROD-MOTOR-PAYG']);
  });

  it('gives each line an evidence profile, and worldwide lines a territory to match', () => {
    for (const p of PRODUCT_CATALOGUE) {
      const profile = p.evidenceProfile ?? evidenceProfileFor(p.line);
      expect(EVIDENCE_PROFILES[profile], `${p.productId} profile ${profile}`).toBeDefined();
      expect(EVIDENCE_PROFILES[profile]!.length, `${profile} has bands`).toBeGreaterThan(0);
    }
    expect(evidenceProfileFor('medical')).toBe('medical');
    expect(evidenceProfileFor('hull')).toBe('short-tail');
    expect(evidenceProfileFor('life')).toBe('life');
    // Travel, marine and hull are sold across borders; a territory list of three countries would
    // decline a customer the product was written for.
    for (const p of PRODUCT_CATALOGUE.filter((x) => ['travel', 'marine', 'hull'].includes(x.line))) {
      expect((p.acceptedCountries ?? []).length, `${p.productId} territory`).toBeGreaterThan(10);
    }
    expect(WORLDWIDE.length).toBeGreaterThan(30);
    expect(lineDef('hull').family).toBe('marine & aviation');
    expect(productVariety('prod-hull-marine')?.name).toBe('Marine Hull & Machinery');
    expect(productVariety('PROD-NOPE')).toBeUndefined();
  });
});

describe('the five the demo world has always run', () => {
  it('keep the ids, names and numbers the rest of the platform was built against', () => {
    const legacy: Record<string, { name: string; category: string; line: string; rate: string }> = {
      'PROD-UL-GLOBAL': { name: 'Global Unit-Linked Plan', category: 'unit-linked', line: 'life', rate: '48.00' },
      'PROD-LIFE-TERM': { name: 'Level Term Life Protection', category: 'conventional', line: 'life', rate: '30.00' },
      'PROD-MEDICAL-GRP': { name: 'Comprehensive Medical Cover', category: 'conventional', line: 'medical', rate: '30.00' },
      'PROD-TKF-FAMILY': { name: 'Family Takaful Protection & Savings Plan', category: 'takaful', line: 'life', rate: '36.00' },
      'PROD-MOTOR-PAYG': { name: 'Pay-as-you-drive Motor Cover', category: 'motor-payg', line: 'motor', rate: '20.00' },
    };
    for (const [id, expected] of Object.entries(legacy)) {
      const variety = productVariety(id)!;
      expect(variety.name, id).toBe(expected.name);
      expect(variety.category, id).toBe(expected.category);
      expect(variety.line, id).toBe(expected.line);
      expect(variety.baseRatePerThousand, id).toBe(expected.rate);
      // And they are seeded first, so a screen that reads the top of the list reads what it always did.
      expect(PRODUCT_CATALOGUE.slice(0, 5).map((p) => p.productId)).toContain(id);
    }
  });
});

describe('the world seeds the catalogue', () => {
  it('makes every variety a product master with underwriting rules behind it', () => {
    const masters = world.erp.listProductMasters();
    expect(masters.length).toBe(PRODUCT_CATALOGUE.length);
    for (const variety of PRODUCT_CATALOGUE) {
      const master = world.erp.productMaster(variety.productId);
      expect(master.variety, variety.productId).toBe(variety.variety);
      expect(master.blurb, variety.productId).toBe(variety.blurb);
      expect(master.category).toBe(variety.category);
      expect(master.line).toBe(variety.line);
      expect(master.entityId).toBe(variety.category === 'takaful' ? world.takafulEntity : world.conventionalEntity);
      // The rules are registered in the underwriting engine, not just listed on a screen.
      const rules = world.underwriting.rulesFor(variety.productId);
      expect(rules.minAge).toBe(variety.minAge);
      expect(rules.maxAge).toBe(variety.maxAge);
      expect(rules.baseRatePerThousandMinor).toBe(parseAmount(variety.baseRatePerThousand, master.currency).minor);
      expect(rules.evidenceBands.length).toBeGreaterThan(0);
      if (variety.category === 'takaful') expect(master.takafulConfig).toBeDefined();
    }
    expect(() => world.underwriting.rulesFor('PROD-NOPE')).toThrow(UnderwritingError);
  });

  it('leaves the demo world\u2019s own books untouched: the seeded policies and proposals still price the same', () => {
    const snapshot = world.erp.snapshot(world);
    expect(snapshot.policies.map((p) => p.policyId)).toEqual(['UL-000123', 'MTR-0441', 'TK-9001']);
    expect(snapshot.summary.products).toBe(PRODUCT_CATALOGUE.length);
    expect(snapshot.policies.find((p) => p.policyId === 'UL-000123')!.sumAssured).toBe('250,000.00 AED');
    expect(snapshot.master.regional.localCurrency).toBe('AED');
    expect(snapshot.master.regional.country).toBe('AE');
    expect(snapshot.master.productLines.length).toBe(PRODUCT_LINES.length);
  });

  it('prices a risk on a brand-new line through the same engine the API uses', () => {
    // A hull risk: nothing in the demo world ever underwrote one before this catalogue existed.
    const app = world.underwriting.register({
      partyId: 'PTY-0001', productId: 'PROD-HULL-MARINE', sumAssured: money(4_000_000_00n, 'AED'),
      at: '2026-10-05T10:00:00+04:00',
      profile: {
        partyId: 'PTY-0001', age: 44, sex: 'male', smoker: false, heightCm: 175, weightKg: 80,
        occupationClass: 2, pursuits: [], conditions: [], familyHistory: [],
        residenceCountry: 'AE', annualIncome: money(60_000_00n, 'AED'),
      },
    });
    const assessment = world.underwriting.assess(app.id);
    const rules = world.underwriting.rulesFor('PROD-HULL-MARINE');
    // The standard premium is the catalogue rate on the sum assured: 9.50 per 1,000 of 4,000,000.
    expect(assessment.standardPremium.minor).toBe((money(4_000_000_00n, 'AED').minor * rules.baseRatePerThousandMinor) / (1000n * 100n));
    expect(assessment.standardPremium.minor).toBe(3_800_000n); // 38,000.00 AED a year
    // 4,000,000 is under the 5,000,000 automatic binding limit a commercial line is filed with.
    expect(assessment.reinsurance.mode).toBe('automatic');
  });

  it('ranks the new lines in the journey\u2019s recommendation, with the objective they answer', () => {
    const candidates = productCatalogue(world);
    expect(candidates.length).toBe(PRODUCT_CATALOGUE.length);
    const marine = candidates.find((c) => c.productId === 'PROD-MAR-OPEN')!;
    expect(marine.objectives).toContain('business-continuity');
    expect(marine.investmentLinked).toBe(false);

    const evaluation = evaluateNeeds({ needId: 'NA-TEST-1', answers: answers('business-continuity', { dependants: 0, 'outstanding-debt': 0 }) });
    const ranked = recommendProducts({ evaluation, candidates });
    const openCover = ranked.find((r) => r.productId === 'PROD-MAR-OPEN')!;
    expect(openCover.fits, `marine open cover should fit a business-continuity need: ${openCover.disqualifiers.join('; ')}`).toBe(true);
    // A family-protection need must not be answered with a cargo policy.
    const family = evaluateNeeds({ needId: 'NA-TEST-2', answers: answers('family-protection', { age: 41 }) });
    const familyRanked = recommendProducts({ evaluation: family, candidates });
    expect(familyRanked.find((r) => r.productId === 'PROD-MAR-OPEN')!.fits).toBe(false);
    expect(familyRanked.find((r) => r.productId === 'PROD-MTG-REDUCTION')!.fits).toBe(true);
  });

  it('re-files a catalogue product from its id, keeping the numbers nobody changed', () => {
    const before = world.erp.productMaster('PROD-CI-MULTIPAY');
    const after = world.erp.defineProductMaster(world, { productId: 'PROD-CI-MULTIPAY', baseRatePerThousand: '92.00', by: 'product-factory' });
    expect(after.name).toBe(before.name);
    expect(after.variety).toBe(before.variety);
    expect(after.blurb).toBe(before.blurb);
    expect(after.line).toBe('critical-illness');
    expect(after.rules.baseRatePerThousandMinor).toBe(parseAmount('92.00', after.currency).minor);
    expect(after.rules.automaticBindingLimitMinor).toBe(before.rules.automaticBindingLimitMinor);
    expect(after.rules.evidenceBands.length).toBeGreaterThan(0);
    // A new variety, not on file, still has to be given a name — and inherits the life manual.
    const fresh = world.erp.defineProductMaster(world, { productId: 'PROD-CYBER-SME', name: 'SME Cyber Cover', line: 'general', category: 'conventional', baseRatePerThousand: '16.00' });
    expect(fresh.variety).toBe('SME Cyber Cover');
    expect(fresh.currency).toBe(world.erp.regionalSettings().current.localCurrency);
    expect(fresh.rules.evidenceBands.length).toBeGreaterThan(0);
    expect(() => world.erp.defineProductMaster(world, { productId: 'PROD-BAD', name: 'Bad ages', minAge: 70, maxAge: 20 })).toThrow(/entry age/);
    expect(() => world.erp.defineProductMaster(world, { productId: '' })).toThrow(/productId/);
  });
});
