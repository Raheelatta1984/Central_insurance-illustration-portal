import { describe, expect, it } from 'vitest';
import { buildWorld } from './demo.js';
import { money } from './money.js';
import { buildUnitLinkedStatement, splitMoneyByWeights, validateBpsWeights } from './unitlinked-statement.js';

describe('unit-linked statement and allocations', () => {
  it('allocates every minor unit and rejects invalid weights', () => {
    const weights = [{ fundId: 'A', bps: 7000 }, { fundId: 'B', bps: 3000 }];
    const legs = splitMoneyByWeights(money(101n, 'AED'), weights);
    expect(legs.reduce((sum, leg) => sum + leg.amount.minor, 0n)).toBe(101n);
    expect(validateBpsWeights([{ fundId: 'A', bps: 5000 }, { fundId: 'A', bps: 5000 }]).valid).toBe(false);
    expect(() => splitMoneyByWeights(money(101n, 'AED'), [{ fundId: 'A', bps: 2000 }])).toThrow();
  });

  it('builds a reproducible statement for the seeded unit-linked policy', () => {
    const world = buildWorld();
    const statement = buildUnitLinkedStatement(world, 'UL-000123');
    expect(statement.policyId).toBe('UL-000123');
    expect(world.unitLinked.reproduce('UL-000123').ok).toBe(true);
    const times = statement.lines.map((line) => Date.parse(line.at));
    expect(times).toEqual([...times].sort((a, b) => a - b));
    expect(statement.recommendedFunds).toBeNull();
    expect(statement.fundHistory[0]).toMatchObject({ date: '2026-09-29', daysSinceCommencement: 0 });
    expect(statement.fundHistory.at(-1)?.funds.map((fund) => fund.fundId).sort()).toEqual(['FBAL', 'FGLOBAL']);
    expect(() => buildUnitLinkedStatement(world, 'MTR-0441')).toThrow();
  });
});
