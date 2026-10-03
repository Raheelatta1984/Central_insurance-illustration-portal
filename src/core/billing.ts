/**
 * Billing and collections for micro-duration cover.
 *
 * The primitive is the cover SEGMENT: cover and charge exist only between an explicit start
 * and an explicit stop. Two behaviours are supported and both are explicit:
 *   - autoStart = true  : a daily renewal — cover reactivates at 00:00 each day until stopped;
 *   - autoStart = false : a scheduled policy — after a stop, cover stays stopped. Nothing
 *     restarts silently at midnight, which is the behaviour regulators dislike.
 */
import { Money, add, applyBps, compare, money, multiply, sub, sum, zero, formatAmount } from './money.js';

export type BillingMode = 'annual' | 'instalment' | 'monthly' | 'daily' | 'payg' | 'start-stop';
export type SegmentStatus = 'scheduled' | 'active' | 'paused' | 'ended' | 'suspended';

export interface CoverSegment {
  readonly id: string;
  readonly policyId: string;
  readonly productId: string;
  readonly mode: BillingMode;
  readonly dailyRate: Money;
  readonly usageRatePerUnit?: Money;      // pay-as-you-go rate per km / per trip / per hour
  readonly tariffVersion: string;
  startAt?: string;                        // ISO timestamp; unset = scheduled for the future
  endAt?: string;
  status: SegmentStatus;
  readonly autoStart: boolean;
  readonly graceDays: number;
  scheduledStartAt?: string;
  scheduledStopAt?: string;
}

export interface ChargeEvent {
  readonly id: string;
  readonly policyId: string;
  readonly segmentId: string;
  readonly kind: 'cover-day' | 'usage' | 'fee' | 'refund';
  readonly at: string;
  readonly amount: Money;
  readonly tariffVersion: string;
  readonly note: string;
}

export interface WalletAccount { readonly policyId: string; balance: Money; readonly currency: string }

export class BillingError extends Error {}

let seq = 0;
const nextId = (p: string) => `${p}-${String(++seq).padStart(6, '0')}`;

export class BillingEngine {
  private readonly segments = new Map<string, CoverSegment>();
  private readonly events: ChargeEvent[] = [];
  private readonly wallets = new Map<string, WalletAccount>();

  constructor(private readonly currency: string) {}

  openWallet(policyId: string, opening: Money): WalletAccount {
    if (opening.currency !== this.currency) throw new BillingError(`wallet currency ${opening.currency} != engine currency ${this.currency}`);
    const acct = { policyId, balance: opening, currency: this.currency };
    this.wallets.set(policyId, acct);
    return acct;
  }

  wallet(policyId: string): WalletAccount {
    const w = this.wallets.get(policyId);
    if (!w) throw new BillingError(`no wallet for ${policyId}`);
    return w;
  }

  private credit(policyId: string, amount: Money): void {
    const w = this.wallet(policyId);
    this.wallets.set(policyId, { ...w, balance: add(w.balance, amount) });
  }

  createSegment(input: Omit<CoverSegment, 'id' | 'status'> & { status?: SegmentStatus }): CoverSegment {
    const segment: CoverSegment = { ...input, id: nextId('SEG'), status: input.status ?? (input.startAt ? 'active' : 'scheduled') };
    if (!segment.autoStart && segment.startAt && !input.startAt) segment.status = 'scheduled';
    this.segments.set(segment.id, segment);
    return segment;
  }

  segment(id: string): CoverSegment { const s = this.segments.get(id); if (!s) throw new BillingError(`unknown segment ${id}`); return s; }
  segmentsFor(policyId: string): CoverSegment[] { return [...this.segments.values()].filter((s) => s.policyId === policyId); }
  allSegments(): CoverSegment[] { return [...this.segments.values()]; }
  chargeEvents(policyId?: string): ChargeEvent[] { return policyId ? this.events.filter((e) => e.policyId === policyId) : [...this.events]; }

  /** Explicit start (today or in the future). */
  startCover(segmentId: string, at: string): CoverSegment {
    const s = this.segment(segmentId);
    this.segments.set(segmentId, { ...s, startAt: at, status: 'active', scheduledStartAt: undefined });
    return this.segment(segmentId);
  }

  /** Explicit stop. Scheduled stops are honoured by tick(); manual stops take effect immediately. */
  stopCover(segmentId: string, at: string): CoverSegment {
    const s = this.segment(segmentId);
    this.segments.set(segmentId, { ...s, endAt: at, status: 'paused', scheduledStopAt: undefined });
    return this.segment(segmentId);
  }

  scheduleStart(segmentId: string, at: string): CoverSegment {
    const s = this.segment(segmentId);
    if (s.status === 'active') throw new BillingError('segment is already active');
    this.segments.set(segmentId, { ...s, scheduledStartAt: at, status: 'scheduled' });
    return this.segment(segmentId);
  }

  scheduleStop(segmentId: string, at: string): CoverSegment {
    const s = this.segment(segmentId);
    this.segments.set(segmentId, { ...s, scheduledStopAt: at });
    return this.segment(segmentId);
  }

  cancelScheduledStop(segmentId: string): CoverSegment {
    const s = this.segment(segmentId);
    this.segments.set(segmentId, { ...s, scheduledStopAt: undefined });
    return this.segment(segmentId);
  }

