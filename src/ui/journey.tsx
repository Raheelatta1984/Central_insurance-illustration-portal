/**
 * The guided customer lifecycle: nineteen closed sections that open one at a time.
 *
 * This is the screen the whole journey was built for. Nothing here decides whether a section may be
 * filled in — `src/core/journey.ts` does, through the same API the server exposes — so the console
 * cannot drift from the gate. What this file does is render that gate: the rail of closed sections,
 * the one that opens itself, the mandatory fields still outstanding, the money as the engines
 * computed it, and the button that commits the step and moves the recommendation on.
 */
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import type { WorldSnapshot } from '../core/demo';
import type { ConsoleTab } from '../core/tour';
import type { JourneyStageId } from '../core/journey';
import { api } from './api';
import { MissingList, SectionModel, SectionStack, SummaryRows } from './sections';
import { GuideHeading } from './guide';

/* ------------------------------------------------------------------ the shape the API returns */

interface FieldView { id: string; label: string; kind: string; mandatory: boolean; editable: boolean; options?: string[]; hint?: string; group?: string }
interface StageView {
  id: JourneyStageId; order: number; title: string; shortTitle: string; purpose: string; regulatoryBasis: string;
  owner: string; detailTab: string; status: SectionModel['status']; percent: number; complete: boolean;
  autoOpen: boolean; submitted: boolean; lockedBy: string | null; lockedByTitle: string | null;
  missing: string[]; blockers: string[]; warnings: string[];
  summary: Array<{ label: string; value: string; tone?: 'ok' | 'warn' | 'bad' | 'info' }>;
  artefacts: string[]; produces: string[]; fields: FieldView[]; answers: Record<string, unknown>;
}
interface IllustrationViewShape {
  currency: string; headline: string; paymentTermsLabel: string; assumptions: string[];
  scenarios: Array<{ label: string; rate: string; source: string }>;
  milestoneHeader: string[];
  milestones: Array<{ label: string; year: number; age: number; values: string[] }>;
  yearlyHeader: string[]; yearly: string[][]; investmentLinked: boolean;
}
interface DeliveryView {
  status: 'sent' | 'failed' | 'not-sent'; transport: string; messageId: string;
  providerMessageId: string | null; to: string; at: string; error: string | null; detail: string;
}
interface QuotationView {
  quotationId: string; version: number; status: string; totalPayable: string; expiresAt: string;
  pdf: { fileName: string; bytes: number; pages: number; fingerprint: string; opens: boolean };
  illustration: IllustrationViewShape | null;
  email: { messageId: string; to: string; subject: string; dispatchedAt: string; delivery: DeliveryView | null } | null;
  finalisation: { signedBy: string; signedAt: string; buyToken: string; coolingOffEndsOn: string } | null;
  compliance: Array<{ label: string; passes: boolean; hard: boolean; detail: string }>; blockers: string[]; warnings: string[];
}
interface ProgressView {
  percent: number; completeStages: number; totalStages: number; nextRecommended: JourneyStageId | null;
  nextRecommendedTitle: string | null; headline: string; blockers: string[]; stages: StageView[];
}
interface CaseView {
  caseId: string; customerName: string; status: string; openedAt: string; openedBy: string;
  country: string; currency: string; artefacts: Record<string, string | number | undefined>;
  log: Array<{ at: string; by: string; stageId: string; action: string; detail: string; completeAfter: boolean }>;
  progress: ProgressView;
}
interface JourneyView {
  asOf: string; currency: string; tenant: string; pack: string; coolingOffDays: number;
  illustrationWording: string; quotationValidityDays: number;
  products: Array<{ productId: string; name: string; category: string; entityId: string; currency: string; minAge: number; maxAge: number; objectives: string[]; shariahCompliant: boolean; investmentLinked: boolean; minimumRiskAppetite: string; defaultFunds: string[]; baseRatePerThousand: string; incomeMultiple: number; aiStraightThroughLimit: string; automaticBindingLimit: string; facultativeThreshold: string }>;
  funds: Array<{ fundId: string; name: string; currency: string; shariahScreened: boolean; riskGrade: string; navPerUnit: string; navDate: string; fmcBpsAnnual: number }>;
  riders: Array<{ code: string; name: string; loadingBps: number; shariahEligible: boolean; requiresEvidence: string[]; note: string; minAge?: number; maxAge?: number }>;
  questionnaire: Array<{ id: string; label: string; kind: string; mandatory: boolean; options?: string[]; currency?: string; why: string }>;
  questionnaireAttestation: string;
  paymentMethods: Array<{ code: string; label: string; feeBps: number; settlementDays: number; settlesOnCapture: boolean; requiresAuthentication: boolean; shariahEligible: boolean; supportsInstalments: boolean; minAmount: string; maxAmount: string; note: string }>;
  freelancePanel: Array<{ id: string; name: string; specialty: string; maxOccupationClass: number; turnaroundHours: number; available: boolean; shariahQualified: boolean; languages: string[]; limit: string; dayRate: string }>;
  queue: { inHouseOpenCases: number; inHouseCapacityPerDay: number; oldestCaseHours: number; promisedDecisionHours: number; workingHoursPerDay: number };
  occupationLabels: Array<{ class: number; label: string }>;
  manualCodes: { conditions: Array<{ code: string; label: string; bps: number }>; pursuits: Array<{ code: string; bps: number; exclusion?: string }>; familyHistory: Array<{ code: string; bps: number }> };
  engagements: Array<Record<string, unknown>>;
  reinsuranceAssists: Array<Record<string, unknown>>;
  channelOptions: Array<{ code: string; name: string }>;
  subChannelOptions: Array<{ code: string; name: string; parentChannelCode: string }>;
  mail: { transport: string; configured: boolean; reason: string } | null;
  quotations: Array<QuotationView>;
  payments: Array<{ id: string; reference: string; method: string; amount: string; fee: string; net: string; status: string; settlesOn: string; proof: string[]; card: { brand: string; maskedPan: string; authentication: string; cvvStored: boolean } | null; bnpl: { provider: string; instalments: number; disclosure: string; schedule: Array<{ number: number; dueDate: string; amount: string; status: string }> } | null }>;
  cases: CaseView[];
}

type Drafts = Record<string, Record<string, unknown>>;

const asJourney = (data: WorldSnapshot): JourneyView => (data as unknown as { journey: JourneyView }).journey;

/* ------------------------------------------------------------------ small editors */

const YesNo: React.FC<{ value: unknown; onChange: (v: boolean) => void; disabled?: boolean }> = ({ value, onChange, disabled }) => (
  <select
    disabled={disabled}
    value={value === true ? 'yes' : value === false ? 'no' : ''}
    onChange={(e) => onChange(e.target.value === 'yes' ? true : e.target.value === 'no' ? false : undefined as unknown as boolean)}
  >
    <option value="">— not answered —</option>
    <option value="yes">Yes</option>
    <option value="no">No</option>
  </select>
);

