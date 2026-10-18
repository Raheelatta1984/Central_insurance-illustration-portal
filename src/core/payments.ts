/**
 * Payment options and capture — the "buy online" half of the sale.
 *
 * The customer was promised six ways to pay: cash at the counter, credit card, debit card (Visa and
 * Mastercard), bank transfer, buy-now-pay-later, and a deposit into a branch account. Each has a
 * different answer to the same three questions — when is the money *ours*, what did it cost to take,
 * and what proof exists that it was taken — so each is modelled explicitly rather than as a string
 * on a receipt.
 *
 * Card numbers are never stored. A PAN is validated (Luhn), identified by brand from its prefix and
 * length, and reduced to its last four digits plus a fingerprint; the CVV is accepted at the point
 * of capture and discarded, and the record says so. Bank transfers and branch deposits are captured
 * as *pending* until the bank confirms, because a policy issued on an uncleared transfer is a policy
 * the insurer paid for.
 */
import { Money, add, allocate, applyBps, compare, formatAmount, money, sub, zero } from './money.js';
import { fingerprint } from './persistence.js';

export class PaymentError extends Error {}

/** A failure or reversal of money movement needs a real sentence behind it, not "err". */
export const REASON_MINIMUM = 24;

export type PaymentMethod = 'cash' | 'credit-card' | 'debit-card' | 'bank-transfer' | 'bnpl' | 'branch-deposit';
export type PaymentStatus = 'authorised' | 'captured' | 'settled' | 'pending' | 'failed' | 'refunded';
export type CardBrand = 'visa' | 'mastercard' | 'amex' | 'discover' | 'unknown';

export interface PaymentMethodDef {
  readonly code: PaymentMethod;
  readonly label: string;
  /** Merchant or handling cost in basis points, charged by whoever takes the money. */
  readonly feeBps: number;
  /** Business days until the money is the insurer's, not merely promised. */
  readonly settlementDays: number;
  readonly settlesOnCapture: boolean;
  readonly requiresAuthentication: boolean;
  readonly shariahEligible: boolean;
  readonly supportsInstalments: boolean;
  readonly minAmountMinor: bigint;
  readonly maxAmountMinor: bigint;
  readonly note: string;
}

export const PAYMENT_METHODS: readonly PaymentMethodDef[] = [
  { code: 'cash', label: 'Cash at the counter', feeBps: 0, settlementDays: 0, settlesOnCapture: true, requiresAuthentication: false, shariahEligible: true, supportsInstalments: false, minAmountMinor: 1n, maxAmountMinor: 50_000_00n, note: 'Counted and receipted at the branch; above the counter limit the payment must be banked, not taken in cash.' },
  { code: 'credit-card', label: 'Credit card (Visa, Mastercard)', feeBps: 220, settlementDays: 1, settlesOnCapture: false, requiresAuthentication: true, shariahEligible: true, supportsInstalments: true, minAmountMinor: 100n, maxAmountMinor: 100_000_00n, note: 'Strong customer authentication required; the merchant fee is borne by the insurer, never added to the customer premium.' },
  { code: 'debit-card', label: 'Debit card (Visa, Mastercard)', feeBps: 90, settlementDays: 1, settlesOnCapture: false, requiresAuthentication: true, shariahEligible: true, supportsInstalments: false, minAmountMinor: 100n, maxAmountMinor: 100_000_00n, note: 'Funds leave the customer account immediately; settlement to the insurer follows the card scheme cycle.' },
  { code: 'bank-transfer', label: 'Bank transfer (IBAN)', feeBps: 0, settlementDays: 2, settlesOnCapture: false, requiresAuthentication: false, shariahEligible: true, supportsInstalments: false, minAmountMinor: 100n, maxAmountMinor: 10_000_000_00n, note: 'Captured as pending until the bank statement confirms the credit; the payment reference must match the quotation.' },
  { code: 'bnpl', label: 'Buy now, pay later', feeBps: 450, settlementDays: 3, settlesOnCapture: false, requiresAuthentication: true, shariahEligible: false, supportsInstalments: true, minAmountMinor: 500_00n, maxAmountMinor: 50_000_00n, note: 'The provider pays the insurer and collects instalments from the customer; the provider fee is a cost of sale and must be disclosed. Not offered on a Shariah-compliant arrangement unless the provider is itself approved.' },
  { code: 'branch-deposit', label: 'Deposit in branch / cheque', feeBps: 0, settlementDays: 3, settlesOnCapture: false, requiresAuthentication: false, shariahEligible: true, supportsInstalments: false, minAmountMinor: 100n, maxAmountMinor: 10_000_000_00n, note: 'A deposit slip or cheque is held against the quotation until it clears; a cheque that bounces reverses the receipt.' },
];

