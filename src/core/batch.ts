/**
 * Batch processing — scheduled, event-based work over quotations and policies.
 *
 * One registry owns every recurring job the business asked for:
 *   quotation generation · illustration generation · policy issuance ·
 *   monthly-anniversary mortality (cost of insurance) · premium accrual ·
 *   commission accrual · commission clawback · fund management charges ·
 *   dividend distribution.
 *
 * Design rules (the same ones the rest of the core follows):
 *  - Every batch event is set up once as an EVENT-BASED ACCOUNTING definition: the debit and
 *    credit accounts it posts, its schedule, its basis and the policy states it applies to.
 *    A run never invents accounting — it resolves the definition filed for that event.
 *  - A subject is processed only while it is alive. The moment a policy lapses, is fully
 *    withdrawn or is surrendered (or a quotation expires/is declined), it leaves every later
 *    batch — terminal subjects are reported as skipped-with-reason, never charged.
 *  - Runs are idempotent and resumable: a run key is (job, period, subject). Re-running the
 *    same period produces duplicates-skipped, not double charges. A failed item can be retried
 *    without re-processing the items that already succeeded.
 *  - Amounts are integer minor units (bigint). No floats anywhere near money.
 */
import { parseAmount } from './money.js';

export type BatchEventType =
  | 'quotation-generation'
  | 'illustration-generation'
  | 'policy-issuance'
  | 'anniversary-mortality'
  | 'anniversary-premium-accrual'
  | 'anniversary-commission-accrual'
  | 'anniversary-clawback'
  | 'anniversary-fund-management-charge'
  | 'anniversary-dividend-distribution';

export type BatchSubjectKind = 'quotation' | 'policy';
export type BatchSubjectStatus =
  | 'quotation-open' | 'quotation-expired' | 'quotation-declined'
  | 'in-force' | 'paid-up' | 'lapsed' | 'fully-withdrawn' | 'surrendered' | 'matured' | 'claimed-out';

export const TERMINAL_SUBJECT_STATUSES: ReadonlyArray<BatchSubjectStatus> = [
  'quotation-expired', 'quotation-declined', 'lapsed', 'fully-withdrawn', 'surrendered', 'matured', 'claimed-out',
];

export interface BatchAccountingSetup {
  readonly debitAccount: string;
  readonly creditAccount: string;
  readonly descriptionTemplate: string; // {{subjectId}} {{period}} {{event}}
}

export interface BatchEventDefinition {
  readonly id: string;
  readonly eventType: BatchEventType;
  readonly label: string;
  readonly subjectKind: BatchSubjectKind;
  readonly schedule: string; // human + machine readable cadence
  readonly basis: string; // how the amount is derived
  readonly rateBps: number; // of the basis amount, where applicable
  readonly accounting: BatchAccountingSetup;
  readonly appliesToStatuses: ReadonlyArray<BatchSubjectStatus>;
  readonly enabled: boolean;
  readonly updatedAt: string;
  readonly updatedBy: string;
}

export interface BatchSubject {
  readonly id: string;
  readonly kind: BatchSubjectKind;
  readonly status: BatchSubjectStatus;
  readonly productId: string;
  readonly currency: string;
  readonly basisMinor: bigint; // sum assured (mortality), premium, fund value or dividend pool basis
  readonly anniversaryDay: number; // day of month the policy anniversary falls on
  readonly partnerId?: string;
  readonly fundId?: string;
}

export interface BatchLine {
  readonly subjectId: string;
  readonly eventType: BatchEventType;
  readonly period: string;
  readonly status: 'posted' | 'skipped-terminal' | 'skipped-not-due' | 'duplicate-skipped' | 'failed';
  readonly reason: string;
  readonly amountMinor: string;
  readonly currency: string;
  readonly debitAccount: string;
  readonly creditAccount: string;
  readonly voucherRef: string | null;
}

export interface BatchRun {
  readonly id: string;
  readonly jobId: string;
  readonly eventType: BatchEventType;
  readonly period: string; // YYYY-MM (or YYYY-MM-DD for generation jobs)
  readonly at: string;
  readonly by: string;
  readonly lines: ReadonlyArray<BatchLine>;
  readonly posted: number;
  readonly skipped: number;
  readonly duplicates: number;
  readonly failed: number;
  readonly totalMinorByCurrency: Readonly<Record<string, string>>;
  readonly idempotencyKey: string;
}

