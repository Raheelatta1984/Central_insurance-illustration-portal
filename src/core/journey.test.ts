/**
 * The customer lifecycle journey: gated sections, in sequence.
 *
 * These tests are the acceptance criteria for the thing operators actually complain about — a console
 * where every tab is open at once and nothing tells you what to do next. What is asserted here:
 * every section starts closed, a section opens only when the one before it is 100% complete on its
 * mandatory fields, the machine says which section that is, an incomplete or locked section is
 * refused by the API as well as by the screen, and the whole sequence runs from onboarding to
 * investment progress producing a real customer, a real quotation PDF, a real receipt and a real
 * policy with the allocation the customer signed.
 */
import { describe, expect, it } from 'vitest';
import { buildWorld, World } from './demo.js';
import { JOURNEY_STAGES, JourneyStageId, stageAfter, stageBefore, stageSpec } from './journey.js';

const ORDER: JourneyStageId[] = [
  'identity', 'profile', 'needs', 'recommendation', 'coverage', 'loadings', 'riders', 'medical',
  'funds', 'beneficiaries', 'uw-review', 'quotation', 'finalisation', 'payment', 'routing',
  'conversion', 'allocation', 'investment', 'servicing',
];

type Answers = Record<string, unknown>;

/** The answers a well-run sale produces, stage by stage. Amounts are filled in as the case goes. */
function answersFor(stageId: JourneyStageId, context: { due?: string; requirements?: string[] } = {}): Answers {
  switch (stageId) {
    case 'identity': return {
      kind: 'person', nameEn: 'Noura Saeed Al Zaabi', nameAr: 'نورة الزعابي', dateOfBirth: '1993-03-08',
      idType: 'emirates-id', idNumber: '784-1993-2233445-6', idSource: 'chip',
      phone: '+971 50 778 9900', email: 'noura.zaabi@example.ae', addressLine: 'Corniche Tower, Apt 1204',
      city: 'Abu Dhabi', country: 'AE', consentTo: 'DXB-BROKER-01',
    };
    case 'profile': return {
      contactConfirmed: true, duplicateChecked: true, consentScopes: ['customer.exists', 'customer.name', 'customer.contact'],
      dataResidency: 'in-country', taxResidence: 'AE', taxId: 'AE-TIN-1990-7654321', preferedChannel: 'portal',
    };
    case 'needs': return {
      country: 'AE', attestationAgreed: true,
      answers: [
        { questionId: 'residence-country', value: 'AE' }, { questionId: 'dependants', value: 2 },
        { questionId: 'annual-income', value: 480000 }, { questionId: 'existing-cover', value: 3900000 },
        { questionId: 'outstanding-debt', value: 600000 }, { questionId: 'premium-budget', value: 60000 },
        { questionId: 'objective', value: 'family-protection' }, { questionId: 'risk-appetite', value: 'growth' },
        { questionId: 'shariah-preferred', value: false }, { questionId: 'age', value: 41 },
        { questionId: 'smoker', value: false }, { questionId: 'medical-conditions', value: false },
        { questionId: 'occupation-class', value: '2' },
      ],
    };
    case 'recommendation': return {
      productId: 'PROD-UL-GLOBAL', alternativesPresented: true, customerAccepted: true,
      recommendationNote: 'Growth appetite with income to replace and a mortgage to cover: an investment-linked plan answers both inside the stated budget.',
    };
    case 'coverage': return {
      sumAssured: '1020000', termYears: 20, paymentFrequency: 'annual', annualIncome: '480000',
      age: 41, sex: 'male', smoker: false, heightCm: 178, weightKg: 82, residenceCountry: 'AE',
    };
    case 'loadings': return {
      occupationClass: '2', occupationTitle: 'Marine logistics supervisor, no work at height',
      conditions: [], pursuits: [], familyHistory: [], loadingReviewedBy: 'underwriter-1', loadingAcknowledged: true,
    };
    case 'riders': return { ridersConsidered: true, riders: ['critical-illness', 'waiver-of-premium'], withoutLoading: [], ridersAcknowledged: true };
    case 'medical': return {
      requirementsOrdered: true, reviewedBy: 'underwriter-1',
      reviewNote: 'Evidence received from the customer’s physician and read against the manual.',
      results: (context.requirements ?? ['blood profile', 'urine analysis', 'Critical illness questionnaire', 'Occupation and duties declaration'])
        .map((label) => ({ label, status: 'reviewed', at: '2026-10-05', by: 'underwriter-1' })),
    };
    case 'funds': return {
      weights: [{ fundId: 'FGLOBAL', weightPct: 60 }, { fundId: 'FBAL', weightPct: 40 }],
      appetiteAcknowledged: true, dealingAcknowledged: true,
    };
    case 'beneficiaries': return {
      beneficiaries: [
        { name: 'Salem Al Mansoori', relationship: 'spouse', sharePct: 60, kind: 'primary' },
        { name: 'Hessa Al Mansoori', relationship: 'daughter', sharePct: 40, kind: 'primary', dateOfBirth: '2015-04-02', guardian: 'Salem Al Mansoori' },
      ],
      customerConfirmed: true,
    };
    case 'uw-review': return {
      questionnaireReviewed: true, questionnaireUpdatedBy: 'underwriter-1',
      questionnaireNotes: 'Questionnaire reviewed against the evidence on file; no undeclared conditions found.',
      decisionOutcome: 'standard', decidedBy: 'senior-underwriter', decidedByAi: false, acceptedReferrals: [],
    };
    case 'quotation': return { issue: true, emailTo: 'customer@example.ae', emailLanguage: 'both', sendEmail: true, buyLinkSent: true };
    case 'finalisation': return { coolingOffAcknowledged: true, reviewedWithCustomer: true, signedBy: 'Ahmed Al Mansoori', signedAt: '2026-10-05' };
    case 'payment': return { method: 'cash', amount: context.due ?? '49,219.49', branch: 'Jumeirah' };
    case 'routing': return { routeConfirmed: true, confirmedBy: 'senior-underwriter', seniorSignOff: 'senior-underwriter' };
    case 'conversion': return { convert: true, convertedBy: 'policy-issue-desk', commencement: '2026-10-05', initialFundId: 'FGLOBAL' };
    case 'allocation': return {
      allocationReviewed: true, reviewedBy: 'fund-administrator', reviewedAt: '2026-10-05',
      rebalanceRequested: false, rebalanceNote: 'Allocation matches the signed target weights; no rebalance needed at issue.',
    };
    case 'investment': return { progressReviewed: true, statementSent: true, reviewedBy: 'fund-administrator' };
    case 'servicing': return { handoverAcknowledged: true, serviceChannel: 'portal', handoverBy: 'policy-servicing' };
    default: return {};
  }
}

