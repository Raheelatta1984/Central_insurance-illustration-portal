/**
 * Funds & Accounting Configuration Engine — country-specific standards, dynamic mappings,
 * event-driven debit/credit and voucher lifecycle.
 *
 * Every insurer runs the same idea differently per jurisdiction: a chart of accounts that
 * follows IFRS 17, SOCPA, CBUAE or BNM layouts, funds that map to GL accounts by many
 * dimensions, and a voucher that is born from a policy event rather than typed by hand.
 *
 * This module is the filing cabinet for all three:
 *  - CountryAccountingStandard: the standard a fund follows in one jurisdiction
 *  - FundAccountingRule: which accounting treatment applies to a product in a country
 *  - FundMap: dynamic many-to-many wiring from funds → GL accounts across product,
 *    sub-product, partner, omni-channel, sub-channel and policy dimensions
 *  - FundEvent + Voucher: an event (deposit, accrual, premium adjustment, allocation,
 *    gain, loss, withdrawal, sum-assured reduction, sum-at-risk change) posts a
 *    balanced double-entry voucher with a first-class description that names policy,
 *    product, partner, channel and fund.
 */

import { convert, formatAmount, money, parseAmount } from './money.js';
import { Ledger, posting } from './ledger.js';

export type CountryCode = string; // ISO-2
export type AccountingStandard = 'IFRS17' | 'IFRS4' | 'SOCPA' | 'CBUAE-GAAP' | 'BNM-MFRS17' | 'LOCAL-GAAP';
export type FundLifeCycleEvent =
  | 'premium-received'
  | 'deposit-amount'
  | 'accrual-to-policy'
  | 'premium-adjustment'
  | 'investment-allocation'
  | 'investment-allocated'
  | 'investment-gain'
  | 'investment-loss'
  | 'investment-withdrawal-partial'
  | 'investment-withdrawal-full'
  | 'sum-assured-reduction'
  | 'sum-at-risk-change'
  | 'processing-charge'
  | 'income-allocation';

export interface CountryAccountingConfig {
  readonly id: string;
  readonly country: CountryCode;
  readonly countryName: string;
  readonly standard: AccountingStandard;
  readonly currency: string;
  readonly fiscalYearEnd: string; // MM-DD
  readonly description: string;
  readonly enabled: boolean;
  readonly updatedAt: string;
  readonly updatedBy: string;
}

export interface FundAccountingRule {
  readonly id: string;
  readonly country: CountryCode;
  readonly productLine: string;
  readonly subProduct?: string;
  readonly fundId: string;
  readonly fundName: string;
  readonly glPrefix: string;
  readonly valuationMethod: 'NAV' | 'BID_OFFER' | 'AMORTISED_COST' | 'FAIR_VALUE';
  readonly revenueRecognition: 'PREMIUM_ALLOCATION' | 'VARIABLE_FEE' | 'GENERAL_MEASUREMENT';
  readonly enabled: boolean;
  readonly note: string;
  readonly updatedAt: string;
}

export interface DynamicFundMapping {
  readonly id: string;
  readonly fundId: string;
  readonly fundName: string;
  readonly country: CountryCode | null; // null = all countries
  readonly eventType: FundLifeCycleEvent | null; // null = all events for this fund
  readonly productId: string | null; // null = all products
  readonly subProduct: string | null;
  readonly partnerId: string | null;
  readonly omniChannel: string | null;
  readonly subChannel: string | null;
  readonly policyId: string | null; // null = all policies in scope
  readonly debitAccount: string;
  readonly creditAccount: string;
  readonly costCentre?: string;
  readonly priority: number; // lower = more specific wins
  readonly descriptionTemplate: string; // e.g. "{{event}} for {{policyId}} via {{partnerId}} on {{fundId}}"
  readonly enabled: boolean;
  readonly updatedAt: string;
  readonly updatedBy: string;
}

export interface VoucherLine {
  readonly account: string;
  readonly side: 'debit' | 'credit';
  readonly amountMinor: bigint;
  readonly currency: string;
  readonly fundId?: string;
}

export interface Voucher {
  readonly id: string;
  readonly eventId: string;
  readonly eventType: FundLifeCycleEvent;
  readonly at: string;
  readonly by: string;
  readonly policyId: string;
  readonly productId: string;
  readonly subProduct?: string;
  readonly partnerId?: string;
  readonly omniChannel?: string;
  readonly subChannel?: string;
  readonly fundId: string;
  readonly amountMinor: bigint;
  readonly currency: string;
  readonly description: string;
  readonly lines: readonly VoucherLine[];
  readonly balanced: boolean;
  readonly mappingId?: string;
  readonly country?: CountryCode;
  readonly ledgerJournalId?: string;
  readonly ledgerEntityId?: string;
}

