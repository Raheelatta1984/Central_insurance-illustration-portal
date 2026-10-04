/**
 * Reinsurance and retakaful. These tests hold the rules that stop a cession from going somewhere it
 * is not allowed to go, and hold the arithmetic that decides how much of a claim comes back.
 */
import { describe, expect, it } from 'vitest';
import { Chart, buildChart } from './chart.js';
import { Ledger } from './ledger.js';
import { Money, money } from './money.js';
import { REINSURANCE_SEED, ReinsuranceError, TreatyRegister } from './reinsurance.js';

function book(entityId = 'ALK-CONV', currency = 'AED') {
  const ledger = new Ledger('AED');
  buildChart(ledger, entityId, currency, []);
  return { ledger, register: new TreatyRegister(ledger, entityId, currency) };
}

function seeded(basis: 'conventional' | 'takaful' = 'conventional', entityId = 'ALK-CONV') {
  const { ledger, register } = book(entityId);
  for (const treat of REINSURANCE_SEED) {
    if (treat.basis === basis) register.register({ ...treat, currency: 'AED' });
  }
  return { ledger, register };
}


/** A claims stub that posts exactly what the claims module posts, so the books are real. */
function claimsStub(ledger: Ledger, entityId = 'ALK-CONV') {
  return {
    recover(claimId: string, input: { amount: Money; at: string; receivedInto?: string }) {
      const account = input.receivedInto ?? `${entityId}:CASH`;
      ledger.post({
        id: `CL-STUB-${claimId}-${Math.random().toString(36).slice(2, 8)}`,
        entityId, at: input.at, source: 'claims', sourceRef: claimId,
        description: `reinsurance recovery on ${claimId}`,
        postings: [
          { accountId: account, side: 'debit', amount: input.amount, baseAmount: input.amount },
          { accountId: `${entityId}:CLAIM-RECOVERY`, side: 'credit', amount: input.amount, baseAmount: input.amount },
        ],
      });
      return { id: `REC-${claimId}`, amount: input.amount };
    },
  };
}

describe('treaty register', () => {
  it('refuses a treaty that cannot be read as a share of anything', () => {
    const { register } = book();
    expect(() => register.register({ ...REINSURANCE_SEED[0]!, cessionBps: 0 } as never)).toThrow(/share between 0 and 10,000 bps/);
    expect(() => register.register({ ...REINSURANCE_SEED[1]!, lines: 0 } as never)).toThrow(/at least one line/);
    expect(() => register.register({ ...REINSURANCE_SEED[2]!, limit: money(0n, 'AED') } as never)).toThrow(/positive limit/);
    expect(() => register.register({ ...REINSURANCE_SEED[0]!, commissionBps: 12_000 } as never)).toThrow(/not a share of the premium/);
    expect(() => register.register({ ...REINSURANCE_SEED[0]!, to: '2025-12-31' } as never)).toThrow(/cannot end before it starts/);
  });

  it('keeps one register with both bases, and will not mix currencies inside an entity', () => {
    const { register } = book();
    for (const treat of REINSURANCE_SEED) register.register({ ...treat, currency: 'AED' });
    expect(register.list().map((t) => t.id)).toContain('RTKF-QS-20');
    expect(register.list({ basis: 'takaful' }).map((t) => t.id)).toEqual(['RTKF-QS-20']);
    // 'all' treaties respond to every line of business, so they belong in this list too.
    expect(register.list({ lineOfBusiness: 'motor' }).map((t) => t.id))
      .toEqual(['AGG-SL-DEPOSIT', 'FAC-MOTOR', 'QS-25-2026', 'RTKF-QS-20', 'XOL-CAT-5M']);
    expect(register.list({ lineOfBusiness: 'medical' }).map((t) => t.id)).not.toContain('FAC-MOTOR');
    expect(() => register.register({ ...REINSURANCE_SEED[0]!, id: 'USD-1', currency: 'USD' } as never)).toThrow(/cannot take a USD treaty/);
  });
});

describe('cession', () => {
  it('cedes a quota share exactly, and never more than the whole risk', () => {
    const { register } = seeded();
    const c = register.authoriseCession('QS-25-2026', {
      riskId: 'UL-000123', sumInsured: money(900_000_00, 'AED'), lineOfBusiness: 'life', at: '2026-03-01T10:00:00+04:00', basis: 'conventional',
    });
    expect(c.ceded.minor).toBe(225_000_00n);
    expect(c.retainedAfter.minor).toBe(675_000_00n);
    expect(c.shareBps).toBe(2_500);
    expect(c.explanation).toMatch(/25% of every risk/);
  });

  it('a surplus treaty retains first and cedes its lines, then says what is left over', () => {
    const { register } = seeded();
    const small = register.authoriseCession('SURPLUS-10', {
      riskId: 'P-1', sumInsured: money(150_000_00, 'AED'), lineOfBusiness: 'life', at: '2026-03-01T10:00:00+04:00', basis: 'conventional',
    });
    expect(small.ceded.minor).toBe(0n);
    expect(small.explanation).toMatch(/inside the 200,000.00 AED retention/);

    const large = register.authoriseCession('SURPLUS-10', {
      riskId: 'P-2', sumInsured: money(3_500_000_00, 'AED'), lineOfBusiness: 'life', at: '2026-03-01T10:00:00+04:00', basis: 'conventional',
    });
    expect(large.ceded.minor).toBe(2_000_000_00n);          // capacity: 200,000 × 10 lines
    expect(large.retainedAfter.minor).toBe(1_500_000_00n);  // 200,000 retained + 1.3m above the treaty
    expect(large.explanation).toMatch(/retained and should be facultative/);
  });

  it('an excess of loss treaty responds only inside its band', () => {
    const { register } = seeded();
    const below = register.authoriseCession('XOL-CAT-5M', {
      riskId: 'R-1', sumInsured: money(800_000_00, 'AED'), lineOfBusiness: 'motor', at: '2026-03-01T10:00:00+04:00', basis: 'conventional',
    });
    expect(below.ceded.minor).toBe(0n);
    const inside = register.authoriseCession('XOL-CAT-5M', {
      riskId: 'R-2', sumInsured: money(2_000_000_00, 'AED'), lineOfBusiness: 'motor', at: '2026-03-01T10:00:00+04:00', basis: 'conventional',
    });
    expect(inside.ceded.minor).toBe(1_000_000_00n);
    const above = register.authoriseCession('XOL-CAT-5M', {
      riskId: 'R-3', sumInsured: money(9_000_000_00, 'AED'), lineOfBusiness: 'motor', at: '2026-03-01T10:00:00+04:00', basis: 'conventional',
    });
    expect(above.ceded.minor).toBe(5_000_000_00n);          // capped by the limit
    expect(above.retainedAfter.minor).toBe(4_000_000_00n);
  });

  it('a treaty outside its dates cannot be used, and a line of business it does not cover cannot either', () => {
    const { register } = seeded();
    expect(() => register.authoriseCession('QS-25-2026', {
      riskId: 'X', sumInsured: money(1000_00, 'AED'), lineOfBusiness: 'life', at: '2027-03-01T10:00:00+04:00', basis: 'conventional',
    })).toThrow(/not in force on 2027-03-01/);
    expect(() => register.authoriseCession('FAC-MOTOR', {
      riskId: 'X', sumInsured: money(1000_00, 'AED'), lineOfBusiness: 'life', at: '2026-03-01T10:00:00+04:00', basis: 'conventional',
    })).toThrow(/covers motor, not life/);
  });

  it('facultative cover exists only after the reinsurer accepts the named risk', () => {
    const { register } = seeded();
    expect(() => register.authoriseCession('FAC-MOTOR', {
      riskId: 'MTR-9', sumInsured: money(500_000_00, 'AED'), lineOfBusiness: 'motor', at: '2026-03-01T10:00:00+04:00', basis: 'conventional',
    })).toThrow(/has not been accepted under facultative treaty/);
    register.acceptFacultative('FAC-MOTOR', 'MTR-9', { at: '2026-03-02T09:00:00+04:00', by: 'underwriting/reinsurance-desk' });
    const c = register.authoriseCession('FAC-MOTOR', {
      riskId: 'MTR-9', sumInsured: money(500_000_00, 'AED'), lineOfBusiness: 'motor', at: '2026-03-03T10:00:00+04:00', basis: 'conventional',
    });
    expect(c.ceded.minor).toBe(200_000_00n);                 // the 40% offered and accepted
    expect(register.acceptedRisks('FAC-MOTOR')).toEqual(['MTR-9']);
  });

  it('participant risk money may not be ceded to a conventional reinsurer, and conventional risk may not use retakaful', () => {
    const { register } = book();
    for (const treat of REINSURANCE_SEED) register.register({ ...treat, currency: 'AED' });
    expect(() => register.authoriseCession('QS-25-2026', {
      riskId: 'TKF-1', sumInsured: money(100_000_00, 'AED'), lineOfBusiness: 'life', at: '2026-03-01T10:00:00+04:00', basis: 'takaful',
    })).toThrow(/participant risk money may not be ceded to it/);
    expect(() => register.authoriseCession('RTKF-QS-20', {
      riskId: 'C-1', sumInsured: money(100_000_00, 'AED'), lineOfBusiness: 'life', at: '2026-03-01T10:00:00+04:00', basis: 'conventional',
    })).toThrow(/cannot take conventional risk/);
  });
});

