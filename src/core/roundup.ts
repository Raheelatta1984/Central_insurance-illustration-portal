/**
 * Customer Debit-Card Attachment & Spare-Change Round-Up Micro-Investment Engine.
 *
 * Lets a policyholder attach one or more debit cards under a demo direct-debit
 * micro-collection mandate (Luhn + expiry checked, keyed in-memory fingerprint,
 * masked PAN only, `cvvStored: false` — raw PAN and CVV are never persisted), configure
 * their preferred round-up step / rule / multiplier / cap / fund split, and automatically
 * collect spare change from everyday card purchases (e.g. 4.50 -> 5.00 -> 0.50) straight
 * into their unit-linked policy's segregated investment funds.
 */

import { hmacSha256Hex, randomTokenHex } from './hash.js';
import { splitMoneyByWeights as allocateWeights, validateBpsWeights as validateAllocation, type FundBpsWeight as AllocationWeight } from './unitlinked-statement.js';
import type { World } from './demo.js';
import {
  add,
  formatAmount,
  money,
  parseAmount,
  scaleOf,
  sub,
  toDecimalString,
  zero,
  type Money,
} from './money.js';
import {
  cardBrand,
  cardExpiryValid,
  luhnValid,
  maskPan,
  type CardBrand,
} from './payments.js';
import { assertUnitLinkedPolicy } from './unitlinked-statement.js';
import { unitsForAmount, unitsToDecimal, priceToDecimal } from './units.js';

export class RoundUpError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RoundUpError';
  }
}

export type RoundUpExactMatchRule = 'skip-zero' | 'add-full-step';
export type RoundUpRedirectMode = 'immediate' | 'threshold-sweep';
export type RoundUpAllocationMode = 'policy-weights' | 'custom-weights';
export type AttachedCardStatus = 'active' | 'paused' | 'revoked';

export interface AttachedDebitCard {
  readonly cardId: string;
  readonly mandateId: string;
  readonly partyId: string;
  readonly customerName: string;
  readonly policyId: string;
  readonly cardholderName: string;
  readonly issuingBank: string;
  readonly brand: CardBrand;
  readonly maskedPan: string;
  readonly last4: string;
  readonly fingerprint: string;
  readonly expiry: string;
  readonly authentication: 'sca-3ds' | 'contactless';
  /** Raw CVV is never stored anywhere in memory, disk, or logs. */
  readonly cvvStored: false;
  status: AttachedCardStatus;
  readonly attachedAt: string;
  readonly attachedBy: string;
  lastChargedAt?: string;
  totalCharged: Money;
  chargeCount: number;
}

export interface RoundUpPolicySettings {
  readonly policyId: string;
  readonly partyId: string;
  readonly currency: string;
  enabled: boolean;
  cardId: string | null;
  /** Whole currency unit step to round purchases up to (e.g. 1, 5, 10, 50, 100). */
  roundStepMajor: number;
  /** Behaviour when purchase is already an exact multiple of `roundStepMajor` (e.g. 5.00 with step 1). */
  exactMatchRule: RoundUpExactMatchRule;
  /** Optional spare-change booster multiplier (1x .. 10x). */
  multiplier: number;
  /** `'immediate'` invests every spare-change collection straight into funds; `'threshold-sweep'` buffers until threshold. */
  redirectMode: RoundUpRedirectMode;
  sweepThreshold: Money;
  monthlyCap: Money | null;
  /** Entry fee bps on spare-change round-ups (defaults to 0 bps so micro-savings go 100% into units). */
  roundUpChargeBps: number;
  allocationMode: RoundUpAllocationMode;
  customWeights: ReadonlyArray<{ fundId: string; weightBps: number }>;
  pendingBuffer: Money;
  updatedAt: string;
  updatedBy: string;
}

export interface RoundUpFundConversionLeg {
  readonly fundId: string;
  readonly fundName: string;
  readonly weightBps: number;
  readonly grossAmount: string;
  readonly feeDeducted: string;
  readonly netInvested: string;
  readonly navPrice: string;
  readonly unitsConverted: string;
  readonly unitTransactionId: string;
  readonly journalIds: readonly string[];
}

export type RoundUpEventStatus =
  | 'invested'
  | 'buffered'
  | 'swept-and-invested'
  | 'skipped-exact'
  | 'skipped-cap'
  | 'skipped-disabled';

export interface RoundUpEvent {
  readonly id: string;
  readonly chargeRef: string | null;
  readonly policyId: string;
  readonly partyId: string;
  readonly cardId: string;
  readonly cardMaskedPan: string;
  readonly merchantName: string;
  readonly merchantCategory: string;
  readonly purchaseAmount: Money;
  readonly roundedAmount: Money;
  readonly spareChangeAmount: Money;
  readonly multiplier: number;
  readonly redirectedAmount: Money;
  readonly investedAmount: Money;
  readonly roundStepMajor: number;
  readonly status: RoundUpEventStatus;
  readonly statusNote: string;
  readonly allocations: readonly RoundUpFundConversionLeg[];
  readonly receiptIds: readonly string[];
  readonly journalIds: readonly string[];
  readonly at: string;
  readonly by: string;
}

export interface SpareChangeCalculation {
  readonly purchaseAmount: Money;
  readonly roundStepMajor: number;
  readonly exactMatchRule: RoundUpExactMatchRule;
  readonly multiplier: number;
  readonly roundedAmount: Money;
  readonly baseSpareChange: Money;
  readonly redirectedAmount: Money;
  readonly isExactMatch: boolean;
}

/**
 * Pure decimal-exact spare-change calculator.
 * Example: purchase 4.50, step 1, rule 'skip-zero', multiplier 1
 *   -> roundedAmount 5.00, baseSpareChange 0.50, redirectedAmount 0.50.
 */
