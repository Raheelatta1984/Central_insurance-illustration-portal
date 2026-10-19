/**
 * The rating grid: a product's price, by age band, gender, occupational rank and sum assured — and the
 * bulk file an actuary uploads it from.
 *
 * These tests are written against the real world (`buildWorld`), because the point of the grid is that
 * it prices what the engines sell: a row filed here is the row a quotation is priced from, with the
 * product's own entry ages as its limits and the local currency as its unit. The behaviours that matter
 * are the ones a spreadsheet gets wrong — a band that stops short of the product's maximum age, two
 * rows that say different things about the same life, an upload that half-applies, a rate typed as a
 * percentage into a money column — so each of those is refused or reported, in words, on purpose.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { buildWorld, World } from './demo.js';
import { parseCsv, RateError, validateRateRow } from './rating.js';
import { applyBps, formatAmount, toDecimalString, money } from './money.js';

function seedWorld(): World {
  return buildWorld();
}

describe('the seeded tariff grid', () => {
  it('prices a standard life at the product’s filed rate, in exact decimal money', () => {
    const w = seedWorld();
    const product = w.erp.productMaster('PROD-UL-GLOBAL');
    const priced = w.erp.rating.price({
      productId: 'PROD-UL-GLOBAL', kind: 'premium', age: 25, gender: 'male',
      occupationClass: 1, sumAssured: '100,000.00',
    });
    expect(priced.priced).toBe(true);
    const row = priced.row!;
    // The row the life landed on is the youngest age band and the lower sum-assured band, and its rate
    // is the product's own filed tariff with the band's shape factors applied — never a float.
    expect(row.ageFrom).toBe(product.rules.minAge);
    expect(row.sumTo).toBe('250000.00');
    expect(minorOf(row.ratePerThousand)).toBe(applyBps(applyBps(money(product.rules.baseRatePerThousandMinor, 'AED'), 5500), 10000).minor);
    // rate per 1,000 × sum assured / 1,000, with the currency scale carried in the divisor.
    expect(priced.amount).toEqual(money((10_000_000n * minorOf(row.ratePerThousand)) / 100_000n, 'AED'));
    expect(priced.amount.currency).toBe('AED');
    expect(priced.basis).toContain('per 1,000');
    expect(priced.basis).toContain('AED');
  });

  it('rates an older life above a younger one and a wider sum-assured band above a narrower one', () => {
    const w = seedWorld();
    const young = w.erp.rating.price({ productId: 'PROD-UL-GLOBAL', kind: 'premium', age: 25, sumAssured: '100,000.00' });
    const older = w.erp.rating.price({ productId: 'PROD-UL-GLOBAL', kind: 'premium', age: 58, sumAssured: '100,000.00' });
    const big = w.erp.rating.price({ productId: 'PROD-UL-GLOBAL', kind: 'premium', age: 25, sumAssured: '400,000.00' });
    expect(older.amount.minor > young.amount.minor).toBe(true);
    expect(big.amount.minor > young.amount.minor).toBe(true);
    // The sum-assured band is half-open: a life at exactly the boundary belongs to the band above, and
    // one penny under it belongs to the band below. A tariff that double-bounded its bands priced the
    // boundary twice and left nobody the wiser.
    const atEdge = w.erp.rating.price({ productId: 'PROD-UL-GLOBAL', kind: 'premium', age: 25, sumAssured: '250,000.00' });
    expect(atEdge.row?.sumFrom).toBe('250000.00');
    expect(atEdge.row?.sumTo).toBeNull();
    const justUnder = w.erp.rating.price({ productId: 'PROD-UL-GLOBAL', kind: 'premium', age: 25, sumAssured: '249,999.99' });
    expect(justUnder.row?.sumTo).toBe('250000.00');
    expect(BigInt(justUnder.row!.ageTo) >= 25n).toBe(true);
    expect(atEdge.amount.minor > justUnder.amount.minor).toBe(true);
  });

  it('files a monthly cost of insurance per 1,000 for unit-linked and takaful, and not for a medical book', () => {
    const w = seedWorld();
    const stats = w.erp.rating.stats();
    expect(stats.mortalityRows).toBeGreaterThan(0);
    const coi = w.erp.rating.price({ productId: 'PROD-UL-GLOBAL', kind: 'mortality', age: 45, gender: 'male', occupationClass: 3, sumAssured: '250,000.00' });
    expect(coi.priced).toBe(true);
    expect(coi.basis).toContain('per month');
    const annual = w.erp.rating.price({ productId: 'PROD-UL-GLOBAL', kind: 'premium', age: 45, gender: 'male', occupationClass: 3, sumAssured: '250,000.00' });
    // A monthly mortality charge that took more than twice the annual premium in a year would empty the
    // fund by the second anniversary: the shape of the table has to stay inside what a policy can pay.
    expect(coi.amount.minor > 0n).toBe(true);
    expect(coi.amount.minor * 12n < annual.amount.minor * 2n).toBe(true);
    expect(w.erp.rating.listFor({ productId: 'PROD-MEDICAL-GRP', kind: 'mortality' }).length).toBe(0);
  });

  it('says which row priced a risk, so a quote can answer a pricing review', () => {
    const w = seedWorld();
    const matched = w.erp.rating.match({ productId: 'PROD-UL-GLOBAL', kind: 'premium', age: 45, gender: 'female', occupationClass: 4, sumAssured: '10,000.00' });
    expect(matched.row).not.toBeNull();
    // A unisex, all-class row won because that is how the premium tariff is filed — and the reasons say so.
    expect(matched.reasons.join(' ')).toContain('unisex');
    expect(matched.reasons.join(' ')).toContain('all-classes');
  });
});

describe('filing and re-filing rows', () => {
  let w: World;
  beforeEach(() => { w = seedWorld(); });

  it('keeps one row per natural key, so re-running the same upload does not double the tariff', () => {
    const input = {
      productId: 'PROD-LIFE-TERM', kind: 'premium', gender: 'unisex', ageFrom: 18, ageTo: 25,
      occupationClass: 0, sumFrom: '0.00', sumTo: null, ratePerThousand: '21.00', by: 'actuary',
    };
    const first = w.erp.rating.upsert(input);
    const before = w.erp.rating.count();
    const again = w.erp.rating.upsert(input);
    expect(first.created).toBe(true);
    expect(again.created).toBe(false);
    expect(again.row.rowId).toBe(first.row.rowId);
    expect(w.erp.rating.count()).toBe(before);
  });

  it('copies a row so a neighbouring band is filed by editing one cell rather than typing twelve', () => {
    const source = w.erp.rating.listFor({ productId: 'PROD-UL-GLOBAL', kind: 'premium' })[0]!;
    const copy = w.erp.rating.duplicate(source.rowId, { ageFrom: 60, ageTo: 65, ratePerThousand: '99.00' } as never, '2026-10-05T09:00:00Z', 'actuary');
    expect(copy.rowId).not.toBe(source.rowId);
    expect(copy.ageFrom).toBe(60);
    expect(copy.ratePerThousand).toBe('99.00');
    expect(copy.productId).toBe(source.productId);
    expect(copy.updatedBy).toBe('actuary');
  });

  it('refuses a row the arithmetic cannot stand behind, with the reason', () => {
    expect(() => w.erp.rating.upsert({ productId: 'PROD-LIFE-TERM', kind: 'premium', ageFrom: 60, ageTo: 18, ratePerThousand: '10.00' }))
      .toThrowError(/inverted/);
    expect(() => w.erp.rating.upsert({ productId: 'PROD-NOT-FILED', kind: 'premium', ageFrom: 18, ageTo: 25, ratePerThousand: '10.00' }))
      .toThrowError(/not filed in the product factory/);
    expect(() => w.erp.rating.upsert({ productId: 'PROD-LIFE-TERM', kind: 'premium', ageFrom: 18, ageTo: 25, sumFrom: '50,000.00', sumTo: '10,000.00', ratePerThousand: '10.00' }))
      .toThrowError(/must end above where it starts/);
  });

  it('reports the hole a deleted band leaves, up to the age the product can still be sold at', () => {
    const product = w.erp.productMaster('PROD-LIFE-TERM');
    const rows = w.erp.rating.listFor({ productId: 'PROD-LIFE-TERM', kind: 'premium' });
    for (const row of rows) if (row.ageFrom > product.rules.minAge) w.erp.rating.remove(row.rowId);
    const gaps = w.erp.rating.ageGaps('PROD-LIFE-TERM', 'premium');
    expect(gaps.length).toBeGreaterThan(0);
    const uncovered = gaps[0]!.gaps;
    expect(uncovered.length).toBeGreaterThan(0);
    expect(uncovered[0]!.from).toBeGreaterThan(product.rules.minAge);
    expect(uncovered.at(-1)!.to).toBe(product.rules.maxAge);
  });

  it('names two base rows that answer the same life twice', () => {
    w.erp.rating.upsert({ productId: 'PROD-LIFE-TERM', kind: 'premium', gender: 'unisex', ageFrom: 18, ageTo: 40, occupationClass: 0, sumFrom: '0.00', sumTo: null, ratePerThousand: '20.00' });
    w.erp.rating.upsert({ productId: 'PROD-LIFE-TERM', kind: 'premium', gender: 'unisex', ageFrom: 35, ageTo: 55, occupationClass: 0, sumFrom: '0.00', sumTo: null, ratePerThousand: '26.00' });
    const clashes = w.erp.rating.overlaps('PROD-LIFE-TERM', 'premium');
    expect(clashes.some((o) => o.why.includes('35–40'))).toBe(true);
  });
});

describe('the bulk upload', () => {
  let w: World;
  beforeEach(() => { w = seedWorld(); });

  it('prints a template that carries this tenant’s own products and can be uploaded back unchanged', () => {
    const csv = w.erp.rating.template(['PROD-UL-GLOBAL', 'PROD-LIFE-TERM']);
    expect(csv).toContain('Product ID');
    expect(csv).toContain('Occupation class');
    expect(csv).toContain('PROD-UL-GLOBAL');
    expect(csv).toContain('mortality');
    const fresh = seedWorld();
    const before = fresh.erp.rating.count();
    const report = fresh.erp.rating.importCsv(csv, { by: 'actuary' });
    expect(report.rejected.length, report.rejected.map((r) => r.reasons.join(' ')).join(' | ')).toBe(0);
    expect(report.applied).toBeGreaterThan(0);
    // The template's rows land on bands the seed already covers, so the file replaces rather than doubles.
    expect(fresh.erp.rating.count()).toBeLessThanOrEqual(before + report.applied);
    expect(report.applied).toBeGreaterThan(report.replaced);   // some rows are new, the rest re-file the seed
  });

  it('applies the clean rows and refuses the dirty ones, line by line', () => {
    const csv = [
      'Product ID,Rate type,Gender,Age from,Age to,Occupation class,Sum assured from,Sum assured to,Channel,Partner,Rate per 1000,Currency,Note',
      'PROD-CI-STANDALONE,premium,unisex,18,30,0,0,, , ,12.00,AED,good row',
      'PROD-CI-STANDALONE,premium,unisex,60,31,0,0,, , ,18.00,AED,inverted ages',
      'PROD-CI-STANDALONE,premium,unisex,31,45,0,0,, , ,"17,50",AED,quoted amount with a separator',
      'PROD-CI-STANDALONE,premium,unisex,46,55,0,0,, , ,-4.00,AED,negative rate',
      'PROD-CI-COMPREHENSIVE,mortality,male,18,40,3,0,,,,2.10,AED,a CI plan priced monthly',
    ].join('\r\n');
    const report = w.erp.rating.importCsv(csv, { by: 'actuary' });
    expect(report.read).toBe(5);
    expect(report.applied).toBe(3);
    expect(report.rejected.map((r) => r.line)).toEqual([3, 5]);
    expect(report.rejected[0]!.reasons.join(' ')).toContain('inverted');
    expect(report.rejected[1]!.reasons.join(' ')).toContain('negative');
    const priced = w.erp.rating.price({ productId: 'PROD-CI-STANDALONE', age: 20, sumAssured: '50,000.00' });
    expect(priced.amount).toEqual(money(60_000n, 'AED'));   // 12.00 per 1,000 on 50,000.00
    expect(priced.row?.note).toBe('good row');
    // A comma in this codebase is a thousands separator, in the sheet and in the API alike: the quoted
    // cell survived its own comma and was filed as 1,750.00 rather than being refused or truncated.
    expect(w.erp.rating.listFor({ productId: 'PROD-CI-STANDALONE' }).some((r) => r.ratePerThousand === '1750.00')).toBe(true);
  });

  it('treats a re-upload of the same file as a re-filing, not as a doubling', () => {
    const csv = [
      'Product ID,Rate type,Gender,Age from,Age to,Occupation class,Sum assured from,Sum assured to,Channel,Partner,Rate per 1000,Currency,Note',
      'PROD-CI-STANDALONE,premium,unisex,18,30,0,0,, , ,12.00,AED,first pass',
    ].join('\r\n');
    const one = w.erp.rating.importCsv(csv);
    const two = w.erp.rating.importCsv(csv);
    expect(one.applied).toBe(1);
    expect(two.replaced).toBe(1);
    expect(w.erp.rating.listFor({ productId: 'PROD-CI-STANDALONE' }).filter((r) => r.ageFrom === 18 && r.ageTo === 30).length).toBe(1);
  });

  it('clears a product’s tariff first when the operator chose replace', () => {
    const before = w.erp.rating.listFor({ productId: 'PROD-UL-GLOBAL' }).length;
    expect(before).toBeGreaterThan(1);
    const csv = [
      'Product ID,Rate type,Gender,Age from,Age to,Occupation class,Sum assured from,Sum assured to,Channel,Partner,Rate per 1000,Currency,Note',
      'PROD-UL-GLOBAL,premium,unisex,18,65,0,0,, , ,30.00,AED,one line covers the whole range',
    ].join('\r\n');
    const report = w.erp.rating.importCsv(csv, { mode: 'replace' });
    expect(report.cleared).toBe(before);
    expect(w.erp.rating.listFor({ productId: 'PROD-UL-GLOBAL', kind: 'premium' }).length).toBe(1);
    // The mortality rows went too: replace means "this file is the tariff", for this product.
    expect(w.erp.rating.listFor({ productId: 'PROD-UL-GLOBAL', kind: 'mortality' }).length).toBe(0);
  });

  it('skips the template’s guidance lines, ignores columns it does not know, and refuses a file with no required column', () => {
    const withComments = `# guidance\r\n# more guidance\r\nProduct ID,Rate type,Age from,Age to,Rate per 1000,Extras\r\nPROD-LIFE-TERM,premium,18,25,11.00,whatever\r\n`;
    const report = w.erp.rating.importCsv(withComments);
    expect(report.read).toBe(1);
    expect(report.applied).toBe(1);
    expect(report.warnings.join(' ')).toContain('Extras');
    expect(report.warnings.join(' ')).toContain('guidance line');
    expect(() => w.erp.rating.importCsv('Product ID,Rate type,Age from\r\nPROD-LIFE-TERM,premium,18\r\n')).toThrowError(/missing required column/i);
    expect(() => w.erp.rating.importCsv('nonsense\r\nnope')).toThrowError();
  });

  it('refuses a file bigger than the limit and says how to finish the job', () => {
    const header = 'Product ID,Rate type,Gender,Age from,Age to,Occupation class,Sum assured from,Sum assured to,Channel,Partner,Rate per 1000,Currency,Note';
    const lines = Array.from({ length: 6 }, (_, i) => `PROD-CI-STANDALONE,premium,unisex,${18 + i},${19 + i},0,0,, , ,12.00,AED,row ${i}`);
    const csv = [header, ...lines].join('\r\n');
    expect(() => w.erp.rating.importCsv(csv, { limit: 4 })).toThrowError(/limit per upload is 4/);
  });

  it('exports what is on file in the shape the importer reads back', () => {
    const csv = w.erp.rating.exportCsv({ productId: 'PROD-UL-GLOBAL' });
    const table = parseCsv(csv);
    expect(table[0]![0]).toBe('Product ID');
    expect(table.length).toBe(w.erp.rating.listFor({ productId: 'PROD-UL-GLOBAL' }).length + 1);
    const fresh = seedWorld();
    const before = fresh.erp.rating.count();
    const report = fresh.erp.rating.importCsv(csv);
    expect(report.rejected.length).toBe(0);
    expect(fresh.erp.rating.count()).toBe(before);
    expect(fresh.erp.rating.listFor({ productId: 'PROD-UL-GLOBAL' }).length).toBe(w.erp.rating.listFor({ productId: 'PROD-UL-GLOBAL' }).length);
  });
});

describe('validating a single row', () => {
  const resolve = (id: string) => (id === 'PROD-LIFE-TERM'
    ? { productId: id, name: 'Level Term', currency: 'AED', minAge: 18, maxAge: 70, category: 'conventional', standardOccupations: [1, 2] }
    : undefined);

  it('accepts an amount written the way a spreadsheet writes it', () => {
    const checked = validateRateRow({ productId: 'PROD-LIFE-TERM', kind: 'Premium Rate', gender: 'F', ageFrom: '18', ageTo: '30', ratePerThousand: '1,234.50' }, resolve);
    expect(checked.ok).toBe(true);
    if (checked.ok) {
      expect(checked.row.gender).toBe('female');
      expect(checked.row.ratePerThousand).toBe('1234.50');
      expect(toDecimalString(money(123_450n, 'AED'))).toBe('1234.50');
    }
  });

  it('refuses an age band outside the ages the product is filed to admit', () => {
    const checked = validateRateRow({ productId: 'PROD-LIFE-TERM', kind: 'premium', ageFrom: '4', ageTo: '17', ratePerThousand: '1.00' }, resolve);
    expect(checked.ok).toBe(false);
    if (!checked.ok) expect(checked.reasons.join(' ')).toContain('outside');
  });

  it('refuses a partner row that never says which channel it sells through', () => {
    const checked = validateRateRow({ productId: 'PROD-LIFE-TERM', kind: 'premium', ageFrom: '18', ageTo: '30', partnerId: 'BROKER-01', ratePerThousand: '10.00' }, resolve);
    expect(checked.ok).toBe(false);
    if (!checked.ok) expect(checked.reasons.join(' ')).toContain('must name the channel');
  });

  it('keeps a rate as decimal money and never as a float', () => {
    // A nil rate across an open band would price every life in it at zero: refused, not rounded away.
    const nil = validateRateRow({ productId: 'PROD-LIFE-TERM', kind: 'premium', ageFrom: '18', ageTo: '30', ratePerThousand: '0.00', sumFrom: '0.00' }, resolve);
    expect(nil.ok).toBe(false);
    if (!nil.ok) expect(nil.reasons.join(' ')).toContain('nil');
    // One tenth of a currency unit is a rate, and it survives the round trip as 0.10 and not as 0.1.
    const good = validateRateRow({ productId: 'PROD-LIFE-TERM', kind: 'premium', ageFrom: '18', ageTo: '30', ratePerThousand: '0.10', sumFrom: '0.00' }, resolve);
    expect(good.ok).toBe(true);
    if (good.ok) expect(formatAmount(money(minorOf(good.row.ratePerThousand), 'AED'))).toBe('0.10 AED');
    if (good.ok) expect(good.row.ratePerThousand).toBe('0.10');
  });
});

/** A decimal amount as minor units, in a two-decimal currency. */
function minorOf(decimal: string): bigint {
  const neg = decimal.startsWith('-');
  const clean = decimal.replace(/^-/, '');
  const [whole = '0', frac = ''] = clean.split('.');
  const value = BigInt(`${whole}${frac.padEnd(2, '0').slice(0, 2)}`);
  return neg ? -value : value;
}