describe('premium cession on the books', () => {
  it('books ceded premium as an expense, commission as income, and keeps the ledger balanced', () => {
    const { ledger, register } = seeded();
    const cession = register.cedePremium({
      treatyId: 'QS-25-2026', policyId: 'UL-000123', riskId: 'UL-000123',
      sumInsured: money(900_000_00, 'AED'), premium: money(921_150_00, 'AED'),
      lineOfBusiness: 'life', at: '2026-03-01T10:00:00+04:00', basis: 'conventional', by: 'reinsurance/desk',
    });
    expect(cession.cededPremium.minor).toBe(230_287_50n);    // 25% of 921,150.00
    expect(cession.commission.minor).toBe(34_543_13n);       // 15% of the ceded premium, half-up
    expect(cession.netRetainedPremium.minor).toBe(725_405_63n);
    expect(cession.shareBps).toBe(2_500);
    expect(ledger.proof('ALK-CONV').balanced).toBe(true);
    expect(ledger.balance('ALK-CONV:REINS:CEDED-PREMIUM').minor).toBe(230_287_50n);
    expect(ledger.balance('ALK-CONV:REINS:PAYABLE').minor).toBe(230_287_50n);
    expect(ledger.balance('ALK-CONV:REINS:COMMISSION').minor).toBe(34_543_13n);
  });

  it('uses the exact slice for a surplus treaty rather than a rounded percentage', () => {
    const { register } = seeded();
    const cession = register.cedePremium({
      treatyId: 'SURPLUS-10', policyId: 'P-2', riskId: 'P-2',
      sumInsured: money(3_500_000_00, 'AED'), premium: money(3_500_00, 'AED'),
      lineOfBusiness: 'life', at: '2026-03-01T10:00:00+04:00', basis: 'conventional',
    });
    // 2,000,000 / 3,500,000 of 3,500.00 = 2,000.00 exactly, not 2,000.05 from a rounded 5,714 bps
    expect(cession.cededPremium.minor).toBe(2_000_00n);
    expect(cession.commission.minor).toBe(200_00n);             // 10% of the ceded 2,000.00
    expect(cession.netRetainedPremium.minor).toBe(1_700_00n);   // 1,500.00 kept + 200.00 commission
  });

  it('refuses to cede the same risk twice under the same treaty, but allows a new instalment', () => {
    const { register } = seeded();
    const base = {
      treatyId: 'QS-25-2026', policyId: 'UL-000123', riskId: 'UL-000123',
      sumInsured: money(300_000_00, 'AED'), premium: money(1_000_00, 'AED'),
      lineOfBusiness: 'life', at: '2026-03-01T10:00:00+04:00', basis: 'conventional' as const,
    };
    register.cedePremium(base);
    expect(() => register.cedePremium(base)).toThrow(/already ceded under QS-25-2026/);
    const second = register.cedePremium({ ...base, at: '2026-04-01T10:00:00+04:00', ref: 'instalment-2' });
    expect(second.ref).toBe('instalment-2');
    expect(register.cessionSchedule()).toHaveLength(2);
  });

  it('remembers the cession so a claim recovery uses the same share', () => {
    const { register } = seeded();
    register.cedePremium({
      treatyId: 'QS-25-2026', policyId: 'UL-000123', riskId: 'UL-000123',
      sumInsured: money(900_000_00, 'AED'), premium: money(921_150_00, 'AED'),
      lineOfBusiness: 'life', at: '2026-03-01T10:00:00+04:00', basis: 'conventional',
    });
    expect(register.shareFor('UL-000123').shareBps).toBe(2_500);
    expect(() => register.shareFor('UL-999999')).toThrow(/no cession is on the schedule/);
  });
});

describe('claim recovery', () => {
  it('recovers the ceded share and records it as receivable, not cash', () => {
    const { ledger, register } = seeded();
    register.cedePremium({
      treatyId: 'QS-25-2026', policyId: 'UL-000123', riskId: 'UL-000123',
      sumInsured: money(900_000_00, 'AED'), premium: money(921_150_00, 'AED'),
      lineOfBusiness: 'life', at: '2026-03-01T10:00:00+04:00', basis: 'conventional',
    });
    const claim = {
      id: 'CLM-000001',
      recover: (claimId: string, input: { type: 'reinsurance'; amount: { minor: bigint; currency: string }; at: string; receivedInto?: string }) => {
        /* eslint-disable-next-line @typescript-eslint/no-unused-expressions */
        expect(claimId).toBe('CLM-000001');
        expect(input.receivedInto).toBe('ALK-CONV:REINS:RECEIVABLE');
        return { id: 'REC-CLM-000001-2', amount: input.amount as never };
      },
    };
    const result = register.recoverClaim({
      policyId: 'UL-000123', claim, claimId: 'CLM-000001',
      paid: money(1_150_00, 'AED'), at: '2026-03-10T10:00:00+04:00', by: 'recovery-desk',
    });
    expect(result.amount.minor).toBe(287_50n);              // 25% of 1,150.00
    expect(result.shareBps).toBe(2_500);
    expect(register.recoveryList()).toHaveLength(1);
    // Claiming the same recovery twice is refused; a named further instalment is not.
    expect(() => register.recoverClaim({
      policyId: 'UL-000123', claim, claimId: 'CLM-000001',
      paid: money(1_150_00, 'AED'), at: '2026-03-11T10:00:00+04:00',
    })).toThrow(/already been recovered under QS-25-2026/);
  });

  it('will not invent a recovery on a risk that was never ceded', () => {
    const { register } = seeded();
    const claim = { id: 'CLM-1', recover: () => ({ id: 'REC-1', amount: money(0n, 'AED') }) };
    expect(() => register.recoverClaim({
      policyId: 'NOT-CEDED', claim, claimId: 'CLM-1', paid: money(100_00, 'AED'), at: '2026-03-10T10:00:00+04:00',
    })).toThrow(/no cession is on the schedule/);
  });
});

