/**
 * Rating tables: what a product costs, by age band, gender, occupational rank and sum assured.
 *
 * A product's `baseRatePerThousand` is a single number, and a single number is a tariff nobody can
 * sell from: a 25-year-old office clerk and a 58-year-old crane operator do not pay the same rate per
 * 1,000 of cover, and a bank counter does not quote the same price as an aggregator API. This module
 * holds the grid those differences live in — the same principle the rest of the ERP applies to labels,
 * calendars and products: **the numbers are data, filed with a trail, and the engines read them.**
 *
 * Two kinds of row exist, because they are charged differently and they are reviewed differently:
 *
 *  - `premium`   — the annual gross rate per 1,000 of sum assured, which the underwriting engine's
 *    standard premium comes from;
 *  - `mortality` — the unit-linked cost of insurance per 1,000 of sum assured **per month**, which is
 *    deducted from units and is the figure a policyholder's illustration is actually sensitive to.
 *
 * A row is keyed by the four dimensions the pricing team works in (age band, gender, occupational
 * rank, sum-assured band) plus an optional channel and partner scope, so one product can hold a base
 * tariff and a per-partner variation without a second product being invented for it. The most specific
 * row that matches wins; the fallback chain is written out so a quote can say *which* row priced it.
 *
 * Bulk upload is a first-class path, not an afterthought: `template()` prints the sample file (with
 * this tenant's own product ids, currency, ages and classes already in it), `importCsv()` parses,
 * validates and applies it row by row — rejecting the dirty rows with a reason and keeping the clean
 * ones — so an actuary can price ninety varieties in a spreadsheet instead of ninety forms.
 *
 * Money rule: a rate is a decimal amount per 1,000 of sum assured. It is parsed with `parseAmount`,
 * held to its exact scale and multiplied with `BigInt`; no float ever touches the arithmetic.
 */
import { parseCsv, toCsv } from './csv.js';
import { formatAmount, Money, parseAmount, roundRational, scaleOf } from './money.js';

export class RateError extends Error {}

/** `premium` prices the cover; `mortality` is the unit-linked cost of insurance. */
export type RateKind = 'premium' | 'mortality';
/** Unisex is a real rating decision, not a missing one: it is what most term life tariffs are filed as. */
export type RateGender = 'male' | 'female' | 'unisex';

/** What a rate row has to be filed against: the product's own filed range and currency. */
export interface RateProductRef {
  readonly productId: string;
  readonly name: string;
  readonly currency: string;
  readonly minAge: number;
  readonly maxAge: number;
  readonly category: string;
  /** 1–5; the ranks the product accepts as standard, used only to warn, never to block a filing. */
  readonly standardOccupations: readonly number[];
}

export type RateProductResolver = (productId: string) => RateProductRef | undefined;

export interface RateRow {
  readonly rowId: string;
  readonly productId: string;
  readonly kind: RateKind;
  readonly gender: RateGender;
  /** Inclusive. */
  readonly ageFrom: number;
  /** Inclusive. */
  readonly ageTo: number;
  /** 0 = every occupational rank; 1–5 = that rank only. */
  readonly occupationClass: number;
  /** Decimal amount, inclusive lower bound of the sum-assured band. */
  readonly sumFrom: string;
  /** Decimal amount, exclusive upper bound; `null` means the band is open-ended. */
  readonly sumTo: string | null;
  /** Null = the base tariff, which every channel and partner reads unless it overrides it. */
  readonly channelCode: string | null;
  /** Null = not partner-specific. */
  readonly partnerId: string | null;
  /** Decimal amount per 1,000 of sum assured, per year for `premium` and per month for `mortality`. */
  readonly ratePerThousand: string;
  readonly currency: string;
  readonly note: string;
  readonly updatedAt: string;
  readonly updatedBy: string;
}

export interface RateRowInput {
  productId?: string;
  kind?: string;
  gender?: string;
  ageFrom?: string | number;
  ageTo?: string | number;
  occupationClass?: string | number;
  sumFrom?: string | number;
  sumTo?: string | number | null;
  channelCode?: string | null;
  partnerId?: string | null;
  ratePerThousand?: string | number;
  currency?: string;
  note?: string;
  rowId?: string;
  updatedAt?: string;
  updatedBy?: string;
}

/* ------------------------------------------------------------------ the sheet: columns, template, parsing */

/** The bulk-upload column set: the header the template prints and the importer accepts. */
export interface RateColumn {
  readonly key: keyof RateRow | 'rowId';
  readonly label: string;
  readonly required: boolean;
  readonly hint: string;
  readonly example: string;
  /** Other header spellings a partner's sheet arrives with, accepted as the same column. */
  readonly aliases?: readonly string[];
}

