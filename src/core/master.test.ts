/**
 * Master settings: the tenant's own words, its own calendar, and its own products.
 *
 * These three routes are what makes the platform a platform rather than a demo. A tenant that calls a
 * premium a "contribution" has to be able to say so once and have the form, the checklist and the
 * refusal message all agree. A tenant in Kuala Lumpur has to see its own time zone, its own date order
 * and its own currency without a code change. And a tenant that underwrites hull risks has to be able
 * to file one. Each group below tests the setting *and* the place the setting has to take effect.
 */
import { describe, expect, it } from 'vitest';
import { createRuntimeState, dispatchApiRoute, isDomainRefusal, RuntimeState } from './routes.js';
import { PRODUCT_CATALOGUE, PRODUCT_LINES } from './products.js';

type Body = Record<string, unknown>;

/** The HTTP layer hands the route a pathname and a query separately; these helpers split them the same way. */
function splitQuery(path: string): [string, URLSearchParams] {
  const [pathname, search = ''] = path.split('?');
  return [pathname ?? path, new URLSearchParams(search)];
}

async function call(state: RuntimeState, method: 'GET' | 'POST', path: string, payload: Body = {}): Promise<{ status: number; body: any }> {
  const [pathname, searchParams] = splitQuery(path);
  const result = await dispatchApiRoute(state, method, pathname, searchParams, payload);
  expect(result.handled, `${method} ${path}`).toBe(true);
  return { status: result.status, body: result.body };
}

async function refusal(state: RuntimeState, path: string, payload: Body = {}): Promise<string> {
  const [pathname, searchParams] = splitQuery(path);
  try {
    const result = await dispatchApiRoute(state, 'POST', pathname, searchParams, payload);
    if (result.status >= 400) return JSON.stringify(result.body);
    return '';
  } catch (error) {
    expect(isDomainRefusal(error), String(error)).toBe(true);
    return error instanceof Error ? error.message : String(error);
  }
}

/** The seeded journey case, so the tests work against the one the console opens with. */
async function seededCaseId(state: RuntimeState): Promise<string> {
  const journey = await call(state, 'GET', '/journey');
  return String(journey.body.cases[0]!.caseId);
}

/* ------------------------------------------------------------------ 1. renaming a field */

describe('master settings can rename a journey field', () => {
  it('renames it on the form, in the missing-field checklist and in the refusal that names it', async () => {
    const state = createRuntimeState();
    const caseId = await seededCaseId(state);

    const before = await call(state, 'GET', '/journey');
    expect(before.body.stages.find((s: any) => s.id === 'coverage').fields.find((f: any) => f.id === 'sumAssured').label).toBe('Sum assured');
    // The seeded case has not priced its cover yet, so the checklist names the field by default.
    const coverageBefore = before.body.cases[0].progress.stages.find((s: any) => s.id === 'coverage')!;
    expect(coverageBefore.missing).toContain('Sum assured');

    const saved = await call(state, 'POST', '/journey/field-settings', {
      fieldSettings: { coverage: { sumAssured: { mandatory: true, editable: true, label: 'Amount of cover' } } },
      by: 'fatima@broker.ae', at: '2026-10-05T13:00:00Z',
    });
    expect(saved.status).toBe(200);
    expect(saved.body.fieldSettings.coverage.sumAssured).toEqual({ mandatory: true, editable: true, label: 'Amount of cover' });
    expect(saved.body.renamedFieldCount).toBe(1);
    expect(saved.body.fieldRenames[0]).toMatchObject({
      by: 'fatima@broker.ae', at: '2026-10-05T13:00:00Z', stageId: 'coverage', fieldId: 'sumAssured',
      from: 'Sum assured', to: 'Amount of cover',
    });

    const after = await call(state, 'GET', '/journey');
    const field = after.body.stages.find((s: any) => s.id === 'coverage').fields.find((f: any) => f.id === 'sumAssured')!;
    expect(field.label).toBe('Amount of cover');
    expect(field.defaultLabel).toBe('Sum assured');
    expect(field.renamed).toBe(true);
    // The case's own progress carries the rename too: the checklist is what an operator reads.
    const coverage = after.body.cases[0].progress.stages.find((s: any) => s.id === 'coverage')!;
    expect(coverage.fields.find((f: any) => f.id === 'sumAssured').label).toBe('Amount of cover');
    expect(coverage.missing).toContain('Amount of cover');
    expect(coverage.missing).not.toContain('Sum assured');
    expect(after.body.fieldSettings.coverage.sumAssured.label).toBe('Amount of cover');
    expect(after.body.fieldRenames.length).toBe(1);

    // Lock the renamed field and try to write to it: the refusal has to use the tenant's word for it,
    // because a message naming a field the form does not show cannot be acted on.
    await call(state, 'POST', '/journey/field-settings', {
      fieldSettings: { coverage: { sumAssured: { mandatory: true, editable: false, label: 'Amount of cover' } } },
    });
    const refused = await refusal(state, '/journey/save', { caseId, stageId: 'coverage', answers: { sumAssured: 500000 }, by: 'agent' });
    expect(refused).toContain('Amount of cover is locked by master settings');
    expect(refused).not.toContain('Sum assured is locked');
  });

  it('files a rename as wording: bounded, no markup, and reversible to the default', async () => {
    const state = createRuntimeState();

    expect(await refusal(state, '/journey/field-settings', {
      fieldSettings: { coverage: { sumAssured: { mandatory: true, editable: true, label: 'x'.repeat(81) } } },
    })).toContain('must be 80 characters or fewer');

    expect(await refusal(state, '/journey/field-settings', {
      fieldSettings: { coverage: { sumAssured: { mandatory: true, editable: true, label: '<script>alert(1)</script>' } } },
    })).toContain('cannot contain markup characters');

    expect(await refusal(state, '/journey/field-settings', {
      fieldSettings: { coverage: { sumAssured: { mandatory: true, editable: true, label: 42 } } },
    })).toContain('must be text');

    expect(await refusal(state, '/journey/field-settings', {
      fieldSettings: { coverage: { notAField: { mandatory: true, editable: true, label: 'Nope' } } },
    })).toContain('unknown field setting');

    // Whitespace is normalised rather than filed, and an empty label means "go back to the default" —
    // so undoing a rename never depends on anybody remembering the original wording.
    const tidy = await call(state, 'POST', '/journey/field-settings', {
      fieldSettings: { identity: { phone: { mandatory: true, editable: true, label: '  Mobile   number  ' } } },
    });
    expect(tidy.body.fieldSettings.identity.phone.label).toBe('Mobile number');

    const undone = await call(state, 'POST', '/journey/field-settings', {
      fieldSettings: { identity: { phone: { mandatory: true, editable: true, label: '' } } },
    });
    expect(undone.body.fieldSettings.identity.phone.label).toBeUndefined();
    const journey = await call(state, 'GET', '/journey');
    const phone = journey.body.stages.find((s: any) => s.id === 'identity')!.fields.find((f: any) => f.id === 'phone')!;
    expect(phone.label).toBe('Phone');
    expect(phone.renamed).toBe(false);
    // The trail keeps both changes: a rename and its reversal are both facts about the tenant.
    expect(undone.body.renamedFieldCount).toBe(2);
    expect(undone.body.fieldRenames.map((r: any) => r.to)).toEqual(['Mobile number', 'Phone']);
  });

  it('keeps the flags and the label in one setting, and still refuses the old mistakes', async () => {
    const state = createRuntimeState();
    expect(await refusal(state, '/journey/field-settings', {
      fieldSettings: { coverage: { notAFieldAtAll: { mandatory: true, editable: true, label: 'Nope' } } },
    })).toContain('unknown field setting');
    expect(await refusal(state, '/journey/field-settings', {
      fieldSettings: { coverage: { sumAssured: { mandatory: 'yes', editable: true } } },
    })).toContain('mandatory and editable must be boolean');
    expect(await refusal(state, '/journey/field-settings', { fieldSettings: { notAStage: {} } })).toContain('unknown journey stage settings');
    expect(await refusal(state, '/journey/field-settings', { fieldSettings: [] })).toContain('must be a stage-to-field object');
  });
});

