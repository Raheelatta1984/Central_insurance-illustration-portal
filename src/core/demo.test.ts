/**
 * The demo world is not a fixture: it is the app's live state, so it gets asserted like code.
 * These tests guard the journeys the console shows and the numbers the API returns.
 */
import { describe, expect, it } from 'vitest';
import { buildWorld, claimsSnapshot, extractSnapshot, groupSnapshot, reinsuranceSnapshot, uaeRuleSnapshot, underwritingSnapshot, wordingSnapshot, worldSnapshot } from './demo.js';
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
    expect(view.recoveries).toHaveLength(2);              // the policy recovery and the catastrophe one
    const policy = view.recoveries.find((r) => r.source === 'policy')!;
    const storm = view.recoveries.find((r) => r.source === 'event')!;
    expect(policy.amount).toBe('287.50 AED');
    expect(policy.outstanding).toBe('287.50 AED');
    expect(storm.amount).toBe('600,000.00 AED');
    expect(storm.settled).toBe('450,000.00 AED');         // Emirates Re has paid most of it
    expect(storm.outstanding).toBe('150,000.00 AED');
    // One policy recovery and one catastrophe recovery, both from Emirates Re.
    expect(view.events).toHaveLength(1);
    expect(view.events[0]!.eventId).toBe('STORM-ALPHAI');
    expect(view.events[0]!.amount).toBe('600,000.00 AED');
    expect(view.conventional.recoveries).toBe('600,287.50 AED');
    // Commission due plus recoveries due: the account a finance team reconciles against.
    expect(w.ledger.balance('ALK-CONV:REINS:RECEIVABLE').minor).toBe(150_785_44n);   // 450,000 has been collected
    // Ceded premium is the cessions only: the deposit-accounted instalments are an asset, not an expense.
    expect(w.ledger.balance('ALK-CONV:REINS:CEDED-PREMIUM').minor).toBe(3_819_63n);
    expect(w.ledger.balance('ALK-CONV:REINS:COMMISSION').minor).toBe(497_94n);
    // The recoverable is what is still owed: the 450,000 Emirates Re has already paid is out of it.
    expect(view.conventional.recoverable).toBe('150,785.44 AED');
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

  it('a catastrophe is recovered from the layer, the cover is reinstated, and both are on the record', () => {
    const w = buildWorld();
    const view = reinsuranceSnapshot(w);
    const xol = view.conventional.treaties.find((t) => t.treatyId === 'XOL-CAT-5M')!;
    expect(xol.kind).toBe('excess-of-loss');
    expect(xol.limit).toBe('5,000,000.00 AED');
    expect(xol.consumed).toBe('0.00 AED');       // 600,000 was paid, then reinstated
    expect(xol.available).toBe('5,000,000.00 AED');
    expect(xol.reinstatementsUsed).toBe(1);
    expect(xol.reinstatementsLeft).toBe(1);
    expect(xol.exhausted).toBe(false);

    const first = view.conventional.reinstatements[0]!;
    expect(first.sequence).toBe(1);
    expect(first.free).toBe(true);               // the first reinstatement is free
    expect(first.premium).toBe('0.00 AED');
    expect(first.restored).toBe('600,000.00 AED');
    expect(first.journalId).toBeNull();          // nothing to post for a free reinstatement, and it says so
    expect(w.ledger.balance('ALK-CONV:REINS:RECOVERY').minor).toBe(600_000_00n);
  });

  it('the deposit-accounted treaty keeps its premium off the profit and loss account until it settles', () => {
    const w = buildWorld();
    const view = reinsuranceSnapshot(w);
    const account = view.conventional.deposits.find((d) => d.treatyId === 'AGG-SL-DEPOSIT')!;
    expect(account.treatment).toBe('deposit');
    expect(account.depositPaid).toBe('300,000.00 AED');         // two instalments on account
    expect(account.technicalPremium).toBeNull();               // the period is not settled yet: the console does that
    expect(account.settled).toBe(false);
    expect(account.assetRemaining).toBe('300,000.00 AED');      // an asset, still on the balance sheet
    expect(account.adjustments.at(-1)?.kind).toBe('additional');
    expect(account.adjustments.at(-1)?.amount).toBe('100,000.00 AED');
    // and nothing of that money has been recognised as premium expense
    expect(w.ledger.balance('ALK-CONV:REINS:CEDED-PREMIUM').minor).toBe(3_819_63n);
    // The treaty says which accounting it gets, and the two treatments are visibly different.
    const treatments = view.conventional.treaties.map((t) => t.treatment);
    expect(treatments).toContain('deposit');
    expect(treatments).toContain('risk-transferring');
  });

  it('reinsurance: the cover, reinstatement and deposit fields the console reads are all present', () => {
    const view = reinsuranceSnapshot(buildWorld());
    for (const book of [view.conventional, view.takaful]) {
      for (const treaty of book.treaties) {
        for (const key of ['limit', 'consumed', 'available', 'exhausted', 'treatment', 'reinstatementsUsed', 'reinstatementsLeft']) {
          expect(Object.keys(treaty), `treaty.${key}`).toContain(key);
        }
      }
      for (const r of book.reinstatements) {
        for (const key of ['treatyId', 'sequence', 'restored', 'premium', 'free', 'at', 'available', 'journalId']) {
          expect(Object.keys(r), `reinstatement.${key}`).toContain(key);
        }
      }
      for (const d of book.deposits) {
        for (const key of ['treatyId', 'depositPaid', 'technicalPremium', 'settled', 'treatment', 'assetRemaining', 'adjustments']) {
          expect(Object.keys(d), `deposit.${key}`).toContain(key);
        }
      }
    }
    for (const e of view.events) for (const key of ['eventId', 'treatyId', 'amount', 'at', 'journalId']) expect(Object.keys(e)).toContain(key);
  });

  it('ages what reinsurers still owe, against each treaty’s own terms, and flags what is late', () => {
    const w = buildWorld();
    const view = reinsuranceSnapshot(w);
    expect(view.ageing.outstanding).toBe('150,287.50 AED');
    expect(view.ageing.overdue).toBe('150,000.00 AED');       // only the catastrophe recovery is late
    expect(view.ageing.oldestDays).toBe(20);
    expect(view.ageing.worstOverdue).toEqual(['XOL-CAT-5M (6d)']);
    expect(view.ageing.buckets.find((b) => b.bucket === '0-30')!.count).toBe(2);

    const storm = view.ageing.items.find((i) => i.claimId === 'STORM-ALPHAI')!;
    expect(storm.expectedBy).toBe('2026-09-29');              // 14-day terms, not the 60-day default
    expect(storm.overdueDays).toBe(6);
    expect(storm.bucket).toBe('0-30');
    const policy = view.ageing.items.find((i) => i.claimId === 'CLM-000001')!;
    expect(policy.overdueDays).toBe(0);                        // 60-day terms on the quota share
    expect(policy.expectedBy).toBe('2026-12-01');
  });

  it('ties the register to the books line by line, and runs the controls that hunt for unclaimed money', () => {
    const w = buildWorld();
    const view = reinsuranceSnapshot(w);
    expect(view.reconciliation.agrees).toBe(true);
    expect(view.reconciliation.differences).toBe(0);
    for (const line of view.reconciliation.lines) {
      expect(line.status, `${line.kind}: register ${line.register} vs books ${line.ledger}`).toBe('agrees');
    }
    expect(view.reconciliation.lines.find((l) => l.kind === 'receivable')!.register).toBe('150,785.44 AED');
    expect(view.reconciliation.balanceSheet.depositAsset).toBe('300,000.00 AED');
    // Security is money we hold and owe back, and the books carry both halves of it.
    expect(view.reconciliation.balanceSheet.restrictedCash).toBe('10,000.00 AED');
    expect(view.reconciliation.balanceSheet.securityReceived).toBe('11,500.00 AED');
    expect(view.reconciliation.lines.find((l) => l.kind === 'collateral-cash')!.register).toBe('10,000.00 AED');
    expect(view.reconciliation.lines.find((l) => l.kind === 'security-liability')!.register).toBe('11,500.00 AED');
    expect(view.reconciliation.lines).toHaveLength(8);

    // The catastrophe recovery is 6 days past its terms: a warning a human decides on, not an error.
    // The one error is the security shortfall, which is a fact rather than a judgement.
    expect(view.reconciliation.quality.errors).toBe(1);
    expect(view.reconciliation.quality.warnings).toBe(3);
    const late = view.reconciliation.quality.findings.find((f) => f.code === 'REINS-030')!;
    expect(late.detail).toMatch(/150,000\.00 AED from XOL-CAT-5M is 6 days past the settlement terms/);
    const short = view.reconciliation.quality.findings.find((f) => f.code === 'REINS-060')!;
    expect(short.severity).toBe('error');
    expect(short.detail).toMatch(/Emirates Re is 50,000\.00 AED short of the security its treaties require/);
    expect(view.reconciliation.quality.checked).toContain('a paid claim on a ceded risk has had its recovery claimed');
    expect(view.reconciliation.quality.checked).toContain('the security behind every counterparty covers what that counterparty owes');
  });

  it('security: what each reinsurer must put up, what it has, and every reason the two do not match', () => {
    const w = buildWorld();
    const view = reinsuranceSnapshot(w);
    const security = view.security;

    expect(security.requirement).toBe('150,983.39 AED');       // 150,000 of recoverable plus the 983.39 premium margin
    expect(security.held).toBe('101,500.00 AED');
    expect(security.shortfall).toBe('50,000.00 AED');
    expect(security.unsecured).toEqual(['Emirates Re 50,000.00 AED']);
    expect(security.ledger.restrictedCash).toBe('10,000.00 AED');
    expect(security.ledger.receivedAsSecurity).toBe('11,500.00 AED');
    expect(security.ledger.offBalanceSheet).toBe('90,000.00 AED');   // two letters of credit, relied on and disclosed

    const emirates = security.positions.find((p) => p.counterparty === 'Emirates Re')!;
    expect(emirates.recoverable).toBe('150,000.00 AED');
    expect(emirates.requirement).toBe('150,000.00 AED');       // no premium margin: an event treaty cedes no premium
    expect(emirates.held).toBe('100,000.00 AED');              // 60,000 + 30,000 letters of credit and 10,000 cash
    expect(emirates.shortfall).toBe('50,000.00 AED');
    expect(emirates.coverPct).toBe(66.66);
    expect(emirates.secured).toBe(false);
    expect(emirates.instruments.filter((i) => i.inForce)).toHaveLength(3);
    expect(emirates.instruments.find((i) => i.reference === 'LC-77420')!.expiresAt).toBe('2026-10-20');
    expect(emirates.calls).toHaveLength(1);
    expect(emirates.calls[0]!.amount).toBe('50,000.00 AED');
    expect(emirates.calls[0]!.outstanding).toBe('50,000.00 AED');
    expect(emirates.calls[0]!.status).toBe('open');
    expect(emirates.calls[0]!.dueBy).toBe('2026-10-31');

    const gulf = security.positions.find((p) => p.counterparty === 'Gulf Reinsurance PSC')!;
    expect(gulf.requirement).toBe('983.39 AED');               // 287.50 of recovery plus 3,000 bps of 2,319.63 ceded
    expect(gulf.held).toBe('1,500.00 AED');                    // premium withheld rather than paid
    expect(gulf.surplus).toBe('516.61 AED');                   // and 516.61 of it secures nothing
    expect(gulf.secured).toBe(true);
    expect(gulf.notes.join(' ')).toMatch(/is doing nothing: release it/);

    expect(security.positions.find((p) => p.counterparty === 'MENA Re')!.secured).toBe(true);
    expect(security.findings.map((f) => `${f.severity}:${f.code}`)).toEqual([
      'error:REINS-060', 'warning:REINS-061', 'warning:REINS-064', 'info:REINS-065',
    ]);
    // The retakaful operator posts cash and it sits in the participant risk fund, where participant money belongs.
    expect(security.retakaful).toHaveLength(1);
    expect(security.retakaful[0]!.requirement).toBe('90.00 AED');
    expect(security.retakaful[0]!.held).toBe('90.00 AED');
    expect(security.retakaful[0]!.shortfall).toBe('0.00 AED');
    expect(w.ledger.balance('ALK-TKF:COLLATERAL:CASH').minor).toBe(90_00n);
    const entry = w.ledger.entriesFor('ALK-TKF', { fundId: 'PRF' }).find((e) => e.source === 'reinsurance')!;
    expect(entry.entityId).toBe('ALK-TKF');
  });

  it('reporting extracts: the return ties to the books, the exhibits state their limits, the bordereaux close per counterparty', () => {
    const w = buildWorld();
    const view = extractSnapshot(w);
    const r = view.conventional;

    expect(r.id).toBe('RI-EX-ALK-CONV-00001');
    expect(r.version).toBe(1);
    expect(r.tiesToBooks).toBe(true);
    expect(r.differencesAccepted).toBeNull();
    expect(r.controls.every((c) => c.state === 'agrees')).toBe(true);
    expect(r.controls.map((c) => c.code)).toEqual(['RS-A.5', 'RS-A.7', 'RS-B.3', 'RS-B.4', 'RS-C.receivable', 'RS-C.payable', 'RS-C.deposit', 'RS-C.security']);
    expect(r.tables.map((t) => t.code)).toEqual(['RS-A', 'RS-B', 'RS-C', 'RS-D']);
    expect(r.period).toEqual({ from: '2026-01-01', to: '2026-10-05' });

    // The return carries the same figures the rest of the console has been showing all along.
    const rowOf = (table: string, code: string) => r.tables.find((t) => t.code === table)!.rows.find((x) => x.code === code)!;
    expect(rowOf('RS-A', 'A.1').values[0]).toBe('16,778.50 AED');
    expect(rowOf('RS-A', 'A.2').values[1]).toBe('3,819.63 AED');
    expect(rowOf('RS-A', 'A.7').values[0]).toBe('497.94 AED');
    expect(rowOf('RS-A', 'A.8').values[2]).toBe('13,456.81 AED');
    // The deposit-accounted period was settled in the console flow in the recorded run, but the world the
    // tests build has it open: A.4 is nil, and A.5 is the ceded premium alone.
    expect(rowOf('RS-A', 'A.4').values[1]).toBe('0.00 AED');
    expect(rowOf('RS-A', 'A.5').values[1]).toBe('3,819.63 AED');
    expect(rowOf('RS-B', 'B.2').values[1]).toBe('450,000.00 AED');
    expect(rowOf('RS-B', 'B.3').values[1]).toBe('150,287.50 AED');
    expect(rowOf('RS-C', 'C.Emirates Re').values[0]).toBe('150,000.00 AED');
    expect(rowOf('RS-C', 'C.Gulf Reinsurance PSC').values[0]).toBe('635.44 AED');     // 347.94 quota-share commission + 287.50 recovery
    expect(rowOf('RS-C', 'C.Gulf Reinsurance PSC').values[1]).toBe('819.63 AED');     // ceded premium less the 1,500 withheld as security
    expect(rowOf('RS-D', 'D.AGG-SL-DEPOSIT').values[3]).toBe('300,000.00 AED');
    expect(r.tables.find((t) => t.code === 'RS-C')!.totals).toEqual(['150,785.44 AED', '2,319.63 AED', '300,000.00 AED', '101,500.00 AED', '148,465.81 AED']);
    expect(r.limitations.join(' ')).toMatch(/No IBNR estimate is computed here/);

    // The actuary's exhibits: ratios are shown as percentages, and the run-off is the claims log.
    const exhibits = w.extracts.list().find((e) => e.kind === 'actuarial-exhibits')!;
    const loss = exhibits.tables.find((t) => t.code === 'AE-3')!;
    expect(loss.columns).toContain('Loss ratio (gross)');
    expect(loss.totals!.some((cell) => cell !== null && 'ratioBps' in cell)).toBe(true);
    expect(exhibits.limitations.some((l) => l.includes('No discounting'))).toBe(true);

    // The window files from its own fund: 360.00 ceded of the 1,800.00 tabarru, 72.00 wakalah fee.
    const t = view.takaful;
    expect(t.title).toMatch(/Retakaful return — participant risk fund/);
    expect(t.tiesToBooks).toBe(true);
    expect(t.tables.find((x) => x.code === 'RS-A')!.rows.find((x) => x.code === 'A.2')!.values[1]).toBe('360.00 AED');
    expect(t.tables.find((x) => x.code === 'RS-A')!.rows.find((x) => x.code === 'A.7')!.values[0]).toBe('72.00 AED');
    expect(t.notes.join(' ')).toMatch(/participant money is reported in its own fund/);

    // One bordereau per counterparty, each closing on the same figures the return carries.
    expect(view.bordereaux.map((b) => b.counterparty)).toEqual(['Al Wathba Re', 'Emirates Re', 'Gulf Reinsurance PSC', 'MENA Re']);
    const emirates = view.bordereaux.find((b) => b.counterparty === 'Emirates Re')!;
    expect(emirates.tiesToBooks).toBe(true);
    expect(emirates.tables.find((x) => x.code === 'BD-2')!.rows).toHaveLength(1);
    const closing = emirates.tables.find((x) => x.code === 'BD-4')!;
    expect(closing.rows.find((x) => x.code === 'BD.4.1')!.values[0]).toBe('150,000.00 AED');
    expect(closing.rows.find((x) => x.code === 'BD.4.5')!.note).toMatch(/short/);
    expect(closing.rows.find((x) => x.code === 'BD.4.5')!.values[0]).toBe('150,000.00 AED');

    expect(view.history).toHaveLength(1);
    expect(view.history[0]!.version).toBe(1);
    expect(view.issued).toBe(8);                       // 2 returns + 2 exhibits + 4 bordereaux
    expect(view.verify.intact).toBe(true);
    expect(view.verify.detail).toMatch(/reproduces exactly/);
  });

  it('an issued return cannot be rewritten: a later event issues a second version, and the first stays', () => {
    const w = buildWorld();
    const first = extractSnapshot(w).conventional;
    expect(first.version).toBe(1);
    const year = { from: '2026-01-01', to: '2026-10-05' };

    const reissued = w.extracts.issue({
      kind: 'regulatory-return', period: year, asOf: '2026-10-05', by: 'finance/reporting', at: '2026-10-05T18:00:00+04:00',
    });
    expect(reissued.created).toBe(false);                       // nothing changed: the same extract comes back
    expect(reissued.extract.id).toBe(first.id);

    const event = w.reinsurance.recoverEvent('XOL-CAT-5M', {
      eventId: 'FLOOD-2', loss: money(1_140_000_00, 'AED'), at: '2026-10-05T13:00:00+04:00', by: 'catastrophe-desk',
    });
    expect(event.amount.minor).toBe(140_000_00n);
    // The figures have moved, so the same period can no longer be reissued in silence.
    expect(() => w.extracts.issue({
      kind: 'regulatory-return', period: year, asOf: '2026-10-05', by: 'finance/reporting', at: '2026-10-05T18:05:00+04:00',
      changesSummary: 'a later entry',
    })).toThrow(/say what changed and why before superseding a return/);
    const v2 = w.extracts.issue({
      kind: 'regulatory-return', period: year, asOf: '2026-10-05', by: 'finance/reporting', at: '2026-10-05T18:10:00+04:00',
      changesSummary: 'FLOOD-2 was claimed and posted after the first extract was prepared; the register and the books agree on the revised figures',
    });
    expect(v2.created).toBe(true);
    expect(v2.extract.version).toBe(2);
    expect(v2.extract.supersedes).toBe(first.id);
    expect(v2.extract.tiesToBooks).toBe(true);
    // The issued v1 figures are money in the engine; the console snapshot formats them for the screen.
    const figure = (draft: { tables: readonly { code: string; rows: readonly { code: string; values: readonly unknown[] }[] }[] }) => {
      const cell = draft.tables.find((t) => t.code === 'RS-B')!.rows.find((x) => x.code === 'B.3')!.values[1] as { minor: bigint };
      return cell.minor;
    };
    expect(figure(w.extracts.get(first.id))).toBe(150_287_50n);
    expect(figure(v2.extract)).toBe(290_287_50n);                // the original 150,000 plus the new 140,000
    expect(w.extracts.history('regulatory-return', year).map((h) => h.version)).toEqual([1, 2]);
    expect(w.extracts.verify(first.id).intact).toBe(false);      // the old one no longer reproduces, and says why
    expect(w.extracts.verify(first.id).detail).toMatch(/no longer reproduces/);
  });

  it('reinsurance: the ageing and reconciliation fields the console reads are all present', () => {
    const view = reinsuranceSnapshot(buildWorld());
    for (const key of ['asOf', 'outstanding', 'overdue', 'oldestDays', 'worstOverdue', 'buckets', 'items']) {
      expect(Object.keys(view.ageing), `ageing.${key}`).toContain(key);
    }
    for (const item of view.ageing.items) {
      for (const key of ['recoveryId', 'claimId', 'treatyId', 'amount', 'settled', 'outstanding', 'ageDays', 'expectedBy', 'overdueDays', 'bucket']) {
        expect(Object.keys(item), `item.${key}`).toContain(key);
      }
    }
    for (const key of ['agrees', 'differences', 'lines', 'balanceSheet', 'quality']) expect(Object.keys(view.reconciliation)).toContain(key);
    for (const line of view.reconciliation.lines) for (const key of ['kind', 'what', 'register', 'ledger', 'difference', 'status']) expect(Object.keys(line)).toContain(key);
    for (const key of ['errors', 'warnings', 'findings', 'checked']) expect(Object.keys(view.reconciliation.quality)).toContain(key);
    for (const key of ['asOf', 'requirement', 'held', 'shortfall', 'unsecured', 'positions', 'findings', 'notes', 'ledger', 'retakaful']) {
      expect(Object.keys(view.security), `security.${key}`).toContain(key);
    }
    for (const position of view.security.positions) {
      for (const key of ['counterparty', 'treaties', 'recoverable', 'premiumRequirement', 'requirement', 'held', 'shortfall', 'surplus', 'coverPct', 'secured', 'instruments', 'calls']) {
        expect(Object.keys(position), `position.${key}`).toContain(key);
      }
    }
    for (const key of ['restrictedCash', 'receivedAsSecurity', 'interestCredited', 'offBalanceSheet']) expect(Object.keys(view.security.ledger)).toContain(key);
  });
});

