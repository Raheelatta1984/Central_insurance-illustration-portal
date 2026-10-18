/**
 * The journey over the API.
 *
 * The console never touches the engine directly: it posts to these endpoints. So the acceptance
 * criteria are re-run here through the dispatcher — the same one the Node server and the offline
 * browser bundle both use — to prove that a locked section is refused over HTTP as well as on screen,
 * that a submitted section moves the recommendation on, and that the quotation the API hands back is
 * a PDF a reader can open.
 */
import { describe, expect, it } from 'vitest';
import { createRuntimeState, dispatchApiRoute, isDomainRefusal, RuntimeState } from './routes.js';
import { money } from './money.js';
import { offerFreelanceAssist } from './uwroute.js';

type Body = Record<string, unknown>;

async function call(state: RuntimeState, method: 'GET' | 'POST', path: string, payload: Body = {}): Promise<{ status: number; body: any }> {
  const result = await dispatchApiRoute(state, method, path, new URLSearchParams(), payload);
  expect(result.handled, `${method} ${path}`).toBe(true);
  return { status: result.status, body: result.body };
}

/** A domain refusal arrives as a thrown error; the server turns it into a 409 with the sentence. */
async function refusal(state: RuntimeState, path: string, payload: Body = {}): Promise<string> {
  try {
    const result = await dispatchApiRoute(state, 'POST', path, new URLSearchParams(), payload);
    if (result.status >= 400) return JSON.stringify(result.body);
    return '';
  } catch (error) {
    expect(isDomainRefusal(error), String(error)).toBe(true);
    return error instanceof Error ? error.message : String(error);
  }
}

const ANSWERS: Record<string, Body> = {
  identity: {
    kind: 'person', nameEn: 'Noura Saeed Al Zaabi', nameAr: 'نورة الزعابي', dateOfBirth: '1993-03-08',
    idType: 'emirates-id', idNumber: '784-1993-2233445-6', idSource: 'chip', phone: '+971 50 778 9900',
    email: 'noura.zaabi@example.ae', addressLine: 'Corniche Tower, Apt 1204', city: 'Abu Dhabi', country: 'AE',
    consentTo: 'DXB-BROKER-01',
  },
  profile: {
    contactConfirmed: true, duplicateChecked: true, consentScopes: ['customer.exists', 'customer.name', 'customer.contact'],
    dataResidency: 'in-country', taxResidence: 'AE', taxId: 'AE-TIN-1993-2233445',
  },
  needs: {
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
  },
  recommendation: { productId: 'PROD-UL-GLOBAL', alternativesPresented: true, customerAccepted: true, recommendationNote: 'Growth appetite, income to replace and a mortgage to cover: the unit-linked plan answers all three inside budget.' },
  coverage: { sumAssured: '1020000', termYears: 20, paymentFrequency: 'annual', annualIncome: '480000', age: 41, sex: 'female', smoker: false, heightCm: 168, weightKg: 62, residenceCountry: 'AE' },
  loadings: { occupationClass: '2', occupationTitle: 'Marine logistics supervisor, no work at height', conditions: [], pursuits: [], familyHistory: [], loadingReviewedBy: 'underwriter-1', loadingAcknowledged: true },
  riders: { ridersConsidered: true, riders: ['critical-illness'], withoutLoading: [], ridersAcknowledged: true },
  medical: { requirementsOrdered: true, reviewedBy: 'underwriter-1', reviewNote: 'Evidence received from the treating physician and read against the manual.', results: [{ label: 'blood profile', status: 'reviewed', at: '2026-10-05', by: 'underwriter-1' }, { label: 'urine analysis', status: 'reviewed', at: '2026-10-05', by: 'underwriter-1' }, { label: 'Critical illness questionnaire', status: 'reviewed', at: '2026-10-05', by: 'underwriter-1' }] },
  funds: { weights: [{ fundId: 'FGLOBAL', weightPct: 60 }, { fundId: 'FBAL', weightPct: 40 }], appetiteAcknowledged: true, dealingAcknowledged: true },
  beneficiaries: { beneficiaries: [{ name: 'Saeed Al Zaabi', relationship: 'father', sharePct: 100, kind: 'primary' }], customerConfirmed: true },
  'uw-review': { questionnaireReviewed: true, questionnaireUpdatedBy: 'underwriter-1', questionnaireNotes: 'Questionnaire reviewed against the evidence on file; nothing undeclared.', decisionOutcome: 'standard', decidedBy: 'senior-underwriter', decidedByAi: false },
  quotation: { issue: true, emailTo: 'noura.zaabi@example.ae', emailLanguage: 'both', sendEmail: true, buyLinkSent: true },
  finalisation: { coolingOffAcknowledged: true, reviewedWithCustomer: true, signedBy: 'Noura Saeed Al Zaabi', signedAt: '2026-10-05' },
  payment: { method: 'cash', amount: '49,219.49', branch: 'Jumeirah' },
  routing: { routeConfirmed: true, confirmedBy: 'senior-underwriter', seniorSignOff: 'senior-underwriter' },
  conversion: { convert: true, convertedBy: 'policy-issue-desk', commencement: '2026-10-05', initialFundId: 'FGLOBAL' },
  allocation: { allocationReviewed: true, reviewedBy: 'fund-administrator', reviewedAt: '2026-10-05', rebalanceRequested: false, rebalanceNote: 'Allocation matches the signed target weights; nothing to rebalance at issue.' },
  investment: { progressReviewed: true, statementSent: true, reviewedBy: 'fund-administrator' },
  servicing: { handoverAcknowledged: true, serviceChannel: 'portal', handoverBy: 'policy-servicing' },
};