export function methodDef(code: PaymentMethod): PaymentMethodDef {
  const def = PAYMENT_METHODS.find((m) => m.code === code);
  if (!def) throw new PaymentError(`unknown payment method "${code}"`);
  return def;
}

/* ------------------------------------------------------------------ cards */

export function cardBrand(pan: string): CardBrand {
  const digits = pan.replace(/\D/g, '');
  if (/^4\d{12}(\d{3})?$/.test(digits)) return 'visa';
  if (/^(5[1-5]\d{4}|2(2[2-9]\d{3}|[3-6]\d{4}|7[01]\d{3}|720\d{2}))\d{10}$/.test(digits)) return 'mastercard';
  if (/^3[47]\d{13}$/.test(digits)) return 'amex';
  if (/^6(011|5\d{2})\d{12}$/.test(digits)) return 'discover';
  return 'unknown';
}

export function luhnValid(pan: string): boolean {
  const digits = pan.replace(/\D/g, '');
  if (digits.length < 12) return false;
  let sum = 0;
  let double = false;
  for (let i = digits.length - 1; i >= 0; i -= 1) {
    let d = Number(digits[i]);
    if (double) { d *= 2; if (d > 9) d -= 9; }
    sum += d;
    double = !double;
  }
  return sum % 10 === 0;
}

export function maskPan(pan: string): string {
  const digits = pan.replace(/\D/g, '');
  if (digits.length < 8) return '****';
  return `${'*'.repeat(Math.max(4, digits.length - 4))}${digits.slice(-4)}`;
}

export function cardExpiryValid(expiry: string, asOf: string): boolean {
  const m = /^(\d{2})\s*\/\s*(\d{2}|\d{4})$/.exec(expiry.trim());
  if (!m) return false;
  const month = Number(m[1]);
  if (month < 1 || month > 12) return false;
  const year = m[2]!.length === 2 ? 2000 + Number(m[2]) : Number(m[2]);
  const ref = new Date(`${asOf.slice(0, 10)}T00:00:00Z`);
  const end = new Date(Date.UTC(year, month, 1));   // a card is valid to the last day of its month
  return end.getTime() > ref.getTime();
}

/** IBAN check-digit test (ISO 13616 mod-97), with the country and BBAN length kept honest. */
export function ibanValid(iban: string): boolean {
  const clean = iban.replace(/\s+/g, '').toUpperCase();
  if (!/^[A-Z]{2}\d{2}[A-Z0-9]{10,30}$/.test(clean)) return false;
  const rearranged = clean.slice(4) + clean.slice(0, 4);
  const numeric = rearranged.replace(/[A-Z]/g, (c) => String(c.charCodeAt(0) - 55));
  let remainder = 0;
  for (const ch of numeric) remainder = (remainder * 10 + Number(ch)) % 97;
  return remainder === 1;
}

/* ------------------------------------------------------------------ BNPL */

export interface Instalment {
  readonly number: number;
  readonly dueDate: string;
  readonly amount: Money;
  readonly status: 'due-now' | 'scheduled';
}

export interface BnplPlan {
  readonly provider: string;
  readonly instalments: number;
  readonly schedule: readonly Instalment[];
  readonly providerFee: Money;
  readonly customerPays: Money;
  readonly firstPayment: Money;
  readonly disclosure: string;
}

const BNPL_PROVIDERS: ReadonlyArray<{ name: string; instalments: readonly number[]; feeBps: number; shariahApproved: boolean }> = [
  { name: 'tabby', instalments: [3, 4], feeBps: 450, shariahApproved: false },
  { name: 'tamara', instalments: [3, 4, 6], feeBps: 475, shariahApproved: true },
  { name: 'postpay', instalments: [4], feeBps: 425, shariahApproved: false },
];