export function calculateSpareChangeRoundUp(input: {
  purchaseAmount: Money;
  roundStepMajor: number;
  exactMatchRule?: RoundUpExactMatchRule;
  multiplier?: number;
}): SpareChangeCalculation {
  const { purchaseAmount } = input;
  if (purchaseAmount.minor <= 0n) {
    throw new RoundUpError('Purchase amount must be greater than zero');
  }
  const stepMajor = Number(input.roundStepMajor);
  if (!Number.isInteger(stepMajor) || stepMajor < 1 || stepMajor > 10_000) {
    throw new RoundUpError(`Round-up step must be a whole integer between 1 and 10,000, got ${input.roundStepMajor}`);
  }
  const multiplier = Number(input.multiplier ?? 1);
  if (!Number.isInteger(multiplier) || multiplier < 1 || multiplier > 10) {
    throw new RoundUpError(`Round-up multiplier must be an integer between 1 and 10, got ${input.multiplier}`);
  }
  const exactMatchRule: RoundUpExactMatchRule = input.exactMatchRule ?? 'skip-zero';
  const scale = scaleOf(purchaseAmount.currency);
  const stepMinor = BigInt(stepMajor) * (10n ** BigInt(scale));
  const rem = purchaseAmount.minor % stepMinor;
  const isExactMatch = rem === 0n;

  let baseSpareMinor: bigint;
  let roundedMinor: bigint;
  if (isExactMatch) {
    if (exactMatchRule === 'add-full-step') {
      baseSpareMinor = stepMinor;
      roundedMinor = purchaseAmount.minor + stepMinor;
    } else {
      baseSpareMinor = 0n;
      roundedMinor = purchaseAmount.minor;
    }
  } else {
    baseSpareMinor = stepMinor - rem;
    roundedMinor = purchaseAmount.minor + baseSpareMinor;
  }

  const redirectedMinor = baseSpareMinor * BigInt(multiplier);
  return {
    purchaseAmount,
    roundStepMajor: stepMajor,
    exactMatchRule,
    multiplier,
    roundedAmount: money(roundedMinor, purchaseAmount.currency),
    baseSpareChange: money(baseSpareMinor, purchaseAmount.currency),
    redirectedAmount: money(redirectedMinor, purchaseAmount.currency),
    isExactMatch,
  };
}

function fingerprintPan(pan: string, key: string): string {
  const digits = pan.replace(/[\s-]/g, '');
  return hmacSha256Hex(key, digits);
}

/* ========================================================= REGISTRY */

export class RoundUpRegistry {
  // Process-local key: duplicate detection is not a payment-provider token.
  private readonly fingerprintKey = randomTokenHex(32);
  private readonly cards = new Map<string, AttachedDebitCard>();
  private readonly settingsByPolicy = new Map<string, RoundUpPolicySettings>();
  private readonly events: RoundUpEvent[] = [];
  private cardSeq = 0;
  private mandateSeq = 0;
  private chargeSeq = 0;
  private eventSeq = 0;

  private ensureDefaultSettings(w: World, policyId: string): RoundUpPolicySettings {
    const existing = this.settingsByPolicy.get(policyId);
    if (existing) return existing;
    const policy = assertUnitLinkedPolicy(w, policyId);
    const created: RoundUpPolicySettings = {
      policyId: policy.policyId,
      partyId: policy.partyId,
      currency: policy.currency,
      enabled: false,
      cardId: null,
      roundStepMajor: 1,
      exactMatchRule: 'skip-zero',
      multiplier: 1,
      redirectMode: 'immediate',
      sweepThreshold: parseAmount('10.00', policy.currency),
      monthlyCap: null,
      roundUpChargeBps: 0,
      allocationMode: 'policy-weights',
      customWeights: (policy.targetWeights ?? []).map((t) => ({ fundId: t.fundId, weightBps: t.weightBps })),
      pendingBuffer: zero(policy.currency),
      updatedAt: `${w.asOf}T09:00:00+04:00`,
      updatedBy: 'system',
    };
    this.settingsByPolicy.set(policy.policyId, created);
    return created;
  }

  private resolveEffectiveWeights(
    w: World,
    policyId: string,
    settings: RoundUpPolicySettings,
  ): AllocationWeight[] {
    const policy = assertUnitLinkedPolicy(w, policyId);
    const source = settings.allocationMode === 'custom-weights' && settings.customWeights.length > 0
      ? settings.customWeights
      : (policy.targetWeights && policy.targetWeights.length > 0
        ? policy.targetWeights
        : [{ fundId: w.nav.listFunds()[0]?.id ?? 'FBAL', weightBps: 10_000 }]);
    const weights: AllocationWeight[] = source
      .filter((s) => s.weightBps > 0)
      .map((s) => ({ fundId: s.fundId, bps: Math.round(s.weightBps) }));
    const check = validateAllocation(weights);
    if (!check.valid) {
      throw new RoundUpError(`Invalid round-up fund allocation weights: ${check.errors.join('; ')}`);
    }
    return weights;
  }

  private monthlyInvestedSoFar(policyId: string, yearMonth: string, currency: string): Money {
    return this.events
      .filter((e) => e.policyId === policyId && e.at.slice(0, 7) === yearMonth && e.investedAmount.minor > 0n)
      .reduce((acc, e) => add(acc, e.investedAmount), zero(currency));
  }

  /* --------------------------------------------------- 1. ATTACH DEBIT CARD */