const ORDER = Object.keys(ANSWERS);

describe('GET /journey', () => {
  it('serves the catalogue, the choice lists the sections need, and the case in flight', async () => {
    const state = createRuntimeState(1);
    const { status, body } = await call(state, 'GET', '/journey');
    expect(status).toBe(200);
    expect(body.stages).toHaveLength(19);
    expect(body.stages[0].id).toBe('identity');
    expect(body.stages[18].id).toBe('servicing');
    expect(body.products.length).toBeGreaterThan(0);
    expect(body.funds.map((f: { fundId: string }) => f.fundId)).toEqual(['FGLOBAL', 'FBAL', 'TKF-EQ']);
    expect(body.riders.map((r: { code: string }) => r.code)).toContain('critical-illness');
    expect(body.paymentMethods.map((m: { code: string }) => m.code)).toEqual(['cash', 'credit-card', 'debit-card', 'bank-transfer', 'bnpl', 'branch-deposit']);
    expect(body.freelancePanel.length).toBeGreaterThan(0);
    expect(body.questionnaire.length).toBeGreaterThan(10);
    expect(body.queue.promisedDecisionHours).toBe(24);

    expect(body.cases).toHaveLength(1);
    const progress = body.cases[0].progress;
    expect(progress.completeStages).toBe(4);
    expect(progress.nextRecommended).toBe('coverage');
    expect(progress.stages.filter((s: { autoOpen: boolean }) => s.autoOpen).map((s: { id: string }) => s.id)).toEqual(['coverage']);
    // Money never reaches the console as a bigint: it is formatted on the way out.
    expect(JSON.stringify(progress)).not.toMatch(/"minor"/);
  });

  it('is served inside the world snapshot the console already loads', async () => {
    const state = createRuntimeState(1);
    const { body } = await call(state, 'GET', '/world');
    expect(body.journey.cases).toHaveLength(1);
    expect(body.journey.stages).toHaveLength(19);
    expect(body.journey.pack).toMatch(/^AE /);
  });
});

