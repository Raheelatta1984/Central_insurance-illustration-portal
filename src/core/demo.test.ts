/**
 * The demo world is not a fixture: it is the app's live state, so it gets asserted like code.
 * These tests guard the journeys the console shows and the numbers the API returns.
 */
import { describe, expect, it } from 'vitest';
import { buildWorld, claimsSnapshot, groupSnapshot, reinsuranceSnapshot, underwritingSnapshot, worldSnapshot } from './demo.js';
import { money } from './money.js';
import { AE_PACK } from './regulatory.js';

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
    expect(motor.recoveries).toHaveLength(2);
    expect(motor.recoveries[0]!.type).toBe('salvage');
    // The second recovery is the quota share's: the reinsurer carries the same quarter of the claim.
    expect(motor.recoveries[1]!.type).toBe('reinsurance');
    expect(motor.recoveries[1]!.amount.minor).toBe(287_50n);
    expect(w.claims.netCost(motor.id).minor).toBe(682_50n);

    // The AI approved the small critical-illness line within its straight-through limit.
    const ci = claims[1]!;
    expect(ci.decisions.at(-1)?.isAi).toBe(true);
    expect(ci.decisions.at(-1)?.rationale).toMatch(/ai-straight-through limit/);
    expect(w.claims.approvedAmount(ci.id)?.minor).toBe(400_00n);

    const position = w.claims.position();
    expect(position.paidCash.minor).toBe(1150_00n);          // cash actually paid to the claimant
    expect(position.expenseIncurred.minor).toBe(16150_00n);  // settlement plus the reserve still standing
    expect(position.reserved.minor).toBe(15000_00n);         // the open case's liability
    expect(position.recovered.minor).toBe(467_50n);   // salvage 180.00 + the reinsurer's 287.50
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