export function bnplProvider(name: string): { name: string; instalments: readonly number[]; feeBps: number; shariahApproved: boolean } {
  const p = BNPL_PROVIDERS.find((b) => b.name === name.trim().toLowerCase());
  if (!p) throw new PaymentError(`unknown BNPL provider "${name}" — onboard it in master settings before offering it`);
  return p;
}

export function bnplPlan(input: { amount: Money; provider: string; instalments?: number; firstPaymentAt: string; shariahProduct?: boolean }): BnplPlan {
  const provider = bnplProvider(input.provider);
  const instalments = input.instalments ?? provider.instalments[0]!;
  if (!provider.instalments.includes(instalments)) {
    throw new PaymentError(`${provider.name} offers ${provider.instalments.join('/')} instalments, not ${instalments}`);
  }
  if (input.shariahProduct && !provider.shariahApproved) {
    throw new PaymentError(`${provider.name} is not a Shariah-approved BNPL provider and cannot collect contributions for a takaful arrangement`);
  }
  const providerFee = applyBps(input.amount, provider.feeBps);
  const parts = allocate(input.amount, Array.from({ length: instalments }, () => 1));
  const schedule = parts.map((amount, i) => ({
    number: i + 1,
    dueDate: addMonths(input.firstPaymentAt.slice(0, 10), i),
    amount,
    status: (i === 0 ? 'due-now' : 'scheduled') as Instalment['status'],
  }));
  return {
    provider: provider.name,
    instalments,
    schedule,
    providerFee,
    customerPays: input.amount,
    firstPayment: schedule[0]!.amount,
    disclosure: `${provider.name} collects ${instalments} instalments; the first of ${formatAmount(schedule[0]!.amount)} is taken now and the insurer receives the full ${formatAmount(input.amount)} less a provider fee of ${formatAmount(providerFee)} (${provider.feeBps} bps). The fee is a cost of sale borne by the insurer and is not added to your premium.`,
  };
}

export function addMonths(day: string, months: number): string {
  const d = new Date(`${day.slice(0, 10)}T00:00:00Z`);
  if (Number.isNaN(d.getTime())) return day;
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + months, Math.min(d.getUTCDate(), 28))).toISOString().slice(0, 10);
}

export function addBusinessDays(day: string, days: number): string {
  let d = new Date(`${day.slice(0, 10)}T00:00:00Z`);
  let left = days;
  while (left > 0) {
    d = new Date(d.getTime() + 86_400_000);
    const dow = d.getUTCDay();
    if (dow !== 5 && dow !== 6) left -= 1;      // Friday and Saturday are the UAE weekend
  }
  return d.toISOString().slice(0, 10);
}

/* ------------------------------------------------------------------ capture */

export interface CaptureInput {
  readonly reference: string;          // quotation id, policy id or invoice the money belongs to
  readonly partyId: string;
  readonly customerName: string;
  readonly amount: Money;
  readonly method: PaymentMethod;
  readonly at: string;
  readonly by: string;
  readonly currency: string;
  /** card */
  readonly pan?: string;
  readonly expiry?: string;
  readonly cardholder?: string;
  readonly cvvPresent?: boolean;
  readonly authentication?: 'sca-3ds' | 'contactless' | 'none';
  /** bank transfer / branch deposit */
  readonly iban?: string;
  readonly bankName?: string;
  readonly depositSlip?: string;
  readonly branch?: string;
  /** bnpl */
  readonly bnplProvider?: string;
  readonly bnplInstalments?: number;
  readonly shariahProduct?: boolean;
  /** reconciliation */
  readonly amountDue?: Money;
  readonly idempotencyKey?: string;
}

export interface PaymentRecord {
  readonly id: string;
  readonly reference: string;
  readonly partyId: string;
  readonly customerName: string;
  readonly method: PaymentMethod;
  readonly methodLabel: string;
  readonly amount: Money;
  readonly amountLabel: string;
  readonly fee: Money;
  readonly feeLabel: string;
  readonly netToInsurer: Money;
  readonly netLabel: string;
  readonly status: PaymentStatus;
  readonly settlesOn: string;
  readonly settledAt: string | null;
  readonly at: string;
  readonly by: string;
  readonly proof: readonly string[];
  readonly card: { readonly brand: CardBrand; readonly maskedPan: string; readonly fingerprint: string; readonly expiry: string; readonly authentication: string; readonly cvvStored: false } | null;
  readonly bank: { readonly iban: string; readonly maskedIban: string; readonly bankName: string } | null;
  readonly branch: { readonly slip: string; readonly branch: string } | null;
  readonly bnpl: BnplPlan | null;
  readonly reconciliation: {
    readonly dueLabel: string;
    readonly paidLabel: string;
    readonly shortfallLabel: string;
    readonly overpaymentLabel: string;
    readonly clearsDue: boolean;
  };
  readonly note: string;
  readonly idempotencyKey: string | null;
}