interface Stage { id: JourneyStageId; order: number; status: string; percent: number; complete: boolean; autoOpen: boolean; missing: string[]; blockers: string[]; warnings: string[]; lockedByTitle: string | null; summary: Array<{ label: string; value: string }> }
interface Progress { stages: Stage[]; percent: number; completeStages: number; nextRecommended: JourneyStageId | null; nextRecommendedTitle: string | null; headline: string; blockers: string[] }

type SubmitResult = { accepted: boolean; reason: string; detail: Record<string, unknown>; progress: Progress };

function submit(w: World, caseId: string, stageId: JourneyStageId, answers: Answers, by = 'operator'): SubmitResult {
  return w.journey.submit(w, { caseId, stageId, answers, by }) as unknown as SubmitResult;
}

function stage(progress: Progress, id: JourneyStageId): Stage {
  const found = progress.stages.find((s) => s.id === id);
  if (!found) throw new Error(`no stage ${id}`);
  return found;
}

/** Walk a case up to (and including) `upto`, returning the last result. */
function walk(w: World, caseId: string, upto: JourneyStageId, overrides: Partial<Record<JourneyStageId, Answers>> = {}): SubmitResult {
  let last: SubmitResult | null = null;
  let due = '49,219.49';
  for (const id of ORDER) {
    const answers = { ...answersFor(id, { due }), ...(overrides[id] ?? {}) };
    last = submit(w, caseId, id, answers);
    expect(last.accepted, `${id}: ${last.reason}`).toBe(true);
    if (id === 'quotation') due = String(last.detail['totalPayable'] ?? due).replace(' AED', '');
    if (id === upto) return last;
  }
  return last!;
}

