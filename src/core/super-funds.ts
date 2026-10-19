/**
 * Super Funds Investment Policy Administration — the 6th pillar beside life, medical,
 * group life, motor, hull, home-contents & travel.
 *
 * A super/investment-linked policy has:
 *  - a member balance that lives in unit-linked funds (SUPER-BAL, SUPER-GROWTH, SUPER-CONSERV)
 *  - monthly processing charges (admin, investment fee, insurance premium inside super)
 *  - investment income allocation via premium post-adjustment: the net investment return is
 *    allocated to the member by crediting the policy accrual account and adjusting premium.
 *
 * This engine holds the product master, the member ledger, the monthly charge run and the
 * income allocation artefact that an auditor can read back to the voucher.
 */

import { formatAmount, parseAmount, scaleOf } from './money.js';

export type SuperFundId = 'SUPER-BAL' | 'SUPER-GROWTH' | 'SUPER-CONSERV';
export type SuperProductVariant = 'accumulation' | 'pension' | 'transition-to-retirement';

export interface SuperProductMaster {
  readonly productId: string;
  readonly name: string;
  readonly variant: SuperProductVariant;
  readonly currency: string;
  readonly line: 'super-funds';
  readonly category: 'super-funds';
  readonly minAge: number;
  readonly maxAge: number;
  readonly defaultFunds: readonly SuperFundId[];
  readonly monthlyAdminFeeMinor: bigint; // in cents of local currency
  readonly investmentFeeBpsAnnual: number;
  readonly insurancePremiumPerMilleMonthly?: number;
  readonly enabled: boolean;
  readonly updatedAt: string;
  readonly updatedBy: string;
}

export interface SuperMemberPolicy {
  readonly policyId: string;
  readonly partyId: string;
  readonly productId: string;
  readonly productName: string;
  readonly commencement: string;
  readonly memberName: string;
  readonly fundId: SuperFundId;
  readonly employerId?: string;
  readonly balanceMinor: bigint;
  readonly units: string; // decimal
  readonly navPerUnit: string;
  readonly totalContributionsMinor: bigint;
  readonly totalChargesMinor: bigint;
  readonly totalIncomeAllocatedMinor: bigint;
  readonly status: 'active' | 'deferred' | 'pension' | 'exited';
  readonly lastChargeAt?: string;
  readonly lastAllocationAt?: string;
  readonly currency: string;
}

export interface SuperPolicyCharge {
  readonly policyId: string;
  readonly productId: string;
  readonly fundId: SuperFundId;
  readonly processingMinor: bigint;
  readonly investmentMinor: bigint;
  readonly totalMinor: bigint;
  readonly currency: string;
}

export interface SuperChargeRun {
  readonly id: string;
  readonly at: string;
  readonly by: string;
  readonly policyIds: readonly string[];
  readonly policyCharges: readonly SuperPolicyCharge[];
  readonly processingChargeMinor: bigint;
  readonly investmentFeeMinor: bigint;
  readonly totalChargedMinor: bigint;
  readonly currency: string;
  readonly note: string;
}

export interface SuperIncomeAllocation {
  readonly id: string;
  readonly at: string;
  readonly by: string;
  readonly fundId: SuperFundId;
  readonly period: string; // YYYY-MM
  readonly gainMinor: bigint; // positive = gain, negative modelled as separate loss row
  readonly allocatedMinor: bigint;
  readonly currency: string;
  readonly method: 'premium-post-adjustment';
  readonly policyCount: number;
  readonly policyAllocations: ReadonlyArray<{ policyId: string; productId: string; amountMinor: bigint }>;
  readonly note: string;
}

export class SuperFundsError extends Error {}

function parseMinor(value: string | number, currency = 'AUD'): bigint {
  try {
    return parseAmount(String(value).replace(/,/g, '').trim(), currency).minor;
  } catch {
    throw new SuperFundsError(`amount ${String(value)} is not valid ${currency} money`);
  }
}