export const RATE_COLUMNS: readonly RateColumn[] = Object.freeze([
  { key: 'productId', label: 'Product ID', required: true, hint: 'must already be filed in the product factory', example: 'PROD-UL-GLOBAL' },
  { key: 'kind', label: 'Rate type', required: true, hint: 'premium = annual rate per 1,000 of sum assured; mortality = unit-linked cost of insurance per 1,000 per month', example: 'premium' },
  { key: 'gender', label: 'Gender', required: false, hint: 'male, female or unisex (blank = unisex)', example: 'unisex' },
  { key: 'ageFrom', label: 'Age from', required: true, hint: 'inclusive entry age', example: '18' },
  { key: 'ageTo', label: 'Age to', required: true, hint: 'inclusive entry age', example: '30' },
  { key: 'occupationClass', label: 'Occupation class', required: false, hint: '0 or blank = every class; 1-5 = that rank only', example: '0' },
  { key: 'sumFrom', label: 'Sum assured from', required: false, hint: 'inclusive, in the product currency (blank = 0)', example: '0' },
  { key: 'sumTo', label: 'Sum assured to', required: false, hint: 'exclusive (blank = no upper limit)', example: '100,000' },
  { key: 'channelCode', label: 'Channel', required: false, hint: 'blank = the base tariff every channel reads', example: '' },
  { key: 'partnerId', label: 'Partner', required: false, hint: 'blank = not partner-specific', example: '' },
  { key: 'ratePerThousand', label: 'Rate per 1000', required: true, hint: 'decimal money amount, per year for premium and per month for mortality', example: '24.50', aliases: ['rate', 'rate per thousand', 'base rate', 'tariff rate', 'premium rate', 'coi', 'charge'] },
  { key: 'currency', label: 'Currency', required: false, hint: 'blank = the product currency', example: 'AED' },
  { key: 'note', label: 'Note', required: false, hint: 'what a reviewer should know about this row', example: 'Level term, standard life' },
]);

/** A row's natural key: two rows with the same key are the same row, so an upload replaces rather than doubles. */
function rateKey(row: Pick<RateRow, 'productId' | 'kind' | 'gender' | 'ageFrom' | 'ageTo' | 'occupationClass' | 'sumFrom' | 'sumTo' | 'channelCode' | 'partnerId'>): string {
  return [
    row.productId, row.kind, row.gender, row.ageFrom, row.ageTo, row.occupationClass,
    row.sumFrom, row.sumTo ?? '∞', row.channelCode ?? '', row.partnerId ?? '',
  ].join('|');
}

export { parseCsv, csvCell, toCsv } from './csv.js';

const slugKey = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, '');

/** A header cell is accepted by its column key or by its printed label, so a renamed sheet still loads. */
/** Which column a header cell means: by key, by the printed label, or by one of its known aliases. */
function columnFor(header: string): RateColumn | undefined {
  const want = slugKey(header);
  if (!want) return undefined;
  return RATE_COLUMNS.find((c) =>
    slugKey(String(c.key)) === want
    || slugKey(c.label) === want
    || (c.aliases ?? []).some((a) => slugKey(a) === want),
  );
}

/* ------------------------------------------------------------------ validation */

export interface RowIssue { readonly line: number; readonly field?: string; readonly message: string }

/** A rejected upload row, with the line it came from and every reason it was refused. */
export interface RejectedRow { readonly line: number; readonly raw: Record<string, string>; readonly reasons: string[] }

const GENDER_WORDS: Readonly<Record<string, RateGender>> = {
  m: 'male', male: 'male', man: 'male', f: 'female', female: 'female', woman: 'female',
  u: 'unisex', unisex: 'unisex', any: 'unisex', '': 'unisex',
};

const KIND_WORDS: Readonly<Record<string, RateKind>> = {
  premium: 'premium', 'premiumrate': 'premium', rate: 'premium', 'basicrate': 'premium', tariff: 'premium', price: 'premium',
  mortality: 'mortality', coi: 'mortality', 'costofinsurance': 'mortality', 'mortalitycharge': 'mortality', 'unitlinked': 'mortality', charges: 'mortality',
};

function occupationOf(value: string): number | null {
  const v = value.trim().toLowerCase().replace(/\bclass\b/g, '').replace(/[^0-9]/g, '');
  if (!v) return 0;
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 && n <= 5 ? Math.trunc(n) : null;
}

/**
 * Turn one spreadsheet row into a filed rate row, or say exactly why it cannot be filed.
 *
 * Every check here is a mistake an actuary has actually made in a tariff file: an inverted age band,
 * a rate typed as "1,234.5" into a percentage column, a product id from last year's workbook, an
 * upper sum-assured bound below its own lower bound, a mortality row on a product that has no units to
 * deduct from. The row is refused with a sentence, never silently corrected.
 */