export interface FundEventInput {
  readonly policyId: string;
  readonly productId: string;
  readonly subProduct?: string;
  readonly partnerId?: string;
  readonly omniChannel?: string;
  readonly subChannel?: string;
  readonly fundId: string;
  readonly eventType: FundLifeCycleEvent;
  readonly amount: string | number; // decimal string
  readonly currency?: string;
  readonly country?: string;
  readonly period?: string; // YYYY-MM for investment income/expense allocations
  readonly descriptionOverride?: string;
  readonly at?: string;
  readonly by?: string;
}

export const EVENT_LABELS: Record<FundLifeCycleEvent, string> = {
  'premium-received': 'Premium received — cash to premium suspense',
  'deposit-amount': 'Deposit amount credited to policy accruals',
  'accrual-to-policy': 'Accrual released to policy fund units',
  'premium-adjustment': 'Policy premium adjustment — additional or refund',
  'investment-allocation': 'Premium earmarked for investment allocation',
  'investment-allocated': 'Investment allocated to fund units at NAV',
  'investment-gain': 'Investment gain credited — NAV uplift',
  'investment-loss': 'Investment loss recognised — NAV drawdown',
  'investment-withdrawal-partial': 'Partial investment withdrawal to policyholder',
  'investment-withdrawal-full': 'Full investment surrender and fund exit',
  'sum-assured-reduction': 'Sum assured reduced — reserve and charge release',
  'sum-at-risk-change': 'Sum at risk recalculated — mortality reserve movement',
  'processing-charge': 'Monthly processing charge deducted',
  'income-allocation': 'Investment income allocated via premium post-adjustment',
};

const DEFAULT_TEMPLATES: Record<FundLifeCycleEvent, { debit: string; credit: string }> = {
  'premium-received': { debit: 'CASH', credit: 'PREMIUM-SUSPENSE' },
  'deposit-amount': { debit: 'PREMIUM-SUSPENSE', credit: 'POLICY-ACCRUAL' },
  'accrual-to-policy': { debit: 'POLICY-ACCRUAL', credit: 'POLICY-FUND-LIABILITY' },
  'premium-adjustment': { debit: 'PREMIUM-SUSPENSE', credit: 'PREMIUM-INCOME' },
  'investment-allocation': { debit: 'POLICY-FUND-LIABILITY', credit: 'INVESTMENT-CLEARING' },
  'investment-allocated': { debit: 'INVESTMENT-CLEARING', credit: 'FUND-UNITS-ISSUED' },
  'investment-gain': { debit: 'FUND-ASSETS', credit: 'INVESTMENT-GAIN' },
  'investment-loss': { debit: 'INVESTMENT-LOSS', credit: 'FUND-ASSETS' },
  'investment-withdrawal-partial': { debit: 'FUND-UNITS-ISSUED', credit: 'CASH' },
  'investment-withdrawal-full': { debit: 'FUND-UNITS-ISSUED', credit: 'CASH' },
  'sum-assured-reduction': { debit: 'INSURANCE-LIABILITY', credit: 'PREMIUM-REFUND-PAYABLE' },
  'sum-at-risk-change': { debit: 'MORTALITY-RESERVE', credit: 'INSURANCE-LIABILITY' },
  'processing-charge': { debit: 'POLICY-FUND-LIABILITY', credit: 'FEE-INCOME' },
  'income-allocation': { debit: 'INVESTMENT-GAIN', credit: 'POLICY-ACCRUAL' },
};

export class FundsAccountingError extends Error {}

function parseMinor(amount: string | number, currency: string): bigint {
  const raw = String(amount).replace(/,/g, '').trim().replace(new RegExp(`\\s+${currency}$`, 'i'), '');
  try {
    return parseAmount(raw, currency).minor;
  } catch {
    throw new FundsAccountingError(`amount ${String(amount)} is not valid ${currency} money`);
  }
}

function describeVoucher(input: FundEventInput): string {
  const parts = [EVENT_LABELS[input.eventType], `policy ${input.policyId}`, `product ${input.productId}`];
  if (input.subProduct) parts.push(`sub-product ${input.subProduct}`);
  parts.push(`fund ${input.fundId}`);
  if (input.partnerId) parts.push(`partner ${input.partnerId}`);
  if (input.omniChannel) parts.push(`channel ${input.omniChannel}`);
  if (input.subChannel) parts.push(`sub-channel ${input.subChannel}`);
  if (input.country) parts.push(`country ${input.country}`);
  return parts.join(' · ');
}

export interface FundsAccountingOptions {
  /** When supplied, vouchers also post as real journals in the double-entry ledger. */
  readonly ledger?: Ledger;
  /** Country → legal entity; unresolved countries fall back to the entity returned here. */
  readonly entityForCountry?: (country: string | undefined, fundId: string) => { entityId: string; currency: string };
  readonly defaultEntity?: { entityId: string; currency: string };
}