const CodeList: React.FC<{ options: Array<{ code: string; label?: string; note?: string }>; value: unknown; onChange: (v: string[]) => void; emptyLabel: string }> = ({ options, value, onChange, emptyLabel }) => {
  const chosen = Array.isArray(value) ? (value as string[]) : typeof value === 'string' ? value.split(',').map((s) => s.trim()).filter(Boolean) : [];
  const toggle = (code: string) => onChange(chosen.includes(code) ? chosen.filter((c) => c !== code) : [...chosen, code]);
  return (
    <div className="chipset">
      {options.map((o) => (
        <label key={o.code} className={`chip${chosen.includes(o.code) ? ' on' : ''}`} title={o.note}>
          <input type="checkbox" checked={chosen.includes(o.code)} onChange={() => toggle(o.code)} />
          {o.label ?? o.code}
        </label>
      ))}
      {options.length === 0 && <span className="muted small">{emptyLabel}</span>}
    </div>
  );
};

const QuestionnaireEditor: React.FC<{
  questions: JourneyView['questionnaire']; value: unknown; attestation: string; agreed: unknown;
  onAnswers: (v: Array<{ questionId: string; value: string | number | boolean }>) => void; onAgreed: (v: boolean) => void;
}> = ({ questions, value, attestation, agreed, onAnswers, onAgreed }) => {
  const answers = Array.isArray(value) ? (value as Array<{ questionId: string; value: string | number | boolean }>) : [];
  const map = new Map(answers.map((a) => [a.questionId, a.value]));
  const set = (questionId: string, v: string | number | boolean) => {
    const next = questions.map((q) => ({ questionId: q.id, value: q.id === questionId ? v : map.get(q.id) ?? '' }))
      .filter((a) => a.value !== '');
    onAnswers(next);
  };
  return (
    <div className="fieldGrid">
      {questions.map((q) => (
        <label key={q.id} className="field" title={q.why}>
          <span>{q.label}{q.mandatory && <i className="req">*</i>}</span>
          {q.kind === 'choice' && (
            <select value={String(map.get(q.id) ?? '')} onChange={(e) => set(q.id, e.target.value)}>
              <option value="">— choose —</option>
              {(q.options ?? []).map((o) => <option key={o} value={o}>{o}</option>)}
            </select>
          )}
          {q.kind === 'boolean' && <YesNo value={map.get(q.id)} onChange={(v) => set(q.id, v)} />}
          {(q.kind === 'number' || q.kind === 'amount') && (
            <input
              type="number" inputMode="decimal" value={String(map.get(q.id) ?? '')}
              placeholder={q.kind === 'amount' ? `${q.currency ?? ''} amount` : 'number'}
              onChange={(e) => set(q.id, e.target.value === '' ? '' : Number(e.target.value))}
            />
          )}
          <small className="muted">{q.why}</small>
        </label>
      ))}
      <label className="field wide">
        <span>Customer attestation<i className="req">*</i></span>
        <span className="attestation">{attestation}</span>
        <YesNo value={agreed} onChange={onAgreed} />
      </label>
    </div>
  );
};

const WeightsEditor: React.FC<{ funds: JourneyView['funds']; value: unknown; onChange: (v: Array<{ fundId: string; weightPct: number }>) => void }> = ({ funds, value, onChange }) => {
  const rows = Array.isArray(value) ? (value as Array<{ fundId: string; weightPct?: number; weightBps?: number }>) : [];
  const pctOf = (fundId: string) => {
    const row = rows.find((r) => r.fundId === fundId);
    if (!row) return 0;
    return row.weightPct !== undefined ? Number(row.weightPct) : Number(row.weightBps ?? 0) / 100;
  };
  const total = funds.reduce((sum, f) => sum + pctOf(f.fundId), 0);
  const set = (fundId: string, pct: number) => {
    const next = funds.map((f) => ({ fundId: f.fundId, weightPct: f.fundId === fundId ? pct : pctOf(f.fundId) })).filter((r) => r.weightPct > 0);
    onChange(next);
  };
  const spread = () => onChange(funds.map((f) => ({ fundId: f.fundId, weightPct: Math.round((100 / funds.length) * 100) / 100 })));
  return (
    <div className="weights">
      {funds.map((f) => (
        <label key={f.fundId} className="field">
          <span>{f.name} <small className="muted">({f.fundId} · {f.riskGrade} · {f.shariahScreened ? 'Shariah-screened' : 'not screened'} · NAV {f.navPerUnit} on {f.navDate} · charge {(f.fmcBpsAnnual / 100).toFixed(2)}%)</small></span>
          <span className="weightRow">
            <input type="number" min={0} max={100} step={0.01} value={pctOf(f.fundId) || ''} placeholder="0" onChange={(e) => set(f.fundId, Number(e.target.value))} />
            <span className="muted">%</span>
          </span>
        </label>
      ))}
      <div className="row">
        <span className={`pill ${Math.round(total * 100) === 10000 ? 'ok' : 'bad'}`}>Total {total.toFixed(2)}% {Math.round(total * 100) === 10000 ? '— balances' : '— must be exactly 100%'}</span>
        <button type="button" className="ghost" onClick={spread}>Spread evenly</button>
        <button type="button" className="ghost" onClick={() => onChange([])}>Clear</button>
      </div>
    </div>
  );
};

interface BeneficiaryRow { name: string; relationship: string; sharePct: number; kind: string; dateOfBirth?: string; guardian?: string }

const BeneficiariesEditor: React.FC<{ value: unknown; onChange: (v: BeneficiaryRow[]) => void }> = ({ value, onChange }) => {
  const rows: BeneficiaryRow[] = Array.isArray(value) ? (value as BeneficiaryRow[]) : [];
  const total = rows.filter((r) => r.kind !== 'contingent').reduce((s, r) => s + Number(r.sharePct || 0), 0);
  const patch = (index: number, part: Partial<BeneficiaryRow>) => onChange(rows.map((r, i) => (i === index ? { ...r, ...part } : r)));
  return (
    <div className="beneficiaries">
      {rows.map((r, i) => (
        <div className="row" key={i}>
          <label>Name<input value={r.name ?? ''} onChange={(e) => patch(i, { name: e.target.value })} /></label>
          <label>Relationship<input value={r.relationship ?? ''} onChange={(e) => patch(i, { relationship: e.target.value })} /></label>
          <label>Share %<input type="number" min={0} max={100} step={0.01} value={r.sharePct ?? ''} onChange={(e) => patch(i, { sharePct: Number(e.target.value) })} /></label>
          <label>Kind
            <select value={r.kind ?? 'primary'} onChange={(e) => patch(i, { kind: e.target.value })}>
              <option value="primary">Primary</option>
              <option value="contingent">Contingent</option>
            </select>
          </label>
          <label>Date of birth<input type="date" value={r.dateOfBirth ?? ''} onChange={(e) => patch(i, { dateOfBirth: e.target.value })} /></label>
          <label>Guardian (if a minor)<input value={r.guardian ?? ''} onChange={(e) => patch(i, { guardian: e.target.value })} /></label>
          <button type="button" className="ghost" onClick={() => onChange(rows.filter((_, j) => j !== i))}>Remove</button>
        </div>
      ))}
      <div className="row">
        <button type="button" className="ghost" onClick={() => onChange([...rows, { name: '', relationship: '', sharePct: 0, kind: 'primary' }])}>+ Add beneficiary</button>
        <span className={`pill ${Math.round(total * 100) === 10000 ? 'ok' : rows.length === 0 ? 'info' : 'bad'}`}>Primary shares {total.toFixed(2)}% {Math.round(total * 100) === 10000 ? '— balances' : '— must be exactly 100%'}</span>
      </div>
    </div>
  );
};

