/**
 * Staged financial commands. Nothing here performs I/O: the PostgreSQL adapter commits the
 * returned aggregate and its idempotency result in one transaction. A thrown leg leaves the
 * caller's aggregate untouched. Configuration blocks are deliberate, durable non-money results.
 */
import { allocate, money, roundRational, sub, type Money } from '../money.js';
import { unitsForAmount, unitsToRealise, valueOfUnits } from '../units.js';
import { monthlyPolicyAnniversaries } from '../policy-anniversary.js';
import { distributionComplete, distributionScopeKey, formatPolicyId, sameDistribution, validateDistribution, validateEvidence, type DistributionEvidence, type PolicyDistribution } from '../policy-distribution.js';
import { fromJson, toJson, fingerprintOf } from '../persistence.js';
import { calculateSpareChangeRoundUp } from '../roundup.js';
import {
  FinancialError,
  type CardProvider, type CardTokenEvidence, type CollectionEvidence, type CommandResult,
  type ConfigurationRequest, type FinancialJournal, type FinancialPolicy, type FinancialRule,
  type FinancialRuleKind, type RuleScope, type FinancialState, type FinancialTransaction, type PaymentEvidence,
  type PaymentVerifier, type VerifiedPayment,
} from './model.js';

export type FinancialLeg = 'policy' | 'units' | 'receipt' | 'journal' | 'alteration' | 'cycle' | 'configuration' | 'request' | 'provider-event';
/** Test/drill seam only; never accepted from HTTP or environment configuration. */
export type FaultInjector = (leg: FinancialLeg, ordinal: number) => void;
const clone = <T>(value: T): T => fromJson<T>(toJson(value));
const minor = (value: string, field: string, positive = false): bigint => {
  if (!/^(0|[1-9]\d*)$/.test(value) || (positive && BigInt(value) <= 0n)) throw new FinancialError(`${field} must be ${positive ? 'positive' : 'non-negative'} integer minor units`, 400);
  return BigInt(value);
};
const date = (value: string): string => {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value) || !Number.isFinite(Date.parse(`${value}T00:00:00Z`)) || new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) !== value) throw new FinancialError(`invalid calendar date ${value}`, 400);
  return value;
};
const instant = (value: string): string => {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(value) || !Number.isFinite(Date.parse(value))) throw new FinancialError('an ISO timestamp with explicit timezone is required', 400);
  return value;
};
const identifier = (value: string, field: string): string => {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_.:/ -]{1,160}$/.test(value)) throw new FinancialError(`${field} is invalid`, 400);
  return value;
};
export function localCalendarDay(at: string, timezone: string): string {
  instant(at);
  try {
    const parts = new Intl.DateTimeFormat('en-CA', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date(at));
    const get = (type: string) => parts.find((p) => p.type === type)?.value ?? '';
    return `${get('year')}-${get('month')}-${get('day')}`;
  } catch { throw new FinancialError('policy timezone must be a valid IANA timezone', 400); }
}
/** Exact decimal rate to rational micro-units; no floating-point money arithmetic. */
export function decimalRate(value: string): { numerator: bigint; denominator: bigint } {
  if (!/^\d+(?:\.\d{1,6})?$/.test(value)) throw new FinancialError('rate must be a non-negative decimal with at most six places', 400);
  const [whole = '0', fraction = ''] = value.split('.');
  return { numerator: BigInt(whole + fraction.padEnd(6, '0')), denominator: 1_000_000n };
}
function ruleAmount(rule: FinancialRule, basis: Money, sumAssured: Money): bigint {
  if (rule.currency !== basis.currency) throw new FinancialError('rule currency does not match policy currency');
  if (rule.basis === 'fixed-minor') return minor(rule.amountMinor ?? '', 'rule amountMinor');
  const rate = decimalRate(rule.rate ?? '');
  if (rule.basis === 'gross-bps') return roundRational(basis.minor * rate.numerator, rate.denominator * 10_000n);
  if (rule.basis === 'sum-assured-per-mille') return roundRational(sumAssured.minor * rate.numerator, rate.denominator * 1_000n);
  throw new FinancialError('unsupported calculation basis');
}
class ConfigurationBlockedError extends FinancialError {
  constructor(readonly requestId: string, message: string) { super(message, 409, 'CONFIGURATION_REQUIRED'); }
}
export interface CommandContext { readonly id: string; readonly actor: string; readonly at: string; readonly fault?: FaultInjector }
export interface ReconciliationReport { readonly ok: boolean; readonly checks: Array<{ name: string; ok: boolean; detail: string }>; readonly policyCount: number; readonly transactionCount: number; readonly journalCount: number; readonly receiptCount: number }

