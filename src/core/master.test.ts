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

async function call(state: RuntimeState, method: 'GET' | 'POST', path: string, payload: Body = {}): Promise<{ status: number; body: any }> {
  const result = await dispatchApiRoute(state, method, path, new URLSearchParams(), payload);
  expect(result.handled, `${method} ${path}`).toBe(true);
  return { status: result.status, body: result.body };
}

async function refusal(state: RuntimeState, path: string, payload: Body = {}): Promise<string> {
  try {
    const result = await dispatchApiRoute(state, 'POST', path, new URLSearchParams(), payload);
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