describe('the grid refuses nonsense at the door', () => {
  it('will not price a risk for a product nobody named', () => {
    const w = seedWorld();
    expect(() => w.erp.rating.price({ productId: '  ', age: 40, sumAssured: '1000' })).toThrowError(RateError);
    const unpriced = w.erp.rating.price({ productId: 'PROD-MOTOR-PAYG', kind: 'premium', age: 40, sumAssured: '1,000.00' });
    expect(unpriced.priced).toBe(false);
    expect(unpriced.reasons.join(' ')).toContain('No premium row covers');
    expect(unpriced.amount.minor).toBe(0n);
  });
});

describe('two bands that touch are one tariff, not two answers', () => {
  it('reports no overlap where a capped band meets an open band at the same figure', () => {
    const w = seedWorld();
    // The seeded grid is exactly this shape: 0–250,000.00 and 250,000.00-and-above, same ages, same
    // gender, same class. Matching treats the upper figure as exclusive, so the QA report has to agree —
    // otherwise every product on the shelf shows a five-overlap defect that is not one.
    expect(w.erp.rating.listFor({ productId: 'PROD-UL-GLOBAL', kind: 'premium' }).length).toBe(10);
    expect(w.erp.rating.overlaps('PROD-UL-GLOBAL', 'premium')).toEqual([]);
    expect(w.erp.rating.ageGaps('PROD-UL-GLOBAL', 'premium').every((g) => g.gaps.length === 0)).toBe(true);

    // And a genuine double answer on the same band is still reported, with both rows named.
    const filed = w.erp.rating.upsert({
      productId: 'PROD-UL-GLOBAL', kind: 'premium', gender: 'unisex', ageFrom: 18, ageTo: 26,
      occupationClass: 0, sumFrom: '0.00', sumTo: '500,000.00', ratePerThousand: '30.00', by: 'test',
    });
    expect(filed.row.ratePerThousand).toBe('30.00');
    const found = w.erp.rating.overlaps('PROD-UL-GLOBAL', 'premium');
    expect(found.length).toBe(2);
    expect(found.map((o) => o.b.rowId)).toEqual([filed.row.rowId, filed.row.rowId]);
    for (const overlap of found) expect(overlap.why).toContain('says two things about one life');
  });
});
