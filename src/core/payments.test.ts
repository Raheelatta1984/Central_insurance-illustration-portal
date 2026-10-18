/**
 * Payment options and capture.
 *
 * Six ways to pay, six different answers to "when is the money ours". These tests hold the line on
 * the three things that go wrong in practice: a card number that is stored rather than fingerprinted,
 * a policy issued on a transfer that has not cleared, and a retried "buy" button that charges the
 * customer twice.
 */
import { describe, expect, it } from 'vitest';
import { money, formatAmount, parseAmount } from './money.js';
import {
  PAYMENT_METHODS, PaymentBook, addBusinessDays, bnplPlan, cardBrand, cardExpiryValid, ibanValid,
  luhnValid, maskPan, methodDef, paymentOptionsFor,
} from './payments.js';

const AED = 'AED';
const due = parseAmount('49,219.49', AED);
const at = '2026-10-05T11:00:00+04:00';

function book(): PaymentBook { return new PaymentBook(); }

const base = {
  reference: 'QTN-2026-000001', partyId: 'PTY-0001', customerName: 'Ahmed Al Mansoori',
  amount: due, at, by: 'cashier-desk', currency: AED, amountDue: due,
};

describe('the method catalogue', () => {
  it('offers cash, both card rails, bank transfer, BNPL and a branch deposit', () => {
    expect(PAYMENT_METHODS.map((m) => m.code)).toEqual(['cash', 'credit-card', 'debit-card', 'bank-transfer', 'bnpl', 'branch-deposit']);
    for (const m of PAYMENT_METHODS) expect(m.note.length, m.code).toBeGreaterThan(30);
  });

  it('says which methods are available for an amount, and why one is not', () => {
    // A customer told "card declined" without a reason calls the contact centre; the reason is here.
    const options = paymentOptionsFor({ amount: parseAmount('20', AED) });
    expect(options.find((o) => o.code === 'bnpl')!.available).toBe(false);
    expect(options.find((o) => o.code === 'bnpl')!.reason).toMatch(/below the/);
    expect(options.find((o) => o.code === 'cash')!.available).toBe(true);

    const big = paymentOptionsFor({ amount: parseAmount('90,000', AED) });
    expect(big.find((o) => o.code === 'cash')!.available).toBe(false);
    expect(big.find((o) => o.code === 'cash')!.reason).toMatch(/above the/);
    expect(big.find((o) => o.code === 'bank-transfer')!.available).toBe(true);

    const takaful = paymentOptionsFor({ amount: due, shariahProduct: true });
    expect(takaful.find((o) => o.code === 'bnpl')!.available).toBe(false);
    expect(takaful.find((o) => o.code === 'bnpl')!.reason).toMatch(/Shariah-compliant/);
  });

  it('prices the handling cost to the insurer, not to the customer', () => {
    expect(methodDef('credit-card').feeBps).toBe(220);
    expect(methodDef('cash').feeBps).toBe(0);
    expect(paymentOptionsFor({ amount: due }).find((o) => o.code === 'credit-card')!.feeLabel).toMatch(/borne by the insurer/);
  });
});

