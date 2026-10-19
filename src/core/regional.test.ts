/**
 * Country, region, calendar and currency master settings.
 *
 * Why these matter rather than merely existing: a date read in the wrong zone moves a dealing day and
 * misses a cut-off, and an amount printed without its currency is an amount a customer can
 * misread. Every test here is one of those two failures being refused.
 */
import { describe, expect, it } from 'vitest';
import { money, formatAmount } from './money.js';
import {
  COUNTRIES, CURRENCY_LIST, DATE_FORMATS, REGIONS, RegionalDesk, RegionalError, TIMEZONES,
  applyDateFormat, defaultRegional, formatDate, zonedParts,
} from './regional.js';

describe('the country packs', () => {
  it('holds a pack per country with the region, zone, currency and calendar that come with it', () => {
    expect(COUNTRIES.length).toBeGreaterThanOrEqual(30);
    for (const pack of COUNTRIES) {
      expect(pack.code, pack.name).toMatch(/^[A-Z]{2}$/);
      expect(pack.regions.length, `${pack.code} operating regions`).toBeGreaterThan(0);
      expect(TIMEZONES.some((z) => z.id === pack.timezone), `${pack.code} zone ${pack.timezone}`).toBe(true);
      expect(CURRENCY_LIST.some((c) => c.code === pack.currency), `${pack.code} currency ${pack.currency}`).toBe(true);
      expect(DATE_FORMATS.includes(pack.dateFormat), `${pack.code} date format`).toBe(true);
      expect(REGIONS.includes(pack.region), `${pack.code} region`).toBe(true);
    }
  });

  it('names the Gulf, South-East Asian, European, African, American and Asia-Pacific books', () => {
    for (const region of ['Gulf Cooperation Council', 'South-East Asia', 'Europe', 'Africa', 'Americas', 'Asia-Pacific']) {
      expect(REGIONS, region).toContain(region);
    }
  });

  it('refuses a country, a zone and a currency that are not on file, and says how many are', () => {
    const desk = defaultRegional();
    expect(() => desk.update({ country: 'ZZ' })).toThrow(RegionalError);
    expect(() => desk.update({ country: 'ZZ' })).toThrow(/country packs are on file/);
    expect(() => desk.update({ timezone: 'Mars/Olympus' })).toThrow(/time zone/i);
    expect(() => desk.update({ localCurrency: 'XXX' })).toThrow(/unknown currency/);
    expect(() => desk.update({ region: 'Atlantis' })).toThrow(/unknown region/);
    expect(() => desk.update({ operatingRegion: 'Nowhere' })).toThrow(/operating region/);
    expect(() => desk.update({ dateFormat: 'YYYY/YYYY/YYYY' as never })).toThrow(/unknown date format/);
  });
});