export function validateRateRow(
  raw: Record<string, string>,
  resolve: RateProductResolver,
  defaults: { currency: string; at: string; by: string } = { currency: 'AED', at: '', by: '' },
): { ok: true; row: Omit<RateRow, 'rowId'> } | { ok: false; reasons: string[] } {
  const reasons: string[] = [];
  const productId = (raw['productId'] ?? '').trim().toUpperCase();
  if (!productId) reasons.push('Product ID is required.');
  const product = productId ? resolve(productId) : undefined;
  if (productId && !product) reasons.push(`${productId} is not filed in the product factory — define the product before its tariff.`);

  const kindWord = slugKey(raw['kind'] ?? 'premium');
  const kind = KIND_WORDS[kindWord];
  if (!kind) reasons.push(`Rate type "${raw['kind'] ?? ''}" is not recognised — use "premium" or "mortality".`);

  const genderWord = (raw['gender'] ?? '').trim().toLowerCase();
  const gender = GENDER_WORDS[genderWord];
  if (!gender) reasons.push(`Gender "${raw['gender'] ?? ''}" is not recognised — use male, female or unisex.`);

  const ageFrom = Number(String(raw['ageFrom'] ?? '').replace(/[^0-9.-]/g, ''));
  const ageTo = Number(String(raw['ageTo'] ?? '').replace(/[^0-9.-]/g, ''));
  if (!Number.isFinite(ageFrom) || !Number.isInteger(ageFrom)) reasons.push('Age from must be a whole number of years.');
  if (!Number.isFinite(ageTo) || !Number.isInteger(ageTo)) reasons.push('Age to must be a whole number of years.');
  if (Number.isInteger(ageFrom) && Number.isInteger(ageTo) && ageFrom > ageTo) {
    reasons.push(`The age band is inverted: ${ageFrom} to ${ageTo} admits nobody.`);
  }
  if (Number.isInteger(ageFrom) && ageFrom < 0) reasons.push('A negative entry age is not a thing an age band can start at.');
  if (Number.isInteger(ageTo) && ageTo > 120) reasons.push('An entry age above 120 is a typo, not a tariff.');
  if (product && Number.isInteger(ageFrom) && Number.isInteger(ageTo)) {
    if (ageTo < product.minAge || ageFrom > product.maxAge) {
      reasons.push(`${ageFrom}–${ageTo} lies outside ${product.productId}'s filed entry range of ${product.minAge}–${product.maxAge}.`);
    }
  }

  const occupationClass = occupationOf(raw['occupationClass'] ?? '');
  if (occupationClass === null) reasons.push(`Occupation class "${raw['occupationClass'] ?? ''}" must be blank (every class) or 1-5.`);

  const currency = (raw['currency'] ?? '').trim().toUpperCase() || product?.currency || defaults.currency;
  let sumFromMinor: bigint = 0n;
  let sumToMinor: bigint | null = null;
  const sumFromText = (raw['sumFrom'] ?? '').trim() || '0';
  const sumToText = (raw['sumTo'] ?? '').trim();
  try {
    sumFromMinor = parseAmount(sumFromText, currency).minor;
    if (sumFromMinor < 0n) reasons.push('Sum assured from cannot be negative.');
  } catch { reasons.push(`Sum assured from "${raw['sumFrom'] ?? ''}" is not an amount in ${currency}.`); }
  if (sumToText) {
    try {
      sumToMinor = parseAmount(sumToText, currency).minor;
      if (sumToMinor <= sumFromMinor) reasons.push('The sum-assured band must end above where it starts (or leave the upper bound blank).');
    } catch { reasons.push(`Sum assured to "${raw['sumTo'] ?? ''}" is not an amount in ${currency}.`); }
  }

  const rateRaw = (raw['ratePerThousand'] ?? '').trim();
  let rateMinor = 0n;
  if (!rateRaw) reasons.push('Rate per 1,000 is required.');
  else {
    try {
      rateMinor = parseAmount(rateRaw, currency).minor;
      if (rateMinor < 0n) reasons.push('A rate per 1,000 cannot be negative — a credit is a different document.');
      if (rateMinor === 0n && sumFromMinor === 0n) reasons.push('A zero rate with no sum-assured floor would price every life of that band at nil.');
    } catch { reasons.push(`Rate per 1,000 "${raw['ratePerThousand'] ?? ''}" is not a decimal amount.`); }
  }

  const channelCode = (raw['channelCode'] ?? '').trim().toUpperCase() || null;
  const partnerId = (raw['partnerId'] ?? '').trim().toUpperCase() || null;
  if (partnerId && !channelCode) reasons.push(`A partner row must name the channel ${partnerId} sells through.`);

  if (reasons.length > 0) return { ok: false, reasons };

  const minAge = Number.isFinite(ageFrom) ? ageFrom : 0;
  const maxAge = Number.isInteger(ageTo) ? ageTo : minAge;
  const note = (raw['note'] ?? '').trim();

  return {
    ok: true,
    row: {
      productId, kind: kind ?? 'premium', gender: gender ?? 'unisex', ageFrom: minAge, ageTo: maxAge,
      occupationClass: occupationClass ?? 0,
      sumFrom: sumFromMinor === 0n ? '0.00' : decimal(sumFromMinor, currency),
      sumTo: sumToMinor === null ? null : decimal(sumToMinor, currency),
      channelCode, partnerId,
      ratePerThousand: decimal(rateMinor, currency),
      currency,
      note,
      updatedAt: defaults.at, updatedBy: defaults.by,
    },
  };
}

/** Minor units back to a plain decimal string, in the currency's own scale. */
function decimal(minor: bigint, currency: string): string {
  const scale = scaleOf(currency);
  const neg = minor < 0n;
  const v = neg ? -minor : minor;
  const unit = 10n ** BigInt(scale);
  const whole = (v / unit).toString();
  const frac = (v % unit).toString();
  return `${neg ? '-' : ''}${whole}${scale > 0 ? `.${frac.padStart(scale, '0')}` : ''}`;
}