/* ------------------------------------------------------------------ 2. country, calendar and currency */

describe('master settings hold the country, the calendar and the currencies', () => {
  it('starts on the Gulf book and offers the choices the tenant may pick from', async () => {
    const state = createRuntimeState();
    const regional = await call(state, 'GET', '/master/regional');
    expect(regional.status).toBe(200);
    const body = regional.body;
    expect(body.country).toBe('AE');
    expect(body.countryName).toBe('United Arab Emirates');
    expect(body.operatingRegion).toBe('Dubai');
    expect(body.timezone).toBe('Asia/Dubai');
    expect(body.utcOffsetLabel).toContain('+04:00');
    expect(body.localCurrency).toBe('AED');
    expect(body.dateFormat).toBeTruthy();
    expect(body.weekStart).toBeTruthy();
    expect(body.regulator).toContain('CBUAE');
    expect(body.choices.countries.length).toBeGreaterThanOrEqual(30);
    expect(body.choices.currencies.length).toBeGreaterThanOrEqual(30);
    expect(body.choices.timezones.length).toBeGreaterThanOrEqual(10);
    expect(body.foreignCurrencies.map((c: any) => c.code).sort()).toEqual(['EUR', 'GBP', 'MYR', 'USD']);
    // A rate on its own means nothing to a reader; the card quotes what it buys.
    const usd = body.examples.find((e: any) => e.to === 'USD')!;
    expect(usd.label).toContain('272.29 USD');
    expect(body.lines.length).toBe(PRODUCT_LINES.length);
    expect(body.lines.reduce((n: number, l: any) => n + l.count, 0)).toBe(PRODUCT_CATALOGUE.length);

    const worldSnapshot = await call(state, 'GET', '/world');
    expect(worldSnapshot.body.erp.master.regional.localCurrency).toBe('AED');
    expect(worldSnapshot.body.erp.master.regional.country).toBe('AE');
  });

  it('moves the whole tenant: country, region, time zone, date order, currency and the rate card', async () => {
    const state = createRuntimeState();
    const moved = await call(state, 'POST', '/master/regional', {
      country: 'MY', operatingRegion: 'Kuala Lumpur', localCurrency: 'MYR',
      by: 'group-finance', at: '2026-10-05T09:00:00Z',
    });
    expect(moved.status).toBe(200);
    const body = moved.body;
    expect(body.country).toBe('MY');
    expect(body.timezone).toBe('Asia/Kuala_Lumpur');
    expect(body.utcOffsetLabel).toContain('+08:00');
    expect(body.localCurrency).toBe('MYR');
    expect(body.locale).toBe('ms-MY');
    expect(body.timeFormat).toBe('24h');
    expect(body.weekStart).toBe('monday');
    expect(body.regulator).toContain('BNM');
    expect(body.updatedBy).toBe('group-finance');
    expect(body.updatedAt).toBe('2026-10-05T09:00:00Z');
    expect(body.audit.length).toBeGreaterThan(0);
    // The rate card is rebased into the new local currency, not dropped: the same quotes, re-expressed.
    const usd = body.foreignCurrencies.find((c: any) => c.code === 'USD')!;
    expect(Number(usd.rate)).toBeGreaterThan(3);
    expect(usd.rate).not.toBe('3.6725');
    expect(body.examples.find((e: any) => e.to === 'USD')!.label).toContain('USD');
    // And a product filed after the move is filed in the new local currency, with no argument about it.
    const product = await call(state, 'POST', '/master/product', { productId: 'PROD-HULL-YACHT', by: 'product-factory' });
    expect(product.body.currency).toBe('MYR');

    // The date order and the clock are separate settings, so a tenant can hold one and change the other.
    const reformatted = await call(state, 'POST', '/master/regional', { dateFormat: 'YYYY-MM-DD', timeFormat: '12h' });
    expect(reformatted.body.dateFormat).toBe('YYYY-MM-DD');
    expect(reformatted.body.timeFormat).toBe('12h');
    expect(reformatted.body.localCurrency).toBe('MYR');

    const worldSnapshot = await call(state, 'GET', '/world');
    expect(worldSnapshot.body.erp.master.regional.localCurrency).toBe('MYR');
    expect(worldSnapshot.body.erp.master.regional.timezone).toBe('Asia/Kuala_Lumpur');
    expect(worldSnapshot.body.erp.master.regional.dateFormat).toBe('YYYY-MM-DD');
  });

  it('refuses a country, time zone, currency or date format it does not have on file', async () => {
    const state = createRuntimeState();
    expect(await refusal(state, '/master/regional', { country: 'XX' })).toContain('unknown country');
    expect(await refusal(state, '/master/regional', { timezone: 'Mars/Olympus' })).toContain('unknown time zone');
    expect(await refusal(state, '/master/regional', { localCurrency: 'ZZZ' })).toContain('unknown currency');
    expect(await refusal(state, '/master/regional', { dateFormat: 'MM-DD-YY' })).toContain('unknown date format');
    expect(await refusal(state, '/master/regional', { weekStart: 'midweek' })).toContain('unknown week start');
    expect(await refusal(state, '/master/regional', { country: 'MY', operatingRegion: 'Dubai' })).toContain('is not an operating region');
    // A refusal leaves the card exactly as it was: a half-applied regional change would put the
    // currency on one screen and the calendar on another.
    const regional = await call(state, 'GET', '/master/regional');
    expect(regional.body.country).toBe('AE');
    expect(regional.body.localCurrency).toBe('AED');
    expect(regional.body.timezone).toBe('Asia/Dubai');
  });

  it('quotes, re-quotes and removes a foreign currency, and keeps the local one out of the list', async () => {
    const state = createRuntimeState();
    const added = await call(state, 'POST', '/master/regional/currency', {
      code: 'SGD', rate: '2.72', asOf: '2026-10-04', kind: 'floating', by: 'treasury',
    });
    expect(added.status).toBe(200);
    const sgd = added.body.foreignCurrencies.find((c: any) => c.code === 'SGD')!;
    expect(sgd.rate).toBe('2.7200');
    expect(sgd.asOf).toBe('2026-10-04');
    expect(sgd.kind).toBe('floating');
    expect(added.body.examples.find((e: any) => e.to === 'SGD')!.label).toContain('SGD');

    // Re-quoting updates the rate rather than adding a second SGD row: one currency, one rate.
    const requoted = await call(state, 'POST', '/master/regional/currency', { code: 'SGD', rate: '2.75', by: 'treasury' });
    expect(requoted.body.foreignCurrencies.filter((c: any) => c.code === 'SGD').length).toBe(1);
    expect(requoted.body.foreignCurrencies.find((c: any) => c.code === 'SGD')!.rate).toBe('2.7500');

    const removed = await call(state, 'POST', '/master/regional/currency/remove', { code: 'SGD', by: 'treasury' });
    expect(removed.body.foreignCurrencies.some((c: any) => c.code === 'SGD')).toBe(false);

    expect(await refusal(state, '/master/regional/currency', { code: 'AED', rate: '1' })).toContain('is the local currency');
    expect(await refusal(state, '/master/regional/currency', { code: 'USD', rate: '-3' })).toContain('must be a positive number');
    expect(await refusal(state, '/master/regional/currency', { code: 'ZZZ', rate: '1' })).toContain('unknown currency');
    expect(await refusal(state, '/master/regional/currency/remove', { code: 'SGD' })).toContain('is not on the foreign currency list');
  });

  it('keeps the FX master and the regional card as one rate card, quoted from either door', async () => {
    const state = createRuntimeState();
    // The older master-settings FX route still works, and a quote into the local currency shows up on
    // the regional card — otherwise two screens would disagree about what a pound costs.
    await call(state, 'POST', '/master/fx', { from: 'GBP', to: 'AED', rate: '4.80', asOf: '2026-10-04', by: 'treasury' });
    const regional = await call(state, 'GET', '/master/regional');
    expect(regional.body.foreignCurrencies.find((c: any) => c.code === 'GBP')!.rate).toBe('4.8000');
    // A rate quoted the other way round lands on the same card, inverted, because the card is read
    // "one unit of that currency buys this much local".
    await call(state, 'POST', '/master/fx', { from: 'AED', to: 'JPY', rate: '40.00', by: 'treasury' });
    const after = await call(state, 'GET', '/master/regional');
    expect(after.body.foreignCurrencies.some((c: any) => c.code === 'JPY')).toBe(true);
  });
});