export class BatchError extends Error {}

const SETUP = (debitAccount: string, creditAccount: string, event: string): BatchAccountingSetup => ({
  debitAccount, creditAccount,
  descriptionTemplate: `${event} for {{subjectId}} in {{period}} (batch {{event}})`,
});

export const DEFAULT_BATCH_EVENTS: ReadonlyArray<Omit<BatchEventDefinition, 'id' | 'updatedAt' | 'updatedBy'>> = [
  { eventType: 'quotation-generation', label: 'Quotation generation', subjectKind: 'quotation', schedule: 'daily 06:00 + on-demand', basis: 'Open quotations due for (re)generation in the period', rateBps: 0, accounting: SETUP('1500-QUOTATION-CLEARING', '4100-QUOTATION-FEE-INCOME', 'Quotation generated'), appliesToStatuses: ['quotation-open'], enabled: true },
  { eventType: 'illustration-generation', label: 'Illustration generation', subjectKind: 'quotation', schedule: 'daily 06:15 + on-demand', basis: 'Open quotations needing a benefit illustration for the period', rateBps: 0, accounting: SETUP('1500-QUOTATION-CLEARING', '4110-ILLUSTRATION-INCOME', 'Illustration generated'), appliesToStatuses: ['quotation-open'], enabled: true },
  { eventType: 'policy-issuance', label: 'Policy issuance', subjectKind: 'quotation', schedule: 'daily 07:00 + on-demand', basis: 'Accepted quotations converted to in-force policies', rateBps: 0, accounting: SETUP('1510-POLICY-ISSUANCE-CLEARING', '4200-ISSUANCE-FEE-INCOME', 'Policy issued'), appliesToStatuses: ['quotation-open'], enabled: true },
  { eventType: 'anniversary-mortality', label: 'Monthly anniversary — mortality / cost of insurance', subjectKind: 'policy', schedule: 'monthly on each policy anniversary day', basis: 'rateBps of sum assured (basisMinor)', rateBps: 9, accounting: SETUP('5100-MORTALITY-CHARGE', '2100-POLICYHOLDER-FUND', 'Mortality charge'), appliesToStatuses: ['in-force', 'paid-up'], enabled: true },
  { eventType: 'anniversary-premium-accrual', label: 'Monthly anniversary — premium accrual', subjectKind: 'policy', schedule: 'monthly on each policy anniversary day', basis: 'rateBps of annual premium (basisMinor)', rateBps: 833, accounting: SETUP('1200-PREMIUM-RECEIVABLE', '4000-PREMIUM-INCOME', 'Premium accrued'), appliesToStatuses: ['in-force'], enabled: true },
  { eventType: 'anniversary-commission-accrual', label: 'Monthly anniversary — commission accrual', subjectKind: 'policy', schedule: 'monthly on each policy anniversary day', basis: 'rateBps of accrued premium (basisMinor)', rateBps: 1250, accounting: SETUP('5200-COMMISSION-EXPENSE', '2200-COMMISSION-PAYABLE', 'Commission accrued'), appliesToStatuses: ['in-force', 'paid-up'], enabled: true },
  { eventType: 'anniversary-clawback', label: 'Monthly anniversary — commission clawback', subjectKind: 'policy', schedule: 'monthly, and immediately on lapse/surrender detection run', basis: 'rateBps of commission at risk (basisMinor) for subjects leaving the book', rateBps: 2500, accounting: SETUP('2210-CLAWBACK-RECEIVABLE', '5200-COMMISSION-EXPENSE', 'Commission clawback'), appliesToStatuses: ['lapsed', 'surrendered', 'fully-withdrawn'], enabled: true },
  { eventType: 'anniversary-fund-management-charge', label: 'Monthly anniversary — fund management charge', subjectKind: 'policy', schedule: 'monthly on each policy anniversary day', basis: 'rateBps p.a. ÷ 12 of fund value (basisMinor)', rateBps: 150, accounting: SETUP('2100-POLICYHOLDER-FUND', '4300-FUND-MANAGEMENT-INCOME', 'Fund management charge'), appliesToStatuses: ['in-force', 'paid-up'], enabled: true },
  { eventType: 'anniversary-dividend-distribution', label: 'Monthly anniversary — dividend distribution', subjectKind: 'policy', schedule: 'monthly after dividend declaration', basis: 'rateBps of participating fund value (basisMinor)', rateBps: 40, accounting: SETUP('5300-DIVIDEND-EXPENSE', '2100-POLICYHOLDER-FUND', 'Dividend distributed'), appliesToStatuses: ['in-force', 'paid-up'], enabled: true },
];