  /**
   * Advance the clock. Charges one day at a time, only for days inside an active window.
   * Returns the events raised. Idempotent: re-running tick for a past time raises nothing new.
   */
  tick(nowIso: string): ChargeEvent[] {
    const raised: ChargeEvent[] = [];
    for (const s of this.allSegments()) {
      const schedStart = s.scheduledStartAt && s.scheduledStartAt <= nowIso ? s.scheduledStartAt : undefined;
      const schedStop = s.scheduledStopAt && s.scheduledStopAt <= nowIso ? s.scheduledStopAt : undefined;
      let current: CoverSegment = { ...s };
      if (schedStart && current.status !== 'active') current = { ...current, startAt: schedStart, status: 'active', scheduledStartAt: undefined };
      if (schedStop) current = { ...current, endAt: schedStop, status: 'paused', scheduledStopAt: undefined };
      if (current.status === 'active' && current.startAt) {
        const from = current.startAt;
        const to = current.endAt && current.endAt < nowIso ? current.endAt : nowIso;
        for (const day of this.dayBoundaries(from, to)) {
          if (this.events.some((e) => e.segmentId === current.id && e.kind === 'cover-day' && e.at === day)) continue;
          const amount = current.dailyRate;
          const ev: ChargeEvent = {
            id: nextId('CHG'), policyId: current.policyId, segmentId: current.id, kind: 'cover-day',
            at: day, amount, tariffVersion: current.tariffVersion,
            note: `Daily cover charged for the day starting ${day.slice(0, 10)}${current.autoStart ? ' (daily renewal)' : ' (explicit start)'}`,
          };
          const wallet = this.wallet(current.policyId);
          if (compare(wallet.balance, amount) < 0) {
            current = { ...current, status: 'suspended' };
            raised.push({ ...ev, id: nextId('CHG'), amount: zero(this.currency), note: `Insufficient wallet balance ${formatAmount(wallet.balance)} for ${formatAmount(amount)} — cover suspended, no charge raised` });
            break;
          }
          this.credit(current.policyId, multiply(amount, -1));
          this.events.push(ev);
          raised.push(ev);
        }
      }
      // A stopped segment whose end is in the past is simply ended — it never restarts by itself.
      if (current.status === 'paused' && current.endAt && current.endAt <= nowIso && !current.autoStart) {
        current = { ...current, status: 'ended' };
      }
      this.segments.set(current.id, current);
    }
    return raised;
  }

  /** Pay-as-you-go usage (km driven, trips, hours) priced at the tariff rate. */
  recordUsage(input: { segmentId: string; units: number; at: string; note?: string }): ChargeEvent {
    const s = this.segment(input.segmentId);
    if (s.status !== 'active') throw new BillingError('cannot record usage on a segment that is not active');
    if (!s.usageRatePerUnit) throw new BillingError('segment has no usage rate — it is not a pay-as-you-go tariff');
    const amount = multiply(s.usageRatePerUnit, input.units);
    const wallet = this.wallet(s.policyId);
    if (compare(wallet.balance, amount) < 0) throw new BillingError(`insufficient wallet balance for usage charge ${formatAmount(amount)}`);
    this.credit(s.policyId, multiply(amount, -1));
    const ev: ChargeEvent = {
      id: nextId('CHG'), policyId: s.policyId, segmentId: s.id, kind: 'usage', at: input.at, amount,
      tariffVersion: s.tariffVersion, note: input.note ?? `${input.units} units at ${formatAmount(s.usageRatePerUnit)}`,
    };
    this.events.push(ev);
    return ev;
  }

  topUpWallet(policyId: string, amount: Money, at: string): ChargeEvent {
    this.credit(policyId, amount);
    const ev: ChargeEvent = { id: nextId('CHG'), policyId, segmentId: '-', kind: 'fee', at, amount, tariffVersion: 'n/a', note: 'Wallet top-up' };
    this.events.push(ev);
    return ev;
  }

  /** Pro-rata refund of unearned cover when a customer stops early. */
  proRataRefund(segmentId: string, at: string, shortRateBps = 0): ChargeEvent {
    const s = this.segment(segmentId);
    const paid = sum(this.events.filter((e) => e.segmentId === segmentId && e.kind === 'cover-day').map((e) => e.amount), this.currency);
    const days = this.dayBoundaries(s.startAt ?? at, at).length;
    const refundBps = Math.max(0, 10000 - shortRateBps);
    const refund = applyBps(money((paid.minor * BigInt(refundBps)) / 10000n, this.currency), 10000 / Math.max(days, 1));
    const ev: ChargeEvent = {
      id: nextId('CHG'), policyId: s.policyId, segmentId, kind: 'refund', at, amount: refund,
      tariffVersion: s.tariffVersion, note: `Pro-rata refund of ${days} charged day(s), short-rate retention ${shortRateBps} bps`,
    };
    this.credit(s.policyId, refund);
    this.events.push(ev);
    return ev;
  }

  statement(policyId: string): { events: ChargeEvent[]; total: Money; balance: Money } {
    const events = this.chargeEvents(policyId);
    const chargeTotal = events.filter((e) => e.kind !== 'refund').reduce((acc, e) => add(acc, e.amount), zero(this.currency));
    return {
      events,
      total: sub(chargeTotal, sum(events.filter((e) => e.kind === 'refund').map((e) => e.amount), this.currency)),
      balance: this.wallet(policyId).balance,
    };
  }

  private dayBoundaries(fromIso: string, toIso: string): string[] {
    const out: string[] = [];
    const start = new Date(fromIso);
    const end = new Date(toIso);
    const firstMidnight = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth(), start.getUTCDate() + 1));
    for (let t = firstMidnight.getTime(); t <= end.getTime(); t += 86_400_000) {
      out.push(new Date(t).toISOString());
      if (out.length > 1500) break;
    }
    return out;
  }
}
