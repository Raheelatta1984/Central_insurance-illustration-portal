import { beforeEach, describe, expect, it } from 'vitest';
import { DatedFx, GroupConsolidator, GroupEntitySpec, RateTable, GroupError } from './groupfinance.js';
import { Ledger } from './ledger.js';
import { buildChart, defineIntercompany } from './chart.js';
import { posting as ledgerPosting } from './ledger.js';
import { money } from './money.js';

const RATES: DatedFx[] = [
  { from: 'MYR', to: 'AED', numerator: 84n, denominator: 100n, asOf: '2026-09-01' },   // 0.84
  { from: 'MYR', to: 'AED', numerator: 82n, denominator: 100n, asOf: '2026-09-30' },   // 0.82 closing
  { from: 'USD', to: 'AED', numerator: 367n, denominator: 100n, asOf: '2026-09-01' },
];

function rates(): RateTable { return new RateTable('AED', RATES); }

/** A ledger with a UAE entity in AED and a Malaysian entity in MYR, plus an intercompany charge. */
function buildGroup() {
  const ledger = new Ledger('AED');
  const conv = buildChart(ledger, 'ALK-CONV', 'AED', []);
  const my = buildChart(ledger, 'ALK-MY', 'MYR', []);
  defineIntercompany(ledger, 'ALK-CONV', 'AED', ['ALK-MY']);
  defineIntercompany(ledger, 'ALK-MY', 'MYR', ['ALK-CONV']);

  // Conventional entity: premium income and cash.
  ledger.post({
    id: 'J-CONV-1', entityId: 'ALK-CONV', at: '2026-09-10T09:00:00+04:00', recordedAt: '2026-09-10T09:00:00+04:00',
    source: 'test', sourceRef: 'P-1', description: 'premium received',
    postings: [
      ledgerPosting(conv.cash(), 'debit', money(100_000_00n, 'AED')),
      ledgerPosting(conv.premiumIncome(), 'credit', money(100_000_00n, 'AED')),
    ],
  });

  // Malaysian entity: contribution income, and an intercompany fee charged to it by the UAE entity.
  // Foreign-currency postings carry their base-currency amount, which is exactly the discipline
  // the ledger enforces: MYR 200,000.00 at 0.82 is AED 164,000.00.
  ledger.post({
    id: 'J-MY-1', entityId: 'ALK-MY', at: '2026-09-15T09:00:00+08:00', recordedAt: '2026-09-15T09:00:00+08:00',
    source: 'test', sourceRef: 'P-2', description: 'contribution received MYR 200,000',
    postings: [
      ledgerPosting(my.cash(), 'debit', money(200_000_00n, 'MYR'), money(164_000_00n, 'AED')),
      ledgerPosting(my.premiumIncome(), 'credit', money(200_000_00n, 'MYR'), money(164_000_00n, 'AED')),
    ],
  });
  ledger.post({
    id: 'J-MY-2', entityId: 'ALK-MY', at: '2026-09-20T09:00:00+08:00', recordedAt: '2026-09-20T09:00:00+08:00',
    source: 'test', sourceRef: 'IC-1', description: 'intercompany management fee to the UAE entity',
    postings: [
      ledgerPosting(my.icExpense('ALK-CONV'), 'debit', money(20_000_00n, 'MYR'), money(16_400_00n, 'AED')),
      ledgerPosting(my.icPayable('ALK-CONV'), 'credit', money(20_000_00n, 'MYR'), money(16_400_00n, 'AED')),
    ],
  });
  ledger.post({
    id: 'J-CONV-2', entityId: 'ALK-CONV', at: '2026-09-20T09:00:00+04:00', recordedAt: '2026-09-20T09:00:00+04:00',
    source: 'test', sourceRef: 'IC-1', description: 'intercompany management fee from the Malaysian entity',
    postings: [
      // The two books do not agree on this one, on purpose: a classic in-transit difference.
      ledgerPosting(conv.icReceivable('ALK-MY'), 'debit', money(4_600_00n, 'AED')),
      ledgerPosting(conv.icIncome('ALK-MY'), 'credit', money(4_600_00n, 'AED')),
    ],
  });

  const entities: GroupEntitySpec[] = [
    { entityId: 'ALK-CONV', name: 'Conventional', functionalCurrency: 'AED', ownershipPct: 100, chart: conv },
    { entityId: 'ALK-MY', name: 'Malaysia', functionalCurrency: 'MYR', ownershipPct: 70, chart: my },
  ];
  let seq = 0;
  const consolidator = new GroupConsolidator(ledger, {
    groupCurrency: 'AED', groupEntityId: `GRP-${seq++}`, entities, rates: rates(),
  });
  return { ledger, conv, my, consolidator, entities };
}