function unitsFor(balanceMinor: bigint, currency: string, navPerUnit = 11.42): string {
  const divisor = 10 ** scaleOf(currency);
  const balance = Number(balanceMinor) / divisor;
  return (balance / navPerUnit).toFixed(6);
}

function decimalAmount(minor: bigint, currency: string): string {
  const formatted = formatAmount({ minor, currency });
  return formatted.slice(0, -(currency.length + 1));
}

export class SuperFundsRegistry {
  private products = new Map<string, SuperProductMaster>();
  private policies = new Map<string, SuperMemberPolicy>();
  private charges: SuperChargeRun[] = [];
  private allocations: SuperIncomeAllocation[] = [];
  private seq = 0;
  private readonly trail: Array<{ at: string; by: string; action: string; detail: string }> = [];

  private record(action: string, detail: string, at: string, by: string) {
    this.trail.push({ at, by, action, detail });
    if (this.trail.length > 300) this.trail.splice(0, this.trail.length - 300);
  }

  // ---- Products ----

  listProducts(): SuperProductMaster[] {
    return [...this.products.values()].sort((a, b) => a.productId.localeCompare(b.productId));
  }

  upsertProduct(input: Partial<SuperProductMaster> & { productId: string; name: string; at?: string; by?: string }): SuperProductMaster {
    const id = input.productId.trim().toUpperCase();
    const name = input.name.trim();
    if (!id) throw new SuperFundsError('productId is required');
    if (!name) throw new SuperFundsError(`${id} needs a product name`);
    const cur = this.products.get(id);
    const variant = (input.variant ?? cur?.variant ?? 'accumulation') as SuperProductVariant;
    if (!['accumulation', 'pension', 'transition-to-retirement'].includes(variant)) throw new SuperFundsError(`unknown super product variant ${variant}`);
    const minAge = input.minAge ?? cur?.minAge ?? 18;
    const maxAge = input.maxAge ?? cur?.maxAge ?? 75;
    if (!Number.isInteger(minAge) || !Number.isInteger(maxAge) || minAge < 0 || maxAge > 120 || minAge > maxAge) throw new SuperFundsError('super product age range must be whole years from 0 to 120, with minimum <= maximum');
    const currency = (input.currency ?? cur?.currency ?? 'AUD').trim().toUpperCase();
    try { parseAmount('0', currency); } catch { throw new SuperFundsError(`unsupported currency ${currency}`); }
    const defaultFunds = [...new Set((input.defaultFunds ?? cur?.defaultFunds ?? ['SUPER-BAL']).map(f => String(f).toUpperCase()))] as SuperFundId[];
    if (defaultFunds.length === 0 || defaultFunds.some(f => !['SUPER-BAL', 'SUPER-GROWTH', 'SUPER-CONSERV'].includes(f))) throw new SuperFundsError('select one or more valid super investment funds');
    const monthlyAdminFeeMinor = input.monthlyAdminFeeMinor ?? cur?.monthlyAdminFeeMinor ?? 600n;
    const investmentFeeBpsAnnual = input.investmentFeeBpsAnnual ?? cur?.investmentFeeBpsAnnual ?? 85;
    if (monthlyAdminFeeMinor < 0n) throw new SuperFundsError('monthly admin fee cannot be negative');
    if (!Number.isInteger(investmentFeeBpsAnnual) || investmentFeeBpsAnnual < 0 || investmentFeeBpsAnnual > 10000) throw new SuperFundsError('annual investment fee must be a whole number between 0 and 10000 bps');
    const prod: SuperProductMaster = {
      productId: id, name, variant, currency,
      line: 'super-funds', category: 'super-funds', minAge, maxAge, defaultFunds,
      monthlyAdminFeeMinor, investmentFeeBpsAnnual,
      insurancePremiumPerMilleMonthly: input.insurancePremiumPerMilleMonthly ?? cur?.insurancePremiumPerMilleMonthly,
      enabled: input.enabled ?? cur?.enabled ?? true,
      updatedAt: input.at ?? new Date().toISOString(),
      updatedBy: input.by ?? 'master-settings',
    };
    this.products.set(id, prod);
    this.record(cur ? 'super-product-updated' : 'super-product-created', `${id} · ${prod.name} · ${prod.variant} · ${currency}`, prod.updatedAt, prod.updatedBy);
    return prod;
  }