const MedicalResultsEditor: React.FC<{ requirements: Array<{ label: string; status: string; source: string; reason: string }>; value: unknown; onChange: (v: Array<Record<string, string>>) => void; asOf: string }> = ({ requirements, value, onChange, asOf }) => {
  const rows = Array.isArray(value) ? (value as Array<Record<string, string>>) : [];
  const rowFor = (label: string) => rows.find((r) => r['label'] === label);
  const set = (label: string, part: Record<string, string>) => {
    const existing = rowFor(label);
    const next = existing ? rows.map((r) => (r['label'] === label ? { ...r, ...part } : r)) : [...rows, { label, status: 'ordered', at: asOf, by: '', ...part }];
    onChange(next);
  };
  if (requirements.length === 0) {
    return <p className="muted small">No medical evidence is required for this age and sum assured under the product manual.</p>;
  }
  return (
    <div className="requirements">
      {requirements.map((req) => {
        const row = rowFor(req.label);
        const status = row?.['status'] ?? 'required';
        return (
          <div className="row requirement" key={req.label}>
            <label className="grow">
              <span>{req.label} <small className="muted">({req.source})</small></span>
              <small className="muted">{req.reason}</small>
            </label>
            <label>Status
              <select value={status} onChange={(e) => set(req.label, { status: e.target.value })}>
                <option value="required">not yet ordered</option>
                <option value="ordered">ordered</option>
                <option value="received">received</option>
                <option value="reviewed">reviewed</option>
                <option value="waived">waived</option>
              </select>
            </label>
            <label>Date<input type="date" value={row?.['at'] ?? ''} onChange={(e) => set(req.label, { at: e.target.value })} /></label>
            <label>By<input value={row?.['by'] ?? ''} placeholder="reviewer" onChange={(e) => set(req.label, { by: e.target.value })} /></label>
            {status === 'waived' && (
              <label className="grow">Why it was waived<input value={row?.['waiverReason'] ?? ''} onChange={(e) => set(req.label, { waiverReason: e.target.value })} /></label>
            )}
          </div>
        );
      })}
    </div>
  );
};

/* ------------------------------------------------------------------ the panel */

