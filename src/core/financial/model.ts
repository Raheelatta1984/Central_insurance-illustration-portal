/** Serializable aggregate for the durable financial book. No engine instances or provider secrets. */
import type { PolicyDistribution, DistributionEvidence } from '../policy-distribution.js';
export type FinancialRuleKind = 'allocation' | 'topup' | 'roundup' | 'administration' | 'mortality' | 'switch' | 'withdrawal' | 'surrender';
export const FINANCIAL_RULE_KINDS: readonly FinancialRuleKind[] = ['allocation', 'topup', 'roundup', 'administration', 'mortality', 'switch', 'withdrawal', 'surrender'];
export type CalculationBasis = 'gross-bps' | 'fixed-minor' | 'sum-assured-per-mille';
export interface RuleScope extends PolicyDistribution { readonly category: string; readonly productId: string }
export interface FinancialRule {
  readonly id: string; readonly version: number; readonly kind: FinancialRuleKind;
  readonly scope: RuleScope | 'global'; readonly globalFallback: boolean;
  readonly basis: CalculationBasis; readonly rate: string | null; readonly amountMinor: string | null;
  readonly currency: string; readonly effectiveFrom: string; readonly effectiveTo: string | null;
  readonly status: 'proposed' | 'approved' | 'disabled';
  readonly proposedBy: string; readonly sourceReference: string;
  readonly approval: { readonly by: string; readonly at: string; readonly reference: string } | null;
  readonly environment: 'live' | 'demo';
}
export interface ConfigurationRequest {
  readonly id: string; readonly key: string; readonly priority: 'P1'; readonly kind: FinancialRuleKind | 'distribution';
  readonly scope: Partial<RuleScope>; readonly policyIds: string[]; readonly reason: string;
  readonly suggestedConfiguration: { readonly scope: Partial<RuleScope> | 'global'; readonly kind: FinancialRuleKind | 'distribution'; readonly basis: null; readonly rate: null; readonly amountMinor: null; readonly currency: string | null; readonly effectiveFrom: null; readonly approval: null };
  status: 'open' | 'resolved'; readonly createdAt: string; updatedAt: string;
  resolution: { readonly by: string; readonly at: string; readonly reference: string } | null;
}
export interface FinancialPolicy {
  readonly policyId: string; readonly partyId: string; readonly category: string; readonly productId: string;
  readonly entityId: string; readonly currency: string; readonly commencement: string; readonly timezone: string;
  distribution: PolicyDistribution | null; readonly distributionEvidence: DistributionEvidence | null;
  readonly sumAssuredMinor: string; readonly instalmentMinor: string; readonly paymentFrequency: 'monthly' | 'annual' | 'single';
  status: 'in-force' | 'paid-up' | 'surrendered'; totalPremiumMinor: string;
  selectedFunds: Array<{ fundId: string; weightBps: number }>;
  recommendation: { readonly recordedBy: string; readonly recordedAt: string; readonly sourceReference: string; readonly funds: Array<{ fundId: string; weightBps: number }> } | null;
}
export interface FinancialHolding { readonly policyId: string; readonly fundId: string; units: string }
export interface FinancialTransaction {
  readonly id: string; readonly commandId: string; readonly policyId: string;
  readonly type: 'allocation' | 'topup' | 'roundup' | 'charge' | 'switch-out' | 'switch-in' | 'withdrawal' | 'surrender';
  readonly fundId: string; readonly units: string; readonly priceMicro: string; readonly valueMinor: string;
  readonly grossMinor: string; readonly chargeMinor: string; readonly residualMinor: string; readonly currency: string;
  readonly chargeCode: string | null; readonly ruleId: string | null; readonly ruleVersion: number | null;
  readonly at: string; readonly valuationDate: string; readonly journalIds: string[]; receiptId: string | null;
  readonly cycle: string | null; readonly instructionId: string;
}
export interface FinancialReceipt {
  readonly id: string; readonly commandId: string; readonly policyId: string; readonly transactionId: string;
  readonly amountMinor: string; readonly feeMinor: string; readonly netMinor: string; readonly currency: string;
  readonly provider: string; readonly providerReference: string; readonly verifiedAt: string; readonly at: string;
}
export interface FinancialJournal {
  readonly id: string; readonly commandId: string; readonly policyId: string; readonly at: string; readonly description: string;
  readonly lines: Array<{ account: string; side: 'debit' | 'credit'; amountMinor: string; currency: string }>;
}
export interface FinancialAlteration { readonly id: string; readonly commandId: string; readonly policyId: string; readonly kind: string; readonly at: string; readonly by: string; readonly transactionIds: string[]; readonly detail: string }
export interface FinancialCycle { readonly policyId: string; readonly cycle: string; readonly kind: FinancialRuleKind; readonly dueDate: string; status: 'posted' | 'blocked'; transactionId: string | null; requestId: string | null; updatedAt: string }
export interface FinancialNav { readonly fundId: string; readonly date: string; readonly priceMicro: string; readonly currency: string; readonly sourceReference: string }
export interface ProviderCard { readonly id: string; readonly policyId: string; readonly provider: string; readonly providerToken: string; readonly mandateReference: string; readonly consentReference: string; readonly last4: string; readonly verifiedAt: string; status: 'active' | 'revoked' }
export interface RoundUpSettings { readonly policyId: string; enabled: boolean; readonly cardId: string | null; readonly stepMajor: number; readonly multiplier: number; readonly monthlyCapMinor: string | null; readonly updatedAt: string; readonly updatedBy: string }
export interface RoundUpEvent { readonly id: string; readonly provider: string; readonly providerEventId: string; readonly policyId: string; readonly cardId: string; readonly purchaseMinor: string; readonly collectedMinor: string; readonly currency: string; readonly at: string; readonly transactionIds: string[]; readonly status: 'invested' | 'skipped-zero' | 'skipped-cap' }
export interface FinancialState {
  readonly schemaVersion: 1; readonly environment: 'live' | 'demo';
  policies: FinancialPolicy[]; holdings: FinancialHolding[]; transactions: FinancialTransaction[];
  receipts: FinancialReceipt[]; journals: FinancialJournal[]; alterations: FinancialAlteration[];
  rules: FinancialRule[]; configurationRequests: ConfigurationRequest[]; cycles: FinancialCycle[]; nav: FinancialNav[];
  cards: ProviderCard[]; roundUpSettings: RoundUpSettings[]; roundUpEvents: RoundUpEvent[];
  sequences: Record<string, string>; backfillAudit: Array<{ policyId: string; evidence: DistributionEvidence; by: string; at: string }>;
  distributionFlags: Array<{ policyId: string; reason: 'missing-evidence' | 'conflict'; sourceRecordIds: string[]; at: string }>;
}
export function emptyFinancialState(environment: 'live' | 'demo' = 'live'): FinancialState {
  return { schemaVersion: 1, environment, policies: [], holdings: [], transactions: [], receipts: [], journals: [], alterations: [], rules: [], configurationRequests: [], cycles: [], nav: [], cards: [], roundUpSettings: [], roundUpEvents: [], sequences: {}, backfillAudit: [], distributionFlags: [] };
}
export interface CommandResult { readonly status: number; readonly body: unknown }
export interface FinancialCommand { readonly scope: string; readonly key: string; readonly requestHash: string; readonly result: CommandResult; readonly at: string }
export interface PaymentEvidence { readonly provider: string; readonly reference: string; readonly amountMinor: string; readonly currency: string; readonly policyId: string }
export interface VerifiedPayment extends PaymentEvidence { readonly verifiedAt: string }
export interface PaymentVerifier { verify(input: PaymentEvidence): Promise<VerifiedPayment> }
export interface CardTokenEvidence { readonly provider: string; readonly token: string; readonly mandateReference: string; readonly consentReference: string; readonly policyId: string; readonly last4: string }
export interface CollectionEvidence { readonly provider: string; readonly eventId: string; readonly token: string; readonly policyId: string; readonly purchaseMinor: string; readonly collectedMinor: string; readonly currency: string; readonly at: string }
export interface CardProvider {
  verifyToken(input: CardTokenEvidence): Promise<{ verifiedAt: string }>;
  verifyCollection(input: CollectionEvidence): Promise<{ verifiedAt: string }>;
}
export class FinancialError extends Error {
  constructor(message: string, readonly status = 409, readonly code = 'FINANCIAL_REFUSED') { super(message); }
}
export class FinancialInProgressError extends FinancialError { constructor() { super('financial command is in progress; retry with the same key', 409, 'IN_PROGRESS'); } }