function moneyFrom(minor: bigint, currency: string): Money { return { minor, currency }; }

/* ------------------------------------------------------------------ the store */

export interface RateQuery {
  readonly productId: string;
  readonly kind?: RateKind;
  readonly age: number;
  readonly gender?: string;
  readonly occupationClass?: number;
  /** Decimal amount or minor units — the console works in decimals, the engines in minor units. */
  readonly sumAssured?: string;
  readonly sumAssuredMinor?: bigint;
  readonly channelCode?: string | null;
  readonly partnerId?: string | null;
}

export interface RateMatch {
  readonly row: RateRow | null;
  readonly reasons: string[];
}

export interface RatePrice extends RateMatch {
  readonly priced: boolean;
  readonly sumAssured: Money;
  readonly amount: Money;
  readonly basis: string;
}

/** Built up row by row as the file is applied, which is why the counters are not frozen. */
export interface ImportReport {
  read: number;
  applied: number;
  replaced: number;
  cleared: number;
  rejected: RejectedRow[];
  warnings: string[];
  mode: 'append' | 'replace';
  skipped: number;
}

/**
 * The grid, held as rows. The store owns the rows and their validation; it does not own products,
 * channels or partners, which it is handed a resolver for — so a tariff row can never disagree with
 * the product it is filed against without saying so out loud.
 */
export class RateTables {
  private readonly rows = new Map<string, RateRow>();
  private readonly byKey = new Map<string, string>();
  private readonly trail: Array<{ at: string; by: string; action: string; detail: string }> = [];
  private seq = 0;

  constructor(private readonly resolveProduct: RateProductResolver, private readonly defaultCurrency: () => string) {}

  /* ---- reading */

  list(): RateRow[] { return [...this.rows.values()]; }

  count(): number { return this.rows.size; }

  audit(limit = 8) { return this.trail.slice(-limit).reverse(); }

  listFor(filter: { productId?: string; kind?: RateKind; channelCode?: string | null; partnerId?: string | null } = {}): RateRow[] {
    return this.list().filter((r) =>
      (filter.productId === undefined || r.productId === filter.productId)
      && (filter.kind === undefined || r.kind === filter.kind)
      && (filter.channelCode === undefined || r.channelCode === filter.channelCode)
      && (filter.partnerId === undefined || r.partnerId === filter.partnerId),
    );
  }

  stats() {
    const rows = this.list();
    const products = new Set(rows.map((r) => r.productId));
    return {
      rows: rows.length,
      productsCovered: products.size,
      premiumRows: rows.filter((r) => r.kind === 'premium').length,
      mortalityRows: rows.filter((r) => r.kind === 'mortality').length,
      channelRows: rows.filter((r) => r.channelCode !== null).length,
      partnerRows: rows.filter((r) => r.partnerId !== null).length,
      byProduct: [...products].sort().map((productId) => {
        const own = rows.filter((r) => r.productId === productId);
        return {
          productId,
          rows: own.length,
          premium: own.filter((r) => r.kind === 'premium').length,
          mortality: own.filter((r) => r.kind === 'mortality').length,
          genders: [...new Set(own.map((r) => r.gender))].sort(),
          classes: [...new Set(own.map((r) => r.occupationClass))].sort((a, b) => a - b),
          ages: own.length > 0 ? `${Math.min(...own.map((r) => r.ageFrom))}–${Math.max(...own.map((r) => r.ageTo))}` : '—',
        };
      }),
    };
  }

  /* ---- writing */

  private record(action: string, detail: string, at: string, by: string): void {
    this.trail.push({ at, by, action, detail });
    if (this.trail.length > 200) this.trail.splice(0, this.trail.length - 200);
  }

  /**
   * File a row. The natural key decides whether this is a new row or the new version of the row that
   * was there, which is what makes a re-run of the same upload a no-op rather than a double count.
   */
  upsert(input: RateRowInput & { at?: string; by?: string }): { row: RateRow; created: boolean } {
    const raw: Record<string, string> = {};
    for (const [k, v] of Object.entries(input)) raw[k] = v === null || v === undefined ? '' : String(v);
    const checked = validateRateRow(raw, this.resolveProduct, {
      currency: this.defaultCurrency(),
      at: input.at ?? '', by: input.by ?? 'master-settings',
    });
    if (!checked.ok) throw new RateError(checked.reasons.join(' '));
    const key = rateKey(checked.row);
    const existingId = this.byKey.get(key);
    const rowId = input.rowId ?? existingId ?? `RATE-${String(++this.seq).padStart(6, '0')}`;
    if (!existingId && this.rows.has(rowId)) throw new RateError(`rate row ${rowId} already holds a different key`);
    const row: RateRow = { ...checked.row, rowId };
    if (existingId && existingId !== rowId) { this.rows.delete(existingId); this.byKey.delete(key); }
    this.rows.set(rowId, row);
    this.byKey.set(key, rowId);
    this.record(existingId ? 'rate-updated' : 'rate-filed', `${row.productId} ${row.kind} ${row.gender} ${row.ageFrom}-${row.ageTo} cl${row.occupationClass} @ ${row.ratePerThousand}/${row.currency}`, row.updatedAt, row.updatedBy);
    return { row, created: !existingId };
  }