  attachDebitCard(w: World, input: {
    policyId: string;
    pan: string;
    expiry: string;
    cardholderName?: string;
    issuingBank?: string;
    authentication?: 'sca-3ds' | 'contactless';
    setAsActiveCard?: boolean;
    at?: string;
    by?: string;
  }): AttachedDebitCard {
    const policy = assertUnitLinkedPolicy(w, input.policyId);
    const rawPan = (input.pan ?? '').replace(/[\s-]/g, '');
    if (!rawPan) throw new RoundUpError('Debit card number (PAN) is required');
    if (!luhnValid(rawPan)) {
      throw new RoundUpError('Debit card number failed Luhn check-digit validation');
    }
    const brand = cardBrand(rawPan);
    if (brand === 'unknown') {
      throw new RoundUpError('Unsupported debit card network (supported: Visa, Mastercard, Mada, Meeza, UnionPay, Amex)');
    }
    const at = input.at ?? `${w.asOf}T10:00:00+04:00`;
    const asOfDate = at.slice(0, 10);
    if (!cardExpiryValid(input.expiry ?? '', asOfDate)) {
      throw new RoundUpError(`Debit card expiry '${input.expiry}' is invalid or expired as of ${asOfDate}`);
    }

    const fp = fingerprintPan(rawPan, this.fingerprintKey);
    const duplicate = [...this.cards.values()].find(
      (c) => c.policyId === policy.policyId && c.fingerprint === fp && c.status !== 'revoked',
    );
    if (duplicate) {
      throw new RoundUpError(`This debit card (${duplicate.maskedPan}) is already attached to policy ${policy.policyId}`);
    }

    const cardId = `RDC-${String(++this.cardSeq).padStart(4, '0')}`;
    const mandateId = `RUM-${String(++this.mandateSeq).padStart(4, '0')}`;
    const card: AttachedDebitCard = {
      cardId,
      mandateId,
      partyId: policy.partyId,
      customerName: policy.holderName,
      policyId: policy.policyId,
      cardholderName: (input.cardholderName ?? '').trim() || policy.holderName,
      issuingBank: (input.issuingBank ?? '').trim() || 'Primary Customer Bank',
      brand,
      maskedPan: maskPan(rawPan),
      last4: rawPan.slice(-4),
      fingerprint: fp,
      expiry: input.expiry.trim(),
      authentication: input.authentication ?? 'sca-3ds',
      cvvStored: false,
      status: 'active',
      attachedAt: at,
      attachedBy: input.by ?? 'customer-portal',
      totalCharged: zero(policy.currency),
      chargeCount: 0,
    };
    this.cards.set(cardId, card);

    const settings = this.ensureDefaultSettings(w, policy.policyId);
    if (settings.cardId === null || input.setAsActiveCard !== false) {
      settings.cardId = cardId;
      settings.enabled = true;
      settings.updatedAt = at;
      settings.updatedBy = input.by ?? 'customer-portal';
    }
    return card;
  }

  setCardStatus(w: World, input: {
    cardId: string;
    status: AttachedCardStatus;
    at?: string;
    by?: string;
  }): AttachedDebitCard {
    const card = this.cards.get((input.cardId ?? '').trim());
    if (!card) throw new RoundUpError(`Unknown attached debit card ${input.cardId}`);
    card.status = input.status;
    const settings = this.ensureDefaultSettings(w, card.policyId);
    if (settings.cardId === card.cardId && input.status !== 'active') {
      const fallback = [...this.cards.values()].find(
        (c) => c.policyId === card.policyId && c.cardId !== card.cardId && c.status === 'active',
      );
      if (fallback) {
        settings.cardId = fallback.cardId;
      } else if (input.status === 'revoked') {
        settings.enabled = false;
      }
      settings.updatedAt = input.at ?? `${w.asOf}T10:05:00+04:00`;
      settings.updatedBy = input.by ?? 'customer-portal';
    }
    return card;
  }

  /* --------------------------------------------------- 2. CONFIGURE SETTINGS */