describe('the UAE rule book in the world', () => {
  it('carries every rule with both languages, and the five decisions the desk has taken under it', () => {
    const view = worldSnapshot(buildWorld());
    const book = view.uaeRules;
    expect(book.rules.length).toBe(12);
    expect(book.rules.every((r) => /[\u0600-\u06FF]/.test(r.requirementAr))).toBe(true);
    expect(book.rules.every((r) => r.instrument.includes('—') && r.clause.length > 40)).toBe(true);
    expect(book.decisions.map((d) => d.decision)).toEqual(['allow', 'allow', 'escalate', 'refuse', 'refuse']);
    expect(book.statement).toMatchObject({ rules: 12, decisions: 5, allow: 2, escalate: 1, refuse: 2 });
    expect(book.decisions[0]!.blocking).toEqual([]);
    expect(book.decisions[2]!.blocking[0]!.ruleId).toBe('UAE-RI-02');
    expect(book.decisions[2]!.blocking[0]!.missing).toContain('rating agency report');
    expect(book.decisions[3]!.blocking[0]!.ruleId).toBe('UAE-RI-09');
    expect(book.decisions[4]!.blocking[0]!.detail).toContain('no licence');
    expect(book.limitation).toContain('append-only');
  });

  it('does not let a read of the world add a decision: enforce is what moves the log', () => {
    const w = buildWorld();
    const first = uaeRuleSnapshot(w).statement.decisions;
    uaeRuleSnapshot(w);
    expect(uaeRuleSnapshot(w).statement.decisions).toBe(first);
    expect(w.rules.statement().decisions).toBe(first);
  });
});