function isAnniversaryDue(subject: BatchSubject, period: string): boolean {
  // period is YYYY-MM or YYYY-MM-DD; monthly jobs are due in that month on the anniversary day.
  const day = period.length > 7 ? Number(period.slice(8, 10)) : subject.anniversaryDay;
  return day === subject.anniversaryDay;
}

export class BatchRegistry {
  private definitions = new Map<BatchEventType, BatchEventDefinition>();
  private runs: BatchRun[] = [];
  private processed = new Set<string>(); // `${jobId}|${period}|${subjectId}`
  private runSeq = 0;
  private voucherSeq = 0;

  bootstrapDefaults(at = '2026-10-05T00:00:00+04:00', by = 'seed'): void {
    if (this.definitions.size) return;
    DEFAULT_BATCH_EVENTS.forEach((d, i) => this.definitions.set(d.eventType, { ...d, id: `BEV-${String(i + 1).padStart(3, '0')}`, updatedAt: at, updatedBy: by }));
  }

  listDefinitions(): BatchEventDefinition[] { return [...this.definitions.values()]; }

  upsertDefinition(input: Partial<BatchEventDefinition> & { eventType: BatchEventType; by?: string; at?: string; debitAccount?: string; creditAccount?: string }): BatchEventDefinition {
    const existing = this.definitions.get(input.eventType);
    if (!existing && (input.debitAccount === undefined && !input.accounting)) throw new BatchError(`event ${input.eventType} is not set up yet: file its debit/credit accounting before enabling it`);
    const base = existing ?? {
      id: `BEV-${String(this.definitions.size + 1).padStart(3, '0')}`,
      label: input.label ?? input.eventType, subjectKind: input.subjectKind ?? 'policy',
      schedule: input.schedule ?? 'monthly', basis: input.basis ?? 'filed basis', rateBps: input.rateBps ?? 0,
      accounting: input.accounting!, appliesToStatuses: input.appliesToStatuses ?? ['in-force'], enabled: input.enabled ?? true,
      eventType: input.eventType, updatedAt: '', updatedBy: '',
    };
    const next: BatchEventDefinition = {
      ...base, ...input,
      accounting: input.accounting ?? (input.debitAccount || input.creditAccount ? { debitAccount: input.debitAccount ?? base.accounting.debitAccount, creditAccount: input.creditAccount ?? base.accounting.creditAccount, descriptionTemplate: base.accounting.descriptionTemplate } : base.accounting),
      updatedAt: input.at ?? new Date().toISOString(), updatedBy: input.by ?? 'batch-admin',
    };
    this.definitions.set(next.eventType, next);
    return next;
  }