  /**
   * File many rows at once. One dirty row must not lose the ninety-nine good ones — a bulk operation
   * is applied row by row and reports what it refused, which is also what makes it safe to re-run.
   */
  upsertMany(inputs: RateRowInput[], options: { at?: string; by?: string } = {}): { saved: RateRow[]; rejected: Array<{ index: number; reasons: string[] }> } {
    const saved: RateRow[] = [];
    const rejected: Array<{ index: number; reasons: string[] }> = [];
    inputs.forEach((input, index) => {
      const raw: Record<string, string> = {};
      for (const [k, v] of Object.entries(input)) raw[k] = v === null || v === undefined ? '' : String(v);
      const checked = validateRateRow(raw, this.resolveProduct, {
        currency: this.defaultCurrency(), at: options.at ?? '', by: options.by ?? 'master-settings',
      });
      if (!checked.ok) { rejected.push({ index, reasons: checked.reasons }); return; }
      const key = rateKey(checked.row);
      const rowId = input.rowId ?? this.byKey.get(key) ?? `RATE-${String(++this.seq).padStart(6, '0')}`;
      const row: RateRow = { ...checked.row, rowId, updatedAt: options.at ?? '', updatedBy: options.by ?? 'master-settings' };
      this.rows.set(rowId, row);
      this.byKey.set(key, rowId);
      saved.push(row);
    });
    this.record('rate-bulk', `${saved.length} row(s) filed${rejected.length > 0 ? `, ${rejected.length} refused` : ''}`, options.at ?? '', options.by ?? 'master-settings');
    return { saved, rejected };
  }

  /** Copy a row: the way a new band is filed in practice is by taking the one beside it and changing a cell. */
  duplicate(rowId: string, patch: RateRowInput = {}, at = '', by = 'master-settings'): RateRow {
    const source = this.rows.get(rowId);
    if (!source) throw new RateError(`no rate row ${rowId} to copy`);
    const { rowId: _dropped, ...carried } = source;
    const merged: RateRowInput & { at?: string; by?: string } = { ...carried, ...patch, at, by };
    delete (merged as Record<string, unknown>)['rowId'];
    return this.upsert(merged).row;
  }

  remove(rowId: string, at = '', by = 'master-settings'): void {
    const row = this.rows.get(rowId);
    if (!row) throw new RateError(`no rate row ${rowId} to remove`);
    this.rows.delete(rowId);
    this.byKey.delete(rateKey(row));
    this.record('rate-removed', `${row.productId} ${row.kind} ${row.ageFrom}-${row.ageTo}`, at, by);
  }

  /** Drop every row of a product (the "replace the tariff" half of a bulk upload). */
  clearFor(productId: string, at = '', by = 'master-settings'): number {
    const doomed = this.listFor({ productId });
    for (const row of doomed) { this.rows.delete(row.rowId); this.byKey.delete(rateKey(row)); }
    if (doomed.length > 0) this.record('rate-cleared', `${doomed.length} row(s) for ${productId}`, at, by);
    return doomed.length;
  }

  /* ---- the bulk file */

  /**
   * The sample template an actuary downloads before they price anything: the real headers, the real
   * product ids and currency of this tenant, worked examples of each row kind, and the rules written
   * where they will be read — in the file itself.
   */
  template(productIds: readonly string[] = [], options: { rows?: number } = {}): string {
    const currency = this.defaultCurrency();
    const sampleProducts = productIds.length > 0 ? productIds : (this.firstProductIds(4));
    const perProduct = Math.max(1, options.rows ?? 4);
    const body: string[][] = [];
    for (const productId of sampleProducts.slice(0, 8)) {
      const product = this.resolveProduct(productId);
      const minAge = product?.minAge ?? 18;
      const maxAge = product?.maxAge ?? 65;
      const span = Math.max(1, maxAge - minAge);
      const band = (i: number) => {
        const from = minAge + Math.floor((span * i) / perProduct);
        const to = i === perProduct - 1 ? maxAge : minAge + Math.floor((span * (i + 1)) / perProduct) - 1;
        return { from, to };
      };
      for (let i = 0; i < perProduct; i++) {
        const { from, to } = band(i);
        body.push([
          productId, 'premium', i % 2 === 0 ? 'unisex' : 'unisex', String(from), String(to), '0', '0', '250,000',
          '', '', (20 + i * 6.5).toFixed(2), currency, `Age band ${from}-${to}, every occupation class, up to 250,000`,
        ]);
        if (product && (product.category === 'unit-linked' || product.category === 'takaful')) {
          for (const cls of [1, 3, 5]) {
            body.push([
              productId, 'mortality', cls === 1 ? 'male' : cls === 3 ? 'female' : 'unisex', String(from), String(to), String(cls),
              '0', '', '', '', (0.55 + i * 0.4 + cls * 0.22).toFixed(2), currency,
              `Cost of insurance per month, occupation class ${cls}`,
            ]);
          }
        }
      }
      body.push([
        productId, 'premium', 'unisex', String(minAge), String(maxAge), '0', '250,000', '',
        'BROKER', '', '18.00', currency, 'Channel override: a broker tariff, filed against the same bands',
      ]);
    }
    const header = RATE_COLUMNS.map((c) => c.label);
    const notes = [
      `# Rate sample template — ${sampleProducts.length} product(s), amounts in ${currency}.`,
      '# Fill the rows in, keep the headers, delete these # lines if you like — the importer skips them.',
      '# Age from / Age to are inclusive entry ages. Sum assured to is exclusive; leave it blank for "and above".',
      '# Occupation class: blank or 0 = every class; 1-5 = that rank only (1 professional … 5 underground/offshore).',
      '# Gender: male, female or unisex. A male or female row beats a unisex row when both match.',
      '# Rate type: "premium" is the annual rate per 1,000 of sum assured; "mortality" is the unit-linked',
      '#   cost of insurance per 1,000 of sum assured per month, and it is what an illustration is sensitive to.',
      '# Channel / Partner: leave blank for the base tariff. A partner row must name its channel.',
      '# Two rows with the same product, type, gender, ages, class, sum band, channel and partner are the same',
      '#   row: the upload replaces it rather than adding a second one, so re-running a file is safe.',
    ];
    return `${notes.join('\r\n')}\r\n${toCsv(header, body)}`;
  }

