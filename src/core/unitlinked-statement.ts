/**
 * Unit-Linked Policy Investment Process Flow, Chronological Statement, and Servicing Engine.
 *
 * Exclusively serves policies with `category === 'unit-linked'`. Non-linked products
 * (`motor-payg`, `medical`, `term-life`, `savings`, `takaful`, `annuity`, etc.) are
 * rejected at the boundary so conventional / general insurance policies never surface
 * unit-dealing or fund-segregation mechanics.
 *
 * Models the complete 6-stage unit-linked investment lifecycle:
 *   1. Funds & Premium Receipt (regular monthly / quarterly / semi-annual / annual premiums,
 *      ad-hoc extra payments, and debit-card spare-change round-ups)
 *   2. Entry & Allocation Charge Deductions -> Net Investable Cash
 *   3. Multi-Fund Allocation & NAV Unit Conversion (+Units credited)
 *   4. Mortality (COI) & Administration Fee Unit Deductions (-Units cancelled)
 *   5. Fund-to-Fund Switches & Portfolio Rebalancing (-Units out / +Units in)
 *   6. Withdrawals, Surrender Settlements & Live Segregated Fund Valuation
 */

import { TOTAL_WEIGHT_BPS } from './allocation.js';
import { resolveDealingPoint } from './fund.js';
import { requirePolicyChargeRules } from './policy-charge-rules.js';
import type { World } from './demo.js';
import type { ErpPolicy, PaymentFrequency } from './erp.js';
import {
  add,
  allocate,
  formatAmount,
  money,
  parseAmount,
  sub,
  zero,
  type Money,
} from './money.js';
import { unitsFromDecimal, unitsToDecimal, priceToDecimal, valueOfUnits } from './units.js';
import type { UnitTransaction } from './unitlinked.js';

export interface FundBpsWeight {
  readonly fundId: string;
  readonly bps: number;
}

export function validateBpsWeights(weights: readonly FundBpsWeight[]): { valid: boolean; errors: string[] } {
  const errors: string[] = [];
  if (weights.length === 0) {
    errors.push('At least one fund with a positive weight is required');
    return { valid: false, errors };
  }
  let total = 0;
  const seen = new Set<string>();
  for (const w of weights) {
    if (!w.fundId) errors.push('Fund id is required');
    if (seen.has(w.fundId)) errors.push(`Duplicate fund ${w.fundId}`);
    seen.add(w.fundId);
    if (!Number.isInteger(w.bps) || w.bps <= 0 || w.bps > TOTAL_WEIGHT_BPS) {
      errors.push(`Invalid weight ${w.bps} bps for ${w.fundId}`);
    }
    total += w.bps;
  }
  if (total !== TOTAL_WEIGHT_BPS) {
    errors.push(`Fund allocation weights must sum to 100.00% (10,000 bps), got ${(total / 100).toFixed(2)}% (${total} bps)`);
  }
  return { valid: errors.length === 0, errors };
}

export function splitMoneyByWeights(
  total: Money,
  weights: readonly FundBpsWeight[],
): Array<{ fundId: string; bps: number; amount: Money }> {
  const check = validateBpsWeights(weights);
  if (!check.valid) throw new UnitLinkedStatementError(check.errors.join('; '));
  const amounts = allocate(total, weights.map((w) => w.bps));
  return weights.map((w, idx) => ({
    fundId: w.fundId,
    bps: w.bps,
    amount: amounts[idx] ?? zero(total.currency),
  }));
}

export class UnitLinkedStatementError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UnitLinkedStatementError';
  }
}

export type StatementStageId =
  | 'funds-receipt'
  | 'entry-deductions'
  | 'unit-conversion'
  | 'mortality-admin-deductions'
  | 'fund-switches'
  | 'settlements-withdrawals';

export interface ProcessFlowStep {
  readonly stepNumber: number;
  readonly stageId: StatementStageId;
  readonly title: string;
  readonly subtitle: string;
  readonly grossInOrVolume: string;
  readonly deductions: string;
  readonly netEffect: string;
  readonly unitsImpact: string;
  readonly transactionCount: number;
  readonly ledgerAccounts: readonly string[];
  readonly status: 'active' | 'completed' | 'standby';
}

export type StatementMovementKind =
  | 'regular-premium-allocation'
  | 'adhoc-topup-allocation'
  | 'roundup-allocation'
  | 'mortality-coi-deduction'
  | 'admin-fee-deduction'
  | 'fund-switch-out'
  | 'fund-switch-in'
  | 'partial-withdrawal-settlement'
  | 'surrender-settlement';

export interface UnitLinkedStatementLine {
  readonly lineNo: number;
  readonly transactionId: string;
  readonly instructionId: string | null;
  readonly at: string;
  readonly valuationDate: string;
  readonly movementKind: StatementMovementKind;
  readonly movementLabel: string;
  readonly processStage: StatementStageId;
  readonly fundId: string;
  readonly fundName: string;
  readonly grossAmount: string;
  readonly deductionCode: string | null;
  readonly deductionAmount: string;
  readonly deductionBasis: string | null;
  readonly netCashAmount: string;
  readonly navPrice: string;
  readonly unitEffect: 'unit-conversion' | 'unit-deduction';
  readonly unitsDelta: string;
  readonly runningFundUnits: string;
  readonly runningPolicyUnits: string;
  readonly dealingExplanation: string;
  readonly journalIds: readonly string[];
  readonly note: string;
}

export interface FundStatementPosition {
  readonly fundId: string;
  readonly fundName: string;
  readonly shariahScreened: boolean;
  readonly currency: string;
  readonly latestNav: string;
  readonly navValuationDate: string;
  readonly standingTargetBps: number;
  readonly standingTargetPct: string;
  readonly actualWeightBps: number;
  readonly actualWeightPct: string;
  readonly driftBps: number;
  readonly driftPct: string;
  readonly unitsConvertedIn: string;
  readonly unitsDeductedOut: string;
  readonly closingUnits: string;
  readonly closingValue: string;
}

export interface ScheduledCadencePreview {
  readonly activeFrequency: PaymentFrequency;
  readonly annualisedPremium: string;
  readonly activeInstalmentAmount: string;
  readonly options: ReadonlyArray<{
    readonly frequency: 'monthly' | 'quarterly' | 'semi-annual' | 'annual';
    readonly periodsPerYear: number;
    readonly instalmentAmount: string;
    readonly isCurrent: boolean;
  }>;
}