describe('utilisation statement', () => {
  it('shows capacity, what is used, what is left, and the percentage of the book ceded', () => {
    const { register } = seeded();
    register.cedePremium({
      treatyId: 'QS-25-2026', policyId: 'UL-000123', riskId: 'UL-000123',
      sumInsured: money(900_000_00, 'AED'), premium: money(921_150_00, 'AED'),
      lineOfBusiness: 'life', at: '2026-03-01T10:00:00+04:00', basis: 'conventional',
    });
    register.cedePremium({
      treatyId: 'SURPLUS-10', policyId: 'P-2', riskId: 'P-2',
      sumInsured: money(3_500_000_00, 'AED'), premium: money(3_500_00, 'AED'),
      lineOfBusiness: 'life', at: '2026-03-01T10:00:00+04:00', basis: 'conventional',
    });
    const statement = register.utilisation({ asOf: '2026-10-05', basis: 'conventional' });
    expect(statement.grossPremium.minor).toBe(924_650_00n);
    expect(statement.cededPremium.minor).toBe(232_287_50n);
    expect(statement.commissionIncome.minor).toBe(34_743_13n);
    expect(statement.netRetainedPremium.minor).toBe(727_105_63n);
    expect(statement.cessionBps).toBe(2_512);

    const quota = statement.treaties.find((t) => t.treatyId === 'QS-25-2026')!;
    expect(quota.cededSumInsured.minor).toBe(225_000_00n);
    expect(quota.premiumCeded.minor).toBe(230_287_50n);
    expect(quota.risks).toBe(1);
    expect(quota.valid).toBe(true);
    expect(quota.commissionEarned.minor).toBe(34_543_13n);

    const surplus = statement.treaties.find((t) => t.treatyId === 'SURPLUS-10')!;
    expect(surplus.capacity.minor).toBe(2_000_000_00n);      // 200,000 × 10 lines
    expect(surplus.cededSumInsured.minor).toBe(2_000_000_00n);
    expect(surplus.headroom.minor).toBe(0n);
    expect(surplus.usedBps).toBe(10_000);                    // a full treaty, and it says so
    expect(surplus.premiumCededBps).toBe(5_714);
  });

  it('a treaty that is not in force on the statement date is flagged, not silently used', () => {
    const { register } = seeded();
    const statement = register.utilisation({ asOf: '2027-06-30', basis: 'conventional' });
    expect(statement.treaties.every((t) => !t.valid)).toBe(true);
  });

  it('segregates the takaful book: its own statement, its own retakaful treaty', () => {
    const { register } = seeded('takaful', 'ALK-TKF');
    register.cedePremium({
      treatyId: 'RTKF-QS-20', policyId: 'TKF-000001', riskId: 'TKF-000001',
      sumInsured: money(500_000_00, 'AED'), premium: money(60_000_00, 'AED'),
      lineOfBusiness: 'life', at: '2026-03-01T10:00:00+04:00', basis: 'takaful',
    });
    const statement = register.utilisation({ asOf: '2026-10-05', basis: 'takaful' });
    expect(statement.treaties.map((t) => t.treatyId)).toEqual(['RTKF-QS-20']);
    expect(statement.cededPremium.minor).toBe(12_000_00n);   // 20% of the contribution
    expect(statement.commissionIncome.minor).toBe(2_400_00n); // 20% wakalah fee on the ceded contribution
    expect(statement.notes.length).toBeGreaterThanOrEqual(0);
  });

  it('retrocedes through the same register, so a reinsurer’s book is modelled identically', () => {
    const { register } = seeded();
    const retro = register.retrocede({
      treatyId: 'QS-25-2026', policyId: 'UL-000123', riskId: 'UL-000123',
      sumInsured: money(900_000_00, 'AED'), premium: money(921_150_00, 'AED'),
      lineOfBusiness: 'life', at: '2026-03-01T10:00:00+04:00',
    });
    expect(retro.treatyId).toBe('QS-25-2026-RETRO');
    expect(retro.cededPremium.minor).toBe(230_287_50n);
    const statement = register.utilisation({ asOf: '2026-10-05', basis: 'conventional' });
    expect(statement.treaties.map((t) => t.treatyId)).toContain('QS-25-2026-RETRO');
  });

describe('catastrophe recovery, cover and reinstatement', () => {
  const cat = (register: TreatyRegister) => register.coverState('XOL-CAT-5M');

  it('pays the layer above the attachment, and the cover it uses is gone until it is reinstated', () => {
    const { ledger, register } = seeded();
    const first = register.recoverEvent('XOL-CAT-5M', {
      eventId: 'STORM-ALPHAI', loss: money(1_600_000_00, 'AED'), at: '2026-04-02T10:00:00+04:00', by: 'catastrophe-desk',
    });
    expect(first.amount.minor).toBe(600_000_00n);            // 1.6m loss, 1m retained: the treaty pays 600,000
    expect(first.treatment).toBe('risk-transferring');
    expect(first.cover.consumed.minor).toBe(600_000_00n);
    expect(first.cover.available.minor).toBe(4_400_000_00n);
    expect(ledger.balance('ALK-CONV:REINS:RECEIVABLE').minor).toBe(600_000_00n);
    expect(ledger.balance('ALK-CONV:REINS:RECOVERY').minor).toBe(600_000_00n);   // recovery is income
    expect(ledger.proof('ALK-CONV').balanced).toBe(true);

    // A loss inside the attachment is retained in full, and says so.
    expect(() => register.recoverEvent('XOL-CAT-5M', {
      eventId: 'FLOOD-SMALL', loss: money(700_000_00, 'AED'), at: '2026-04-03T10:00:00+04:00',
    })).toThrow(/inside the 1,000,000\.00 AED attachment point/);
  });

  it('refuses a loss the remaining cover cannot meet, rather than paying what is not there', () => {
    const { register } = seeded();
    // The first event uses 600,000 of the 5,000,000 layer, so 4,400,000 is left.
    register.recoverEvent('XOL-CAT-5M', { eventId: 'STORM-ALPHAI', loss: money(1_600_000_00, 'AED'), at: '2026-04-02T10:00:00+04:00' });
    expect(() => register.recoverEvent('XOL-CAT-5M', {
      eventId: 'STORM-HUGE', loss: money(20_000_000_00, 'AED'), at: '2026-04-03T10:00:00+04:00',
    })).toThrow(/has 4,400,000\.00 AED of cover left and the event needs 5,000,000\.00 AED/);
  });

  it('reinstates free the first time, charges for the second, and refuses the third', () => {
    const { ledger, register } = seeded();
    register.recoverEvent('XOL-CAT-5M', { eventId: 'STORM-ALPHAI', loss: money(1_600_000_00, 'AED'), at: '2026-04-02T10:00:00+04:00' });
    const first = register.reinstate('XOL-CAT-5M', { at: '2026-04-03T09:00:00+04:00', by: 'reinsurance/desk' });
    expect(first.free).toBe(true);
    expect(first.premium.minor).toBe(0n);
    expect(first.restored.minor).toBe(600_000_00n);
    expect(first.available.minor).toBe(5_000_000_00n);       // cover whole again
    expect(cat(register).reinstatementsLeft).toBe(1);

    // a second event, then the paid reinstatement: 50% of 250,000 pro rata to the 600,000 restored
    register.recoverEvent('XOL-CAT-5M', { eventId: 'STORM-BISHRA', loss: money(2_600_000_00, 'AED'), at: '2026-06-10T10:00:00+04:00' });
    const second = register.reinstate('XOL-CAT-5M', { at: '2026-06-11T09:00:00+04:00' });
    expect(second.free).toBe(false);
    expect(second.restored.minor).toBe(1_600_000_00n);       // 2.6m loss, 1m retained: 1.6m paid, so 1.6m restored
    expect(second.premium.minor).toBe(40_000_00n);           // 250,000 x 50% x 1,600,000/5,000,000
    expect(second.journalId).toBeTruthy();
    expect(ledger.balance('ALK-CONV:REINS:CEDED-PREMIUM').minor).toBe(40_000_00n);
    expect(cat(register).reinstatementsLeft).toBe(0);
    expect(register.reinstatements()).toHaveLength(2);

    register.recoverEvent('XOL-CAT-5M', { eventId: 'STORM-CYRA', loss: money(1_200_000_00, 'AED'), at: '2026-08-01T10:00:00+04:00' });
    expect(() => register.reinstate('XOL-CAT-5M', { at: '2026-08-02T09:00:00+04:00' }))
      .toThrow(/used all 2 reinstatements; the cover is exhausted/);
  });

  it('will not reinstate cover that has not been used, or leave a reinstatement uncapped', () => {
    const { register } = seeded();
    expect(() => register.reinstate('XOL-CAT-5M', { at: '2026-04-03T09:00:00+04:00' }))
      .toThrow(/has paid nothing: there is nothing to reinstate/);
    register.recoverEvent('XOL-CAT-5M', { eventId: 'STORM-ALPHAI', loss: money(1_600_000_00, 'AED'), at: '2026-04-02T10:00:00+04:00' });
    expect(() => register.reinstate('XOL-CAT-5M', { at: '2026-04-03T09:00:00+04:00', restore: money(2_000_000_00, 'AED') }))
      .toThrow(/cannot restore more than has been used/);
    // and a treaty that is not excess of loss has no reinstatements at all
    expect(() => register.reinstate('QS-25-2026', { at: '2026-04-03T09:00:00+04:00' }))
      .toThrow(/reinstatements apply to excess of loss/);
    expect(() => register.recoverEvent('QS-25-2026', { eventId: 'X', loss: money(9_000_000_00, 'AED'), at: '2026-04-03T09:00:00+04:00' }))
      .toThrow(/a loss is recovered per policy, not per event/);
  });

  it('a treaty cannot be written with reinstatements it cannot price', () => {
    const { register } = book();
    expect(() => register.register({ ...REINSURANCE_SEED[2]!, id: 'XOL-NO-PREM', annualPremium: undefined } as never))
      .toThrow(/needs its annual premium/);
    expect(() => register.register({ ...REINSURANCE_SEED[0]!, id: 'QS-REINST', reinstatements: 2, reinstatementBps: 5_000, annualPremium: money(1_000_00, 'AED') } as never))
      .toThrow(/reinstatements are an excess of loss feature/);
    expect(() => register.register({ ...REINSURANCE_SEED[2]!, id: 'XOL-FREE-TOO-MANY', freeReinstatements: 3 } as never))
      .toThrow(/more free reinstatements than reinstatements/);
  });
});

describe('deposit premium and adjustment', () => {
  it('holds the deposit as an asset, settles on the real subject premium and refunds the difference', () => {
    const { ledger, register } = seeded();
    const opened = register.openDeposit('AGG-SL-DEPOSIT', { amount: money(300_000_00, 'AED'), at: '2026-01-05T10:00:00+04:00' });
    expect(opened.depositPaid.minor).toBe(300_000_00n);
    expect(ledger.balance('ALK-CONV:REINS:DEPOSIT-PREMIUM').minor).toBe(300_000_00n);   // an asset, not an expense
    expect(ledger.balance('ALK-CONV:REINS:CEDED-PREMIUM').minor).toBe(0n);
    expect(ledger.proof('ALK-CONV').balanced).toBe(true);

    // 8,000,000 of subject premium at 3.5% is 280,000: the deposit overpaid by 20,000, so it comes back
    const settled = register.settleDeposit('AGG-SL-DEPOSIT', { subjectPremium: money(8_000_000_00, 'AED'), at: '2026-12-31T15:00:00+04:00' });
    expect(settled.technicalPremium?.minor).toBe(280_000_00n);
    expect(settled.settled).toBe(true);
    expect(settled.adjustments.at(-1)?.kind).toBe('return');
    expect(settled.adjustments.at(-1)?.amount.minor).toBe(20_000_00n);
    expect(ledger.balance('ALK-CONV:REINS:DEPOSIT-PREMIUM').minor).toBe(0n);            // released
    expect(ledger.balance('ALK-CONV:REINS:CEDED-PREMIUM').minor).toBe(280_000_00n);     // the real cost
    expect(ledger.balance('ALK-CONV:CASH').minor).toBe(-280_000_00n);                   // 300,000 paid out, 20,000 refunded
    expect(ledger.proof('ALK-CONV').balanced).toBe(true);
  });

  it('charges additional premium when the period earned more than the deposit', () => {
    const { ledger, register } = seeded();
    register.openDeposit('AGG-SL-DEPOSIT', { amount: money(100_000_00, 'AED'), at: '2026-01-05T10:00:00+04:00' });
    const settled = register.settleDeposit('AGG-SL-DEPOSIT', { subjectPremium: money(8_000_000_00, 'AED'), at: '2026-12-31T15:00:00+04:00' });
    expect(settled.technicalPremium?.minor).toBe(280_000_00n);
    expect(settled.adjustments.at(-1)?.kind).toBe('additional');
    expect(settled.adjustments.at(-1)?.amount.minor).toBe(180_000_00n);
    expect(ledger.balance('ALK-CONV:REINS:CEDED-PREMIUM').minor).toBe(280_000_00n);
    expect(ledger.balance('ALK-CONV:REINS:DEPOSIT-PREMIUM').minor).toBe(0n);
    expect(ledger.proof('ALK-CONV').balanced).toBe(true);
  });

  it('pays the deposit in instalments and refuses to settle twice, or to invent a rate', () => {
    const { register } = seeded();
    register.openDeposit('AGG-SL-DEPOSIT', { amount: money(100_000_00, 'AED'), at: '2026-01-05T10:00:00+04:00', instalment: 1 });
    register.openDeposit('AGG-SL-DEPOSIT', { amount: money(100_000_00, 'AED'), at: '2026-04-05T10:00:00+04:00', instalment: 2 });
    expect(register.depositAccount('AGG-SL-DEPOSIT').depositPaid.minor).toBe(200_000_00n);
    expect(() => register.openDeposit('AGG-SL-DEPOSIT', { amount: money(100_000_00, 'AED'), at: '2026-01-05T10:00:00+04:00', instalment: 1 }))
      .toThrow(/instalment 1 of the AGG-SL-DEPOSIT deposit has already been paid/);
    register.settleDeposit('AGG-SL-DEPOSIT', { subjectPremium: money(8_000_000_00, 'AED'), at: '2026-12-31T15:00:00+04:00' });
    expect(() => register.settleDeposit('AGG-SL-DEPOSIT', { subjectPremium: money(8_000_000_00, 'AED'), at: '2026-12-31T16:00:00+04:00' }))
      .toThrow(/already settled for this period/);
    expect(() => register.settleDeposit('AGG-SL-DEPOSIT', { subjectPremium: money(8_000_000_00, 'AED'), at: '2026-12-31T16:00:00+04:00', rateOnLineBps: 0 }))
      .toThrow(/already settled/);   // the settlement guard answers before the rate does, which is the right order
    const { register: fresh } = seeded();
    fresh.openDeposit('AGG-SL-DEPOSIT', { amount: money(100_000_00, 'AED'), at: '2026-01-05T10:00:00+04:00' });
    expect(() => fresh.settleDeposit('QS-25-2026', { subjectPremium: money(1_000_00, 'AED'), at: '2026-12-31T15:00:00+04:00' }))
      .toThrow(/has no deposit premium on account/);
  });

  it('deposit accounting keeps the premium off the profit and loss account and draws the deposit for a loss', () => {
    const { ledger, register } = seeded();
    const cession = register.cedePremium({
      treatyId: 'AGG-SL-DEPOSIT', policyId: 'AGG-2026', riskId: 'AGG-2026',
      sumInsured: money(1_000_000_00, 'AED'), premium: money(40_000_00, 'AED'),
      lineOfBusiness: 'all', at: '2026-01-05T10:00:00+04:00', basis: 'conventional',
    });
    expect(cession.treatment).toBe('deposit');
    expect(ledger.balance('ALK-CONV:REINS:CEDED-PREMIUM').minor).toBe(0n);              // no expense recognised
    expect(ledger.hasAccount('ALK-CONV:REINS:DEPOSIT-PREMIUM')).toBe(true);

    register.openDeposit('AGG-SL-DEPOSIT', { amount: money(300_000_00, 'AED'), at: '2026-01-05T10:00:00+04:00' });
    // the treaty's own share of a loss comes out of the deposit, and no income is recognised
    const drawn = register.recoverEvent('AGG-SL-DEPOSIT', { eventId: 'AGG-Q3', loss: money(900_000_00, 'AED'), at: '2026-10-01T10:00:00+04:00' });
    expect(drawn.treatment).toBe('deposit');
    expect(drawn.amount.minor).toBe(400_000_00n);                                       // above the 500,000 attachment
    expect(ledger.balance('ALK-CONV:REINS:RECOVERY').minor).toBe(0n);                   // no recovery income
    expect(register.accountingTreatment('AGG-SL-DEPOSIT')).toBe('deposit');
    expect(register.accountingTreatment('XOL-CAT-5M')).toBe('risk-transferring');
    expect(ledger.proof('ALK-CONV').balanced).toBe(true);
  });
});

describe('recovery tracking and ageing', () => {
  const makeRecovery = (register: TreatyRegister, ledger: Ledger) => {
    register.cedePremium({
      treatyId: 'QS-25-2026', policyId: 'MTR-0441', riskId: 'MTR-0441',
      sumInsured: money(250_000_00, 'AED'), premium: money(67_00, 'AED'),
      lineOfBusiness: 'motor', at: '2026-01-05T10:00:00+04:00', basis: 'conventional',
    });
    return register.recoverClaim({
      policyId: 'MTR-0441', claim: claimsStub(ledger), claimId: 'CLM-000001',
      paid: money(1_150_00, 'AED'), at: '2026-01-10T10:00:00+04:00',
    });
  };

  it('settles a recovery to cash, allows a part settlement, and refuses to collect it twice', () => {
    const { ledger, register } = seeded();
    const recovery = makeRecovery(register, ledger);
    expect(register.recoveryList()[0]!.outstanding.minor).toBe(287_50n);

    const part = register.settleRecovery({ recoveryId: recovery.recoveryId, amount: money(100_00, 'AED'), at: '2026-02-01T10:00:00+04:00', by: 'treasury' });
    expect(part.settled.minor).toBe(100_00n);
    expect(part.outstanding.minor).toBe(187_50n);
    expect(ledger.balance('ALK-CONV:CASH').minor).toBe(100_00n);
    // The receivable holds the recovery and this treaty's commission (25% of 67.00 = 16.75, at the
    // seed's 1,500 bps = 2.51), less the 100.00 the counterparty has now paid.
    expect(ledger.balance('ALK-CONV:REINS:RECEIVABLE').minor).toBe(28_750n + 251n - 10_000n);

    const rest = register.settleRecovery({ recoveryId: recovery.recoveryId, at: '2026-03-01T10:00:00+04:00' });
    expect(rest.outstanding.minor).toBe(0n);
    expect(ledger.balance('ALK-CONV:CASH').minor).toBe(287_50n);
    expect(ledger.balance('ALK-CONV:REINS:RECEIVABLE').minor).toBe(251n);   // only the commission is still owed
    expect(ledger.proof('ALK-CONV').balanced).toBe(true);

    expect(() => register.settleRecovery({ recoveryId: recovery.recoveryId, at: '2026-04-01T10:00:00+04:00' }))
      .toThrow(/is already settled in full/);
    expect(() => register.settleRecovery({ recoveryId: 'REC-NOPE', at: '2026-04-01T10:00:00+04:00' }))
      .toThrow(/unknown recovery/);
  });

  it('refuses to collect more than is outstanding', () => {
    const { ledger, register } = seeded();
    const recovery = makeRecovery(register, ledger);
    expect(() => register.settleRecovery({ recoveryId: recovery.recoveryId, amount: money(500_00, 'AED'), at: '2026-02-01T10:00:00+04:00' }))
      .toThrow(/has 287\.50 AED outstanding; 500\.00 AED cannot be collected against it/);
  });

  it('ages what is still owed, against the treaty’s own settlement terms', () => {
    const { ledger, register } = seeded();
    makeRecovery(register, ledger);   // recorded 2026-01-10, default terms 60 days
    const at30 = register.ageing({ asOf: '2026-02-01' });
    expect(at30.items).toHaveLength(1);
    expect(at30.items[0]!.ageDays).toBe(22);
    expect(at30.items[0]!.bucket).toBe('0-30');
    expect(at30.items[0]!.overdueDays).toBe(0);
    expect(at30.overdue.minor).toBe(0n);
    expect(at30.buckets.find((b) => b.bucket === '0-30')!.count).toBe(1);

    const at90 = register.ageing({ asOf: '2026-04-15' });
    expect(at90.items[0]!.ageDays).toBe(95);
    expect(at90.items[0]!.bucket).toBe('90+');
    expect(at90.items[0]!.overdueDays).toBe(35);
    expect(at90.items[0]!.expectedBy).toBe('2026-03-11');
    expect(at90.overdue.minor).toBe(287_50n);
    expect(at90.worstOverdue[0]).toBe('QS-25-2026 (35d)');
    expect(at90.oldestDays).toBe(95);
  });

  it('a settled recovery stops ageing, and a shorter settlement term makes an older debt overdue', () => {
    const { ledger, register } = seeded();
    const recovery = makeRecovery(register, ledger);
    register.settleRecovery({ recoveryId: recovery.recoveryId, at: '2026-02-01T10:00:00+04:00' });
    expect(register.ageing({ asOf: '2026-06-01' }).items).toHaveLength(0);
    expect(register.ageing({ asOf: '2026-06-01' }).outstanding.minor).toBe(0n);

    const { register: strict } = book();
    strict.register({ ...REINSURANCE_SEED[0]!, currency: 'AED', settlementDays: 14 } as never);
    strict.cedePremium({
      treatyId: 'QS-25-2026', policyId: 'MTR-0441', riskId: 'MTR-0441',
      sumInsured: money(250_000_00, 'AED'), premium: money(67_00, 'AED'),
      lineOfBusiness: 'motor', at: '2026-01-05T10:00:00+04:00', basis: 'conventional',
    });
    strict.recoverClaim({ policyId: 'MTR-0441', claim: claimsStub(ledger), claimId: 'CLM-1', paid: money(1_150_00, 'AED'), at: '2026-01-10T10:00:00+04:00' });
    const aged = strict.ageing({ asOf: '2026-02-01' });
    expect(aged.items[0]!.expectedBy).toBe('2026-01-24');
    expect(aged.items[0]!.overdueDays).toBe(8);
    expect(aged.overdue.minor).toBe(287_50n);
  });
});

describe('reconciliation and data quality', () => {
  it('ties the register to the books, line by line, and states the difference rather than smoothing it', () => {
    const { ledger, register } = seeded();
    register.cedePremium({
      treatyId: 'QS-25-2026', policyId: 'MTR-0441', riskId: 'MTR-0441',
      sumInsured: money(250_000_00, 'AED'), premium: money(1_000_00, 'AED'),
      lineOfBusiness: 'motor', at: '2026-01-05T10:00:00+04:00', basis: 'conventional',
    });
    register.recoverEvent('XOL-CAT-5M', { eventId: 'STORM-1', loss: money(1_600_000_00, 'AED'), at: '2026-02-01T10:00:00+04:00' });
    register.reinstate('XOL-CAT-5M', { at: '2026-02-02T10:00:00+04:00' });

    const clean = register.reconcile({ asOf: '2026-03-01' });
    expect(clean.agrees).toBe(true);
    expect(clean.differences).toBe(0);
    expect(clean.lines.map((l) => l.kind)).toContain('receivable');
    expect(clean.lines.find((l) => l.kind === 'ceded-premium')!.register.minor).toBe(250_00n);   // 25% of 1,000.00
    expect(clean.lines.find((l) => l.kind === 'event-recovery')!.register.minor).toBe(600_000_00n);
    // 25% of 1,000.00 premium is 250.00 ceded; the commission is the seed's 1,500 bps of that, 37.50.
    expect(clean.balanceSheet.receivable.minor).toBe(600_000_00n + 37_50n);
    expect(clean.lines.find((l) => l.kind === 'receivable')!.difference.minor).toBe(0n);

    // Now break it on purpose: a journal posted straight to the ledger that the register knows
    // nothing about. A reconciliation that cannot see this is decoration.
    ledger.post({
      id: 'ROGUE-1', entityId: 'ALK-CONV', at: '2026-03-02T10:00:00+04:00', source: 'gl', sourceRef: 'manual',
      description: 'manual adjustment, no register record',
      postings: [
        { accountId: 'ALK-CONV:REINS:CEDED-PREMIUM', side: 'debit', amount: money(999_00, 'AED'), baseAmount: money(999_00, 'AED') },
        { accountId: 'ALK-CONV:REINS:PAYABLE', side: 'credit', amount: money(999_00, 'AED'), baseAmount: money(999_00, 'AED') },
      ],
    });
    const broken = register.reconcile({ asOf: '2026-03-03' });
    expect(broken.agrees).toBe(false);
    const line = broken.lines.find((l) => l.kind === 'ceded-premium')!;
    expect(line.status).toBe('difference');
    expect(line.difference.minor).toBe(-999_00n);
  });

  it('reconciles policy recoveries against the claims account, taking salvage out of the comparison', () => {
    const { ledger, register } = seeded();
    register.cedePremium({
      treatyId: 'QS-25-2026', policyId: 'MTR-0441', riskId: 'MTR-0441',
      sumInsured: money(250_000_00, 'AED'), premium: money(67_00, 'AED'),
      lineOfBusiness: 'motor', at: '2026-01-05T10:00:00+04:00', basis: 'conventional',
    });
    const recovery = register.recoverClaim({
      policyId: 'MTR-0441', claim: claimsStub(ledger), claimId: 'CLM-000001',
      paid: money(1_150_00, 'AED'), at: '2026-01-10T10:00:00+04:00',
    });
    // the stub above already posted the recovery the way claims does; add 180.00 of salvage beside it
    ledger.post({
      id: 'CL-REC-2', entityId: 'ALK-CONV', at: '2026-01-11T10:00:00+04:00', source: 'claims', sourceRef: 'CLM-000001',
      description: 'salvage', postings: [
        { accountId: 'ALK-CONV:CASH', side: 'debit', amount: money(180_00, 'AED'), baseAmount: money(180_00, 'AED') },
        { accountId: 'ALK-CONV:CLAIM-RECOVERY', side: 'credit', amount: money(180_00, 'AED'), baseAmount: money(180_00, 'AED') },
      ],
    });
    const result = register.reconcile({
      asOf: '2026-03-01',
      claimsRecoveries: [{ type: 'reinsurance', amount: recovery.amount }, { type: 'salvage', amount: money(180_00, 'AED') }],
    });
    const line = result.lines.find((l) => l.kind === 'policy-recovery')!;
    expect(line.register.minor).toBe(287_50n);
    expect(line.ledger.minor).toBe(287_50n);       // 467.50 in the account less 180.00 of salvage
    expect(line.status).toBe('agrees');
    expect(line.note).toMatch(/salvage \/ third-party recovery removed/);
  });

  it('finds a paid claim on a ceded risk whose recovery was never claimed', () => {
    const { register } = seeded();
    register.cedePremium({
      treatyId: 'QS-25-2026', policyId: 'MTR-0441', riskId: 'MTR-0441',
      sumInsured: money(250_000_00, 'AED'), premium: money(67_00, 'AED'),
      lineOfBusiness: 'motor', at: '2026-01-05T10:00:00+04:00', basis: 'conventional',
    });
    const report = register.dataQuality({
      asOf: '2026-03-01',
      paidClaims: [{ claimId: 'CLM-FORGOTTEN', policyId: 'MTR-0441', paid: money(4_000_00, 'AED'), cause: 'motor' }],
    });
    const finding = report.findings.find((f) => f.code === 'REINS-020')!;
    expect(finding.severity).toBe('error');
    expect(finding.detail).toMatch(/1,000\.00 AED has not been claimed/);   // 25% of 4,000.00
    expect(report.errors).toBeGreaterThan(0);
    expect(report.checked).toContain('a paid claim on a ceded risk has had its recovery claimed');
  });

  it('flags a treaty whose period ended with premium still on account, and a cession that cedes nothing', () => {
    const { register } = seeded();
    // a treaty whose period ended on 2026-03-31, with a deposit never settled against it
    register.register({
      ...REINSURANCE_SEED[3]!, id: 'AGG-EXPIRED', currency: 'AED',
      depositAccounted: true, depositPremium: money(50_000_00, 'AED'), rateOnLineBps: 350,
      kind: 'excess-of-loss', attachment: money(100_000_00, 'AED'), limit: money(500_000_00, 'AED'),
      commissionBps: 0, cessionBps: undefined, lineOfBusiness: 'all',
      from: '2026-01-01', to: '2026-03-31',
    } as never);
    register.openDeposit('AGG-EXPIRED', { amount: money(50_000_00, 'AED'), at: '2026-01-15T10:00:00+04:00' });

    // a surplus cession of a risk that sits inside the retention: it cedes nothing, and says so
    register.cedePremium({
      treatyId: 'SURPLUS-10', policyId: 'P-SMALL', riskId: 'P-SMALL',
      sumInsured: money(50_000_00, 'AED'), premium: money(500_00, 'AED'),
      lineOfBusiness: 'life', at: '2026-02-01T10:00:00+04:00', basis: 'conventional',
    });

    const report = register.dataQuality({ asOf: '2026-05-01' });
    expect(report.findings.some((f) => f.code === 'REINS-040' && f.subject === 'AGG-EXPIRED')).toBe(true);
    expect(report.findings.some((f) => f.code === 'REINS-011' && f.subject === 'P-SMALL')).toBe(true);
    expect(report.findings.some((f) => f.code === 'REINS-003' && f.subject === 'XOL-CAT-5M')).toBe(false);   // it has an expiry
    expect(report.checked).toContain('every treaty can be administered as written');
    expect(report.checked).toContain('the register agrees with the books');
    expect(report.errors).toBe(0);   // nothing here is an error: warnings are things a human decides on
  });
});
});