  run(input: { eventType: BatchEventType; period: string; subjects: ReadonlyArray<BatchSubject>; at?: string; by?: string; forceFailSubjectIds?: ReadonlyArray<string> }): BatchRun {
    const def = this.definitions.get(input.eventType);
    if (!def) throw new BatchError(`no batch event setup for ${input.eventType} — set up its event-based accounting first (Batch tab → Event setup)`);
    if (!def.enabled) throw new BatchError(`batch event ${input.eventType} is disabled in its setup — enable it before running`);
    if (!/^\d{4}-\d{2}(-\d{2})?$/.test(input.period)) throw new BatchError('period must be YYYY-MM (monthly jobs) or YYYY-MM-DD (generation jobs)');
    const at = input.at ?? new Date().toISOString();
    const by = input.by ?? 'batch-operator';
    const jobId = def.id;
    const lines: BatchLine[] = [];
    const totals = new Map<string, bigint>();

    for (const subject of input.subjects) {
      if (subject.kind !== def.subjectKind) continue;
      const key = `${jobId}|${input.period}|${subject.id}`;
      const clawbackRun = def.eventType === 'anniversary-clawback';
      const terminal = TERMINAL_SUBJECT_STATUSES.includes(subject.status);
      // Clawback is the one job that *targets* leavers; every other job must never touch them.
      if (terminal && !clawbackRun) {
        lines.push({ subjectId: subject.id, eventType: def.eventType, period: input.period, status: 'skipped-terminal', reason: `subject is ${subject.status} — batch events stop at lapse, full withdrawal, surrender, maturity or claim-out`, amountMinor: '0', currency: subject.currency, debitAccount: def.accounting.debitAccount, creditAccount: def.accounting.creditAccount, voucherRef: null });
        continue;
      }
      if (!def.appliesToStatuses.includes(subject.status)) {
        lines.push({ subjectId: subject.id, eventType: def.eventType, period: input.period, status: 'skipped-terminal', reason: `status ${subject.status} is not in the setup's applicable statuses (${def.appliesToStatuses.join(', ')})`, amountMinor: '0', currency: subject.currency, debitAccount: def.accounting.debitAccount, creditAccount: def.accounting.creditAccount, voucherRef: null });
        continue;
      }
      if (def.eventType.startsWith('anniversary-') && !clawbackRun && !isAnniversaryDue(subject, input.period)) {
        lines.push({ subjectId: subject.id, eventType: def.eventType, period: input.period, status: 'skipped-not-due', reason: `anniversary day ${subject.anniversaryDay} is not due in period ${input.period}`, amountMinor: '0', currency: subject.currency, debitAccount: def.accounting.debitAccount, creditAccount: def.accounting.creditAccount, voucherRef: null });
        continue;
      }
      if (this.processed.has(key)) {
        lines.push({ subjectId: subject.id, eventType: def.eventType, period: input.period, status: 'duplicate-skipped', reason: 'already processed for this job + period (idempotency key) — not charged twice', amountMinor: '0', currency: subject.currency, debitAccount: def.accounting.debitAccount, creditAccount: def.accounting.creditAccount, voucherRef: null });
        continue;
      }
      if ((input.forceFailSubjectIds ?? []).includes(subject.id)) {
        lines.push({ subjectId: subject.id, eventType: def.eventType, period: input.period, status: 'failed', reason: 'simulated posting failure — safe to retry this item only', amountMinor: '0', currency: subject.currency, debitAccount: def.accounting.debitAccount, creditAccount: def.accounting.creditAccount, voucherRef: null });
        continue;
      }
      const monthlyDivisor = def.eventType === 'anniversary-fund-management-charge' ? 12n : 1n;
      const amount = def.rateBps === 0 ? 0n : (subject.basisMinor * BigInt(def.rateBps)) / 10_000n / monthlyDivisor;
      this.processed.add(key);
      const voucherRef = `BVCH-${String(++this.voucherSeq).padStart(7, '0')}`;
      totals.set(subject.currency, (totals.get(subject.currency) ?? 0n) + amount);
      lines.push({ subjectId: subject.id, eventType: def.eventType, period: input.period, status: 'posted', reason: def.accounting.descriptionTemplate.replace('{{subjectId}}', subject.id).replace('{{period}}', input.period).replace('{{event}}', def.eventType), amountMinor: amount.toString(), currency: subject.currency, debitAccount: def.accounting.debitAccount, creditAccount: def.accounting.creditAccount, voucherRef });
    }

    const run: BatchRun = {
      id: `BRUN-${String(++this.runSeq).padStart(6, '0')}`, jobId, eventType: def.eventType, period: input.period, at, by,
      lines,
      posted: lines.filter((l) => l.status === 'posted').length,
      skipped: lines.filter((l) => l.status === 'skipped-terminal' || l.status === 'skipped-not-due').length,
      duplicates: lines.filter((l) => l.status === 'duplicate-skipped').length,
      failed: lines.filter((l) => l.status === 'failed').length,
      totalMinorByCurrency: Object.fromEntries([...totals.entries()].map(([c, v]) => [c, v.toString()])),
      idempotencyKey: `${jobId}:${input.period}`,
    };
    this.runs.push(run);
    return run;
  }