export interface UnitLinkedPolicyStatement {
  readonly policyId: string;
  readonly partyId: string;
  readonly holderName: string;
  readonly holderNameAr: string | null;
  readonly productId: string;
  readonly productName: string;
  readonly entityId: string;
  readonly currency: string;
  readonly status: string;
  readonly commencement: string;
  readonly sumAssured: string;
  readonly autoRebalanceMonths: number | null;
  readonly valuationAsOf: string;
  readonly reproducedFromLog: boolean;
  readonly cadence: ScheduledCadencePreview;
  readonly nextMonthlyDeductionsEstimate: {
    readonly mortalityCoi: string;
    readonly mortalityBasis: string;
    readonly adminFee: string;
    readonly totalMonthlyDeduction: string;
  };
  readonly chargeSchedule: {
    readonly allocationChargeBps: number;
    readonly topupChargeBps: number;
    readonly monthlyAdminFee: string;
    readonly switchingFeeBps: number;
    readonly partialWithdrawalFeeBps: number;
  };
  readonly summary: {
    readonly regularPremiumGross: string;
    readonly adHocTopUpGross: string;
    readonly roundUpGross: string;
    readonly totalFundsReceivedGross: string;
    readonly allocationFeeDeducted: string;
    readonly topUpFeeDeducted: string;
    readonly totalEntryFeesDeducted: string;
    readonly netInvestedIntoFunds: string;
    readonly mortalityDeductedAmount: string;
    readonly mortalityUnitsCancelled: string;
    readonly adminFeeDeductedAmount: string;
    readonly adminUnitsCancelled: string;
    readonly switchingGrossVolume: string;
    readonly switchingFeeDeducted: string;
    readonly withdrawalGrossRealised: string;
    readonly withdrawalFeeDeducted: string;
    readonly settlementsPaidToCustomer: string;
    readonly withdrawalUnitsCancelled: string;
    readonly totalUnitsConverted: string;
    readonly totalUnitsDeducted: string;
    readonly closingUnitsTotal: string;
    readonly closingFundValue: string;
  };
  readonly availableFunds: ReadonlyArray<{
    readonly fundId: string;
    readonly fundName: string;
    readonly currency: string;
    readonly shariahScreened: boolean;
    readonly latestNav: string;
    readonly navValuationDate: string;
    readonly dealingCutOff: string;
    readonly pricingBasis: string;
  }>;
  readonly funds: readonly FundStatementPosition[];
  /** Only recorded recommendations; null means no recommendation is on file. */
  readonly recommendedFunds: ReadonlyArray<{ fundId: string; fundName: string; weightPct: string }> | null;
  /** Valuation-day balances. These are not investment returns; cash flows affect them. */
  readonly fundHistory: ReadonlyArray<{ date: string; daysSinceCommencement: number; funds: ReadonlyArray<{ fundId: string; value: string | null; units: string }> }>;
  readonly processFlow: readonly ProcessFlowStep[];
  readonly lines: readonly UnitLinkedStatementLine[];
}

/* ========================================================= HELPERS */

export function assertUnitLinkedPolicy(w: World, policyId: string): ErpPolicy {
  const id = (policyId ?? '').trim();
  if (!id) throw new UnitLinkedStatementError('policyId is required');
  const policy = w.erp.getPolicy(id);
  if (!policy) throw new UnitLinkedStatementError(`Unknown policy ${id}`);
  if (policy.category !== 'unit-linked') {
    throw new UnitLinkedStatementError(
      `Policy ${id} (${policy.category}) is not a unit-linked product — unit-linked fund statements and dealing operations apply exclusively to unit-linked policies.`,
    );
  }
  if (!w.unitLinked.hasPolicy(id)) {
    throw new UnitLinkedStatementError(`Policy ${id} has no unit-linked investment account registered`);
  }
  return policy;
}

function latestNavDate(w: World): string {
  return w.nav.listFunds().reduce((max, f) => {
    const d = w.nav.latestValuation(f.id)?.valuationDate ?? w.asOf;
    return d > max ? d : max;
  }, w.asOf);
}

function periodsPerYearFor(freq: PaymentFrequency): number {
  switch (freq) {
    case 'monthly': return 12;
    case 'quarterly': return 4;
    case 'semi-annual': return 2;
    case 'annual': return 1;
    case 'single': return 1;
    case 'payg': return 12;
  }
}

export function instalmentForFrequency(annualPremium: Money, frequency: PaymentFrequency): Money {
  const periods = periodsPerYearFor(frequency);
  if (periods <= 1) return annualPremium;
  const parts = allocate(annualPremium, Array.from({ length: periods }, () => 1));
  return parts[0] ?? annualPremium;
}

function normalizeWeights(
  w: World,
  currency: string,
  weights: ReadonlyArray<{ fundId: string; weightBps: number }>,
): FundBpsWeight[] {
  if (!Array.isArray(weights) || weights.length === 0) {
    throw new UnitLinkedStatementError('At least one fund allocation weight is required');
  }
  const seen = new Set<string>();
  const cleaned: FundBpsWeight[] = [];
  for (const raw of weights) {
    const fundId = (raw.fundId ?? '').trim();
    const bps = Math.round(Number(raw.weightBps));
    if (!fundId) throw new UnitLinkedStatementError('Fund id cannot be empty');
    if (!Number.isFinite(bps) || bps < 0) {
      throw new UnitLinkedStatementError(`Invalid weight ${raw.weightBps} bps for fund ${fundId}`);
    }
    if (bps === 0) continue;
    if (seen.has(fundId)) {
      throw new UnitLinkedStatementError(`Duplicate fund ${fundId} in allocation weights`);
    }
    const fund = w.nav.fund(fundId);
    if (fund.currency !== currency) {
      throw new UnitLinkedStatementError(`Fund ${fundId} (${fund.currency}) does not match policy currency ${currency}`);
    }
    seen.add(fundId);
    cleaned.push({ fundId, bps });
  }
  const check = validateBpsWeights(cleaned);
  if (!check.valid) {
    throw new UnitLinkedStatementError(check.errors.join('; '));
  }
  return cleaned;
}

function classifyTransaction(txn: UnitTransaction): {
  movementKind: StatementMovementKind;
  movementLabel: string;
  processStage: StatementStageId;
} {
  if (txn.type === 'allocation') {
    return {
      movementKind: 'regular-premium-allocation',
      movementLabel: 'Scheduled Premium -> Allocation & Unit Conversion',
      processStage: 'unit-conversion',
    };
  }
  if (txn.type === 'topup') {
    if (txn.channel === 'debit-card-roundup') {
      return {
        movementKind: 'roundup-allocation',
        movementLabel: 'Debit-Card Spare-Change Round-Up -> Unit Conversion',
        processStage: 'unit-conversion',
      };
    }
    return {
      movementKind: 'adhoc-topup-allocation',
      movementLabel: 'Ad-Hoc Investment Payment -> Unit Conversion',
      processStage: 'unit-conversion',
    };
  }
  if (txn.type === 'charge') {
    const code = txn.charges[0]?.code;
    if (code === 'coi') {
      return {
        movementKind: 'mortality-coi-deduction',
        movementLabel: 'Mortality (COI) Deduction -> Unit Cancellation',
        processStage: 'mortality-admin-deductions',
      };
    }
    return {
      movementKind: 'admin-fee-deduction',
      movementLabel: 'Administration Fee Deduction -> Unit Cancellation',
      processStage: 'mortality-admin-deductions',
    };
  }
  if (txn.type === 'switch-out') {
    return {
      movementKind: 'fund-switch-out',
      movementLabel: 'Fund Switch Out -> Unit Redemption',
      processStage: 'fund-switches',
    };
  }
  if (txn.type === 'switch-in') {
    return {
      movementKind: 'fund-switch-in',
      movementLabel: 'Fund Switch In -> Unit Conversion',
      processStage: 'fund-switches',
    };
  }
  if (txn.type === 'withdrawal') {
    return {
      movementKind: 'partial-withdrawal-settlement',
      movementLabel: 'Partial Withdrawal -> Unit Realisation & Settlement',
      processStage: 'settlements-withdrawals',
    };
  }
  return {
    movementKind: 'surrender-settlement',
    movementLabel: 'Full Surrender -> Unit Realisation & Final Settlement',
    processStage: 'settlements-withdrawals',
  };
}

/* ========================================================= STATEMENT BUILDER */