export class FinancialBook {
  private legOrdinal = 0;
  constructor(private readonly state: FinancialState, private readonly context: CommandContext) { instant(context.at); identifier(context.actor, 'actor'); }
  private leg(name: FinancialLeg): void { this.context.fault?.(name, ++this.legOrdinal); }
  private policy(id: string): FinancialPolicy {
    const policy = this.state.policies.find((p) => p.policyId === id);
    if (!policy) throw new FinancialError('policy not found', 404);
    return policy;
  }
  private active(id: string): FinancialPolicy {
    const p = this.policy(id);
    if (p.status === 'surrendered') throw new FinancialError('surrendered policy cannot be financially mutated');
    return p;
  }
  private holding(policyId: string, fundId: string) {
    let h = this.state.holdings.find((x) => x.policyId === policyId && x.fundId === fundId);
    if (!h) { h = { policyId, fundId, units: '0' }; this.state.holdings.push(h); }
    return h;
  }
  private price(fundId: string, at: string, currency: string) {
    const day = at.slice(0, 10);
    const nav = this.state.nav.filter((n) => n.fundId === fundId && n.date <= day && n.currency === currency).sort((a, b) => a.date.localeCompare(b.date)).at(-1);
    if (!nav || BigInt(nav.priceMicro) <= 0n) throw new FinancialError(`no verified positive NAV for ${fundId} on or before ${day}`);
    return { micro: BigInt(nav.priceMicro), currency, date: nav.date, sourceReference: nav.sourceReference };
  }
  private journal(policy: FinancialPolicy, at: string, description: string, lines: FinancialJournal['lines']): string {
    const totals = new Map<string, bigint>();
    for (const line of lines) {
      const amount = minor(line.amountMinor, 'journal amount');
      totals.set(line.currency, (totals.get(line.currency) ?? 0n) + (line.side === 'debit' ? amount : -amount));
    }
    if (!lines.length || [...totals.values()].some((v) => v !== 0n)) throw new FinancialError('unbalanced financial journal');
    const id = `${this.context.id}-J-${this.state.journals.length + 1}`;
    this.state.journals.push({ id, commandId: this.context.id, policyId: policy.policyId, at, description, lines });
    this.leg('journal');
    return id;
  }
  private transaction(input: Omit<FinancialTransaction, 'id' | 'commandId'>): FinancialTransaction {
    const txn: FinancialTransaction = { ...input, id: `${this.context.id}-T-${this.state.transactions.length + 1}`, commandId: this.context.id };
    const holding = this.holding(input.policyId, input.fundId);
    const next = BigInt(holding.units) + BigInt(input.units);
    if (next < 0n) throw new FinancialError('financial operation would create negative units');
    holding.units = next.toString(); this.leg('units');
    this.state.transactions.push(txn);
    return txn;
  }
  private alteration(policy: FinancialPolicy, kind: string, transactionIds: string[], detail: string): void {
    this.state.alterations.push({ id: `${this.context.id}-A`, commandId: this.context.id, policyId: policy.policyId, kind, at: this.context.at, by: this.context.actor, transactionIds, detail });
    this.leg('alteration');
  }
  private request(kind: ConfigurationRequest['kind'], scope: Partial<RuleScope>, policy: FinancialPolicy | null, reason: string): ConfigurationRequest {
    const key = fingerprintOf({ kind, scope, reason });
    const existing = this.state.configurationRequests.find((r) => r.key === key);
    if (existing) {
      if (policy && !existing.policyIds.includes(policy.policyId)) existing.policyIds.push(policy.policyId);
      return existing;
    }
    const request: ConfigurationRequest = {
      id: `P1-${key.slice(0, 20)}`, key, priority: 'P1', kind, scope, policyIds: policy ? [policy.policyId] : [], reason,
      suggestedConfiguration: { scope: kind === 'distribution' ? scope : 'global', kind, basis: null, rate: null, amountMinor: null, currency: policy?.currency ?? null, effectiveFrom: null, approval: null },
      status: 'open', createdAt: this.context.at, updatedAt: this.context.at, resolution: null,
    };
    this.state.configurationRequests.push(request); this.leg('request');
    return request;
  }
  private resolve(kind: FinancialRuleKind, policy: FinancialPolicy, asOf: string): FinancialRule {
    if (!distributionComplete(policy.distribution)) {
      const request = this.request('distribution', { category: policy.category, productId: policy.productId, ...(policy.distribution ?? {}) }, policy, 'missing-distribution');
      throw new ConfigurationBlockedError(request.id, 'distribution evidence is incomplete; financial transaction blocked');
    }
    const scope: RuleScope = { category: policy.category, productId: policy.productId, ...(policy.distribution ?? {}) };
    const applicable = this.state.rules.filter((r) => r.kind === kind && r.status === 'approved' && r.environment === this.state.environment && r.effectiveFrom <= asOf && (r.effectiveTo === null || asOf < r.effectiveTo));
    const exact = applicable.filter((r) => r.scope !== 'global' && r.scope.category === scope.category && r.scope.productId === scope.productId && sameDistribution(r.scope, scope));
    const global = applicable.filter((r) => r.scope === 'global' && r.globalFallback);
    const matches = exact.length ? exact : global;
    if (matches.length === 1) return matches[0]!;
    const request = this.request(kind, scope, policy, matches.length > 1 ? 'ambiguous-rule' : 'missing-scoped-and-global-rule');
    throw new ConfigurationBlockedError(request.id, matches.length > 1 ? 'overlapping approved rules; transaction blocked' : 'no approved scoped or explicit global rule; transaction blocked');
  }
  private blockedCycle(policy: FinancialPolicy, cycle: { cycle: string; dueDate: string }, kind: FinancialRuleKind, requestId: string): void {
    const existing = this.state.cycles.find((c) => c.policyId === policy.policyId && c.cycle === cycle.cycle && c.kind === kind);
    if (existing?.status === 'posted') throw new FinancialError('posted cycle cannot be replaced');
    if (existing) { existing.status = 'blocked'; existing.requestId = requestId; existing.updatedAt = this.context.at; }
    else this.state.cycles.push({ policyId: policy.policyId, cycle: cycle.cycle, kind, dueDate: cycle.dueDate, status: 'blocked', transactionId: null, requestId, updatedAt: this.context.at });
    this.leg('cycle');
  }
  private markCycle(policy: FinancialPolicy, cycle: string, kind: FinancialRuleKind, txn: FinancialTransaction, dueDate?: string): void {
    const existing = this.state.cycles.find((c) => c.policyId === policy.policyId && c.cycle === cycle && c.kind === kind);
    if (existing?.status === 'posted') throw new FinancialError('rule already processed for this policy and cycle');
    if (existing) { existing.status = 'posted'; existing.transactionId = txn.id; existing.requestId = null; existing.updatedAt = this.context.at; }
    else this.state.cycles.push({ policyId: policy.policyId, cycle, kind, dueDate: dueDate ?? txn.at.slice(0, 10), status: 'posted', transactionId: txn.id, requestId: null, updatedAt: this.context.at });
    this.leg('cycle');
  }