export class FundsAccountingRegistry {
  private configs = new Map<string, CountryAccountingConfig>();
  private rules = new Map<string, FundAccountingRule>();
  private mappings = new Map<string, DynamicFundMapping>();
  private vouchers: Voucher[] = [];
  private seq = 1000;
  private readonly trail: Array<{ at: string; by: string; action: string; detail: string }> = [];

  constructor(private readonly options: FundsAccountingOptions = {}) {}

  private record(action: string, detail: string, at: string, by: string) {
    this.trail.push({ at, by, action, detail });
    if (this.trail.length > 300) this.trail.splice(0, this.trail.length - 300);
  }

  // ---- Country standards ----

  listConfigs(): CountryAccountingConfig[] {
    return [...this.configs.values()].sort((a, b) => a.country.localeCompare(b.country));
  }

  upsertConfig(input: Partial<CountryAccountingConfig> & { country: string; standard: AccountingStandard; currency: string; at?: string; by?: string }): CountryAccountingConfig {
    const country = input.country.trim().toUpperCase();
    if (!/^[A-Z]{2}$/.test(country)) throw new FundsAccountingError('country must be ISO-2');
    const currency = (input.currency ?? 'AED').trim().toUpperCase();
    if (!/^[A-Z]{3}$/.test(currency)) throw new FundsAccountingError('currency must be ISO-3');
    const standards: AccountingStandard[] = ['IFRS17', 'IFRS4', 'SOCPA', 'CBUAE-GAAP', 'BNM-MFRS17', 'LOCAL-GAAP'];
    if (!standards.includes(input.standard)) throw new FundsAccountingError(`standard must be one of ${standards.join(', ')}`);
    try { parseAmount('0', currency); } catch { throw new FundsAccountingError(`unsupported currency ${currency}`); }
    const fiscalYearEnd = input.fiscalYearEnd?.trim();
    if (fiscalYearEnd && !/^(0[1-9]|1[0-2])-(0[1-9]|[12][0-9]|3[01])$/.test(fiscalYearEnd)) {
      throw new FundsAccountingError('fiscal year end must be MM-DD');
    }
    const existing = this.configs.get(country);
    const cfg: CountryAccountingConfig = {
      id: existing?.id ?? `FAC-${country}`,
      country,
      countryName: (input.countryName ?? existing?.countryName ?? country).trim(),
      standard: input.standard,
      currency,
      fiscalYearEnd: (fiscalYearEnd ?? existing?.fiscalYearEnd ?? '12-31').trim(),
      description: (input.description ?? existing?.description ?? `${country} — ${input.standard}`).trim(),
      enabled: input.enabled ?? existing?.enabled ?? true,
      updatedAt: input.at ?? new Date().toISOString(),
      updatedBy: input.by ?? 'master-settings',
    };
    this.configs.set(country, cfg);
    this.record(existing ? 'country-config-updated' : 'country-config-created', `${country} · ${cfg.standard} · ${currency}`, cfg.updatedAt, cfg.updatedBy);
    return cfg;
  }

  removeConfig(country: string, at = '', by = 'master-settings'): void {
    const key = country.trim().toUpperCase();
    if (!this.configs.has(key)) throw new FundsAccountingError(`no accounting config for ${key}`);
    this.configs.delete(key);
    this.record('country-config-removed', key, at, by);
  }

  // ---- Fund accounting rules ----

  listRules(country?: string): FundAccountingRule[] {
    const all = [...this.rules.values()];
    if (!country) return all.sort((a, b) => a.country.localeCompare(b.country));
    return all.filter(r => r.country === country.toUpperCase()).sort((a, b) => a.fundId.localeCompare(b.fundId));
  }

