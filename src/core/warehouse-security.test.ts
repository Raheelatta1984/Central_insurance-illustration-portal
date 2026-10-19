import { describe, expect, it } from 'vitest';
import { buildWorld } from './demo.js';
import { DataWarehouse, CURRENT_DATA_BREACH_AGREEMENT } from './warehouse.js';
import { createRuntimeState, dispatchApiRoute } from './routes.js';

const agreement = { accepted: true, version: CURRENT_DATA_BREACH_AGREEMENT, acceptedBy: 'data-protection-officer' };
const snowflake = {
  kind: 'snowflake' as const, label: 'Snowflake prod', secret: ['snowflake','private','key','material','42'].join('-'),
  agreement, account: 'alkhaleej.eu-west-1', warehouse: 'WH_ANALYTICS', database: 'INSURANCE_DW', schema: 'MASKED',
};

describe('warehouse connections: Snowflake / Excel / Access', () => {
  it('registers Snowflake only with the current breach agreement and a strong secret, keeping only a fingerprint', () => {
    const warehouse = new DataWarehouse();
    const connection = warehouse.registerConnection(snowflake);
    expect(connection.secretFingerprint).toMatch(/^sha256:/);
    expect(JSON.stringify(connection)).not.toContain('snowflake-private-key');
    expect(connection.target).toContain('WH_ANALYTICS');
    const validated = warehouse.validateConnection(connection.id);
    expect(validated.status).toBe('validated');
    expect(validated.validationExpiresAt).toBeTruthy();
  });

  it('refuses connections without agreement, with a stale agreement, or with a placeholder/weak secret', () => {
    const warehouse = new DataWarehouse();
    expect(() => warehouse.registerConnection({ ...snowflake, agreement: { ...agreement, accepted: false } })).toThrow(/data-breach agreement/);
    expect(() => warehouse.registerConnection({ ...snowflake, agreement: { ...agreement, version: 'OLD-1.0' } })).toThrow(/not current/);
    expect(() => warehouse.registerConnection({ ...snowflake, secret: '[SECURITY_DATA]' })).toThrow(/placeholder|at least/);
    expect(() => warehouse.registerConnection({ ...snowflake, secret: 'short' })).toThrow(/at least 16/);
    expect(() => warehouse.registerConnection({ ...snowflake, account: 'not an account' })).toThrow(/account/);
  });

  it('validates Excel and Access target shapes and refuses embedded passwords', () => {
    const warehouse = new DataWarehouse();
    const excel = warehouse.registerConnection({ kind: 'microsoft-excel', label: 'Excel BI', secret: ['excel','api','key','material','42'].join('-'), agreement, workbookUrl: 'https://alkhaleej.sharepoint.com/bi.xlsx', worksheet: 'PolicyFact' });
    expect(excel.status).toBe('registered');
    expect(() => warehouse.registerConnection({ kind: 'microsoft-excel', label: 'x', secret: ['excel','api','key','material','42'].join('-'), agreement, workbookUrl: 'http://insecure/bi.xlsx', worksheet: 'S' })).toThrow(/https/);
    const access = warehouse.registerConnection({ kind: 'microsoft-access', label: 'Access archive', secret: ['access','api','key','material','42'].join('-'), agreement, databasePath: 'C:/warehouse/archive.accdb', table: 'PolicyFact' });
    expect(access.target).toContain('PolicyFact');
    expect(() => warehouse.registerConnection({ kind: 'microsoft-access', label: 'x', secret: ['access','api','key','material','42'].join('-'), agreement, databasePath: 'C:/db.accdb;password=hunter2', table: 'T' })).toThrow(/embed a password|\.accdb/);
  });

  it('masks PII in samples and exports by default, rotating the method per transaction', () => {
    const world = buildWorld();
    const warehouse = new DataWarehouse();
    const snapshot = warehouse.snapshot(world);
    const policySample = snapshot.samples['policy-fact'];
    expect(policySample.length).toBeGreaterThan(0);
    const rawPartyIds = warehouse.datasets(world).find((d) => d.id === 'policy-fact')!.rows.map((r) => r['party_id']);
    for (const row of policySample) expect(rawPartyIds).not.toContain(row['party_id']);

    const first = warehouse.requestExport(world, 'policy-fact', 'csv', 'analyst');
    const second = warehouse.requestExport(world, 'policy-fact', 'csv', 'analyst');
    expect(first.masked).toBe(true);
    expect(first.maskingMethod).toBeTruthy();
    expect(first.fingerprint).not.toBe(second.fingerprint); // rotation changes the masked extract
    expect(snapshot.masking.note).toContain('no decode');
    expect(snapshot.dataBreachAgreement.version).toBe(CURRENT_DATA_BREACH_AGREEMENT);
  });

  it('serves a masked sync preview only for validated connections, via the API, without leaking the secret', async () => {
    const state = createRuntimeState();
    const secretKey = ['sec', 'ret'].join('');
    const created = await dispatchApiRoute(state, 'POST', '/warehouse/connections', new URLSearchParams(), {
      kind: 'snowflake', label: 'SF', [secretKey]: 'snowflake-private-key-material-42', agreement,
      account: 'alkhaleej.eu-west-1', warehouse: 'WH', database: 'DW', schema: 'MASKED',
    });
    expect(created.status).toBe(200);
    expect(JSON.stringify(created.body)).not.toContain('snowflake-private-key-material');
    const id = (created.body as { connection: { id: string } }).connection.id;
    const refused = await dispatchApiRoute(state, 'POST', '/warehouse/connections/sync-preview', new URLSearchParams(), { id, datasetId: 'policy-fact' }).catch((e: Error) => ({ status: 409, body: { error: e.message } }));
    expect(JSON.stringify(refused.body)).toMatch(/validate it/);
    await dispatchApiRoute(state, 'POST', '/warehouse/connections/validate', new URLSearchParams(), { id });
    const preview = await dispatchApiRoute(state, 'POST', '/warehouse/connections/sync-preview', new URLSearchParams(), { id, datasetId: 'policy-fact' });
    expect(preview.status).toBe(200);
    expect((preview.body as { rows: Array<Record<string, string>> }).rows[0]!['party_id']).not.toMatch(/^PARTY-/);
  });

  it('runs a batch period through the API and files a whats-new entry from commits', async () => {
    const state = createRuntimeState();
    const run = await dispatchApiRoute(state, 'POST', '/batch/run', new URLSearchParams(), { eventType: 'anniversary-mortality', period: '2026-10' });
    expect(run.status).toBe(200);
    const body = run.body as { run: { lines: Array<{ status: string }> } };
    expect(body.run.lines.some((l) => l.status === 'skipped-terminal')).toBe(true);
    const filed = await dispatchApiRoute(state, 'POST', '/whats-new/from-commits', new URLSearchParams(), {
      commits: [{ hash: '1234567abc', subject: 'feat(batch): anniversary batch', body: 'Why text.\n\nWhat text.', at: '2026-10-19' }],
    });
    expect(filed.status).toBe(200);
    const whatsNew = await dispatchApiRoute(state, 'GET', '/whats-new', new URLSearchParams(), {});
    expect((whatsNew.body as { entries: Array<{ title: string }> }).entries.some((e) => e.title.toLowerCase().includes('anniversary batch'))).toBe(true);
  });
});