  static execute(state: FinancialState, context: CommandContext, operation: (book: FinancialBook) => unknown): { state: FinancialState; result: CommandResult } {
    const staged = clone(state);
    const book = new FinancialBook(staged, context);
    try {
      const body = operation(book);
      const proof = reconcileFinancialState(staged);
      if (!proof.ok) throw new FinancialError(`financial reconciliation failed: ${proof.checks.filter((c) => !c.ok).map((c) => c.name).join(', ')}`, 500);
      return { state: staged, result: { status: 200, body } };
    } catch (error) {
      if (error instanceof ConfigurationBlockedError) {
        const proof = reconcileFinancialState(staged);
        if (!proof.ok) throw new FinancialError('configuration block could not be durably reconciled', 500);
        return { state: staged, result: { status: 409, body: { error: error.message, code: error.code, requestId: error.requestId, posted: false } } };
      }
      throw error;
    }
  }

  issuePolicy(input: { partyId: string; category: string; productId: string; entityId: string; currency: string; commencement: string; timezone: string; distribution: PolicyDistribution; sumAssuredMinor: string; instalmentMinor: string; paymentFrequency: FinancialPolicy['paymentFrequency']; selectedFunds: FinancialPolicy['selectedFunds']; recommendation?: FinancialPolicy['recommendation'] }): { policyId: string } {
    const distribution = validateDistribution(input.distribution);
    if (!distributionComplete(distribution) || distribution.subChannelCode === null || distribution.partnerId === null) throw new FinancialError('issuance requires channel, sub-channel and partner (explicit NA where applicable)', 400);
    const commencement = date(input.commencement); localCalendarDay(`${commencement}T12:00:00Z`, input.timezone);
    minor(input.sumAssuredMinor, 'sumAssuredMinor', true); minor(input.instalmentMinor, 'instalmentMinor', true);
    if (!/^[A-Z]{3}$/.test(input.currency)) throw new FinancialError('explicit three-letter currency required', 400);
    validateWeights(input.selectedFunds);
    if (input.recommendation) validateWeights(input.recommendation.funds);
    const key = `${input.category}:${distributionScopeKey(input.category, input.productId, distribution)}`;
    const sequence = BigInt(this.state.sequences[key] ?? '0') + 1n;
    this.state.sequences[key] = sequence.toString();
    const policyId = formatPolicyId(input.category, distribution, sequence);
    if (this.state.policies.some((p) => p.policyId === policyId)) throw new FinancialError('policy ID collision');
    const policy: FinancialPolicy = { ...input, policyId, commencement, distribution, distributionEvidence: null, status: 'in-force', totalPremiumMinor: '0', recommendation: input.recommendation ?? null };
    this.state.policies.push(policy); this.leg('policy');
    for (const f of input.selectedFunds) this.holding(policyId, f.fundId);
    return { policyId };
  }

  proposeRule(input: Omit<FinancialRule, 'version' | 'status' | 'proposedBy' | 'approval' | 'environment'>): { ruleId: string; version: number; status: 'proposed' } {
    date(input.effectiveFrom); if (input.effectiveTo) { date(input.effectiveTo); if (input.effectiveTo <= input.effectiveFrom) throw new FinancialError('effectiveTo must follow effectiveFrom', 400); }
    identifier(input.sourceReference, 'sourceReference');
    const permittedBases = input.kind === 'administration' ? ['fixed-minor', 'sum-assured-per-mille'] : input.kind === 'mortality' ? ['sum-assured-per-mille'] : ['gross-bps'];
    if (!permittedBases.includes(input.basis)) throw new FinancialError('calculation basis is not permitted for this rule kind', 400);
    if ((input.scope === 'global') !== input.globalFallback) throw new FinancialError('global fallback must be explicitly configured', 400);
    if (input.scope !== 'global') { validateDistribution(input.scope); if (input.scope.subChannelCode === null || input.scope.partnerId === null) throw new FinancialError('scoped rule requires explicit NA or a known value', 400); }
    if (input.basis === 'fixed-minor') minor(input.amountMinor ?? '', 'amountMinor');
    else { const rate = decimalRate(input.rate ?? ''); if (rate.numerator > 10_000_000_000n) throw new FinancialError('rate exceeds supported bound', 400); }
    const version = Math.max(0, ...this.state.rules.filter((r) => r.id === input.id).map((r) => r.version)) + 1;
    this.state.rules.push({ ...input, version, status: 'proposed', proposedBy: this.context.actor, approval: null, environment: this.state.environment }); this.leg('configuration');
    return { ruleId: input.id, version, status: 'proposed' };
  }
  approveRule(input: { ruleId: string; version: number; reference: string; designatedApprover: string }): { ruleId: string; version: number; status: 'approved' } {
    const rule = this.state.rules.find((r) => r.id === input.ruleId && r.version === input.version);
    if (!rule || rule.status !== 'proposed') throw new FinancialError('rule version is not awaiting approval');
    if (this.context.actor !== input.designatedApprover || rule.proposedBy === this.context.actor) throw new FinancialError('named independent human approval required; self-approval refused', 403);
    identifier(input.reference, 'approval reference');
    if (rule.environment !== this.state.environment) throw new FinancialError('demo rules cannot be approved in a live book');
    const approved: FinancialRule = { ...rule, status: 'approved', approval: { by: this.context.actor, at: this.context.at, reference: input.reference } };
    this.state.rules[this.state.rules.indexOf(rule)] = approved; this.leg('configuration');
    for (const request of this.state.configurationRequests) {
      if (request.status !== 'open' || request.kind !== rule.kind) continue;
      const scope = request.scope;
      const exact = rule.scope !== 'global' && scope.category === rule.scope.category && scope.productId === rule.scope.productId && scope.channelCode === rule.scope.channelCode && scope.subChannelCode === rule.scope.subChannelCode && scope.partnerId === rule.scope.partnerId;
      const globalCoversMissing = rule.scope === 'global' && request.reason === 'missing-scoped-and-global-rule';
      if (exact || globalCoversMissing) { request.status = 'resolved'; request.updatedAt = this.context.at; request.resolution = approved.approval; }
    }
    return { ruleId: rule.id, version: rule.version, status: 'approved' };
  }