export function CustomerJourneyPanel({
  data, onReload, onNavigate,
}: {
  data: WorldSnapshot;
  onReload: () => Promise<void>;
  onNavigate?: (tab: ConsoleTab) => void;
}) {
  const journey = asJourney(data);
  const [caseId, setCaseId] = useState<string>(journey.cases[0]?.caseId ?? '');
  const [drafts, setDrafts] = useState<Drafts>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<{ stageId: string; accepted: boolean; reason: string } | null>(null);
  const [detail, setDetail] = useState<Record<string, unknown> | null>(null);
  const [revision, setRevision] = useState(0);

  const active = journey.cases.find((c) => c.caseId === caseId) ?? journey.cases[0];

  useEffect(() => { if (!caseId && journey.cases[0]) setCaseId(journey.cases[0].caseId); }, [journey.cases, caseId]);

  // Drafts are re-read from the server after every save or submit, so what the operator typed and
  // what the engine holds can never drift apart on screen.
  useEffect(() => {
    if (!active) return;
    const next: Drafts = {};
    for (const stage of active.progress.stages) next[stage.id] = { ...stage.answers };
    setDrafts(next);
    // Deliberately keyed on the case, the local revision counter and the snapshot's timestamp: the
    // drafts are re-read whenever the server answered, and never on an unrelated re-render.
  }, [active?.caseId, active?.progress.stages, revision, data.generatedAt]);

  const draft = useCallback((stageId: string): Record<string, unknown> => drafts[stageId] ?? {}, [drafts]);
  const patch = useCallback((stageId: string, part: Record<string, unknown>) => {
    setDrafts((current) => ({ ...current, [stageId]: { ...(current[stageId] ?? {}), ...part } }));
  }, []);

  const run = useCallback(async (fn: () => Promise<unknown>, stageId?: string) => {
    setBusy(true);
    setError(null);
    setNotice(null);
    setDetail(null);
    try {
      const result = await fn() as { accepted?: boolean; reason?: string; stageId?: string; detail?: Record<string, unknown>; progress?: ProgressView };
      if (result && typeof result.accepted === 'boolean') {
        setNotice({ stageId: String(result.stageId ?? stageId ?? ''), accepted: result.accepted, reason: String(result.reason ?? '') });
        setDetail(result.detail ?? null);
      }
      await onReload();
      setRevision((r) => r + 1);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }, [onReload]);

  const openCase = useCallback(() => run(() => api('/journey/open', 'POST', { customerName: 'New customer', country: 'AE', by: 'console-operator' })
    .then((res) => { setCaseId((res as { caseId: string }).caseId); return res; })), [run]);

  const sections: SectionModel[] = useMemo(() => {
    if (!active) return [];
    return active.progress.stages.map((stage) => buildSection({
      stage, caseId: active.caseId, journey, data, draft: draft(stage.id), patch, busy, run, onNavigate,
      quotationId: active.artefacts.quotationId ? String(active.artefacts.quotationId) : null,
      paymentId: active.artefacts.paymentId ? String(active.artefacts.paymentId) : null,
      engagement: journey.engagements.find((e) => e['caseReference'] === active.caseId) ?? null,
      assist: journey.reinsuranceAssists.find((a) => a['caseReference'] === active.caseId) ?? null,
      notice, detail,
    }));
  }, [active, journey, data, draft, patch, busy, run, onNavigate, notice, detail]);

  if (!active) {
    return (
      <section className="card sections" style={{ gridColumn: '1 / -1' }}>
        <header><h3>No journey open</h3><p>Open one to start the sequence: every section closed, the first one opening itself.</p></header>
        <div className="row"><button onClick={openCase} disabled={busy}>+ Open a customer journey</button></div>
        {error && <div className="errorBox">{error}</div>}
      </section>
    );
  }

  const progress = active.progress;
  return (
    <div className="grid">
      <SectionStack
        sections={sections}
        overallPercent={progress.percent}
        completeCount={progress.completeStages}
        totalCount={progress.totalStages}
        headline={progress.headline}
        aside={
          <div className="journeyHead">
            <div className="row" style={{ justifyContent: 'space-between', alignItems: 'flex-start' }}>
              <div>
                <div className="pills">
                  <span className="pill info">{active.caseId}</span>
                  <span className="pill">{active.customerName}</span>
                  <span className="pill">{active.status}</span>
                  <span className="pill">{journey.pack}</span>
                  <span className="pill">free-look {journey.coolingOffDays} day(s)</span>
                  {Object.entries(active.artefacts).filter(([, v]) => v).map(([k, v]) => (
                    <span className="pill ok" key={k}>{k}: {String(v)}</span>
                  ))}
                </div>
                {journey.cases.length > 1 && (
                  <label className="small">Journey
                    <select value={active.caseId} onChange={(e) => setCaseId(e.target.value)}>
                      {journey.cases.map((c) => <option key={c.caseId} value={c.caseId}>{c.caseId} — {c.customerName} ({c.status}, {c.progress.percent}%)</option>)}
                    </select>
                  </label>
                )}
              </div>
              <div className="row">
                <button className="ghost" onClick={openCase} disabled={busy}>+ New journey</button>
              </div>
            </div>
            {notice && (
              <div className={notice.accepted ? 'okBox small' : 'errorBox small'}>
                <b>{notice.accepted ? 'Accepted' : 'Refused'} — {notice.stageId}:</b> {notice.reason}
              </div>
            )}
            {error && <div className="errorBox small">{error}</div>}
            {progress.blockers.length > 0 && <MissingList blockers={progress.blockers} />}
            <MailDesk onReload={onReload} />
          </div>
        }
      />
    </div>
  );
}

/* ------------------------------------------------------------------ one section */

interface BuildArgs {
  stage: StageView;
  caseId: string;
  journey: JourneyView;
  data: WorldSnapshot;
  draft: Record<string, unknown>;
  patch: (stageId: string, part: Record<string, unknown>) => void;
  busy: boolean;
  run: (fn: () => Promise<unknown>, stageId?: string) => Promise<void>;
  onNavigate?: (tab: ConsoleTab) => void;
  quotationId: string | null;
  paymentId: string | null;
  engagement: Record<string, unknown> | null;
  assist: Record<string, unknown> | null;
  notice: { stageId: string; accepted: boolean; reason: string } | null;
  detail: Record<string, unknown> | null;
}

function buildSection(args: BuildArgs): SectionModel {
  const { stage, journey, data, draft, patch, busy, run, quotationId, paymentId, engagement, assist, onNavigate } = args;
  const id = stage.id;
  const set = (part: Record<string, unknown>) => patch(id, part);
  const fields = stage.fields;

  const save = () => run(() => api('/journey/save', 'POST', { caseId: args.caseId, stageId: id, answers: draft, by: 'console-operator' }), id);
  const submit = () => run(() => api('/journey/submit', 'POST', { caseId: args.caseId, stageId: id, answers: draft, by: 'console-operator' }), id);

  const fieldEditors: React.ReactNode[] = [];
  const rendered = new Set<string>();

  const renderField = (field: FieldView) => {
    if (rendered.has(field.id)) return null;
    rendered.add(field.id);
    const value = draft[field.id];
    const special = specialEditor(field.id, args);
    if (special) {
      return <div className="field wide" key={field.id}><span>{field.label}{field.mandatory && <i className="req">*</i>}{!field.editable && <small className="muted"> · locked by master settings</small>}{field.hint && <small className="muted"> {field.hint}</small>}</span><fieldset disabled={!field.editable} style={{ border: 0, padding: 0, margin: 0, minWidth: 0 }}>{special}</fieldset></div>;
    }
    return (
      <label className="field" key={field.id}>
        <span>{field.label}{field.mandatory && <i className="req">*</i>}{!field.editable && <small className="muted"> · locked by master settings</small>}</span>
        {field.kind === 'boolean' && <YesNo value={value} disabled={!field.editable} onChange={(v) => set({ [field.id]: v })} />}
        {field.kind === 'select' && (
          <select disabled={!field.editable} value={String(value ?? '')} onChange={(e) => set({ [field.id]: e.target.value })}>
            <option value="">— choose —</option>
            {(field.options ?? []).map((o) => <option key={o} value={o}>{o}</option>)}
          </select>
        )}
        {field.kind === 'date' && <input disabled={!field.editable} type="date" value={String(value ?? '')} onChange={(e) => set({ [field.id]: e.target.value })} />}
        {(field.kind === 'number' || field.kind === 'amount' || field.kind === 'percent') && (
          <input disabled={!field.editable} type="number" inputMode="decimal" value={String(value ?? '')} onChange={(e) => set({ [field.id]: e.target.value })} />
        )}
        {(field.kind === 'text' || field.kind === 'signature' || field.kind === 'readonly') && (
          <input disabled={!field.editable} value={String(value ?? '')} readOnly={field.kind === 'readonly'} onChange={(e) => set({ [field.id]: e.target.value })} />
        )}
        {field.kind === 'list' && (
          <input disabled={!field.editable} value={Array.isArray(value) ? (value as unknown[]).join(', ') : String(value ?? '')} placeholder="comma separated"
            onChange={(e) => set({ [field.id]: e.target.value.split(',').map((s) => s.trim()).filter(Boolean) })} />
        )}
        {field.hint && <small className="muted">{field.hint}</small>}
      </label>
    );
  };

  for (const field of fields) {
    const editor = renderField(field);
    if (editor) fieldEditors.push(editor);
  }

  const body = (
    <>
      <p className="muted small purpose">{stage.purpose}</p>
      <p className="small ruleNote"><b>Why this section exists:</b> {stage.regulatoryBasis} <span className="pill">owned by {stage.owner}</span></p>
      <div className="fieldGrid">{fieldEditors}</div>
      {stage.summary.length > 0 && (
        <>
          <GuideHeading title="What the engine computed" />
          <SummaryRows rows={stage.summary} />
        </>
      )}
      {stageExtras(args)}
      {stage.produces.length > 0 && (
        <p className="muted small">Produces: {stage.produces.join(' · ')}</p>
      )}
    </>
  );

  const footer = (
    <div className="row">
      <button onClick={submit} disabled={busy || stage.status === 'locked'}>
        {stage.complete ? 'Submitted ✓' : 'Submit & continue →'}
      </button>
      <button className="ghost" onClick={save} disabled={busy}>Save draft</button>
      {stage.detailTab && onNavigate && (
        <button className="ghost" onClick={() => onNavigate(stage.detailTab as ConsoleTab)}>Open the {stage.detailTab} tab</button>
      )}
      {quotationId && id === 'quotation' && <DownloadQuotation quotationId={quotationId} />}
      {quotationId && id === 'finalisation' && <DownloadQuotation quotationId={quotationId} />}
      {paymentId && id === 'payment' && <SettlePayment paymentId={paymentId} run={run} />}
      {stage.status === 'locked' && <span className="muted small">Closed until “{stage.lockedByTitle}” is complete.</span>}
      {!stage.complete && stage.status !== 'locked' && stage.percent === 100 && <span className="muted small">Every mandatory field is filled — submit to commit this step and open the next section.</span>}
      {args.notice?.stageId === id && (
        <span className={args.notice.accepted ? 'okText small' : 'bad small'}>{args.notice.accepted ? 'Accepted' : 'Refused'}: {args.notice.reason}</span>
      )}
    </div>
  );

  return {
    id,
    order: stage.order,
    title: `${stage.order}. ${stage.title}`,
    subtitle: stage.complete ? 'complete' : stage.status === 'locked' ? `closed — waiting on ${stage.lockedByTitle ?? 'the previous section'}` : stage.status === 'blocked' ? 'blocked' : `${stage.percent}% complete`,
    status: stage.status,
    percent: stage.percent,
    missing: stage.missing,
    blockers: stage.blockers,
    warnings: stage.warnings,
    lockedByTitle: stage.lockedByTitle,
    autoOpen: stage.autoOpen,
    badges: stage.submitted ? <span className="pill ok" key="s">submitted</span> : undefined,
    children: body,
    footer,
  };
}

/** Field-specific editors that need the catalogues from the snapshot. */
function specialEditor(fieldId: string, args: BuildArgs): React.ReactNode | null {
  const { stage, journey, draft, patch } = args;
  const set = (part: Record<string, unknown>) => patch(stage.id, part);
  const value = draft[fieldId];

  if (stage.id === 'needs' && fieldId === 'answers') {
    return (
      <QuestionnaireEditor
        questions={journey.questionnaire}
        value={value}
        attestation={journey.questionnaireAttestation}
        agreed={draft['attestationAgreed']}
        onAnswers={(v) => set({ answers: v })}
        onAgreed={(v) => set({ attestationAgreed: v })}
      />
    );
  }
  // The two shelves a case may have been sold through. The options are the tenant's own channels,
  // so they come from the snapshot rather than from the stage definition.
  if (stage.id === 'coverage' && fieldId === 'channelCode') {
    const codes = journey.channelOptions ?? [];
    return (
      <select value={String(value ?? '')} onChange={(e) => set({ channelCode: e.target.value, subChannelCode: '' })}>
        <option value="">— the product master’s own rates —</option>
        {codes.map((c) => <option key={c.code} value={c.code}>{c.code} · {c.name}</option>)}
      </select>
    );
  }
  if (stage.id === 'coverage' && fieldId === 'subChannelCode') {
    const parent = String(draft['channelCode'] ?? '').trim();
    const codes = (journey.subChannelOptions ?? []).filter((c) => parent === '' || c.parentChannelCode === parent);
    return (
      <select value={String(value ?? '')} onChange={(e) => set({ subChannelCode: e.target.value })} disabled={codes.length === 0}>
        <option value="">— inherit from the omni-channel —</option>
        {codes.map((c) => <option key={c.code} value={c.code}>{c.code} · {c.name}</option>)}
      </select>
    );
  }
  if (stage.id === 'funds' && fieldId === 'weights') {
    return <WeightsEditor funds={journey.funds} value={value} onChange={(v) => set({ weights: v })} />;
  }
  if (stage.id === 'beneficiaries' && fieldId === 'beneficiaries') {
    return <BeneficiariesEditor value={value} onChange={(v) => set({ beneficiaries: v as unknown as BeneficiaryRow[] })} />;
  }
  if (stage.id === 'medical' && fieldId === 'results') {
    const requirements = (draft['requirements'] as Array<{ label: string; status: string; source: string; reason: string }> | undefined) ?? [];
    return <MedicalResultsEditor requirements={requirements} value={value} onChange={(v) => set({ results: v })} asOf={journey.asOf} />;
  }
  if (stage.id === 'riders' && (fieldId === 'riders' || fieldId === 'withoutLoading')) {
    const selected = Array.isArray(draft['riders']) ? (draft['riders'] as string[]) : [];
    const without = Array.isArray(draft['withoutLoading']) ? (draft['withoutLoading'] as string[]) : [];
    return (
      <div className="riders">
        {journey.riders.map((rider) => {
          const on = selected.includes(rider.code);
          const free = without.includes(rider.code);
          return (
            <div className={`row rider${on ? ' on' : ''}`} key={rider.code}>
              <label className="chip grow">
                <input
                  type="checkbox" checked={on}
                  onChange={(e) => {
                    const next = e.target.checked ? [...selected, rider.code] : selected.filter((c) => c !== rider.code);
                    set({ riders: next, withoutLoading: without.filter((c) => next.includes(c)) });
                  }}
                />
                <b>{rider.name}</b> <small className="muted">{rider.loadingBps === 0 ? 'no loading — priced inside the base rate' : `${rider.loadingBps} bps`} · {rider.shariahEligible ? 'Shariah-eligible' : 'not Shariah-eligible'}</small>
              </label>
              {on && (
                <label className="chip">
                  <input
                    type="checkbox" checked={free}
                    onChange={(e) => set({ withoutLoading: e.target.checked ? [...without, rider.code] : without.filter((c) => c !== rider.code) })}
                  />
                  attach without loading
                </label>
              )}
              <small className="muted">{rider.note}</small>
            </div>
          );
        })}
      </div>
    );
  }
  if (stage.id === 'loadings' && fieldId === 'conditions') {
    return <CodeList value={value} onChange={(v) => set({ conditions: v })} emptyLabel="none" options={journey.manualCodes.conditions.map((c) => ({ code: c.code, label: `${c.label} (${c.bps} bps)` }))} />;
  }
  if (stage.id === 'loadings' && fieldId === 'pursuits') {
    return <CodeList value={value} onChange={(v) => set({ pursuits: v })} emptyLabel="none" options={journey.manualCodes.pursuits.map((p) => ({ code: p.code, label: `${p.code} (${p.bps} bps)${p.exclusion ? ` — exclusion: ${p.exclusion}` : ''}` }))} />;
  }
  if (stage.id === 'loadings' && fieldId === 'familyHistory') {
    return <CodeList value={value} onChange={(v) => set({ familyHistory: v })} emptyLabel="none" options={journey.manualCodes.familyHistory.map((f) => ({ code: f.code, label: `${f.code} (${f.bps} bps)` }))} />;
  }
  if (stage.id === 'profile' && fieldId === 'consentScopes') {
    return (
      <CodeList
        value={value} onChange={(v) => set({ consentScopes: v })} emptyLabel="none"
        options={['customer.exists', 'customer.name', 'customer.contact', 'customer.holdings', 'marketing'].map((code) => ({ code }))}
      />
    );
  }
  if (stage.id === 'recommendation' && fieldId === 'productId') {
    // Ninety-odd varieties across seventeen lines: grouped by line, so the operator picks a shelf and
    // then a variety rather than scrolling one flat list of every product the tenant has ever filed.
    const byLine = new Map<string, typeof journey.products>();
    for (const p of journey.products) {
      const line = String((p as { line?: string }).line ?? p.category);
      byLine.set(line, [...(byLine.get(line) ?? []), p]);
    }
    return (
      <select value={String(value ?? '')} onChange={(e) => set({ productId: e.target.value })}>
        <option value="">— choose from the ranked list below —</option>
        {[...byLine.entries()].map(([line, list]) => (
          <optgroup key={line} label={`${line} (${list.length})`}>
            {list.map((p) => (
              <option key={p.productId} value={p.productId} title={String((p as { blurb?: string }).blurb ?? '')}>
                {String((p as { variety?: string }).variety ?? p.name)} — {p.name} · {p.category} · {p.minAge}–{p.maxAge} · rate {p.baseRatePerThousand} per 1,000
              </option>
            ))}
          </optgroup>
        ))}
      </select>
    );
  }
  if (stage.id === 'conversion' && fieldId === 'initialFundId') {
    return (
      <select value={String(value ?? '')} onChange={(e) => set({ initialFundId: e.target.value })}>
        <option value="">— choose —</option>
        {journey.funds.map((f) => <option key={f.fundId} value={f.fundId}>{f.name} ({f.fundId})</option>)}
      </select>
    );
  }
  if (stage.id === 'payment' && fieldId === 'method') {
    return (
      <div className="methods">
        {journey.paymentMethods.map((m) => (
          <label key={m.code} className={`chip method${value === m.code ? ' on' : ''}`}>
            <input type="radio" name="payment-method" checked={value === m.code} onChange={() => set({ method: m.code })} />
            <b>{m.label}</b>
            <small className="muted">{m.feeBps === 0 ? 'no handling cost' : `${m.feeBps} bps cost to the insurer`} · {m.settlesOnCapture ? 'settles on capture' : `settles in ${m.settlementDays} business day(s)`} · {m.minAmount}–{m.maxAmount}</small>
            <small className="muted">{m.note}</small>
          </label>
        ))}
      </div>
    );
  }
  return null;
}

/** Stage-specific read-only extras: the documents, the money and the routing this step produced. */
function stageExtras(args: BuildArgs): React.ReactNode {
  const { stage, journey, detail } = args;
  const id = stage.id;

  if (id === 'needs' && draftOf(args)['evaluation']) {
    const evaluation = draftOf(args)['evaluation'] as Record<string, unknown>;
    return (
      <div className="extra">
        <GuideHeading title="The need, and the assumptions behind it" />
        <SummaryRows rows={[
          { label: 'Income replacement', value: String(evaluation['incomeReplacement'] ?? '—') },
          { label: 'Debt cover', value: String(evaluation['debtCover'] ?? '—') },
          { label: 'Less existing cover', value: String(evaluation['lessExistingCover'] ?? '—') },
          { label: 'Replacement years', value: String(evaluation['replacementYears'] ?? '—') },
        ]} />
        <ul className="list small muted">{(evaluation['basis'] as string[] ?? []).map((b) => <li key={b}>{b}</li>)}</ul>
      </div>
    );
  }

  if (id === 'loadings' && draftOf(args)['breakdown']) {
    const breakdown = draftOf(args)['breakdown'] as { standardPremium: string; loadedPremium: string; totalPayable: string; totalExtraBps: number; components: Array<{ label: string; bps: number; amount: string; reason: string; referToHuman: boolean }>; exclusions: string[]; evidenceRequired: string[]; reconciliation: { detail: string; agrees: boolean | null } };
    return (
      <div className="extra">
        <GuideHeading title="How the premium is built" />
        <div className="stat"><span>Standard premium</span><b>{breakdown.standardPremium}</b></div>
        {breakdown.components.map((c) => (
          <div className="stat" key={c.label}><span>{c.label} {c.referToHuman && <span className="pill warn">human review</span>}</span><b>{c.bps} bps = {c.amount}</b></div>
        ))}
        <div className="stat"><span>Loaded premium</span><b>{breakdown.loadedPremium}</b></div>
        <div className="stat"><span>Total payable with riders</span><b>{breakdown.totalPayable}</b></div>
        <p className={`small ${breakdown.reconciliation.agrees === false ? 'bad' : 'muted'}`}>{breakdown.reconciliation.detail}</p>
        {breakdown.exclusions.length > 0 && <p className="small">Exclusions: {breakdown.exclusions.join('; ')}</p>}
        {breakdown.evidenceRequired.length > 0 && <p className="small muted">Evidence this loading needs: {breakdown.evidenceRequired.join('; ')}</p>}
      </div>
    );
  }

  if (id === 'riders' && draftOf(args)['pricing']) {
    const pricing = draftOf(args)['pricing'] as { lines: Array<{ name: string; bps: number; amount: string; waived: boolean }>; total: string; waivedValue: string; evidenceRequired: string[] };
    return (
      <div className="extra">
        <GuideHeading title="Rider schedule" />
        {pricing.lines.map((l) => (
          <div className="stat" key={l.name}><span>{l.name}{l.waived && <span className="pill warn">without loading</span>}</span><b>{l.bps} bps = {l.amount}</b></div>
        ))}
        <div className="stat"><span>Rider premium</span><b>{pricing.total}</b></div>
        {Number(pricing.waivedValue.replace(/[^0-9.]/g, '')) > 0 && <div className="stat"><span>Loading given away</span><b className="warnText">{pricing.waivedValue}</b></div>}
        {pricing.evidenceRequired.length > 0 && <p className="small muted">Evidence the riders need: {pricing.evidenceRequired.join('; ')}</p>}
      </div>
    );
  }

  if (id === 'funds' && draftOf(args)['plan']) {
    const plan = draftOf(args)['plan'] as { investableLabel: string; lines: Array<{ name: string; fundId: string; weightPct: number; amountLabel: string; units: string; navPerUnit: string; navDate: string; riskGrade: string }>; weightedChargeBps: number; weightedRiskScore: number; appetite: string | null; appetiteAgrees: boolean | null; acknowledgementsRequired: string[] };
    return (
      <div className="extra">
        <GuideHeading title="What the first contribution buys, at the published valuation" />
        <div className="stat"><span>Amount invested</span><b>{plan.investableLabel}</b></div>
        {plan.lines.map((l) => (
          <div className="stat" key={l.fundId}><span>{l.name} ({l.riskGrade})</span><b>{l.weightPct.toFixed(2)}% = {l.amountLabel} → {l.units} units at {l.navPerUnit} on {l.navDate}</b></div>
        ))}
        <div className="stat"><span>Weighted fund charge</span><b>{(plan.weightedChargeBps / 100).toFixed(2)}% a year</b></div>
        <div className="stat"><span>Weighted risk grade</span><b>{plan.weightedRiskScore} of 2 against a “{plan.appetite ?? 'unstated'}” appetite</b></div>
        {plan.acknowledgementsRequired.map((a) => <p className="small warnText" key={a}>{a}</p>)}
      </div>
    );
  }

  if (id === 'beneficiaries' && draftOf(args)['set']) {
    const set = draftOf(args)['set'] as { primaries: Array<{ name: string; relationship: string; sharePct: number; share: string | null }>; contingents: Array<{ name: string; sharePct: number }>; primaryTotalPct: number };
    return (
      <div className="extra">
        <GuideHeading title="Who receives the proceeds" />
        {set.primaries.map((b) => <div className="stat" key={b.name}><span>Primary — {b.name} ({b.relationship})</span><b>{b.sharePct.toFixed(2)}%{b.share ? ` = ${b.share}` : ''}</b></div>)}
        {set.contingents.map((b) => <div className="stat" key={b.name}><span>Contingent — {b.name}</span><b>{b.sharePct.toFixed(2)}%</b></div>)}
        <div className="stat"><span>Primary total</span><b>{set.primaryTotalPct.toFixed(2)}%</b></div>
      </div>
    );
  }

  if (id === 'quotation') {
    const quotation = journey.quotations.find((q) => q.quotationId === args.quotationId);
    if (!quotation) return null;
    return (
      <div className="extra">
        <GuideHeading title="The document, and the compliance checks behind it" />
        <div className="stat"><span>Quotation</span><b>{quotation.quotationId} v{quotation.version} · {quotation.status}</b></div>
        <div className="stat"><span>Total payable</span><b>{quotation.totalPayable}</b></div>
        <div className="stat"><span>Valid until</span><b>{quotation.expiresAt.slice(0, 10)} ({journey.quotationValidityDays} days)</b></div>
        <div className="stat"><span>PDF</span><b>{quotation.pdf.fileName} · {quotation.pdf.pages} page(s) · {(quotation.pdf.bytes / 1024).toFixed(1)} KB · fingerprint {quotation.pdf.fingerprint}{quotation.pdf.opens ? ' · opens ✓' : ' · DOES NOT OPEN'}</b></div>
        {quotation.email && <DeliveryRow email={quotation.email} />}
        {quotation.finalisation && <div className="stat"><span>Signed</span><b>{quotation.finalisation.signedBy} on {quotation.finalisation.signedAt.slice(0, 10)} · cooling-off to {quotation.finalisation.coolingOffEndsOn} · token {quotation.finalisation.buyToken}</b></div>}
        {quotation.illustration && <IllustrationPanel illustration={quotation.illustration} />}
        <ResendQuotation quotationId={quotation.quotationId} to={quotation.email?.to} run={args.run} busy={args.busy} />
        <details>
          <summary className="muted small">Compliance checks ({quotation.compliance.filter((c) => c.passes).length}/{quotation.compliance.length} pass)</summary>
          <ul className="list small">
            {quotation.compliance.map((c) => (
              <li key={c.label}>{c.passes ? '✓' : c.hard ? '✗' : '!'} <b>{c.label}</b> — {c.detail}</li>
            ))}
          </ul>
        </details>
        {detail && <pre className="code small">{JSON.stringify(detail, null, 1).slice(0, 1200)}</pre>}
      </div>
    );
  }

  if (id === 'payment') {
    const payments = journey.payments.filter((p) => p.reference === args.quotationId);
    if (payments.length === 0) return null;
    return (
      <div className="extra">
        <GuideHeading title="Money taken" />
        {payments.map((p) => (
          <div key={p.id}>
            <div className="stat"><span>{p.id} · {p.method}</span><b>{p.amount} · {p.status} · settles {p.settlesOn}</b></div>
            {p.card && <div className="stat"><span>Card</span><b>{p.card.brand} {p.card.maskedPan} · {p.card.authentication} · CVV stored: {String(p.card.cvvStored)}</b></div>}
            {p.bnpl && <div className="stat"><span>BNPL</span><b>{p.bnpl.provider} · {p.bnpl.instalments} instalments · {p.bnpl.schedule.map((s) => `${s.dueDate}: ${s.amount}`).join(' → ')}</b></div>}
            <div className="stat"><span>Handling cost / net to insurer</span><b>{p.fee} / {p.net}</b></div>
            <ul className="list small muted">{p.proof.map((line) => <li key={line}>{line}</li>)}</ul>
          </div>
        ))}
      </div>
    );
  }

  if (id === 'routing') {
    return (
      <div className="extra">
        <GuideHeading title="Capacity, and who the case goes to if this route fails" />
        <SummaryRows rows={[
          { label: 'In-house queue', value: `${journey.queue.inHouseOpenCases} open case(s) at ${journey.queue.inHouseCapacityPerDay} a day, oldest waiting ${journey.queue.oldestCaseHours}h` },
          { label: 'Promised decision', value: `${journey.queue.promisedDecisionHours} working hour(s)` },
        ]} />
        <div className="tableWrap">
          <table>
            <thead><tr><th>Panel underwriter</th><th>Specialty</th><th>Turnaround</th><th>Authority</th><th>Day rate</th><th>Available</th></tr></thead>
            <tbody>
              {journey.freelancePanel.map((f) => (
                <tr key={f.id}>
                  <td>{f.name} <small className="muted">({f.id})</small></td>
                  <td>{f.specialty}{f.shariahQualified ? ' · Shariah-qualified' : ''}</td>
                  <td>{f.turnaroundHours}h</td>
                  <td>{f.limit} · class ≤ {f.maxOccupationClass}</td>
                  <td>{f.dayRate}</td>
                  <td>{f.available ? 'yes' : 'no'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {args.engagement && <p className="small">Engaged: <b>{String(args.engagement['underwriter'])}</b> · {String(args.engagement['cost'])} · due {String(args.engagement['expectedDecisionAt']).slice(0, 16)} · {String(args.engagement['status'])}</p>}
        {args.assist && <p className="small">Reinsurance assist <b>{String(args.assist['requestId'])}</b> · {String(args.assist['status'])}{args.assist['answer'] ? ` · answer: ${JSON.stringify(args.assist['answer'])}` : ''}</p>}
        {detail && <pre className="code small">{JSON.stringify(detail, null, 1).slice(0, 1200)}</pre>}
      </div>
    );
  }

  if ((id === 'allocation' || id === 'investment') && draftOf(args)['progressReport']) {
    const report = draftOf(args)['progressReport'] as Record<string, unknown>;
    return (
      <div className="extra">
        <SummaryRows rows={[
          { label: 'Contributions to date', value: String(report['contributions'] ?? '—') },
          { label: 'Current fund value', value: String(report['currentValue'] ?? '—') },
          { label: 'Gain / loss', value: String(report['gainLossLabel'] ?? '—'), tone: String(report['gainLossLabel'] ?? '').startsWith('-') ? 'bad' : 'ok' },
          { label: 'Drift', value: String(report['driftLabel'] ?? '—'), tone: report['withinTolerance'] ? 'ok' : 'warn' },
          { label: 'Next review', value: String(report['nextReview'] ?? '—'), tone: report['overdue'] ? 'bad' : 'info' },
        ]} />
        <p className="small muted">{journey.illustrationWording}</p>
      </div>
    );
  }

  if (detail && args.notice?.stageId === id) {
    return <pre className="code small">{JSON.stringify(detail, null, 1).slice(0, 1200)}</pre>;
  }
  return null;
}

function draftOf(args: BuildArgs): Record<string, unknown> { return args.draft; }

/* ------------------------------------------------------------------ the illustration, and the email that carries it */

/**
 * The benefit illustration, as the customer will read it: the milestones they ask about by name,
 * then every year behind them. The figures come from the engine already formatted — a screen never
 * re-rounds a number the quotation document has printed.
 */
const IllustrationPanel: React.FC<{ illustration: IllustrationViewShape }> = ({ illustration }) => (
  <div className="extra">
    <GuideHeading title="Benefit illustration — what this policy is worth" />
    <div className="stat"><span>Payment terms</span><b>{illustration.paymentTermsLabel}</b></div>
    <div className="stat"><span>Assumed growth before charges</span><b>{illustration.scenarios.map((sc) => `${sc.label} ${sc.rate}`).join(' · ')}</b></div>
    <div className="stat"><span>Where each rate comes from</span><b>{illustration.scenarios.map((sc) => sc.source).join(' · ')}</b></div>
    <div className="stat"><span>Headline</span><b>{illustration.headline}</b></div>
    <div className="tableWrap">
      <table className="gridTable autoFit">
        <thead><tr>{illustration.milestoneHeader.map((h) => <th key={h}>{h}</th>)}</tr></thead>
        <tbody>
          {illustration.milestones.map((m) => (
            <tr key={`${m.year}-${m.label}`}>
              <td>{m.label}</td>
              {m.values.map((v, i) => <td key={i}>{v}</td>)}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
    <details>
      <summary className="muted small">Every policy year ({illustration.yearly.length} rows)</summary>
      <div className="tableWrap">
        <table className="gridTable autoFit">
          <thead><tr>{illustration.yearlyHeader.map((h) => <th key={h}>{h}</th>)}</tr></thead>
          <tbody>
            {illustration.yearly.map((row) => (
              <tr key={row[0]}>{row.map((cell, i) => <td key={i}>{cell}</td>)}</tr>
            ))}
          </tbody>
        </table>
      </div>
    </details>
    <ul className="list small muted">{illustration.assumptions.map((a) => <li key={a}>{a}</li>)}</ul>
  </div>
);

/** What actually happened to the message: sent, refused, or held because nothing is configured. */
const DeliveryRow: React.FC<{ email: QuotationView['email'] }> = ({ email }) => {
  if (!email) return null;
  const delivery = email.delivery;
  const tone = !delivery ? 'info' : delivery.status === 'sent' ? 'ok' : delivery.status === 'failed' ? 'bad' : 'warn';
  return (
    <div className="stat">
      <span>Emailed</span>
      <b>
        {email.to} · {email.dispatchedAt} · {email.messageId}
        {delivery && (
          <>
            {' · '}
            <span className={`pill ${tone}`}>
              {delivery.status === 'sent' ? `sent via ${delivery.transport}` : delivery.status === 'failed' ? 'delivery FAILED' : 'NOT delivered'}
            </span>
            {delivery.providerMessageId ? ` · ${delivery.providerMessageId}` : ''}
          </>
        )}
      </b>
      {delivery && <p className={`small ${tone === 'ok' ? 'okText' : tone === 'bad' ? 'bad' : 'warnText'}`}>{delivery.detail}</p>}
    </div>
  );
};

/** Re-send the same document. The attempt is recorded against the quotation, like the first one. */
const ResendQuotation: React.FC<{
  quotationId: string; to: string | undefined;
  run: (fn: () => Promise<unknown>) => Promise<void>; busy: boolean;
}> = ({ quotationId, to, run, busy }) => (
  <div className="row">
    <button
      className="ghost"
      disabled={busy}
      onClick={() => void run(() => api('/journey/quotation/email', 'POST', { quotationId, ...(to && !to.includes('*') ? { to } : {}), by: 'console-operator' }))}
    >
      Email this quotation now
    </button>
    <span className="muted small">Sends through the transport shown in the mail desk below — the answer is recorded on the quotation.</span>
  </div>
);

/**
 * The mail desk: whether the quotation email will actually leave the building, and a button that
 * proves it before a customer is promised anything.
 */
const MailDesk: React.FC<{ onReload: () => Promise<void> }> = ({ onReload }) => {
  const [status, setStatus] = useState<{
    transport: string; kind: string; from: string; configured: boolean; reason: string;
    sent: number; failed: number; notSent: number; last: DeliveryView | null; env: Record<string, string>;
  } | null>(null);
  const [to, setTo] = useState('');
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<DeliveryView | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(() => {
    api<{ transport: string; kind: string; from: string; configured: boolean; reason: string; sent: number; failed: number; notSent: number; last: DeliveryView | null; env: Record<string, string> }>('/mail/status')
      .then(setStatus)
      .catch((e) => setError(e instanceof Error ? e.message : String(e)));
  }, []);

  useEffect(load, [load]);

  const sendTest = async () => {
    setBusy(true);
    setError(null);
    setResult(null);
    try {
      const res = await api<{ delivery: DeliveryView }>('/mail/test', 'POST', { to: to.trim(), by: 'console-operator' });
      setResult(res.delivery);
      load();
      await onReload();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  if (!status) return null;
  return (
    <div className="extra">
      <GuideHeading title="Mail delivery" />
      <div className="stat">
        <span>Transport</span>
        <b>
          {status.transport} · from {status.from || '—'}
          {' '}
          <span className={`pill ${status.configured ? 'ok' : 'warn'}`}>{status.configured ? 'live' : 'not delivering'}</span>
        </b>
        {!status.configured && <p className="small warnText">{status.reason}</p>}
      </div>
      <div className="stat"><span>Deliveries this session</span><b>{status.sent} sent · {status.notSent} held · {status.failed} failed</b></div>
      <div className="stat">
        <span>Settings present</span>
        <b>{Object.entries(status.env).map(([k, v]) => `${k}: ${v}`).join(' · ')}</b>
      </div>
      {status.last && <div className="stat"><span>Last attempt</span><b>{status.last.status} · {status.last.detail}</b></div>}
      <div className="row">
        <label>Test address<input value={to} onChange={(e) => setTo(e.target.value)} placeholder="ops@example.com" /></label>
        <button className="ghost" disabled={busy || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(to.trim())} onClick={() => void sendTest()}>
          {busy ? 'Sending…' : 'Send a test email'}
        </button>
      </div>
      {result && <div className={`small ${result.status === 'sent' ? 'okBox' : 'errorBox'}`}>{result.detail}</div>}
      {error && <div className="errorBox small">{error}</div>}
    </div>
  );
};

/* ------------------------------------------------------------------ the two buttons that need the API */

const DownloadQuotation: React.FC<{ quotationId: string }> = ({ quotationId }) => {
  const [state, setState] = useState<{ fileName: string; base64: string; pages: number } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const load = async () => {
    setBusy(true);
    setError(null);
    try {
      const res = await api<{ fileName: string; base64: string; pages: number }>('/journey/quotation/pdf', 'POST', { quotationId });
      setState(res);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <>
      <button className="ghost" onClick={load} disabled={busy}>{busy ? 'Fetching…' : 'Fetch the PDF'}</button>
      {state && (
        <a className="pill ok" download={state.fileName} href={`data:application/pdf;base64,${state.base64}`}>
          Download {state.fileName} ({state.pages} page(s))
        </a>
      )}
      {error && <span className="bad small">{error}</span>}
    </>
  );
};

const SettlePayment: React.FC<{ paymentId: string; run: (fn: () => Promise<unknown>) => Promise<void> }> = ({ paymentId, run }) => (
  <>
    <button className="ghost" disabled={false} onClick={() => run(() => api('/journey/payment/settle', 'POST', { paymentId, by: 'treasury', proof: 'Bank statement credits the collection account for this quotation reference' }))}>
      Bank confirmed — settle
    </button>
    <button className="ghost" onClick={() => run(() => api('/journey/payment/fail', 'POST', { paymentId, by: 'treasury', reason: 'The transfer never arrived; the customer confirmed they did not send it' }))}>
      Mark as failed
    </button>
  </>
);