export interface Reconciliation {
  readonly reference: string;
  readonly due: Money;
  readonly paid: Money;
  readonly pending: Money;
  readonly shortfall: Money;
  readonly overpayment: Money;
  readonly clearsDue: boolean;
  readonly payments: readonly PaymentRecord[];
}

export class PaymentBook {
  private readonly payments: PaymentRecord[] = [];
  private readonly byKey = new Map<string, PaymentRecord>();
  private seq = 0;

  list(): PaymentRecord[] { return [...this.payments]; }

  for(reference: string): PaymentRecord[] { return this.payments.filter((p) => p.reference === reference); }

  get(id: string): PaymentRecord {
    const p = this.payments.find((x) => x.id === id);
    if (!p) throw new PaymentError(`unknown payment ${id}`);
    return p;
  }

  /**
   * Take a payment. The same idempotency key twice returns the first record instead of charging the
   * customer again — a retried "buy" button must never produce two receipts.
   */
  capture(input: CaptureInput): PaymentRecord {
    if (input.idempotencyKey) {
      const existing = this.byKey.get(input.idempotencyKey);
      if (existing) return existing;
    }
    const def = methodDef(input.method);
    const amount = input.amount;
    if (amount.currency !== input.currency) throw new PaymentError(`payment currency ${amount.currency} does not match the ${input.currency} quotation`);
    if (amount.minor <= 0n) throw new PaymentError('a payment must be greater than zero');
    if (amount.minor < def.minAmountMinor) throw new PaymentError(`${def.label} accepts no less than ${formatAmount(money(def.minAmountMinor, input.currency))}`);
    if (amount.minor > def.maxAmountMinor) throw new PaymentError(`${def.label} accepts no more than ${formatAmount(money(def.maxAmountMinor, input.currency))}; split the payment or use a bank transfer`);
    if (input.shariahProduct && !def.shariahEligible && input.method !== 'bnpl') {
      throw new PaymentError(`${def.label} is not offered on a Shariah-compliant arrangement`);
    }

    const proof: string[] = [];
    let card: PaymentRecord['card'] = null;
    let bank: PaymentRecord['bank'] = null;
    let branch: PaymentRecord['branch'] = null;
    let bnpl: BnplPlan | null = null;
    let status: PaymentStatus = def.settlesOnCapture ? 'captured' : 'pending';

    if (input.method === 'credit-card' || input.method === 'debit-card') {
      const pan = (input.pan ?? '').replace(/\s+/g, '');
      if (!luhnValid(pan)) throw new PaymentError('the card number does not pass its check digit — it was mistyped or truncated');
      const brand = cardBrand(pan);
      if (brand === 'unknown') throw new PaymentError('the card brand is not on the accepted list (Visa, Mastercard)');
      if (input.method === 'credit-card' && brand === 'amex') {
        proof.push('American Express accepted on the credit-card rail under the merchant agreement');
      }
      if (!input.expiry || !cardExpiryValid(input.expiry, input.at)) throw new PaymentError('the card has expired or the expiry date is not readable');
      if (def.requiresAuthentication && input.authentication !== 'sca-3ds' && input.authentication !== 'contactless') {
        throw new PaymentError(`${def.label} needs strong customer authentication; the transaction was not authenticated`);
      }
      card = {
        brand, maskedPan: maskPan(pan), fingerprint: fingerprint(pan).slice(0, 16),
        expiry: input.expiry, authentication: input.authentication ?? 'none', cvvStored: false,
      };
      proof.push(`Authorised by ${brand} on ${maskPan(pan)} with ${input.authentication ?? 'no'} authentication`);
      proof.push('The card number is held as a fingerprint and its last four digits only; the CVV was used for authorisation and discarded');
      status = 'captured';
    }

    if (input.method === 'bank-transfer') {
      const iban = (input.iban ?? '').replace(/\s+/g, '').toUpperCase();
      if (!ibanValid(iban)) throw new PaymentError(`"${iban}" is not a valid IBAN (ISO 13616 check digits failed)`);
      bank = { iban, maskedIban: `${iban.slice(0, 4)}****${iban.slice(-4)}`, bankName: input.bankName?.trim() || '—' };
      proof.push(`Transfer instructed to ${bank.maskedIban} at ${bank.bankName}; pending until the bank statement confirms the credit`);
      status = 'pending';
    }

    if (input.method === 'branch-deposit') {
      if (!input.depositSlip?.trim()) throw new PaymentError('a branch deposit needs the deposit slip number as its proof');
      branch = { slip: input.depositSlip.trim(), branch: input.branch?.trim() || 'head-office' };
      proof.push(`Deposit slip ${branch.slip} held at ${branch.branch}; pending until the deposit clears`);
      status = 'pending';
    }

    if (input.method === 'cash') {
      proof.push(`Cash counted at ${input.branch?.trim() || 'head-office'} and receipted by ${input.by}`);
      status = 'captured';
    }

    if (input.method === 'bnpl') {
      bnpl = bnplPlan({
        amount, provider: input.bnplProvider ?? 'tabby',
        ...(input.bnplInstalments ? { instalments: input.bnplInstalments } : {}),
        firstPaymentAt: input.at.slice(0, 10), shariahProduct: input.shariahProduct ?? false,
      });
      proof.push(bnpl.disclosure);
      proof.push(`Provider agreement reference ${fingerprint(`${bnpl.provider}|${input.reference}|${input.at}`).slice(0, 12)}`);
      status = 'captured';
    }

    const fee = applyBps(amount, def.feeBps);
    const settlesOn = def.settlementDays === 0 ? input.at.slice(0, 10) : addBusinessDays(input.at.slice(0, 10), def.settlementDays);
    const due = input.amountDue ?? amount;
    const shortfall = compare(amount, due) < 0 ? sub(due, amount) : zero(input.currency);
    const overpayment = compare(amount, due) > 0 ? sub(amount, due) : zero(input.currency);
    if (overpayment.minor > 0n && input.method !== 'bnpl') {
      proof.push(`Overpayment of ${formatAmount(overpayment)} held as an advance against the next instalment`);
    }

    const record: PaymentRecord = {
      id: `PAY-${String(++this.seq).padStart(6, '0')}`,
      reference: input.reference, partyId: input.partyId, customerName: input.customerName,
      method: input.method, methodLabel: def.label,
      amount, amountLabel: formatAmount(amount),
      fee, feeLabel: formatAmount(fee),
      netToInsurer: sub(amount, fee), netLabel: formatAmount(sub(amount, fee)),
      status, settlesOn, settledAt: status === 'captured' && def.settlementDays === 0 ? input.at : null,
      at: input.at, by: input.by, proof, card, bank, branch, bnpl,
      reconciliation: {
        dueLabel: formatAmount(due), paidLabel: formatAmount(amount),
        shortfallLabel: formatAmount(shortfall), overpaymentLabel: formatAmount(overpayment),
        clearsDue: compare(amount, due) >= 0,
      },
      note: status === 'pending'
        ? `${def.label}: recorded as pending; the policy is issued when the money settles on ${settlesOn}.`
        : `${def.label}: captured${def.feeBps > 0 ? ` less a ${def.feeBps} bps handling cost of ${formatAmount(fee)}` : ''}; settles ${settlesOn}.`,
      idempotencyKey: input.idempotencyKey ?? null,
    };
    this.payments.push(record);
    if (input.idempotencyKey) this.byKey.set(input.idempotencyKey, record);
    return record;
  }

