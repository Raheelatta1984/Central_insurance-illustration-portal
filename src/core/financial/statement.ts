/** Read model derived only from committed financial facts. Missing prices stay unavailable. */
import { formatAmount, money } from '../money.js';
import { priceToDecimal, unitsToDecimal, valueOfUnits } from '../units.js';
import { localCalendarDay, validateWeights } from './book.js';
import { FinancialError, type FinancialState } from './model.js';

export function financialStatement(state: FinancialState, policyId: string, now: string) {
  const policy = state.policies.find((p) => p.policyId === policyId);
  if (!policy) throw new FinancialError('policy not found', 404);
  const today = localCalendarDay(now, policy.timezone);
  const transactions = state.transactions.filter((t) => t.policyId === policyId).sort((a, b) => Date.parse(a.at) - Date.parse(b.at) || a.id.localeCompare(b.id));
  const selected = new Set(policy.selectedFunds.map((f) => f.fundId));
  const holdings = state.holdings.filter((h) => h.policyId === policyId);
  const funds = [...new Set([...selected, ...holdings.map((h) => h.fundId)])].sort().map((fundId) => {
    const holding = holdings.find((h) => h.fundId === fundId);
    const units = BigInt(holding?.units ?? '0');
    const nav = state.nav.filter((n) => n.fundId === fundId && n.currency === policy.currency && n.date <= today).sort((a, b) => a.date.localeCompare(b.date)).at(-1);
    const price = nav ? { micro: BigInt(nav.priceMicro), currency: policy.currency } : null;
    const target = policy.selectedFunds.find((f) => f.fundId === fundId)?.weightBps ?? 0;
    return { fundId, selected: selected.has(fundId), targetWeightBps: target, units: unitsToDecimal(units), navDate: nav?.date ?? null, nav: price ? priceToDecimal(price) : null, value: price ? formatAmount(valueOfUnits(units, price)) : null, valueMinor: price ? valueOfUnits(units, price).minor.toString() : null };
  });
  const dates = [...new Set([policy.commencement, ...state.nav.filter((n) => selected.has(n.fundId) && n.currency === policy.currency && n.date >= policy.commencement && n.date <= today).map((n) => n.date)])].sort();
  const history = dates.map((date) => ({
    date,
    daysSinceCommencement: Math.round((Date.parse(`${date}T00:00:00Z`) - Date.parse(`${policy.commencement}T00:00:00Z`)) / 86400000),
    funds: funds.filter((f) => f.selected).map((f) => {
      const units = transactions.filter((t) => t.fundId === f.fundId && t.at.slice(0, 10) <= date).reduce((n, t) => n + BigInt(t.units), 0n);
      const nav = state.nav.filter((n) => n.fundId === f.fundId && n.currency === policy.currency && n.date <= date).sort((a, b) => a.date.localeCompare(b.date)).at(-1);
      const value = nav ? valueOfUnits(units, { micro: BigInt(nav.priceMicro), currency: policy.currency }) : null;
      return { fundId: f.fundId, units: unitsToDecimal(units), navDate: nav?.date ?? null, value: value ? formatAmount(value) : null };
    }),
  }));
  const total = (types: string[], field: 'grossMinor' | 'chargeMinor' | 'valueMinor') => transactions.filter((t) => types.includes(t.type)).reduce((n, t) => n + BigInt(t[field]), 0n);
  const inflows = ['allocation', 'topup', 'roundup'];
  const knownValues = funds.every((f) => f.valueMinor !== null);
  const recommendation = policy.recommendation;
  validateWeights(policy.selectedFunds);
  const distinct = recommendation !== null && (recommendation.funds.length !== policy.selectedFunds.length || recommendation.funds.some((r) => !policy.selectedFunds.some((s) => s.fundId === r.fundId && s.weightBps === r.weightBps)));
  return {
    policyId, commencement: policy.commencement, timezone: policy.timezone, valuationAsOf: today, currency: policy.currency,
    selectedFunds: funds.filter((f) => f.selected), funds, history,
    summary: {
      grossReceived: formatAmount(money(total(inflows, 'grossMinor'), policy.currency)),
      entryCharges: formatAmount(money(total(inflows, 'chargeMinor'), policy.currency)),
      mortalityCharges: formatAmount(money(transactions.filter((t) => t.chargeCode === 'mortality').reduce((n, t) => n + BigInt(t.chargeMinor), 0n), policy.currency)),
      administrationCharges: formatAmount(money(transactions.filter((t) => t.chargeCode === 'administration').reduce((n, t) => n + BigInt(t.chargeMinor), 0n), policy.currency)),
      closingValue: knownValues ? formatAmount(money(funds.reduce((n, f) => n + BigInt(f.valueMinor ?? '0'), 0n), policy.currency)) : null,
      closingValueStatus: knownValues ? 'valued-from-recorded-nav' : 'unavailable-missing-nav',
      unitsReconcile: funds.every((f) => BigInt(holdings.find((h) => h.fundId === f.fundId)?.units ?? '0') === transactions.filter((t) => t.fundId === f.fundId).reduce((n, t) => n + BigInt(t.units), 0n)),
    },
    recommendation: recommendation && distinct ? { ...recommendation, available: true, displaySeconds: 5, distinctFromSelection: true } : { available: false, reason: recommendation ? 'not-distinct-from-selection' : 'no-recorded-recommendation', displaySeconds: 0 },
    lines: transactions.map((t) => ({ ...t, journalIds: [...t.journalIds], receipt: state.receipts.find((r) => r.id === t.receiptId) ?? null })),
    environment: state.environment, simulated: state.environment === 'demo',
  };
}
export function financialPolicyPage(state: FinancialState, after: string | null, limit: number) {
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new FinancialError('limit must be 1–100', 400);
  const policies = [...state.policies].sort((a, b) => a.policyId.localeCompare(b.policyId)).filter((p) => after === null || p.policyId > after);
  const page = policies.slice(0, limit);
  return { items: page, nextCursor: policies.length > limit ? page.at(-1)?.policyId ?? null : null };
}