  upsertRule(input: Partial<FundAccountingRule> & { country: string; fundId: string; at?: string; by?: string }): FundAccountingRule {
    const country = input.country.trim().toUpperCase();
    const fundId = input.fundId.trim().toUpperCase();
    if (!country || !fundId) throw new FundsAccountingError('country and fundId are required');
    if (!this.configs.has(country)) throw new FundsAccountingError(`file the country accounting standard for ${country} before its fund rules`);
    const productLine = (input.productLine ?? 'GENERAL').trim();
    const subProduct = input.subProduct?.trim().toUpperCase() || '';
    const key = `${country}|${productLine}|${subProduct}|${fundId}`;
    const cur = this.rules.get(key);
    const rule: FundAccountingRule = {
      id: cur?.id ?? `FAR-${String(this.rules.size + 1).padStart(4, '0')}`,
      country,
      productLine: (input.productLine ?? cur?.productLine ?? 'GENERAL').trim(),
      subProduct: input.subProduct !== undefined ? input.subProduct.trim().toUpperCase() : cur?.subProduct,
      fundId,
      fundName: (input.fundName ?? cur?.fundName ?? fundId).trim(),
      glPrefix: (input.glPrefix ?? cur?.glPrefix ?? `${country}-FUND`).trim(),
      valuationMethod: (input.valuationMethod ?? cur?.valuationMethod ?? 'NAV') as FundAccountingRule['valuationMethod'],
      revenueRecognition: (input.revenueRecognition ?? cur?.revenueRecognition ?? 'VARIABLE_FEE') as FundAccountingRule['revenueRecognition'],
      enabled: input.enabled ?? cur?.enabled ?? true,
      note: (input.note ?? cur?.note ?? '').trim(),
      updatedAt: input.at ?? new Date().toISOString(),
    };
    this.rules.set(key, rule);
    this.record(cur ? 'fund-rule-updated' : 'fund-rule-created', `${country} · ${fundId} · ${rule.valuationMethod}`, rule.updatedAt, input.by ?? 'master-settings');
    return rule;
  }

  removeRule(id: string, at = '', by = 'master-settings'): void {
    const key = [...this.rules.entries()].find(([, v]) => v.id === id)?.[0];
    if (!key) throw new FundsAccountingError(`no rule ${id}`);
    this.rules.delete(key);
    this.record('fund-rule-removed', id, at, by);
  }

  // ---- Dynamic mappings ----

  listMappings(filter: Partial<DynamicFundMapping> = {}): DynamicFundMapping[] {
    let rows = [...this.mappings.values()];
    if (filter.country) rows = rows.filter(r => r.country === filter.country!.toUpperCase());
    if (filter.fundId) rows = rows.filter(r => r.fundId === filter.fundId!.toUpperCase());
    if (filter.productId) rows = rows.filter(r => r.productId === filter.productId!.toUpperCase());
    if (filter.partnerId) rows = rows.filter(r => r.partnerId === filter.partnerId!.toUpperCase());
    if (filter.omniChannel) rows = rows.filter(r => r.omniChannel === filter.omniChannel!.toUpperCase());
    return rows.sort((a, b) => a.priority - b.priority || a.fundId.localeCompare(b.fundId));
  }

  private specificity(m: DynamicFundMapping): number {
    let s = 0;
    if (m.country) s += 128;
    if (m.eventType) s += 64;
    if (m.policyId) s += 32;
    if (m.subChannel) s += 16;
    if (m.omniChannel) s += 8;
    if (m.partnerId) s += 4;
    if (m.subProduct) s += 2;
    if (m.productId) s += 1;
    return s;
  }

  resolveMapping(input: FundEventInput): DynamicFundMapping | undefined {
    const candidates = [...this.mappings.values()].filter(m => m.enabled && m.fundId.toUpperCase() === input.fundId.trim().toUpperCase());
    const matches = candidates.filter(m => {
      if (m.country && m.country !== (input.country ?? '').toUpperCase()) return false;
      if (m.eventType && m.eventType !== input.eventType) return false;
      if (m.productId && m.productId !== input.productId.toUpperCase()) return false;
      if (m.subProduct && m.subProduct !== (input.subProduct ?? '').toUpperCase()) return false;
      if (m.partnerId && m.partnerId !== (input.partnerId ?? '').toUpperCase()) return false;
      if (m.omniChannel && m.omniChannel !== (input.omniChannel ?? '').toUpperCase()) return false;
      if (m.subChannel && m.subChannel !== (input.subChannel ?? '').toUpperCase()) return false;
      if (m.policyId && m.policyId !== input.policyId.toUpperCase()) return false;
      return true;
    });
    if (matches.length === 0) return undefined;
    return matches.sort((a, b) => this.specificity(b) - this.specificity(a) || a.priority - b.priority)[0];
  }

