import { describe, expect, it } from 'vitest';
import { createRuntimeState, dispatchApiRoute, type RuntimeState } from './routes.js';
import type { PartnerScope } from './partner-portal.js';
import { money, toDecimalString } from './money.js';

type Body = Record<string, unknown>;
async function call(state: RuntimeState, method: 'GET' | 'POST', path: string, body: Body = {}, query = ''): Promise<any> {
  const result = await dispatchApiRoute(state, method, path, new URLSearchParams(query), body);
  expect(result.handled, path).toBe(true);
  return result.body;
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

const scope: PartnerScope = { partnerId: 'DEMO-BROKER', channelCode: 'BROKER', subChannelCode: 'DEMO-BROKER-DESK' };
async function setup() {
  const state = createRuntimeState(1, () => '2026-10-05T12:00:00.000Z');
  await call(state, 'POST', '/partner-portal/demo/setup');
  return state;
}
async function signedCase(state: RuntimeState, overrides: Record<string, Body> = {}) {
  const { caseId } = await call(state, 'POST', '/partner-portal/journey/open', { ...scope, customerName: 'Noura Saeed Al Zaabi', by: 'agent' });
  let due = '';
  const bookBefore = state.world.underwriting.bookPremium().policies;
  for (const stageId of Object.keys(ANSWERS).slice(0, 13).filter((stageId) => stageId !== 'uw-review' && stageId !== 'medical')) {
    const result = await call(state, 'POST', '/journey/submit', { caseId, stageId, answers: { ...ANSWERS[stageId], ...overrides[stageId] }, by: 'agent' });
    expect(result.accepted, `${stageId}: ${result.reason}`).toBe(true);
    if (stageId === 'coverage') {
      const app = state.world.underwriting.application(String(result.artefacts.applicationId));
      expect(state.world.underwriting.isHeldForPartnerApproval(app.id)).toBe(true);
      expect(() => state.world.underwriting.assess(app.id)).toThrow(/partner approval/i);
      expect(() => state.world.underwriting.decide(app.id, { at: '2026-10-05', by: 'unauthorised' })).toThrow(/partner approval/i);
      expect(app.decision).toBeUndefined();
    }
    if (stageId === 'quotation') {
      due = String(result.detail.totalPayable).replace(' AED', '');
      const quote = state.world.journey.quotations.get(String(result.artefacts.quotationId));
      expect(quote.facts.conditional).toBe(true);
      expect(state.world.journey.get(String(caseId)).answers.quotation['buyLinkSent']).toBe(false);
      expect(quote.pdf.text).toMatch(/SUBJECT TO UNDERWRITING/i);
      expect(quote.email?.body).toMatch(/no underwriting decision or cover exists/i);
    }
  }
  const c = state.world.journey.get(String(caseId));
  const quote = state.world.journey.quotations.get(c.artefacts.quotationId!);
  expect(c.submitted).not.toContain('medical');
  await expect(call(state, 'POST', '/partner-portal/journey/stage', { caseId, stageId: 'medical', action: 'save', answers: ANSWERS['medical'], by: 'insurer-underwriter' })).rejects.toThrow(/approved manual insurer route/i);
  expect(c.computed.__medicalRequirements).toBeUndefined();
  expect(quote.facts.medicalRequirements).toEqual([]);
  expect(quote.pdf.text).toMatch(/medical evidence may be required/i);
  expect(quote.finalisation?.readyToBuyOnline).toBe(false);
  expect(quote.finalisation?.buyToken).toBe('');
  expect(state.world.underwriting.bookPremium().policies).toBe(bookBefore);
  return { caseId: String(caseId), due };
}
async function submit(state: RuntimeState, caseId: string) {
  return call(state, 'POST', '/partner-portal/applications/submit', { caseId, by: 'agent' });
}
async function approve(state: RuntimeState, id: string, role = 'manager') {
  return call(state, 'POST', '/partner-portal/applications/review', { id, by: 'reviewer', role, outcome: 'approved', note: 'Reviewed the signed application.' });
}
async function reviewMedical(state: RuntimeState, caseId: string) {
  const result = await call(state, 'POST', '/partner-portal/journey/stage', { caseId, stageId: 'medical', action: 'submit', answers: ANSWERS['medical'], by: 'insurer-underwriter' });
  expect(result.accepted, result.reason).toBe(true);
}
async function manuallyUnderwrite(state: RuntimeState, caseId: string, applicationId: string) {
  await reviewMedical(state, caseId);
  const result = await call(state, 'POST', '/partner-portal/journey/stage', { caseId, stageId: 'uw-review', action: 'submit', answers: ANSWERS['uw-review'], by: 'insurer-underwriter' });
  expect(result.accepted, result.reason).toBe(true);
  await expect(call(state, 'POST', '/partner-portal/underwriting/review', { id: applicationId, by: 'reviewer', note: 'Current underwriting decision reviewed.', termsReconciled: true })).rejects.toThrow(/independently/);
  await expect(call(state, 'POST', '/partner-portal/underwriting/review', { id: applicationId, by: 'insurer-underwriter', note: 'Current underwriting decision reviewed independently.', termsReconciled: false })).rejects.toThrow(/confirm all final terms/i);
  const reviewed = await call(state, 'POST', '/partner-portal/underwriting/review', { id: applicationId, by: 'insurer-underwriter', note: 'Current underwriting decision reviewed independently.', termsReconciled: true });
  expect(reviewed.underwritingReview.by).toBe('insurer-underwriter');
}

it('requires enabled matching partner scopes for every channel and sub-channel', async () => {
  const state = await setup();
  expect(state.world.partnerPortal.scope(state.world, { partnerId: 'DEMO-BANK', subChannelCode: 'DEMO-BANK-BRANCH' }, true).channelCode).toBe('BANCASSURANCE');
  expect(state.world.partnerPortal.scope(state.world, scope, true)).toEqual(scope);
  expect(() => state.world.partnerPortal.scope(state.world, { partnerId: 'DEMO-BANK', subChannelCode: 'DEMO-BROKER-DESK' })).toThrow(/sub-channel/);
  expect(() => state.world.partnerPortal.scope(state.world, { partnerId: 'DEMO-BANK', channelCode: 'BROKER' })).toThrow(/match/);
  expect(() => state.world.partnerPortal.scope(state.world, { partnerId: 'NOT-FILED' })).toThrow(/not filed/);
});

describe('signed application and fallback review', () => {
  it('holds underwriting until manager approval and requires an independent human for a manual route', async () => {
    const state = await setup();
    const { caseId, due } = await signedCase(state);
    const appId = state.world.journey.get(caseId).artefacts.applicationId!;
    const submitted = await submit(state, caseId);
    expect(submitted.status).toBe('pending');
    await expect(submit(state, caseId)).rejects.toThrow(/return the current/);
    await expect(call(state, 'POST', '/partner-portal/applications/review', { id: submitted.id, by: 'agent', role: 'supervisor', outcome: 'approved', note: 'I reviewed the application.' })).rejects.toThrow(/submitter/);
    await expect(call(state, 'POST', '/policies/convert', { applicationId: appId })).rejects.toThrow(/approved customer journey/);
    const paymentBefore = await call(state, 'POST', '/journey/submit', { caseId, stageId: 'payment', answers: { ...ANSWERS['payment'], amount: due }, by: 'cashier' });
    expect(paymentBefore.accepted).toBe(false);
    expect(paymentBefore.reason).toMatch(/locked|partner.*approval/i);
    const before = await call(state, 'POST', '/journey/submit', { caseId, stageId: 'routing', answers: ANSWERS['routing'] });
    expect(before.accepted).toBe(false);
    expect(state.world.journey.context(state.world, state.world.journey.get(caseId)).partnerRoutingBlocker).toMatch(/partner.*approval/i);
    expect(before.reason).toMatch(/locked|partner.*approval/i);

    const approved = await approve(state, submitted.id, 'manager');
    expect(approved.status).toBe('approved');
    expect(approved.route).toMatchObject({ route: expect.any(String), automatic: expect.any(Boolean), assignedTo: expect.any(String) });
    expect(approved.review.role).toBe('manager'); // a supervisor was not required to decide first
    expect(approved.route.automatic).toBe(false); // this larger risk requires independent human review
    await expect(call(state, 'POST', '/partner-portal/journey/stage', { caseId, stageId: 'medical', action: 'save', answers: ANSWERS['medical'], by: 'reviewer' })).rejects.toThrow(/independent insurer/i);
    expect(state.world.journey.get(caseId).answers.medical['results']).toBeUndefined();
    await expect(call(state, 'POST', '/partner-portal/applications/review', { id: submitted.id, by: 'reviewer', role: 'manager', outcome: 'returned', note: 'short' })).rejects.toThrow(/reason/);
    expect(state.world.partnerPortal.application(submitted.id).status).toBe('approved');
    const awaitingUnderwriter = await call(state, 'POST', '/journey/submit', { caseId, stageId: 'payment', answers: { ...ANSWERS['payment'], amount: due } });
    expect(awaitingUnderwriter.accepted).toBe(false);
    await manuallyUnderwrite(state, caseId, submitted.id);
    const payment = await call(state, 'POST', '/journey/submit', { caseId, stageId: 'payment', answers: { ...ANSWERS['payment'], amount: due }, by: 'cashier' });
    expect(payment.accepted, payment.reason).toBe(true);
    await expect(call(state, 'POST', '/partner-portal/applications/review', { id: submitted.id, by: 'reviewer', role: 'manager', outcome: 'returned', note: 'Customer has asked to change coverage.' })).rejects.toThrow(/paid/);
    expect(state.world.partnerPortal.application(submitted.id).status).toBe('approved');
    await expect(call(state, 'POST', '/journey/save', { caseId, stageId: 'coverage', answers: { sumAssured: '999' } })).rejects.toThrow(/return the partner application/);
    await expect(call(state, 'POST', '/policies/convert', { applicationId: appId })).rejects.toThrow(/approved customer journey/);

    const routed = await call(state, 'POST', '/journey/submit', { caseId, stageId: 'routing', answers: ANSWERS['routing'] });
    expect(routed.accepted, routed.reason).toBe(true);
    const converted = await call(state, 'POST', '/journey/submit', { caseId, stageId: 'conversion', answers: ANSWERS['conversion'] });
    expect(converted.accepted, converted.reason).toBe(true);
    expect(converted.detail.policyId).toMatch(/^UL-/);
    expect(state.world.ledger.proof(state.world.conventionalEntity).balanced).toBe(true);
  });

  it('lets a senior manager approve a low-risk automated route without a prior supervisor decision', async () => {
    const state = await setup();
    const { caseId, due } = await signedCase(state, { coverage: { sumAssured: '100000' }, riders: { riders: [] } });
    const submitted = await submit(state, caseId);
    const reviewed = await approve(state, submitted.id, 'senior-manager');
    expect(reviewed.review.role).toBe('senior-manager');
    expect(reviewed.route.automatic).toBe(true);
    expect(reviewed.underwritingReview).toBeNull();
    const payment = await call(state, 'POST', '/journey/submit', { caseId, stageId: 'payment', answers: { ...ANSWERS['payment'], amount: due } });
    expect(payment.accepted, payment.reason).toBe(true);
    const routing = await call(state, 'POST', '/journey/submit', { caseId, stageId: 'routing', answers: ANSWERS['routing'] });
    expect(routing.accepted, routing.reason).toBe(true);
    const policy = await call(state, 'POST', '/journey/submit', { caseId, stageId: 'conversion', answers: ANSWERS['conversion'] });
    expect(policy.accepted, policy.reason).toBe(true);
  });

  it('blocks changed underwriting terms until the same customer freshly signs a revised quote', async () => {
    const state = await setup();
    const { caseId, due } = await signedCase(state);
    const submitted = await submit(state, caseId);
    const original = state.world.journey.quotations.get(submitted.quotationId, submitted.quotationVersion);
    const product = state.world.erp.listProductMasters().find((p) => p.productId === 'PROD-UL-GLOBAL')!;
    const changedRate = toDecimalString(money(product.rules.baseRatePerThousandMinor + 5n, product.currency));
    state.world.erp.defineProductMaster(state.world, { productId: product.productId, name: product.name, baseRatePerThousand: changedRate });
    const approved = await approve(state, submitted.id);
    expect(approved.route.automatic).toBe(false);
    await manuallyUnderwrite(state, caseId, submitted.id);
    const c = state.world.journey.get(caseId);
    expect(state.world.partnerPortal.gate(state.world, c, state.world.journey.context(state.world, c).routing)).toMatch(/new quotation and fresh customer acceptance/i);
    const blocked = await call(state, 'POST', '/journey/submit', { caseId, stageId: 'payment', answers: { ...ANSWERS['payment'], amount: due } });
    expect(blocked.accepted).toBe(false);
    const revision = await call(state, 'POST', '/partner-portal/quotation/reissue', { id: submitted.id, by: 'insurer-underwriter' });
    const revised = state.world.journey.quotations.get(revision.revisedQuotation.quotationId);
    expect(revised.facts.requiresFreshAcceptance).toBe(true);
    expect(revised.pdf.text).toMatch(/REVISED TERMS.*NEW ACCEPTANCE REQUIRED/i);
    expect(revised.email?.body).toMatch(/freshly accept these revised terms before making any payment/i);
    expect(revised.facts.totalPayable.minor).not.toBe(original.facts.totalPayable.minor);
    await expect(call(state, 'POST', '/partner-portal/quotation/accept', { id: submitted.id, signedBy: 'Different person', reviewedWithCustomer: true, by: 'agent' })).rejects.toThrow(/same customer/);
    expect(state.world.partnerPortal.gate(state.world, c, state.world.journey.context(state.world, c).routing)).toMatch(/customer must accept/i);
    await expect(call(state, 'POST', '/partner-portal/quotation/accept', { id: submitted.id, signedBy: original.finalisation!.signedBy, by: 'agent' })).rejects.toThrow(/reviewed with the customer/i);
    await call(state, 'POST', '/partner-portal/quotation/accept', { id: submitted.id, signedBy: original.finalisation!.signedBy, reviewedWithCustomer: true, by: 'agent' });
    expect(state.world.journey.quotations.get(original.quotationId).finalisation?.signatureReference).toBe(original.finalisation?.signatureReference);
    expect(state.world.partnerPortal.gate(state.world, c, state.world.journey.context(state.world, c).routing)).toBeNull();
    const newDue = state.world.journey.quotations.get(revision.revisedQuotation.quotationId).totalPayable.replace(' AED', '');
    const paid = await call(state, 'POST', '/journey/submit', { caseId, stageId: 'payment', answers: { ...ANSWERS['payment'], amount: newDue } });
    expect(paid.accepted, paid.reason).toBe(true);
    const routed = await call(state, 'POST', '/journey/submit', { caseId, stageId: 'routing', answers: ANSWERS['routing'] });
    expect(routed.accepted, routed.reason).toBe(true);
    const issued = await call(state, 'POST', '/journey/submit', { caseId, stageId: 'conversion', answers: ANSWERS['conversion'] });
    expect(issued.accepted, issued.reason).toBe(true);
  });

  it('requires fresh acceptance of changed rates on the automated route as well', async () => {
    const state = await setup();
    const { caseId } = await signedCase(state, { coverage: { ...ANSWERS['coverage'], sumAssured: '200000' }, riders: { riders: [] } });
    const row = await submit(state, caseId);
    const product = state.world.erp.listProductMasters().find((p) => p.productId === 'PROD-UL-GLOBAL')!;
    state.world.erp.defineProductMaster(state.world, { productId: product.productId, name: product.name, baseRatePerThousand: toDecimalString(money(product.rules.baseRatePerThousandMinor + 5n, product.currency)) });
    expect((await approve(state, row.id)).route.automatic).toBe(true);
    const c = state.world.journey.get(caseId);
    expect(state.world.partnerPortal.gate(state.world, c)).toMatch(/new quotation and fresh customer acceptance/i);
    const revised = await call(state, 'POST', '/partner-portal/quotation/reissue', { id: row.id, by: 'insurer-underwriter' });
    const doc = await call(state, 'GET', '/partner-portal/quotation', {}, `id=${row.id}`);
    expect(doc.quotationId).toBe(revised.revisedQuotation.quotationId);
    expect(doc.pdf.base64.startsWith('JVBER')).toBe(true);
    await expect(call(state, 'POST', '/partner-portal/quotation/accept', { id: row.id, signedBy: ' ', reviewedWithCustomer: true, by: 'agent' })).rejects.toThrow(/signedBy|signature/i);
    await call(state, 'POST', '/partner-portal/quotation/accept', { id: row.id, signedBy: 'Noura Saeed Al Zaabi', reviewedWithCustomer: true, by: 'agent' });
    expect(state.world.partnerPortal.gate(state.world, c)).toBeNull();
    // Simulate a later underwriting decision by the engine: the signature is bound to the old one.
    state.world.underwriting.decide(row.applicationId, { at: '2026-10-06T10:00:00Z', by: 'different-decision', isAi: true });
    expect(state.world.partnerPortal.gate(state.world, c)).toMatch(/decision changed/i);
    await expect(call(state, 'POST', '/partner-portal/quotation/accept', { id: row.id, signedBy: 'Noura Saeed Al Zaabi', reviewedWithCustomer: true, by: 'agent' })).rejects.toThrow(/current revised quotation/i);
  });

  it('refuses to manufacture a quote when current filed rates no longer reproduce the decision', async () => {
    const state = await setup();
    const { caseId } = await signedCase(state);
    const row = await submit(state, caseId); await approve(state, row.id); await manuallyUnderwrite(state, caseId, row.id);
    const product = state.world.erp.listProductMasters().find((p) => p.productId === 'PROD-UL-GLOBAL')!;
    state.world.erp.defineProductMaster(state.world, { productId: product.productId, name: product.name, baseRatePerThousand: toDecimalString(money(product.rules.baseRatePerThousandMinor + 5n, product.currency)) });
    await expect(call(state, 'POST', '/partner-portal/quotation/reissue', { id: row.id, by: 'insurer-underwriter' })).rejects.toThrow(/does not reproduce/i);
    expect(state.world.partnerPortal.application(row.id).revisedQuotation).toBeNull();
  });

  it('never permits payment, conversion, or re-quotation on a declined decision', async () => {
    const state = await setup();
    const { caseId, due } = await signedCase(state);
    const row = await submit(state, caseId); await approve(state, row.id);
    await reviewMedical(state, caseId);
    const decision = await call(state, 'POST', '/partner-portal/journey/stage', { caseId, stageId: 'uw-review', action: 'submit', answers: { ...ANSWERS['uw-review'], decisionOutcome: 'declined' }, by: 'insurer-underwriter' });
    expect(decision.accepted, decision.reason).toBe(true);
    expect(state.world.partnerPortal.gate(state.world, state.world.journey.get(caseId))).toMatch(/accepting underwriting decision/i);
    await expect(call(state, 'POST', '/partner-portal/quotation/reissue', { id: row.id, by: 'insurer-underwriter' })).rejects.toThrow(/accepting underwriting decision/i);
    const payment = await call(state, 'POST', '/journey/submit', { caseId, stageId: 'payment', answers: { ...ANSWERS['payment'], amount: due } });
    expect(payment.accepted).toBe(false);
    await expect(call(state, 'POST', '/policies/convert', { applicationId: row.applicationId })).rejects.toThrow(/approved customer journey/i);
  });

  it('re-holds a returned manual case and blocks legacy underwriting amendment and decision bypasses', async () => {
    const state = await setup();
    const { caseId } = await signedCase(state); const row = await submit(state, caseId);
    await expect(call(state, 'POST', '/underwriting/amend', { applicationId: row.applicationId, reason: 'Changed questionnaire', smoker: true })).rejects.toThrow(/must not be amended/i);
    await expect(call(state, 'POST', '/underwriting/decide', { applicationId: row.applicationId })).rejects.toThrow(/scoped insurer/i);
    await expect(call(state, 'POST', '/journey/submit', { caseId, stageId: 'uw-review', answers: ANSWERS['uw-review'] })).rejects.toThrow(/scoped insurer/i);
    await approve(state, row.id);
    await expect(call(state, 'POST', '/underwriting/amend', { applicationId: row.applicationId, reason: 'Changed questionnaire', smoker: true })).rejects.toThrow(/must not be amended/i);
    await call(state, 'POST', '/partner-portal/applications/review', { id: row.id, by: 'reviewer', role: 'manager', outcome: 'returned', note: 'Return for a fresh partner review.' });
    expect(state.world.underwriting.isHeldForPartnerApproval(row.applicationId)).toBe(true);
    expect(() => state.world.underwriting.assess(row.applicationId)).toThrow(/partner approval/i);
    const again = await submit(state, caseId); expect(again.id).not.toBe(row.id);
    expect((await approve(state, again.id)).status).toBe('approved');
  });

  it('also accepts a supervisor as the single independent reviewer', async () => {
    const state = await setup();
    const { caseId } = await signedCase(state);
    const submitted = await submit(state, caseId);
    const reviewed = await approve(state, submitted.id, 'supervisor');
    expect(reviewed.review.role).toBe('supervisor');
    expect(reviewed.status).toBe('approved');
  });

  it('rechecks the current partner product shelf at review and routing', async () => {
    const state = await setup();
    const { caseId } = await signedCase(state);
    const row = await submit(state, caseId);
    const offer = { partnerId: scope.partnerId, productId: 'PROD-UL-GLOBAL' };
    state.world.erp.channels.upsertOffer({ ...offer, enabled: false });
    await expect(approve(state, row.id)).rejects.toThrow(/partner shelf/);
    state.world.erp.channels.upsertOffer({ ...offer, enabled: true });
    await approve(state, row.id);
    state.world.erp.channels.upsertOffer({ ...offer, enabled: false });
    const c = state.world.journey.get(caseId);
    expect(state.world.partnerPortal.gate(state.world, c, state.world.journey.context(state.world, c).routing)).toMatch(/no longer valid/);
  });

  it('requires the customer signature and rejects a changed risk after submission', async () => {
    const state = await setup();
    const opened = await call(state, 'POST', '/partner-portal/journey/open', { ...scope, customerName: 'A customer', by: 'agent' });
    await expect(submit(state, opened.caseId)).rejects.toThrow(/sign-off/);
    const { caseId } = await signedCase(state);
    const row = await submit(state, caseId);
    const app = state.world.underwriting.application(row.applicationId);
    app.profile = { ...app.profile, occupationClass: 4 };
    await expect(approve(state, row.id, 'senior-manager')).rejects.toThrow(/changed/);
    const returned = await call(state, 'POST', '/partner-portal/applications/review', { id: row.id, by: 'reviewer', role: 'senior-manager', outcome: 'returned', note: 'Risk information changed, reissue.' });
    expect(returned.status).toBe('returned');
    // The legacy desk cannot update the existing underwriting application on a coverage edit.
    // Do not let a returned case be re-quoted with risk facts from two different versions.
    await expect(call(state, 'POST', '/journey/save', { caseId, stageId: 'coverage', answers: { sumAssured: '1000000' } })).rejects.toThrow(/new journey/);
    await expect(submit(state, caseId)).rejects.toThrow(/quotation and underwriting file do not match|changed/);
  });
});

describe('commission and insurer conversations', () => {
  it('reconciles exact amounts, keeps differences disputed, and records only externally reported partial settlements', async () => {
    const state = await setup();
    const { caseId, due } = await signedCase(state);
    const application = await submit(state, caseId);
    const approved = await approve(state, application.id);
    if (!approved.route.automatic) await manuallyUnderwrite(state, caseId, application.id);
    await call(state, 'POST', '/journey/submit', { caseId, stageId: 'payment', answers: { ...ANSWERS['payment'], amount: due } });
    const routed = await call(state, 'POST', '/journey/submit', { caseId, stageId: 'routing', answers: ANSWERS['routing'] });
    expect(routed.accepted, routed.reason).toBe(true);
    const conversion = await call(state, 'POST', '/journey/submit', { caseId, stageId: 'conversion', answers: ANSWERS['conversion'] });
    expect(conversion.accepted, conversion.reason).toBe(true);
    const policyId = conversion.detail.policyId;
    const entry = await call(state, 'POST', '/partner-portal/commission/accrue', { ...scope, policyId, period: '2026-10', sourceRef: 'BATCH-1', premium: '1000.00', policyYear: 1, by: 'finance' });
    expect(entry.expectedMinor).toBe('15000');
    await expect(call(state, 'POST', '/partner-portal/commission/accrue', { ...scope, policyId, period: '2026-10', sourceRef: 'BATCH-1', premium: '1.00', policyYear: 1, by: 'finance' })).rejects.toThrow(/already recorded/);
    await expect(call(state, 'POST', '/partner-portal/commission/statement', { id: entry.id, reference: 'STM-0', amount: '150.001', by: 'finance' })).rejects.toThrow(/decimal/);
    await call(state, 'POST', '/partner-portal/commission/statement', { id: entry.id, reference: 'STM-1', amount: '149.99', by: 'finance' });
    await expect(call(state, 'POST', '/partner-portal/commission/review', { id: entry.id, role: 'manager', outcome: 'approved', note: 'Checked against the statement', by: 'reviewer' })).rejects.toThrow(/differs/);
    await call(state, 'POST', '/partner-portal/commission/review', { id: entry.id, role: 'manager', outcome: 'disputed', note: 'One cent difference to investigate', by: 'reviewer' });
    await call(state, 'POST', '/partner-portal/commission/statement', { id: entry.id, reference: 'STM-2', amount: '150.00', by: 'finance' });
    await expect(call(state, 'POST', '/partner-portal/commission/review', { id: entry.id, role: 'manager', outcome: 'approved', note: 'Checked against the statement', by: 'finance' })).rejects.toThrow(/own reconciliation/);
    await call(state, 'POST', '/partner-portal/commission/review', { id: entry.id, role: 'manager', outcome: 'approved', note: 'Checked against the statement', by: 'reviewer' });
    await call(state, 'POST', '/partner-portal/commission/disbursement', { id: entry.id, reference: 'BANK-1', amount: '75.00', by: 'finance' });
    await expect(call(state, 'POST', '/partner-portal/commission/disbursement', { id: entry.id, reference: 'BANK-2', amount: '75.01', by: 'finance' })).rejects.toThrow(/outstanding/);
    await expect(call(state, 'POST', '/partner-portal/commission/disbursement', { id: entry.id, reference: 'BANK-1', amount: '1.00', by: 'finance' })).rejects.toThrow(/already recorded/);
    const report = await call(state, 'GET', '/partner-portal/workspace', {}, 'partnerId=DEMO-BROKER');
    expect(report.reports[0]).toMatchObject({ accrued: '150.00 AED', stated: '150.00 AED', approved: '150.00 AED', disbursed: '75.00 AED', outstanding: '75.00 AED' });
    expect(report.commissions.items[0].statements).toHaveLength(2);
  });

  it('aggregates operational reports across pages but only within the selected sub-channel', async () => {
    const state = await setup();
    state.world.erp.channels.upsertSubChannel({ code: 'OTHER-DESK', name: 'Other desk', parentChannelCode: 'BROKER', partnerId: 'DEMO-BROKER' });
    for (let i = 0; i < 52; i++) await call(state, 'POST', '/partner-portal/requests/open', { ...scope, kind: 'reporting-request', subject: `Report ${i}`, message: 'Please send the distribution report.', by: 'agent' });
    await call(state, 'POST', '/partner-portal/requests/open', { ...scope, subChannelCode: 'OTHER-DESK', kind: 'commission-query', subject: 'Other desk question', message: 'Please check the commission statement.', by: 'agent' });
    const first = await call(state, 'GET', '/partner-portal/workspace', {}, 'partnerId=DEMO-BROKER&subChannelCode=DEMO-BROKER-DESK&limit=1');
    expect(first.requests.items).toHaveLength(1);
    expect(first.summary.openRequests).toBe(53); // sample request plus all 52 new ones
    expect(first.summary.requestsByType).toEqual([{ kind: 'reporting-request', count: 53 }]);
    const other = await call(state, 'GET', '/partner-portal/workspace', {}, 'partnerId=DEMO-BROKER&subChannelCode=OTHER-DESK&limit=1');
    expect(other.summary.openRequests).toBe(1);
    expect(other.summary.requestsByType).toEqual([{ kind: 'commission-query', count: 1 }]);
  });

  it('only opens policy-related requests for an attributed policy and never changes the policy or claim', async () => {
    const state = await setup();
    await expect(call(state, 'POST', '/partner-portal/requests/open', { ...scope, kind: 'claim-settlement', policyId: 'MTR-0441', subject: 'Settlement question', message: 'Please update the settlement status.', by: 'agent' })).rejects.toThrow(/not attributed/);
    const req = await call(state, 'POST', '/partner-portal/requests/open', { ...scope, kind: 'reporting-request', subject: 'Quarterly report', message: 'Please send the distribution report.', by: 'agent' });
    await expect(call(state, 'POST', '/partner-portal/requests/reply', { id: req.id, from: 'partner', close: true, message: 'Closing this request now.', by: 'agent' })).rejects.toThrow(/only the insurer/);
    const closed = await call(state, 'POST', '/partner-portal/requests/reply', { id: req.id, from: 'insurer', close: true, message: 'The report has been sent for review.', by: 'insurer' });
    expect(closed.status).toBe('closed');
    await expect(call(state, 'POST', '/partner-portal/requests/reply', { id: req.id, from: 'insurer', message: 'Another update on this request.', by: 'insurer' })).rejects.toThrow(/closed/);
  });
});