  removeProduct(productId: string, at = '', by = 'master-settings'): void {
    const key = productId.trim().toUpperCase();
    if (!this.products.has(key)) throw new SuperFundsError(`no super product ${key}`);
    // Don't delete if policies exist
    const holders = [...this.policies.values()].filter(p => p.productId === key);
    if (holders.length > 0) throw new SuperFundsError(`${key} still has ${holders.length} member policies`);
    this.products.delete(key);
    this.record('super-product-removed', key, at, by);
  }

  // ---- Member policies ----

  listPolicies(): SuperMemberPolicy[] {
    return [...this.policies.values()].sort((a, b) => a.policyId.localeCompare(b.policyId));
  }

  createMemberPolicy(input: {
    policyId?: string; partyId: string; productId: string; memberName?: string;
    fundId?: SuperFundId; employerId?: string; initialContribution?: string | number;
    currency?: string; at?: string; by?: string;
  }): SuperMemberPolicy {
    const product = this.products.get(input.productId.trim().toUpperCase());
    if (!product || !product.enabled) throw new SuperFundsError(`unknown or disabled super product ${input.productId}`);
    if (!input.partyId.trim()) throw new SuperFundsError('member party id is required');
    let policyId = input.policyId?.trim().toUpperCase() ?? '';
    if (!policyId) {
      do { policyId = `SUPER-${String(++this.seq).padStart(6, '0')}`; } while (this.policies.has(policyId));
    }
    if (this.policies.has(policyId)) throw new SuperFundsError(`member policy ${policyId} already exists`);
    const currency = (input.currency ?? product.currency).trim().toUpperCase();
    try { parseAmount('0', currency); } catch { throw new SuperFundsError(`unsupported currency ${currency}`); }
    if (currency !== product.currency) throw new SuperFundsError(`${product.productId} is priced in ${product.currency}; member currency ${currency} does not match`);
    const fundId = (input.fundId ?? product.defaultFunds[0] ?? 'SUPER-BAL') as SuperFundId;
    if (!product.defaultFunds.includes(fundId)) throw new SuperFundsError(`${fundId} is not in ${product.productId}'s approved default fund list`);
    const initial = input.initialContribution !== undefined ? parseMinor(input.initialContribution, currency) : 0n;
    if (initial < 0n) throw new SuperFundsError('initial contribution cannot be negative');
    const navPerUnit = '11.4200';
    const pol: SuperMemberPolicy = {
      policyId,
      partyId: input.partyId.trim().toUpperCase(),
      productId: product.productId,
      productName: product.name,
      commencement: (input.at ?? new Date().toISOString()).slice(0, 10),
      memberName: (input.memberName ?? input.partyId).trim(),
      fundId,
      employerId: input.employerId?.trim(),
      balanceMinor: initial,
      units: unitsFor(initial, currency),
      navPerUnit,
      totalContributionsMinor: initial,
      totalChargesMinor: 0n,
      totalIncomeAllocatedMinor: 0n,
      status: 'active',
      currency,
    };
    this.policies.set(policyId, pol);
    this.record('member-policy-created', `${policyId} · ${product.productId} · ${fundId} · ${decimalAmount(initial, currency)} ${currency}`, pol.commencement, input.by ?? 'member-admin');
    return pol;
  }

  contribute(policyId: string, amount: string | number, at = new Date().toISOString(), by = 'member-admin'): SuperMemberPolicy {
    const pol = this.policies.get(policyId.toUpperCase());
    if (!pol) throw new SuperFundsError(`no member policy ${policyId}`);
    const minor = parseMinor(amount, pol.currency);
    if (minor <= 0n) throw new SuperFundsError('contribution must be positive');
    const nextBalance = pol.balanceMinor + minor;
    const next: SuperMemberPolicy = {
      ...pol,
      balanceMinor: nextBalance,
      totalContributionsMinor: pol.totalContributionsMinor + minor,
      units: unitsFor(nextBalance, pol.currency, Number(pol.navPerUnit)),
    };
    this.policies.set(pol.policyId, next);
    this.record('member-contribution', `${policyId} +${decimalAmount(minor, pol.currency)} → ${decimalAmount(next.balanceMinor, pol.currency)} ${pol.currency}`, at, by);
    return next;
  }

