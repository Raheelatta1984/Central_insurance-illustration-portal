import React, { useState } from 'react';
import type { WorldSnapshot } from '../core/demo';
import { api } from './api';
import { downloadText } from './grid';

export const WarehousePanel: React.FC<{ data: WorldSnapshot; onReload: () => Promise<void> }> = ({ data, onReload }) => {
  const wh = data.warehouse as unknown as {
    asOf: string; datasets: Array<{ id: string; label: string; grain: string; source: string; rowCount: number; columns: string[]; sampleCount: number; lineage: string; freshness: string }>;
    samples: Record<string, Array<Record<string, string>>>;
    dashboards: Array<{ id: string; title: string; tool: string; description: string; kpis: Array<{ label: string; value: string; trend?: string }>; filters: string[]; refresh: string }>;
    exports: Array<{ id: string; datasetId: string; format: string; rows: number; bytes: number; fingerprint: string; exportedAt: string; exportedBy: string }>;
    connectors: Array<{ id: string; label: string; protocol: string; auth: string; tables: number; status: string; lastSync: string }>;
    lineageSummary: string; limitations: string;
  };
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [tab, setTab] = useState<'datasets' | 'dashboards' | 'exports' | 'connectors'>('datasets');
  const [ds, setDs] = useState(wh.datasets[0]?.id ?? 'voucher-fact');

  const run = async (label: string, fn: () => Promise<unknown>) => {
    setBusy(true); setError(null); setNotice(null);
    try { const r = await fn(); await onReload(); setNotice(`${label}: ${JSON.stringify(r).slice(0, 700)}`); } catch (e) { setError(e instanceof Error ? e.message : String(e)); } finally { setBusy(false); }
  };

  const exportDataset = async (format: 'csv' | 'json') => {
    setBusy(true); setError(null); setNotice(null);
    try {
      const result = await api<{ filename: string; content: string; rows: number; bytes: number; fingerprint: string }>('/warehouse/export', 'POST', { datasetId: ds, format, by: 'data-analyst' });
      downloadText(result.filename, result.content, format === 'csv' ? 'text/csv;charset=utf-8' : 'application/json;charset=utf-8');
      await onReload();
      setNotice(`${result.filename} · ${result.rows} rows · ${result.bytes.toLocaleString()} bytes · fingerprint ${result.fingerprint}`);
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
    finally { setBusy(false); }
  };

  const Pill: React.FC<{ tone?: string; children: React.ReactNode }> = ({ tone = 'info', children }) => <span className={`pill ${tone}`}>{children}</span>;

  const activeSample = wh.samples[ds] ?? [];

  return (
    <div className="grid">
      <section className="card" style={{ gridColumn: '1 / -1' }}>
        <header><h3>Data warehouse — single tab for every analyst, engineer & scientist</h3><p className="muted small">One place to answer Power BI, Tableau, QlikView / Qlik Sense, Databricks and Data Fabric questions — nine datasets, five live dashboards, fingerprinted exports and connector health, all from the same warehouse that is itself a projection of the ledger, NAV and registries. As of {wh.asOf}.</p></header>
        <div className="pills">
          <Pill tone="ok">{wh.datasets.length} datasets</Pill>
          <Pill tone="info">{wh.dashboards.length} dashboards</Pill>
          <Pill tone="warn">{wh.exports.length} exports</Pill>
          <Pill tone="info">{wh.connectors.length} BI connector recipes</Pill>
        </div>
        <div className="row" style={{ marginTop: 8 }}>
          {(['datasets', 'dashboards', 'exports', 'connectors'] as const).map(k => (
            <button key={k} className={tab === k ? '' : 'ghost'} onClick={() => setTab(k)}>{k === 'datasets' ? '1. Datasets & lineage' : k === 'dashboards' ? '2. Dashboards (native)' : k === 'exports' ? '3. Exports & fingerprints' : '4. Connectors (Power BI → Data Fabric)'}</button>
          ))}
        </div>
      </section>

      {tab === 'datasets' && (
        <>
          <section className="card" style={{ gridColumn: '1 / -1' }}>
            <h4>Datasets — grain, source, row count, columns, lineage & freshness</h4>
            <div className="tableWrap"><table className="gridTable autoFit"><thead><tr><th>Dataset</th><th>Label</th><th>Grain</th><th>Source</th><th>Rows</th><th>Cols</th><th>Lineage</th><th>Fresh</th></tr></thead><tbody>
              {wh.datasets.map(d => <tr key={d.id} style={d.id === ds ? { background: '#13212f' } : undefined}><td><button className={d.id === ds ? '' : 'ghost'} onClick={() => setDs(d.id)}>{d.id}</button></td><td>{d.label}</td><td className="small muted">{d.grain.slice(0, 70)}</td><td className="small muted">{d.source.slice(0, 60)}</td><td>{d.rowCount}</td><td className="small">{d.columns.slice(0, 4).join(', ')}{d.columns.length > 4 ? ' …' : ''}</td><td className="small muted">{d.lineage.slice(0, 70)}</td><td>{d.freshness}</td></tr>)}
            </tbody></table></div>
            <p className="muted small">{wh.lineageSummary}</p>
            <p className="muted small">Limitations: {wh.limitations}</p>
          </section>
          <section className="card" style={{ gridColumn: '1 / -1' }}>
            <h4>Sample — {ds}</h4>
            <div className="tableWrap"><table className="gridTable autoFit"><thead><tr>{(wh.datasets.find(d => d.id === ds)?.columns ?? []).slice(0, 10).map(c => <th key={c}>{c}</th>)}</tr></thead><tbody>
              {activeSample.map((row, i) => <tr key={i}>{(wh.datasets.find(d => d.id === ds)?.columns ?? []).slice(0, 10).map(c => <td key={c} className="small">{row[c] ?? '—'}</td>)}</tr>)}
              {activeSample.length === 0 && <tr><td colSpan={10} className="muted">No sample — check dataset.</td></tr>}
            </tbody></table></div>
            <div className="row">
              <label>Dataset<select value={ds} onChange={e => setDs(e.target.value)}>{wh.datasets.map(d => <option key={d.id} value={d.id}>{d.id} — {d.label}</option>)}</select></label>
              <button disabled={busy} onClick={() => void exportDataset('csv')}>Download complete CSV</button>
              <button className="ghost" disabled={busy} onClick={() => void exportDataset('json')}>Download JSON</button>
            </div>
          </section>
        </>
      )}

      {tab === 'dashboards' && (
        <section className="card" style={{ gridColumn: '1 / -1' }}>
          <h4>Native dashboards — no Power BI license required to read the KPI</h4>
          <div className="grid" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(320px, 1fr))' }}>
            {wh.dashboards.map(db => (
              <div key={db.id} className="card">
                <h4>{db.title} · <span className="pill info">{db.tool}</span></h4>
                <p className="small muted">{db.description}</p>
                <div className="stat" style={{ flexDirection: 'column', alignItems: 'flex-start' }}>
                  {db.kpis.map(k => <div key={k.label} style={{ display: 'flex', justifyContent: 'space-between', width: '100%' }}><span className="muted small">{k.label}</span><b>{k.value} {k.trend && <span className="pill info">{k.trend}</span>}</b></div>)}
                </div>
                <p className="muted small">Filters: {db.filters.join(' · ')}</p>
                <p className="muted small">Refresh: {db.refresh}</p>
              </div>
            ))}
          </div>
        </section>
      )}

      {tab === 'exports' && (
        <section className="card" style={{ gridColumn: '1 / -1' }}>
          <h4>Exports — fingerprinted, countable, auditable</h4>
          <div className="tableWrap"><table className="gridTable autoFit"><thead><tr><th>Export</th><th>Dataset</th><th>Format</th><th>Rows</th><th>Bytes</th><th>Fingerprint</th><th>At</th><th>By</th></tr></thead><tbody>
            {wh.exports.map(e => <tr key={e.id}><td>{e.id}</td><td>{e.datasetId}</td><td>{e.format}</td><td>{e.rows}</td><td>{(e.bytes / 1024).toFixed(1)} KB</td><td className="small">{e.fingerprint}</td><td className="small">{e.exportedAt.slice(0, 16).replace('T', ' ')}</td><td>{e.exportedBy}</td></tr>)}
            {wh.exports.length === 0 && <tr><td colSpan={8} className="muted">No exports yet — export a dataset from the Datasets tab.</td></tr>}
          </tbody></table></div>
        </section>
      )}

      {tab === 'connectors' && (
        <section className="card" style={{ gridColumn: '1 / -1' }}>
          <h4>Connector health — the same warehouse, every protocol</h4>
          <div className="tableWrap"><table className="gridTable autoFit"><thead><tr><th>Connector</th><th>Protocol</th><th>Auth</th><th>Tables</th><th>Status</th><th>Last sync</th></tr></thead><tbody>
            {wh.connectors.map(c => (
              <tr key={c.id}>
                <td><b>{c.label}</b></td>
                <td className="small muted">{c.protocol}</td>
                <td className="small">{c.auth}</td>
                <td>{c.tables}</td>
                <td><Pill tone={c.status === 'connected' ? 'ok' : 'info'}>{c.status}</Pill></td>
                <td>{c.lastSync}</td>
              </tr>
            ))}
          </tbody></table></div>
          <p className="muted small">These are connection recipes, not authenticated live external sessions. They all point at the same projection; no second ledger is created.</p>
        </section>
      )}

      {notice && <div className="okBox small" style={{ gridColumn: '1 / -1' }}>{notice}</div>}
      {error && <div className="errorBox small" style={{ gridColumn: '1 / -1' }}>{error}</div>}
    </div>
  );
};