  upsertMapping(input: Partial<DynamicFundMapping> & { fundId: string; debitAccount: string; creditAccount: string; at?: string; by?: string }): DynamicFundMapping {
    const fundId = input.fundId.trim().toUpperCase();
    if (!fundId) throw new FundsAccountingError('fundId is required');
    const debitAccount = input.debitAccount.trim();
    const creditAccount = input.creditAccount.trim();
    if (!debitAccount || !creditAccount) throw new FundsAccountingError('debit and credit GL accounts are required');
    if (debitAccount === creditAccount) throw new FundsAccountingError('debit and credit must differ');
    const id = input.id?.trim() || `MAP-${String(this.mappings.size + 1).padStart(4, '0')}`;
    const cur = this.mappings.get(id);
    const country = input.country === undefined ? cur?.country ?? null : input.country ? input.country.trim().toUpperCase() : null;
    if (country && !/^[A-Z]{2}$/.test(country)) throw new FundsAccountingError('mapping country must be ISO-2');
    if (country && !this.configs.has(country)) throw new FundsAccountingError(`file the country accounting standard for ${country} before country-specific mappings`);
    const eventType = input.eventType === undefined ? cur?.eventType ?? null : input.eventType;
    if (eventType !== null && !Object.prototype.hasOwnProperty.call(DEFAULT_TEMPLATES, eventType)) {
      throw new FundsAccountingError(`unknown fund event ${String(eventType)}`);
    }
    const mapping: DynamicFundMapping = {
      id,
      fundId,
      fundName: (input.fundName ?? cur?.fundName ?? fundId).trim(),
      country,
      eventType,
      productId: input.productId !== undefined ? (input.productId ? input.productId.trim().toUpperCase() : null) : cur?.productId ?? null,
      subProduct: input.subProduct !== undefined ? (input.subProduct ? input.subProduct.trim().toUpperCase() : null) : cur?.subProduct ?? null,
      partnerId: input.partnerId !== undefined ? (input.partnerId ? input.partnerId.trim().toUpperCase() : null) : cur?.partnerId ?? null,
      omniChannel: input.omniChannel !== undefined ? (input.omniChannel ? input.omniChannel.trim().toUpperCase() : null) : cur?.omniChannel ?? null,
      subChannel: input.subChannel !== undefined ? (input.subChannel ? input.subChannel.trim().toUpperCase() : null) : cur?.subChannel ?? null,
      policyId: input.policyId !== undefined ? (input.policyId ? input.policyId.trim().toUpperCase() : null) : cur?.policyId ?? null,
      debitAccount,
      creditAccount,
      costCentre: input.costCentre ?? cur?.costCentre,
      priority: input.priority ?? cur?.priority ?? 100,
      descriptionTemplate: (input.descriptionTemplate ?? cur?.descriptionTemplate ?? `{{event}} — {{policyId}} · {{productId}} → {{fundId}}`).trim(),
      enabled: input.enabled ?? cur?.enabled ?? true,
      updatedAt: input.at ?? new Date().toISOString(),
      updatedBy: input.by ?? 'master-settings',
    };
    this.mappings.set(id, mapping);
    this.record(cur ? 'mapping-updated' : 'mapping-created', `${id} · ${fundId} · ${debitAccount} → ${creditAccount}`, mapping.updatedAt, mapping.updatedBy);
    return mapping;
  }

  removeMapping(id: string, at = '', by = 'master-settings'): void {
    if (!this.mappings.has(id)) throw new FundsAccountingError(`no mapping ${id}`);
    this.mappings.delete(id);
    this.record('mapping-removed', id, at, by);
  }

  // ---- Event → Voucher ----

  private ledgerAccountId(account: string, entityId: string, currency: string, fundId: string): string {
    const ledger = this.options.ledger;
    if (!ledger) return account;
    if (ledger.hasAccount(account)) {
      const existing = ledger.account(account);
      if (existing.entityId !== entityId) throw new FundsAccountingError(`GL account ${account} belongs to ${existing.entityId}, not ${entityId}`);
      if (existing.currency !== currency) throw new FundsAccountingError(`GL account ${account} is ${existing.currency}, not ${currency}`);
      return account;
    }
    const safe = account.trim().toUpperCase().replace(/[^A-Z0-9]+/g, '-').replace(/^-|-$/g, '') || 'UNNAMED';
    const id = `${entityId}:FA:${safe}:${fundId.toUpperCase()}`;
    if (!ledger.hasAccount(id)) {
      const name = account.toUpperCase();
      const type = /(^|[-:])(CASH|ASSET|INVESTMENT|RECEIVABLE)([-:]|$)/.test(name) ? 'asset'
        : /(^|[-:])(EXPENSE|LOSS|CHARGE)([-:]|$)/.test(name) ? 'expense'
        : /(^|[-:])(INCOME|GAIN|REVENUE|FEE)([-:]|$)/.test(name) ? 'income'
        : /(^|[-:])(EQUITY|CAPITAL)([-:]|$)/.test(name) ? 'equity'
        : 'liability';
      ledger.defineAccount({ id, name: account, type, entityId, currency, fundId });
    }
    return id;
  }