describe('POST /journey', () => {
  it('opens a case with every section closed and the first one recommended', async () => {
    const state = createRuntimeState(1);
    const opened = await call(state, 'POST', '/journey/open', { customerName: 'Noura Saeed Al Zaabi', country: 'AE' });
    expect(opened.status).toBe(200);
    const caseId = opened.body.caseId as string;
    expect(caseId).toMatch(/^JNY-/);
    expect(opened.body.progress.completeStages).toBe(0);
    expect(opened.body.progress.nextRecommended).toBe('identity');
    expect(opened.body.progress.stages.filter((s: { autoOpen: boolean }) => s.autoOpen).map((s: { id: string }) => s.id)).toEqual(['identity']);
    expect(opened.body.progress.stages.slice(1).every((s: { status: string }) => s.status === 'locked')).toBe(true);
  });

  it('refuses a locked section over the API, exactly as the console does', async () => {
    const state = createRuntimeState(1);
    const caseId = (await call(state, 'POST', '/journey/open', {})).body.caseId as string;
    const refused = await call(state, 'POST', '/journey/submit', { caseId, stageId: 'conversion', answers: ANSWERS['conversion'] });
    expect(refused.status).toBe(200);
    expect(refused.body.accepted).toBe(false);
    expect(refused.body.reason).toMatch(/locked until "Customer onboarding & identity verification" is 100% complete/);
  });

  it('refuses an incomplete section and names the fields it is missing', async () => {
    const state = createRuntimeState(1);
    const caseId = (await call(state, 'POST', '/journey/open', {})).body.caseId as string;
    const refused = await call(state, 'POST', '/journey/submit', { caseId, stageId: 'identity', answers: { nameEn: 'Noura' } });
    expect(refused.body.accepted).toBe(false);
    expect(refused.body.reason).toMatch(/mandatory fields outstanding/);
    expect(refused.body.reason).toMatch(/Identity document number/);
  });

  it('saves a draft without completing the section', async () => {
    const state = createRuntimeState(1);
    const caseId = (await call(state, 'POST', '/journey/open', {})).body.caseId as string;
    const saved = await call(state, 'POST', '/journey/save', { caseId, stageId: 'identity', answers: ANSWERS['identity'] });
    expect(saved.status).toBe(200);
    const identity = saved.body.progress.stages.find((s: { id: string }) => s.id === 'identity');
    expect(identity.percent).toBe(100);
    expect(identity.complete).toBe(false);
    expect(saved.body.progress.nextRecommended).toBe('identity');
  });

  it('walks the whole lifecycle through the API and produces the documents and the policy', async () => {
    const state = createRuntimeState(1);
    const caseId = (await call(state, 'POST', '/journey/open', { customerName: 'Noura Saeed Al Zaabi' })).body.caseId as string;
    let due = '49,219.49';
    let quotationId = '';
    let paymentId = '';
    let policyId = '';

    for (const stageId of ORDER) {
      const answers = { ...ANSWERS[stageId] };
      if (stageId === 'payment') { answers['method'] = 'cash'; answers['amount'] = due; answers['branch'] = 'Jumeirah'; }
      const result = await call(state, 'POST', '/journey/submit', { caseId, stageId, answers, by: 'operator' });
      expect(result.body.accepted, `${stageId}: ${result.body.reason}`).toBe(true);
      if (stageId === 'quotation') {
        due = String(result.body.detail.totalPayable).replace(' AED', '');
        quotationId = String(result.body.detail.quotationId);
        expect(result.body.detail.pdf.opens).toBe(true);
        expect(result.body.detail.email.to).toBe('n*********i@example.ae');   // masked in the audit copy
      }
      if (stageId === 'payment') paymentId = String(result.body.detail.paymentId);
      if (stageId === 'conversion') policyId = String(result.body.detail.policyId);
      const next = result.body.progress.nextRecommended;
      if (stageId !== 'servicing') {
        expect(next, `after ${stageId}`).toBe(ORDER[ORDER.indexOf(stageId) + 1]);
        expect(result.body.progress.stages.filter((s: { autoOpen: boolean }) => s.autoOpen).map((s: { id: string }) => s.id)).toEqual([ORDER[ORDER.indexOf(stageId) + 1]]);
      } else {
        expect(next).toBeNull();
        expect(result.body.progress.percent).toBe(100);
      }
    }

    // The document the API hands back is a PDF a reader can open, not text with a .pdf name.
    const pdf = await call(state, 'POST', '/journey/quotation/pdf', { quotationId });
    expect(pdf.status).toBe(200);
    expect(pdf.body.base64.startsWith('JVBER')).toBe(true);
    expect(pdf.body.opens).toBe(true);
    expect(pdf.body.pages).toBeGreaterThan(0);
    expect(pdf.body.text).toContain('Noura Saeed Al Zaabi');
    expect(pdf.body.fingerprint).toHaveLength(16);

    // The money, the policy and the books are all reachable from the world the console renders.
    const world = (await call(state, 'GET', '/world')).body;
    expect(world.journey.payments.find((p: { id: string }) => p.id === paymentId).status).toBe('captured');
    expect(world.erp.policies.find((p: { policyId: string }) => p.policyId === policyId).status).toBe('in force');
    expect(world.erp.policies.find((p: { policyId: string }) => p.policyId === policyId).targetWeights).toEqual([{ fundId: 'FGLOBAL', weightBps: 6000 }, { fundId: 'FBAL', weightBps: 4000 }]);
    expect(world.ledger.proof.balanced).toBe(true);
    expect(world.journey.quotations.find((q: { quotationId: string }) => q.quotationId === quotationId).status).toBe('finalised');
  });

  it('holds the journey while a transfer is pending, and releases it when the bank confirms', async () => {
    const state = createRuntimeState(1);
    const caseId = (await call(state, 'POST', '/journey/open', { customerName: 'Noura Saeed Al Zaabi' })).body.caseId as string;
    let due = '49,219.49';
    for (const stageId of ORDER.slice(0, ORDER.indexOf('payment') + 1)) {
      const answers = { ...ANSWERS[stageId] };
      if (stageId === 'payment') { answers['method'] = 'bank-transfer'; answers['iban'] = 'AE070331234567890123456'; answers['bankName'] = 'Emirates NBD'; answers['amount'] = due; }
      const result = await call(state, 'POST', '/journey/submit', { caseId, stageId, answers });
      expect(result.body.accepted, `${stageId}: ${result.body.reason}`).toBe(true);
      if (stageId === 'quotation') due = String(result.body.detail.totalPayable).replace(' AED', '');
    }
    const journey = await call(state, 'GET', '/journey');
    const mine = journey.body.cases.find((c: { caseId: string }) => c.caseId === caseId);
    const paymentId = mine.artefacts.paymentId as string;
    expect(mine.progress.stages.find((s: { id: string }) => s.id === 'payment').complete).toBe(false);

    const locked = await call(state, 'POST', '/journey/submit', { caseId, stageId: 'routing', answers: ANSWERS['routing'] });
    expect(locked.body.accepted).toBe(false);
    expect(locked.body.reason).toMatch(/locked until "Buy online/);

    const settled = await call(state, 'POST', '/journey/payment/settle', { paymentId, by: 'treasury', proof: 'Bank statement line 4471 credits the collection account' });
    expect(settled.status).toBe(200);
    expect(settled.body.status).toBe('settled');

    const after = await call(state, 'GET', '/journey');
    const resumed = after.body.cases.find((c: { caseId: string }) => c.caseId === caseId);
    expect(resumed.progress.stages.find((s: { id: string }) => s.id === 'payment').complete).toBe(true);
    expect(resumed.progress.nextRecommended).toBe('routing');

    // Money already received is reversed, not failed: the two are different accounting events.
    expect(await refusal(state, '/journey/payment/fail', { paymentId, reason: 'The transfer never arrived and the customer confirmed they did not send it' }))
      .toMatch(/already settled; money the insurer has received is reversed, not failed/);
  });

  it('takes a freelance underwriting report and a reinsurer’s answer through the API', async () => {
    const state = createRuntimeState(1);
    const desk = state.world.journey.underwritingDesk;
    const offer = offerFreelanceAssist({ sumAssured: money(750_000_00n, 'AED'), occupationClass: 1, neededWithinHours: 24 })!;
    const engaged = desk.engageFreelance({ caseReference: 'JNY-API', offer, at: '2026-10-05T09:00:00+04:00', by: 'senior-underwriter' });
    const request = desk.requestReinsuranceAssist({ caseReference: 'JNY-API', sumAssured: money(2_500_000_00n, 'AED'), treatyId: 'TRT-QS-01', cessionBps: 2500, at: '2026-10-05T09:00:00+04:00', by: 'senior-underwriter' });

    const reported = await call(state, 'POST', '/journey/freelance/report', {
      engagementId: engaged.engagementId, recommendation: 'rated',
      notes: 'Occupation duties confirmed on a site visit; recommend a 60 bps occupational debit and standard terms otherwise.',
    });
    expect(reported.status).toBe(200);
    expect(reported.body.recommendation).toBe('rated');
    expect(reported.body.status).toBe('reported');

    const answered = await call(state, 'POST', '/journey/reinsurance/answer', {
      requestId: request.requestId, decision: 'accept-with-conditions', conditions: ['No cover for the first 90 days of the critical illness rider'],
    });
    expect(answered.body.decision).toBe('accept-with-conditions');
    expect(answered.body.conditions).toHaveLength(1);

    const world = await call(state, 'GET', '/world');
    expect(world.body.journey.engagements[0].underwriter).toBe(offer.name);
    expect(world.body.journey.reinsuranceAssists[0].answer.decision).toBe('accept-with-conditions');

    expect(await refusal(state, '/journey/freelance/report', { engagementId: 'FUE-999999', recommendation: 'rated', notes: 'x'.repeat(40) })).toMatch(/unknown freelance engagement/);
    expect(await refusal(state, '/journey/reinsurance/answer', { requestId: 'RIA-999999', decision: 'accept' })).toMatch(/unknown reinsurance assist request/);
  });

  it('abandons a case only with a reason, through the API', async () => {
    const state = createRuntimeState(1);
    const caseId = (await call(state, 'POST', '/journey/open', {})).body.caseId as string;
    expect(await refusal(state, '/journey/abandon', { caseId, by: 'agent-7', reason: 'no' })).toMatch(/at least 24 characters/);
    const abandoned = await call(state, 'POST', '/journey/abandon', { caseId, by: 'agent-7', reason: 'Customer deferred the decision to the next financial year' });
    expect(abandoned.body.status).toBe('abandoned');
  });
});

describe('POST /underwriting/amend', () => {
  it('records the questionnaire change, re-assesses, and sets a decision aside', async () => {
    // The journey's review-and-update screen and the underwriting tab both post here: the file has
    // to show what changed, who changed it, and that the old decision no longer describes the risk.
    const state = createRuntimeState(1);
    const applicationId = state.world.underwriting.list()[0]!.id;
    state.world.underwriting.decide(applicationId, { at: '2026-10-04T09:00:00+04:00', by: 'senior-underwriter' });

    const refused = await refusal(state, '/underwriting/amend', { applicationId, by: 'underwriter-1', reason: 'typo', occupationClass: 4 });
    expect(refused).toMatch(/at least 24 characters/);

    const { status, body } = await call(state, 'POST', '/underwriting/amend', {
      applicationId, by: 'underwriter-1',
      reason: 'Customer disclosed offshore rig duties at the medical interview; occupation reclassified.',
      occupationClass: 4, smoker: true, conditions: 'hypertension-controlled',
    });
    expect(status).toBe(200);
    expect(body.amendments.map((a: { field: string }) => a.field)).toEqual(['smoker', 'occupationClass', 'conditions']);
    expect(body.amendments.find((a: { field: string }) => a.field === 'occupationClass')).toMatchObject({ from: '1', to: '4', by: 'underwriter-1' });
    expect(body.amendments.find((a: { field: string }) => a.field === 'conditions')).toMatchObject({ from: 'none', to: 'hypertension-controlled' });
    expect(body.decisionSetAside).toBe('standard');
    expect(body.reassessment.extraMortalityBps).toBe(150 + 100 + 25);
    // The trail carries the three field changes and the decision that was set aside because of them.
    expect(body.trail).toHaveLength(4);
    expect(body.trail[3]).toMatchObject({ field: 'decision', from: 'standard decided by senior-underwriter' });
    expect(body.trail[3].to).toMatch(/must be decided again/);

    // The snapshot the console renders carries the trail, so the screen and the file agree.
    const world = await call(state, 'GET', '/world');
    const application = world.body.underwriting.applications.find((a: { id: string }) => a.id === applicationId);
    expect(application.amendments).toHaveLength(4);
    expect(application.heightCm).toBeGreaterThan(0);
    expect(application.decidedBy).toBeNull();               // the decision was set aside
  });

  it('records nothing when the answers are confirmed as they stand', async () => {
    const state = createRuntimeState(1);
    const applicationId = state.world.underwriting.list()[0]!.id;
    const { body } = await call(state, 'POST', '/underwriting/amend', {
      applicationId, by: 'underwriter-1',
      reason: 'Questionnaire reviewed with the customer on the phone; every answer confirmed as it stood.',
      smoker: false, occupationClass: 1,
    });
    expect(body.amendments).toEqual([]);
    expect(body.decisionSetAside).toBeNull();
  });
});

describe('master journey field settings', () => {
  it('updates required and editable controls, exposes them in the journey, and enforces locked fields at the API', async () => {
    const state = createRuntimeState(1);
    const saved = await call(state, 'POST', '/journey/field-settings', {
      fieldSettings: { identity: { phone: { mandatory: false, editable: false } } },
    });
    expect(saved.status).toBe(200);
    const snapshot = await call(state, 'GET', '/journey');
    expect(snapshot.body.fieldSettings.identity.phone).toEqual({ mandatory: false, editable: false });
    const opened = await call(state, 'POST', '/journey/open', {});
    const identity = opened.body.progress.stages.find((stage: { id: string }) => stage.id === 'identity');
    expect(identity.fields.find((field: { id: string }) => field.id === 'phone')).toMatchObject({ mandatory: false, editable: false });

    const message = await refusal(state, '/journey/save', {
      caseId: opened.body.caseId, stageId: 'identity', answers: { phone: '+971501234567' },
    });
    expect(message).toContain('Phone is locked by master settings');
  });
});