export function buildUnitLinkedStatement(w: World, policyId: string): UnitLinkedPolicyStatement {
  const policy = assertUnitLinkedPolicy(w, policyId);
  const ccy = policy.currency;
  const valDate = latestNavDate(w);
  // The unit engine keeps append order, which can include backdated instructions.
  // Display by instruction time while retaining append order for equal timestamps.
  const txns = [...w.unitLinked.transactions(policy.policyId)].sort((a, b) => {
    const delta = Date.parse(a.instructionAt) - Date.parse(b.instructionAt);
    return Number.isFinite(delta) ? delta : 0;
  });
  const valuation = w.unitLinked.valueOf(policy.policyId, valDate);
  const reproduced = w.unitLinked.reproduce(policy.policyId);
  const currentHoldings = w.unitLinked.unitsHeld(policy.policyId);
  const reproducedFromLog = reproduced.ok;

  let regularPremiumGross = zero(ccy);
  let adHocTopUpGross = zero(ccy);
  let roundUpGross = zero(ccy);
  let allocationFeeDeducted = zero(ccy);
  let topUpFeeDeducted = zero(ccy);
  let netInvestedIntoFunds = zero(ccy);

  let mortalityDeductedAmount = zero(ccy);
  let mortalityUnitsCancelled = 0n;
  let adminFeeDeductedAmount = zero(ccy);
  let adminUnitsCancelled = 0n;

  let switchingGrossVolume = zero(ccy);
  let switchingFeeDeducted = zero(ccy);
  let switchInUnits = 0n;
  let switchOutUnits = 0n;

  let withdrawalGrossRealised = zero(ccy);
  let withdrawalFeeDeducted = zero(ccy);
  let settlementsPaidToCustomer = zero(ccy);
  let withdrawalUnitsCancelled = 0n;

  let totalUnitsConverted = 0n;
  let totalUnitsDeducted = 0n;
  let receiptCount = 0;
  let entryFeeCount = 0;
  let conversionCount = 0;
  let deductionCount = 0;
  let switchCount = 0;
  let settlementCount = 0;

  const runningByFund = new Map<string, bigint>();
  const convertedByFund = new Map<string, bigint>();
  const deductedByFund = new Map<string, bigint>();
  let runningPolicyUnits = 0n;

  const lines: UnitLinkedStatementLine[] = txns.map((txn, idx) => {
    const fund = w.nav.fund(txn.fundId);
    const prevFundUnits = runningByFund.get(txn.fundId) ?? 0n;
    const nextFundUnits = prevFundUnits + txn.units;
    runningByFund.set(txn.fundId, nextFundUnits);
    runningPolicyUnits += txn.units;

    if (txn.units >= 0n) {
      totalUnitsConverted += txn.units;
      convertedByFund.set(txn.fundId, (convertedByFund.get(txn.fundId) ?? 0n) + txn.units);
    } else {
      const absUnits = -txn.units;
      totalUnitsDeducted += absUnits;
      deductedByFund.set(txn.fundId, (deductedByFund.get(txn.fundId) ?? 0n) + absUnits);
    }

    const primaryCharge = txn.charges[0];
    const chargeAmt = primaryCharge ? primaryCharge.amount : zero(ccy);
    let grossAmt = txn.value;
    let netCash = txn.value;

    if (txn.type === 'allocation') {
      const gross = txn.grossAmount ?? add(txn.value, chargeAmt);
      grossAmt = gross;
      netCash = sub(gross, chargeAmt);
      regularPremiumGross = add(regularPremiumGross, gross);
      allocationFeeDeducted = add(allocationFeeDeducted, chargeAmt);
      netInvestedIntoFunds = add(netInvestedIntoFunds, netCash);
      receiptCount += 1;
      if (chargeAmt.minor > 0n) entryFeeCount += 1;
      conversionCount += 1;
    } else if (txn.type === 'topup') {
      const gross = txn.grossAmount ?? add(txn.value, chargeAmt);
      grossAmt = gross;
      netCash = sub(gross, chargeAmt);
      if (txn.channel === 'debit-card-roundup') {
        roundUpGross = add(roundUpGross, gross);
      } else {
        adHocTopUpGross = add(adHocTopUpGross, gross);
      }
      topUpFeeDeducted = add(topUpFeeDeducted, chargeAmt);
      netInvestedIntoFunds = add(netInvestedIntoFunds, netCash);
      receiptCount += 1;
      if (chargeAmt.minor > 0n) entryFeeCount += 1;
      conversionCount += 1;
    } else if (txn.type === 'charge') {
      deductionCount += 1;
      grossAmt = txn.value;
      netCash = zero(ccy);
      if (primaryCharge?.code === 'coi') {
        mortalityDeductedAmount = add(mortalityDeductedAmount, txn.value);
        mortalityUnitsCancelled += -txn.units;
      } else {
        adminFeeDeductedAmount = add(adminFeeDeductedAmount, txn.value);
        adminUnitsCancelled += -txn.units;
      }
    } else if (txn.type === 'switch-out') {
      switchCount += 1;
      switchingGrossVolume = add(switchingGrossVolume, txn.value);
      switchingFeeDeducted = add(switchingFeeDeducted, chargeAmt);
      switchOutUnits += -txn.units;
      grossAmt = txn.value;
      netCash = sub(txn.value, chargeAmt);
    } else if (txn.type === 'switch-in') {
      switchInUnits += txn.units;
      grossAmt = txn.value;
      netCash = txn.value;
    } else if (txn.type === 'withdrawal' || txn.type === 'surrender') {
      settlementCount += 1;
      withdrawalGrossRealised = add(withdrawalGrossRealised, txn.value);
      withdrawalFeeDeducted = add(withdrawalFeeDeducted, chargeAmt);
      const payout = sub(txn.value, chargeAmt);
      settlementsPaidToCustomer = add(settlementsPaidToCustomer, payout);
      withdrawalUnitsCancelled += -txn.units;
      grossAmt = txn.value;
      netCash = payout;
    }

    const classified = classifyTransaction(txn);
    return {
      lineNo: idx + 1,
      transactionId: txn.id,
      instructionId: txn.instructionId ?? null,
      at: txn.instructionAt,
      valuationDate: txn.dealingPoint.valuationDate,
      movementKind: classified.movementKind,
      movementLabel: classified.movementLabel,
      processStage: classified.processStage,
      fundId: txn.fundId,
      fundName: fund.name,
      grossAmount: formatAmount(grossAmt),
      deductionCode: primaryCharge ? primaryCharge.code : null,
      deductionAmount: formatAmount(chargeAmt),
      deductionBasis: primaryCharge ? primaryCharge.basis : null,
      netCashAmount: formatAmount(netCash),
      navPrice: `${priceToDecimal(txn.pricePerUnit)} ${txn.pricePerUnit.currency}`,
      unitEffect: txn.units >= 0n ? 'unit-conversion' : 'unit-deduction',
      unitsDelta: txn.units >= 0n ? `+${unitsToDecimal(txn.units)}` : unitsToDecimal(txn.units),
      runningFundUnits: unitsToDecimal(nextFundUnits),
      runningPolicyUnits: unitsToDecimal(runningPolicyUnits),
      dealingExplanation: txn.dealingPoint.explanation,
      journalIds: [...txn.journalIds],
      note: txn.note,
    };
  });

  const totalFundsReceivedGross = add(add(regularPremiumGross, adHocTopUpGross), roundUpGross);
  const totalEntryFeesDeducted = add(allocationFeeDeducted, topUpFeeDeducted);
  const totalPeriodicDeductions = add(mortalityDeductedAmount, adminFeeDeductedAmount);
  const totalPeriodicUnits = mortalityUnitsCancelled + adminUnitsCancelled;

  // Standing target map + all relevant funds on policy or in NAV catalogue for policy currency
  const targetMap = new Map<string, number>();
  for (const tw of policy.targetWeights ?? []) {
    targetMap.set(tw.fundId, tw.weightBps);
  }
  const totalPortfolioMinor = valuation.total.minor;
  const allCurrencyFunds = w.nav.listFunds().filter((f) => f.currency === ccy);
  const relevantFundIds = new Set<string>([
    ...targetMap.keys(),
    ...currentHoldings.map((h) => h.fundId),
    ...allCurrencyFunds.map((f) => f.id),
  ]);

  const funds: FundStatementPosition[] = [...relevantFundIds].map((fundId) => {
    const f = w.nav.fund(fundId);
    const latest = w.nav.latestValuation(fundId);
    const price = latest ? latest.pricePerUnit : w.nav.priceAt(fundId, valDate);
    const navValuationDate = latest ? latest.valuationDate : valDate;
    const closingUnits = w.unitLinked.unitsOf(policy.policyId, fundId);
    const closingVal = valueOfUnits(closingUnits, price);
    const standingTargetBps = targetMap.get(fundId) ?? 0;
    const actualWeightBps = totalPortfolioMinor > 0n
      ? Number((closingVal.minor * 10_000n) / totalPortfolioMinor)
      : 0;
    const driftBps = actualWeightBps - standingTargetBps;
    return {
      fundId,
      fundName: f.name,
      shariahScreened: f.shariahScreened,
      currency: f.currency,
      latestNav: `${priceToDecimal(price)} ${price.currency}`,
      navValuationDate,
      standingTargetBps,
      standingTargetPct: `${(standingTargetBps / 100).toFixed(2)}%`,
      actualWeightBps,
      actualWeightPct: `${(actualWeightBps / 100).toFixed(2)}%`,
      driftBps,
      driftPct: `${driftBps >= 0 ? '+' : ''}${(driftBps / 100).toFixed(2)}%`,
      unitsConvertedIn: unitsToDecimal(convertedByFund.get(fundId) ?? 0n),
      unitsDeductedOut: unitsToDecimal(deductedByFund.get(fundId) ?? 0n),
      closingUnits: unitsToDecimal(closingUnits),
      closingValue: formatAmount(closingVal),
    };
  });

  const selectedFunds = funds.filter((fund) => fund.standingTargetBps > 0 || w.unitLinked.unitsOf(policy.policyId, fund.fundId) > 0n);
  const historyDates = [...new Set([policy.commencement, ...selectedFunds.flatMap((fund) => w.nav.valuationHistory(fund.fundId)
    .map((valuation) => valuation.valuationDate)
    .filter((date) => date >= policy.commencement && date <= valDate))])].sort();
  const fundHistory = historyDates.map((date) => ({
    date,
    daysSinceCommencement: Math.floor((Date.parse(`${date}T00:00:00Z`) - Date.parse(`${policy.commencement}T00:00:00Z`)) / 86_400_000),
    funds: selectedFunds.map((fund) => {
      const units = txns.filter((txn) => txn.fundId === fund.fundId && txn.instructionAt.slice(0, 10) <= date)
        .reduce((sum, txn) => sum + txn.units, 0n);
      const valuations = w.nav.valuationHistory(fund.fundId).filter((entry) => entry.valuationDate <= date);
      const latestDate = valuations.reduce((latest, entry) => entry.valuationDate > latest ? entry.valuationDate : latest, '');
      const latest = valuations.filter((entry) => entry.valuationDate === latestDate).at(-1);
      return { fundId: fund.fundId, units: unitsToDecimal(units), value: latest ? formatAmount(valueOfUnits(units, latest.pricePerUnit)) : null };
    }),
  }));
  const rec = policy.recommendationRecord;
  const recordedRecommendation = rec && rec.funds.length > 0 && (rec.funds.length !== (policy.targetWeights?.length ?? 0) || rec.funds.some((r) => !policy.targetWeights?.some((t) => t.fundId === r.fundId && t.weightBps === r.weightBps)));
  const recommendedFunds = recordedRecommendation ? rec.funds.map((weight) => ({
    fundId: weight.fundId,
    fundName: w.nav.fund(weight.fundId).name,
    weightPct: `${(weight.weightBps / 100).toFixed(2)}%`,
  })) : null;

  const availableFunds = allCurrencyFunds.map((f) => {
    const latest = w.nav.latestValuation(f.id);
    const price = latest ? latest.pricePerUnit : w.nav.priceAt(f.id, valDate);
    const offsetHours = f.dealingRule.utcOffsetMinutes / 60;
    const tzSign = offsetHours >= 0 ? '+' : '';
    return {
      fundId: f.id,
      fundName: f.name,
      currency: f.currency,
      shariahScreened: f.shariahScreened,
      latestNav: `${priceToDecimal(price)} ${price.currency}`,
      navValuationDate: latest ? latest.valuationDate : valDate,
      dealingCutOff: `${f.dealingRule.cutoff} (UTC${tzSign}${offsetHours})`,
      pricingBasis: f.pricingBasis,
    };
  });

  const entity = policy.entityId;
  const processFlow: ProcessFlowStep[] = [
    {
      stepNumber: 1,
      stageId: 'funds-receipt',
      title: '1. Funds & Premium Receipt',
      subtitle: `Regular (${policy.paymentFrequency}), ad-hoc extra payments & debit-card spare-change round-ups`,
      grossInOrVolume: formatAmount(totalFundsReceivedGross),
      deductions: formatAmount(zero(ccy)),
      netEffect: `Regular ${formatAmount(regularPremiumGross)} · Ad-hoc ${formatAmount(adHocTopUpGross)} · Round-up ${formatAmount(roundUpGross)}`,
      unitsImpact: 'Pending NAV dealing cut-off',
      transactionCount: receiptCount,
      ledgerAccounts: [`${entity}:CASH`, `${entity}:FUND_CLEARING`],
      status: receiptCount > 0 ? 'completed' : 'standby',
    },
    {
      stepNumber: 2,
      stageId: 'entry-deductions',
      title: '2. Entry & Allocation Charge Deductions',
      subtitle: 'Front-end premium allocation & top-up fee retention before unit purchase',
      grossInOrVolume: formatAmount(totalFundsReceivedGross),
      deductions: formatAmount(totalEntryFeesDeducted),
      netEffect: `Net investable ${formatAmount(netInvestedIntoFunds)}`,
      unitsImpact: `Alloc fee ${formatAmount(allocationFeeDeducted)} · Top-up fee ${formatAmount(topUpFeeDeducted)}`,
      transactionCount: entryFeeCount,
      ledgerAccounts: [`${entity}:FUND_CLEARING`, `${entity}:FEE:allocation`, `${entity}:FEE:topup`],
      status: entryFeeCount > 0 || receiptCount > 0 ? 'completed' : 'standby',
    },
    {
      stepNumber: 3,
      stageId: 'unit-conversion',
      title: '3. Fund Allocations & Unit Conversions',
      subtitle: 'Percentage split across segregated funds and conversion into 6-dp units at NAV',
      grossInOrVolume: formatAmount(netInvestedIntoFunds),
      deductions: formatAmount(zero(ccy)),
      netEffect: `${formatAmount(netInvestedIntoFunds)} invested across segregated funds`,
      unitsImpact: `+${unitsToDecimal(totalUnitsConverted - switchInUnits)} units created`,
      transactionCount: conversionCount,
      ledgerAccounts: [`${entity}:FUND:*:PARTICIPANTS`, `${entity}:FUND:*:INVESTMENTS`],
      status: conversionCount > 0 ? 'completed' : 'standby',
    },
    {
      stepNumber: 4,
      stageId: 'mortality-admin-deductions',
      title: '4. Mortality (COI) & Admin Fee Deductions',
      subtitle: 'Monthly risk mortality & policy administration fees settled by unit cancellation',
      grossInOrVolume: formatAmount(totalPeriodicDeductions),
      deductions: formatAmount(totalPeriodicDeductions),
      netEffect: `COI ${formatAmount(mortalityDeductedAmount)} · Admin ${formatAmount(adminFeeDeductedAmount)}`,
      unitsImpact: `-${unitsToDecimal(totalPeriodicUnits)} units deducted`,
      transactionCount: deductionCount,
      ledgerAccounts: [`${entity}:FUND:*:PARTICIPANTS`, `${entity}:FEE:coi`, `${entity}:FEE:admin`],
      status: deductionCount > 0 ? 'completed' : 'standby',
    },
    {
      stepNumber: 5,
      stageId: 'fund-switches',
      title: '5. Fund Switches & Allocation Rebalancing',
      subtitle: 'Atomic unit redemption out of source fund and unit conversion into target fund',
      grossInOrVolume: formatAmount(switchingGrossVolume),
      deductions: formatAmount(switchingFeeDeducted),
      netEffect: formatAmount(sub(switchingGrossVolume, switchingFeeDeducted)),
      unitsImpact: `-${unitsToDecimal(switchOutUnits)} out / +${unitsToDecimal(switchInUnits)} in`,
      transactionCount: switchCount,
      ledgerAccounts: [`${entity}:FUND:*:PARTICIPANTS`, `${entity}:FUND_CLEARING`, `${entity}:FEE:switching`],
      status: switchCount > 0 ? 'completed' : 'standby',
    },
    {
      stepNumber: 6,
      stageId: 'settlements-withdrawals',
      title: '6. Withdrawals, Settlements & Live Valuation',
      subtitle: 'Partial withdrawals, surrender settlements, closing unit balance & NAV valuation',
      grossInOrVolume: formatAmount(withdrawalGrossRealised),
      deductions: formatAmount(withdrawalFeeDeducted),
      netEffect: `Settled ${formatAmount(settlementsPaidToCustomer)} · Live value ${formatAmount(valuation.total)}`,
      unitsImpact: `-${unitsToDecimal(withdrawalUnitsCancelled)} withdrawn · ${unitsToDecimal(runningPolicyUnits)} closing units`,
      transactionCount: settlementCount,
      ledgerAccounts: [`${entity}:FUND:*:PARTICIPANTS`, `${entity}:FEE:partial-withdrawal`, `${entity}:CASH`],
      status: policy.status === 'surrendered' ? 'completed' : 'active',
    },
  ];

  const schedule = w.unitLinked.chargeSchedule();
  const coiEstimate = w.erp.mortalityChargeForPolicy(w, policy.policyId);
  const adminMoney = money(BigInt(schedule.adminFeeMonthlyMinor), ccy);
  const cadenceFrequencies: ReadonlyArray<'monthly' | 'quarterly' | 'semi-annual' | 'annual'> = [
    'monthly',
    'quarterly',
    'semi-annual',
    'annual',
  ];

  return {
    policyId: policy.policyId,
    partyId: policy.partyId,
    holderName: policy.holderName,
    holderNameAr: policy.holderNameAr ?? null,
    productId: policy.productId,
    productName: policy.productName,
    entityId: policy.entityId,
    currency: ccy,
    status: policy.status,
    commencement: policy.commencement,
    sumAssured: formatAmount(policy.sumAssured),
    autoRebalanceMonths: policy.autoRebalanceMonths ?? null,
    valuationAsOf: valDate,
    reproducedFromLog,
    cadence: {
      activeFrequency: policy.paymentFrequency,
      annualisedPremium: formatAmount(policy.annualPremium),
      activeInstalmentAmount: formatAmount(instalmentForFrequency(policy.annualPremium, policy.paymentFrequency)),
      options: cadenceFrequencies.map((freq) => ({
        frequency: freq,
        periodsPerYear: periodsPerYearFor(freq),
        instalmentAmount: formatAmount(instalmentForFrequency(policy.annualPremium, freq)),
        isCurrent: policy.paymentFrequency === freq,
      })),
    },
    nextMonthlyDeductionsEstimate: {
      mortalityCoi: formatAmount(coiEstimate.amount),
      mortalityBasis: coiEstimate.basis,
      adminFee: formatAmount(adminMoney),
      totalMonthlyDeduction: formatAmount(add(coiEstimate.amount, adminMoney)),
    },
    chargeSchedule: {
      allocationChargeBps: schedule.allocationChargeBps,
      topupChargeBps: schedule.topupChargeBps,
      monthlyAdminFee: formatAmount(adminMoney),
      switchingFeeBps: schedule.switchingFeeBps,
      partialWithdrawalFeeBps: schedule.partialWithdrawalFeeBps,
    },
    summary: {
      regularPremiumGross: formatAmount(regularPremiumGross),
      adHocTopUpGross: formatAmount(adHocTopUpGross),
      roundUpGross: formatAmount(roundUpGross),
      totalFundsReceivedGross: formatAmount(totalFundsReceivedGross),
      allocationFeeDeducted: formatAmount(allocationFeeDeducted),
      topUpFeeDeducted: formatAmount(topUpFeeDeducted),
      totalEntryFeesDeducted: formatAmount(totalEntryFeesDeducted),
      netInvestedIntoFunds: formatAmount(netInvestedIntoFunds),
      mortalityDeductedAmount: formatAmount(mortalityDeductedAmount),
      mortalityUnitsCancelled: unitsToDecimal(mortalityUnitsCancelled),
      adminFeeDeductedAmount: formatAmount(adminFeeDeductedAmount),
      adminUnitsCancelled: unitsToDecimal(adminUnitsCancelled),
      switchingGrossVolume: formatAmount(switchingGrossVolume),
      switchingFeeDeducted: formatAmount(switchingFeeDeducted),
      withdrawalGrossRealised: formatAmount(withdrawalGrossRealised),
      withdrawalFeeDeducted: formatAmount(withdrawalFeeDeducted),
      settlementsPaidToCustomer: formatAmount(settlementsPaidToCustomer),
      withdrawalUnitsCancelled: unitsToDecimal(withdrawalUnitsCancelled),
      totalUnitsConverted: unitsToDecimal(totalUnitsConverted),
      totalUnitsDeducted: unitsToDecimal(totalUnitsDeducted),
      closingUnitsTotal: unitsToDecimal(runningPolicyUnits),
      closingFundValue: formatAmount(valuation.total),
    },
    availableFunds,
    funds,
    recommendedFunds,
    fundHistory,
    processFlow,
    lines,
  };
}