describe('the wording book in the world', () => {
  it('holds the templates and paragraphs as data, and two generated letters with both languages', () => {
    const view = worldSnapshot(buildWorld());
    const w = view.wording;
    expect(w.templates.length).toBe(4);
    expect(w.disclaimers.length).toBe(8);
    expect(w.disclaimers.every((d) => /[\u0600-\u06FF]/.test(d.textAr))).toBe(true);
    expect(w.documents.length).toBe(2);
    const bordereau = w.documents.find((d) => d.type === 'bordereau-cover')!;
    expect(bordereau.scope).toBe('conventional');
    expect(bordereau.blocks.every((b) => b.en.length > 0 && b.ar.length > 0)).toBe(true);
    expect(bordereau.disclaimers.map((d) => d.id)).toEqual(['W-BASIS-01', 'W-LICENCE-01', 'W-SETTLE-01']);
    const note = w.documents.find((d) => d.type === 'treaty-note')!;
    expect(note.scope).toBe('takaful');
    // the window's scope renames the contribution label and keeps the segregation paragraph word for word
    expect(note.fields.find((f) => f.key === 'policy.contribution')!.label).toBe('Contribution');
    const segregation = w.disclaimers.find((d) => d.id === 'W-SEG-01')!;
    expect(note.blocks.find((b) => b.id === 'W-SEG-01')!.en).toBe(segregation.text);
    expect(note.blocks.find((b) => b.id === 'W-SEG-01')!.ar).toBe(segregation.textAr);
    expect(w.verify.every((v) => v.intact)).toBe(true);
  });

  it('does not add a letter when the world is merely read', () => {
    const world = buildWorld();
    const before = wordingSnapshot(world).documents.length;
    wordingSnapshot(world);
    expect(wordingSnapshot(world).documents.length).toBe(before);
  });
});