  configureSettings(w: World, input: {
    policyId: string;
    enabled?: boolean;
    cardId?: string | null;
    roundStepMajor?: number;
    exactMatchRule?: RoundUpExactMatchRule;
    multiplier?: number;
    redirectMode?: RoundUpRedirectMode;
    sweepThreshold?: string | number;
    monthlyCap?: string | number | null;
    roundUpChargeBps?: number;
    allocationMode?: RoundUpAllocationMode;
    customWeights?: ReadonlyArray<{ fundId: string; weightBps: number }>;
    at?: string;
    by?: string;
  }): RoundUpPolicySettings {
    const policy = assertUnitLinkedPolicy(w, input.policyId);
    const previous = this.ensureDefaultSettings(w, policy.policyId);
    // Validate on a copy so a rejected request never leaves partially changed settings.
    const settings = { ...previous, customWeights: [...previous.customWeights] };
    const at = input.at ?? `${w.asOf}T10:15:00+04:00`;
    const by = input.by ?? 'customer-portal';

    if (input.cardId !== undefined) {
      if (input.cardId === null || input.cardId === '') {
        settings.cardId = null;
      } else {
        const card = this.cards.get(input.cardId);
        if (!card || card.policyId !== policy.policyId) {
          throw new RoundUpError(`Debit card ${input.cardId} is not attached to policy ${policy.policyId}`);
        }
        if (card.status === 'revoked') {
          throw new RoundUpError(`Debit card ${input.cardId} has been revoked`);
        }
        settings.cardId = card.cardId;
      }
    }

    if (input.roundStepMajor !== undefined) {
      const step = Number(input.roundStepMajor);
      if (!Number.isInteger(step) || step < 1 || step > 10_000) {
        throw new RoundUpError('roundStepMajor must be an integer between 1 and 10,000');
      }
      settings.roundStepMajor = step;
    }

    if (input.exactMatchRule !== undefined) {
      if (input.exactMatchRule !== 'skip-zero' && input.exactMatchRule !== 'add-full-step') {
        throw new RoundUpError(`Unsupported exactMatchRule ${String(input.exactMatchRule)}`);
      }
      settings.exactMatchRule = input.exactMatchRule;
    }

    if (input.multiplier !== undefined) {
      const mult = Number(input.multiplier);
      if (!Number.isInteger(mult) || mult < 1 || mult > 10) {
        throw new RoundUpError('multiplier must be an integer between 1 and 10');
      }
      settings.multiplier = mult;
    }

    if (input.redirectMode !== undefined) {
      if (input.redirectMode !== 'immediate' && input.redirectMode !== 'threshold-sweep') {
        throw new RoundUpError(`Unsupported redirectMode ${String(input.redirectMode)}`);
      }
      settings.redirectMode = input.redirectMode;
    }

    if (input.sweepThreshold !== undefined && String(input.sweepThreshold).trim() !== '') {
      const threshold = parseAmount(String(input.sweepThreshold).trim(), policy.currency);
      if (threshold.minor <= 0n) throw new RoundUpError('sweepThreshold must be greater than zero');
      settings.sweepThreshold = threshold;
    }

    if (input.monthlyCap !== undefined) {
      if (input.monthlyCap === null || String(input.monthlyCap).trim() === '') {
        settings.monthlyCap = null;
      } else {
        const cap = parseAmount(String(input.monthlyCap).trim(), policy.currency);
        if (cap.minor <= 0n) throw new RoundUpError('monthlyCap must be greater than zero when set');
        settings.monthlyCap = cap;
      }
    }

    if (input.roundUpChargeBps !== undefined) {
      const bps = Number(input.roundUpChargeBps);
      if (!Number.isInteger(bps) || bps < 0 || bps > 1_000) {
        throw new RoundUpError('roundUpChargeBps must be between 0 and 1,000 bps');
      }
      settings.roundUpChargeBps = bps;
    }

    if (input.allocationMode !== undefined) {
      if (input.allocationMode !== 'policy-weights' && input.allocationMode !== 'custom-weights') {
        throw new RoundUpError(`Unsupported allocationMode ${String(input.allocationMode)}`);
      }
      settings.allocationMode = input.allocationMode;
    }

    if (input.customWeights !== undefined) {
      const cleaned = input.customWeights
        .filter((cw) => cw.weightBps > 0)
        .map((cw) => {
          const f = w.nav.fund(cw.fundId);
          if (f.currency !== policy.currency) {
            throw new RoundUpError(`Fund ${cw.fundId} (${f.currency}) does not match policy currency ${policy.currency}`);
          }
          return { fundId: cw.fundId, bps: Number(cw.weightBps) };
        });
      if (settings.allocationMode === 'custom-weights' || cleaned.length > 0) {
        const check = validateAllocation(cleaned);
        if (!check.valid) throw new RoundUpError(check.errors.join('; '));
        settings.customWeights = cleaned.map((c) => ({ fundId: c.fundId, weightBps: c.bps }));
      }
    }

    if (input.enabled !== undefined) {
      settings.enabled = Boolean(input.enabled);
    }
    if (settings.enabled && (!settings.cardId || this.cards.get(settings.cardId)?.status !== 'active')) {
      throw new RoundUpError('An active debit card is required to enable automatic spare-change round-ups');
    }
    if (settings.allocationMode === 'custom-weights') {
      const check = validateAllocation(settings.customWeights.map((weight) => ({ fundId: weight.fundId, bps: weight.weightBps })));
      if (!check.valid) throw new RoundUpError(check.errors.join('; '));
    }

    settings.updatedAt = at;
    settings.updatedBy = by;
    this.settingsByPolicy.set(policy.policyId, settings);
    return settings;
  }

  /* --------------------------------------------------- 3. PREVIEW CALCULATOR */

  previewRoundUp(w: World, input: {
    policyId: string;
    purchaseAmount: string | number;
    roundStepMajor?: number;
    exactMatchRule?: RoundUpExactMatchRule;
    multiplier?: number;
  }) {
    const policy = assertUnitLinkedPolicy(w, input.policyId);
    const settings = this.ensureDefaultSettings(w, policy.policyId);
    const purchase = parseAmount(String(input.purchaseAmount).trim(), policy.currency);
    const calc = calculateSpareChangeRoundUp({
      purchaseAmount: purchase,
      roundStepMajor: input.roundStepMajor ?? settings.roundStepMajor,
      exactMatchRule: input.exactMatchRule ?? settings.exactMatchRule,
      multiplier: input.multiplier ?? settings.multiplier,
    });
    const weights = this.resolveEffectiveWeights(w, policy.policyId, settings);
    const latestDate = w.nav.listFunds().reduce((max, f) => {
      const d = w.nav.latestValuation(f.id)?.valuationDate ?? w.asOf;
      return d > max ? d : max;
    }, w.asOf);
    const split = calc.redirectedAmount.minor > 0n
      ? allocateWeights(calc.redirectedAmount, weights)
      : weights.map((wt) => ({ fundId: wt.fundId, bps: wt.bps, amount: zero(policy.currency) }));

    return {
      policyId: policy.policyId,
      currency: policy.currency,
      purchaseAmount: formatAmount(calc.purchaseAmount),
      roundStepMajor: calc.roundStepMajor,
      exactMatchRule: calc.exactMatchRule,
      multiplier: calc.multiplier,
      roundedAmount: formatAmount(calc.roundedAmount),
      spareChange: formatAmount(calc.baseSpareChange),
      redirectedToInvestment: formatAmount(calc.redirectedAmount),
      isExactMatch: calc.isExactMatch,
      expectedFundAllocations: split.map((leg) => {
        const fund = w.nav.fund(leg.fundId);
        const price = w.nav.latestValuation(leg.fundId)?.pricePerUnit ?? w.nav.priceAt(leg.fundId, latestDate);
        const estUnits = leg.amount.minor > 0n ? unitsForAmount(leg.amount, price) : 0n;
        return {
          fundId: leg.fundId,
          fundName: fund.name,
          weightPct: `${(leg.bps / 100).toFixed(2)}%`,
          amount: formatAmount(leg.amount),
          navPrice: `${priceToDecimal(price)} ${price.currency}`,
          estimatedUnits: unitsToDecimal(estUnits),
        };
      }),
    };
  }