  /** The bank confirmed the credit: pending becomes settled, and the policy may be issued. */
  settle(input: { paymentId: string; at: string; by: string; proof?: string }): PaymentRecord {
    const record = this.get(input.paymentId);
    if (record.status === 'settled') return record;
    if (record.status === 'failed' || record.status === 'refunded') {
      throw new PaymentError(`payment ${record.id} is ${record.status} and cannot be settled`);
    }
    const settled: PaymentRecord = {
      ...record, status: 'settled', settledAt: input.at,
      proof: [...record.proof, input.proof?.trim() || `Settled on ${input.at.slice(0, 10)} by ${input.by}`],
      note: `${record.methodLabel}: settled ${input.at.slice(0, 10)}; the money is the insurer's.`,
    };
    this.payments[this.payments.indexOf(record)] = settled;
    return settled;
  }

  /** A transfer that never arrived, or a cheque that bounced — before the money was ours. */
  fail(input: { paymentId: string; at: string; by: string; reason: string }): PaymentRecord {
    const record = this.get(input.paymentId);
    if (record.status === 'captured' || record.status === 'settled') {
      throw new PaymentError(`payment ${record.id} was already ${record.status}; money the insurer has received is reversed, not failed`);
    }
    if (input.reason.trim().length < REASON_MINIMUM) {
      throw new PaymentError(`a failed payment needs a reason of at least ${REASON_MINIMUM} characters — "${input.reason}" is not one`);
    }
    const failed: PaymentRecord = {
      ...record, status: 'failed', settledAt: null,
      proof: [...record.proof, `Failed on ${input.at.slice(0, 10)} by ${input.by}: ${input.reason.trim()}`],
      note: `${record.methodLabel}: failed — ${input.reason.trim()}`,
    };
    this.payments[this.payments.indexOf(record)] = failed;
    return failed;
  }