  // ---- Monthly charge run ----

  runMonthlyCharges(input: { policyIds?: string[]; at?: string; by?: string }): SuperChargeRun[] {
    const at = input.at ?? new Date().toISOString();
    if (Number.isNaN(Date.parse(at))) throw new SuperFundsError(`invalid charge-run date ${at}`);
    const by = input.by ?? 'super-charge-run';
    const wanted = input.policyIds?.map(id => id.trim().toUpperCase()).filter(Boolean);
    const targets = wanted?.length
      ? wanted.map(id => this.policies.get(id)).filter((p): p is SuperMemberPolicy => Boolean(p && p.status === 'active'))
      : [...this.policies.values()].filter(p => p.status === 'active');
    if (targets.length === 0) throw new SuperFundsError('no active super member policies to charge');
    const month = at.slice(0, 7);
    const already = targets.filter(p => p.lastChargeAt?.slice(0, 7) === month);
    if (already.length > 0) throw new SuperFundsError(`monthly processing already ran for ${already.map(p => p.policyId).join(', ')} in ${month}`);

    // Fees in different functional currencies must never be added together. The run is split by currency.
    const byCurrency = new Map<string, SuperPolicyCharge[]>();
    for (const pol of targets) {
      const product = this.products.get(pol.productId);
      if (!product) continue;
      const adminWanted = product.monthlyAdminFeeMinor;
      const investmentWanted = (pol.balanceMinor * BigInt(product.investmentFeeBpsAnnual)) / 10_000n / 12n;
      const processing = adminWanted < pol.balanceMinor ? adminWanted : pol.balanceMinor;
      const afterProcessing = pol.balanceMinor - processing;
      const investment = investmentWanted < afterProcessing ? investmentWanted : afterProcessing;
      const total = processing + investment;
      const charge: SuperPolicyCharge = {
        policyId: pol.policyId, productId: pol.productId, fundId: pol.fundId,
        processingMinor: processing, investmentMinor: investment, totalMinor: total, currency: pol.currency,
      };
      const list = byCurrency.get(pol.currency) ?? [];
      list.push(charge);
      byCurrency.set(pol.currency, list);
      const balanceMinor = pol.balanceMinor - total;
      this.policies.set(pol.policyId, {
        ...pol,
        balanceMinor,
        units: unitsFor(balanceMinor, pol.currency, Number(pol.navPerUnit)),
        totalChargesMinor: pol.totalChargesMinor + total,
        lastChargeAt: at,
      });
    }
    const runs: SuperChargeRun[] = [];
    for (const [currency, policyCharges] of byCurrency) {
      const total = policyCharges.reduce((sum, c) => sum + c.totalMinor, 0n);
      const investment = policyCharges.reduce((sum, c) => sum + c.investmentMinor, 0n);
      const run: SuperChargeRun = {
        id: `SCHG-${String(++this.seq).padStart(6, '0')}`,
        at, by,
        policyIds: policyCharges.map(c => c.policyId),
        policyCharges,
        processingChargeMinor: total - investment,
        investmentFeeMinor: investment,
        totalChargedMinor: total,
        currency,
        note: `Monthly processing: ${policyCharges.length} members charged — admin + pro-rated investment fee deducted from member balance`,
      };
      this.charges.push(run);
      this.record('monthly-charges', `${run.id} · ${policyCharges.length} members · ${decimalAmount(total, currency)} ${currency}`, at, by);
      runs.push(run);
    }
    return runs;
  }

  // ---- Investment income allocation via premium post-adjustment ----