describe('the stage catalogue', () => {
  it('runs from onboarding to investment progress in one fixed sequence', () => {
    expect(JOURNEY_STAGES.map((s) => s.id)).toEqual(ORDER);
    expect(JOURNEY_STAGES.map((s) => s.order)).toEqual(ORDER.map((_, i) => i + 1));
    expect(new Set(JOURNEY_STAGES.map((s) => s.id)).size).toBe(ORDER.length);
  });

  it('explains every stage: what it is for, which rule requires it, who owns it and what it produces', () => {
    // A section nobody can explain is a section somebody skips.
    for (const s of JOURNEY_STAGES) {
      expect(s.purpose.length, s.id).toBeGreaterThan(40);
      expect(s.regulatoryBasis.length, s.id).toBeGreaterThan(20);
      expect(s.produces.length, s.id).toBeGreaterThan(0);
      expect(s.fields.length, s.id).toBeGreaterThan(0);
      expect(['customer', 'agent', 'underwriter', 'cashier', 'back-office', 'system']).toContain(s.owner);
      for (const f of s.fields) expect(f.label.length, `${s.id}.${f.id}`).toBeGreaterThan(2);
    }
  });

  it('knows what comes before and after any stage', () => {
    expect(stageAfter('identity')).toBe('profile');
    expect(stageAfter('quotation')).toBe('finalisation');
    expect(stageAfter('servicing')).toBeNull();
    expect(stageBefore('coverage')).toBe('recommendation');
    expect(stageBefore('identity')).toBeNull();
    expect(stageSpec('routing').shortTitle).toBe('UW route');
    expect(() => stageSpec('nonsense' as JourneyStageId)).toThrow(/unknown journey stage/);
  });
});

describe('the seeded journey in the demo world', () => {
  it('opens with the first four sections complete and only the next one flagged to open', () => {
    const w = buildWorld();
    const snapshot = w.journey.snapshot(w);
    expect(snapshot.cases).toHaveLength(1);
    const progress = snapshot.cases[0]!.progress as unknown as Progress;

    expect(progress.completeStages).toBe(4);
    expect(progress.percent).toBe(Math.round((4 / ORDER.length) * 100));
    for (const id of ['identity', 'profile', 'needs', 'recommendation'] as JourneyStageId[]) {
      expect(stage(progress, id).status, id).toBe('complete');
      expect(stage(progress, id).percent, id).toBe(100);
    }
    expect(progress.nextRecommended).toBe('coverage');
    expect(progress.nextRecommendedTitle).toBe(stageSpec('coverage').title);
    // Exactly one section is marked to open itself, and it is the recommended one.
    expect(progress.stages.filter((s) => s.autoOpen).map((s) => s.id)).toEqual(['coverage']);
  });

  it('keeps every later section closed and says which section holds it', () => {
    const w = buildWorld();
    const progress = w.journey.snapshot(w).cases[0]!.progress as unknown as Progress;
    for (const id of ORDER.slice(4)) {
      const s = stage(progress, id);
      expect(s.status, id).toBe(id === 'coverage' ? 'ready' : 'locked');
      expect(s.autoOpen, id).toBe(id === 'coverage');
      if (id !== 'coverage') {
        expect(s.lockedByTitle, id).toBe(stageSpec('coverage').title);
        expect(s.percent, id).toBe(0);
      }
    }
    expect(progress.headline).toMatch(/Section 5 of 19/);
  });

  it('shows the needs analysis it evaluated, with the assumptions behind the sum assured', () => {
    const w = buildWorld();
    const progress = w.journey.snapshot(w).cases[0]!.progress as unknown as Progress;
    const needs = stage(progress, 'needs');
    expect(needs.summary.find((r) => r.label === 'Suggested sum assured')!.value).toBe('1,020,000.00 AED');
    expect(needs.summary.find((r) => r.label === 'Affordability ceiling')!.value).toBe('72,000.00 AED');
    expect(needs.summary.find((r) => r.label === 'Pre-sale gate')!.value).toBe('allowed');
  });
});