  invest(input: { policyId: string; amountMinor: string; kind: 'allocation' | 'topup' | 'roundup'; at: string; evidence: VerifiedPayment; cycle?: string; cycleDueDate?: string }, verifierReady: boolean): { transactionIds: string[]; receiptIds: string[]; journalIds: string[] } {
    if (!verifierReady) throw new FinancialError('payment verification is not configured; no cash or units posted', 503, 'PROVIDER_REQUIRED');
    const policy = this.active(input.policyId); const at = instant(input.at);
    const gross = minor(input.amountMinor, 'amountMinor', true);
    if (input.evidence.policyId !== policy.policyId || input.evidence.amountMinor !== gross.toString() || input.evidence.currency !== policy.currency || Date.parse(input.evidence.verifiedAt) > Date.parse(this.context.at)) throw new FinancialError('verified payment evidence does not match this policy, amount and currency');
    if (input.cycle && this.state.cycles.some((c) => c.policyId === policy.policyId && c.cycle === input.cycle && c.kind === 'allocation' && c.status === 'posted')) throw new FinancialError('premium cycle already processed');
    if (this.state.receipts.some((r) => r.provider === input.evidence.provider && r.providerReference === input.evidence.reference)) throw new FinancialError('provider payment reference already receipted; use the original command key to replay');
    const rule = this.resolve(input.kind, policy, at.slice(0, 10));
    const charge = money(ruleAmount(rule, money(gross, policy.currency), money(BigInt(policy.sumAssuredMinor), policy.currency)), policy.currency);
    if (charge.minor >= gross) throw new FinancialError('configured charge leaves no investable cash');
    const amounts = allocate(money(gross, policy.currency), policy.selectedFunds.map((f) => f.weightBps));
    const transactionIds: string[] = []; const receiptIds: string[] = []; const journalIds: string[] = [];
    // Preflight every fund before the first leg. Dealing uses the recorded valuation on/before instruction date.
    const prices = policy.selectedFunds.map((f) => this.price(f.fundId, at, policy.currency));
    for (let i = 0; i < policy.selectedFunds.length; i++) {
      const fund = policy.selectedFunds[i]!; const grossAmount = amounts[i]!;
      const legCharge = money(ruleAmount(rule, grossAmount, money(BigInt(policy.sumAssuredMinor), policy.currency)), policy.currency);
      const amount = sub(grossAmount, legCharge); const price = prices[i]!;
      if (amount.minor <= 0n) throw new FinancialError('configured charge leaves no investable cash in a selected fund');
      const units = unitsForAmount(amount, price, 'floor');
      if (units <= 0n) throw new FinancialError('net amount is too small for the recorded NAV');
      const value = valueOfUnits(units, price); const residual = sub(amount, value);
      const grossLeg = grossAmount;
      const journals = [this.journal(policy, at, `${input.kind} ${fund.fundId}`, [
        { account: 'cash', side: 'debit', amountMinor: grossLeg.minor.toString(), currency: policy.currency },
        { account: `participant:${fund.fundId}`, side: 'credit', amountMinor: value.minor.toString(), currency: policy.currency },
        { account: `fee:${input.kind}`, side: 'credit', amountMinor: legCharge.minor.toString(), currency: policy.currency },
        { account: `residual:${fund.fundId}`, side: 'credit', amountMinor: residual.minor.toString(), currency: policy.currency },
      ]), this.journal(policy, at, `fund investment ${fund.fundId}`, [
        { account: `investments:${fund.fundId}`, side: 'debit', amountMinor: value.minor.toString(), currency: policy.currency },
        { account: 'cash', side: 'credit', amountMinor: value.minor.toString(), currency: policy.currency },
      ])];
      const txn = this.transaction({ policyId: policy.policyId, type: input.kind, fundId: fund.fundId, units: units.toString(), priceMicro: price.micro.toString(), valueMinor: value.minor.toString(), grossMinor: grossLeg.minor.toString(), chargeMinor: legCharge.minor.toString(), residualMinor: residual.minor.toString(), currency: policy.currency, chargeCode: input.kind, ruleId: rule.id, ruleVersion: rule.version, at, valuationDate: price.date, journalIds: journals, receiptId: null, cycle: input.cycle ?? null, instructionId: this.context.id });
      const receiptId = `${this.context.id}-R-${i + 1}`;
      this.state.receipts.push({ id: receiptId, commandId: this.context.id, policyId: policy.policyId, transactionId: txn.id, amountMinor: grossLeg.minor.toString(), feeMinor: legCharge.minor.toString(), netMinor: amount.minor.toString(), currency: policy.currency, provider: input.evidence.provider, providerReference: input.evidence.reference, verifiedAt: input.evidence.verifiedAt, at }); this.leg('receipt');
      txn.receiptId = receiptId; txn.journalIds.forEach((id) => journalIds.push(id)); transactionIds.push(txn.id); receiptIds.push(receiptId);
    }
    policy.totalPremiumMinor = (BigInt(policy.totalPremiumMinor) + gross).toString(); this.leg('policy');
    if (input.cycle) this.markCycle(policy, input.cycle, 'allocation', this.state.transactions.find((t) => t.id === transactionIds[0])!, input.cycleDueDate);
    this.alteration(policy, input.kind, transactionIds, 'verified cash allocated; residual journaled explicitly');
    return { transactionIds, receiptIds, journalIds };
  }

