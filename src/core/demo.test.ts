/**
 * The demo world is not a fixture: it is the app's live state, so it gets asserted like code.
 * These tests guard the journeys the console shows and the numbers the API returns.
 */
import { describe, expect, it } from 'vitest';
import { buildWorld, worldSnapshot } from './demo.js';
import { money } from './money.js';

describe('demo world', () => {
  it('builds a balanced two-entity book with a takaful window', () => {
    const w = buildWorld();
    expect(w.entities.map((e) => e.id)).toEqual(['ALK-CONV', 'ALK-TKF']);
    expect(w.ledger.proof(w.conventionalEntity).balanced).toBe(true);
    expect(w.ledger.proof(w.takafulEntity).balanced).toBe(true);
  });

  it('shows the conventional claim journey end to end, with a recovery and a live approval', () => {
    const w = buildWorld();
    const claims = w.claims.list();
    expect(claims.map((c) => c.status)).toEqual(['settled', 'approved']);

    const motor = claims[0]!;
    expect(motor.paid.minor).toBe(1150_00n);
    expect(motor.recoveries).toHaveLength(1);
    expect(motor.recoveries[0]!.type).toBe('salvage');
    expect(w.claims.netCost(motor.id).minor).toBe(970_00n);

    // The AI approved the small critical-illness line within its straight-through limit.
    const ci = claims[1]!;
    expect(ci.decisions.at(-1)?.isAi).toBe(true);
    expect(ci.decisions.at(-1)?.rationale).toMatch(/ai-straight-through limit/);
    expect(w.claims.approvedAmount(ci.id)?.minor).toBe(400_00n);

    const position = w.claims.position();
    expect(position.paidCash.minor).toBe(1150_00n);          // cash actually paid to the claimant
    expect(position.expenseIncurred.minor).toBe(16150_00n);  // settlement plus the reserve still standing
    expect(position.reserved.minor).toBe(15000_00n);         // the open case's liability
    expect(position.recovered.minor).toBe(180_00n);
    expect(position.openClaims).toBe(1);
  });

  it('pays the takaful claim from the participants risk fund, not from operator cash', () => {
    const w = buildWorld();
    const claim = w.takafulClaims.list()[0]!;
    expect(claim.status).toBe('settled');
    expect(claim.fundId).toBe('PRF');
    expect(claim.decisions.at(-1)?.rationale).toMatch(/from the PRF pool/);
    expect(w.takaful.balance('PRF').minor).toBe(300_00n);  // 700.00 less the 400.00 pool claim
    expect(w.ledger.proof(w.takafulEntity).balanced).toBe(true);
  });

  it('exposes a snapshot the console can render without asking for anything else', () => {
    const snapshot = worldSnapshot(buildWorld());
    expect(snapshot.claims.list).toHaveLength(2);
    expect(snapshot.claims.position.netCost).toMatch(/AED/);
    expect(snapshot.claims.authority.find((a) => a.role === 'ai-straight-through')?.limit).toMatch(/1,000.00/);
    expect(snapshot.claims.overdue.map((c) => c.id)).toEqual([snapshot.claims.list[1]!.id]);
    expect(snapshot.takafulClaims.list[0]!.fundId).toBe('PRF');
    expect(snapshot.ledger.proof.balanced).toBe(true);
    expect(snapshot.policy.reproduce.ok).toBe(true);
    expect(snapshot.cover.segments.length).toBeGreaterThan(0);
    expect(snapshot.takaful.proposal.blockers.length).toBeGreaterThan(0);
  });

  it('refuses, in the live world, an AI approval above its straight-through limit', () => {
    const w = buildWorld();
    const claim = w.claims.register({ policyId: 'UL-000123', cause: 'death', lossDate: '2026-09-30', reportedAt: '2026-10-01', description: 'Death benefit' });
    w.claims.triage(claim.id, { coverInForce: true, exclusionsApplied: [], daysLate: 1, fraudSignals: 0 });
    expect(() => w.claims.approve(claim.id, {
      amount: { minor: 250_000_00n, currency: 'AED' }, at: '2026-10-05T09:00:00+04:00', by: 'agent/claims-triage', role: 'ai-straight-through',
    })).toThrow(/needs a human authority/);
    expect(() => w.claims.approve(claim.id, {
      amount: { minor: 250_000_00n, currency: 'AED' }, at: '2026-10-05T09:00:00+04:00', by: 'Chief Claims Officer', role: 'chief-claims-officer',
    })).not.toThrow();
    expect(w.claims.claim(claim.id).status).toBe('approved');
  });
});

