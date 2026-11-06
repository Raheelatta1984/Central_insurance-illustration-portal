import { describe, expect, it } from 'vitest';
import { buildWorld } from './demo.js';
import { money } from './money.js';
import { calculateSpareChangeRoundUp } from './roundup.js';

describe('spare-change round-up', () => {
  it('rounds in minor units and supports exact matches and multipliers', () => {
    const result = calculateSpareChangeRoundUp({ purchaseAmount: money(450n, 'AED'), roundStepMajor: 1, multiplier: 2 });
    expect(result.roundedAmount.minor).toBe(500n);
    expect(result.baseSpareChange.minor).toBe(50n);
    expect(result.redirectedAmount.minor).toBe(100n);
    expect(calculateSpareChangeRoundUp({ purchaseAmount: money(500n, 'AED'), roundStepMajor: 1 }).redirectedAmount.minor).toBe(0n);
    expect(calculateSpareChangeRoundUp({ purchaseAmount: money(500n, 'AED'), roundStepMajor: 1, exactMatchRule: 'add-full-step' }).redirectedAmount.minor).toBe(100n);
  });

  it('rejects fractional round-up steps and preserves settings on rejected changes', () => {
    expect(() => calculateSpareChangeRoundUp({ purchaseAmount: money(450n, 'AED'), roundStepMajor: 1.5 })).toThrow();
    const world = buildWorld();
    const before = world.roundUp.snapshot(world).settings[0];
    expect(() => world.roundUp.configureSettings(world, { policyId: 'UL-000123', roundStepMajor: 3, multiplier: 1.5 })).toThrow();
    expect(world.roundUp.snapshot(world).settings[0]).toEqual(before);
  });

  it('does not expose the seeded card number in its snapshot', () => {
    const world = buildWorld();
    expect(JSON.stringify(world.roundUp.snapshot(world))).not.toContain('4532015112830366');
  });
});