describe('the gates', () => {
  it('refuses a locked section instead of letting an operator jump the sequence', () => {
    const w = buildWorld();
    const caseId = w.journey.list()[0]!.caseId;
    const result = submit(w, caseId, 'conversion', answersFor('conversion'));
    expect(result.accepted).toBe(false);
    expect(result.reason).toMatch(/locked until "Coverage & premium calculation" is 100% complete/);
    expect(result.progress.stages.find((s) => s.id === 'conversion')!.status).toBe('locked');
  });

  it('refuses an open section while mandatory fields are missing, and names them', () => {
    const w = buildWorld();
    const caseId = w.journey.list()[0]!.caseId;
    const result = submit(w, caseId, 'coverage', { sumAssured: '1020000', termYears: 20 });
    expect(result.accepted).toBe(false);
    expect(result.reason).toMatch(/mandatory fields outstanding/);
    expect(result.reason).toMatch(/Payment frequency/);
    expect(result.reason).toMatch(/Entry age/);
    expect(result.progress.stages.find((s) => s.id === 'coverage')!.percent).toBeGreaterThan(0);
    expect(result.progress.stages.find((s) => s.id === 'coverage')!.percent).toBeLessThan(100);
  });

  it('refuses a sum assured the customer cannot afford, quoting the ceiling from the needs analysis', () => {
    // Suitability is not a warning: the gate stops, and says which number it stopped on.
    const w = buildWorld();
    const caseId = w.journey.list()[0]!.caseId;
    const result = submit(w, caseId, 'coverage', { ...answersFor('coverage'), sumAssured: '9,000,000' });
    expect(result.accepted).toBe(false);
    expect(result.reason).toMatch(/above the affordability ceiling of 72,000\.00 AED/);
  });

  it('refuses fund weights that do not total 100%, and never re-scales them', () => {
    const w = buildWorld();
    const caseId = w.journey.list()[0]!.caseId;
    walk(w, caseId, 'medical');
    const result = submit(w, caseId, 'funds', { weights: [{ fundId: 'FGLOBAL', weightPct: 60 }, { fundId: 'FBAL', weightPct: 30 }], appetiteAcknowledged: true, dealingAcknowledged: true });
    expect(result.accepted).toBe(false);
    expect(result.reason).toMatch(/must total exactly 10000 bps/);
    expect(stage(result.progress, 'funds').complete).toBe(false);
  });

  it('refuses beneficiaries whose shares do not total 100%, and a minor with no guardian', () => {
    const w = buildWorld();
    const caseId = w.journey.list()[0]!.caseId;
    walk(w, caseId, 'funds');
    const short = submit(w, caseId, 'beneficiaries', { beneficiaries: [{ name: 'Salem', relationship: 'spouse', sharePct: 70 }], customerConfirmed: true });
    expect(short.accepted).toBe(false);
    expect(short.reason).toMatch(/must total exactly 10000 bps/);

    const orphan = submit(w, caseId, 'beneficiaries', {
      beneficiaries: [{ name: 'Hessa', relationship: 'daughter', sharePct: 100, dateOfBirth: '2015-04-02' }], customerConfirmed: true,
    });
    expect(orphan.accepted).toBe(false);
    expect(orphan.reason).toMatch(/needs a named guardian/);
  });

  it('will not quote a declined risk, and says who may decline one', () => {
    const w = buildWorld();
    const caseId = w.journey.list()[0]!.caseId;
    walk(w, caseId, 'funds');
    submit(w, caseId, 'beneficiaries', answersFor('beneficiaries'));
    const declined = submit(w, caseId, 'uw-review', { ...answersFor('uw-review'), decisionOutcome: 'declined' });
    expect(declined.accepted).toBe(false);
    expect(declined.reason).toMatch(/only a named human may record that outcome/);
  });

  it('refuses a rider given away without loading unless somebody authorises it in writing', () => {
    const w = buildWorld();
    const caseId = w.journey.list()[0]!.caseId;
    walk(w, caseId, 'loadings');
    const result = submit(w, caseId, 'riders', { ridersConsidered: true, riders: ['critical-illness'], withoutLoading: ['critical-illness'], ridersAcknowledged: true });
    expect(result.accepted).toBe(false);
    expect(result.reason).toMatch(/Waiver authorised by|Reason the loading was waived|named person authorises it/);
  });

  it('retrieves the existing customer instead of generating a duplicate customer number', () => {
    // Sara Khalifa already exists in the register as PTY-0002, under this exact Emirates ID.
    // Onboarding her again must not mint a second golden record for one human being — every
    // holding, consent and claim would split across the two customer numbers. The existing
    // record is retrieved, the case carries her original number, and because the duplicate was
    // resolved by retrieval there is nothing left for the profile stage to block on.
    const w = buildWorld();
    const customersBefore = w.parties.list().length;
    const caze = w.journey.open(w, { customerName: 'Sara Khalifa' });
    const identity = submit(w, caze.caseId, 'identity', {
      kind: 'person', nameEn: 'Sara Khalifa', nameAr: 'سارة خليفة', dateOfBirth: '1990-11-02',
      idType: 'emirates-id', idNumber: '784199076543219', idSource: 'government-lookup',
      phone: '+971 55 987 6543', email: 'sara.khalifa@example.ae', addressLine: 'Al Maryah Island, Tower 4',
      city: 'Abu Dhabi', country: 'AE', consentTo: 'DXB-BROKER-01',
    });
    expect(identity.accepted, identity.reason).toBe(true);
    expect(w.journey.get(caze.caseId).artefacts.partyId).toBe('PTY-0002');
    expect(identity.detail['partyId']).toBe('PTY-0002');
    expect(identity.detail['created']).toBe(false);
    expect(String(identity.detail['note'])).toMatch(/already on file as PTY-0002/);
    expect(w.parties.list().length).toBe(customersBefore);

    const profile = submit(w, caze.caseId, 'profile', answersFor('profile'));
    expect(profile.accepted, profile.reason).toBe(true);
    expect(stage(profile.progress, 'profile').summary.find((r) => r.label === 'Duplicate search')!.value).toMatch(/no possible duplicate/);
  });

  it('stops at a possible duplicate until the operator records what it turned out to be', () => {
    // Same name, date of birth, phone and email as the Sara Khalifa in the register — but a
    // *different* Emirates ID, so she may genuinely be a second person. That resemblance is not
    // silently collapsed into PTY-0002 and not ignored either: a record is created, flagged,
    // and the profile stage stops until a human says what the match turned out to be.
    const w = buildWorld();
    const caze = w.journey.open(w, { customerName: 'Sara Khalifa' });
    const identity = submit(w, caze.caseId, 'identity', {
      kind: 'person', nameEn: 'Sara Khalifa', nameAr: 'سارة خليفة', dateOfBirth: '1990-11-02',
      idType: 'emirates-id', idNumber: '784-1990-1112223-4', idSource: 'government-lookup',
      phone: '+971 55 987 6543', email: 'sara.khalifa@example.ae', addressLine: 'Al Maryah Island, Tower 4',
      city: 'Abu Dhabi', country: 'AE', consentTo: 'DXB-BROKER-01',
    });
    expect(w.journey.get(caze.caseId).artefacts.partyId).not.toBe('PTY-0002');
    expect(identity.detail['created']).toBe(true);
    const blocked = submit(w, caze.caseId, 'profile', answersFor('profile'));
    expect(blocked.accepted).toBe(false);
    expect(blocked.reason).toMatch(/possible duplicate\(s\) in the register/);
    expect(stage(blocked.progress, 'profile').summary.find((r) => r.label === 'Duplicate search')!.value).toMatch(/unresolved/);

    const resolved = submit(w, caze.caseId, 'profile', {
      ...answersFor('profile'), duplicateResolution: 'distinct-person',
      duplicateNote: 'Second Sara Khalifa in the register: different Emirates ID, confirmed on the phone with the customer.',
    });
    expect(resolved.accepted, resolved.reason).toBe(true);
    expect(stage(resolved.progress, 'profile').warnings.join(' ')).toMatch(/recorded as a different person/);
  });

  it('records "no riders needed" as a decision rather than skipping the section', () => {
    const w = buildWorld();
    const caseId = w.journey.list()[0]!.caseId;
    walk(w, caseId, 'loadings');
    const blank = submit(w, caseId, 'riders', {});
    expect(blank.accepted).toBe(false);
    expect(blank.reason).toMatch(/Riders considered with the customer/);

    const none = submit(w, caseId, 'riders', { ridersConsidered: true });
    expect(none.accepted, none.reason).toBe(true);
    expect(stage(none.progress, 'riders').summary[0]!.value).toMatch(/none attached/);
  });
});