describe('card handling', () => {
  it('recognises Visa and Mastercard, and validates the check digit', () => {
    expect(cardBrand('4111 1111 1111 1111')).toBe('visa');
    expect(cardBrand('5555555555554444')).toBe('mastercard');
    expect(cardBrand('2223000048400010')).toBe('mastercard');   // the 2-series Mastercard range
    expect(cardBrand('378282246310005')).toBe('amex');
    expect(cardBrand('1234567812345678')).toBe('unknown');
    expect(luhnValid('4111111111111111')).toBe(true);
    expect(luhnValid('4111111111111112')).toBe(false);
  });

  it('never stores the card number, only its mask and a fingerprint', () => {
    const captured = book().capture({
      ...base, method: 'credit-card', pan: '4111 1111 1111 1111', expiry: '09/2029', authentication: 'sca-3ds',
    });
    expect(captured.card!.maskedPan).toBe('************1111');
    expect(captured.card!.brand).toBe('visa');
    expect(captured.card!.cvvStored).toBe(false);
    expect(captured.card!.fingerprint).toHaveLength(16);
    const serialised = JSON.stringify(captured, (_k, v) => (typeof v === 'bigint' ? v.toString() : v));
    expect(serialised).not.toContain('4111111111111111');
    expect(serialised).toContain('************1111');
    expect(captured.proof.join(' ')).toMatch(/CVV was used for authorisation and discarded/);
  });

  it('refuses an unauthenticated card payment, a mistyped number and an expired card', () => {
    expect(() => book().capture({ ...base, method: 'credit-card', pan: '4111111111111111', expiry: '09/2029', authentication: 'none' }))
      .toThrow(/strong customer authentication/);
    expect(() => book().capture({ ...base, method: 'credit-card', pan: '4111111111111112', expiry: '09/2029', authentication: 'sca-3ds' }))
      .toThrow(/check digit/);
    expect(() => book().capture({ ...base, method: 'debit-card', pan: '4111111111111111', expiry: '01/2020', authentication: 'sca-3ds' }))
      .toThrow(/expired/);
    expect(cardExpiryValid('10/2026', '2026-10-05')).toBe(true);   // valid to the end of its month
    expect(cardExpiryValid('09/2026', '2026-10-05')).toBe(false);
    expect(maskPan('411111')).toBe('****');
  });

  it('captures a card immediately but settles it on the scheme cycle', () => {
    const captured = book().capture({ ...base, method: 'debit-card', pan: '4111111111111111', expiry: '09/2029', authentication: 'sca-3ds' });
    expect(captured.status).toBe('captured');
    expect(captured.settledAt).toBeNull();                          // T+1, not today
    expect(captured.settlesOn).toBe('2026-10-06');
    expect(formatAmount(captured.fee)).toBe('442.98 AED');          // 90 bps
    expect(formatAmount(captured.netToInsurer)).toBe('48,776.51 AED');
  });
});

describe('bank transfer and branch deposit', () => {
  it('validates the IBAN check digits and holds the transfer as pending', () => {
    // A policy issued on an uncleared transfer is a policy the insurer has paid for.
    expect(ibanValid('AE070331234567890123456')).toBe(true);
    expect(ibanValid('AE080331234567890123456')).toBe(false);
    expect(ibanValid('not-an-iban')).toBe(false);

    const captured = book().capture({ ...base, method: 'bank-transfer', iban: 'AE07 0331 2345 6789 0123 456', bankName: 'Emirates NBD' });
    expect(captured.status).toBe('pending');
    expect(captured.bank!.maskedIban).toBe('AE07****3456');
    expect(captured.settlesOn).toBe(addBusinessDays('2026-10-05', 2));
    expect(captured.proof.join(' ')).toMatch(/pending until the bank statement confirms/);
    expect(() => book().capture({ ...base, method: 'bank-transfer', iban: 'AE080331234567890123456' })).toThrow(/not a valid IBAN/);
  });

  it('needs the deposit slip number as its proof', () => {
    expect(() => book().capture({ ...base, method: 'branch-deposit', branch: 'Jumeirah' })).toThrow(/deposit slip number/);
    const captured = book().capture({ ...base, method: 'branch-deposit', depositSlip: 'DEP-88213', branch: 'Jumeirah' });
    expect(captured.status).toBe('pending');
    expect(captured.branch!.slip).toBe('DEP-88213');
  });

  it('settles cash on the counter, and skips the UAE weekend when counting settlement days', () => {
    const cash = book().capture({ ...base, method: 'cash', branch: 'Jumeirah' });
    expect(cash.status).toBe('captured');
    expect(cash.settlesOn).toBe('2026-10-05');
    expect(cash.settledAt).toBe(at);
    expect(addBusinessDays('2026-10-08', 1)).toBe('2026-10-11');   // Friday and Saturday are the weekend
  });

  it('moves a pending payment to settled when the bank confirms, and refuses to settle a failed one', () => {
    const b = book();
    const pending = b.capture({ ...base, method: 'bank-transfer', iban: 'AE070331234567890123456' });
    const settled = b.settle({ paymentId: pending.id, at: '2026-10-07T09:00:00+04:00', by: 'treasury', proof: 'Bank statement line 4471 credits the collection account' });
    expect(settled.status).toBe('settled');
    expect(settled.settledAt).toBe('2026-10-07T09:00:00+04:00');
    expect(settled.proof.at(-1)).toMatch(/Bank statement line 4471/);

    // Money the insurer has already received is reversed, not failed: they are different events.
    expect(() => b.fail({ paymentId: settled.id, at: '2026-10-08T09:00:00+04:00', by: 'treasury', reason: 'The transfer never arrived; the customer confirmed they did not send it' }))
      .toThrow(/already settled; money the insurer has received is reversed, not failed/);

    // A second transfer that never arrives fails, and then cannot be settled afterwards.
    const second = b.capture({ ...base, reference: 'QTN-2026-000002', method: 'bank-transfer', iban: 'AE070331234567890123456' });
    expect(() => b.fail({ paymentId: second.id, at: '2026-10-08', by: 'treasury', reason: 'nope' })).toThrow(/at least 24 characters/);
    const failed = b.fail({ paymentId: second.id, at: '2026-10-08T09:00:00+04:00', by: 'treasury', reason: 'The transfer never arrived; the customer confirmed they did not send it' });
    expect(failed.status).toBe('failed');
    expect(failed.proof.at(-1)).toMatch(/Failed on 2026-10-08/);
    expect(() => b.settle({ paymentId: failed.id, at: '2026-10-09', by: 'treasury' })).toThrow(/cannot be settled/);
  });
});