describe('group finance in the demo world', () => {
  it('consolidates three entities in two currencies into one balanced group balance sheet', () => {
    const w = buildWorld();
    const report = w.group.consolidate({ asOf: w.asOf, periodStart: w.groupPeriodStart });
    expect(report.entities.map((e) => e.entityId)).toEqual(['ALK-CONV', 'ALK-TKF', 'ALK-MY']);
    expect(report.group.balanced).toBe(true);
    expect(report.group.difference.minor).toBe(0n);
    expect(report.group.totals.translationReserve.minor).not.toBe(0n);   // the ringgit entity creates one
    expect(w.ledger.proof('GRP').balanced).toBe(true);
    expect(report.group.checks.every((c) => c.check !== 'consolidated balance sheet balances' || c.ok)).toBe(true);
  });

  it('funds every entity with paid-up capital, so the group balance sheet looks like an insurer', () => {
    const w = buildWorld();
    const report = w.group.consolidate({ asOf: w.asOf, periodStart: w.groupPeriodStart });
    for (const e of report.entities) {
      expect(e.netAssets.minor).toBeGreaterThan(0n);
      expect(e.lines.find((l) => l.accountId.endsWith('SHARE-CAPITAL'))?.amount.minor ?? 0n).toBeGreaterThan(0n);
    }
    // Equity in the Malaysian book is translated at the historical rate, not the closing one.
    const malaysia = report.entities.find((e) => e.entityId === 'ALK-MY')!;
    expect(malaysia.lines.find((l) => l.accountId === 'ALK-MY:SHARE-CAPITAL')?.rateBasis).toBe('historical');
    expect(malaysia.cta.minor).not.toBe(0n);
  });

  it('states the 30% minority share of the Malaysian subsidiary', () => {
    const w = buildWorld();
    const report = w.group.consolidate({ asOf: w.asOf, periodStart: w.groupPeriodStart });
    const nci = report.nci.find((n) => n.entityId === 'ALK-MY')!;
    expect(nci.minorityPct).toBe(30);
    const malaysia = report.entities.find((e) => e.entityId === 'ALK-MY')!;
    expect(nci.shareOfNetAssets.minor).toBe((malaysia.netAssets.minor * 30n) / 100n);
    expect(report.group.attribution.minority.minor).toBe(nci.shareOfNetAssets.minor);
  });

  it('shows an intercompany balance that agrees and one that does not', () => {
    const w = buildWorld();
    const report = w.group.consolidate({ asOf: w.asOf, periodStart: w.groupPeriodStart });
    const withTakaful = report.intercompany.balances.find((b) => b.payableEntity === 'ALK-TKF')!;
    expect(withTakaful.difference.minor).toBe(0n);
    expect(withTakaful.eliminated.minor).toBe(2_500_00n);

    const withMalaysia = report.intercompany.balances.find((b) => b.payableEntity === 'ALK-MY')!;
    // The payable (MYR 20,000 at closing) is larger than the receivable (AED 4,600), so the
    // difference is negative; the in-transit figure is the absolute value.
    expect(withMalaysia.difference.minor).toBeLessThan(0n);
    expect(report.eliminations.inTransit.minor).toBe(-withMalaysia.difference.minor);
    expect(report.eliminations.notes.some((n) => n.includes('in transit'))).toBe(true);
  });

  it('leaves the entity books exactly as they were', () => {
    const w = buildWorld();
    const before = {
      conv: w.ledger.entriesFor(w.conventionalEntity).length,
      tkf: w.ledger.entriesFor(w.takafulEntity).length,
      my: w.ledger.entriesFor(w.malaysiaEntity).length,
      cash: w.ledger.balance(`${w.malaysiaEntity}:CASH`).minor,
    };
    w.group.consolidate({ asOf: w.asOf, periodStart: w.groupPeriodStart });
    expect(w.ledger.entriesFor(w.conventionalEntity).length).toBe(before.conv);
    expect(w.ledger.entriesFor(w.takafulEntity).length).toBe(before.tkf);
    expect(w.ledger.entriesFor(w.malaysiaEntity).length).toBe(before.my);
    expect(w.ledger.balance(`${w.malaysiaEntity}:CASH`).minor).toBe(before.cash);
  });

  it('renders the group panel inside the console snapshot', () => {
    const snapshot = worldSnapshot(buildWorld());
    expect(snapshot.group.entities).toHaveLength(3);
    expect(snapshot.group.group.balanced).toBe(true);
    expect(snapshot.group.group.trialBalance.length).toBeGreaterThan(3);
    expect(snapshot.group.nci[0]!.shareOfNetAssets).toMatch(/AED/);
    expect(snapshot.group.eliminations.notes.length).toBeGreaterThan(0);
  });
});