  private firstProductIds(n: number): string[] {
    const seen: string[] = [];
    for (const row of this.rows.values()) if (!seen.includes(row.productId)) seen.push(row.productId);
    return seen.slice(0, n);
  }

  /**
   * Read an uploaded tariff file. Returns what was applied and what was refused, line by line; it never
   * half-applies a rejected row, and it never refuses the whole file because one row had a typo.
   */
  importCsv(text: string, options: { mode?: 'append' | 'replace'; at?: string; by?: string; limit?: number } = {}): ImportReport {
    const lines = parseCsv(text).filter((l) => l.some((c) => c.length > 0));
    const comment = lines.filter((l) => (l[0] ?? '').startsWith('#'));
    const data = lines.filter((l) => !(l[0] ?? '').startsWith('#'));
    if (data.length < 2) throw new RateError('The file has no data rows under its header.');
    const header = data[0]!;
    const mapping = header.map((h, i) => ({ i, col: columnFor(h) })).filter((m) => m.col !== undefined) as Array<{ i: number; col: RateColumn }>;
    const unknown = header.filter((h, i) => !mapping.some((m) => m.i === i) && h.trim().length > 0).map((h) => h.trim());
    if (mapping.length === 0) throw new RateError(`No column in the header was recognised (${header.slice(0, 4).join(', ')}…). Use the downloaded template.`);
    const missing = RATE_COLUMNS.filter((c) => c.required && !mapping.some((m) => m.col.key === c.key)).map((c) => c.label);
    if (missing.length > 0) throw new RateError(`The file is missing required column(s): ${missing.join(', ')}.`);

    const limit = options.limit ?? 5000;
    const records = data.slice(1, limit + 1).map((line) => {
      const raw: Record<string, string> = {};
      for (const m of mapping) raw[String(m.col.key)] = line[m.i] ?? '';
      return raw;
    });
    if (data.length - 1 > limit) {
      throw new RateError(`This file has ${data.length - 1} rows and the limit per upload is ${limit}. Split it by product line and upload again — rows already applied stay applied.`);
    }

    const report: ImportReport = {
      read: records.length, applied: 0, replaced: 0, cleared: 0, rejected: [],
      warnings: comment.length > 0 ? [`${comment.length} # guidance line(s) were skipped, as the template says they would be.`] : [],
      mode: options.mode ?? 'append', skipped: data.length - 1 - records.length,
    };
    if (unknown.length > 0) report.warnings.push(`Ignored unrecognised column(s): ${unknown.join(', ')}.`);

    const touchedProducts = new Set(records.map((r) => (r['productId'] ?? '').trim().toUpperCase()));
    if (report.mode === 'replace') {
      for (const productId of touchedProducts) if (productId) report.cleared += this.clearFor(productId, options.at ?? '', options.by ?? 'bulk-upload');
    }

    records.forEach((raw, i) => {
      const line = i + 2 + comment.length;
      const checked = validateRateRow(raw, this.resolveProduct, {
        currency: this.defaultCurrency(), at: options.at ?? '', by: options.by ?? 'bulk-upload',
      });
      if (!checked.ok) {
        report.rejected.push({ line, raw, reasons: checked.reasons });
        return;
      }
      const key = rateKey(checked.row);
      const existing = this.byKey.get(key);
      const rowId = existing ?? `RATE-${String(++this.seq).padStart(6, '0')}`;
      const row: RateRow = { ...checked.row, rowId };
      this.rows.set(rowId, row);
      this.byKey.set(key, rowId);
      report.applied += 1;
      if (existing) report.replaced += 1;
    });
    this.record('rate-import', `${report.applied} row(s) applied, ${report.rejected.length} refused (${report.mode})`, options.at ?? '', options.by ?? 'bulk-upload');
    return report;
  }

