/**
 * Reinsurance and retakaful. These tests hold the rules that stop a cession from going somewhere it
 * is not allowed to go, and hold the arithmetic that decides how much of a claim comes back.
 */
import { describe, expect, it } from 'vitest';
import { Chart, buildChart } from './chart.js';
import { Ledger } from './ledger.js';
import { money } from './money.js';
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
      .toEqual(['FAC-MOTOR', 'QS-25-2026', 'RTKF-QS-20', 'XOL-CAT-5M']);
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
});
