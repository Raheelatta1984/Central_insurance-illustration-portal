import { describe, expect, it } from 'vitest';
import { detectDelimiter, IngestionFabric, inferMapping, parseTable, validateRows } from './ingest.js';

const csv = [
  'full_name,emirates_id,email,date_of_birth',
  'Sara Khalifa,784-1990-7654321-9,sara@example.ae,1990-11-02',
  'Omar Hassan,784-1978-1112223-4,omar@example.ae,1978-06-21',
  'Bad Email,784-1975-2223334-5,not-an-email,1975-03-03',
  ',784-1999-0000000-0,,1999-01-01',
].join('\n');

describe('ingestion fabric', () => {
  it('detects the delimiter of any file a partner sends', () => {
    expect(detectDelimiter('a,b,c')).toBe(',');
    expect(detectDelimiter('a\tb\tc')).toBe('\t');
    expect(detectDelimiter('a|b|c')).toBe('|');
    expect(detectDelimiter('a;b;c')).toBe(';');
  });

  it('parses and infers a typed mapping', () => {
    const table = parseTable(csv);
    expect(table.headers).toEqual(['full_name', 'emirates_id', 'email', 'date_of_birth']);
    const mapping = inferMapping(table);
    expect(mapping.find((m) => m.name === 'email')!.type).toBe('email');
    expect(mapping.find((m) => m.name === 'date_of_birth')!.type).toBe('date');
  });

  it('accepts good rows and quarantines suspects with reasons', () => {
    const table = parseTable(csv);
    const result = validateRows(table.rows, [
      { name: 'full_name', type: 'string', required: true },
      { name: 'emirates_id', type: 'id', required: true },
      { name: 'email', type: 'email', required: true },
      { name: 'date_of_birth', type: 'date' },
    ]);
    expect(result.stats.total).toBe(4);
    expect(result.stats.accepted).toBe(2);
    expect(result.stats.quarantined).toBe(2);
    const reasons = result.quarantined.flatMap((q) => q.errors.map((e) => `${e.column}:${e.message}`));
    expect(reasons.join(' ')).toMatch(/email:not an email address/);
    expect(Object.keys(result.stats.byColumn)).toContain('email');
  });

  it('commits idempotently and suppresses duplicates by natural key', () => {
    const fabric = new IngestionFabric();
    const mapping = {
      source: 'broker', entityType: 'customer',
      fields: [
        { name: 'full_name', type: 'string' as const, required: true },
        { name: 'emirates_id', type: 'id' as const, required: true },
        { name: 'email', type: 'email' as const, required: true },
        { name: 'date_of_birth', type: 'date' as const },
      ],
      naturalKeys: ['emirates_id'],
    };
    const first = fabric.submit({ loadId: 'L1', source: 'broker', submittedAt: '2026-10-01T00:00:00Z', text: csv, mapping });
    expect(fabric.submit({ loadId: 'L1', source: 'broker', submittedAt: '2026-10-01T00:00:00Z', text: csv, mapping }).loadId).toBe('L1');
    const committed = fabric.commit('L1', '2026-10-01T00:10:00Z');
    expect(committed.committedKeys).toHaveLength(first.result.stats.accepted);
    const recommitted = fabric.commit('L1', '2026-10-01T00:20:00Z');
    expect(recommitted.committedAt).toBe('2026-10-01T00:10:00Z');
    expect(recommitted.committedKeys).toHaveLength(2);

    const sameCustomersAgain = [csv.split('\n')[0]!, csv.split('\n')[1]!, csv.split('\n')[2]!].join('\n');
    fabric.submit({ loadId: 'L2', source: 'broker', submittedAt: '2026-10-02T00:00:00Z', text: sameCustomersAgain, mapping });
    const second = fabric.commit('L2', '2026-10-02T00:10:00Z');
    expect(second.duplicatesSuppressed).toBe(2);
    expect(second.committedKeys).toHaveLength(0);
  });

  it('reports anomalies and the supervisor notes in a reconciliation pack', () => {
    const fabric = new IngestionFabric((load) => [`Supervisor reviewed ${load.result.stats.total} rows`]);
    fabric.submit({
      loadId: 'L3', source: 'broker', submittedAt: '2026-10-01T00:00:00Z', text: csv,
      mapping: {
        source: 'broker', entityType: 'customer',
        fields: [
          { name: 'full_name', type: 'string', required: true },
          { name: 'emirates_id', type: 'id', required: true },
          { name: 'email', type: 'email', required: true },
          { name: 'date_of_birth', type: 'date' },
        ],
        naturalKeys: ['emirates_id'],
      },
    });
    fabric.commit('L3', '2026-10-01T00:10:00Z');
    const reconciliation = fabric.reconciliation('L3');
    expect(reconciliation.summary).toMatch(/2\/4 rows accepted/);
    expect(reconciliation.anomalies.join(' ')).toMatch(/quarantined/);
    expect(reconciliation.anomalies.join(' ')).toMatch(/20%|Most common offending columns/);
    expect(reconciliation.supervisorNotes[0]).toMatch(/Supervisor reviewed 4 rows/);
  });
});