  /** The same rows in the same shape, for "download what is on file" — round-trips through `importCsv`. */
  exportCsv(filter: { productId?: string } = {}): string {
    const rows = this.listFor(filter).sort((a, b) => rateKey(a).localeCompare(rateKey(b)));
    const header = RATE_COLUMNS.map((c) => c.label);
    const body = rows.map((r) => [
      r.productId, r.kind, r.gender, String(r.ageFrom), String(r.ageTo), String(r.occupationClass),
      r.sumFrom, r.sumTo ?? '', r.channelCode ?? '', r.partnerId ?? '', r.ratePerThousand, r.currency, r.note,
    ]);
    return toCsv(header, body);
  }

  /* ---- matching and pricing */

  /**
   * The most specific row that covers this life. Fallback order is explicit and reported, because
   * "which row priced it" is the first thing a pricing review asks.
   */
  match(query: RateQuery): RateMatch {
    const productId = (query.productId ?? '').trim().toUpperCase();
    if (!productId) throw new RateError('a product id is required to price a risk');
    const kind = query.kind ?? 'premium';
    const gender = GENDER_WORDS[slugKey(query.gender ?? 'unisex')] ?? 'unisex';
    const occupationClass = query.occupationClass ?? 0;
    const currency = this.resolveProduct(productId)?.currency ?? this.defaultCurrency();
    const sumMinor = query.sumAssuredMinor !== undefined
      ? query.sumAssuredMinor
      : query.sumAssured !== undefined && query.sumAssured !== '' ? parseAmount(query.sumAssured, currency).minor : 0n;
    const channel = (query.channelCode ?? '') ? String(query.channelCode).trim().toUpperCase() : null;
    const partner = (query.partnerId ?? '') ? String(query.partnerId).trim().toUpperCase() : null;

    const reasons: string[] = [];
    const candidates = this.listFor({ productId, kind }).filter((r) => {
      if (query.age < r.ageFrom || query.age > r.ageTo) return false;
      if (r.gender !== 'unisex' && r.gender !== gender) return false;
      if (r.occupationClass !== 0 && r.occupationClass !== occupationClass) return false;
      if (sumMinor < parseAmount(r.sumFrom, r.currency).minor) return false;
      if (r.sumTo !== null && sumMinor >= parseAmount(r.sumTo, r.currency).minor) return false;
      if (r.partnerId !== null && r.partnerId !== partner) return false;
      if (r.channelCode !== null && r.channelCode !== channel && (partner === null || r.partnerId !== null)) return false;
      return true;
    });

    if (candidates.length === 0) {
      reasons.push(`No ${kind} row covers age ${query.age}, ${gender}, class ${occupationClass || 'any'}, sum assured ${formatAmount(moneyFrom(sumMinor, currency))} for ${productId}.`);
      const scope = channel ? ` on ${channel}` : '';
      reasons.push(`File one (or download the template and bulk-upload it) — the tariff${scope} has ${this.listFor({ productId, kind }).length} row(s) on file.`);
      return { row: null, reasons };
    }
    const scored = candidates.map((r) => {
      let score = 0;
      const why: string[] = [];
      if (r.partnerId !== null) { score += 8; why.push(`partner ${r.partnerId}`); }
      if (r.channelCode !== null) { score += 4; why.push(`channel ${r.channelCode}`); }
      if (r.gender !== 'unisex') { score += 2; why.push(`${r.gender} row`); }
      if (r.occupationClass !== 0) { score += 1; why.push(`occupation class ${r.occupationClass}`); }
      const ageSpan = r.ageTo - r.ageFrom;
      const sumSpan = r.sumTo === null ? Number.MAX_SAFE_INTEGER : Number(parseAmount(r.sumTo, r.currency).minor - parseAmount(r.sumFrom, r.currency).minor);
      return { row: r, score, why, ageSpan, sumSpan };
    }).sort((a, b) => b.score - a.score || a.ageSpan - b.ageSpan || a.sumSpan - b.sumSpan || a.row.rowId.localeCompare(b.row.rowId));

    const best = scored[0]!;
    if (best.row.partnerId === null) reasons.push('no partner row on this product, so the channel or base tariff priced it');
    if (best.row.channelCode === null) reasons.push('no channel override, so the base tariff priced it');
    if (best.row.gender === 'unisex') reasons.push('a unisex row: this tariff does not rate by gender');
    if (best.row.occupationClass === 0) reasons.push('an all-classes row: this tariff does not rate by occupation');
    if (best.row.sumTo === null) reasons.push('the open-ended sum-assured band priced it');
    if (scored.length > 1) reasons.push(`${scored.length - 1} more general row(s) also covered it and lost on specificity`);
    return { row: best.row, reasons: [...(best.why.length > 0 ? [`priced from ${best.why.join(' + ')}`] : []), ...reasons] };
  }

