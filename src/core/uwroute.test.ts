/**
 * Underwriting routing: who decides, and how long the customer waits.
 *
 * Straight-through is the goal but it has to be *earned*: no loading, no referral, no outstanding
 * medical evidence and a sum assured inside the AI limit. The tests here hold the three escalations
 * that matter — a decline always goes to a human, a facultative-sized risk goes to the reinsurer
 * before issue, and a queue that cannot meet its promise hires capacity in rather than letting the
 * customer wait silently.
 */
import { describe, expect, it } from 'vitest';
import { money, formatAmount, parseAmount } from './money.js';
import { DEFAULT_ROUTING_LIMITS, FREELANCE_PANEL, UnderwritingDesk, addHours, offerFreelanceAssist, queueWaitHours, routeUnderwriting, RoutingLimits, UnderwritingQueue } from './uwroute.js';

const AED = 'AED';

const LIMITS: RoutingLimits = {
  currency: AED,
  aiStraightThroughMinor: 500_000_00n,        // 500,000.00
  automaticBindingLimitMinor: 1_000_000_00n,  // 1,000,000.00
  facultativeThresholdMinor: 2_000_000_00n,   // 2,000,000.00
  ...DEFAULT_ROUTING_LIMITS,
};

const QUIET_QUEUE: UnderwritingQueue = {
  inHouseOpenCases: 2, inHouseCapacityPerDay: 6, oldestCaseHours: 0,
  promisedDecisionHours: 24, workingHoursPerDay: 8,
};

const BUSY_QUEUE: UnderwritingQueue = {
  inHouseOpenCases: 24, inHouseCapacityPerDay: 6, oldestCaseHours: 8,
  promisedDecisionHours: 24, workingHoursPerDay: 8,
};

const route = (over: Partial<Parameters<typeof routeUnderwriting>[0]> = {}) => routeUnderwriting({
  sumAssured: money(250_000_00n, AED),
  outcome: 'standard',
  extraMortalityBps: 0,
  referrals: [],
  outstandingMedical: 0,
  occupationClass: 1,
  limits: LIMITS,
  queue: QUIET_QUEUE,
  caseReference: 'JNY-000001',
  at: '2026-10-05T09:00:00+04:00',
  ...over,
});

describe('the routing decision', () => {
  it('issues a clean, small, unrated risk straight through', () => {
    const decision = route();
    expect(decision.route).toBe('straight-through');
    expect(decision.automatic).toBe(true);
    expect(decision.decidedByAi).toBe(true);
    expect(decision.expectedDecisionHours).toBe(0);
    expect(decision.withinPromise).toBe(true);
    expect(decision.headline).toMatch(/no human decision needed/);
    expect(decision.reasons.join(' ')).toMatch(/inside the 500,000.00 AED straight-through limit/);
    expect(decision.escalations.join(' ')).toMatch(/quality sample/);
  });

  it('auto-binds a rated risk below the binding limit, and samples it', () => {
    const decision = route({ extraMortalityBps: 75, outcome: 'rated' });
    expect(decision.route).toBe('auto-rules');
    expect(decision.automatic).toBe(true);
    expect(decision.reasons.join(' ')).toMatch(/75 bps of loading/);
  });

  it('sends anything at or above the AI limit to a human', () => {
    // The straight-through limit is the line an agent may not cross, however clean the risk looks.
    const decision = route({ sumAssured: money(750_000_00n, AED) });
    expect(decision.automatic).toBe(false);
    expect(['manual-inhouse', 'senior-review']).toContain(decision.route);
  });

  it('gives a decline or a postponement to a senior underwriter, never to a machine', () => {
    for (const outcome of ['declined', 'postponed'] as const) {
      const decision = route({ outcome, sumAssured: money(100_000_00n, AED) });
      expect(decision.route).toBe('senior-referral');
      expect(decision.automatic).toBe(false);
      expect(decision.assignedTo).toBe('senior-underwriter');
      expect(decision.reasons.join(' ')).toMatch(/no automated path may decline or postpone/);
      expect(decision.escalations).toContain('chief-underwriter');
    }
  });

  it('refers the case to a senior underwriter when the loading is heavy or the sum assured is large', () => {
    const heavy = route({ extraMortalityBps: 200, outcome: 'rated', referrals: ['senior-underwriter'] });
    expect(heavy.route === 'senior-review' || heavy.route === 'freelance-assist').toBe(true);
    expect(heavy.reasons.join(' ')).toMatch(/senior-review threshold/);

    const large = route({ sumAssured: money(2_500_000_00n, AED), outcome: 'rated', extraMortalityBps: 0 });
    expect(['reinsurance-assist', 'freelance-assist']).toContain(large.route);   // above the facultative threshold
  });

  it('holds a case with medical evidence outstanding out of the automatic path', () => {
    const decision = route({ outstandingMedical: 2, sumAssured: money(100_000_00n, AED) });
    expect(decision.route).toBe('manual-inhouse');
    expect(decision.automatic).toBe(false);
    expect(decision.reasons.join(' ')).toMatch(/2 medical requirement\(s\) are still outstanding/);
  });

  it('asks the reinsurer before issue once the facultative threshold is reached', () => {
    const decision = route({ sumAssured: money(2_500_000_00n, AED) });
    expect(decision.route).toBe('reinsurance-assist');
    expect(decision.reinsuranceAssist).toBe(true);
    expect(decision.expectedDecisionHours).toBeGreaterThanOrEqual(24);
    expect(decision.reasons.join(' ')).toMatch(/reaches the facultative threshold of 2,000,000.00 AED/);

    const flagged = route({ sumAssured: money(250_000_00n, AED), referrals: ['reinsurance-desk'] });
    expect(flagged.reinsuranceAssist).toBe(true);
  });

  it('routes a hazardous occupation to a senior signature', () => {
    const decision = route({ occupationClass: 4, sumAssured: money(250_000_00n, AED) });
    expect(decision.route).toBe('senior-review');
    expect(decision.reasons.join(' ')).toMatch(/Occupation class 4 needs a senior underwriter/);
  });
});