export function listUnitLinkedStatements(w: World): UnitLinkedPolicyStatement[] {
  return w.erp.listUnitLinkedPolicies().map((p) => buildUnitLinkedStatement(w, p.policyId));
}

/* ========================================================= SERVICING ACTIONS */

export interface UnitLinkedPaymentInput {
  readonly policyId: string;
  readonly paymentKind: 'scheduled-premium' | 'ad-hoc-topup';
  readonly billingFrequency?: 'monthly' | 'quarterly' | 'semi-annual' | 'annual';
  readonly updatePolicyFrequency?: boolean;
  readonly amount?: string | number;
  readonly allocations?: ReadonlyArray<{ fundId: string; weightBps: number }>;
  readonly saveAsStandingAllocations?: boolean;
  readonly paymentMethod?: string;
  readonly chargeBpsOverride?: number;
  readonly at?: string;
  readonly by?: string;
  readonly note?: string;
}

export function executeUnitLinkedInvestmentPayment(w: World, input: UnitLinkedPaymentInput) {
  const policy = assertUnitLinkedPolicy(w, input.policyId);
  if (policy.status === 'cancelled' || policy.status === 'surrendered') {
    throw new UnitLinkedStatementError(`Policy ${policy.policyId} is ${policy.status} and cannot accept investments`);
  }
  const at = input.at ?? `${w.asOf}T10:30:00+04:00`;
  const by = input.by ?? 'policy-servicing';

  let gross: Money;
  if (input.amount !== undefined && String(input.amount).trim() !== '') {
    gross = parseAmount(String(input.amount).trim(), policy.currency);
  } else if (input.paymentKind === 'scheduled-premium') {
    const freq = input.billingFrequency ?? policy.paymentFrequency;
    gross = instalmentForFrequency(policy.annualPremium, freq);
  } else {
    throw new UnitLinkedStatementError('Amount is required for ad-hoc investment payments');
  }
  if (gross.minor <= 0n) {
    throw new UnitLinkedStatementError('Payment amount must be greater than zero');
  }

  const rawWeights = input.allocations && input.allocations.length > 0
    ? input.allocations
    : (policy.targetWeights && policy.targetWeights.length > 0
      ? policy.targetWeights
      : [{ fundId: w.nav.listFunds()[0]?.id ?? 'FBAL', weightBps: 10_000 }]);

  const normalized = normalizeWeights(w, policy.currency, rawWeights);
  const legs = splitMoneyByWeights(gross, normalized).filter((l) => l.amount.minor > 0n);
  if (legs.length === 0) {
    throw new UnitLinkedStatementError('Payment amount is too small to split across selected funds');
  }

  // Resolve every dealing price before changing policy settings or posting the first leg.
  // This prevents a missing NAV on a later fund from leaving an earlier leg posted. It is
  // not a substitute for durable atomicity or idempotency when any later posting fails.
  for (const leg of legs) {
    const fund = w.nav.fund(leg.fundId);
    const dealingPoint = resolveDealingPoint(fund.dealingRule, at, fund.calendar);
    w.nav.priceAt(leg.fundId, dealingPoint.valuationDate);
  }

  if (input.billingFrequency && input.updatePolicyFrequency) {
    const beforeFreq = policy.paymentFrequency;
    if (beforeFreq !== input.billingFrequency) {
      policy.paymentFrequency = input.billingFrequency;
      w.erp.recordAlterationRecord({
        policyId: policy.policyId,
        partyId: policy.partyId,
        category: 'non-financial',
        type: 'non-financial',
        kind: 'payment-frequency',
        before: beforeFreq,
        after: input.billingFrequency,
        summary: `Billing frequency updated from ${beforeFreq} to ${input.billingFrequency}`,
        journalIds: [],
        at,
        by,
        reason: 'Policyholder scheduled cadence selection',
      });
    }
  }

  if (input.saveAsStandingAllocations) {
    const nextWeights = normalized.map((nw) => ({ fundId: nw.fundId, weightBps: nw.bps }));
    const before = (policy.targetWeights ?? []).map((t) => `${t.fundId}:${(t.weightBps / 100).toFixed(1)}%`).join(', ') || 'none';
    const after = nextWeights.map((t) => `${t.fundId}:${(t.weightBps / 100).toFixed(1)}%`).join(', ');
    policy.targetWeights = nextWeights;
    w.unitLinked.updatePolicyMeta(policy.policyId, { targetWeights: nextWeights });
    w.erp.recordAlterationRecord({
      policyId: policy.policyId,
      partyId: policy.partyId,
      category: 'non-financial',
      type: 'non-financial',
      kind: 'rebalance-weights',
      before,
      after,
      summary: `Standing fund allocation updated to ${after}`,
      journalIds: [],
      at,
      by,
      reason: 'Saved new allocation percentages during investment payment',
    });
  }

  const createdTxns: UnitTransaction[] = [];
  const receiptIds: string[] = [];

  for (let i = 0; i < legs.length; i++) {
    const leg = legs[i]!;
    const txn = input.paymentKind === 'scheduled-premium'
      ? w.unitLinked.payPremium({
        policyId: policy.policyId,
        premium: leg.amount,
        fundId: leg.fundId,
        instructionAt: at,
        ...(input.chargeBpsOverride !== undefined ? { allocationChargeBps: input.chargeBpsOverride } : {}),
      })
      : w.unitLinked.payTopUp({
        policyId: policy.policyId,
        amount: leg.amount,
        fundId: leg.fundId,
        instructionAt: at,
        channel: 'ad-hoc-topup',
        ...(input.chargeBpsOverride !== undefined ? { topupChargeBps: input.chargeBpsOverride } : {}),
        ...(input.note ? { notePrefix: input.note } : {}),
      });
    createdTxns.push(txn);
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
      paymentMethod: input.paymentMethod ?? 'bank-transfer',
      journalIds: txn.journalIds,
      note: input.note
        ?? (input.paymentKind === 'scheduled-premium'
          ? `Scheduled (${input.billingFrequency ?? policy.paymentFrequency}) premium allocation (${(leg.bps / 100).toFixed(2)}%) into ${leg.fundId}`
          : `Ad-hoc extra allocation (${(leg.bps / 100).toFixed(2)}%) into ${leg.fundId}`),
    });
    receiptIds.push(receipt.id);
  }

  return {
    policyId: policy.policyId,
    paymentKind: input.paymentKind,
    grossAmount: formatAmount(gross),
    receiptIds,
    allocations: createdTxns.map((t) => ({
      transactionId: t.id,
      fundId: t.fundId,
      unitsConverted: unitsToDecimal(t.units),
      navPrice: `${priceToDecimal(t.pricePerUnit)} ${t.pricePerUnit.currency}`,
      feeDeducted: formatAmount(t.charges[0]?.amount ?? zero(policy.currency)),
      netInvested: formatAmount(t.value),
      journalIds: t.journalIds,
    })),
    statement: buildUnitLinkedStatement(w, policy.policyId),
  };
}

