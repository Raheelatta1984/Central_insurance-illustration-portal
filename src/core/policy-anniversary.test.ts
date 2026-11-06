import { describe, expect, it } from 'vitest';
import { monthlyPolicyAnniversaries } from './policy-anniversary.js';

describe('monthly policy anniversary calendar', () => {
  it('moves a missing day to the first of the following month without losing its cycle', () => {
    expect(monthlyPolicyAnniversaries('2025-01-31', '2025-02-01', '2025-04-30')).toEqual([
      { cycle: '2025-02', dueDate: '2025-03-01' },
      { cycle: '2025-03', dueDate: '2025-03-31' },
    ]);
    expect(monthlyPolicyAnniversaries('2024-01-29', '2024-02-01', '2024-03-01')).toEqual([
      { cycle: '2024-02', dueDate: '2024-02-29' },
    ]);
    expect(monthlyPolicyAnniversaries('2025-01-31', '2025-03-01', '2025-03-01')).toEqual([
      { cycle: '2025-02', dueDate: '2025-03-01' },
    ]);
  });
  it('never schedules before the first monthly anniversary and rejects invalid dates', () => {
    expect(monthlyPolicyAnniversaries('2026-05-12', '2026-01-01', '2026-06-12')).toEqual([{ cycle: '2026-06', dueDate: '2026-06-12' }]);
    expect(() => monthlyPolicyAnniversaries('2026-02-30', '2026-03-01', '2026-04-01')).toThrow();
    expect(() => monthlyPolicyAnniversaries('2026-01-01', '2026-05-01', '2026-04-01')).toThrow();
  });
});