  /* ---------------------------------------- 4. COLLECT & INVEST SPARE CHANGE */

  private investCollectedAmount(
    w: World,
    policyId: string,
    card: AttachedDebitCard,
    amountToInvest: Money,
    at: string,
    by: string,
    noteContext: string,
  ): {
    chargeRef: string;
    allocations: RoundUpFundConversionLeg[];
    receiptIds: string[];
    journalIds: string[];
  } {
    const policy = assertUnitLinkedPolicy(w, policyId);
    const settings = this.ensureDefaultSettings(w, policy.policyId);
    const weights = this.resolveEffectiveWeights(w, policy.policyId, settings);
    const chargeRef = `RCH-${String(++this.chargeSeq).padStart(5, '0')}`;

    const legs = allocateWeights(amountToInvest, weights).filter((l) => l.amount.minor > 0n);
    const allocations: RoundUpFundConversionLeg[] = [];
    const receiptIds: string[] = [];
    const journalIds: string[] = [];

    for (const leg of legs) {
      const fund = w.nav.fund(leg.fundId);
      const txn = w.unitLinked.payTopUp({
        policyId: policy.policyId,
        amount: leg.amount,
        fundId: leg.fundId,
        instructionAt: at,
        topupChargeBps: settings.roundUpChargeBps,
        channel: 'debit-card-roundup',
        instructionId: chargeRef,
        notePrefix: `${noteContext} (${card.maskedPan})`,
      });
      const fee = txn.charges[0]?.amount ?? zero(policy.currency);
      const receipt = w.erp.recordReceiptRecord({
        policyId: policy.policyId,
        partyId: policy.partyId,
        customerName: policy.holderName,
        category: policy.category,
        amount: leg.amount,
        fundId: leg.fundId,
        unitsAllocated: unitsToDecimal(txn.units),
        pricePerUnit: priceToDecimal(txn.pricePerUnit),
        feeDeducted: fee,
        at,
        by,
        paymentMethod: `debit-card-roundup (${card.brand.toUpperCase()} ••${card.last4})`,
        journalIds: txn.journalIds,
        note: `${noteContext} -> ${leg.fundId} (+${unitsToDecimal(txn.units)} units)`,
      });
      receiptIds.push(receipt.id);
      journalIds.push(...txn.journalIds);
      allocations.push({
        fundId: leg.fundId,
        fundName: fund.name,
        weightBps: leg.bps,
        grossAmount: formatAmount(leg.amount),
        feeDeducted: formatAmount(fee),
        netInvested: formatAmount(txn.value),
        navPrice: `${priceToDecimal(txn.pricePerUnit)} ${txn.pricePerUnit.currency}`,
        unitsConverted: unitsToDecimal(txn.units),
        unitTransactionId: txn.id,
        journalIds: [...txn.journalIds],
      });
    }

    card.totalCharged = add(card.totalCharged, amountToInvest);
    card.chargeCount += 1;
    card.lastChargedAt = at;

    return { chargeRef, allocations, receiptIds, journalIds };
  }