  deduct(input: { policyId: string; kind: 'administration' | 'mortality'; fundId: string; at: string; cycle?: { cycle: string; dueDate: string } }): { transactionId: string; journalIds: string[] } {
    const policy = this.active(input.policyId); const at = instant(input.at);
    if (input.cycle && this.state.cycles.some((c) => c.policyId === policy.policyId && c.cycle === input.cycle!.cycle && c.kind === input.kind && c.status === 'posted')) throw new FinancialError('rule already processed for this policy and cycle');
    const rule = this.resolve(input.kind, policy, input.cycle?.dueDate ?? at.slice(0, 10));
    const amount = ruleAmount(rule, money(0n, policy.currency), money(BigInt(policy.sumAssuredMinor), policy.currency));
    const price = this.price(input.fundId, at, policy.currency);
    const units = unitsToRealise(money(amount, policy.currency), price);
    if (units < 0n || units > BigInt(this.holding(policy.policyId, input.fundId).units)) throw new FinancialError('insufficient units for configured charge');
    const value = valueOfUnits(units, price);
    const journalIds = [this.journal(policy, at, `${input.kind} units cancelled`, [
      { account: `participant:${input.fundId}`, side: 'debit', amountMinor: value.minor.toString(), currency: policy.currency },
      { account: `fee:${input.kind}`, side: 'credit', amountMinor: value.minor.toString(), currency: policy.currency },
    ]), this.journal(policy, at, `${input.kind} fund disinvestment`, [
      { account: 'cash', side: 'debit', amountMinor: value.minor.toString(), currency: policy.currency },
      { account: `investments:${input.fundId}`, side: 'credit', amountMinor: value.minor.toString(), currency: policy.currency },
    ])];
    const txn = this.transaction({ policyId: policy.policyId, type: 'charge', fundId: input.fundId, units: (-units).toString(), priceMicro: price.micro.toString(), valueMinor: value.minor.toString(), grossMinor: value.minor.toString(), chargeMinor: value.minor.toString(), residualMinor: '0', currency: policy.currency, chargeCode: input.kind, ruleId: rule.id, ruleVersion: rule.version, at, valuationDate: price.date, journalIds, receiptId: null, cycle: input.cycle?.cycle ?? null, instructionId: this.context.id });
    if (input.cycle) this.markCycle(policy, input.cycle.cycle, input.kind, txn, input.cycle.dueDate);
    this.alteration(policy, input.kind, [txn.id], `configured ${input.kind}; actual realised value ${value.minor.toString()} minor units`);
    return { transactionId: txn.id, journalIds };
  }

  switch(input: { policyId: string; fromFundId: string; toFundId: string; units: string; at: string }): { transactionIds: string[]; journalIds: string[] } {
    const policy = this.active(input.policyId); const at = instant(input.at);
    if (input.fromFundId === input.toFundId) throw new FinancialError('switch funds must differ', 400);
    const outUnits = minor(input.units, 'units', true);
    if (outUnits > BigInt(this.holding(policy.policyId, input.fromFundId).units)) throw new FinancialError('insufficient units for switch');
    const from = this.price(input.fromFundId, at, policy.currency); const to = this.price(input.toFundId, at, policy.currency);
    const rule = this.resolve('switch', policy, at.slice(0, 10));
    const gross = valueOfUnits(outUnits, from); const fee = money(ruleAmount(rule, gross, money(BigInt(policy.sumAssuredMinor), policy.currency)), policy.currency);
    const net = sub(gross, fee); const inUnits = unitsForAmount(net, to, 'floor'); const valueIn = valueOfUnits(inUnits, to); const residual = sub(net, valueIn);
    if (inUnits <= 0n || fee.minor >= gross.minor) throw new FinancialError('switch leaves no investable units');
    const journalIds = [this.journal(policy, at, 'atomic switch value conservation', [
      { account: `participant:${input.fromFundId}`, side: 'debit', amountMinor: gross.minor.toString(), currency: policy.currency },
      { account: `participant:${input.toFundId}`, side: 'credit', amountMinor: valueIn.minor.toString(), currency: policy.currency },
      { account: 'fee:switch', side: 'credit', amountMinor: fee.minor.toString(), currency: policy.currency },
      { account: `residual:${input.toFundId}`, side: 'credit', amountMinor: residual.minor.toString(), currency: policy.currency },
    ]), this.journal(policy, at, 'switch fund investments', [
      { account: 'cash', side: 'debit', amountMinor: gross.minor.toString(), currency: policy.currency },
      { account: `investments:${input.fromFundId}`, side: 'credit', amountMinor: gross.minor.toString(), currency: policy.currency },
      { account: `investments:${input.toFundId}`, side: 'debit', amountMinor: valueIn.minor.toString(), currency: policy.currency },
      { account: 'cash', side: 'credit', amountMinor: valueIn.minor.toString(), currency: policy.currency },
    ])];
    const base = { policyId: policy.policyId, priceMicro: from.micro.toString(), valueMinor: gross.minor.toString(), grossMinor: gross.minor.toString(), chargeMinor: fee.minor.toString(), residualMinor: residual.minor.toString(), currency: policy.currency, chargeCode: 'switch', ruleId: rule.id, ruleVersion: rule.version, at, valuationDate: from.date, journalIds, receiptId: null, cycle: null, instructionId: this.context.id };
    const out = this.transaction({ ...base, type: 'switch-out', fundId: input.fromFundId, units: (-outUnits).toString() });
    const inn = this.transaction({ ...base, type: 'switch-in', fundId: input.toFundId, units: inUnits.toString(), priceMicro: to.micro.toString(), valueMinor: valueIn.minor.toString(), grossMinor: valueIn.minor.toString(), chargeMinor: '0', residualMinor: '0', valuationDate: to.date });
    this.alteration(policy, 'switch', [out.id, inn.id], 'both fund legs committed under one instruction');
    return { transactionIds: [out.id, inn.id], journalIds };
  }