  allocateIncome(input: {
    fundId: SuperFundId; period: string; gainAmount: string | number; currency?: string; at?: string; by?: string;
  }): SuperIncomeAllocation {
    const fundId = input.fundId;
    const period = input.period.trim();
    if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(period)) throw new SuperFundsError('period must be YYYY-MM');
    if (this.allocations.some(a => a.fundId === fundId && a.period === period)) throw new SuperFundsError(`investment income for ${fundId} in ${period} was already allocated`);
    const at = input.at ?? `${period}-28T23:59:59.000Z`;
    const by = input.by ?? 'super-investment';
    const eligibleAll = [...this.policies.values()].filter(p => p.fundId === fundId && p.status === 'active' && p.balanceMinor > 0n);
    if (eligibleAll.length === 0) throw new SuperFundsError(`no active members in ${fundId} to allocate to`);
    const currency = (input.currency ?? eligibleAll[0]!.currency).trim().toUpperCase();
    const eligible = eligibleAll.filter(p => p.currency === currency);
    if (eligible.length !== eligibleAll.length) throw new SuperFundsError(`members in ${fundId} span currencies; allocate separately after filing currency-specific fund codes`);
    const gainMinor = parseMinor(input.gainAmount, currency);
    if (gainMinor === 0n) throw new SuperFundsError('allocation amount must be non-zero');
    const totalBalance = eligible.reduce((sum, p) => sum + p.balanceMinor, 0n);
    if (gainMinor < 0n && -gainMinor > totalBalance) throw new SuperFundsError('investment loss cannot exceed aggregate member balances');