  listRuns(limit = 20): BatchRun[] { return [...this.runs].slice(-limit).reverse(); }

  snapshot(subjects: ReadonlyArray<BatchSubject> = []) {
    return {
      definitions: this.listDefinitions(),
      runs: this.listRuns(),
      subjects,
      terminalStatuses: TERMINAL_SUBJECT_STATUSES,
      rule: 'Every event needs a filed debit/credit setup before it can run. A quotation or policy is processed only while alive: lapse, full withdrawal, surrender, maturity, claim-out, expired or declined stops all later batches (reported as skipped-terminal). Clawback is the exception — it targets leavers to recover commission. Re-running a period is safe: job + period + subject is the idempotency key.',
    };
  }

  stats() {
    return { definitions: this.definitions.size, enabled: this.listDefinitions().filter((d) => d.enabled).length, runs: this.runs.length, processedKeys: this.processed.size, postedLines: this.runs.reduce((n, r) => n + r.posted, 0) };
  }
}

/** Build batch subjects from the ERP snapshot shapes the world already exposes. */
export function batchSubjectsFromWorld(erp: { policies: ReadonlyArray<Record<string, unknown>>; proposals: ReadonlyArray<Record<string, unknown>> }): BatchSubject[] {
  const parseMinor = (label: unknown): bigint => {
    // Snapshot labels are formatted amounts ("250,000.00 AED"): parse them with the exact money
    // parser (currency-aware scale), never regex + float. A label that is not an amount (e.g.
    // "—" for a proposal with no sum assured yet) reads as zero basis.
    const text = String(label ?? '').trim();
    const currency = text.match(/\b([A-Z]{3})$/)?.[1] ?? 'AED';
    const numeric = text.replace(/\s+[A-Z]{3}$/, '').replace(/,/g, '').trim();
    if (numeric === '' || numeric === '—') return 0n;
    try { return parseAmount(numeric, currency).minor; } catch { return 0n; }
  };
  const statusOf = (raw: string): BatchSubjectStatus => {
    const s = raw.toLowerCase();
    if (s.includes('surrender')) return 'surrendered';
    if (s.includes('lapse')) return 'lapsed';
    if (s.includes('withdraw')) return 'fully-withdrawn';
    if (s.includes('matur')) return 'matured';
    if (s.includes('paid-up') || s.includes('paid up')) return 'paid-up';
    return 'in-force';
  };
  const subjects: BatchSubject[] = erp.policies.map((p, i) => ({
    id: String(p['policyId']), kind: 'policy' as const, status: statusOf(String(p['status'])),
    productId: String(p['productId']), currency: String(p['currency'] ?? 'AED'),
    basisMinor: parseMinor(p['sumAssured']), anniversaryDay: (i % 28) + 1,
    fundId: 'FGLOBAL',
  }));
  for (const q of erp.proposals) {
    subjects.push({
      id: `QT-${String(q['applicationId'])}`, kind: 'quotation', status: q['decided'] ? 'quotation-open' : 'quotation-open',
      productId: String(q['productId']), currency: 'AED', basisMinor: parseMinor(q['sumAssured']), anniversaryDay: 1,
    });
  }
  // Demo terminal subjects so the stop-rule is visible, not just described.
  subjects.push(
    { id: 'UL-LAPSED-001', kind: 'policy', status: 'lapsed', productId: 'PROD-UL-GLOBAL', currency: 'AED', basisMinor: 500_000_00n, anniversaryDay: 5, fundId: 'FGLOBAL' },
    { id: 'UL-SURR-001', kind: 'policy', status: 'surrendered', productId: 'PROD-UL-GLOBAL', currency: 'AED', basisMinor: 750_000_00n, anniversaryDay: 5, fundId: 'FGLOBAL' },
    { id: 'UL-WD-001', kind: 'policy', status: 'fully-withdrawn', productId: 'PROD-UL-GLOBAL', currency: 'AED', basisMinor: 250_000_00n, anniversaryDay: 5, fundId: 'FGLOBAL' },
  );
  return subjects;
}