  recordPurchase(w: World, input: {
    policyId: string;
    purchaseAmount: string | number;
    merchantName: string;
    merchantCategory?: string;
    cardId?: string;
    at?: string;
    by?: string;
  }): RoundUpEvent {
    const policy = assertUnitLinkedPolicy(w, input.policyId);
    if (policy.status === 'cancelled' || policy.status === 'surrendered') {
      throw new RoundUpError(`Policy ${policy.policyId} is ${policy.status} and cannot receive spare-change investments`);
    }
    const settings = this.ensureDefaultSettings(w, policy.policyId);
    const at = input.at ?? `${w.asOf}T12:00:00+04:00`;
    const by = input.by ?? 'card-feed-processor';
    const merchantName = (input.merchantName ?? '').trim() || 'Everyday Card Purchase';
    const merchantCategory = (input.merchantCategory ?? '').trim() || 'Retail & Dining';
    const purchase = parseAmount(String(input.purchaseAmount).trim(), policy.currency);

    const chosenCardId = input.cardId ?? settings.cardId;
    if (!chosenCardId) {
      throw new RoundUpError(`No debit card attached to policy ${policy.policyId}`);
    }
    const card = this.cards.get(chosenCardId);
    if (!card || card.policyId !== policy.policyId) {
      throw new RoundUpError(`Debit card ${chosenCardId} is not attached to policy ${policy.policyId}`);
    }
    if (card.status !== 'active') {
      throw new RoundUpError(`Debit card ${card.maskedPan} is currently ${card.status}`);
    }
    if (!cardExpiryValid(card.expiry, at.slice(0, 10))) {
      throw new RoundUpError(`Debit card ${card.maskedPan} has expired (${card.expiry})`);
    }

    const calc = calculateSpareChangeRoundUp({
      purchaseAmount: purchase,
      roundStepMajor: settings.roundStepMajor,
      exactMatchRule: settings.exactMatchRule,
      multiplier: settings.multiplier,
    });

    if (!settings.enabled) {
      const ev: RoundUpEvent = {
        id: `RUE-${String(++this.eventSeq).padStart(5, '0')}`,
        chargeRef: null,
        policyId: policy.policyId,
        partyId: policy.partyId,
        cardId: card.cardId,
        cardMaskedPan: card.maskedPan,
        merchantName,
        merchantCategory,
        purchaseAmount: calc.purchaseAmount,
        roundedAmount: calc.roundedAmount,
        spareChangeAmount: calc.baseSpareChange,
        multiplier: calc.multiplier,
        redirectedAmount: calc.redirectedAmount,
        investedAmount: zero(policy.currency),
        roundStepMajor: calc.roundStepMajor,
        status: 'skipped-disabled',
        statusNote: 'Round-up rule is currently paused on this policy',
        allocations: [],
        receiptIds: [],
        journalIds: [],
        at,
        by,
      };
      this.events.push(ev);
      return ev;
    }

    if (calc.redirectedAmount.minor === 0n) {
      const ev: RoundUpEvent = {
        id: `RUE-${String(++this.eventSeq).padStart(5, '0')}`,
        chargeRef: null,
        policyId: policy.policyId,
        partyId: policy.partyId,
        cardId: card.cardId,
        cardMaskedPan: card.maskedPan,
        merchantName,
        merchantCategory,
        purchaseAmount: calc.purchaseAmount,
        roundedAmount: calc.roundedAmount,
        spareChangeAmount: calc.baseSpareChange,
        multiplier: calc.multiplier,
        redirectedAmount: zero(policy.currency),
        investedAmount: zero(policy.currency),
        roundStepMajor: calc.roundStepMajor,
        status: 'skipped-exact',
        statusNote: `Exact multiple of ${calc.roundStepMajor} ${policy.currency} (skip-zero rule)`,
        allocations: [],
        receiptIds: [],
        journalIds: [],
        at,
        by,
      };
      this.events.push(ev);
      return ev;
    }

    // Apply optional monthly cap
    let effectiveRedirect = calc.redirectedAmount;
    if (settings.monthlyCap) {
      const used = this.monthlyInvestedSoFar(policy.policyId, at.slice(0, 7), policy.currency);
      const remaining = settings.monthlyCap.minor > used.minor
        ? sub(settings.monthlyCap, used)
        : zero(policy.currency);
      if (remaining.minor === 0n) {
        const ev: RoundUpEvent = {
          id: `RUE-${String(++this.eventSeq).padStart(5, '0')}`,
          chargeRef: null,
          policyId: policy.policyId,
          partyId: policy.partyId,
          cardId: card.cardId,
          cardMaskedPan: card.maskedPan,
          merchantName,
          merchantCategory,
          purchaseAmount: calc.purchaseAmount,
          roundedAmount: calc.roundedAmount,
          spareChangeAmount: calc.baseSpareChange,
          multiplier: calc.multiplier,
          redirectedAmount: calc.redirectedAmount,
          investedAmount: zero(policy.currency),
          roundStepMajor: calc.roundStepMajor,
          status: 'skipped-cap',
          statusNote: `Monthly cap ${formatAmount(settings.monthlyCap)} reached for ${at.slice(0, 7)}`,
          allocations: [],
          receiptIds: [],
          journalIds: [],
          at,
          by,
        };
        this.events.push(ev);
        return ev;
      }
      if (effectiveRedirect.minor > remaining.minor) {
        effectiveRedirect = remaining;
      }
    }

    if (settings.redirectMode === 'threshold-sweep') {
      const nextBuf = add(settings.pendingBuffer, effectiveRedirect);
      if (nextBuf.minor < settings.sweepThreshold.minor) {
        settings.pendingBuffer = nextBuf;
        const ev: RoundUpEvent = {
          id: `RUE-${String(++this.eventSeq).padStart(5, '0')}`,
          chargeRef: null,
          policyId: policy.policyId,
          partyId: policy.partyId,
          cardId: card.cardId,
          cardMaskedPan: card.maskedPan,
          merchantName,
          merchantCategory,
          purchaseAmount: calc.purchaseAmount,
          roundedAmount: calc.roundedAmount,
          spareChangeAmount: calc.baseSpareChange,
          multiplier: calc.multiplier,
          redirectedAmount: effectiveRedirect,
          investedAmount: zero(policy.currency),
          roundStepMajor: calc.roundStepMajor,
          status: 'buffered',
          statusNote: `Buffered (${formatAmount(nextBuf)} / ${formatAmount(settings.sweepThreshold)} sweep threshold)`,
          allocations: [],
          receiptIds: [],
          journalIds: [],
          at,
          by,
        };
        this.events.push(ev);
        return ev;
      }
      settings.pendingBuffer = zero(policy.currency);
      const invested = this.investCollectedAmount(
        w,
        policy.policyId,
        card,
        nextBuf,
        at,
        by,
        `Round-up threshold sweep triggered by ${merchantName}`,
      );
      const ev: RoundUpEvent = {
        id: `RUE-${String(++this.eventSeq).padStart(5, '0')}`,
        chargeRef: invested.chargeRef,
        policyId: policy.policyId,
        partyId: policy.partyId,
        cardId: card.cardId,
        cardMaskedPan: card.maskedPan,
        merchantName,
        merchantCategory,
        purchaseAmount: calc.purchaseAmount,
        roundedAmount: calc.roundedAmount,
        spareChangeAmount: calc.baseSpareChange,
        multiplier: calc.multiplier,
        redirectedAmount: effectiveRedirect,
        investedAmount: nextBuf,
        roundStepMajor: calc.roundStepMajor,
        status: 'swept-and-invested',
        statusNote: `Threshold met — ${formatAmount(nextBuf)} charged & invested straight into funds`,
        allocations: invested.allocations,
        receiptIds: invested.receiptIds,
        journalIds: invested.journalIds,
        at,
        by,
      };
      this.events.push(ev);
      return ev;
    }

    // Immediate mode: collect spare change on debit card and invest straight into funds
    const invested = this.investCollectedAmount(
      w,
      policy.policyId,
      card,
      effectiveRedirect,
      at,
      by,
      `Spare-change round-up on ${merchantName} (${formatAmount(calc.purchaseAmount)} -> ${formatAmount(calc.roundedAmount)})`,
    );
    const ev: RoundUpEvent = {
      id: `RUE-${String(++this.eventSeq).padStart(5, '0')}`,
      chargeRef: invested.chargeRef,
      policyId: policy.policyId,
      partyId: policy.partyId,
      cardId: card.cardId,
      cardMaskedPan: card.maskedPan,
      merchantName,
      merchantCategory,
      purchaseAmount: calc.purchaseAmount,
      roundedAmount: calc.roundedAmount,
      spareChangeAmount: calc.baseSpareChange,
      multiplier: calc.multiplier,
      redirectedAmount: effectiveRedirect,
      investedAmount: effectiveRedirect,
      roundStepMajor: calc.roundStepMajor,
      status: 'invested',
      statusNote: `Collected ${formatAmount(effectiveRedirect)} on ${card.maskedPan} & converted straight into fund units`,
      allocations: invested.allocations,
      receiptIds: invested.receiptIds,
      journalIds: invested.journalIds,
      at,
      by,
    };
    this.events.push(ev);
    return ev;
  }