describe('buy now, pay later', () => {
  it('splits the premium into instalments that add back to it exactly', () => {
    const plan = bnplPlan({ amount: due, provider: 'tabby', instalments: 4, firstPaymentAt: '2026-10-05' });
    expect(plan.instalments).toBe(4);
    // Largest remainder: the first instalment carries the extra fils, so the four add back exactly.
    expect(plan.schedule.map((s) => formatAmount(s.amount))).toEqual(['12,304.88 AED', '12,304.87 AED', '12,304.87 AED', '12,304.87 AED']);
    expect(formatAmount(plan.firstPayment)).toBe('12,304.88 AED');
    const total = plan.schedule.reduce((acc, s) => acc + s.amount.minor, 0n);
    expect(total).toBe(due.minor);
    expect(plan.schedule[0]!.status).toBe('due-now');
    expect(plan.schedule[0]!.dueDate).toBe('2026-10-05');
    expect(plan.schedule[1]!.dueDate).toBe('2026-11-05');
    expect(plan.disclosure).toMatch(/provider fee/);
    expect(formatAmount(plan.providerFee)).toBe('2,214.88 AED');    // 450 bps
  });

  it('only offers the instalment counts the provider actually supports', () => {
    expect(() => bnplPlan({ amount: due, provider: 'postpay', instalments: 6, firstPaymentAt: '2026-10-05' })).toThrow(/not 6/);
    expect(() => bnplPlan({ amount: due, provider: 'klarna', firstPaymentAt: '2026-10-05' })).toThrow(/unknown BNPL provider/);
  });

  it('will not collect contributions for a takaful arrangement through an unapproved provider', () => {
    expect(() => bnplPlan({ amount: due, provider: 'tabby', firstPaymentAt: '2026-10-05', shariahProduct: true })).toThrow(/not a Shariah-approved BNPL provider/);
    const approved = bnplPlan({ amount: due, provider: 'tamara', instalments: 3, firstPaymentAt: '2026-10-05', shariahProduct: true });
    expect(approved.provider).toBe('tamara');
  });

  it('captures the BNPL payment in full with the schedule attached as proof', () => {
    const captured = book().capture({ ...base, method: 'bnpl', bnplProvider: 'tabby', bnplInstalments: 4 });
    expect(captured.status).toBe('captured');
    expect(captured.bnpl!.schedule).toHaveLength(4);
    expect(formatAmount(captured.amount)).toBe('49,219.49 AED');     // the insurer is paid in full now
    expect(captured.proof.join(' ')).toMatch(/collects 4 instalments/);
  });
});