describe('underwriting in the demo world', () => {
  it('shows a clean acceptance, a rated life, a case waiting on a human and an AI acceptance inside its limit', () => {
    const w = buildWorld();
    const apps = w.underwriting.list();
    expect(apps).toHaveLength(4);
    const [clean, rated, referral, ai] = apps;

    expect(clean!.decision?.outcome).toBe('standard');
    expect(rated!.decision?.outcome).toBe('rated');
    expect(rated!.decision?.extraMortalityBps).toBe(100 + 75 + 60);   // smoker, type 2 diabetes, non-standard occupation class
    expect(referral!.decision).toBeUndefined();
    expect(ai!.decision?.decidedByAi).toBe(true);
    expect(ai!.decision?.outcome).toBe('standard');

    const queue = w.underwriting.queue();
    expect(queue.map((q) => q.applicationId)).toEqual([referral!.id]);
    expect(queue[0]!.waitingOn).toEqual(expect.arrayContaining(['senior-underwriter', 'reinsurance-desk']));
    expect(queue[0]!.reasonCodes).toContain('reinsurance-facultative');
  });

  it('prices the accepted book and shows the reinsurer what it carries', () => {
    const w = buildWorld();
    const book = w.underwriting.bookPremium();
    expect(book.policies).toBe(3);
    expect(book.standard.minor).toBe(750_000n + 900_000n + 360_000n);   // 250k, 300k and 120k at 30.00 per 1,000
    expect(book.loaded.minor).toBe(750_000n + 921_150n + 360_000n);   // the rated life carries 235bps
    const share = w.underwriting.reinsuranceShare(2_500);
    expect(share).toHaveLength(1);
    // The reinsurer shares sum assured, not premium: 25% of 670,000.00 across the three accepted lives.
    expect(share[0]!.ceded.minor).toBe(167_500_00n);
    expect(share[0]!.retained.minor).toBe(502_500_00n);
    const exposures = ['PTY-0001', 'PTY-0003'].map((p) => w.underwriting.aggregateExposure(p));
    expect(exposures[0]!.totalSumAssured.minor).toBe(250_000_00n);
    expect(exposures[1]!.policies).toBe(0);
  });

  it('refuses an AI decline and refers it to a named human, live', () => {
    const w = buildWorld();
    const doomed = w.underwriting.register({
      partyId: 'PTY-0009', productId: 'PROD-LIFE-TERM', sumAssured: money(200_000_00n, 'AED'), at: '2026-10-05',
      profile: { partyId: 'PTY-0009', age: 38, sex: 'male', smoker: false, heightCm: 178, weightKg: 78, occupationClass: 1, pursuits: [], conditions: [], familyHistory: [], residenceCountry: 'XX', annualIncome: money(30_000_00n, 'AED') },
    });
    const decision = w.underwriting.decide(doomed.id, { at: '2026-10-05', by: 'agent/quote-bot', isAi: true });
    expect(decision.outcome).toBe('referred');
    expect(decision.reasons.find((r) => r.code === 'ai-authority')?.detail).toMatch(/no cover is issued on an AI decision/);
  });

  it('renders the underwriting panel inside the console snapshot', () => {
    const snapshot = worldSnapshot(buildWorld());
    expect(snapshot.underwriting.applications).toHaveLength(4);
    expect(snapshot.underwriting.book.standard).toMatch(/AED/);
    expect(snapshot.underwriting.queue[0]!.waitingOn).toContain('reinsurance-desk');
    expect(snapshot.underwriting.exposure.find((e) => e.partyId === 'PTY-0001')?.totalSumAssured).toMatch(/250,000.00/);
  });
});