describe('complete means submitted, not merely typed', () => {
  it('keeps a section open when its fields are saved but never committed', () => {
    // An operator can fill a form and walk away. The journey must not tick that section, or open the
    // one behind it, until the step has actually been taken.
    const w = buildWorld();
    const caze = w.journey.open(w, { customerName: 'Noura Saeed Al Zaabi' });
    w.journey.save(w, { caseId: caze.caseId, stageId: 'identity', answers: answersFor('identity'), by: 'agent-7' });

    const saved = w.journey.progress(w, caze.caseId) as unknown as Progress;
    const identity = stage(saved, 'identity');
    expect(identity.missing).toEqual([]);
    expect(identity.percent).toBe(100);
    expect(identity.complete).toBe(false);
    expect(saved.nextRecommended).toBe('identity');
    expect(stage(saved, 'profile').status).toBe('locked');

    const submitted = submit(w, caze.caseId, 'identity', {});
    expect(submitted.accepted, submitted.reason).toBe(true);
    expect(stage(submitted.progress, 'identity').complete).toBe(true);
    expect(submitted.progress.nextRecommended).toBe('profile');
    expect(w.journey.get(caze.caseId).submitted).toEqual(['identity']);
  });
});

describe('the whole sequence, end to end', () => {
  it('opens the next section each time the previous one reaches 100%', () => {
    const w = buildWorld();
    const caseId = w.journey.list()[0]!.caseId;
    let progress = w.journey.progress(w, caseId) as unknown as Progress;
    let due = '49,219.49';
    for (const id of ORDER.slice(4)) {
      expect(progress.nextRecommended, `before ${id}`).toBe(id);
      const answers = { ...answersFor(id, { due }), ...(id === 'quotation' ? { emailTo: 'ahmed.mansoori@example.ae' } : {}) };
      const result = submit(w, caseId, id, answers);
      expect(result.accepted, `${id}: ${result.reason}`).toBe(true);
      expect(stage(result.progress, id).complete, id).toBe(true);
      expect(stage(result.progress, id).percent, id).toBe(100);
      expect(result.progress.stages.filter((s) => s.autoOpen).map((s) => s.id), `auto-open after ${id}`).toEqual(
        id === 'servicing' ? [] : [ORDER[ORDER.indexOf(id) + 1]!],
      );
      if (id === 'quotation') due = String(result.detail['totalPayable']).replace(' AED', '');
      progress = result.progress;
    }
    expect(progress.completeStages).toBe(ORDER.length);
    expect(progress.percent).toBe(100);
    expect(progress.nextRecommended).toBeNull();
    expect(progress.headline).toMatch(/Every section is complete/);
  });

  it('creates the customer, the underwriting file, the quotation, the receipt and the policy', () => {
    const w = buildWorld();
    const caze = w.journey.open(w, { customerName: 'Noura Saeed Al Zaabi', country: 'AE' });
    const final = walk(w, caze.caseId, 'servicing');

    expect(final.progress.percent).toBe(100);
    const artefacts = w.journey.get(caze.caseId).artefacts;
    expect(artefacts.partyId).toMatch(/^PTY-/);
    expect(w.parties.get(artefacts.partyId!)!.names.en).toBe('Noura Saeed Al Zaabi');
    expect(artefacts.needId).toBe(`NA-${caze.caseId}`);
    expect(artefacts.applicationId).toMatch(/^UW-/);
    expect(artefacts.quotationId).toMatch(/^QTN-/);
    expect(artefacts.emailMessageId).toMatch(/^MSG-/);
    expect(artefacts.paymentId).toMatch(/^PAY-/);
    expect(artefacts.policyId).toMatch(/^UL-/);

    const quotation = w.journey.quotations.get(artefacts.quotationId!);
    expect(quotation.pdf.opens).toBe(true);
    expect(quotation.pdf.pages).toBeGreaterThan(0);
    expect(quotation.pdf.text).toContain('Noura Saeed Al Zaabi');
    expect(quotation.pdf.text).toContain('Total payable');
    expect(quotation.status).toBe('finalised');

    const payment = w.journey.payments.get(artefacts.paymentId!);
    expect(payment.methodLabel).toMatch(/Cash/);
    expect(payment.status).toBe('captured');

    const policy = w.erp.snapshot(w).policies.find((p) => p.policyId === artefacts.policyId)!;
    expect(policy.status).toBe('in force');
    expect(policy.targetWeights).toEqual([{ fundId: 'FGLOBAL', weightBps: 6000 }, { fundId: 'FBAL', weightBps: 4000 }]);
    expect(policy.beneficiaryName).toBe('Salem Al Mansoori');
    expect(policy.sumAssured).toBe('1,020,000.00 AED');
    expect(w.ledger.proof(w.conventionalEntity).balanced).toBe(true);
  });

  it('records the underwriting file amendment when the questionnaire is reviewed and updated', () => {
    const w = buildWorld();
    const caze = w.journey.open(w, { customerName: 'Noura Saeed Al Zaabi' });
    walk(w, caze.caseId, 'loadings');
    const applicationId = w.journey.get(caze.caseId).artefacts.applicationId!;
    const amendments = w.underwriting.amendmentsFor(applicationId);
    expect(amendments.map((a) => a.field)).toContain('occupationClass');
    expect(amendments[0]!.from).toBe('1');
    expect(amendments[0]!.to).toBe('2');
    expect(amendments[0]!.by).toBe('underwriter-1');
    expect(amendments[0]!.reason.length).toBeGreaterThan(24);
  });

  it('reports investment progress against the signed targets, and flags the drift', () => {
    const w = buildWorld();
    const caze = w.journey.open(w, { customerName: 'Noura Saeed Al Zaabi' });
    const result = walk(w, caze.caseId, 'investment');
    // The first contribution is invested in one fund against a 60/40 signature: the report has to say so.
    expect(result.detail['maxDriftBps']).toBeGreaterThan(500);
    expect(result.detail['withinTolerance']).toBe(false);
    const summary = stage(result.progress, 'investment').summary;
    expect(summary.find((r) => r.label === 'Contributions to date')!.value).toMatch(/AED/);
    expect(summary.find((r) => r.label === 'Disclaimer')!.value).toMatch(/may fall as well as rise/);
  });

  it('hands the policy to servicing with the alteration and claim routes spelled out', () => {
    const w = buildWorld();
    const caze = w.journey.open(w, { customerName: 'Noura Saeed Al Zaabi' });
    const result = walk(w, caze.caseId, 'servicing');
    expect(result.detail['routes']).toHaveLength(3);
    expect(String((result.detail['routes'] as string[])[1])).toMatch(/Financial alterations/);
    expect(w.journey.get(caze.caseId).status).toBe('servicing');
  });
});