export interface UpdateStandingAllocationsInput {
  readonly policyId: string;
  readonly allocations: ReadonlyArray<{ fundId: string; weightBps: number }>;
  readonly paymentFrequency?: 'monthly' | 'quarterly' | 'semi-annual' | 'annual';
  readonly annualPremium?: string | number;
  readonly autoRebalanceMonths?: number | null;
  readonly rebalanceExistingNow?: boolean;
  readonly at?: string;
  readonly by?: string;
  readonly reason?: string;
}

export function updateUnitLinkedAllocations(w: World, input: UpdateStandingAllocationsInput) {
  const policy = assertUnitLinkedPolicy(w, input.policyId);
  const at = input.at ?? `${w.asOf}T11:00:00+04:00`;
  const by = input.by ?? 'policy-servicing';
  const normalized = normalizeWeights(w, policy.currency, input.allocations);
  const nextWeights = normalized.map((nw) => ({ fundId: nw.fundId, weightBps: nw.bps }));

  const beforeLabel = (policy.targetWeights ?? [])
    .map((t) => `${t.fundId} ${(t.weightBps / 100).toFixed(2)}%`)
    .join(' + ') || 'Unassigned';
  const afterLabel = nextWeights
    .map((t) => `${t.fundId} ${(t.weightBps / 100).toFixed(2)}%`)
    .join(' + ');

  policy.targetWeights = nextWeights;
  if (input.autoRebalanceMonths !== undefined) {
    if (input.autoRebalanceMonths === null || input.autoRebalanceMonths <= 0) {
      delete policy.autoRebalanceMonths;
    } else {
      policy.autoRebalanceMonths = Math.round(input.autoRebalanceMonths);
    }
  }
  w.unitLinked.updatePolicyMeta(policy.policyId, {
    targetWeights: nextWeights,
    ...(policy.autoRebalanceMonths !== undefined ? { autoRebalanceMonths: policy.autoRebalanceMonths } : {}),
  });

  if (input.paymentFrequency && input.paymentFrequency !== policy.paymentFrequency) {
    const prev = policy.paymentFrequency;
    policy.paymentFrequency = input.paymentFrequency;
    w.erp.recordAlterationRecord({
      policyId: policy.policyId,
      partyId: policy.partyId,
      category: 'non-financial',
      type: 'non-financial',
      kind: 'payment-frequency',
      before: prev,
      after: input.paymentFrequency,
      summary: `Scheduled premium cadence changed from ${prev} to ${input.paymentFrequency}`,
      journalIds: [],
      at,
      by,
      reason: input.reason ?? 'Policyholder updated regular premium schedule',
    });
  }

  if (input.annualPremium !== undefined && String(input.annualPremium).trim() !== '') {
    const nextAnnual = parseAmount(String(input.annualPremium).trim(), policy.currency);
    if (nextAnnual.minor <= 0n) {
      throw new UnitLinkedStatementError('Annualised scheduled premium must be greater than zero');
    }
    policy.annualPremium = nextAnnual;
  }

  w.erp.recordAlterationRecord({
    policyId: policy.policyId,
    partyId: policy.partyId,
    category: 'non-financial',
    type: 'non-financial',
    kind: 'rebalance-weights',
    before: beforeLabel,
    after: afterLabel,
    summary: `Standing fund allocation weights updated: ${afterLabel}`,
    journalIds: [],
    at,
    by,
    reason: input.reason ?? 'Policyholder updated standing fund allocation percentages',
  });

  let rebalanceSwitchedCount = 0;
  if (input.rebalanceExistingNow) {
    const priorCount = w.unitLinked.transactions(policy.policyId).length;
    const reb = w.unitLinked.rebalance({ policyId: policy.policyId, instructionAt: at });
    rebalanceSwitchedCount = reb.length;
    if (reb.length > 0) {
      const journals = w.unitLinked.transactions(policy.policyId).slice(priorCount).flatMap((t) => t.journalIds);
      w.erp.recordAlterationRecord({
        policyId: policy.policyId,
        partyId: policy.partyId,
        category: 'financial',
        type: 'financial',
        kind: 'portfolio-rebalance',
        before: beforeLabel,
        after: afterLabel,
        summary: `Existing holdings rebalanced across ${reb.length} switch leg(s) to ${afterLabel}`,
        journalIds: journals,
        at,
        by,
        reason: input.reason ?? 'Immediate portfolio rebalance to new standing allocation',
      });
    }
  }

  return {
    policyId: policy.policyId,
    standingAllocations: nextWeights,
    rebalanceSwitchedCount,
    statement: buildUnitLinkedStatement(w, policy.policyId),
  };
}