  recordBatchPurchases(w: World, input: {
    policyId: string;
    cardId?: string;
    purchases: ReadonlyArray<{
      purchaseAmount: string | number;
      merchantName: string;
      merchantCategory?: string;
      at?: string;
    }>;
    by?: string;
  }): RoundUpEvent[] {
    if (!Array.isArray(input.purchases) || input.purchases.length === 0) {
      throw new RoundUpError('At least one card purchase is required');
    }
    return input.purchases.map((p, idx) =>
      this.recordPurchase(w, {
        policyId: input.policyId,
        purchaseAmount: p.purchaseAmount,
        merchantName: p.merchantName,
        ...(p.merchantCategory ? { merchantCategory: p.merchantCategory } : {}),
        ...(input.cardId ? { cardId: input.cardId } : {}),
        at: p.at ?? `${w.asOf}T13:${String(idx % 60).padStart(2, '0')}:00+04:00`,
        ...(input.by ? { by: input.by } : {}),
      }),
    );
  }

  sweepPendingBuffer(w: World, input: {
    policyId: string;
    at?: string;
    by?: string;
  }): RoundUpEvent {
    const policy = assertUnitLinkedPolicy(w, input.policyId);
    const settings = this.ensureDefaultSettings(w, policy.policyId);
    if (settings.pendingBuffer.minor <= 0n) {
      throw new RoundUpError(`No pending spare-change buffer to sweep for policy ${policy.policyId}`);
    }
    if (!settings.cardId) {
      throw new RoundUpError(`No active debit card linked to policy ${policy.policyId}`);
    }
    const card = this.cards.get(settings.cardId);
    if (!card || card.status !== 'active') {
      throw new RoundUpError('Linked debit card must be active to sweep buffered spare change');
    }
    const at = input.at ?? `${w.asOf}T16:00:00+04:00`;
    const by = input.by ?? 'customer-portal';
    const amountToSweep = settings.pendingBuffer;
    settings.pendingBuffer = zero(policy.currency);
    const invested = this.investCollectedAmount(
      w,
      policy.policyId,
      card,
      amountToSweep,
      at,
      by,
      'Manual sweep of buffered spare-change round-ups',
    );
    const ev: RoundUpEvent = {
      id: `RUE-${String(++this.eventSeq).padStart(5, '0')}`,
      chargeRef: invested.chargeRef,
      policyId: policy.policyId,
      partyId: policy.partyId,
      cardId: card.cardId,
      cardMaskedPan: card.maskedPan,
      merchantName: 'Pending Round-Up Buffer Sweep',
      merchantCategory: 'Micro-Investment Sweep',
      purchaseAmount: amountToSweep,
      roundedAmount: amountToSweep,
      spareChangeAmount: amountToSweep,
      multiplier: 1,
      redirectedAmount: amountToSweep,
      investedAmount: amountToSweep,
      roundStepMajor: settings.roundStepMajor,
      status: 'swept-and-invested',
      statusNote: `Swept ${formatAmount(amountToSweep)} straight into fund units`,
      allocations: invested.allocations,
      receiptIds: invested.receiptIds,
      journalIds: invested.journalIds,
      at,
      by,
    };
    this.events.push(ev);
    return ev;
  }

  /* --------------------------------------------------- 5. SEED & SNAPSHOT */

  seedDemo(w: World): void {
    const card = this.attachDebitCard(w, {
      policyId: 'UL-000123',
      pan: '4532015112830366',
      expiry: '08/2029',
      cardholderName: 'Ahmed Al Mansoori',
      issuingBank: 'Emirates NBD Debit',
      authentication: 'sca-3ds',
      at: '2026-10-01T09:15:00+04:00',
      by: 'customer-portal',
    });
    this.configureSettings(w, {
      policyId: 'UL-000123',
      enabled: true,
      cardId: card.cardId,
      roundStepMajor: 1,
      exactMatchRule: 'skip-zero',
      multiplier: 1,
      redirectMode: 'immediate',
      sweepThreshold: '10.00',
      monthlyCap: '500.00',
      roundUpChargeBps: 0,
      allocationMode: 'policy-weights',
      at: '2026-10-01T09:16:00+04:00',
      by: 'customer-portal',
    });
    this.recordPurchase(w, {
      policyId: 'UL-000123',
      purchaseAmount: '4.50',
      merchantName: 'Arabica Coffee DIFC',
      merchantCategory: 'Dining & Coffee',
      at: '2026-10-02T08:45:00+04:00',
      by: 'card-feed-processor',
    });
    this.recordPurchase(w, {
      policyId: 'UL-000123',
      purchaseAmount: '47.25',
      merchantName: 'Carrefour Market Marina',
      merchantCategory: 'Groceries',
      at: '2026-10-05T09:20:00+04:00',
      by: 'card-feed-processor',
    });
  }