  settle(input: { policyId: string; kind: 'withdrawal' | 'surrender'; fundId?: string; amountMinor?: string; at: string }): { transactionIds: string[]; payableMinor: string; status: 'payable-recorded' } {
    const policy = this.active(input.policyId); const at = instant(input.at); const rule = this.resolve(input.kind, policy, at.slice(0, 10));
    const holdings = this.state.holdings.filter((h) => h.policyId === policy.policyId && BigInt(h.units) > 0n && (input.kind !== 'withdrawal' || h.fundId === input.fundId));
    if (!holdings.length) throw new FinancialError('no holding available for servicing');
    const requested = input.kind === 'withdrawal' ? minor(input.amountMinor ?? '', 'amountMinor', true) : null;
    let remaining = requested ?? 0n; let payable = 0n; const transactionIds: string[] = [];
    const plans = holdings.map((h) => {
      const price = this.price(h.fundId, at, policy.currency);
      let units = BigInt(h.units);
      if (requested !== null) {
        // Gross up for the configured fee, then verify the actual rounded net. Iteration is
        // bounded and monotone; a fee change can never silently underpay the requested amount.
        let target = remaining;
        for (let attempt = 0; attempt < 6; attempt++) {
          const needed = unitsToRealise(money(target, policy.currency), price);
          units = needed < BigInt(h.units) ? needed : BigInt(h.units);
          const realised = valueOfUnits(units, price);
          const fee = money(ruleAmount(rule, realised, money(BigInt(policy.sumAssuredMinor), policy.currency)), policy.currency);
          const net = sub(realised, fee);
          if (net.minor >= remaining) break;
          target += remaining - net.minor;
        }
        const realised = valueOfUnits(units, price);
        const fee = money(ruleAmount(rule, realised, money(BigInt(policy.sumAssuredMinor), policy.currency)), policy.currency);
        const net = sub(realised, fee); remaining = net.minor < remaining ? remaining - net.minor : 0n;
      }
      return { h, price, units };
    });
    if (requested !== null && remaining > 0n) throw new FinancialError('insufficient policy value for withdrawal');
    for (const { h, price, units } of plans) {
      const gross = valueOfUnits(units, price); const fee = money(ruleAmount(rule, gross, money(BigInt(policy.sumAssuredMinor), policy.currency)), policy.currency); const net = sub(gross, fee);
      if (net.minor <= 0n) throw new FinancialError('servicing charge leaves no customer payable');
      const journalIds = [this.journal(policy, at, `${input.kind} customer payable`, [
        { account: `participant:${h.fundId}`, side: 'debit', amountMinor: gross.minor.toString(), currency: policy.currency },
        { account: `fee:${input.kind}`, side: 'credit', amountMinor: fee.minor.toString(), currency: policy.currency },
        { account: 'customer-payable', side: 'credit', amountMinor: net.minor.toString(), currency: policy.currency },
      ]), this.journal(policy, at, `${input.kind} disinvestment`, [
        { account: 'cash', side: 'debit', amountMinor: gross.minor.toString(), currency: policy.currency },
        { account: `investments:${h.fundId}`, side: 'credit', amountMinor: gross.minor.toString(), currency: policy.currency },
      ])];
      const txn = this.transaction({ policyId: policy.policyId, type: input.kind, fundId: h.fundId, units: (-units).toString(), priceMicro: price.micro.toString(), valueMinor: gross.minor.toString(), grossMinor: gross.minor.toString(), chargeMinor: fee.minor.toString(), residualMinor: '0', currency: policy.currency, chargeCode: input.kind, ruleId: rule.id, ruleVersion: rule.version, at, valuationDate: price.date, journalIds, receiptId: null, cycle: null, instructionId: this.context.id });
      transactionIds.push(txn.id); payable += net.minor;
    }
    if (input.kind === 'surrender') { policy.status = 'surrendered'; this.leg('policy'); }
    this.alteration(policy, input.kind, transactionIds, 'customer payable recorded; external bank disbursement is a separate verified operation');
    return { transactionIds, payableMinor: payable.toString(), status: 'payable-recorded' };
  }

  runMonthly(input: { policyId: string; through?: string; fundId: string }): { posted: Array<{ cycle: string; kind: FinancialRuleKind; transactionId: string }>; blocked: Array<{ cycle: string; kind: FinancialRuleKind; requestId: string }>; skipped: number } {
    const policy = this.policy(input.policyId); const through = date(input.through ?? localCalendarDay(this.context.at, policy.timezone));
    const cycles = monthlyPolicyAnniversaries(policy.commencement, policy.commencement, through);
    const posted: Array<{ cycle: string; kind: FinancialRuleKind; transactionId: string }> = [];
    const blocked: Array<{ cycle: string; kind: FinancialRuleKind; requestId: string }> = []; let skipped = 0;
    for (const cycle of cycles) for (const kind of ['administration', 'mortality'] as const) {
      if (this.state.cycles.some((c) => c.policyId === policy.policyId && c.cycle === cycle.cycle && c.kind === kind && c.status === 'posted')) { skipped++; continue; }
      if (policy.status === 'surrendered') { skipped++; continue; }
      try {
        const today = localCalendarDay(this.context.at, policy.timezone);
        const at = cycle.dueDate === today ? this.context.at : `${cycle.dueDate}T12:00:00Z`;
        const result = this.deduct({ policyId: policy.policyId, kind, fundId: input.fundId, at, cycle });
        posted.push({ cycle: cycle.cycle, kind, transactionId: result.transactionId });
      } catch (error) {
        if (!(error instanceof ConfigurationBlockedError)) throw error;
        this.blockedCycle(policy, cycle, kind, error.requestId); blocked.push({ cycle: cycle.cycle, kind, requestId: error.requestId });
      }
    }
    return { posted, blocked, skipped };
  }