describe('money that has not arrived', () => {
  it('will not issue a policy on a bank transfer that has not cleared, and does once it settles', () => {
    const w = buildWorld();
    const caze = w.journey.open(w, { customerName: 'Noura Saeed Al Zaabi' });
    let due = '49,219.49';
    for (const id of ORDER.slice(0, ORDER.indexOf('payment') + 1)) {
      const answers = { ...answersFor(id, { due }), ...(id === 'payment' ? { method: 'bank-transfer', iban: 'AE070331234567890123456', bankName: 'Emirates NBD' } : {}) };
      const result = submit(w, caze.caseId, id, answers);
      expect(result.accepted, `${id}: ${result.reason}`).toBe(true);
      if (id === 'quotation') due = String(result.detail['totalPayable']).replace(' AED', '');
    }
    const paymentId = w.journey.get(caze.caseId).artefacts.paymentId!;
    expect(w.journey.payments.get(paymentId).status).toBe('pending');

    // The payment section is not complete while the money is only instructed, so conversion stays
    // locked behind it: the sequence itself is the control, not a warning on the conversion screen.
    const pendingProgress = w.journey.progress(w, caze.caseId) as unknown as Progress;
    expect(stage(pendingProgress, 'payment').complete).toBe(false);
    expect(stage(pendingProgress, 'payment').blockers.join(' ')).toMatch(/pending clearance/);
    expect(stage(pendingProgress, 'payment').percent).toBeLessThan(100);

    // Everything behind the payment section is locked while the money is only instructed.
    const routedEarly = submit(w, caze.caseId, 'routing', answersFor('routing'));
    expect(routedEarly.accepted).toBe(false);
    expect(routedEarly.reason).toMatch(/locked until "Buy online — payment options & capture" is 100% complete/);
    const blocked = submit(w, caze.caseId, 'conversion', answersFor('conversion'));
    expect(blocked.accepted).toBe(false);
    expect(blocked.reason).toMatch(/locked until "Buy online — payment options & capture" is 100% complete/);

    w.journey.payments.settle({ paymentId, at: '2026-10-07T09:00:00+04:00', by: 'treasury', proof: 'Bank statement line 4471 credits the collection account' });
    const settledProgress = w.journey.progress(w, caze.caseId) as unknown as Progress;
    expect(stage(settledProgress, 'payment').complete).toBe(true);
    expect(settledProgress.nextRecommended).toBe('routing');         // the sequence resumes where it stopped

    submit(w, caze.caseId, 'routing', answersFor('routing'));
    const converted = submit(w, caze.caseId, 'conversion', answersFor('conversion'));
    expect(converted.accepted, converted.reason).toBe(true);
    expect(converted.detail['policyId']).toMatch(/^UL-/);
  });
});