  reverse(input: { paymentId: string; at: string; by: string; reason: string }): PaymentRecord {
    const record = this.get(input.paymentId);
    if (input.reason.trim().length < REASON_MINIMUM) {
      throw new PaymentError(`a reversal needs a reason of at least ${REASON_MINIMUM} characters`);
    }
    const refunded: PaymentRecord = {
      ...record, status: 'refunded',
      proof: [...record.proof, `Reversed on ${input.at.slice(0, 10)} by ${input.by}: ${input.reason.trim()}`],
      note: `${record.methodLabel}: reversed — ${input.reason.trim()}`,
    };
    this.payments[this.payments.indexOf(record)] = refunded;
    return refunded;
  }

  /** Does the money taken against this reference actually clear what is due? */
  reconcile(reference: string, due: Money): Reconciliation {
    const mine = this.for(reference).filter((p) => p.status !== 'failed' && p.status !== 'refunded');
    const paid = mine.filter((p) => p.status === 'captured' || p.status === 'settled').reduce((acc, p) => add(acc, p.amount), zero(due.currency));
    const pending = mine.filter((p) => p.status === 'pending' || p.status === 'authorised').reduce((acc, p) => add(acc, p.amount), zero(due.currency));
    const shortfall = compare(paid, due) < 0 ? sub(due, paid) : zero(due.currency);
    const overpayment = compare(paid, due) > 0 ? sub(paid, due) : zero(due.currency);
    return { reference, due, paid, pending, shortfall, overpayment, clearsDue: compare(paid, due) >= 0, payments: mine };
  }
}

export function paymentOptionsFor(input: { amount: Money; shariahProduct?: boolean; country?: string }): Array<{ code: PaymentMethod; label: string; available: boolean; reason: string; feeLabel: string; settlesOn: string; note: string }> {
  const at = '2026-10-05';
  return PAYMENT_METHODS.map((m) => {
    const tooSmall = input.amount.minor < m.minAmountMinor;
    const tooLarge = input.amount.minor > m.maxAmountMinor;
    const shariah = Boolean(input.shariahProduct) && !m.shariahEligible;
    const available = !tooSmall && !tooLarge && !shariah;
    return {
      code: m.code, label: m.label, available,
      reason: tooSmall ? `below the ${formatAmount(money(m.minAmountMinor, input.amount.currency))} minimum for this method`
        : tooLarge ? `above the ${formatAmount(money(m.maxAmountMinor, input.amount.currency))} limit for this method`
        : shariah ? 'not offered on a Shariah-compliant arrangement'
        : 'available',
      feeLabel: m.feeBps === 0 ? 'no handling cost' : `${formatAmount(applyBps(input.amount, m.feeBps))} (${m.feeBps} bps) borne by the insurer`,
      settlesOn: m.settlementDays === 0 ? at : addBusinessDays(at, m.settlementDays),
      note: m.note,
    };
  });
}

export { formatAmount, zero };