describe('rate table', () => {
  it('uses the rate in force on the day, and can invert', () => {
    const t = rates();
    expect(t.rateAt('MYR', 'AED', '2026-09-29')).toMatchObject({ numerator: 84n, denominator: 100n });
    expect(t.rateAt('MYR', 'AED', '2026-09-30')).toMatchObject({ numerator: 82n, denominator: 100n });
    expect(t.rateAt('AED', 'MYR', '2026-09-30')).toMatchObject({ numerator: 100n, denominator: 82n });
    expect(t.rateAt('AED', 'AED', '2026-09-30')).toMatchObject({ numerator: 1n, denominator: 1n });
  });

  it('refuses to invent a rate it has never been given', () => {
    expect(() => rates().rateAt('MYR', 'AED', '2026-08-01')).toThrow(GroupError);
    expect(() => rates().rateAt('JPY', 'AED', '2026-09-30')).toThrow(/cannot invent one/);
  });

  it('averages the rates observed inside the period, exactly', () => {
    const average = rates().averageFor('MYR', 'AED', '2026-09-01', '2026-09-30');
    // (0.84 + 0.82) / 2 = 0.83 exactly: 83/100
    expect(Number(average.numerator) / Number(average.denominator)).toBeCloseTo(0.83, 10);
  });
});

describe('translation', () => {
  let world: ReturnType<typeof buildGroup>;
  beforeEach(() => { world = buildGroup(); });

  it('uses the closing rate for assets and liabilities and the average rate for income and expenses', () => {
    const [conv, my] = world.consolidator.translate('2026-09-30', '2026-09-01');
    // UAE entity is already in AED: no translation difference at all.
    expect(conv!.cta.minor).toBe(0n);
    expect(conv!.lines.find((l) => l.accountId === 'ALK-CONV:CASH')?.amount.minor).toBe(100_000_00n);

    const cash = my!.lines.find((l) => l.accountId === 'ALK-MY:CASH')!;
    expect(cash.rateBasis).toBe('closing');
    expect(cash.amount.minor).toBe(200_000_00n * 82n / 100n);      // MYR 200,000 at 0.82

    const income = my!.lines.find((l) => l.accountId === 'ALK-MY:PREMIUM-INCOME')!;
    expect(income.rateBasis).toBe('average');
    expect(income.amount.minor).toBe(200_000_00n * 83n / 100n);    // MYR 200,000 at the 0.83 average
  });

  it('produces a translation reserve equal to the gap the different rates leave', () => {
    const my = world.consolidator.translate('2026-09-30', '2026-09-01')[1]!;
    // net assets (cash at closing) less equity and result (income at average) = the reserve
    const expected = my.netAssets.minor - my.income.minor;
    expect(my.cta.minor).toBe(expected);
    expect(my.cta.minor).not.toBe(0n);
  });
});

