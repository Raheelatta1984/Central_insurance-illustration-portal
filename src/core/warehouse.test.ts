import { describe, expect, it } from 'vitest';
import { buildWorld } from './demo.js';
import { DataWarehouse } from './warehouse.js';
import { createRuntimeState, dispatchApiRoute } from './routes.js';

describe('single read warehouse', () => {
  it('materialises actual rows and preserves source lineage and grain', () => {
    const world = buildWorld();
    const warehouse = new DataWarehouse();
    const datasets = warehouse.datasets(world);
    expect(datasets).toHaveLength(9);
    for (const d of datasets) {
      expect(d.rowCount, d.id).toBe(d.rows.length);
      expect(d.sample.length, d.id).toBe(Math.min(3, d.rowCount));
      expect(d.lineage.length, d.id).toBeGreaterThan(20);
      expect(d.freshness).toBe(world.asOf);
    }
    const vouchers = datasets.find(d => d.id === 'voucher-fact')!;
    expect(vouchers.rows.length).toBe(world.fundsAccounting.listVouchers().reduce((n, v) => n + v.lines.length, 0));
    expect(vouchers.rows.some(row => row['policy_id'] === 'UL-000123')).toBe(true);
    expect(datasets.find(d => d.id === 'super-fact')?.rows.length).toBe(world.superFunds.listPolicies().length);
    expect(datasets.find(d => d.id === 'fund-fact')?.rows.length).toBeGreaterThan(world.nav.listFunds().length);
  });

  it('exports full CSV/JSON contents with stable content fingerprints and truthful connector status', () => {
    const world = buildWorld();
    const warehouse = new DataWarehouse();
    const dataset = warehouse.datasets(world).find(d => d.id === 'voucher-fact')!;
    const csv = warehouse.exportContent(world, 'voucher-fact', 'csv');
    expect(csv.rows).toBe(dataset.rows.length);
    expect(csv.content.startsWith('voucher_id,event_id,event_type')).toBe(true);
    expect(csv.content).toContain('VCH-0001001');
    expect(csv.bytes).toBe(new TextEncoder().encode(csv.content).length);
    const record = warehouse.requestExport(world, 'voucher-fact', 'csv', 'analyst@example.com');
    expect(record.fingerprint).toBe(csv.fingerprint);
    expect(record.fingerprintAlgorithm).toBe('FNV-1a-64');
    const snapshot = warehouse.snapshot(world);
    expect(snapshot.connectors.every(c => c.status === 'ready-to-configure')).toBe(true);
    expect(snapshot.limitations).toContain('not authenticated');
  });

  it('returns exactly the masked artifact recorded in the export audit trail', async () => {
    const state = createRuntimeState();
    for (const format of ['json', 'csv', 'json']) {
      const result = await dispatchApiRoute(state, 'POST', '/warehouse/export', new URLSearchParams(), { datasetId: 'policy-fact', format });
      expect(result.status).toBe(200);
      const artifact = result.body as { content: string; bytes: number; fingerprint: string; rows: number; maskingMethod: string; maskedColumns: string[] };
      let hash = 0xcbf29ce484222325n;
      for (const byte of new TextEncoder().encode(artifact.content)) {
        hash = BigInt.asUintN(64, (hash ^ BigInt(byte)) * 0x100000001b3n);
      }
      expect(artifact.fingerprint).toBe(hash.toString(16).padStart(16, '0'));
      expect(artifact.bytes).toBe(new TextEncoder().encode(artifact.content).length);
      const [record] = state.world.warehouse.exportsSnapshot();
      expect(record).toMatchObject({ fingerprint: artifact.fingerprint, bytes: artifact.bytes, maskingMethod: artifact.maskingMethod });
      expect(record).not.toHaveProperty('content'); // audit history must not retain large downloads
      if (format === 'json') {
        const parsed = JSON.parse(artifact.content);
        expect(parsed.rows).toHaveLength(artifact.rows);
        expect(parsed.piiMasking.method).toBe(artifact.maskingMethod);
        expect(parsed.piiMasking.maskedColumns).toEqual(artifact.maskedColumns);
      }
    }
  });

  it('refuses unknown datasets rather than returning a made-up empty export', () => {
    const warehouse = new DataWarehouse();
    expect(() => warehouse.exportContent(buildWorld(), 'nope' as never, 'csv')).toThrow(/unknown dataset/);
  });
});
