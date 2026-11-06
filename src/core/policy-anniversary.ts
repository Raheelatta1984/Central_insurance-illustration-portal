/**
 * Calendar-only monthly policy anniversaries. The caller supplies dates in the policy's local
 * calendar; this module does not infer a timezone or post charges. Use the commencement day in
 * each month, or that month's last day when the commencement day does not exist. The original
 * commencement day is retained, so a February adjustment does not shift subsequent months.
 */
export class PolicyAnniversaryError extends Error {}

export interface PolicyAnniversary {
  readonly cycle: string;
  readonly dueDate: string;
}

function dateParts(value: string): { year: number; month: number; day: number } {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) throw new PolicyAnniversaryError(`Invalid calendar date: ${value}`);
  const [year, month, day] = value.split('-').map(Number) as [number, number, number];
  const date = new Date(Date.UTC(year, month - 1, day));
  if (year < 100 || date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) {
    throw new PolicyAnniversaryError(`Invalid calendar date: ${value}`);
  }
  return { year, month, day };
}

/** Enumerate due monthly cycles within an inclusive range, beginning one month after commencement. */
export function monthlyPolicyAnniversaries(commencement: string, from: string, through: string): PolicyAnniversary[] {
  const start = dateParts(commencement);
  dateParts(from);
  dateParts(through);
  if (from > through) throw new PolicyAnniversaryError('Start date must not be after end date');
  const first = start.year * 12 + start.month - 1;
  const fromParts = dateParts(from);
  const toParts = dateParts(through);
  const minCycle = Math.max(first + 1, fromParts.year * 12 + fromParts.month - 1);
  const maxCycle = toParts.year * 12 + toParts.month - 1;
  if (maxCycle - minCycle > 12000) throw new PolicyAnniversaryError('Date range is too large');
  const output: PolicyAnniversary[] = [];
  for (let cycleMonth = minCycle; cycleMonth <= maxCycle; cycleMonth += 1) {
    const year = Math.floor(cycleMonth / 12);
    const month = cycleMonth % 12 + 1;
    const lastDay = new Date(Date.UTC(year, month, 0)).getUTCDate();
    const due = new Date(Date.UTC(year, month - 1, Math.min(start.day, lastDay)));
    const dueDate = due.toISOString().slice(0, 10);
    if (dueDate >= from && dueDate <= through) output.push({ cycle: `${year}-${String(month).padStart(2, '0')}`, dueDate });
  }
  return output;
}