export interface UnitLinkedSwitchInput {
  readonly policyId: string;
  readonly fromFundId: string;
  readonly toFundId: string;
  readonly mode: 'percentage' | 'amount' | 'units';
  readonly percentage?: number;
  readonly amount?: string | number;
  readonly units?: string;
  readonly switchingFeeBps?: number;
  readonly at?: string;
  readonly by?: string;
  readonly reason?: string;
}

export function executeUnitLinkedSwitch(w: World, input: UnitLinkedSwitchInput) {
  const policy = assertUnitLinkedPolicy(w, input.policyId);
  if (policy.status === 'cancelled' || policy.status === 'surrendered') {
    throw new UnitLinkedStatementError(`Policy ${policy.policyId} is ${policy.status} and cannot switch funds`);
  }
  const at = input.at ?? `${w.asOf}T11:30:00+04:00`;
  const by = input.by ?? 'policy-servicing';

  let result: { out: UnitTransaction; in: UnitTransaction; instructionId: string };
  if (input.mode === 'percentage') {
    const pct = Number(input.percentage);
    if (!Number.isFinite(pct) || pct <= 0 || pct > 100) {
      throw new UnitLinkedStatementError('Switch percentage must be between 0.01% and 100%');
    }
    const bps = Math.round(pct * 100);
    result = w.unitLinked.switchByPercentage({
      policyId: policy.policyId,
      fromFundId: input.fromFundId,
      toFundId: input.toFundId,
      percentageBps: bps,
      instructionAt: at,
      ...(input.switchingFeeBps !== undefined ? { switchingFeeBps: input.switchingFeeBps } : {}),
    });
  } else if (input.mode === 'units') {
    if (!input.units || !input.units.trim()) {
      throw new UnitLinkedStatementError('Unit quantity is required when switching by units');
    }
    const unitQty = unitsFromDecimal(input.units.trim());
    result = w.unitLinked.switchFund({
      policyId: policy.policyId,
      fromFundId: input.fromFundId,
      toFundId: input.toFundId,
      units: unitQty,
      instructionAt: at,
      ...(input.switchingFeeBps !== undefined ? { switchingFeeBps: input.switchingFeeBps } : {}),
    });
  } else {
    if (input.amount === undefined || String(input.amount).trim() === '') {
      throw new UnitLinkedStatementError('Switch amount is required when switching by amount');
    }
    const amt = parseAmount(String(input.amount).trim(), policy.currency);
    result = w.unitLinked.switchFund({
      policyId: policy.policyId,
      fromFundId: input.fromFundId,
      toFundId: input.toFundId,
      amount: amt,
      instructionAt: at,
      ...(input.switchingFeeBps !== undefined ? { switchingFeeBps: input.switchingFeeBps } : {}),
    });
  }

  const fee = result.out.charges[0]?.amount ?? zero(policy.currency);
  w.erp.recordAlterationRecord({
    policyId: policy.policyId,
    partyId: policy.partyId,
    category: 'financial',
    type: 'financial',
    kind: 'fund-switch',
    before: `${input.fromFundId} (${unitsToDecimal(-result.out.units)} units redeemed)`,
    after: `${input.toFundId} (+${unitsToDecimal(result.in.units)} units converted)`,
    summary: `Switched ${formatAmount(result.out.value)} from ${input.fromFundId} into ${input.toFundId} (${result.instructionId})`,
    amount: result.out.value,
    fee,
    journalIds: result.out.journalIds,
    at,
    by,
    reason: input.reason ?? 'Policyholder fund switch instruction',
  });

  return {
    policyId: policy.policyId,
    instructionId: result.instructionId,
    switchedOut: {
      fundId: result.out.fundId,
      unitsDeducted: unitsToDecimal(-result.out.units),
      grossValue: formatAmount(result.out.value),
      feeDeducted: formatAmount(fee),
    },
    switchedIn: {
      fundId: result.in.fundId,
      unitsConverted: unitsToDecimal(result.in.units),
      netValue: formatAmount(result.in.value),
    },
    statement: buildUnitLinkedStatement(w, policy.policyId),
  };
}