describe('capture controls', () => {
  it('refuses the same idempotency key twice instead of charging the customer again', () => {
    // A retried "buy" button is the most common double-charge there is.
    const b = book();
    const first = b.capture({ ...base, method: 'cash', branch: 'Jumeirah', idempotencyKey: 'key-1' });
    const second = b.capture({ ...base, method: 'cash', branch: 'Jumeirah', idempotencyKey: 'key-1' });
    expect(second.id).toBe(first.id);
    expect(b.list()).toHaveLength(1);
  });

  it('refuses an amount outside the method’s limits, in the wrong currency, or of zero', () => {
    expect(() => book().capture({ ...base, method: 'cash', amount: parseAmount('90,000', AED) })).toThrow(/accepts no more than/);
    expect(() => book().capture({ ...base, method: 'bnpl', amount: parseAmount('20', AED), bnplProvider: 'tabby' })).toThrow(/accepts no less than/);
    expect(() => book().capture({ ...base, method: 'cash', amount: money(1000n, 'USD'), currency: AED })).toThrow(/does not match/);
    expect(() => book().capture({ ...base, method: 'cash', amount: money(0n, AED) })).toThrow(/greater than zero/);
  });

  it('reconciles what has been taken against what is due', () => {
    const b = book();
    expect(b.reconcile(base.reference, due).clearsDue).toBe(false);
    b.capture({ ...base, method: 'cash', amount: parseAmount('20,000', AED), branch: 'Jumeirah' });
    const part = b.reconcile(base.reference, due);
    expect(part.clearsDue).toBe(false);
    expect(formatAmount(part.shortfall)).toBe('29,219.49 AED');
    const transfer = b.capture({ ...base, method: 'bank-transfer', iban: 'AE070331234567890123456', amount: parseAmount('29,219.49', AED) });
    const pending = b.reconcile(base.reference, due);
    // Pending money does not clear the due: the policy waits for the bank, not for the instruction.
    expect(pending.clearsDue).toBe(false);
    expect(formatAmount(pending.pending)).toBe('29,219.49 AED');
    b.settle({ paymentId: transfer.id, at: '2026-10-07T09:00:00+04:00', by: 'treasury' });
    expect(b.reconcile(base.reference, due).clearsDue).toBe(true);

    b.capture({ ...base, method: 'credit-card', amount: parseAmount('60,000', AED), pan: '4111111111111111', expiry: '09/2029', authentication: 'sca-3ds' });
    const over = b.reconcile(base.reference, due);
    expect(formatAmount(over.overpayment)).toBe('60,000.00 AED');
  });

  it('records an overpayment as an advance rather than silently keeping it', () => {
    const captured = book().capture({ ...base, method: 'credit-card', amount: parseAmount('60,000', AED), pan: '4111111111111111', expiry: '09/2029', authentication: 'sca-3ds' });
    expect(captured.proof.join(' ')).toMatch(/held as an advance against the next instalment/);
  });

  it('reverses money only with a reason long enough to be a reason', () => {
    const b = book();
    const captured = b.capture({ ...base, method: 'cash', branch: 'Jumeirah' });
    expect(() => b.reverse({ paymentId: captured.id, at: '2026-10-06', by: 'finance', reason: 'oops' })).toThrow(/at least 24 characters/);
    const reversed = b.reverse({ paymentId: captured.id, at: '2026-10-06T09:00:00+04:00', by: 'finance', reason: 'Customer cancelled inside the free-look period; premium refunded in full' });
    expect(reversed.status).toBe('refunded');
    expect(b.reconcile(base.reference, due).payments).toEqual([]);
  });
});