describe('the calendar', () => {
  it('reads an instant in the tenant zone, and reports the offset from the zone rather than from a guess', () => {
    // 12:00 UTC is 16:00 in Dubai all year, and 13:00 in London in October (BST) but 12:00 in January.
    expect(zonedParts('2026-10-05T12:00:00Z', 'Asia/Dubai')).toMatchObject({ hour: 16, minute: 0, offsetMinutes: 240, offsetLabel: 'UTC+04:00' });
    expect(zonedParts('2026-10-05T12:00:00Z', 'Europe/London')).toMatchObject({ hour: 13, offsetMinutes: 60 });
    expect(zonedParts('2026-01-05T12:00:00Z', 'Europe/London')).toMatchObject({ hour: 12, offsetMinutes: 0 });
    // A zone with a half-hour offset: getting this wrong is the classic cut-off bug.
    expect(zonedParts('2026-10-05T12:00:00Z', 'Asia/Kolkata')).toMatchObject({ hour: 17, minute: 30, offsetMinutes: 330 });
    // Crossing midnight: the date in Auckland is already the next day.
    expect(zonedParts('2026-10-05T12:00:00Z', 'Pacific/Auckland')).toMatchObject({ day: 6, month: 10 });
  });

  it('prints a date the way the country prints it, and refuses a date it cannot read', () => {
    expect(formatDate('2026-10-05', 'DD/MM/YYYY')).toBe('05/10/2026');
    expect(formatDate('2026-10-05', 'MM/DD/YYYY')).toBe('10/05/2026');
    expect(formatDate('2026-10-05', 'YYYY-MM-DD')).toBe('2026-10-05');
    expect(formatDate('2026-10-05', 'DD.MM.YYYY')).toBe('05.10.2026');
    expect(formatDate('2026-10-05', 'D MMM YYYY')).toBe('5 Oct 2026');
    expect(formatDate('2026-10-05', 'DD MMMM YYYY')).toBe('05 October 2026');
    expect(applyDateFormat(5, 10, 2026, 'DD/MM/YYYY')).toBe('05/10/2026');
    expect(() => formatDate('05/10/2026', 'DD/MM/YYYY')).toThrow(/not a calendar date/);
  });

  it('moves the whole calendar when the country moves, unless something is named explicitly', () => {
    const desk = defaultRegional();
    expect(desk.current).toMatchObject({ country: 'AE', timezone: 'Asia/Dubai', localCurrency: 'AED', weekStart: 'monday' });

    desk.update({ country: 'MY', by: 'group-finance', at: '2026-10-06T09:00:00+08:00' });
    // Kuala Lumpur, ringgit, BNM and Monday come with the country: nobody had to remember them.
    expect(desk.current).toMatchObject({
      country: 'MY', region: 'South-East Asia', operatingRegion: 'Kuala Lumpur',
      timezone: 'Asia/Kuala_Lumpur', localCurrency: 'MYR', regulator: 'BNM', weekStart: 'monday',
    });
    expect(desk.formatDateTime('2026-10-06T01:00:00Z')).toMatch(/06\/10\/2026, 09:00 UTC\+08:00/);
    // The rate card came with it, rebased into ringgit on the quote already on file — and the
    // outgoing local currency is now itself a foreign currency, at the reciprocal of that quote.
    const card = Object.fromEntries(desk.current.foreignCurrencies.map((f) => [f.code, f.rateLabel]));
    expect(card).toMatchObject({ AED: '1.2195', USD: '4.4787', EUR: '4.9024', GBP: '5.6707' });
    expect(card['MYR']).toBeUndefined();

    // An explicit override wins over the pack, which is how a branch in a zone of its own is set up.
    desk.update({ country: 'US', timezone: 'America/Los_Angeles', localCurrency: 'USD', by: 'us-branch' });
    expect(desk.current).toMatchObject({ country: 'US', timezone: 'America/Los_Angeles', localCurrency: 'USD', dateFormat: 'MM/DD/YYYY', timeFormat: '12h', weekStart: 'sunday' });
    expect(desk.formatDateTime('2026-10-05T20:30:00Z')).toMatch(/10\/05\/2026, 1:30 pm UTC.07:00/);
    // Rebasing twice on exact rationals lands back on the reciprocal of the original dollar peg:
    // AED 3.6725 per USD becomes USD 0.2723 per AED, with no decimal dust from the round trip.
    const usdCard = Object.fromEntries(desk.current.foreignCurrencies.map((f) => [f.code, f.rateLabel]));
    expect(usdCard).toMatchObject({ AED: '0.2723', EUR: '1.0946', GBP: '1.2662', MYR: '0.2233' });
  });

  it('keeps an audit trail of every change, with who made it and when', () => {
    const desk = defaultRegional();
    desk.update({ country: 'GB', by: 'compliance', at: '2026-10-06T10:00:00Z' });
    const trail = desk.auditTrail();
    expect(trail.length).toBeGreaterThan(0);
    expect(trail.every((c) => c.by === 'compliance' && c.at === '2026-10-06T10:00:00Z')).toBe(true);
    expect(trail.find((c) => c.field === 'country')).toMatchObject({ from: 'AE', to: 'GB' });
    expect(trail.find((c) => c.field === 'localCurrency')).toMatchObject({ from: 'AED', to: 'GBP' });
    expect(trail.find((c) => c.field === 'timezone')).toMatchObject({ from: 'Asia/Dubai', to: 'Europe/London' });
  });
});

