import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import type { PartnerApplication } from '../core/partner-portal.js';
import { createRuntimeState, dispatchApiRoute } from '../core/routes.js';
import { createPortalServer } from './main.js';
import { loadAuthConfig } from './auth.js';

const dist = mkdtempSync(join(tmpdir(), 'partner-portal-http-'));
writeFileSync(join(dist, 'index.html'), '<html>partner</html>');
const state = createRuntimeState(1, () => '2026-10-05T12:00:00Z');
const auth = loadAuthConfig({ PORTAL_AUTH_TOKENS: [
  'admin=admin:admin',
  'agent=alice:partner-agent,partner:DEMO-BROKER,subchannel:DEMO-BROKER-DESK',
  'supervisor=bob:partner-supervisor,partner:DEMO-BROKER,subchannel:DEMO-BROKER-DESK',
  'bank=carol:partner-manager,partner:DEMO-BANK,subchannel:DEMO-BANK-BRANCH',
  'viewer=viewer:partner-viewer,partner:DEMO-BROKER,subchannel:DEMO-BROKER-DESK',
  'bad=bad:partner-agent',
  'finance=fin:partner-finance',
  'service=service:partner-insurer',
  'underwriter=uw:partner-underwriter',
].join(';') });
let server: Server;
let base: string;
async function request(token: string, path: string, body?: Record<string, unknown>) {
  return fetch(`${base}/api${path}`, {
    method: body ? 'POST' : 'GET',
    headers: { authorization: `Bearer ${token}`, ...(body ? { 'content-type': 'application/json' } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
}

describe('the partner HTTP boundary', () => {
  beforeAll(async () => {
    await dispatchApiRoute(state, 'POST', '/partner-portal/demo/setup', new URLSearchParams(), {});
    state.world.erp.channels.upsertSubChannel({ code: 'OTHER-DESK', name: 'Other desk', parentChannelCode: 'BROKER', partnerId: 'DEMO-BROKER' });
    server = createPortalServer({ state, auth, env: {}, dist, log: () => {} });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));

  it('prevents partner tokens from reading or writing the unscoped console, even GET endpoints', async () => {
    for (const path of ['/world', '/journey', '/claims', '/master/channels']) expect((await request('agent', path)).status, path).toBe(403);
    expect((await request('agent', '/journey/open', {})).status).toBe(403);
    expect((await request('bad', '/world')).status).toBe(403); // an unscoped partner role is not an internal account
    expect((await request('agent', '/health')).status).toBe(200);
  });

  it('filters the partner directory and denies another partner and other sub-channel', async () => {
    const access = await (await request('agent', '/partner-portal/access')).json() as { partners: Array<{ partnerId: string; subChannels: Array<{ code: string }> }> };
    expect(access.partners.map((p) => p.partnerId)).toEqual(['DEMO-BROKER']);
    expect(access.partners[0]!.subChannels.map((s) => s.code)).toEqual(['DEMO-BROKER-DESK']);
    expect((await request('agent', '/partner-portal/workspace?partnerId=DEMO-BANK')).status).toBe(403);
    expect((await request('agent', '/partner-portal/workspace?partnerId=DEMO-BROKER&subChannelCode=OTHER-DESK')).status).toBe(403);
    expect((await request('agent', '/partner-portal/journey/open', { partnerId: 'DEMO-BROKER', subChannelCode: 'OTHER-DESK', customerName: 'Someone' })).status).toBe(403);
    expect((await request('agent', '/partner-portal/journey/open', { partnerId: 'DEMO-BROKER', customerName: 'Someone' })).status).toBe(403);
  });

  it('stamps identity from the token and does not trust forged body context or role selection', async () => {
    const response = await request('agent', '/partner-portal/journey/open', {
      partnerId: 'DEMO-BROKER', subChannelCode: 'DEMO-BROKER-DESK', customerName: 'Sample customer',
      by: 'bob', __partnerAuth: { name: 'admin', roles: ['admin'], demo: true },
    });
    expect(response.status).toBe(200);
    const { caseId } = await response.json() as { caseId: string };
    expect(state.world.journey.get(caseId).openedBy).toBe('alice');
    expect((await request('bank', `/partner-portal/journey?caseId=${caseId}`)).status).toBe(403);
    expect((await request('agent', '/partner-portal/commission/statement', { id: 'anything', reference: 'X', amount: '1.00', by: 'fin' })).status).toBe(403);
    expect((await request('viewer', '/partner-portal/journey/open', { partnerId: 'DEMO-BROKER', subChannelCode: 'DEMO-BROKER-DESK', customerName: 'Test' })).status).toBe(403);
  });

  it('does not allow a partner to claim somebody else’s unattributed journey or probe guessed case IDs', async () => {
    const direct = state.world.journey.open(state.world, { customerName: 'Direct customer', country: 'AE', currency: 'AED', by: 'other-insurer-operator' });
    const body = { caseId: direct.caseId, partnerId: 'DEMO-BROKER', subChannelCode: 'DEMO-BROKER-DESK' };
    expect((await request('agent', '/partner-portal/journey/attach', body)).status).toBe(403);
    expect(direct.distribution).toBeUndefined();
    expect((await request('agent', `/partner-portal/journey?caseId=${direct.caseId}`)).status).toBe(403);
    expect((await request('agent', '/partner-portal/journey?caseId=JNY-NOT-FOUND')).status).toBe(403);
    expect((await request('admin', '/partner-portal/journey/attach', body)).status).toBe(200);
  });

  it('enforces the reviewer role on the authenticated principal, not the requested role', async () => {
    const opened = await request('agent', '/partner-portal/journey/open', { partnerId: 'DEMO-BROKER', subChannelCode: 'DEMO-BROKER-DESK', customerName: 'Review boundary' });
    const { caseId } = await opened.json() as { caseId: string };
    // Only the HTTP role check is under test; the domain suite exercises real signed submissions.
    const application: PartnerApplication = { id: 'AUTH-TEST', caseId, scope: { partnerId: 'DEMO-BROKER', channelCode: 'BROKER', subChannelCode: 'DEMO-BROKER-DESK' }, applicationId: 'APP', quotationId: 'QUOTE', quotationVersion: 1, fingerprint: 'test', submittedBy: 'alice', submittedAt: state.now(), status: 'pending', review: null, route: null, underwritingReview: null };
    (state.world.partnerPortal as unknown as { applications: PartnerApplication[] }).applications.push(application);
    const payload = { id: application.id, role: 'manager', outcome: 'returned', note: 'Please correct the application.', by: 'bob', __partnerAuth: { demo: true, roles: ['admin'] } };
    expect((await request('agent', '/partner-portal/applications/review', payload)).status).toBe(403);
    expect((await request('supervisor', '/partner-portal/applications/review', payload)).status).toBe(403);
    expect((await request('bank', '/partner-portal/applications/review', payload)).status).toBe(403);
    const allowed = await request('supervisor', '/partner-portal/applications/review', { ...payload, role: 'supervisor' });
    expect(allowed.status).toBe(200);
    expect(((await allowed.json()) as PartnerApplication).review).toMatchObject({ by: 'bob', role: 'supervisor', outcome: 'returned' });
  });

  it('filters workspace records by the selected sub-channel without broadening authority', async () => {
    const open = async (subChannelCode: string) => (await (await request('admin', '/partner-portal/journey/open', { partnerId: 'DEMO-BROKER', subChannelCode, customerName: 'Filtered journey' })).json() as { caseId: string }).caseId;
    const desk = await open('DEMO-BROKER-DESK');
    const other = await open('OTHER-DESK');
    const filtered = await (await request('admin', '/partner-portal/workspace?partnerId=DEMO-BROKER&subChannelCode=OTHER-DESK')).json() as { cases: { items: Array<{ caseId: string }> } };
    expect(filtered.cases.items.map((c) => c.caseId)).toContain(other);
    expect(filtered.cases.items.map((c) => c.caseId)).not.toContain(desk);
    expect((await request('agent', '/partner-portal/workspace?partnerId=DEMO-BROKER&subChannelCode=OTHER-DESK')).status).toBe(403);
  });

  it('does not let a partner operator do insurer underwriting or fabricate settlement records', async () => {
    const response = await request('agent', '/partner-portal/journey/open', { partnerId: 'DEMO-BROKER', subChannelCode: 'DEMO-BROKER-DESK', customerName: 'Test customer' });
    const { caseId } = await response.json() as { caseId: string };
    expect((await request('agent', '/partner-portal/journey/stage', { caseId, stageId: 'uw-review', action: 'submit', answers: {} })).status).toBe(403);
    expect((await request('agent', '/partner-portal/journey/stage', { caseId, stageId: 'medical', action: 'submit', answers: {} })).status).toBe(403);
    expect((await request('service', '/partner-portal/journey/stage', { caseId, stageId: 'medical', action: 'save', answers: {} })).status).toBe(403);
    state.world.journey.get(caseId).answers.medical = { reviewNote: 'confidential medical note' };
    state.world.journey.get(caseId).answers['uw-review'] = { questionnaireNotes: 'confidential underwriting note' };
    const partnerView = await (await request('agent', `/partner-portal/journey?caseId=${caseId}`)).json() as { stages: Array<{ id: string; answers: Record<string, unknown>; fields: unknown[] }> };
    for (const id of ['medical', 'uw-review']) {
      expect(partnerView.stages.find((stage) => stage.id === id)?.answers).toEqual({});
      expect(partnerView.stages.find((stage) => stage.id === id)?.fields).toEqual([]);
    }
    const insurerView = await (await request('underwriter', `/partner-portal/journey?caseId=${caseId}`)).json() as { stages: Array<{ id: string; answers: Record<string, unknown> }> };
    expect(insurerView.stages.find((stage) => stage.id === 'medical')?.answers['reviewNote']).toBe('confidential medical note');

    expect((await request('service', '/partner-portal/journey/stage', { caseId, stageId: 'uw-review', action: 'submit', answers: {} })).status).toBe(403);
    expect((await request('underwriter', '/partner-portal/journey/stage', { caseId, stageId: 'uw-review', action: 'submit', answers: {} })).status).not.toBe(403);
    expect((await request('agent', '/partner-portal/commission/disbursement', { id: 'unknown', amount: '2.00', reference: 'BANK' })).status).toBe(403);
    expect((await request('agent', '/partner-portal/demo/setup', {})).status).toBe(403);
  });

  it('limits revised quotations and acceptance to authorized roles and partner scopes', async () => {
    const id = 'AUTH-TEST'; // Fixture registered by the reviewer-boundary test above.
    expect((await request('agent', '/partner-portal/quotation/reissue', { id, by: 'uw' })).status).toBe(403);
    expect((await request('service', '/partner-portal/quotation/reissue', { id, by: 'uw' })).status).toBe(403);
    expect((await request('viewer', '/partner-portal/quotation/accept', { id, signedBy: 'Customer' })).status).toBe(403);
    expect((await request('bank', '/partner-portal/quotation/accept', { id, signedBy: 'Customer' })).status).toBe(403);
    expect((await request('bank', `/partner-portal/quotation?id=${id}`)).status).toBe(403);
    expect((await request('agent', '/partner-portal/quotation/accept', { id, signedBy: 'Customer' })).status).toBe(409);
    expect((await request('underwriter', '/partner-portal/quotation/reissue', { id })).status).toBe(409);
    expect((await request('agent', `/partner-portal/quotation?id=${id}`)).status).toBe(409);
  });

  it('only allows an authenticated insurer to close an insurer-facing request', async () => {
    const opened = await request('agent', '/partner-portal/requests/open', { partnerId: 'DEMO-BROKER', subChannelCode: 'DEMO-BROKER-DESK', kind: 'reporting-request', subject: 'Report request', message: 'Please send our monthly report.' });
    expect(opened.status).toBe(200);
    const { id } = await opened.json() as { id: string };
    expect((await request('agent', '/partner-portal/requests/reply', { id, from: 'insurer', message: 'The report is ready to send.', close: true })).status).toBe(409);
    // Finance is not a service desk: a dedicated insurer role is needed (or admin).
    expect((await request('finance', '/partner-portal/requests/reply', { id, message: 'The report is ready to send.', close: true })).status).toBe(403);
    expect((await request('admin', '/partner-portal/requests/reply', { id, message: 'The report is ready to send.', close: true })).status).toBe(200);
  });
});