describe('the console can render every view the API serves', () => {
  it('underwriting: the fields the Underwriting tab reads are all present', () => {
    const w = buildWorld();
    const view = underwritingSnapshot(w.underwriting, w.asOf);
    // Regression: the API once served a narrower shape, and the console crashed on view.share.
    for (const key of ['book', 'queue', 'cession', 'share', 'exposure', 'applications', 'asOf']) {
      expect(Object.keys(view), `underwriting.${key}`).toContain(key);
    }
    expect(view.share.length).toBeGreaterThan(0);
    expect(view.share[0]!.cededLabel).toMatch(/AED/);
    expect(view.book).toMatchObject({ policies: expect.any(Number), standard: expect.any(String) });
  });

  it('claims: the fields the Claims tab reads are all present, for both books', () => {
    const w = buildWorld();
    for (const view of [claimsSnapshot(w.claims, w.asOf), claimsSnapshot(w.takafulClaims, w.asOf)]) {
      for (const key of ['position', 'authority', 'overdue', 'list']) expect(Object.keys(view)).toContain(key);
      for (const key of ['reserved', 'expenseIncurred', 'paidCash', 'recovered', 'netCost', 'openClaims']) {
        expect(Object.keys(view.position)).toContain(key);
      }
      for (const claim of view.list) {
        for (const key of ['id', 'status', 'reserve', 'paid', 'netCost', 'approved', 'decisions', 'recoveries']) {
          expect(Object.keys(claim), `claim.${key}`).toContain(key);
        }
      }
      for (const role of view.authority) expect(Object.keys(role)).toEqual(expect.arrayContaining(['role', 'limit', 'limitMinor', 'isAi']));
    }
  });

  it('group: the fields the Group finance tab reads are all present', () => {
    const view = groupSnapshot(buildWorld(), false);
    for (const key of ['entities', 'intercompany', 'nci', 'eliminations', 'group']) expect(Object.keys(view)).toContain(key);
    for (const key of ['totals', 'netAssets', 'balanced', 'difference', 'checks', 'attribution', 'trialBalance']) {
      expect(Object.keys(view.group), `group.${key}`).toContain(key);
    }
  });

  it('a switch taken after the cut-off still prices, on the latest published valuation, and says so', () => {
    const w = buildWorld();
    // 16:10 is past the 15:00 cut-off, so the instruction rolls into the next business day — whose
    // valuation is not struck yet. The preview must answer with the latest published price and be
    // honest about it, instead of failing in the customer's face.
    const preview = w.decider.previewSwitch({
      policyId: 'UL-000123', fromFundId: 'FGLOBAL', toFundId: 'FBAL',
      amount: money(5000_00, 'AED'), instructionAt: '2026-10-05T16:10:00+04:00',
      disclaimer: AE_PACK.illustration.wording,
    });
    expect(preview.from.valuationDate).toBe('2026-10-06');
    expect(preview.blocked.join(' ')).toMatch(/2026-10-06 valuation is not published yet/);
    expect(preview.blocked.join(' ')).toMatch(/priced on the 2026-10-05 valuation/);
    expect(Number(preview.from.price)).toBeGreaterThan(0);
    expect(preview.fee.minor).toBeGreaterThan(0n);
    // and the same for a withdrawal instruction taken inside the dealing day
    const withdrawal = w.decider.previewWithdrawal({
      policyId: 'UL-000123', fundId: 'FBAL', amount: money(1500_00, 'AED'),
      instructionAt: '2026-10-05T16:10:00+04:00', disclaimer: AE_PACK.illustration.wording,
    });
    expect(withdrawal.blocked.join(' ')).toMatch(/not published yet/);
    expect(Number(withdrawal.price)).toBeGreaterThan(0);
  });

  it('a fund with no published valuation at all is still a hard failure, not a made-up price', () => {
    const w = buildWorld();
    expect(() => w.decider.previewWithdrawal({
      policyId: 'UL-000123', fundId: 'TKF-EQ', amount: money(100_00, 'AED'),
      instructionAt: '2015-01-01T11:00:00+04:00', disclaimer: AE_PACK.illustration.wording,
    })).toThrow(/no published valuation/);
  });

  it('cedes premium to the treaties and shows it in the books, not just in a register', () => {
    const w = buildWorld();
    const view = reinsuranceSnapshot(w);
    const conv = view.conventional;
    expect(conv.grossPremium).toBe('16,778.50 AED');
    expect(conv.cededPremium).toBe('3,819.63 AED');
    expect(conv.netRetainedPremium).toBe('13,456.81 AED');
    expect(conv.commissionIncome).toBe('497.94 AED');
    expect(conv.cessionPct).toBe(22.76);

    // The quota share took a quarter of the rated life case and of the pay-as-you-drive motor risk.
    const quota = conv.treaties.find((t) => t.treatyId === 'QS-25-2026')!;
    expect(quota.risks).toBe(2);
    expect(quota.premiumCeded).toBe('2,319.63 AED');
    expect(quota.commissionEarned).toBe('347.94 AED');
    // The surplus treaty retained the first 200,000 and ceded one line of the case above it.
    const surplus = conv.treaties.find((t) => t.treatyId === 'SURPLUS-10')!;
    expect(surplus.cededSumInsured).toBe('50,000.00 AED');
    expect(surplus.capacity).toBe('2,000,000.00 AED');
    expect(surplus.headroom).toBe('1,950,000.00 AED');
    expect(surplus.usedPct).toBe(2.5);
    expect(surplus.premiumCeded).toBe('1,500.00 AED');
    // Catastrophe cover is bought but not yet used: it must still be on the statement, in force.
    const xol = conv.treaties.find((t) => t.treatyId === 'XOL-CAT-5M')!;
    expect(xol.risks).toBe(0);
    expect(xol.headroom).toBe('5,000,000.00 AED');
    expect(xol.valid).toBe(true);
    // Nothing is ceded to the facultative treaty until a named risk is accepted in writing.
    const facultative = conv.treaties.find((t) => t.treatyId === 'FAC-MOTOR')!;
    expect(facultative.risks).toBe(0);
    expect(view.accepted).toEqual([]);
    expect(view.facultativeRefusal).toMatch(/retained in full until the reinsurer says yes in writing/);
  });

  it('keeps the takaful window apart: its own retakaful treaty, its own fund, its own refusal', () => {
    const w = buildWorld();
    const view = reinsuranceSnapshot(w);
    expect(view.takaful.treaties.map((t) => t.treatyId)).toEqual(['RTKF-QS-20']);
    expect(view.takaful.cededPremium).toBe('360.00 AED');       // 20% of the 1,800.00 tabarru
    expect(view.takaful.commissionIncome).toBe('72.00 AED');    // the operator's 20% wakalah fee
    expect(view.segregationRefusal).toMatch(/participant risk money may not be ceded to it/);
    // The retakaful journal belongs to the participant risk fund, and the ledger says so.
    const entry = w.ledger.entriesFor('ALK-TKF').find((e) => e.source === 'reinsurance')!;
    expect(entry.fundId).toBe('PRF');
    expect(entry.entityId).toBe('ALK-TKF');
  });

  it('the reinsurer’s share of the claim is receivable, and the recoverable on the statement agrees with the ledger', () => {
    const w = buildWorld();
    const view = reinsuranceSnapshot(w);
    expect(view.recoveries).toHaveLength(1);
    expect(view.recoveries[0]!.amount).toBe('287.50 AED');
    expect(view.conventional.recoveries).toBe('287.50 AED');
    // Commission due plus recoveries due: the account a finance team reconciles against.
    expect(w.ledger.balance('ALK-CONV:REINS:RECEIVABLE').minor).toBe(785_44n);
    expect(w.ledger.balance('ALK-CONV:REINS:CEDED-PREMIUM').minor).toBe(3_819_63n);
    expect(w.ledger.balance('ALK-CONV:REINS:COMMISSION').minor).toBe(497_94n);
    expect(view.conventional.recoverable).toBe('785.44 AED');
  });

  it('reinsurance: the fields the Reinsurance tab reads are all present, for both books', () => {
    const view = reinsuranceSnapshot(buildWorld());
    for (const key of ['conventional', 'takaful', 'schedule', 'accepted', 'recoveries', 'facultativeRefusal', 'segregationRefusal']) {
      expect(Object.keys(view)).toContain(key);
    }
    for (const book of [view.conventional, view.takaful]) {
      for (const key of ['grossPremium', 'cededPremium', 'netRetainedPremium', 'cessionPct', 'commissionIncome', 'recoveries', 'recoverable', 'treaties']) {
        expect(Object.keys(book), `book.${key}`).toContain(key);
      }
      for (const treaty of book.treaties) {
        for (const key of ['treatyId', 'name', 'counterparty', 'kind', 'capacity', 'cededSumInsured', 'headroom', 'usedPct', 'premiumCeded', 'commissionEarned', 'valid']) {
          expect(Object.keys(treaty), `treaty.${key}`).toContain(key);
        }
      }
    }
    for (const c of view.schedule) {
      for (const key of ['policyId', 'treatyId', 'sharePct', 'premium', 'cededPremium', 'commission', 'netRetained', 'journalId']) {
        expect(Object.keys(c), `cession.${key}`).toContain(key);
      }
    }
  });
});