  backfillDistribution(input: { policyId: string; evidence: DistributionEvidence[]; sourceRecords: unknown[] }): { policyId: string; status: 'updated' | 'unchanged' | 'missing-evidence' | 'conflict' } {
    const policy = this.policy(input.policyId);
    if (input.evidence.length !== input.sourceRecords.length) throw new FinancialError('each source record needs its exact attribution evidence', 400);
    input.evidence.forEach((e, i) => { validateEvidence(policy.policyId, e); if (fingerprintOf(input.sourceRecords[i]) !== e.sourceDigest) throw new FinancialError('source digest does not match the supplied source record'); });
    const unique = input.evidence.filter((e, i, all) => all.findIndex((x) => sameDistribution(x, e)) === i);
    const flag = (reason: 'missing-evidence' | 'conflict') => {
      if (!this.state.distributionFlags.some((f) => f.policyId === policy.policyId && f.reason === reason)) this.state.distributionFlags.push({ policyId: policy.policyId, reason, sourceRecordIds: input.evidence.map((e) => e.sourceRecordId), at: this.context.at });
    };
    if (!unique.length) { flag('missing-evidence'); const request = this.request('distribution', { category: policy.category, productId: policy.productId }, policy, 'missing-distribution-source-evidence'); throw new ConfigurationBlockedError(request.id, 'no verifiable distribution source evidence; backfill blocked'); }
    if (unique.length > 1 || (policy.distribution && !sameDistribution(policy.distribution, unique[0]!))) { flag('conflict'); return { policyId: policy.policyId, status: 'conflict' }; }
    if (policy.distribution) return { policyId: policy.policyId, status: 'unchanged' };
    const evidence = unique[0]!;
    this.state.policies[this.state.policies.indexOf(policy)] = { ...policy, distribution: validateDistribution(evidence), distributionEvidence: evidence };
    this.state.backfillAudit.push({ policyId: policy.policyId, evidence, by: this.context.actor, at: this.context.at }); this.leg('policy');
    return { policyId: policy.policyId, status: 'updated' };
  }
  recordNav(input: { fundId: string; date: string; priceMicro: string; currency: string; sourceReference: string }): void {
    date(input.date); minor(input.priceMicro, 'priceMicro', true); identifier(input.sourceReference, 'sourceReference');
    if (this.state.nav.some((n) => n.fundId === input.fundId && n.date === input.date)) throw new FinancialError('NAV revisions require a new dated source record; existing valuation is immutable');
    this.state.nav.push({ ...input }); this.leg('configuration');
  }
  configureRoundUp(input: { policyId: string; enabled: boolean; cardId: string | null; stepMajor: number; multiplier: number; monthlyCapMinor: string | null }, verified: boolean): { policyId: string; enabled: boolean } {
    const policy = this.active(input.policyId);
    if (!Number.isInteger(input.stepMajor) || input.stepMajor < 1 || input.stepMajor > 10000 || !Number.isInteger(input.multiplier) || input.multiplier < 1 || input.multiplier > 10) throw new FinancialError('invalid round-up settings', 400);
    if (input.monthlyCapMinor !== null) minor(input.monthlyCapMinor, 'monthlyCapMinor', true);
    if (input.enabled) {
      if (!verified) throw new FinancialError('provider token and mandate verification required', 503, 'PROVIDER_REQUIRED');
      const card = this.state.cards.find((c) => c.id === input.cardId && c.policyId === policy.policyId && c.status === 'active');
      if (!card) throw new FinancialError('active provider-tokenised card required');
    }
    const next = { ...input, updatedAt: this.context.at, updatedBy: this.context.actor };
    const index = this.state.roundUpSettings.findIndex((s) => s.policyId === policy.policyId);
    if (index < 0) this.state.roundUpSettings.push(next); else this.state.roundUpSettings[index] = next;
    this.leg('configuration'); return { policyId: policy.policyId, enabled: input.enabled };
  }
  attachVerifiedCard(input: CardTokenEvidence & { verifiedAt: string }): { cardId: string } {
    if (!/^\d{4}$/.test(input.last4) || !input.token.trim() || !input.mandateReference.trim() || !input.consentReference.trim()) throw new FinancialError('provider token, mandate, consent and last4 required', 400);
    this.active(input.policyId);
    const existing = this.state.cards.find((c) => c.provider === input.provider && c.providerToken === input.token && c.policyId === input.policyId && c.status === 'active');
    if (existing) return { cardId: existing.id };
    const id = `${this.context.id}-CARD`;
    this.state.cards.push({ id, policyId: input.policyId, provider: input.provider, providerToken: input.token, mandateReference: input.mandateReference, consentReference: input.consentReference, last4: input.last4, verifiedAt: input.verifiedAt, status: 'active' }); this.leg('configuration');
    return { cardId: id };
  }
  processRoundUp(input: CollectionEvidence & { cardId: string; evidence: VerifiedPayment }, verified: boolean): unknown {
    if (!verified) throw new FinancialError('provider collection verification is not configured', 503, 'PROVIDER_REQUIRED');
    const policy = this.active(input.policyId); const settings = this.state.roundUpSettings.find((s) => s.policyId === policy.policyId);
    const card = this.state.cards.find((c) => c.id === input.cardId && c.policyId === policy.policyId && c.status === 'active');
    if (!settings?.enabled || !card || card.providerToken !== input.token || card.provider !== input.provider) throw new FinancialError('enabled settings and matching provider token required');
    if (this.state.roundUpEvents.some((e) => e.provider === input.provider && e.providerEventId === input.eventId)) throw new FinancialError('provider event already processed');
    const purchase = minor(input.purchaseMinor, 'purchaseMinor', true); minor(input.collectedMinor, 'collectedMinor');
    if (input.currency !== policy.currency) throw new FinancialError('collection currency mismatch');
    const calculation = calculateSpareChangeRoundUp({ purchaseAmount: money(purchase, policy.currency), roundStepMajor: settings.stepMajor, multiplier: settings.multiplier });
    if (calculation.redirectedAmount.minor !== BigInt(input.collectedMinor)) throw new FinancialError('provider collection does not match the durable round-up settings');
    const month = localCalendarDay(input.at, policy.timezone).slice(0, 7);
    const invested = this.state.roundUpEvents.filter((e) => e.policyId === policy.policyId && localCalendarDay(e.at, policy.timezone).slice(0, 7) === month).reduce((n, e) => n + BigInt(e.collectedMinor), 0n);
    const cap = settings.monthlyCapMinor === null ? null : BigInt(settings.monthlyCapMinor);
    const status = calculation.redirectedAmount.minor === 0n ? 'skipped-zero' : cap !== null && invested + BigInt(input.collectedMinor) > cap ? 'skipped-cap' : 'invested';
    let transactionIds: string[] = [];
    if (status === 'invested') {
      const result = this.invest({ policyId: policy.policyId, amountMinor: input.collectedMinor, kind: 'roundup', at: input.at, evidence: input.evidence }, true);
      transactionIds = result.transactionIds;
    }
    this.state.roundUpEvents.push({ id: `${this.context.id}-RU`, provider: input.provider, providerEventId: input.eventId, policyId: policy.policyId, cardId: card.id, purchaseMinor: input.purchaseMinor, collectedMinor: status === 'invested' ? input.collectedMinor : '0', currency: policy.currency, at: input.at, transactionIds, status }); this.leg('provider-event');
    return { status, transactionIds, posted: status === 'invested' };
  }
}

