import { describe, expect, it } from 'vitest';
import { monthlyPolicyAnniversaries } from './policy-anniversary.js';

describe('monthly policy anniversary calendar', () => {
  it('clamps 31 January to each month end without drifting after February', () => {
    expect(monthlyPolicyAnniversaries('2025-01-31', '2025-02-01', '2025-05-31')).toEqual([
      { cycle: '2025-02', dueDate: '2025-02-28' },
      { cycle: '2025-03', dueDate: '2025-03-31' },
      { cycle: '2025-04', dueDate: '2025-04-30' },
      { cycle: '2025-05', dueDate: '2025-05-31' },
    ]);
    expect(monthlyPolicyAnniversaries('2024-01-31', '2024-02-01', '2024-02-29')).toEqual([{ cycle: '2024-02', dueDate: '2024-02-29' }]);
    expect(monthlyPolicyAnniversaries('2025-01-31', '2025-03-01', '2025-03-01')).toEqual([]);
  });
  it('returns to day 30 after February for a 30 January commencement', () => {
    expect(monthlyPolicyAnniversaries('2025-01-30', '2025-02-01', '2025-04-30')).toEqual([
      { cycle: '2025-02', dueDate: '2025-02-28' },
      { cycle: '2025-03', dueDate: '2025-03-30' },
      { cycle: '2025-04', dueDate: '2025-04-30' },
    ]);
  });
  it('does not treat February month-end as an instruction to use later month-ends', () => {
    expect(monthlyPolicyAnniversaries('2025-02-28', '2025-03-01', '2025-03-31')).toEqual([{ cycle: '2025-03', dueDate: '2025-03-28' }]);
    expect(monthlyPolicyAnniversaries('2024-02-29', '2024-03-01', '2024-03-31')).toEqual([{ cycle: '2024-03', dueDate: '2024-03-29' }]);
    expect(monthlyPolicyAnniversaries('2024-02-29', '2025-02-01', '2025-03-31')).toEqual([{ cycle: '2025-02', dueDate: '2025-02-28' }, { cycle: '2025-03', dueDate: '2025-03-29' }]);
  });
  it('never schedules before the first monthly anniversary and rejects invalid dates', () => {
    expect(monthlyPolicyAnniversaries('2026-05-12', '2026-01-01', '2026-06-12')).toEqual([{ cycle: '2026-06', dueDate: '2026-06-12' }]);
    expect(() => monthlyPolicyAnniversaries('2026-02-30', '2026-03-01', '2026-04-01')).toThrow();
    expect(() => monthlyPolicyAnniversaries('2026-01-01', '2026-05-01', '2026-04-01')).toThrow();
  });
});