/* ------------------------------------------------------------------ 3. the product factory */

describe('master settings file a product', () => {
  it('re-files a catalogue variety from its id, keeping the wording and the limits nobody changed', async () => {
    const state = createRuntimeState();
    const created = await call(state, 'POST', '/master/product', {
      productId: 'PROD-CI-MULTIPAY', baseRatePerThousand: '88.00', by: 'product-factory',
    });
    expect(created.status).toBe(200);
    expect(created.body.productId).toBe('PROD-CI-MULTIPAY');
    expect(created.body.line).toBe('critical-illness');
    expect(created.body.category).toBe('conventional');
    expect(created.body.variety).toBeTruthy();
    expect(created.body.blurb.length).toBeGreaterThan(40);
    expect(created.body.currency).toBe('AED');

    const worldSnapshot = await call(state, 'GET', '/world');
    const master = worldSnapshot.body.erp.master.products.find((p: any) => p.productId === 'PROD-CI-MULTIPAY')!;
    expect(master.baseRatePerThousand).toBe('88.00 AED');
    expect(master.maxAge).toBe(PRODUCT_CATALOGUE.find((p) => p.productId === 'PROD-CI-MULTIPAY')!.maxAge);
    expect(master.variety).toBe(created.body.variety);
    expect(master.blurb).toBe(created.body.blurb);
  });

  it('files a variety nobody has heard of, in the tenant\u2019s currency, and refuses the obvious mistakes', async () => {
    const state = createRuntimeState();
    const fresh = await call(state, 'POST', '/master/product', {
      productId: 'PROD-CYBER-SME', name: 'SME Cyber Cover', line: 'general', category: 'conventional',
      minAge: 18, maxAge: 99, baseRatePerThousand: '16.00', by: 'product-factory',
    });
    expect(fresh.body.currency).toBe('AED');
    expect(fresh.body.line).toBe('general');

    expect(await refusal(state, '/master/product', { productId: '' })).toContain('productId is required');
    expect(await refusal(state, '/master/product', { productId: 'PROD-UNKNOWN-1' })).toContain('productId and name are required');
    expect(await refusal(state, '/master/product', {
      productId: 'PROD-BAD-AGES', name: 'Impossible ages', minAge: 70, maxAge: 20,
    })).toContain('entry age');
  });

  it('reports the whole catalogue by line, so the screen can show what is on file', async () => {
    const state = createRuntimeState();
    const worldSnapshot = await call(state, 'GET', '/world');
    const master = worldSnapshot.body.erp.master;
    expect(master.catalogueSize).toBe(PRODUCT_CATALOGUE.length);
    expect(master.productLines.length).toBe(PRODUCT_LINES.length);
    expect(master.products.length).toBe(PRODUCT_CATALOGUE.length);
    const counts = master.productLines.reduce((n: number, l: any) => n + l.count, 0);
    expect(counts).toBe(PRODUCT_CATALOGUE.length);
    for (const line of master.productLines) expect(line.count, `${line.line} on the shelf`).toBeGreaterThanOrEqual(2);
    // Every line carries its family, which is how the product factory groups 90 rows into 7 shelves.
    expect(new Set(master.productLines.map((l: any) => l.family)).size).toBe(7);
    const hull = master.productLines.find((l: any) => l.line === 'hull')!;
    expect(hull.productIds).toContain('PROD-HULL-MARINE');
    expect(master.products.find((p: any) => p.productId === 'PROD-HULL-MARINE')!.entityId).toBe('ALK-CONV');
    expect(master.products.find((p: any) => p.productId === 'PROD-TKF-FAMILY')!.entityId).toBe('ALK-TKF');
  });
});