export function validateWeights(weights: ReadonlyArray<{ fundId: string; weightBps: number }>): void {
  if (!weights.length || weights.some((w) => !w.fundId || !Number.isInteger(w.weightBps) || w.weightBps <= 0) || new Set(weights.map((w) => w.fundId)).size !== weights.length || weights.reduce((n, w) => n + w.weightBps, 0) !== 10000) throw new FinancialError('selected funds must be distinct positive weights totaling 10000 bps', 400);
}

export function reconcileFinancialState(state: FinancialState): ReconciliationReport {
  const checks: ReconciliationReport['checks'] = [];
  const check = (name: string, ok: boolean, detail: string) => checks.push({ name, ok, detail });
  const unitLog = new Map<string, bigint>(); const liveUnits = new Map<string, bigint>();
  for (const t of state.transactions) { const key = `${t.policyId}|${t.fundId}`; unitLog.set(key, (unitLog.get(key) ?? 0n) + BigInt(t.units)); }
  for (const h of state.holdings) { const key = `${h.policyId}|${h.fundId}`; liveUnits.set(key, (liveUnits.get(key) ?? 0n) + BigInt(h.units)); }
  const unitKeys = new Set([...unitLog.keys(), ...liveUnits.keys()]);
  const unitMismatches = [...unitKeys].filter((k) => (unitLog.get(k) ?? 0n) !== (liveUnits.get(k) ?? 0n) || (liveUnits.get(k) ?? 0n) < 0n);
  check('units-reproduce-from-log', unitMismatches.length === 0, unitMismatches.join(', ') || 'all holdings equal signed unit transactions');
  const balanced = state.journals.every((j) => { const totals = new Map<string, bigint>(); for (const l of j.lines) totals.set(l.currency, (totals.get(l.currency) ?? 0n) + (l.side === 'debit' ? BigInt(l.amountMinor) : -BigInt(l.amountMinor))); return j.lines.length > 0 && [...totals.values()].every((v) => v === 0n); });
  check('journals-balanced', balanced, `${state.journals.length} journals checked by currency`);
  const journalIds = new Set(state.journals.map((j) => j.id));
  const inflows = state.transactions.filter((t) => ['allocation', 'topup', 'roundup'].includes(t.type));
  const receiptOk = state.receipts.length === inflows.length && inflows.every((t) => state.receipts.filter((r) => r.transactionId === t.id).length === 1) && state.receipts.every((r) => { const t = inflows.find((x) => x.id === r.transactionId); return !!t && BigInt(r.amountMinor) === BigInt(t.grossMinor) && BigInt(r.amountMinor) === BigInt(r.feeMinor) + BigInt(r.netMinor) && BigInt(r.netMinor) === BigInt(t.valueMinor) + BigInt(t.residualMinor); });
  // Receipt gross equals fee plus net investable cash; net equals unit value plus residual.
  const cashOk = state.transactions.every((t) => journalIds.size > 0 && t.journalIds.length > 0 && t.journalIds.every((id) => journalIds.has(id))) && inflows.every((t) => { const r = state.receipts.find((x) => x.transactionId === t.id); return !!r && BigInt(r.amountMinor) === BigInt(t.valueMinor) + BigInt(t.chargeMinor) + BigInt(t.residualMinor); });
  check('receipts-match-inflows', receiptOk && cashOk, 'one receipt per inflow; net cash equals unit value plus explicit residual');
  const premiumsOk = state.policies.every((p) => BigInt(p.totalPremiumMinor) === state.transactions.filter((t) => t.policyId === p.policyId && ['allocation', 'topup', 'roundup'].includes(t.type)).reduce((n, t) => n + BigInt(t.grossMinor), 0n));
  check('policy-premiums-match-log', premiumsOk, 'policy premium totals equal verified inflow cash');
  const cyclesOk = state.cycles.every((c) => c.status !== 'posted' || state.transactions.some((t) => t.id === c.transactionId && t.policyId === c.policyId && t.cycle === c.cycle)) && new Set(state.cycles.map((c) => `${c.policyId}|${c.cycle}|${c.kind}`)).size === state.cycles.length;
  check('cycles-exactly-once', cyclesOk, 'unique policy/cycle/rule markers reference committed transactions');
  const idsOk = new Set(state.transactions.map((t) => t.id)).size === state.transactions.length && new Set(state.journals.map((j) => j.id)).size === state.journals.length && new Set(state.receipts.map((r) => r.id)).size === state.receipts.length;
  check('immutable-record-identities', idsOk, 'transaction, journal and receipt IDs are distinct');
  return { ok: checks.every((c) => c.ok), checks, policyCount: state.policies.length, transactionCount: state.transactions.length, journalCount: state.journals.length, receiptCount: state.receipts.length };
}

/** Independent verifier adapter: recomputes from stored facts, never trusts the implementer's answer. */
export async function verifyPaymentEvidence(input: PaymentEvidence, verifier: PaymentVerifier | undefined, now: string): Promise<VerifiedPayment> {
  if (!verifier) throw new FinancialError('no payment verifier configured; live collection is disabled', 503, 'PROVIDER_REQUIRED');
  const result = await verifier.verify(input);
  if (result.policyId !== input.policyId || result.reference !== input.reference || result.amountMinor !== input.amountMinor || result.currency !== input.currency || !Number.isFinite(Date.parse(result.verifiedAt)) || Date.parse(result.verifiedAt) > Date.parse(now)) throw new FinancialError('payment verifier returned mismatched or future-dated evidence');
  return result;
}
export async function verifyCardToken(input: CardTokenEvidence, provider: CardProvider | undefined): Promise<{ verifiedAt: string }> {
  if (!provider) throw new FinancialError('no card provider configured; local fingerprints are not tokenisation', 503, 'PROVIDER_REQUIRED');
  return provider.verifyToken(input);
}
