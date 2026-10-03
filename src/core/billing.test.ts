import { describe, expect, it } from 'vitest';
import { BillingEngine, BillingError } from './billing.js';
import { money } from './money.js';

const CUR = 'AED';
const rate = money(1_250n, CUR);        // 12.50 per day

function engineWithWallet() {
  const billing = new BillingEngine(CUR);
  billing.openWallet('M1', money(100_000n, CUR));
  return billing;
}

describe('billing — micro-duration cover', () => {
  it('charges nothing until cover is explicitly started', () => {
    const billing = engineWithWallet();
    const seg = billing.createSegment({ policyId: 'M1', productId: 'P', mode: 'start-stop', dailyRate: rate, tariffVersion: 'v1', autoStart: false, graceDays: 0 });
    expect(seg.status).toBe('scheduled');
    expect(billing.tick('2026-10-10T12:00:00Z')).toHaveLength(0);
    expect(billing.wallet('M1').balance.minor).toBe(100_000n);
  });

  it('does not restart by itself after a stop when auto-start is off', () => {
    const billing = engineWithWallet();
    const seg = billing.createSegment({ policyId: 'M1', productId: 'P', mode: 'start-stop', dailyRate: rate, tariffVersion: 'v1', autoStart: false, graceDays: 0 });
    billing.startCover(seg.id, '2026-10-01T08:00:00Z');
    const first = billing.tick('2026-10-03T09:00:00Z');
    expect(first).toHaveLength(2);                        // two midnights inside the window
    billing.stopCover(seg.id, '2026-10-03T10:00:00Z');
    const afterStop = billing.tick('2026-10-06T09:00:00Z');
    expect(afterStop).toHaveLength(0);
    expect(billing.segment(seg.id).status).toBe('ended');
    expect(billing.wallet('M1').balance.minor).toBe(100_000n - 2n * 1_250n);
  });

  it('renews daily at midnight when the customer elected it', () => {
    const billing = engineWithWallet();
    const seg = billing.createSegment({ policyId: 'M1', productId: 'P', mode: 'daily', dailyRate: rate, tariffVersion: 'v1', autoStart: true, graceDays: 0 });
    billing.startCover(seg.id, '2026-10-01T08:00:00Z');
    const raised = billing.tick('2026-10-04T09:00:00Z');
    expect(raised).toHaveLength(3);
    expect(billing.segment(seg.id).status).toBe('active');
    expect(raised.every((e) => e.note.includes('daily renewal'))).toBe(true);
  });

  it('is idempotent: re-running the clock never double-charges', () => {
    const billing = engineWithWallet();
    const seg = billing.createSegment({ policyId: 'M1', productId: 'P', mode: 'daily', dailyRate: rate, tariffVersion: 'v1', autoStart: true, graceDays: 0 });
    billing.startCover(seg.id, '2026-10-01T08:00:00Z');
    billing.tick('2026-10-04T09:00:00Z');
    const balanceAfterFirst = billing.wallet('M1').balance.minor;
    expect(billing.tick('2026-10-04T09:00:00Z')).toHaveLength(0);
    expect(billing.wallet('M1').balance.minor).toBe(balanceAfterFirst);
    expect(billing.chargeEvents('M1')).toHaveLength(3);
  });

  it('honours a scheduled start and a scheduled stop, and can cancel the stop', () => {
    const billing = engineWithWallet();
    const seg = billing.createSegment({ policyId: 'M1', productId: 'P', mode: 'start-stop', dailyRate: rate, tariffVersion: 'v1', autoStart: true, graceDays: 0 });
    billing.scheduleStart(seg.id, '2026-10-10T00:00:00Z');
    billing.scheduleStop(seg.id, '2026-10-12T00:00:00Z');
    expect(billing.tick('2026-10-09T12:00:00Z')).toHaveLength(0);
    expect(billing.segment(seg.id).status).toBe('scheduled');
    const started = billing.tick('2026-10-11T12:00:00Z');
    expect(started.length).toBeGreaterThan(0);
    expect(billing.segment(seg.id).status).toBe('active');
    billing.cancelScheduledStop(seg.id);
    expect(billing.segment(seg.id).scheduledStopAt).toBeUndefined();
    billing.scheduleStop(seg.id, '2026-10-12T00:00:00Z');
    billing.tick('2026-10-12T01:00:00Z');
    expect(billing.segment(seg.id).status).toBe('paused');
  });

  it('prices pay-as-you-go usage and refuses when the wallet is empty', () => {
    const billing = engineWithWallet();
    const seg = billing.createSegment({ policyId: 'M1', productId: 'P', mode: 'payg', dailyRate: money(0n, CUR), usageRatePerUnit: money(35n, CUR), tariffVersion: 'v1', autoStart: false, graceDays: 0 });
    billing.startCover(seg.id, '2026-10-01T08:00:00Z');
    const ev = billing.recordUsage({ segmentId: seg.id, units: 200, at: '2026-10-01T18:00:00Z' });
    expect(ev.amount.minor).toBe(7_000n);
    expect(billing.wallet('M1').balance.minor).toBe(93_000n);
    expect(() => billing.recordUsage({ segmentId: seg.id, units: 10_000, at: '2026-10-01T19:00:00Z' })).toThrow(BillingError);
    expect(billing.wallet('M1').balance.minor).toBe(93_000n);
  });

  it('suspends cover instead of charging into a negative wallet', () => {
    const billing = new BillingEngine(CUR);
    billing.openWallet('M2', money(1_000n, CUR));
    const seg = billing.createSegment({ policyId: 'M2', productId: 'P', mode: 'daily', dailyRate: rate, tariffVersion: 'v1', autoStart: true, graceDays: 0 });
    billing.startCover(seg.id, '2026-10-01T08:00:00Z');
    const raised = billing.tick('2026-10-05T09:00:00Z');
    expect(raised.some((e) => e.note.includes('suspended'))).toBe(true);
    expect(billing.segment(seg.id).status).toBe('suspended');
    expect(billing.wallet('M2').balance.minor).toBe(1_000n);   // nothing is part-charged: either a full day is paid or cover suspends
    expect(billing.chargeEvents('M2').filter((e) => e.amount.minor > 0n)).toHaveLength(0);
  });

  it('refunds pro rata on an early stop and keeps the statement honest', () => {
    const billing = engineWithWallet();
    const seg = billing.createSegment({ policyId: 'M1', productId: 'P', mode: 'daily', dailyRate: rate, tariffVersion: 'v1', autoStart: true, graceDays: 0 });
    billing.startCover(seg.id, '2026-10-01T08:00:00Z');
    billing.tick('2026-10-04T09:00:00Z');
    const refund = billing.proRataRefund(seg.id, '2026-10-04T10:00:00Z', 0);
    expect(refund.amount.minor).toBeGreaterThan(0n);
    const statement = billing.statement('M1');
    expect(statement.total.minor).toBe(3n * 1_250n - refund.amount.minor);
    expect(statement.balance.minor).toBe(billing.wallet('M1').balance.minor);
  });
});