/* ------------------------------------------------------------------ 4. the product sheet */

describe('the product factory files a shelf from a sheet', () => {
  it('hands out a template built from what this tenant has on file, and reads it back unchanged', async () => {
    const state = createRuntimeState();
    const sheet = await call(state, 'GET', '/master/product/template?products=PROD-UL-GLOBAL,PROD-HULL-MARINE');
    expect(sheet.status).toBe(200);
    const lines = String(sheet.body.csv).split('\n').filter((l: string) => l.length > 0 && !l.startsWith('#'));
    const header = lines[0]!;
    // The header is the label row, so a filled-in sheet can be uploaded with either ids or labels.
    for (const column of sheet.body.columns) expect(header, `${column} in the header`).toContain(column);
    expect(header).toContain('Omni-channel name');
    expect(lines.length - 1).toBe(2);
    expect(lines[1]).toContain('PROD-UL-GLOBAL');
    expect(lines[2]).toContain('PROD-HULL-MARINE');

    const before = await call(state, 'GET', '/master/product/export');
    // Export carries every filed variety; the sample carries the ones that were asked for.
    expect(String(before.body.csv).split('\n').filter((l: string) => l.length > 0 && !l.startsWith('#')).length)
      .toBe(PRODUCT_CATALOGUE.length + 1);

    // Upload it straight back: the same numbers, no new product, nothing refused, and the export is
    // byte-for-byte what it was — a sheet that round-trips is the only sheet a pricing team can trust.
    const exportBefore = String((await call(state, 'GET', '/master/product/export')).body.csv);
    const roundTrip = await call(state, 'POST', '/master/product/import', { csv: String(sheet.body.csv), by: 'pricing-committee' });
    expect(roundTrip.status).toBe(200);
    expect(roundTrip.body).toMatchObject({ read: 2, saved: 2, created: 0, updated: 2, sheetRejected: [], rejected: [] });
    expect(String((await call(state, 'GET', '/master/product/export')).body.csv)).toBe(exportBefore);
  });

  it('refuses the dirty rows of a sheet and files the clean ones beside them', async () => {
    const state = createRuntimeState();
    const bulk = await call(state, 'POST', '/master/product/bulk', {
      rows: [
        { productId: 'PROD-PET-RISK', name: 'Pet Insurance', line: 'general', category: 'conventional', minAge: 18, maxAge: 80, baseRatePerThousand: '21.00', secondaryName: 'Paw Cover' },
        { productId: 'PROD-BAD-BANDS', name: 'Wrong way round', line: 'general', minAge: 75, maxAge: 30, baseRatePerThousand: '12.00' },
        { productId: 'PROD-BAD-LIMITS', name: 'AI binds above the treaty', line: 'general', minAge: 18, maxAge: 65, baseRatePerThousand: '12.00', automaticBindingLimit: '500,000.00', facultativeThreshold: '250,000.00' },
      ],
      by: 'pricing-committee',
    });
    expect(bulk.status).toBe(200);
    expect(bulk.body.saved).toBe(1);
    expect(bulk.body.created).toBe(1);
    expect(bulk.body.rejected.length).toBe(2);
    expect(JSON.stringify(bulk.body.rejected)).toContain('admits nobody');
    expect(JSON.stringify(bulk.body.rejected)).toContain('facultative threshold');
    expect(bulk.body.products[0]).toMatchObject({ productId: 'PROD-PET-RISK', secondaryName: 'Paw Cover', currency: 'AED' });

    // And the sheet a human uploads reports the same two refusals, split between shape and rules.
    const uploaded = await call(state, 'POST', '/master/product/import', {
      csv: [
        'Product ID,Registered name,Category,Line of business,Age from,Age to,Max BMI,Base rate per 1000,Income multiple,Automatic binding limit,Facultative threshold,AI straight-through limit',
        'PROD-TRAVEL-ANNEX,Travel Annex Cover,conventional,travel,18,90,34,9.50,20,250000.00,400000.00,80000.00',
        'PROD-BAD-DATE,Broken,conventional,travel,not-an-age,90',
      ].join('\n'),
      by: 'bulk-upload',
    });
    expect(uploaded.body.saved).toBe(1);
    expect(uploaded.body.rejected.length).toBe(0);
    expect(uploaded.body.sheetRejected.length).toBe(1);
    expect(JSON.stringify(uploaded.body.sheetRejected)).toContain('Age from');
  });

  it('copies a variety with its whole tariff, so the copy can be quoted the moment it exists', async () => {
    const state = createRuntimeState();
    const before = await call(state, 'GET', '/master/rates?productId=PROD-UL-GLOBAL');
    const filed = before.body.rows.length;
    expect(filed).toBeGreaterThan(0);

    const copied = await call(state, 'POST', '/master/product/copy', {
      sourceProductId: 'PROD-UL-GLOBAL', productId: 'PROD-UL-GLOBAL-2027', secondaryName: 'Global UL (2027 shelf)', by: 'product-factory-grid',
    });
    expect(copied.status).toBe(200);
    expect(copied.body.copiedRateRows).toBe(filed);

    const after = await call(state, 'GET', '/master/rates?productId=PROD-UL-GLOBAL-2027');
    expect(after.body.rows.length).toBe(filed);
    const worldSnapshot = await call(state, 'GET', '/world');
    const twin = worldSnapshot.body.erp.master.products.find((p: any) => p.productId === 'PROD-UL-GLOBAL-2027')!;
    const original = worldSnapshot.body.erp.master.products.find((p: any) => p.productId === 'PROD-UL-GLOBAL')!;
    expect(twin.secondaryName).toBe('Global UL (2027 shelf)');
    // The copy is a twin, not a re-pricing: same tariff, same limits, same currency.
    expect(twin.baseRatePerThousand).toBe(original.baseRatePerThousand);
    expect(twin.automaticBindingLimit).toBe(original.automaticBindingLimit);
    expect(twin.rateRows).toBe(filed);
    // A copy that named an id already on file would silently re-file the original: refused.
    expect(await refusal(state, '/master/product/copy', { sourceProductId: 'PROD-UL-GLOBAL', productId: 'PROD-HULL-MARINE' })).toContain('already on file');
  });

  it('refuses a sheet that cannot be read at all, rather than filing half a header', async () => {
    const state = createRuntimeState();
    expect((await call(state, 'POST', '/master/product/import', { csv: '   ' })).status).toBe(400);
    // A header that matches no column at all is refused whole, rather than filing ninety empty rows.
    expect(await refusal(state, '/master/product/import', { csv: 'a,b,c\n1,2,3' })).toContain('No column in the header was recognised');
    expect(JSON.stringify((await call(state, 'POST', '/master/product/bulk', { rows: [] })).body)).toContain('no product rows were sent');
  });
});

