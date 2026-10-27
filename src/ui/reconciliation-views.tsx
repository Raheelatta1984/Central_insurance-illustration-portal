import React, { useMemo, useState } from 'react';
import type { WorldSnapshot } from '../core/demo';
import type { IdentityField } from '../core/reconciliation/column-mapping';
import { api } from './api';
import { SectionGroup, type SectionGate } from './sections';

type ReconciliationSnap = WorldSnapshot['reconciliation'];
type MappingRecord = ReconciliationSnap['mappings'][number];
type RunRecord = ReconciliationSnap['runs'][number];

function parseRowBlock(text: string, prefix: string): Array<{ rowId: string; policyNumber: string | null; insuredName: string | null }> {
  return text
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line, idx) => {
      const parts = line.split('|').map((p) => p.trim());
      if (parts.length >= 3) {
        return {
          rowId: parts[0] || `${prefix}-${idx + 1}`,
          policyNumber: parts[1] ? parts[1] : null,
          insuredName: parts[2] ? parts[2] : null,
        };
      }
      if (parts.length === 2) {
        return {
          rowId: `${prefix}-${idx + 1}`,
          policyNumber: parts[0] ? parts[0] : null,
          insuredName: parts[1] ? parts[1] : null,
        };
      }
      return {
        rowId: `${prefix}-${idx + 1}`,
        policyNumber: parts[0] ? parts[0] : null,
        insuredName: null,
      };
    });
}

const DEFAULT_PARTNER_ROWS = [
  'P-ROW-101 | pol-2026-00801 | Mariam Al Suwaidi',
  'P-ROW-102 | POL-000805 | Rashid Al Falasi',
  'P-ROW-103A | POL-2026-00810 | Khalid Al Ketbi',
  'P-ROW-103B | POL-2026-00810 | Khalid Al Ketbi',
  'P-ROW-104 | POL-2026-00819 | Layla Al Mazrouei',
].join('\n');

const DEFAULT_INSURER_ROWS = [
  'I-ROW-101 | POL-2026-00801 | MARIAM AL SUWAIDI',
  'I-ROW-102 | POL-805 | RASHID AL FALASI',
  'I-ROW-103 | POL-2026-00810 | KHALID AL KETBI',
  'I-ROW-104 | POL-2026-00818 | Layla Al Mazrouey',
].join('\n');