describe('local and foreign currency', () => {
  it('quotes a foreign currency exactly, with the date it was quoted, and converts on the rational', () => {
    const desk = defaultRegional();
    const usd = desk.current.foreignCurrencies.find((f) => f.code === 'USD')!;
    expect(usd).toMatchObject({ kind: 'pegged', rateLabel: '3.6725', asOf: '2026-09-01' });
    // 1,000.00 AED ÷ 3.6725 = 272.29 USD (half-up), never a float multiplication.
    expect(formatAmount(desk.convert(money(1000_00n, 'AED'), 'USD'))).toBe('272.29 USD');
    // The other direction uses the reciprocal of the same quote, not a second rate somebody typed.
    expect(formatAmount(desk.convert(money(100_00n, 'USD'), 'AED'))).toBe('367.25 AED');
  });

  it('takes a cross rate through the local currency rather than inventing one', () => {
    const desk = defaultRegional();
    const cross = desk.rate('USD', 'GBP');
    expect(cross.asOf).toBe('2026-09-01');   // the older of the two quotes it is built from
    const converted = desk.convert(money(100_00n, 'USD'), 'GBP');
    expect(converted.currency).toBe('GBP');
    expect(Number(converted.minor)).toBeGreaterThan(0);
  });

  it('refuses a conversion it has no rate for, instead of estimating one', () => {
    const desk = defaultRegional();
    expect(() => desk.convert(money(100_00n, 'AED'), 'JPY')).toThrow(/no AED→JPY rate on file/);
    expect(() => desk.rate('JPY', 'KRW')).toThrow(/rate on file/);
  });

  it('refuses the local currency as a foreign one, and a rate that is not a positive number', () => {
    const desk = defaultRegional();
    expect(() => desk.setForeignCurrency({ code: 'AED', rate: 1 })).toThrow(/has no rate against itself/);
    expect(() => desk.setForeignCurrency({ code: 'JPY', rate: 0 })).toThrow(/positive number/);
    expect(() => desk.setForeignCurrency({ code: 'JPY', rate: -1 })).toThrow(/positive number/);
    desk.setForeignCurrency({ code: 'JPY', rate: 0.0246, asOf: '2026-10-06', kind: 'floating', by: 'treasury' });
    expect(desk.current.foreignCurrencies.some((f) => f.code === 'JPY')).toBe(true);
    expect(desk.auditTrail().at(-1)).toMatchObject({ field: 'foreignCurrency.JPY', by: 'treasury' });
    expect(() => desk.removeForeignCurrency('JPY', { by: 'treasury' })).not.toThrow();
    expect(() => desk.removeForeignCurrency('JPY')).toThrow(/not on the foreign currency list/);
  });

  it('promotes a quoted currency to local and turns the outgoing local currency into a foreign one', () => {
    const desk = defaultRegional();
    desk.setForeignCurrency({ code: 'JPY', rate: 0.0246, asOf: '2026-10-06', kind: 'floating', by: 'treasury' });
    desk.update({ country: 'JP', localCurrency: 'JPY', by: 'treasury', at: '2026-10-06T09:00:00+09:00' });
    expect(desk.current.localCurrency).toBe('JPY');
    const card = Object.fromEntries(desk.current.foreignCurrencies.map((f) => [f.code, f.rateLabel]));
    expect(card['JPY']).toBeUndefined();
    expect(card['AED']).toBe('40.6504');                 // 1 ÷ 0.0246, on the rationals
    expect(desk.auditTrail().some((c) => c.field === 'foreignCurrencyCard' && /rebased from AED to JPY/.test(c.to))).toBe(true);
  });

  it('drops the rate card rather than keep quotes it cannot rebase, and writes down why', () => {
    const desk = defaultRegional();
    expect(desk.current.foreignCurrencies.length).toBeGreaterThan(0);
    // The yen has never been quoted, so there is nothing to divide the card by: guessing would
    // re-price every foreign amount on the next screen that read it.
    desk.update({ country: 'JP', localCurrency: 'JPY', by: 'treasury', at: '2026-10-06T09:00:00+09:00' });
    expect(desk.current.foreignCurrencies).toEqual([]);
    const notes = desk.auditTrail().filter((c) => c.field === 'foreignCurrencyCard');
    expect(notes.length).toBeGreaterThan(0);
    expect(notes.every((n) => /dropped — no JPY quote on file/.test(n.to))).toBe(true);
  });

  it('re-quotes a currency in place and keeps the list sorted, so a rate card reads the same every time', () => {
    const desk = defaultRegional();
    desk.setForeignCurrency({ code: 'USD', rate: 3.6800, asOf: '2026-10-06', kind: 'pegged', by: 'treasury' });
    const codes = desk.current.foreignCurrencies.map((f) => f.code);
    expect(codes).toEqual([...codes].sort());
    expect(desk.current.foreignCurrencies.filter((f) => f.code === 'USD')).toHaveLength(1);
    expect(desk.current.foreignCurrencies.find((f) => f.code === 'USD')!.rateLabel).toBe('3.6800');
  });

  it('shows a worked example per foreign currency, which is what an operator checks a rate against', () => {
    const desk = defaultRegional();
    const examples = desk.example();
    expect(examples.map((e) => e.to)).toEqual(['EUR', 'GBP', 'MYR', 'USD']);
    expect(examples[0]!.from).toBe('1,000.00 AED');
    expect(examples.find((e) => e.to === 'USD')!.label).toBe('272.29 USD');
  });
});

describe('the settings as the console reads them', () => {
  it('carries the choice lists with the settings, so a screen never hardcodes a country or a zone', () => {
    const snapshot = new RegionalDesk().snapshot();
    expect(snapshot.choices.countries.length).toBe(COUNTRIES.length);
    expect(snapshot.choices.timezones.length).toBe(TIMEZONES.length);
    expect(snapshot.choices.dateFormats).toEqual([...DATE_FORMATS]);
    expect(snapshot.choices.currencies.length).toBe(CURRENCY_LIST.length);
    expect(snapshot.foreignCurrencies.length).toBe(0);
    expect(snapshot.country).toBe('AE');
  });

  it('is deterministic: the same settings produce the same snapshot, byte for byte', () => {
    const a = defaultRegional().snapshot();
    const b = defaultRegional().snapshot();
    expect(JSON.stringify(a, (_k, v) => (typeof v === 'bigint' ? v.toString() : v)))
      .toBe(JSON.stringify(b, (_k, v) => (typeof v === 'bigint' ? v.toString() : v)));
  });
});