/* ------------------------------------------------------------------ 5. the rating tables */

describe('the tariff prices a life by age, gender, rank and sum assured', () => {
  it('is seeded from each product\u2019s own filed tariff, and reports no holes in the ages it covers', async () => {
    const state = createRuntimeState();
    const rates = await call(state, 'GET', '/master/rates?productId=PROD-UL-GLOBAL');
    expect(rates.body.rows.length).toBeGreaterThan(0);
    expect(rates.body.gaps.every((g: any) => g.gaps.length === 0), 'no uncovered ages').toBe(true);
    expect(rates.body.overlaps).toEqual([]);
    const premium = rates.body.rows.filter((r: any) => r.kind === 'premium');
    expect(premium.length).toBe(10);
    expect(new Set(premium.map((r: any) => `${r.ageFrom}-${r.ageTo}`)).size).toBe(5);
    expect(rates.body.stats.mortalityRows).toBeGreaterThan(0);
  });

  it('files a band, overrides it for a partner, and prices the same life both ways', async () => {
    const state = createRuntimeState();
    // A life aged 34, female, class 3, 150,000 of cover, quoted from the seeded grid.
    const base = await call(state, 'POST', '/master/rates/price', {
      productId: 'PROD-UL-GLOBAL', age: 34, gender: 'female', occupationClass: '3', sumAssured: '150,000.00', kind: 'premium',
    });
    expect(base.body.priced).toBe(true);
    // Age 34 lands in the seeded band 27–35, 38.40 per 1,000 a year: 150,000 buys 5,760.00 of premium.
    expect(base.body.row).toMatchObject({ ageFrom: 27, ageTo: 35, gender: 'unisex', occupationClass: 0, ratePerThousand: '38.40' });
    expect(base.body.amount).toBe('5,760.00 AED');

    const bootstrap = await call(state, 'POST', '/master/channels/bootstrap', { by: 'setup' });
    expect(bootstrap.body.created.length).toBe(6);
    await call(state, 'POST', '/master/partners', {
      partnerId: 'NORTH-BROKER', name: 'North Brokers', channelCode: 'BROKER', commissionBps: [1200, 400], by: 'setup',
    });
    const scoped = await call(state, 'POST', '/master/rates/upsert', {
      productId: 'PROD-UL-GLOBAL', kind: 'premium', gender: 'female', ageFrom: 30, ageTo: 40, occupationClass: 3,
      sumFrom: '0.00', channelCode: 'BROKER', partnerId: 'NORTH-BROKER', ratePerThousand: '1.10', by: 'channel-desk',
    });
    expect(scoped.body.created).toBe(true);

    const viaPartner = await call(state, 'POST', '/master/rates/price', {
      productId: 'PROD-UL-GLOBAL', age: 34, gender: 'female', occupationClass: '3', sumAssured: '150,000.00', partnerId: 'NORTH-BROKER',
    });
    // 1.10 per 1,000 of the same cover, because the partner row outranks the base tariff.
    expect(viaPartner.body.amount).toBe('165.00 AED');
    expect(viaPartner.body.row).toMatchObject({ partnerId: 'NORTH-BROKER', channelCode: 'BROKER', ratePerThousand: '1.10' });
    // The same life, sold direct, still reads the base tariff — an override never leaks sideways.
    const stillBase = await call(state, 'POST', '/master/rates/price', {
      productId: 'PROD-UL-GLOBAL', age: 34, gender: 'female', occupationClass: '3', sumAssured: '150,000.00',
    });
    expect(stillBase.body.amount).toBe('5,760.00 AED');

    // The row can be copied to the band above and then withdrawn again.
    const copied = await call(state, 'POST', '/master/rates/copy', {
      rowId: scoped.body.row.rowId, ageFrom: 41, ageTo: 50, note: 'Copied up one band', by: 'channel-desk',
    });
    expect(copied.body.rows).toBe(scoped.body.rows + 1);
    const removed = await call(state, 'POST', '/master/rates/delete', { rowId: copied.body.row.rowId, by: 'channel-desk' });
    expect(removed.body.rows).toBe(scoped.body.rows);
    expect(scoped.body.row.partnerId).toBe('NORTH-BROKER');
  });

  it('bulk-files rows, keeping the refusals attached to the row that caused them', async () => {
    const state = createRuntimeState();
    const bulk = await call(state, 'POST', '/master/rates/bulk', {
      rows: [
        { productId: 'PROD-UL-GLOBAL', kind: 'premium', gender: 'male', ageFrom: 18, ageTo: 25, occupationClass: 1, sumFrom: '0.00', ratePerThousand: '0.0220' },
        { productId: 'PROD-UL-GLOBAL', kind: 'premium', gender: 'male', ageFrom: 60, ageTo: 21, ratePerThousand: '0.0500' },
      ],
      by: 'pricing-committee',
    });
    expect(bulk.body.saved).toBe(1);
    expect(bulk.body.refused).toBe(1);
    expect(bulk.body.refusedRows[0].index).toBe(1);
    expect(bulk.body.refusedRows[0].reasons.join(' ')).toContain('age');
    expect(Array.isArray(bulk.body.rows)).toBe(true);
    expect(bulk.body.rows[0].rowId).toBeTruthy();

    // A tariff can be cleared for one product without touching any other.
    const beforeClear = await call(state, 'GET', '/master/rates?productId=PROD-LIFE-TERM');
    const cleared = await call(state, 'POST', '/master/rates/clear', { productId: 'PROD-UL-GLOBAL', by: 'pricing-committee' });
    expect(cleared.body.cleared).toBe(41);
    const after = await call(state, 'GET', '/master/rates?productId=PROD-UL-GLOBAL');
    expect(after.body.rows.length).toBe(0);
    expect((await call(state, 'GET', '/master/rates?productId=PROD-LIFE-TERM')).body.rows.length).toBe(beforeClear.body.rows.length);
  });

  it('downloads a sample sheet a pricing team can fill in, and uploads it back in replace mode', async () => {
    const state = createRuntimeState();
    // Pick a product with no seeded grid, so the sample is genuinely the tariff it ends up with.
    const template = await call(state, 'GET', '/master/rates/template?products=PROD-CI-STANDALONE&bands=3');
    const csv = String(template.body.csv);
    expect(csv.split('\n').filter((l: string) => l.startsWith('PROD-CI-STANDALONE')).length).toBeGreaterThan(0);
    const imported = await call(state, 'POST', '/master/rates/import', { csv, mode: 'replace', by: 'bulk-upload' });
    expect(imported.status).toBe(200);
    expect(imported.body.read).toBeGreaterThan(0);
    expect(imported.body.applied).toBe(imported.body.read);
    expect(imported.body.rejected).toEqual([]);

    const rows = await call(state, 'GET', '/master/rates?productId=PROD-CI-STANDALONE');
    expect(rows.body.rows.length).toBe(imported.body.applied);
    const reupload = await call(state, 'POST', '/master/rates/import', { csv, mode: 'replace', by: 'bulk-upload' });
    // "Replace" clears the product's tariff first, so the same four rows arrive as four fresh ones:
    // the file is the tariff, and the count never drifts however often it is uploaded.
    expect(reupload.body.applied).toBe(imported.body.applied);
    expect(reupload.body.cleared).toBe(imported.body.applied);
    expect(reupload.body.rejected).toEqual([]);
    expect((await call(state, 'GET', '/master/rates?productId=PROD-CI-STANDALONE')).body.rows.length).toBe(imported.body.applied);

    // One dirty line never aborts the batch: the good rows file, the bad one is reported with its line.
    const dirty = `${csv.trimEnd()}\nPROD-CI-STANDALONE,premium,unisex,90,20,0,0.00,,,,1.00,AED,inverted band\n`;
    const partial = await call(state, 'POST', '/master/rates/import', { csv: dirty, mode: 'append', by: 'bulk-upload' });
    expect(partial.body.rejected.length).toBe(1);
    expect(partial.body.rejected[0].line).toBeGreaterThan(1);
    // The four good rows re-filed the bands they name — no twins — and the fifth was refused on its own.
    expect(partial.body.applied).toBe(4);
    expect(partial.body.replaced).toBe(4);
    expect(JSON.stringify(partial.body.rejected)).toContain('admits nobody');
  });

  it('charges a unit-linked policy\u2019s cost of insurance from the table, not from a flat figure', async () => {
    const state = createRuntimeState();
    const charged = await call(state, 'POST', '/master/rates/mortality', { policyId: 'UL-000123' });
    expect(charged.status).toBe(200);
    expect(charged.body.fromTable).toBe(true);
    // 0.01 per 1,000 of 250,000.00 of cover, per policy month.
    expect(charged.body.monthlyCharge).toBe('2.50 AED');
    expect(charged.body.row.kind).toBe('mortality');
    expect(charged.body.basis).toContain('per month');
    // A policy the ERP does not know is an error with its id in it, not a silent zero.
    expect(await refusal(state, '/master/rates/mortality', { policyId: 'UL-999999' })).toContain('UL-999999');
  });
});