  private postLedgerJournal(voucher: Voucher): { journalId: string; entityId: string; debitAccount: string; creditAccount: string } | undefined {
    const ledger = this.options.ledger;
    if (!ledger) return undefined;
    const entity = this.options.entityForCountry?.(voucher.country, voucher.fundId) ?? this.options.defaultEntity;
    if (!entity) throw new FundsAccountingError('no ledger entity is configured for funds-accounting vouchers');
    const debitId = this.ledgerAccountId(voucher.lines[0]!.account, entity.entityId, voucher.currency, voucher.fundId);
    const creditId = this.ledgerAccountId(voucher.lines[1]!.account, entity.entityId, voucher.currency, voucher.fundId);
    const amount = money(voucher.amountMinor, voucher.currency);
    let baseAmount = amount;
    if (amount.currency !== ledger.baseCurrency) {
      try {
        baseAmount = convert(amount, ledger.fxRate(amount.currency, ledger.baseCurrency, voucher.at.slice(0, 10)));
      } catch (error) {
        throw new FundsAccountingError(error instanceof Error ? error.message : String(error));
      }
    }
    const journalId = `FA-${voucher.id}`;
    ledger.post({
      id: journalId,
      entityId: entity.entityId,
      at: voucher.at,
      source: 'funds-accounting',
      sourceRef: voucher.eventId,
      description: voucher.description,
      fundId: voucher.fundId,
      postings: [
        posting(debitId, 'debit', amount, baseAmount, `${voucher.eventType} · ${voucher.policyId}`),
        posting(creditId, 'credit', amount, baseAmount, `${voucher.eventType} · ${voucher.policyId}`),
      ],
    });
    return { journalId, entityId: entity.entityId, debitAccount: debitId, creditAccount: creditId };
  }

  postEvent(input: FundEventInput): Voucher {
    const currency = (input.currency ?? this.configs.get(input.country?.trim().toUpperCase() ?? '')?.currency ?? 'AED').trim().toUpperCase();
    if (!Object.prototype.hasOwnProperty.call(DEFAULT_TEMPLATES, input.eventType)) throw new FundsAccountingError(`unknown fund event ${String(input.eventType)}`);
    const minor = parseMinor(input.amount, currency);
    if (minor <= 0n) throw new FundsAccountingError('event amount must be positive');
    const at = input.at ?? new Date().toISOString();
    if (Number.isNaN(Date.parse(at))) throw new FundsAccountingError(`invalid event timestamp ${at}`);
    const by = input.by ?? 'policy-engine';
    const normalized: FundEventInput = {
      ...input,
      policyId: input.policyId.trim().toUpperCase(),
      productId: input.productId.trim().toUpperCase(),
      fundId: input.fundId.trim().toUpperCase(),
      ...(input.subProduct ? { subProduct: input.subProduct.trim().toUpperCase() } : {}),
      ...(input.partnerId ? { partnerId: input.partnerId.trim().toUpperCase() } : {}),
      ...(input.omniChannel ? { omniChannel: input.omniChannel.trim().toUpperCase() } : {}),
      ...(input.subChannel ? { subChannel: input.subChannel.trim().toUpperCase() } : {}),
      ...(input.country ? { country: input.country.trim().toUpperCase() } : {}),
      currency, at, by,
    };
    if (!normalized.policyId || !normalized.productId || !normalized.fundId) throw new FundsAccountingError('policy, product and fund are required');
    const mapping = this.resolveMapping(normalized);
    const baseDebit = mapping?.debitAccount ?? DEFAULT_TEMPLATES[normalized.eventType].debit;
    const baseCredit = mapping?.creditAccount ?? DEFAULT_TEMPLATES[normalized.eventType].credit;
    const countryPrefix = normalized.country ? `${normalized.country}:` : '';
    const debitAccount = mapping ? mapping.debitAccount : `${countryPrefix}${baseDebit}:${normalized.fundId}`;
    const creditAccount = mapping ? mapping.creditAccount : `${countryPrefix}${baseCredit}:${normalized.fundId}`;
    const eventLabel = EVENT_LABELS[normalized.eventType];
    const context = describeVoucher(normalized);
    let detail = mapping?.descriptionTemplate ?? '';
    if (detail) {
      detail = detail
        .replace(/\{\{event\}\}/g, eventLabel)
        .replace(/\{\{eventType\}\}/g, normalized.eventType)
        .replace(/\{\{policyId\}\}/g, normalized.policyId)
        .replace(/\{\{productId\}\}/g, normalized.productId)
        .replace(/\{\{subProduct\}\}/g, normalized.subProduct ?? '—')
        .replace(/\{\{fundId\}\}/g, normalized.fundId)
        .replace(/\{\{partnerId\}\}/g, normalized.partnerId ?? '—')
        .replace(/\{\{omniChannel\}\}/g, normalized.omniChannel ?? '—')
        .replace(/\{\{subChannel\}\}/g, normalized.subChannel ?? '—')
        .replace(/\{\{country\}\}/g, normalized.country ?? '—')
        .replace(/\{\{period\}\}/g, normalized.period ?? '—')
        .replace(/\{\{amount\}\}/g, formatAmount(money(minor, currency)));
    }
    let description = normalized.descriptionOverride?.trim() || eventLabel;
    if (detail) description += ` · ${detail}`;
    // Always append the complete policy context, even if a custom template omits a dimension.
    description += ` · ${context.replace(`${eventLabel} · `, '')}`;

    const seq = ++this.seq;
    const voucher: Voucher = {
      id: `VCH-${String(seq).padStart(7, '0')}`,
      eventId: `EVT-${String(seq).padStart(7, '0')}`,
      eventType: normalized.eventType,
      at, by,
      policyId: normalized.policyId,
      productId: normalized.productId,
      ...(normalized.subProduct ? { subProduct: normalized.subProduct } : {}),
      ...(normalized.partnerId ? { partnerId: normalized.partnerId } : {}),
      ...(normalized.omniChannel ? { omniChannel: normalized.omniChannel } : {}),
      ...(normalized.subChannel ? { subChannel: normalized.subChannel } : {}),
      fundId: normalized.fundId,
      amountMinor: minor,
      currency,
      description,
      lines: [
        { account: debitAccount, side: 'debit', amountMinor: minor, currency, fundId: normalized.fundId },
        { account: creditAccount, side: 'credit', amountMinor: minor, currency, fundId: normalized.fundId },
      ],
      balanced: true,
      ...(mapping ? { mappingId: mapping.id } : {}),
      ...(normalized.country ? { country: normalized.country } : {}),
    };
    const ledgerJournal = this.postLedgerJournal(voucher);
    const filed: Voucher = ledgerJournal
      ? { ...voucher, ledgerJournalId: ledgerJournal.journalId, ledgerEntityId: ledgerJournal.entityId, lines: [
          { ...voucher.lines[0]!, account: ledgerJournal.debitAccount },
          { ...voucher.lines[1]!, account: ledgerJournal.creditAccount },
        ] }
      : voucher;
    this.vouchers.push(filed);
    this.record('voucher-posted', `${filed.id} · ${normalized.eventType} · ${filed.description.slice(0, 80)}`, at, by);
    return filed;
  }