  snapshot(w: World) {
    const unitLinkedPolicies = w.erp.listUnitLinkedPolicies();
    for (const p of unitLinkedPolicies) {
      this.ensureDefaultSettings(w, p.policyId);
    }

    const cards = [...this.cards.values()].map((c) => ({
      cardId: c.cardId,
      mandateId: c.mandateId,
      partyId: c.partyId,
      customerName: c.customerName,
      policyId: c.policyId,
      cardholderName: c.cardholderName,
      issuingBank: c.issuingBank,
      brand: c.brand,
      maskedPan: c.maskedPan,
      last4: c.last4,
      expiry: c.expiry,
      authentication: c.authentication,
      cvvStored: c.cvvStored,
      status: c.status,
      attachedAt: c.attachedAt,
      attachedBy: c.attachedBy,
      lastChargedAt: c.lastChargedAt ?? null,
      totalCharged: formatAmount(c.totalCharged),
      chargeCount: c.chargeCount,
    }));

    const settings = [...this.settingsByPolicy.values()].map((s) => {
      const policy = w.erp.getPolicy(s.policyId);
      const effectiveWeights = this.resolveEffectiveWeights(w, s.policyId, s);
      return {
        policyId: s.policyId,
        partyId: s.partyId,
        holderName: policy?.holderName ?? s.partyId,
        productName: policy?.productName ?? 'Unit-Linked Policy',
        currency: s.currency,
        enabled: s.enabled,
        cardId: s.cardId,
        roundStepMajor: s.roundStepMajor,
        exactMatchRule: s.exactMatchRule,
        multiplier: s.multiplier,
        redirectMode: s.redirectMode,
        sweepThreshold: toDecimalString(s.sweepThreshold),
        sweepThresholdFormatted: formatAmount(s.sweepThreshold),
        monthlyCap: s.monthlyCap ? toDecimalString(s.monthlyCap) : null,
        monthlyCapFormatted: s.monthlyCap ? formatAmount(s.monthlyCap) : null,
        roundUpChargeBps: s.roundUpChargeBps,
        allocationMode: s.allocationMode,
        customWeights: s.customWeights.map((cw) => ({ ...cw })),
        effectiveWeights: effectiveWeights.map((ew) => ({
          fundId: ew.fundId,
          fundName: w.nav.fund(ew.fundId).name,
          weightBps: ew.bps,
          weightPct: `${(ew.bps / 100).toFixed(2)}%`,
        })),
        pendingBuffer: formatAmount(s.pendingBuffer),
        pendingBufferMinor: s.pendingBuffer.minor.toString(),
        updatedAt: s.updatedAt,
        updatedBy: s.updatedBy,
      };
    });

    const events = [...this.events].reverse().map((e) => ({
      id: e.id,
      chargeRef: e.chargeRef,
      policyId: e.policyId,
      partyId: e.partyId,
      cardId: e.cardId,
      cardMaskedPan: e.cardMaskedPan,
      merchantName: e.merchantName,
      merchantCategory: e.merchantCategory,
      purchaseAmount: formatAmount(e.purchaseAmount),
      roundedAmount: formatAmount(e.roundedAmount),
      spareChangeAmount: formatAmount(e.spareChangeAmount),
      multiplier: e.multiplier,
      redirectedAmount: formatAmount(e.redirectedAmount),
      investedAmount: formatAmount(e.investedAmount),
      roundStepMajor: e.roundStepMajor,
      status: e.status,
      statusNote: e.statusNote,
      allocations: e.allocations,
      receiptIds: e.receiptIds,
      journalIds: e.journalIds,
      at: e.at,
      by: e.by,
    }));

    // Totals by currency (default AED for primary summary)
    const primaryCcy = unitLinkedPolicies[0]?.currency ?? 'AED';
    const totalInvested = this.events
      .filter((e) => e.investedAmount.currency === primaryCcy)
      .reduce((acc, e) => add(acc, e.investedAmount), zero(primaryCcy));
    const totalPurchaseSpend = this.events
      .filter((e) => e.purchaseAmount.currency === primaryCcy)
      .reduce((acc, e) => add(acc, e.purchaseAmount), zero(primaryCcy));
    const totalPending = [...this.settingsByPolicy.values()]
      .filter((s) => s.currency === primaryCcy)
      .reduce((acc, s) => add(acc, s.pendingBuffer), zero(primaryCcy));
    const totalUnitsConverted = this.events.reduce((acc, e) => {
      for (const leg of e.allocations) {
        const parts = leg.unitsConverted.split('.');
        const whole = BigInt(parts[0] ?? '0');
        const frac = BigInt((parts[1] ?? '').padEnd(6, '0').slice(0, 6));
        acc += whole * 1_000_000n + frac;
      }
      return acc;
    }, 0n);

    return {
      summary: {
        attachedCardsCount: cards.length,
        activeCardsCount: cards.filter((c) => c.status === 'active').length,
        activeMandatesCount: settings.filter((s) => s.enabled && s.cardId !== null).length,
        roundUpEventsCount: events.length,
        investedEventsCount: this.events.filter((e) => e.investedAmount.minor > 0n).length,
        totalPurchaseVolume: formatAmount(totalPurchaseSpend),
        totalSpareChangeInvested: formatAmount(totalInvested),
        totalPendingBuffer: formatAmount(totalPending),
        totalUnitsConverted: unitsToDecimal(totalUnitsConverted),
      },
      eligiblePolicies: unitLinkedPolicies.map((p) => ({
        policyId: p.policyId,
        partyId: p.partyId,
        holderName: p.holderName,
        productName: p.productName,
        currency: p.currency,
        status: p.status,
      })),
      availableFunds: w.nav.listFunds().map((f) => {
        const latest = w.nav.latestValuation(f.id);
        return {
          fundId: f.id,
          fundName: f.name,
          currency: f.currency,
          shariahScreened: f.shariahScreened,
          latestNav: latest ? `${priceToDecimal(latest.pricePerUnit)} ${latest.pricePerUnit.currency}` : '—',
        };
      }),
      cards,
      settings,
      events,
    };
  }
}