describe('meeting the promised decision time', () => {
  it('counts the queue in working hours', () => {
    expect(queueWaitHours(QUIET_QUEUE)).toBe(8);            // one day of capacity, no ageing
    expect(queueWaitHours(BUSY_QUEUE)).toBe(40);            // four days at six cases a day, plus 8 hours ageing
  });

  it('hires a panel underwriter when the in-house queue cannot answer in time', () => {
    const decision = route({ queue: BUSY_QUEUE, outcome: 'rated', extraMortalityBps: 75, sumAssured: money(750_000_00n, AED) });
    expect(decision.route).toBe('freelance-assist');
    expect(decision.withinPromise).toBe(true);
    expect(decision.freelance).not.toBeNull();
    expect(decision.freelance!.turnaroundHours).toBeLessThanOrEqual(24);
    expect(decision.costEstimate.minor).toBeGreaterThan(0n);
    expect(decision.reasons.join(' ')).toMatch(/engaged for \d+ day\(s\) at/);
    expect(decision.escalations.join(' ')).toMatch(/senior-underwriter \(reviews the freelance recommendation/);
  });

  it('keeps the reinsurance route when the reinsurer must answer, even if the queue is slow', () => {
    const decision = route({ queue: BUSY_QUEUE, sumAssured: money(2_500_000_00n, AED) });
    expect(decision.route).toBe('reinsurance-assist');
    expect(decision.freelance).not.toBeNull();          // capacity is still offered alongside
    expect(decision.withinPromise).toBe(false);
  });

  it('only offers a panel underwriter who actually has the authority for the case', () => {
    // A 10,000,000 sum assured is above most of the panel: the offer has to come from someone who
    // may decide it, and a Shariah arrangement needs a Shariah-qualified underwriter.
    const big = offerFreelanceAssist({ sumAssured: money(9_000_000_00n, AED), occupationClass: 1, neededWithinHours: 24 });
    expect(big?.name).toBe('Layla Haddad');
    expect(big?.authorityNote).toMatch(/10,000,000.00 AED/);

    const takaful = offerFreelanceAssist({ sumAssured: money(1_000_000_00n, AED), occupationClass: 1, neededWithinHours: 24, shariahProduct: true });
    expect(FREELANCE_PANEL.find((f) => f.name === takaful?.name)!.shariahQualified).toBe(true);

    const hazardous = offerFreelanceAssist({ sumAssured: money(1_000_000_00n, AED), occupationClass: 5, neededWithinHours: 24 });
    expect(hazardous?.name).toBe('Layla Haddad');        // the only panel member with class-5 authority

    const impossible = offerFreelanceAssist({ sumAssured: money(50_000_000_00n, AED), occupationClass: 1, neededWithinHours: 24 });
    expect(impossible).toBeNull();
  });

  it('says so when nobody on the panel can take the case, instead of waiting silently', () => {
    const decision = route({ queue: BUSY_QUEUE, sumAssured: money(50_000_000_00n, AED), outcome: 'rated', extraMortalityBps: 75 });
    expect(decision.freelance).toBeNull();
    expect(decision.withinPromise).toBe(false);
    expect(decision.reasons.join(' ')).toMatch(/no panel underwriter is available with the authority this case needs/);
    expect(decision.escalations).toContain('chief-underwriter');
  });
});

describe('the underwriting desk', () => {
  const desk = () => new UnderwritingDesk(LIMITS);
  const offer = {
    underwriterId: 'FU-02', name: 'Peter Njoroge', specialty: 'life', turnaroundHours: 12, daysEngaged: 2,
    cost: money(440_00n, AED), costLabel: formatAmount(money(440_00n, AED)), limit: money(3_000_000_00n, AED),
    authorityNote: 'Panel authority up to 3,000,000.00 AED and occupation class 4.',
    reason: 'Engaged to meet the promised decision time on JNY-000001.',
  };

  it('records the engagement, its cost and when the answer is due', () => {
    const d = desk();
    const engaged = d.engageFreelance({ caseReference: 'JNY-000001', offer, at: '2026-10-05T09:00:00+04:00', by: 'senior-underwriter' });
    expect(engaged.engagementId).toMatch(/^FUE-/);
    expect(engaged.status).toBe('engaged');
    expect(engaged.expectedDecisionAt).toBe(addHours('2026-10-05T09:00:00+04:00', 12));
    expect(formatAmount(d.externalCost())).toBe('440.00 AED');
    expect(d.engagementFor('JNY-000001')?.name).toBe('Peter Njoroge');
  });

  it('takes the freelance report, and insists it says something', () => {
    const d = desk();
    const engaged = d.engageFreelance({ caseReference: 'JNY-000001', offer, at: '2026-10-05T09:00:00+04:00', by: 'senior-underwriter' });
    expect(() => d.freelanceReport({ engagementId: engaged.engagementId, at: '2026-10-05T18:00:00+04:00', recommendation: 'rated', notes: 'looks fine' }))
      .toThrow(/at least 24 characters/);
    const reported = d.freelanceReport({
      engagementId: engaged.engagementId, at: '2026-10-05T18:00:00+04:00', recommendation: 'rated',
      notes: 'Occupation class 3 duties confirmed on site visit; recommend 60 bps occupational debit and standard terms otherwise.',
    });
    expect(reported.status).toBe('reported');
    expect(reported.report?.recommendation).toBe('rated');
    expect(reported.report?.byFreelance).toBe(true);
    expect(d.releaseFreelance(engaged.engagementId).status).toBe('released');
    expect(() => d.freelanceReport({ engagementId: 'FUE-999999', at: '2026-10-05', recommendation: 'rated', notes: 'x'.repeat(30) })).toThrow(/unknown freelance engagement/);
  });

  it('records the reinsurance assist request, its questions and the reinsurer’s answer', () => {
    const d = desk();
    const request = d.requestReinsuranceAssist({
      caseReference: 'JNY-000001', sumAssured: money(2_500_000_00n, AED), treatyId: 'TRT-QS-01', cessionBps: 2500,
      at: '2026-10-05T09:00:00+04:00', by: 'senior-underwriter',
    });
    expect(request.requestId).toMatch(/^RIA-/);
    expect(request.status).toBe('requested');
    expect(request.questions.join(' ')).toMatch(/facultative basis/);
    expect(request.questions.join(' ')).toMatch(/2500 bps/);
    expect(d.assistFor('JNY-000001')?.treatyId).toBe('TRT-QS-01');

    const answered = d.answerReinsuranceAssist({
      requestId: request.requestId, at: '2026-10-06T11:00:00+04:00', byReinsurer: 'Reinsurance underwriter, Swiss Re',
      decision: 'accept-with-conditions', conditions: ['Special acceptance: no cover for the first 90 days of the critical illness rider'],
    });
    expect(answered.status).toBe('answered');
    expect(answered.answer?.conditions).toHaveLength(1);

    const declined = d.answerReinsuranceAssist({ requestId: request.requestId, at: '2026-10-06T12:00:00+04:00', byReinsurer: 'underwriter', decision: 'decline' });
    expect(declined.status).toBe('declined-to-quote');
    expect(() => d.answerReinsuranceAssist({ requestId: 'RIA-999999', at: '2026-10-06', byReinsurer: 'x', decision: 'accept' })).toThrow(/unknown reinsurance assist request/);
  });

  it('prices the routing limits it was given', () => {
    expect(formatAmount(money(desk().routingLimits().facultativeThresholdMinor, AED))).toBe('2,000,000.00 AED');
    expect(parseAmount('2,000,000.00', AED).minor).toBe(200_000_000n);
  });
});