  listVouchers(filter: Partial<Voucher> = {}): Voucher[] {
    let rows = [...this.vouchers];
    if (filter.policyId) rows = rows.filter(v => v.policyId === filter.policyId!.toUpperCase());
    if (filter.productId) rows = rows.filter(v => v.productId === filter.productId!.toUpperCase());
    if (filter.fundId) rows = rows.filter(v => v.fundId === filter.fundId!.toUpperCase());
    if (filter.partnerId) rows = rows.filter(v => v.partnerId === filter.partnerId!.toUpperCase());
    if (filter.eventType) rows = rows.filter(v => v.eventType === filter.eventType);
    return rows.slice(-200).reverse();
  }

  audit(limit = 10) { return this.trail.slice(-limit).reverse(); }

  // ---- Snapshots ----

  bootstrapDefaults(): void {
    if (this.configs.size > 0) return;
    const now = new Date().toISOString();
    this.upsertConfig({ country: 'AE', standard: 'IFRS17', currency: 'AED', countryName: 'United Arab Emirates', fiscalYearEnd: '12-31', description: 'CBUAE — IFRS 17 with local regulatory overlay', at: now, by: 'seed' });
    this.upsertConfig({ country: 'SA', standard: 'SOCPA', currency: 'SAR', countryName: 'Saudi Arabia', fiscalYearEnd: '12-31', description: 'SOCPA / IFRS 17 — Saudi insurance accounting', at: now, by: 'seed' });
    this.upsertConfig({ country: 'MY', standard: 'BNM-MFRS17', currency: 'MYR', countryName: 'Malaysia', fiscalYearEnd: '12-31', description: 'BNM MFRS 17 — Malaysian Takaful & conventional', at: now, by: 'seed' });
    this.upsertConfig({ country: 'AU', standard: 'LOCAL-GAAP', currency: 'AUD', countryName: 'Australia', fiscalYearEnd: '06-30', description: 'AASB 17 — Australian superannuation overlay', at: now, by: 'seed' });
    this.upsertConfig({ country: 'GB', standard: 'IFRS17', currency: 'GBP', countryName: 'United Kingdom', fiscalYearEnd: '12-31', description: 'IFRS 17 — UK prudential reporting', at: now, by: 'seed' });

    // Default fund rules per country
    for (const c of ['AE', 'SA', 'MY', 'AU', 'GB']) {
      for (const f of ['FGLOBAL', 'FBAL', 'TKF-EQ', 'SUPER-BAL', 'SUPER-GROWTH']) {
        try {
          this.upsertRule({ country: c, fundId: f, productLine: 'investment-linked', fundName: f, glPrefix: `${c}-FUND`, valuationMethod: 'NAV', revenueRecognition: c === 'AU' ? 'VARIABLE_FEE' : 'GENERAL_MEASUREMENT', note: `Auto-seeded ${c} rule for ${f}`, at: now, by: 'seed' });
        } catch { /* ignore */ }
      }
    }

    // Example dynamic mappings capturing the voucher description examples
    this.upsertMapping({ id: 'MAP-0001', country: 'AE', fundId: 'FGLOBAL', eventType: 'deposit-amount', debitAccount: 'PREMIUM-SUSPENSE:FGLOBAL', creditAccount: 'POLICY-ACCRUAL:FGLOBAL', priority: 10, descriptionTemplate: 'Deposit received → accruals → {{policyId}} · {{productId}} premium allocation to {{fundId}} via {{partnerId}}', at: now, by: 'seed' });
    this.upsertMapping({ id: 'MAP-0002', country: 'AE', fundId: 'FBAL', eventType: 'investment-allocated', debitAccount: 'INVESTMENT-CLEARING:FBAL', creditAccount: 'FUND-UNITS-ISSUED:FBAL', priority: 10, descriptionTemplate: 'Premium adjustment → investment allocation → {{fundId}} units issued for {{policyId}} ({{partnerId}} / {{omniChannel}})', at: now, by: 'seed' });
    this.upsertMapping({ id: 'MAP-0003', country: 'AU', fundId: 'SUPER-BAL', eventType: 'premium-received', debitAccount: 'SUPER-CASH:SUPER-BAL', creditAccount: 'SUPER-MEMBER-BALANCE:SUPER-BAL', priority: 20, descriptionTemplate: 'Super contribution — {{event}} on {{policyId}} · member balance credited', at: now, by: 'seed' });
    this.upsertMapping({ id: 'MAP-0004', country: 'AE', fundId: 'FGLOBAL', eventType: 'investment-gain', debitAccount: 'FUND-ASSETS:FGLOBAL', creditAccount: 'INVESTMENT-GAIN:FGLOBAL', priority: 10, descriptionTemplate: 'Investment gain → {{policyId}} · {{productId}} in {{fundId}} ({{omniChannel}} / {{subChannel}})', at: now, by: 'seed' });
    this.upsertMapping({ id: 'MAP-0005', country: 'AU', fundId: 'SUPER-BAL', eventType: 'processing-charge', debitAccount: 'SUPER-MEMBER-BALANCE:SUPER-BAL', creditAccount: 'SUPER-FEE-INCOME:SUPER-BAL', priority: 10, descriptionTemplate: 'Monthly super processing charge → member {{policyId}} · {{productId}} · {{amount}}', at: now, by: 'seed' });
    this.upsertMapping({ id: 'MAP-0006', country: 'AU', fundId: 'SUPER-BAL', eventType: 'investment-gain', debitAccount: 'SUPER-FUND-ASSET:SUPER-BAL', creditAccount: 'SUPER-MEMBER-BALANCE:SUPER-BAL', priority: 10, descriptionTemplate: 'Investment income credited by premium post-adjustment → {{policyId}} · {{period}} · {{amount}}', at: now, by: 'seed' });
    this.upsertMapping({ id: 'MAP-0007', country: 'AU', fundId: 'SUPER-BAL', eventType: 'investment-loss', debitAccount: 'SUPER-MEMBER-BALANCE:SUPER-BAL', creditAccount: 'SUPER-FUND-ASSET:SUPER-BAL', priority: 10, descriptionTemplate: 'Investment loss allocated by premium post-adjustment → {{policyId}} · {{period}} · {{amount}}', at: now, by: 'seed' });
  }

  snapshot() {
    return {
      configs: this.listConfigs(),
      rules: [...this.rules.values()].sort((a, b) => a.country.localeCompare(b.country) || a.fundId.localeCompare(b.fundId)),
      mappings: [...this.mappings.values()].sort((a, b) => a.priority - b.priority),
      vouchers: this.listVouchers().slice(0, 50),
      totalVouchers: this.vouchers.length,
      totalMappings: this.mappings.size,
      trail: this.audit(8),
      events: Object.entries(EVENT_LABELS).map(([eventType, label]) => ({ eventType, label })),
      supportedStandards: ['IFRS17', 'IFRS4', 'SOCPA', 'CBUAE-GAAP', 'BNM-MFRS17', 'LOCAL-GAAP'] as AccountingStandard[],
    };
  }

  stats() {
    return {
      configs: this.configs.size,
      rules: this.rules.size,
      mappings: this.mappings.size,
      vouchers: this.vouchers.length,
      balanced: this.vouchers.every(v => v.balanced),
    };
  }
}
