import React, { useMemo, useState } from 'react';
import type { WorldSnapshot } from '../core/demo';
import { api } from './api';

type BatchData = WorldSnapshot['batch'];
type Definition = BatchData['definitions'][number];
type Run = BatchData['runs'][number];

export const BatchPanel: React.FC<{ data: WorldSnapshot; onReload: () => Promise<void> }> = ({ data, onReload }) => {
  const batch = data.batch as BatchData;
  const [eventType, setEventType] = useState('anniversary-mortality');
  const [period, setPeriod] = useState(data.asOf.slice(0, 7));
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [lastRun, setLastRun] = useState<Run | null>(batch.runs[0] ?? null);
  const selected = useMemo(() => batch.definitions.find((d) => d.eventType === eventType) ?? batch.definitions[0], [batch, eventType]);
  const [debit, setDebit] = useState('');
  const [credit, setCredit] = useState('');
  const [rateBps, setRateBps] = useState('');
  const [enabled, setEnabled] = useState(true);

  const choose = (next: string) => {
    setEventType(next);
    const def = batch.definitions.find((d) => d.eventType === next);
    if (def) { setDebit(def.accounting.debitAccount); setCredit(def.accounting.creditAccount); setRateBps(String(def.rateBps)); setEnabled(def.enabled); }
  };

  const run = async (label: string, fn: () => Promise<unknown>) => {
    setBusy(true); setError(null); setNotice(null);
    try { const result = await fn(); await onReload(); setNotice(`${label} — done.`); return result; }
    catch (e) { setError(e instanceof Error ? e.message : String(e)); return null; }
    finally { setBusy(false); }
  };

  const runBatch = () => void run('Batch run', async () => {
    const result = await api<{ run: Run }>('/batch/run', 'POST', { eventType, period, by: 'batch-operator' });
    setLastRun(result.run);
    setNotice(`Batch run ${result.run.id}: ${result.run.posted} posted · ${result.run.skipped} skipped · ${result.run.duplicates} duplicate-skipped · ${result.run.failed} failed. Totals ${JSON.stringify(result.run.totalMinorByCurrency)} (minor units).`);
  });

  const saveSetup = () => void run('Event setup saved', () => api('/batch/setup', 'POST', {
    eventType, debitAccount: debit, creditAccount: credit, rateBps: Number(rateBps), enabled, by: 'batch-admin',
  }));

  const pill = (tone: string, text: string) => <span className={`pill ${tone}`}>{text}</span>;

  return (
    <div className="grid">
      <section className="card" style={{ gridColumn: '1 / -1' }}>
        <header><h3>Batch processing — quotations, issuance & monthly anniversaries</h3>
          <p className="muted small">Every event is set up once in event-based accounting (debit, credit, schedule, basis, rate, applicable statuses), then run over each single quotation and policy. A policy keeps being processed only until it lapses, is fully withdrawn or is surrendered — then it is reported <b>skipped-terminal</b>, never charged. Clawback is the one job that targets leavers.</p></header>
        <div className="pills">
          {pill('ok', `${batch.definitions.length} events set up`)}
          {pill('info', `${batch.subjects.length} subjects (quotations + policies)`)}
          {pill('warn', `${batch.runs.length} runs on file`)}
          {pill('info', `stops at: ${batch.terminalStatuses.join(', ')}`)}
        </div>
        <div className="row" style={{ marginTop: 10 }}>
          <label>Event
            <select value={eventType} onChange={(e) => choose(e.target.value)}>
              {batch.definitions.map((d) => <option key={d.eventType} value={d.eventType}>{d.label}</option>)}
            </select>
          </label>
          <label>Period (YYYY-MM or YYYY-MM-DD)<input value={period} onChange={(e) => setPeriod(e.target.value)} placeholder="2026-10" /></label>
          <button disabled={busy} onClick={runBatch}>▶ Run batch</button>
          <button className="ghost" disabled={busy} onClick={() => void onReload()}>Refresh</button>
        </div>
        <p className="muted small" style={{ marginTop: 8 }}>{batch.rule}</p>
      </section>

      {selected && (
        <section className="card" style={{ gridColumn: '1 / -1' }}>
          <h4>Event-based accounting setup — {selected.label}</h4>
          <div className="row">
            <label>Debit account<input value={debit || selected.accounting.debitAccount} onChange={(e) => setDebit(e.target.value)} /></label>
            <label>Credit account<input value={credit || selected.accounting.creditAccount} onChange={(e) => setCredit(e.target.value)} /></label>
            <label>Rate (bps of basis)<input type="number" value={rateBps || String(selected.rateBps)} onChange={(e) => setRateBps(e.target.value)} /></label>
            <label>Enabled<input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} /></label>
            <button disabled={busy} onClick={saveSetup}>Save setup</button>
          </div>
          <div className="tableWrap"><table className="gridTable autoFit"><thead><tr><th>Event</th><th>Applies to</th><th>Schedule</th><th>Basis</th><th>Rate</th><th>Debit</th><th>Credit</th><th>Status</th><th>Updated</th></tr></thead><tbody>
            {batch.definitions.map((d: Definition) => (
              <tr key={d.id} style={d.eventType === eventType ? { background: '#13212f' } : undefined}>
                <td><button className={d.eventType === eventType ? '' : 'ghost'} onClick={() => choose(d.eventType)}>{d.label}</button></td>
                <td>{d.subjectKind}</td><td className="small">{d.schedule}</td><td className="small muted">{d.basis}</td>
                <td>{d.rateBps} bps</td><td className="small">{d.accounting.debitAccount}</td><td className="small">{d.accounting.creditAccount}</td>
                <td>{d.enabled ? pill('ok', 'enabled') : pill('bad', 'disabled')}</td><td className="small muted">{d.updatedBy} · {d.updatedAt.slice(0, 10)}</td>
              </tr>
            ))}
          </tbody></table></div>
        </section>
      )}

      <section className="card" style={{ gridColumn: '1 / -1' }}>
        <h4>Subjects in scope — quotations & policies (terminal subjects stay visible so the stop-rule is auditable)</h4>
        <div className="tableWrap"><table className="gridTable autoFit"><thead><tr><th>Subject</th><th>Kind</th><th>Status</th><th>Product</th><th>Currency</th><th>Basis (minor)</th><th>Anniversary day</th></tr></thead><tbody>
          {batch.subjects.map((s) => (
            <tr key={`${s.kind}-${s.id}`}><td>{s.id}</td><td>{s.kind}</td>
              <td>{batch.terminalStatuses.includes(s.status) ? pill('warn', s.status) : pill('ok', s.status)}</td>
              <td>{s.productId}</td><td>{s.currency}</td><td>{String(s.basisMinor)}</td><td>{s.anniversaryDay}</td></tr>
          ))}
        </tbody></table></div>
      </section>

      {lastRun && (
        <section className="card" style={{ gridColumn: '1 / -1' }}>
          <h4>Latest run {lastRun.id} — {lastRun.eventType} · {lastRun.period} · by {lastRun.by}</h4>
          <div className="pills">{pill('ok', `${lastRun.posted} posted`)}{pill('warn', `${lastRun.skipped} skipped`)}{pill('info', `${lastRun.duplicates} duplicate-skipped`)}{pill(lastRun.failed ? 'bad' : 'info', `${lastRun.failed} failed`)}</div>
          <div className="tableWrap"><table className="gridTable autoFit"><thead><tr><th>Subject</th><th>Status</th><th>Amount (minor)</th><th>Debit</th><th>Credit</th><th>Voucher</th><th>Reason</th></tr></thead><tbody>
            {lastRun.lines.map((l, i) => (
              <tr key={i}><td>{l.subjectId}</td>
                <td>{l.status === 'posted' ? pill('ok', l.status) : l.status === 'failed' ? pill('bad', l.status) : pill('warn', l.status)}</td>
                <td>{l.amountMinor} {l.currency}</td><td className="small">{l.debitAccount}</td><td className="small">{l.creditAccount}</td>
                <td>{l.voucherRef ?? '—'}</td><td className="small muted">{l.reason}</td></tr>
            ))}
          </tbody></table></div>
        </section>
      )}

      <section className="card" style={{ gridColumn: '1 / -1' }}>
        <h4>Run history</h4>
        <div className="tableWrap"><table className="gridTable autoFit"><thead><tr><th>Run</th><th>Event</th><th>Period</th><th>Posted</th><th>Skipped</th><th>Duplicates</th><th>Failed</th><th>Totals (minor)</th><th>By</th></tr></thead><tbody>
          {batch.runs.map((r) => <tr key={r.id}><td><button className="ghost" onClick={() => setLastRun(r)}>{r.id}</button></td><td>{r.eventType}</td><td>{r.period}</td><td>{r.posted}</td><td>{r.skipped}</td><td>{r.duplicates}</td><td>{r.failed}</td><td className="small">{JSON.stringify(r.totalMinorByCurrency)}</td><td>{r.by}</td></tr>)}
          {batch.runs.length === 0 && <tr><td colSpan={9} className="muted">No runs yet — pick an event and period above and run the first batch. Running the same period twice is safe: the second run reports duplicate-skipped.</td></tr>}
        </tbody></table></div>
      </section>

      {notice && <div className="okBox small" style={{ gridColumn: '1 / -1' }}>{notice}</div>}
      {error && <div className="errorBox small" style={{ gridColumn: '1 / -1' }}>{error}</div>}
    </div>
  );
};