    const byPolicy = eligible.map(pol => ({
      policy: pol,
      share: (gainMinor * pol.balanceMinor) / totalBalance,
    }));
    let allocated = byPolicy.reduce((sum, p) => sum + p.share, 0n);
    let remainder = gainMinor - allocated;
    // Exact remainder goes to the largest balance, which minimizes relative rounding impact and
    // guarantees the allocation is exactly the income amount that the fund earned.
    const remainderOrder = [...byPolicy].sort((a, b) => a.policy.balanceMinor === b.policy.balanceMinor ? a.policy.policyId.localeCompare(b.policy.policyId) : a.policy.balanceMinor > b.policy.balanceMinor ? -1 : 1);
    for (const entry of remainderOrder) {
      if (remainder === 0n) break;
      const step = remainder > 0n ? 1n : -1n;
      entry.share += step;
      remainder -= step;
      allocated += step;
    }
    const policyAllocations: Array<{ policyId: string; productId: string; amountMinor: bigint }> = [];
    for (const { policy, share } of byPolicy) {
      if (share === 0n) continue;
      const balanceMinor = policy.balanceMinor + share;
      if (balanceMinor < 0n) throw new SuperFundsError(`loss allocation would make ${policy.policyId} negative`);
      this.policies.set(policy.policyId, {
        ...policy,
        balanceMinor,
        units: unitsFor(balanceMinor, policy.currency, Number(policy.navPerUnit)),
        totalIncomeAllocatedMinor: policy.totalIncomeAllocatedMinor + share,
        lastAllocationAt: at,
      });
      policyAllocations.push({ policyId: policy.policyId, productId: policy.productId, amountMinor: share });
    }
    const allocation: SuperIncomeAllocation = {
      id: `SALL-${String(++this.seq).padStart(6, '0')}`,
      at, by, fundId, period,
      gainMinor,
      allocatedMinor: allocated,
      currency,
      method: 'premium-post-adjustment',
      policyCount: policyAllocations.length,
      policyAllocations,
      note: `Investment ${gainMinor > 0n ? 'gain' : 'loss'} on ${fundId} for ${period} allocated pro-rata to ${policyAllocations.length} members via premium post-adjustment — credited to member accrual and applied as premium adjustment`,
    };
    this.allocations.push(allocation);
    this.record('income-allocated', `${allocation.id} · ${fundId} · ${period} · ${decimalAmount(gainMinor, currency)} ${currency} → ${policyAllocations.length} members`, at, by);
    return allocation;
  }

  bootstrapDefaults(): void {
    if (this.products.size > 0) return;
    const now = new Date().toISOString();
    this.upsertProduct({ productId: 'PROD-SUPER-ACCUM', name: 'Super Accumulation — Balanced Growth', variant: 'accumulation', minAge: 18, maxAge: 75, defaultFunds: ['SUPER-BAL', 'SUPER-GROWTH'], monthlyAdminFeeMinor: 650n, investmentFeeBpsAnnual: 85, insurancePremiumPerMilleMonthly: 0.45, at: now, by: 'seed' });
    this.upsertProduct({ productId: 'PROD-SUPER-PENSION', name: 'Super Pension — Conservative Income', variant: 'pension', minAge: 55, maxAge: 90, defaultFunds: ['SUPER-CONSERV', 'SUPER-BAL'], monthlyAdminFeeMinor: 450n, investmentFeeBpsAnnual: 65, at: now, by: 'seed' });
    this.upsertProduct({ productId: 'PROD-SUPER-TTR', name: 'Transition to Retirement — Flexible Growth', variant: 'transition-to-retirement', minAge: 55, maxAge: 75, defaultFunds: ['SUPER-BAL', 'SUPER-CONSERV'], monthlyAdminFeeMinor: 550n, investmentFeeBpsAnnual: 75, at: now, by: 'seed' });

    // Seed a couple of member policies so screens are not empty
    this.createMemberPolicy({ policyId: 'SUPER-000001', partyId: 'PTY-0001', productId: 'PROD-SUPER-ACCUM', memberName: 'Ahmed Al Mansoori', fundId: 'SUPER-BAL', initialContribution: '25000', currency: 'AUD', at: now, by: 'seed' });
    this.createMemberPolicy({ policyId: 'SUPER-000002', partyId: 'PTY-0002', productId: 'PROD-SUPER-ACCUM', memberName: 'Sarah Mitchell', fundId: 'SUPER-GROWTH', initialContribution: '42000', currency: 'AUD', at: now, by: 'seed' });
  }

  audit(limit = 10) { return this.trail.slice(-limit).reverse(); }

  snapshot() {
    return {
      products: this.listProducts(),
      policies: this.listPolicies().map(p => ({
        ...p,
        balanceLabel: `${(Number(p.balanceMinor)/100).toFixed(2)} ${p.currency}`,
        contributionsLabel: `${(Number(p.totalContributionsMinor)/100).toFixed(2)} ${p.currency}`,
        chargesLabel: `${(Number(p.totalChargesMinor)/100).toFixed(2)} ${p.currency}`,
        incomeLabel: `${(Number(p.totalIncomeAllocatedMinor)/100).toFixed(2)} ${p.currency}`,
      })),
      charges: [...this.charges].slice(-12).reverse().map(c => ({
        ...c,
        processingLabel: `${(Number(c.processingChargeMinor)/100).toFixed(2)} ${c.currency}`,
        investmentLabel: `${(Number(c.investmentFeeMinor)/100).toFixed(2)} ${c.currency}`,
        totalLabel: `${(Number(c.totalChargedMinor)/100).toFixed(2)} ${c.currency}`,
      })),
      allocations: [...this.allocations].slice(-12).reverse().map(a => ({
        ...a,
        gainLabel: `${(Number(a.gainMinor)/100).toFixed(2)} ${a.currency}`,
        allocatedLabel: `${(Number(a.allocatedMinor)/100).toFixed(2)} ${a.currency}`,
      })),
      totals: {
        members: this.policies.size,
        activeMembers: [...this.policies.values()].filter(p => p.status === 'active').length,
        totalBalanceMinor: [...this.policies.values()].reduce((s, p) => s + p.balanceMinor, 0n).toString(),
        chargesRuns: this.charges.length,
        allocations: this.allocations.length,
      },
      trail: this.audit(8),
    };
  }

  stats() {
    return {
      products: this.products.size,
      policies: this.policies.size,
      active: [...this.policies.values()].filter(p => p.status === 'active').length,
      charges: this.charges.length,
      allocations: this.allocations.length,
    };
  }
}