describe('consolidation', () => {
  let world: ReturnType<typeof buildGroup>;
  beforeEach(() => { world = buildGroup(); });

  it('balances the group ledger and the consolidated balance sheet', () => {
    const report = world.consolidator.consolidate({ asOf: '2026-09-30', periodStart: '2026-09-01' });
    expect(report.group.balanced).toBe(true);
    expect(report.group.difference.minor).toBe(0n);
    expect(report.group.totals.assets.minor).toBeGreaterThan(0n);
    expect(report.group.checks.find((c) => c.check === 'group ledger proof')?.ok).toBe(true);
    expect(report.eliminations.journals.length).toBeGreaterThan(0);
    // The reserve is a real balance on the group ledger, not a report-only plug.
    expect(world.ledger.balance(world.consolidator.translationReserveAccount()).minor).not.toBe(0n);
  });

  it('eliminates the intercompany balance and reports the part that does not agree as in transit', () => {
    const report = world.consolidator.consolidate({ asOf: '2026-09-30', periodStart: '2026-09-01' });
    const pair = report.intercompany.balances.find((b) => b.receivableEntity === 'ALK-CONV' && b.payableEntity === 'ALK-MY')!;
    expect(pair.receivable.minor).toBe(4_600_00n);
    expect(pair.payable.minor).toBe(20_000_00n * 82n / 100n);       // MYR 20,000 at closing: 16,400.00
    expect(pair.eliminated.minor).toBe(pair.receivable.minor);      // the smaller of the two is what can be eliminated
    expect(report.eliminations.inTransit.minor).toBe(pair.payable.minor - pair.receivable.minor);
    expect(report.eliminations.notes.some((n) => n.includes('in transit'))).toBe(true);
    expect(report.group.checks.find((c) => c.check === 'intercompany eliminated')?.ok).toBe(false);   // honest: they do not agree
  });

  it('eliminates intercompany income and expense', () => {
    const report = world.consolidator.consolidate({ asOf: '2026-09-30', periodStart: '2026-09-01' });
    const trading = report.intercompany.incomeAndExpense.find((p) => p.earningEntity === 'ALK-CONV')!;
    expect(trading.income.minor).toBe(4_600_00n);
    expect(trading.expense.minor).toBe(20_000_00n * 83n / 100n);    // expense at the average rate
    expect(trading.eliminated.minor).toBe(trading.income.minor);
    expect(report.eliminations.journals.some((j) => j.startsWith('ELIMINATE-TRADING'))).toBe(true);
  });

  it('states the non-controlling interest instead of claiming the whole subsidiary', () => {
    const report = world.consolidator.consolidate({ asOf: '2026-09-30', periodStart: '2026-09-01' });
    const nci = report.nci.find((n) => n.entityId === 'ALK-MY')!;
    expect(nci.ownershipPct).toBe(70);
    expect(nci.minorityPct).toBe(30);
    const my = report.entities.find((e) => e.entityId === 'ALK-MY')!;
    expect(nci.shareOfNetAssets.minor).toBe(my.netAssets.minor * 30n / 100n);
    expect(report.group.attribution.owners.minor).toBe(report.group.netAssets.minor - nci.shareOfNetAssets.minor);
  });

  it('never touches the entity books', () => {
    const before = world.ledger.entriesFor('ALK-MY').length;
    const cashBefore = world.ledger.balance(world.my.cash());
    world.consolidator.consolidate({ asOf: '2026-09-30', periodStart: '2026-09-01' });
    expect(world.ledger.entriesFor('ALK-MY').length).toBe(before);
    expect(world.ledger.balance(world.my.cash()).minor).toBe(cashBefore.minor);
    expect(world.ledger.proof('ALK-MY').balanced).toBe(true);
    expect(world.ledger.proof('ALK-CONV').balanced).toBe(true);
  });

  it('is idempotent: consolidating twice posts nothing new and gives the same numbers', () => {
    const first = world.consolidator.consolidate({ asOf: '2026-09-30', periodStart: '2026-09-01' });
    const groupJournals = world.ledger.entriesFor(world.consolidator.entities()[0]!.entityId ? 'GRP-0' : 'GRP-0').length;
    const second = world.consolidator.consolidate({ asOf: '2026-09-30', periodStart: '2026-09-01' });
    expect(world.ledger.entriesFor('GRP-0').length).toBe(groupJournals);
    expect(second.group.balanced).toBe(true);
    expect(second.group.netAssets.minor).toBe(first.group.netAssets.minor);
    expect(second.group.totals.translationReserve.minor).toBe(first.group.totals.translationReserve.minor);
  });

  it('refuses an ownership percentage that makes no sense', () => {
    const ledger = new Ledger('AED');
    const chart = buildChart(ledger, 'E1', 'AED', []);
    expect(() => new GroupConsolidator(ledger, {
      groupCurrency: 'AED', groupEntityId: 'GRP-X',
      entities: [{ entityId: 'E1', name: 'E1', functionalCurrency: 'AED', ownershipPct: 120, chart }],
      rates: rates(),
    })).toThrow(/ownership must be/);
  });

  it('shows a single-currency group as a plain sum, with a zero translation reserve', () => {
    const ledger = new Ledger('AED');
    const conv = buildChart(ledger, 'ALK-CONV', 'AED', []);
    const tkf = buildChart(ledger, 'ALK-TKF', 'AED', []);
    for (const [entity, chart, amount] of [['ALK-CONV', conv, 1_000_00n], ['ALK-TKF', tkf, 250_00n]] as const) {
      ledger.post({
        id: `J-${entity}`, entityId: entity, at: '2026-09-10', recordedAt: '2026-09-10', source: 'test', sourceRef: 'S', description: 'premium',
        postings: [ledgerPosting(chart.cash(), 'debit', money(amount, 'AED')), ledgerPosting(chart.premiumIncome(), 'credit', money(amount, 'AED'))],
      });
    }
    const consolidator = new GroupConsolidator(ledger, {
      groupCurrency: 'AED', groupEntityId: 'GRP-AED',
      entities: [
        { entityId: 'ALK-CONV', name: 'Conventional', functionalCurrency: 'AED', ownershipPct: 100, chart: conv },
        { entityId: 'ALK-TKF', name: 'Takaful', functionalCurrency: 'AED', ownershipPct: 100, chart: tkf },
      ],
      rates: rates(),
    });
    const report = consolidator.consolidate({ asOf: '2026-09-30', periodStart: '2026-09-01' });
    expect(report.group.balanced).toBe(true);
    expect(report.group.totals.assets.minor).toBe(1_250_00n);
    expect(report.group.totals.translationReserve.minor).toBe(0n);
    expect(report.nci).toEqual([]);
    expect(report.eliminations.matched.minor).toBe(0n);
  });
});