export interface UnitLinkedDeductionInput {
  readonly policyId: string;
  readonly deductionKind: 'coi' | 'admin' | 'monthly-cycle';
  readonly fundId?: string;
  readonly amount?: string | number;
  readonly at?: string;
  readonly by?: string;
  readonly basis?: string;
}

export function executeUnitLinkedDeduction(w: World, input: UnitLinkedDeductionInput) {
  const policy = assertUnitLinkedPolicy(w, input.policyId);
  requirePolicyChargeRules(policy.policyId);
  if (policy.status === 'cancelled' || policy.status === 'surrendered') {
    throw new UnitLinkedStatementError(`Policy ${policy.policyId} is ${policy.status} and cannot take unit deductions`);
  }
  const at = input.at ?? `${w.asOf}T09:00:00+04:00`;
  const by = input.by ?? 'policy-batch';
  const schedule = w.unitLinked.chargeSchedule();

  const pickDefaultFund = (): string => {
    if (input.fundId && input.fundId.trim()) return input.fundId.trim();
    const valDate = latestNavDate(w);
    const val = w.unitLinked.valueOf(policy.policyId, valDate);
    const sorted = [...val.byFund].sort((a, b) => (b.value.minor > a.value.minor ? 1 : b.value.minor < a.value.minor ? -1 : 0));
    const best = sorted.find((f) => f.units > 0n);
    if (!best) throw new UnitLinkedStatementError(`Policy ${policy.policyId} holds no units to deduct charges from`);
    return best.fundId;
  };

  const targetFundId = pickDefaultFund();
  const executed: Array<{ code: 'coi' | 'admin'; txn: UnitTransaction }> = [];

  if (input.deductionKind === 'coi' || input.deductionKind === 'monthly-cycle') {
    const coiCalc = w.erp.mortalityChargeForPolicy(w, policy.policyId);
    const coiAmt = input.deductionKind === 'coi' && input.amount !== undefined && String(input.amount).trim() !== ''
      ? parseAmount(String(input.amount).trim(), policy.currency)
      : coiCalc.amount;
    if (coiAmt.minor > 0n) {
      const txn = w.unitLinked.chargePolicy({
        policyId: policy.policyId,
        fundId: targetFundId,
        code: 'coi',
        amount: coiAmt,
        instructionAt: at,
        basis: input.basis ?? coiCalc.basis,
      });
      executed.push({ code: 'coi', txn });
    }
  }

  if (input.deductionKind === 'admin' || input.deductionKind === 'monthly-cycle') {
    const defaultAdmin = money(BigInt(schedule.adminFeeMonthlyMinor), policy.currency);
    const adminAmt = input.deductionKind === 'admin' && input.amount !== undefined && String(input.amount).trim() !== ''
      ? parseAmount(String(input.amount).trim(), policy.currency)
      : defaultAdmin;
    if (adminAmt.minor > 0n) {
      const txn = w.unitLinked.chargePolicy({
        policyId: policy.policyId,
        fundId: targetFundId,
        code: 'admin',
        amount: adminAmt,
        instructionAt: at,
        basis: input.basis ?? `Monthly policy administration fee (${formatAmount(adminAmt)})`,
      });
      executed.push({ code: 'admin', txn });
    }
  }

  for (const item of executed) {
    w.erp.recordAlterationRecord({
      policyId: policy.policyId,
      partyId: policy.partyId,
      category: 'financial',
      type: 'financial',
      kind: 'policy-charge',
      before: `${item.txn.fundId} before ${item.code.toUpperCase()}`,
      after: `${unitsToDecimal(-item.txn.units)} units cancelled`,
      summary: `${item.code === 'coi' ? 'Mortality (COI)' : 'Administration'} deduction ${formatAmount(item.txn.value)} from ${item.txn.fundId}`,
      amount: item.txn.value,
      journalIds: item.txn.journalIds,
      at,
      by,
      reason: item.txn.charges[0]?.basis ?? 'Monthly policy unit deduction',
    });
  }

  return {
    policyId: policy.policyId,
    deductions: executed.map((e) => ({
      code: e.code,
      transactionId: e.txn.id,
      fundId: e.txn.fundId,
      unitsCancelled: unitsToDecimal(-e.txn.units),
      valueDeducted: formatAmount(e.txn.value),
      journalIds: e.txn.journalIds,
    })),
    statement: buildUnitLinkedStatement(w, policy.policyId),
  };
}