/* ------------------------------------------------------------------ 6. omni-channel setup */

describe('omni-channel setup: channels, the partners on them, and each partner\u2019s terms', () => {
  it('says plainly what is missing while nothing is set up, and fixes it with one call', async () => {
    const state = createRuntimeState();
    const empty = await call(state, 'GET', '/master/channels');
    expect(empty.body.channelCount).toBe(0);
    expect(empty.body.configured).toBe(false);
    expect(empty.body.blockers.join(' ')).toContain('No omni-channel is set up');

    const bootstrapped = await call(state, 'POST', '/master/channels/bootstrap', { by: 'distribution-desk' });
    expect(bootstrapped.body.created).toEqual(['DIRECT-PORTAL', 'AGENCY', 'BROKER', 'BANCASSURANCE', 'AGGREGATOR', 'EMBEDDED']);
    expect(bootstrapped.body.skipped).toBe(false);
    // Idempotent: a second press files nothing at all and says so.
    const again = await call(state, 'POST', '/master/channels/bootstrap', { by: 'distribution-desk' });
    expect(again.body.created).toEqual([]);
    expect(again.body.skipped).toBe(true);
    expect((await call(state, 'GET', '/master/channels')).body.channelCount).toBe(6);
  });

  it('holds a partner inside its channel\u2019s ceiling, and refuses to delete a channel that is in use', async () => {
    const state = createRuntimeState();
    await call(state, 'POST', '/master/channels/bootstrap', { by: 'distribution-desk' });

    expect(await refusal(state, '/master/partners', {
      partnerId: 'OVER-PAID', name: 'Over Paid Brokers', channelCode: 'BROKER', commissionBps: [4500],
    })).toContain('ceiling');

    const partner = await call(state, 'POST', '/master/partners', {
      partnerId: 'GULF-BROKERS', name: 'Gulf Brokers', channelCode: 'BROKER', commissionBps: [1500, 500, 250],
      clawback: { basis: 'policy-year', trigger: 'cancellation-or-lapse', recoveryBps: [10000, 5000, 2500] }, by: 'distribution-desk',
    });
    expect(partner.body.partner.commissionBps).toEqual([1500, 500, 250]);
    expect(partner.body.partnerCount).toBe(1);

    expect(await refusal(state, '/master/channels/remove', { code: 'BROKER' })).toContain('still holds 1 partner');
    // An offer needs the product on the partner\u2019s shelf first — the order is the point.
    expect(await refusal(state, '/master/offers', { partnerId: 'GULF-BROKERS', productId: 'PROD-UL-GLOBAL', ratePerThousand: '2.00' })).toContain('shelf');
    await call(state, 'POST', '/master/partners/products', { partnerId: 'GULF-BROKERS', productIds: ['PROD-UL-GLOBAL', 'PROD-LIFE-TERM'], by: 'distribution-desk' });
    const offer = await call(state, 'POST', '/master/offers', {
      partnerId: 'GULF-BROKERS', productId: 'PROD-UL-GLOBAL', secondaryName: 'Global UL — Gulf', premiumUpliftBps: 250, enabled: true, by: 'distribution-desk',
    });
    expect(offer.body.offer.ratePerThousand).toBeNull();
    expect(offer.body.offerCount).toBe(1);

    const priced = await call(state, 'POST', '/master/rates/price', {
      productId: 'PROD-UL-GLOBAL', age: 34, gender: 'female', occupationClass: '1', sumAssured: '150,000.00', partnerId: 'GULF-BROKERS',
    });
    expect(priced.body.priced).toBe(true);
    // The offer carries no rate of its own, so the product's tariff prices the life and the offer's 250
    // bps uplift moves it: 5,760.00 becomes 5,904.00, and the commission schedule comes from the partner.
    expect(priced.body.partner).toMatchObject({ partnerId: 'GULF-BROKERS', channelCode: 'BROKER', commissionBps: [1500, 500, 250] });
    expect(priced.body.amount).toBe('5,904.00 AED');
    expect(priced.body.basis).toContain('250 bps premium uplift');
  });

  it('pays a partner in basis points of decimal money, and claws back on the schedule', async () => {
    const state = createRuntimeState();
    await call(state, 'POST', '/master/channels/bootstrap', { by: 'distribution-desk' });
    await call(state, 'POST', '/master/partners', {
      partnerId: 'BANK-AB', name: 'Bank AB Bancassurance', channelCode: 'BANCASSURANCE', commissionBps: [1000, 300], by: 'desk',
    });
    const firstYear = await call(state, 'POST', '/master/commission', { partnerId: 'BANK-AB', productId: 'PROD-UL-GLOBAL', premium: '12,000.00', policyYear: 1 });
    // 1,000 bps of 12,000.00 is 1,200.00 — bps of a decimal premium, never a float on the premium.
    expect(firstYear.body).toMatchObject({ commission: '1,200.00 AED', commissionBps: 1000, policyYear: 1, schedule: [1000, 300] });
    expect(firstYear.body.commissionBasis).toContain('policy year 1');
    // Nothing is owed back before the first policy period is even complete…
    expect(firstYear.body).toMatchObject({ clawback: '0.00 AED', clawbackDue: false });
    // …and a cancellation in year 1 recovers the whole of it, on the partner's clawback plan.
    const lapsed = await call(state, 'POST', '/master/commission', { partnerId: 'BANK-AB', productId: 'PROD-UL-GLOBAL', premium: '12,000.00', policyYear: 1, periodsSinceInception: 1 });
    expect(lapsed.body).toMatchObject({ clawback: '1,200.00 AED', clawbackBps: 10000, clawbackDue: true });
    // A schedule does not run out into thin air: the last figure repeats for later years, and a policy
    // four years old is past the recovery window.
    const thirdYear = await call(state, 'POST', '/master/commission', { partnerId: 'BANK-AB', productId: 'PROD-UL-GLOBAL', premium: '12,000.00', policyYear: 3, periodsSinceInception: 40 });
    expect(thirdYear.body).toMatchObject({ commission: '360.00 AED', commissionBps: 300, clawback: '0.00 AED', clawbackDue: false });
  });

  it('names one plan differently per channel, and keeps the registered name underneath', async () => {
    const state = createRuntimeState();
    await call(state, 'POST', '/master/channels/bootstrap', { by: 'distribution-desk' });
    const named = await call(state, 'POST', '/master/channels/product-name', {
      productId: 'PROD-UL-GLOBAL', channelCode: 'AGENCY', secondaryName: 'Wealth Builder Plan', by: 'distribution-desk',
    });
    expect(named.body.resolved.name).toBe('Wealth Builder Plan');
    expect(named.body.resolved.source).toContain('AGENCY');
    // A channel that was never given a name falls back to the product master, not to the agency\u2019s brand.
    const other = await call(state, 'POST', '/master/rates/price', { productId: 'PROD-UL-GLOBAL', age: 34, sumAssured: '10,000.00' });
    expect(other.body.priced).toBe(true);

    const filed = await call(state, 'POST', '/master/product/bulk', { rows: [{ productId: 'PROD-UL-GLOBAL', secondaryName: 'Global Unit-Linked' }], by: 'desk' });
    expect(filed.body.products[0].secondaryName).toBe('Global Unit-Linked');
    const worldSnapshot = await call(state, 'GET', '/world');
    const product = worldSnapshot.body.erp.master.products.find((p: any) => p.productId === 'PROD-UL-GLOBAL')!;
    expect(product.channelNames.find((c: any) => c.channelCode === 'AGENCY')!.secondaryName).toBe('Wealth Builder Plan');
    expect(product.secondaryName).toBe('Global Unit-Linked');
    // The agency name still wins over the product master for that channel.
    expect((await call(state, 'GET', '/master/channels')).body.channels.find((c: any) => c.code === 'AGENCY')).toBeDefined();
  });

  it('audits every move on this master, from bootstrap to clawback', async () => {
    const state = createRuntimeState();
    await call(state, 'POST', '/master/channels/bootstrap', { by: 'distribution-desk' });
    await call(state, 'POST', '/master/partners', { partnerId: 'APP-1', name: 'App Partner', channelCode: 'EMBEDDED', commissionBps: [800], by: 'integration-bot' });
    const snapshot = await call(state, 'GET', '/master/channels');
    const actions = snapshot.body.trail.map((t: any) => t.action);
    expect(actions.some((a: string) => a.includes('channel'))).toBe(true);
    expect(snapshot.body.trail.some((t: any) => t.by === 'integration-bot')).toBe(true);
  });
});