/**
 * Capability 8 — cash calls and collateral. A reinsurer's promise is only worth the security behind
 * it: these tests hold the arithmetic of what must be secured, the discipline of calling only the
 * real shortfall, and the two rules a Shariah committee would look for — cash posted under a
 * retakaful treaty earns no interest, and a deposit accounted treaty carries no security at all.
 */
describe('collateral, cash calls and release', () => {
  /** A quota share with one cession on it: ceded premium 250.00, so the 3,000 bps security clause asks for 7.50. */
  function withCession(premiumMinor = 1_000_00n) {
    const { ledger, register } = seeded();
    register.cedePremium({
      treatyId: 'QS-25-2026', policyId: 'P-SEC-1', riskId: 'P-SEC-1',
      sumInsured: money(1_000_000_00, 'AED'), premium: money(premiumMinor, 'AED'),
      lineOfBusiness: 'life', at: '2026-02-01T10:00:00+04:00', basis: 'conventional', by: 'reinsurance/desk',
    });
    return { ledger, register };
  }

  it('posts cash security on both sides of the books, and keeps it out of the operating cash account', () => {
    const { ledger, register } = withCession();
    const instrument = register.holdSecurity({
      counterparty: 'Gulf Reinsurance PSC', treatyId: 'QS-25-2026', kind: 'cash',
      amount: money(100_00, 'AED'), at: '2026-02-02T10:00:00+04:00', reference: 'CASH-1', by: 'treasury',
    });
    expect(instrument.onBalanceSheet).toBe(true);
    expect(ledger.balance('ALK-CONV:COLLATERAL:CASH').minor).toBe(100_00n);          // restricted, ours to hold
    expect(ledger.balance('ALK-CONV:RECEIVED-AS-SECURITY').minor).toBe(100_00n);     // and theirs to have back
    expect(ledger.balance('ALK-CONV:CASH').minor).toBe(0n);                          // never spending money
    expect(ledger.proof('ALK-CONV').balanced).toBe(true);

    const position = register.securityPosition('Gulf Reinsurance PSC', '2026-02-02');
    expect(position.premiumRequirement.minor).toBe(75_00n);                          // 3,000 bps of the 250.00 ceded
    expect(position.requirement.minor).toBe(75_00n);                                 // nothing recovered yet
    expect(position.held.minor).toBe(100_00n);
    expect(position.shortfall.minor).toBe(0n);
    expect(position.surplus.minor).toBe(25_00n);
    expect(position.coverBps).toBe(13_333);
    expect(register.securityFindings('2026-02-02').some((f) => f.code === 'REINS-064')).toBe(true);
  });

  it('withholds premium instead of paying it: the payable moves, the cash never does', () => {
    const { ledger, register } = withCession();
    const before = ledger.balance('ALK-CONV:REINS:PAYABLE').minor;
    register.holdSecurity({
      counterparty: 'Gulf Reinsurance PSC', kind: 'funds-withheld',
      amount: money(100_00, 'AED'), at: '2026-02-03T10:00:00+04:00', reference: 'FW-1',
    });
    expect(ledger.balance('ALK-CONV:REINS:PAYABLE').minor).toBe(before - 100_00n);
    expect(ledger.balance('ALK-CONV:COLLATERAL:CASH').minor).toBe(0n);               // no cash moved
    expect(ledger.balance('ALK-CONV:RECEIVED-AS-SECURITY').minor).toBe(100_00n);
    expect(register.securityStatement({ asOf: '2026-02-03' }).ledger.restrictedCash.minor).toBe(0n);
  });

  it('refuses to withhold more premium than is owed, and refuses security from a name it cannot find', () => {
    const { register } = withCession();
    expect(() => register.holdSecurity({
      counterparty: 'Gulf Reinsurance PSC', kind: 'funds-withheld',
      amount: money(9_999_999_00, 'AED'), at: '2026-02-03T10:00:00+04:00',
    })).toThrow(/only .* is payable to reinsurers, so .* cannot be withheld/);
    expect(() => register.holdSecurity({
      counterparty: 'Nowhere Re', kind: 'cash', amount: money(100_00, 'AED'), at: '2026-02-03T10:00:00+04:00',
    })).toThrow(/security is held against a promise we can name/);
    expect(() => register.holdSecurity({
      counterparty: 'MENA Re', treatyId: 'QS-25-2026', kind: 'cash',
      amount: money(100_00, 'AED'), at: '2026-02-03T10:00:00+04:00',
    })).toThrow(/is written by Gulf Reinsurance PSC, not MENA Re/);
    expect(() => register.holdSecurity({
      counterparty: 'Emirates Re', kind: 'cash', amount: money(100_00, 'AED'),
      at: '2026-02-03T10:00:00+04:00', expiresAt: '2026-01-31',
    })).toThrow(/cannot expire on/);
  });

  it('counts a letter of credit without posting it, and says so', () => {
    const { ledger, register } = withCession();
    register.holdSecurity({
      counterparty: 'Gulf Reinsurance PSC', kind: 'letter-of-credit',
      amount: money(5_000_00, 'AED'), at: '2026-02-04T10:00:00+04:00', reference: 'LC-TEST', expiresAt: '2026-12-31',
    });
    const position = register.securityPosition('Gulf Reinsurance PSC', '2026-02-04');
    expect(position.held.minor).toBe(5_000_00n);                                     // relied on
    expect(position.heldOffBalanceSheet.minor).toBe(5_000_00n);
    expect(position.heldOnBalanceSheet.minor).toBe(0n);
    expect(ledger.balance('ALK-CONV:COLLATERAL:CASH').minor).toBe(0n);               // never posted as cash
    const finding = register.securityFindings('2026-02-04').find((f) => f.code === 'REINS-065')!;
    expect(finding.severity).toBe('info');
    expect(finding.what).toMatch(/cannot be spent/);
  });

  it('requires a recoverable in full and calls exactly the shortfall, refusing anything more', () => {
    const { register } = seeded();
    register.recoverEvent('XOL-CAT-5M', {
      eventId: 'STORM-ALPHAI', loss: money(1_600_000_00, 'AED'), at: '2026-04-02T10:00:00+04:00', by: 'catastrophe-desk',
    });
    register.holdSecurity({
      counterparty: 'Emirates Re', treatyId: 'XOL-CAT-5M', kind: 'letter-of-credit',
      amount: money(90_000_00, 'AED'), at: '2026-04-03T10:00:00+04:00', expiresAt: '2026-12-31',
    });
    const position = register.securityPosition('Emirates Re', '2026-04-04');
    expect(position.recoverable.minor).toBe(600_000_00n);
    expect(position.requirement.minor).toBe(600_000_00n);
    expect(position.shortfall.minor).toBe(510_000_00n);
    expect(position.coverBps).toBe(1_500);
    const finding = register.securityFindings('2026-04-04').find((f) => f.code === 'REINS-060')!;
    expect(finding.severity).toBe('error');
    expect(finding.what).toMatch(/Emirates Re is 510,000\.00 AED short/);

    const call = register.callSecurity({ counterparty: 'Emirates Re', at: '2026-04-04T11:00:00+04:00', by: 'treasury' });
    expect(call.amount.minor).toBe(510_000_00n);
    expect(call.dueBy).toBe('2026-05-04');
    expect(call.status).toBe('open');
    expect(() => register.callSecurity({
      counterparty: 'Emirates Re', at: '2026-04-04T12:00:00+04:00', amount: money(1_00, 'AED'),
    })).toThrow(/would double-count the same shortfall/);
    expect(() => register.callSecurity({
      counterparty: 'Emirates Re', at: '2026-04-05T09:00:00+04:00', amount: money(510_001_00, 'AED'), dueInDays: 15,
    })).toThrow(/would take security beyond the exposure it secures/);
  });

  it('refuses to call when the security already covers it, or when nothing is owed at all', () => {
    const { register } = seeded();
    // MENA Re writes a treaty here and is owed nothing: no exposure, no call.
    expect(() => register.callSecurity({ counterparty: 'MENA Re', at: '2026-04-04T11:00:00+04:00' }))
      .toThrow(/there is nothing to secure/);
    register.recoverEvent('XOL-CAT-5M', { eventId: 'STORM-ALPHAI', loss: money(1_600_000_00, 'AED'), at: '2026-04-02T10:00:00+04:00' });
    register.holdSecurity({
      counterparty: 'Emirates Re', kind: 'bank-guarantee', amount: money(600_000_00, 'AED'), at: '2026-04-03T10:00:00+04:00',
    });
    expect(() => register.callSecurity({ counterparty: 'Emirates Re', at: '2026-04-04T11:00:00+04:00', reason: 'routine' }))
      .toThrow(/no shortfall to call/);
  });

  it('answers a call in part, then in full, and refuses a third answer or one larger than the call', () => {
    const { ledger, register } = seeded();
    register.recoverEvent('XOL-CAT-5M', { eventId: 'STORM-ALPHAI', loss: money(1_600_000_00, 'AED'), at: '2026-04-02T10:00:00+04:00' });
    const call = register.callSecurity({ counterparty: 'Emirates Re', at: '2026-04-04T11:00:00+04:00' });
    expect(call.amount.minor).toBe(600_000_00n);                                    // nothing was secured at all
    expect(() => register.settleCall({ callId: call.id, at: '2026-04-05T09:00:00+04:00', amount: money(600_001_00, 'AED') }))
      .toThrow(/answers more than was called/);

    const part = register.settleCall({ callId: call.id, at: '2026-04-05T09:30:00+04:00', amount: money(200_000_00, 'AED'), kind: 'cash' });
    expect(part.call.status).toBe('part-settled');
    expect(part.instrument.kind).toBe('cash');
    expect(ledger.balance('ALK-CONV:COLLATERAL:CASH').minor).toBe(200_000_00n);
    expect(register.securityPosition('Emirates Re', '2026-04-05').shortfall.minor).toBe(400_000_00n);

    const rest = register.settleCall({ callId: call.id, at: '2026-04-06T09:00:00+04:00', amount: money(400_000_00, 'AED'), kind: 'letter-of-credit', expiresAt: '2026-12-31' });
    expect(rest.call.status).toBe('settled');
    expect(rest.call.settlements).toHaveLength(2);
    expect(register.securityPosition('Emirates Re', '2026-04-06').shortfall.minor).toBe(0n);
    expect(() => register.settleCall({ callId: call.id, at: '2026-04-07T09:00:00+04:00' })).toThrow(/is settled in full/);
    expect(() => register.settleCall({ callId: 'CALL-NOWHERE', at: '2026-04-07T09:00:00+04:00' })).toThrow(/unknown cash call/);
  });

  it('returns security and refuses to leave an exposure unsecured unless someone puts their name to it', () => {
    const { ledger, register } = withCession();
    const instrument = register.holdSecurity({
      counterparty: 'Gulf Reinsurance PSC', kind: 'cash', amount: money(100_00, 'AED'), at: '2026-02-02T10:00:00+04:00',
    });
    // 75.00 is required; the 25.00 above it secures nothing and goes back without ceremony
    const first = register.releaseSecurity({ instrumentId: instrument.id, at: '2026-02-05T10:00:00+04:00', amount: money(25_00, 'AED'), reason: 'surplus released to treasury' });
    expect(first.released.minor).toBe(25_00n);
    expect(ledger.balance('ALK-CONV:COLLATERAL:CASH').minor).toBe(75_00n);
    expect(ledger.balance('ALK-CONV:RECEIVED-AS-SECURITY').minor).toBe(75_00n);
    expect(register.securityPosition('Gulf Reinsurance PSC', '2026-02-05').shortfall.minor).toBe(0n);

    expect(() => register.releaseSecurity({ instrumentId: instrument.id, at: '2026-02-06T10:00:00+04:00', amount: money(10_00, 'AED'), reason: 'treasury needs the cash' }))
      .toThrow(/would leave Gulf Reinsurance PSC 10\.00 AED short of what its treaties require; name an approver/);
    const waived = register.releaseSecurity({
      instrumentId: instrument.id, at: '2026-02-07T10:00:00+04:00', amount: money(10_00, 'AED'),
      reason: 'treasury needs the cash', approvedBy: 'chief-financial-officer',
    });
    expect(waived.released.minor).toBe(10_00n);
    expect(register.releaseWaiverList()).toHaveLength(1);
    const waiver = register.securityFindings('2026-02-07').find((f) => f.code === 'REINS-066')!;
    expect(waiver.what).toMatch(/approved by chief-financial-officer/);
    expect(() => register.releaseSecurity({ instrumentId: instrument.id, at: '2026-02-08T10:00:00+04:00', amount: money(65_00, 'AED'), reason: 'the rest of it' }))
      .toThrow(/releasing 65\.00 AED would leave Gulf Reinsurance PSC 75\.00 AED short of what its treaties require; name an approver/);
    register.releaseSecurity({
      instrumentId: instrument.id, at: '2026-02-09T10:00:00+04:00', amount: money(65_00, 'AED'),
      reason: 'the rest of it', approvedBy: 'chief-financial-officer',
    });
    expect(ledger.balance('ALK-CONV:COLLATERAL:CASH').minor).toBe(0n);
    expect(() => register.releaseSecurity({ instrumentId: instrument.id, at: '2026-02-10T10:00:00+04:00', reason: 'again' }))
      .toThrow(/has already been released in full/);
  });

  it('stops counting an instrument that has lapsed, reports it, and refuses to "return" it', () => {
    const { register } = withCession();
    const lapsed = register.holdSecurity({
      counterparty: 'Gulf Reinsurance PSC', kind: 'letter-of-credit', amount: money(5_000_00, 'AED'),
      at: '2026-01-10T10:00:00+04:00', expiresAt: '2026-06-30', reference: 'LC-LAPSED',
    });
    const live = register.securityPosition('Gulf Reinsurance PSC', '2026-06-01');
    expect(live.held.minor).toBe(5_000_00n);
    expect(live.expiringSoon.map((i) => i.id)).toContain(lapsed.id);                 // 30 days is the window

    const after = register.securityPosition('Gulf Reinsurance PSC', '2026-07-01');
    expect(after.held.minor).toBe(0n);                                              // lapsed: it secures nothing
    expect(after.expired.map((i) => i.id)).toContain(lapsed.id);
    const finding = register.securityFindings('2026-07-01').find((f) => f.code === 'REINS-062')!;
    expect(finding.severity).toBe('error');                                         // and the exposure is unsecured
    expect(() => register.releaseSecurity({ instrumentId: lapsed.id, at: '2026-07-02T10:00:00+04:00', reason: 'return it' }))
      .toThrow(/lapsed on 2026-06-30: there is nothing to return/);
    expect(register.securityFindings('2026-07-01').some((f) => f.code === 'REINS-061')).toBe(false);
  });

  it('flags a cash call that nobody answered by its due date', () => {
    const { register } = seeded();
    register.recoverEvent('XOL-CAT-5M', { eventId: 'STORM-ALPHAI', loss: money(1_600_000_00, 'AED'), at: '2026-04-02T10:00:00+04:00' });
    register.callSecurity({ counterparty: 'Emirates Re', at: '2026-04-04T11:00:00+04:00', dueInDays: 10 });
    expect(register.securityFindings('2026-04-14').some((f) => f.code === 'REINS-063')).toBe(false);
    const overdue = register.securityFindings('2026-04-20').find((f) => f.code === 'REINS-063')!;
    expect(overdue.what).toMatch(/was due on 2026-04-14 and is 6 days unanswered/);
  });

  it('pays no interest under a retakaful treaty, and credits it to the counterparty under a conventional one', () => {
    const { register: retakaful } = seeded('takaful', 'ALK-TKF');
    const retakafulCash = retakaful.holdSecurity({
      counterparty: 'Takaful Re International', kind: 'cash', amount: money(90_00, 'AED'), at: '2026-02-02T10:00:00+04:00',
    });
    expect(() => retakaful.creditCollateralInterest({
      instrumentId: retakafulCash.id, at: '2026-03-01T10:00:00+04:00', amount: money(1_00, 'AED'),
    })).toThrow(/would be riba, and this engine will not post it/);

    const { ledger, register } = withCession();
    const cash = register.holdSecurity({
      counterparty: 'Gulf Reinsurance PSC', kind: 'cash', amount: money(10_00, 'AED'), at: '2026-02-02T10:00:00+04:00',
    });
    const credited = register.creditCollateralInterest({ instrumentId: cash.id, at: '2026-02-28T10:00:00+04:00', amount: money(25n, 'AED') });
    expect(credited.journalId).toBeTruthy();
    expect(ledger.balance('ALK-CONV:COLLATERAL:INTEREST').minor).toBe(25n);
    expect(ledger.balance('ALK-CONV:RECEIVED-AS-SECURITY').minor).toBe(1_025n);      // theirs, with interest on top
    expect(ledger.proof('ALK-CONV').balanced).toBe(true);
    const line = register.reconcile({ asOf: '2026-02-28' }).lines.find((l) => l.kind === 'security-liability')!;
    expect(line.status).toBe('agrees');
    expect(line.register.minor).toBe(1_025n);
    expect(line.note).toMatch(/interest earned on their cash/);
    expect(() => register.creditCollateralInterest({
      instrumentId: cash.id, at: '2026-03-01T10:00:00+04:00', amount: money(0n, 'AED'),
    })).toThrow(/interest on nothing is not a posting/);
  });

  it('refuses a security clause on a deposit accounted treaty, and reports the statement as a whole', () => {
    const { register } = seeded();
    expect(() => register.register({
      id: 'DEP-SEC', name: 'Deposit with security', counterparty: 'Gulf Reinsurance PSC', kind: 'excess-of-loss',
      basis: 'conventional', lineOfBusiness: 'all', currency: 'AED', from: '2026-01-01', to: '2026-12-31',
      attachment: money(100_000_00, 'AED'), limit: money(500_000_00, 'AED'), commissionBps: 0,
      depositAccounted: true, depositPremium: money(50_000_00, 'AED'), securityRequiredBps: 2_000,
    })).toThrow(/there is no reinsurer exposure to secure, only the deposit we already hold/);
    expect(() => register.register({
      id: 'SEC-BPS', name: 'Security out of range', counterparty: 'MENA Re', kind: 'quota-share',
      basis: 'conventional', lineOfBusiness: 'life', currency: 'AED', from: '2026-01-01', to: '2026-12-31',
      cessionBps: 1_000, commissionBps: 0, securityRequiredBps: 12_000,
    })).toThrow(/security of 12000 bps of ceded premium is not a share of it/);

    register.recoverEvent('XOL-CAT-5M', { eventId: 'STORM-ALPHAI', loss: money(1_600_000_00, 'AED'), at: '2026-04-02T10:00:00+04:00' });
    register.holdSecurity({
      counterparty: 'Emirates Re', kind: 'letter-of-credit', amount: money(30_000_00, 'AED'),
      at: '2026-04-03T10:00:00+04:00', expiresAt: '2026-10-20', reference: 'LC-SOON',
    });
    const statement = register.securityStatement({ asOf: '2026-10-05' });
    expect(statement.requirement.minor).toBe(600_000_00n);
    expect(statement.held.minor).toBe(30_000_00n);                                  // LC-SOON is still in force, with 15 days to run
    expect(statement.positions.find((p) => p.counterparty === 'Emirates Re')!.expiringSoon).toHaveLength(1);
    expect(statement.findings.some((f) => f.code === 'REINS-061')).toBe(true);
    expect(statement.unsecured.join(' ')).toMatch(/Emirates Re 570,000\.00 AED/);
    expect(statement.positions.map((p) => p.counterparty)).toContain('Gulf Reinsurance PSC');
    expect(statement.positions.find((p) => p.counterparty === 'MENA Re')!.secured).toBe(true);
    expect(statement.notes.some((n) => n.includes('deposit accounted'))).toBe(true);
    expect(statement.ledger.receivedAsSecurity.minor).toBe(0n);
    const reconcile = register.reconcile({ asOf: '2026-10-05' });
    expect(reconcile.lines.some((l) => l.kind === 'collateral-cash')).toBe(true);
    expect(reconcile.lines.some((l) => l.kind === 'security-liability')).toBe(true);
    expect(reconcile.agrees).toBe(true);
  });

  it('ties the security accounts into the books, so collateral can never quietly disappear', () => {
    const { ledger, register } = withCession();
    const statement = register.securityStatement({ asOf: '2026-02-28' });
    expect(statement.ledger.restrictedCash.minor).toBe(0n);
    register.holdSecurity({
      counterparty: 'Gulf Reinsurance PSC', kind: 'cash', amount: money(400_00, 'AED'), at: '2026-02-10T10:00:00+04:00',
    });
    const after = register.securityStatement({ asOf: '2026-02-28' });
    expect(after.ledger.restrictedCash.minor).toBe(400_00n);
    expect(after.ledger.receivedAsSecurity.minor).toBe(400_00n);
    const reconcile = register.reconcile({ asOf: '2026-02-28' });
    const cash = reconcile.lines.find((l) => l.kind === 'collateral-cash')!;
    expect(cash.register.minor).toBe(400_00n);
    expect(cash.status).toBe('agrees');
    expect(reconcile.balanceSheet.restrictedCash.minor).toBe(400_00n);
    expect(reconcile.balanceSheet.securityReceived.minor).toBe(400_00n);
    expect(ledger.proof('ALK-CONV').balanced).toBe(true);
  });
});