export interface UnitLinkedSettlementInput {
  readonly policyId: string;
  readonly settlementKind: 'partial-withdrawal' | 'surrender';
  readonly fundId?: string;
  readonly amount?: string | number;
  readonly feeBps?: number;
  readonly at?: string;
  readonly by?: string;
  readonly reason?: string;
}

export function executeUnitLinkedSettlement(w: World, input: UnitLinkedSettlementInput) {
  const policy = assertUnitLinkedPolicy(w, input.policyId);
  if (policy.status === 'cancelled' || policy.status === 'surrendered') {
    throw new UnitLinkedStatementError(`Policy ${policy.policyId} is already ${policy.status}`);
  }
  const at = input.at ?? `${w.asOf}T14:00:00+04:00`;
  const by = input.by ?? 'policy-servicing';

  if (input.settlementKind === 'partial-withdrawal') {
    if (!input.fundId || !input.fundId.trim()) {
      throw new UnitLinkedStatementError('fundId is required for a partial withdrawal');
    }
    if (input.amount === undefined || String(input.amount).trim() === '') {
      throw new UnitLinkedStatementError('Withdrawal amount is required');
    }
    const amt = parseAmount(String(input.amount).trim(), policy.currency);
    const res = w.unitLinked.partialWithdraw({
      policyId: policy.policyId,
      fundId: input.fundId.trim(),
      amount: amt,
      instructionAt: at,
      ...(input.feeBps !== undefined ? { feeBps: input.feeBps } : {}),
    });
    const fee = res.txn.charges[0]?.amount ?? zero(policy.currency);
    w.erp.recordAlterationRecord({
      policyId: policy.policyId,
      partyId: policy.partyId,
      category: 'financial',
      type: 'financial',
      kind: 'partial-withdrawal',
      before: `${input.fundId.trim()} prior holding`,
      after: `${unitsToDecimal(res.remainingUnits)} units remaining (${formatAmount(res.remainingValue)})`,
      summary: `Partial withdrawal settled ${formatAmount(res.netToCustomer)} from ${input.fundId.trim()}`,
      amount: res.netToCustomer,
      fee,
      journalIds: res.txn.journalIds,
      at,
      by,
      reason: input.reason ?? 'Policyholder partial withdrawal settlement',
    });
    return {
      policyId: policy.policyId,
      settlementKind: 'partial-withdrawal' as const,
      netPaidToCustomer: formatAmount(res.netToCustomer),
      feeDeducted: formatAmount(fee),
      unitsCancelled: unitsToDecimal(-res.txn.units),
      journalIds: res.txn.journalIds,
      statement: buildUnitLinkedStatement(w, policy.policyId),
    };
  }

  // Full policy surrender across all non-zero funds
  if (input.feeBps !== undefined) throw new UnitLinkedStatementError('Surrender fees are determined by the charge schedule');
  const holdings = w.unitLinked.unitsHeld(policy.policyId).filter((h) => h.units > 0n);
  if (!holdings.length) throw new UnitLinkedStatementError('No units available to surrender');
  const results = holdings.map(({ fundId }) => w.unitLinked.surrender({ policyId: policy.policyId, fundId, instructionAt: at }));
  policy.status = 'surrendered';
  const totalPaid = results.reduce((acc, r) => add(acc, r.paid), zero(policy.currency));
  const totalFee = results.reduce((acc, r) => add(acc, r.charge), zero(policy.currency));
  const totalUnits = results.reduce((acc, r) => acc - r.txn.units, 0n);
  const allJournals = results.flatMap((r) => r.txn.journalIds);
  w.erp.recordAlterationRecord({
    policyId: policy.policyId,
    partyId: policy.partyId,
    category: 'financial',
    type: 'financial',
    kind: 'surrender',
    before: 'in-force',
    after: 'surrendered',
    summary: `Full policy surrender settled ${formatAmount(totalPaid)} across ${results.length} fund(s)`,
    amount: totalPaid,
    fee: totalFee,
    journalIds: allJournals,
    at,
    by,
    reason: input.reason ?? 'Policyholder full surrender settlement',
  });
  return {
    policyId: policy.policyId,
    settlementKind: 'surrender' as const,
    netPaidToCustomer: formatAmount(totalPaid),
    feeDeducted: formatAmount(totalFee),
    unitsCancelled: unitsToDecimal(totalUnits),
    journalIds: allJournals,
    statement: buildUnitLinkedStatement(w, policy.policyId),
  };
}
