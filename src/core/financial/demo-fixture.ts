/** Explicit synthetic fixture. Never imported by live startup or migrations. */
import { DEFAULT_CHARGES } from '../unitlinked.js';
import { priceFromDecimal } from '../units.js';
import { emptyFinancialState, type FinancialRule, type FinancialState, type VerifiedPayment } from './model.js';
import { FinancialBook } from './book.js';
export const DEMO_FINANCE_NOTICE = 'SYNTHETIC DEMO ONLY — illustrative rates and payments are not authorized production configuration or actual postings.';
export function demoFinancialFixture(): FinancialState {
  let state = emptyFinancialState('demo'); let seq = 0;
  const run = (actor: string, fn: (book: FinancialBook) => unknown) => { state = FinancialBook.execute(state, { id: `DEMO-${++seq}`, actor, at: '2026-11-06T08:00:00Z' }, fn).state; };
  let policyId = '';
  run('demo-issuer', (b) => { policyId = b.issuePolicy({ partyId: 'DEMO-PARTY', category: 'UNIT_LINKED', productId: 'DEMO-PRODUCT', entityId: 'DEMO-ENTITY', currency: 'AED', commencement: '2025-01-31', timezone: 'Asia/Dubai', distribution: { channelCode: 'DEMO_CHANNEL', subChannelCode: 'NA', partnerId: 'NA' }, sumAssuredMinor: '100000000', instalmentMinor: '100000', paymentFrequency: 'monthly', selectedFunds: [{ fundId: 'DEMO-FUND', weightBps: 10000 }] }).policyId; });
  run('demo-nav', (b) => b.recordNav({ fundId: 'DEMO-FUND', date: '2025-01-01', priceMicro: priceFromDecimal('10', 'AED').micro.toString(), currency: 'AED', sourceReference: 'SYNTHETIC-NAV' }));
  const rules: Array<Pick<FinancialRule, 'kind' | 'basis' | 'rate' | 'amountMinor'>> = [
    { kind: 'allocation', basis: 'gross-bps', rate: String(DEFAULT_CHARGES.allocationChargeBps), amountMinor: null },
    { kind: 'topup', basis: 'gross-bps', rate: String(DEFAULT_CHARGES.topupChargeBps), amountMinor: null },
    { kind: 'roundup', basis: 'gross-bps', rate: '0', amountMinor: null },
    { kind: 'administration', basis: 'fixed-minor', rate: null, amountMinor: String(DEFAULT_CHARGES.adminFeeMonthlyMinor) },
    { kind: 'mortality', basis: 'sum-assured-per-mille', rate: String(DEFAULT_CHARGES.coiPerMilleMonthly), amountMinor: null },
    { kind: 'switch', basis: 'gross-bps', rate: String(DEFAULT_CHARGES.switchingFeeBps), amountMinor: null },
    { kind: 'withdrawal', basis: 'gross-bps', rate: String(DEFAULT_CHARGES.partialWithdrawalFeeBps), amountMinor: null },
    { kind: 'surrender', basis: 'gross-bps', rate: '0', amountMinor: null },
  ];
  for (const rule of rules) {
    const id = `DEMO-${rule.kind}`;
    run('demo-proposer', (b) => b.proposeRule({ id, kind: rule.kind, scope: 'global', globalFallback: true, basis: rule.basis, rate: rule.rate, amountMinor: rule.amountMinor, currency: 'AED', effectiveFrom: '2025-01-01', effectiveTo: null, sourceReference: 'DEFAULT_CHARGES-ILLUSTRATIVE-ONLY' }));
    run('DEMO-APPROVER-NOT-REAL', (b) => b.approveRule({ ruleId: id, version: 1, reference: 'SYNTHETIC-TEST-FIXTURE-NOT-APPROVAL', designatedApprover: 'DEMO-APPROVER-NOT-REAL' }));
  }
  return state;
}
export function demoPayment(policyId: string, amountMinor: string, reference = 'SYNTHETIC-PAYMENT'): VerifiedPayment {
  return { provider: 'demo-only', reference, amountMinor, currency: 'AED', policyId, verifiedAt: '2026-11-06T07:00:00Z' };
}
export function demoPolicyId(state: FinancialState): string { return state.policies[0]!.policyId; }