  /**
   * Price a risk from the table. The premium is `sum assured / 1,000 × rate`, exactly as the
   * underwriting engine's standard premium is built, with the currency scale carried in the divisor so
   * a 2-dp money rate never turns into a whole-currency multiply.
   */
  price(query: RateQuery): RatePrice {
    const productId = (query.productId ?? '').trim().toUpperCase();
    const kind = query.kind ?? 'premium';
    const currency = this.resolveProduct(productId)?.currency ?? this.defaultCurrency();
    const sumMinor = query.sumAssuredMinor !== undefined
      ? query.sumAssuredMinor
      : query.sumAssured !== undefined && query.sumAssured !== '' ? parseAmount(query.sumAssured, currency).minor : 0n;
    const matched = this.match({ ...query, kind });
    if (!matched.row) {
      return {
        row: null, reasons: matched.reasons, priced: false,
        sumAssured: moneyFrom(sumMinor, currency), amount: moneyFrom(0n, currency),
        basis: 'unpriced — no rate row covers this risk',
      };
    }
    const row = matched.row;
    const rateMinor = parseAmount(row.ratePerThousand, row.currency).minor;
    const divisor = 1000n * 10n ** BigInt(scaleOf(row.currency));
    const minor = roundRational(sumMinor * rateMinor, divisor);
    const per = row.kind === 'mortality' ? 'per month' : 'per year';
    return {
      row, reasons: matched.reasons, priced: true,
      sumAssured: moneyFrom(sumMinor, row.currency),
      amount: moneyFrom(minor, row.currency),
      basis: `${row.ratePerThousand} per 1,000 of ${formatAmount(moneyFrom(sumMinor, row.currency))}, ${per}, from ${row.rowId} (${row.productId} · ${row.kind} · ${row.gender} · ages ${row.ageFrom}-${row.ageTo}${row.occupationClass !== 0 ? ` · class ${row.occupationClass}` : ''}${row.channelCode ? ` · ${row.channelCode}` : ''}${row.partnerId ? ` · ${row.partnerId}` : ''})`,
    };
  }

  /**
   * Where a tariff has holes. A band that stops at 59 when the product sells to 65 is not a missing
   * row, it is a customer who cannot be quoted — so the grid reports the uncovered ages per
   * gender-and-class group that the tariff already covers.
   */
  ageGaps(productId: string, kind: RateKind = 'premium'): Array<{ gender: RateGender; occupationClass: number; gaps: Array<{ from: number; to: number }> }> {
    const product = this.resolveProduct(productId);
    if (!product) return [];
    const groups = new Map<string, RateRow[]>();
    for (const row of this.listFor({ productId, kind })) {
      if (row.channelCode !== null || row.partnerId !== null) continue;   // overrides are not the base tariff
      const key = `${row.gender}|${row.occupationClass}`;
      groups.set(key, [...(groups.get(key) ?? []), row]);
    }
    const out: Array<{ gender: RateGender; occupationClass: number; gaps: Array<{ from: number; to: number }> }> = [];
    for (const [key, rows] of groups) {
      const [gender, cls] = key.split('|') as [RateGender, string];
      const occupationClass = Number(cls);
      const sorted = [...rows].sort((a, b) => a.ageFrom - b.ageFrom);
      const gaps: Array<{ from: number; to: number }> = [];
      let cursor = product.minAge;
      for (const row of sorted) {
        if (row.ageFrom > cursor) gaps.push({ from: cursor, to: row.ageFrom - 1 });
        cursor = Math.max(cursor, row.ageTo + 1);
      }
      if (cursor <= product.maxAge) gaps.push({ from: cursor, to: product.maxAge });
      out.push({ gender, occupationClass, gaps });
    }
    return out.sort((a, b) => a.gender.localeCompare(b.gender) || a.occupationClass - b.occupationClass);
  }

  /** Overlapping base rows for the same scope: the mistake a spreadsheet makes at row 400. */
  overlaps(productId: string, kind: RateKind = 'premium'): Array<{ a: RateRow; b: RateRow; why: string }> {
    const rows = this.listFor({ productId, kind }).filter((r) => r.channelCode === null && r.partnerId === null);
    const found: Array<{ a: RateRow; b: RateRow; why: string }> = [];
    const lower = (r: RateRow) => parseAmount(r.sumFrom, r.currency).minor;
    const upper = (r: RateRow) => (r.sumTo === null ? null : parseAmount(r.sumTo, r.currency).minor);
    for (let i = 0; i < rows.length; i++) {
      for (let j = i + 1; j < rows.length; j++) {
        const a = rows[i]!, b = rows[j]!;
        // A unisex row beside a gendered row is a deliberate override, and an all-class row beside a
        // class row is the same shape of decision: only same-dimension pairs are genuinely two answers.
        const genderClash = a.gender === b.gender;
        const classClash = a.occupationClass === b.occupationClass;
        const ageOverlap = Math.max(a.ageFrom, b.ageFrom) <= Math.min(a.ageTo, b.ageTo);
        // Sum bands are half-open, and an open band runs to infinity and not backwards: two bands that
        // merely touch at 250,000.00 are one tariff, not two answers about one life.
        const aTo = upper(a), bTo = upper(b);
        const sumOverlap = (bTo === null || lower(a) < bTo) && (aTo === null || lower(b) < aTo);
        if (genderClash && classClash && ageOverlap && sumOverlap) {
          found.push({
            a, b,
            why: `${a.rowId} and ${b.rowId} both cover ${a.gender} ages ${Math.max(a.ageFrom, b.ageFrom)}–${Math.min(a.ageTo, b.ageTo)} at ${a.occupationClass === 0 ? 'every occupation class' : `class ${a.occupationClass}`} — the pair says two things about one life.`,
          });
        }
      }
    }
    return found;
  }
}