describe('the journey audit trail', () => {
  it('records every save, submit and refusal with who did it and what happened next', () => {
    const w = buildWorld();
    const caze = w.journey.open(w, { customerName: 'Noura Saeed Al Zaabi' });
    w.journey.save(w, { caseId: caze.caseId, stageId: 'identity', answers: { nameEn: 'Noura Saeed Al Zaabi' }, by: 'agent-7' });
    submit(w, caze.caseId, 'coverage', { sumAssured: '1020000' });          // refused: locked
    walk(w, caze.caseId, 'coverage');

    const log = w.journey.get(caze.caseId).log;
    expect(log.some((l) => l.action === 'saved' && l.by === 'agent-7')).toBe(true);
    expect(log.some((l) => l.action === 'refused' && l.stageId === 'coverage')).toBe(true);
    expect(log.some((l) => l.action === 'submitted' && l.completeAfter && l.stageId === 'coverage')).toBe(true);
    expect(log.at(-1)!.detail).toMatch(/next: Occupational & medical loadings/);
  });

  it('abandons a journey only with a reason long enough to be one', () => {
    const w = buildWorld();
    const caze = w.journey.open(w, { customerName: 'Noura Saeed Al Zaabi' });
    expect(() => w.journey.abandon(w, { caseId: caze.caseId, by: 'agent-7', reason: 'no' })).toThrow(/at least 24 characters/);
    const abandoned = w.journey.abandon(w, { caseId: caze.caseId, by: 'agent-7', reason: 'Customer chose to defer the decision until the next financial year' });
    expect(abandoned.status).toBe('abandoned');
    expect(abandoned.log.at(-1)!.action).toBe('abandoned');
  });
});