export const ReconciliationPanel: React.FC<{
  data: WorldSnapshot;
  onReload: () => Promise<void>;
  readOnly?: boolean;
}> = ({ data, onReload, readOnly = false }) => {
  const recon = data.reconciliation;
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  // 1. Channel / sub-channel type form
  const [typeInsurerId, setTypeInsurerId] = useState(recon.insurers[0]?.insurerId ?? 'ALK-CONV');
  const [parentChannelCode, setParentChannelCode] = useState('');
  const [typeCode, setTypeCode] = useState('affinity');
  const [typeName, setTypeName] = useState('Corporate Affinity Scheme');

  // 2. Identity column mapping form
  const [mapInsurerId, setMapInsurerId] = useState(recon.insurers[0]?.insurerId ?? 'ALK-CONV');
  const [sourceLabel, setSourceLabel] = useState('BROKER-NOVEMBER-2026.csv');
  const [headersCsv, setHeadersCsv] = useState(
    'Policy Number, Insured Name, Insurer, Line of Business, Gross Premium, Commission %, Net Payable',
  );
  const [selectedMappingId, setSelectedMappingId] = useState(recon.mappings[0]?.mappingId ?? '');
  const selectedMapping: MappingRecord | undefined = useMemo(
    () => recon.mappings.find((m) => m.mappingId === selectedMappingId) ?? recon.mappings[0],
    [recon.mappings, selectedMappingId],
  );
  const [assignmentDraft, setAssignmentDraft] = useState<Partial<Record<IdentityField, string>>>({});

  // 3. Identity matching runner
  const [scopeInsurerId, setScopeInsurerId] = useState('ALK-CONV');
  const rootPartners = useMemo(
    () => recon.partners.filter((p) => p.insurerId === scopeInsurerId && p.parentPartnerId === null),
    [recon.partners, scopeInsurerId],
  );
  const [scopeRootPartnerId, setScopeRootPartnerId] = useState('MARSH-UAE');
  const subPartners = useMemo(
    () => recon.partners.filter((p) => p.insurerId === scopeInsurerId && p.channelPartnerId === scopeRootPartnerId && p.parentPartnerId !== null),
    [recon.partners, scopeInsurerId, scopeRootPartnerId],
  );
  const [scopeSubpartnerId, setScopeSubpartnerId] = useState('MARSH-UAE-AGENCY');
  const [scopeInsuranceClass, setScopeInsuranceClass] = useState('life');
  const [partnerRowsText, setPartnerRowsText] = useState(DEFAULT_PARTNER_ROWS);
  const [insurerRowsText, setInsurerRowsText] = useState(DEFAULT_INSURER_ROWS);
  const [selectedRunId, setSelectedRunId] = useState(recon.runs[0]?.runId ?? '');
  const selectedRun: RunRecord | undefined = useMemo(
    () => recon.runs.find((r) => r.runId === selectedRunId) ?? recon.runs[0],
    [recon.runs, selectedRunId],
  );

  // 4. Proposal human review note
  const [reviewNote, setReviewNote] = useState('Verified policy endorsement typo against signed schedule; identity only.');

  const execute = async (label: string, fn: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      await fn();
      await onReload();
      setNotice(`${label} saved.`);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const addType = () =>
    void execute('Channel / sub-channel reference type', async () => {
      await api('/reconciliation/channel-type', 'POST', {
        insurerId: typeInsurerId,
        code: typeCode,
        name: typeName,
        parentChannelTypeCode: parentChannelCode || null,
      });
    });

  const proposeColumns = () =>
    void execute('Identity column proposal', async () => {
      const res = await api<{ mapping: MappingRecord }>('/reconciliation/columns/propose', 'POST', {
        insurerId: mapInsurerId,
        sourceLabel,
        headersCsv,
      });
      setSelectedMappingId(res.mapping.mappingId);
      const nextDraft: Partial<Record<IdentityField, string>> = {};
      for (const s of res.mapping.suggestions) {
        if (s.candidates.length === 1) nextDraft[s.field] = String(s.candidates[0]!.index);
      }
      setAssignmentDraft(nextDraft);
    });

  const confirmColumns = (mapping: MappingRecord) =>
    void execute(`Confirmed ${mapping.mappingId}`, async () => {
      const assignments: Partial<Record<IdentityField, number | null>> = {};
      for (const s of mapping.suggestions) {
        const draftVal = assignmentDraft[s.field];
        const fallback = mapping.confirmedAssignments?.[s.field]?.index ?? (s.candidates.length === 1 ? s.candidates[0]!.index : null);
        const raw = draftVal !== undefined ? draftVal : fallback !== null && fallback !== undefined ? String(fallback) : '';
        assignments[s.field] = raw === '' ? null : Number(raw);
      }
      await api('/reconciliation/columns/confirm', 'POST', {
        mappingId: mapping.mappingId,
        assignments,
      });
    });

  const runMatch = () =>
    void execute('Scoped identity matching run', async () => {
      const res = await api<{ run: RunRecord }>('/reconciliation/identity/match', 'POST', {
        scope: {
          insurerId: scopeInsurerId,
          channelPartnerId: scopeRootPartnerId,
          subpartnerId: scopeSubpartnerId || null,
          insuranceClass: scopeInsuranceClass,
        },
        partnerRows: parseRowBlock(partnerRowsText, 'P-ROW'),
        insurerRows: parseRowBlock(insurerRowsText, 'I-ROW'),
      });
      setSelectedRunId(res.run.runId);
    });

  const reviewProposal = (runId: string, leftRowId: string, rightRowId: string, decision: 'confirm' | 'reject') =>
    void execute(`Proposal ${decision}`, async () => {
      await api('/reconciliation/proposals/review', 'POST', {
        runId,
        leftRowId,
        rightRowId,
        decision,
        note: reviewNote,
      });
    });

  const gates: SectionGate[] = [
    {
      id: 'scope-hierarchy',
      title: 'Insurer channel types & partner ownership scope',
      subtitle: `${recon.channelTypes.length} channel types · ${recon.subchannelTypes.length} sub-channel types · ${recon.partners.length} partner nodes`,
      done: recon.partners.length > 0,
      badges: <span className="pill ok">ownership-scoped</span>,
      children: (
        <div>
          <p className="muted small">
            Insurers configure channel and sub-channel codes as reference data (never fixed SQL enums), and every sub-partner carries an immutable root <code>channelPartnerId</code> under the same insurer.
          </p>
          {!readOnly && (
            <div className="row" style={{ marginTop: 10 }}>
              <label>
                Insurer
                <select value={typeInsurerId} onChange={(e) => setTypeInsurerId(e.target.value)}>
                  {recon.insurers.map((ins) => (
                    <option key={ins.insurerId} value={ins.insurerId}>{ins.insurerId} — {ins.name}</option>
                  ))}
                </select>
              </label>
              <label>
                Parent channel (leave blank for top-level channel)
                <select value={parentChannelCode} onChange={(e) => setParentChannelCode(e.target.value)}>
                  <option value="">(Top-level channel type)</option>
                  {recon.channelTypes.filter((c) => c.insurerId === typeInsurerId).map((c) => (
                    <option key={c.code} value={c.code}>{c.code} — {c.name}</option>
                  ))}
                </select>
              </label>
              <label>
                Type code
                <input value={typeCode} onChange={(e) => setTypeCode(e.target.value)} placeholder="affinity" />
              </label>
              <label>
                Display name
                <input value={typeName} onChange={(e) => setTypeName(e.target.value)} placeholder="Corporate Affinity Scheme" />
              </label>
              <button disabled={busy || !recon.featureGate.enabled} onClick={addType}>Add reference type</button>
            </div>
          )}
          <div className="tableWrap" style={{ marginTop: 10 }}>
            <table className="gridTable autoFit">
              <thead>
                <tr>
                  <th>Insurer</th>
                  <th>Partner ID</th>
                  <th>Root Partner</th>
                  <th>Parent</th>
                  <th>Channel Type</th>
                  <th>Sub-Channel Type</th>
                  <th>Name</th>
                </tr>
              </thead>
              <tbody>
                {recon.partners.map((p) => (
                  <tr key={`${p.insurerId}:${p.partnerId}`}>
                    <td><code>{p.insurerId}</code></td>
                    <td><b>{p.partnerId}</b></td>
                    <td><code>{p.channelPartnerId}</code></td>
                    <td>{p.parentPartnerId ? <code>{p.parentPartnerId}</code> : <span className="pill info">root</span>}</td>
                    <td>{p.channelTypeCode}</td>
                    <td>{p.subchannelTypeCode ?? '—'}</td>
                    <td>{p.name}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      ),
    },
    {
      id: 'column-mapping',
      title: 'Identity-only header mapping & human confirmation',
      subtitle: `${recon.mappings.length} mapping(s) · financial columns explicitly ignored`,
      done: recon.mappings.some((m) => m.confirmed),
      badges: <span className="pill info">{recon.mappings.filter((m) => m.confirmed).length} confirmed</span>,
      children: (
        <div>
          <p className="muted small">
            Only the four non-financial identity fields (<code>policyNumber</code>, <code>insuredName</code>, <code>insurer</code>, <code>insuranceClass</code>) are suggested. Any premium, commission, rate, tax or payable column is ignored and never auto-confirmed.
          </p>
          {!readOnly && (
            <div className="row" style={{ marginTop: 10 }}>
              <label>
                Insurer
                <select value={mapInsurerId} onChange={(e) => setMapInsurerId(e.target.value)}>
                  {recon.insurers.map((ins) => (
                    <option key={ins.insurerId} value={ins.insurerId}>{ins.insurerId}</option>
                  ))}
                </select>
              </label>
              <label>
                Source file label
                <input value={sourceLabel} onChange={(e) => setSourceLabel(e.target.value)} />
              </label>
              <label style={{ flex: 2 }}>
                CSV headers (comma-separated)
                <input value={headersCsv} onChange={(e) => setHeadersCsv(e.target.value)} />
              </label>
              <button disabled={busy || !recon.featureGate.enabled} onClick={proposeColumns}>Propose identity columns</button>
            </div>
          )}

          {recon.mappings.length > 0 && (
            <div style={{ marginTop: 12 }}>
              <div className="row">
                <label>
                  Inspect mapping
                  <select value={selectedMapping?.mappingId ?? ''} onChange={(e) => setSelectedMappingId(e.target.value)}>
                    {recon.mappings.map((m) => (
                      <option key={m.mappingId} value={m.mappingId}>
                        {m.mappingId} — {m.sourceLabel} ({m.confirmed ? 'confirmed' : 'awaiting human confirmation'})
                      </option>
                    ))}
                  </select>
                </label>
                {selectedMapping && !readOnly && (
                  <button disabled={busy || !recon.featureGate.enabled} onClick={() => confirmColumns(selectedMapping)}>
                    {selectedMapping.confirmed ? 'Re-confirm column mapping' : 'Confirm identity mapping'}
                  </button>
                )}
              </div>

              {selectedMapping && (
                <>
                  <div className="pills" style={{ marginTop: 8 }}>
                    <span className={`pill ${selectedMapping.confirmed ? 'ok' : 'warn'}`}>
                      {selectedMapping.confirmed ? `Confirmed by ${selectedMapping.confirmedBy}` : 'Unconfirmed proposal — requires human sign-off'}
                    </span>
                    {selectedMapping.ignoredNonIdentityHeaders.length > 0 && (
                      <span className="pill info">
                        Ignored non-identity/financial headers: {selectedMapping.ignoredNonIdentityHeaders.map((h) => h.header).join(', ')}
                      </span>
                    )}
                  </div>
                  <div className="tableWrap" style={{ marginTop: 8 }}>
                    <table className="gridTable autoFit">
                      <thead>
                        <tr>
                          <th>Identity Field</th>
                          <th>Suggestion Status</th>
                          <th>Candidates</th>
                          <th>Human Assignment</th>
                        </tr>
                      </thead>
                      <tbody>
                        {selectedMapping.suggestions.map((s) => {
                          const currentVal = assignmentDraft[s.field]
                            ?? (selectedMapping.confirmedAssignments?.[s.field] !== undefined
                              ? String(selectedMapping.confirmedAssignments[s.field]!.index)
                              : s.candidates.length === 1 ? String(s.candidates[0]!.index) : '');
                          return (
                            <tr key={s.field}>
                              <td><code>{s.field}</code></td>
                              <td><span className={`pill ${s.status === 'suggested' ? 'ok' : s.status === 'ambiguous' ? 'warn' : 'info'}`}>{s.status}</span></td>
                              <td>{s.candidates.length > 0 ? s.candidates.map((c) => `#${c.index}: ${c.header}`).join(' | ') : '—'}</td>
                              <td>
                                <select
                                  disabled={readOnly}
                                  value={currentVal}
                                  onChange={(e) => setAssignmentDraft((prev) => ({ ...prev, [s.field]: e.target.value }))}
                                >
                                  <option value="">(Unassigned)</option>
                                  {selectedMapping.headers.map((hdr, idx) => (
                                    <option key={`${idx}-${hdr}`} value={String(idx)}>#{idx} — {hdr}</option>
                                  ))}
                                </select>
                              </td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>
                </>
              )}
            </div>
          )}
        </div>
      ),
    },
    {
      id: 'identity-matching',
      title: 'Scoped deterministic policy identity matching & duplicate quarantine',
      subtitle: selectedRun
        ? `${selectedRun.runId}: ${selectedRun.summary.exactMatchCount} exact · ${selectedRun.summary.safeVariantMatchCount} safe variant · ${selectedRun.summary.quarantinedFindingCount} quarantined`
        : 'Run scoped identity matching',
      done: recon.runs.length > 0,
      badges: <span className="pill ok">{recon.runs.length} run(s)</span>,
      children: (
        <div>
          {!readOnly && (
            <div>
              <div className="row">
                <label>
                  Insurer
                  <select
                    value={scopeInsurerId}
                    onChange={(e) => {
                      const nextIns = e.target.value;
                      setScopeInsurerId(nextIns);
                      const firstRoot = recon.partners.find((p) => p.insurerId === nextIns && p.parentPartnerId === null);
                      setScopeRootPartnerId(firstRoot?.partnerId ?? '');
                      setScopeSubpartnerId('');
                    }}
                  >
                    {recon.insurers.map((ins) => (
                      <option key={ins.insurerId} value={ins.insurerId}>{ins.insurerId}</option>
                    ))}
                  </select>
                </label>
                <label>
                  Root channel partner
                  <select
                    value={scopeRootPartnerId}
                    onChange={(e) => {
                      setScopeRootPartnerId(e.target.value);
                      setScopeSubpartnerId('');
                    }}
                  >
                    {rootPartners.map((p) => (
                      <option key={p.partnerId} value={p.partnerId}>{p.partnerId} — {p.name}</option>
                    ))}
                  </select>
                </label>
                <label>
                  Sub-partner (optional)
                  <select value={scopeSubpartnerId} onChange={(e) => setScopeSubpartnerId(e.target.value)}>
                    <option value="">(All / Root partner level)</option>
                    {subPartners.map((p) => (
                      <option key={p.partnerId} value={p.partnerId}>{p.partnerId} — {p.name}</option>
                    ))}
                  </select>
                </label>
                <label>
                  Insurance class
                  <select value={scopeInsuranceClass} onChange={(e) => setScopeInsuranceClass(e.target.value)}>
                    {recon.insuranceClasses.map((cls) => (
                      <option key={cls} value={cls}>{cls}</option>
                    ))}
                  </select>
                </label>
                <button disabled={busy || !recon.featureGate.enabled} onClick={runMatch}>Run scoped identity match</button>
              </div>
              <div className="row" style={{ marginTop: 8 }}>
                <label style={{ flex: 1 }}>
                  Partner statement identity rows (<code>rowId | policyNumber | insuredName</code>)
                  <textarea rows={5} value={partnerRowsText} onChange={(e) => setPartnerRowsText(e.target.value)} />
                </label>
                <label style={{ flex: 1 }}>
                  Insurer bordereau identity rows (<code>rowId | policyNumber | insuredName</code>)
                  <textarea rows={5} value={insurerRowsText} onChange={(e) => setInsurerRowsText(e.target.value)} />
                </label>
              </div>
            </div>
          )}

          {selectedRun && (
            <div style={{ marginTop: 12 }}>
              <div className="row">
                <label>
                  Active run
                  <select value={selectedRun.runId} onChange={(e) => setSelectedRunId(e.target.value)}>
                    {recon.runs.map((r) => (
                      <option key={r.runId} value={r.runId}>
                        {r.runId} ({r.scope.insurerId}/{r.scope.channelPartnerId}{r.scope.subpartnerId ? `/${r.scope.subpartnerId}` : ''}/{r.scope.insuranceClass})
                      </option>
                    ))}
                  </select>
                </label>
              </div>
              <div className="pills" style={{ marginTop: 8 }}>
                <span className="pill ok">{selectedRun.summary.exactMatchCount} exact</span>
                <span className="pill ok">{selectedRun.summary.safeVariantMatchCount} corroborated zero-padding</span>
                <span className="pill warn">{selectedRun.summary.quarantinedFindingCount} quarantined duplicate/ambiguous</span>
                <span className="pill info">{selectedRun.summary.pendingProposalCount} pending proposal(s)</span>
                <span className="pill info">{selectedRun.summary.confirmedProposalCount} human-confirmed proposal(s)</span>
                <span className="pill info">Unmatched: {selectedRun.summary.unmatchedPartnerCount} partner / {selectedRun.summary.unmatchedInsurerCount} insurer</span>
              </div>

              <div className="tableWrap" style={{ marginTop: 8 }}>
                <table className="gridTable autoFit">
                  <thead>
                    <tr>
                      <th>Partner Row</th>
                      <th>Insurer Row</th>
                      <th>Match Kind</th>
                      <th>Normalized Policy Key</th>
                    </tr>
                  </thead>
                  <tbody>
                    {selectedRun.matches.map((m) => {
                      const leftRow = selectedRun.partnerRows.find((r) => r.rowId === m.leftRowId);
                      return (
                        <tr key={`${m.leftRowId}-${m.rightRowId}`}>
                          <td><code>{m.leftRowId}</code></td>
                          <td><code>{m.rightRowId}</code></td>
                          <td><span className="pill ok">{m.kind}</span></td>
                          <td><code>{leftRow?.normalizedPolicyNumber ?? '—'}</code></td>
                        </tr>
                      );
                    })}
                    {selectedRun.matches.length === 0 && (
                      <tr><td colSpan={4} className="muted">No deterministic matches on this run.</td></tr>
                    )}
                  </tbody>
                </table>
              </div>

              {selectedRun.findings.length > 0 && (
                <div className="warnBox small" style={{ marginTop: 8 }}>
                  <b>Quarantined findings (excluded from automatic matching):</b>
                  <ul className="list">
                    {selectedRun.findings.map((f, i) => (
                      <li key={`${i}-${f.key}`}>
                        <code>{f.kind}</code> for key <code>{f.key}</code> — partner rows: {f.leftRowIds.join(', ') || 'none'} · insurer rows: {f.rightRowIds.join(', ') || 'none'}
                      </li>
                    ))}
                  </ul>
                </div>
              )}
            </div>
          )}
        </div>
      ),
    },
    {
      id: 'proposal-review',
      title: 'Tentative proposal human review & audit trail',
      subtitle: `${selectedRun?.proposals.length ?? 0} proposal(s) on selected run · ${recon.audit.length} audit event(s)`,
      done: true,
      informational: true,
      badges: <span className="pill warn">human-in-the-loop</span>,
      children: (
        <div>
          <p className="muted small">
            Fuzzy similarity proposals remain tentative until an operator explicitly confirms or rejects them with a written note. Confirming links policy identity only — no commission or financial entry is generated.
          </p>
          {selectedRun && (
            <>
              {!readOnly && selectedRun.proposals.some((p) => p.status === 'pending_review') && (
                <div className="row" style={{ marginTop: 8 }}>
                  <label style={{ flex: 1 }}>
                    Review rationale / audit note
                    <input value={reviewNote} onChange={(e) => setReviewNote(e.target.value)} />
                  </label>
                </div>
              )}
              <div className="tableWrap" style={{ marginTop: 8 }}>
                <table className="gridTable autoFit">
                  <thead>
                    <tr>
                      <th>Partner Row</th>
                      <th>Insurer Row</th>
                      <th>Similarity Score</th>
                      <th>Status</th>
                      <th>Reviewed By / Note</th>
                      <th>Action</th>
                    </tr>
                  </thead>
                  <tbody>
                    {selectedRun.proposals.map((p) => (
                      <tr key={`${p.leftRowId}-${p.rightRowId}`}>
                        <td><code>{p.leftRowId}</code></td>
                        <td><code>{p.rightRowId}</code></td>
                        <td>{(p.score * 100).toFixed(1)}%</td>
                        <td>
                          <span className={`pill ${p.status === 'confirmed' ? 'ok' : p.status === 'rejected' ? 'bad' : 'warn'}`}>
                            {p.status}
                          </span>
                        </td>
                        <td className="small muted">{p.reviewedBy ? `${p.reviewedBy}: ${p.reviewNote ?? ''}` : 'Awaiting human review'}</td>
                        <td>
                          {!readOnly ? (
                            <div className="row">
                              <button
                                disabled={busy || p.status === 'confirmed'}
                                onClick={() => reviewProposal(selectedRun.runId, p.leftRowId, p.rightRowId, 'confirm')}
                              >
                                Confirm identity
                              </button>
                              <button
                                className="ghost"
                                disabled={busy || p.status === 'rejected'}
                                onClick={() => reviewProposal(selectedRun.runId, p.leftRowId, p.rightRowId, 'reject')}
                              >
                                Reject
                              </button>
                            </div>
                          ) : (
                            <span className="muted small">Read-only</span>
                          )}
                        </td>
                      </tr>
                    ))}
                    {selectedRun.proposals.length === 0 && (
                      <tr><td colSpan={6} className="muted">No tentative proposals generated for this run.</td></tr>
                    )}
                  </tbody>
                </table>
              </div>
            </>
          )}

          <h4 style={{ marginTop: 14 }}>Reconciliation foundation audit trail</h4>
          <div className="tableWrap">
            <table className="gridTable autoFit">
              <thead>
                <tr>
                  <th>ID</th>
                  <th>Timestamp</th>
                  <th>Actor</th>
                  <th>Event</th>
                  <th>Detail</th>
                </tr>
              </thead>
              <tbody>
                {recon.audit.map((a) => (
                  <tr key={a.id}>
                    <td><code>{a.id}</code></td>
                    <td className="small muted">{a.at}</td>
                    <td>{a.actor}</td>
                    <td><code>{a.event}</code></td>
                    <td className="small">{a.detail}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      ),
    },
  ];

  return (
    <div className="grid">
      <SectionGroup
        sequential={false}
        title="Partner reconciliation — unlocked non-financial foundation"
        headline={recon.financialBoundary}
        gates={gates}
        aside={
          <div style={{ marginBottom: 10 }}>
            <div className="pills">
              <span className={`pill ${recon.featureGate.enabled ? 'ok' : 'bad'}`}>
                {recon.featureGate.enabled ? 'Foundation: UNLOCKED (non-financial)' : 'Foundation: DISABLED'}
              </span>
              <span className="pill warn">
                Financial commission / clawback / AP calculations: LOCKED
              </span>
              <span className="pill info">
                Mode: {recon.featureGate.mode}
              </span>
            </div>
            {notice && <div className="okBox small" style={{ marginTop: 8 }}>{notice}</div>}
            {error && <div className="errorBox small" style={{ marginTop: 8 }}>{error}</div>}
          </div>
        }
      />
    </div>
  );
};
