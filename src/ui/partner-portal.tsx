import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { LabelRegistry } from '../core/labels';
import { formatAmount, money } from '../core/money';
import { SERVICE_KINDS } from '../core/partner-portal';
import type { PartnerPortal, ServiceKind } from '../core/partner-portal';
import { api } from './api';
import './partner-portal.css';

const registry = new LabelRegistry();
const t = (key: string) => registry.t(`partner.${key}`);
type Workspace = ReturnType<PartnerPortal['workspace']>;
type Partner = { partnerId: string; name: string; channelCode: string; country: string; currency: string; allSubchannels: boolean; subChannels: Array<{ code: string; name: string }> };
type Access = { actor: string; demo: boolean; internal: boolean; roles: string[]; partners: Partner[] };
type Page = 'overview' | 'applications' | 'commissions' | 'requests' | 'reports' | 'audit';
type CaseDetails = {
  caseId: string; nextRecommended: string | null;
  stages: Array<{ id: string; title: string; status: string; complete: boolean; missing: string[]; blockers: string[];
    fields: Array<{ id: string; label: string; kind: string; mandatory: boolean; options: string[]; hint: string }>;
    answers: Record<string, unknown> }>;
};

const PAGES: Array<{ id: Page; icon: string }> = [
  { id: 'overview', icon: '◫' }, { id: 'applications', icon: '▤' }, { id: 'commissions', icon: '◈' },
  { id: 'requests', icon: '✉' }, { id: 'reports', icon: '▥' }, { id: 'audit', icon: '◷' },
];
const date = (value: string) => value ? value.slice(0, 16).replace('T', ' ') + ' UTC' : '—';
const label = (value: string) => { const key = `value.${value}`; const translated = t(key); return translated === `partner.${key}` ? value : translated; };
const Status: React.FC<{ value: string }> = ({ value }) => <span className={`pp-status ${['approved', 'closed', 'complete'].includes(value) ? 'good' : ['disputed', 'rejected', 'returned'].includes(value) ? 'alert' : ''}`}>{label(value)}</span>;
const Empty: React.FC<{ children: React.ReactNode }> = ({ children }) => <div className="pp-empty"><span aria-hidden="true">◇</span><p>{children}</p></div>;
const Field: React.FC<{ label: string; children: React.ReactNode; wide?: boolean }> = ({ label, children, wide }) => <label className={wide ? 'pp-field wide' : 'pp-field'}><span>{label}</span>{children}</label>;

function CommissionHistory({ entry }: { entry: Workspace['commissions']['items'][number] }) {
  const display = (minor: string) => formatAmount(money(BigInt(minor), entry.currency));
  return <section className="pp-panel">
    <div className="pp-panel-heading"><div><span className="pp-eyebrow">{entry.id}</span><h2>{t('statementHistory')}</h2></div></div>
    {entry.statements.length ? <div className="pp-table-wrap"><table><thead><tr><th>{t('reference')}</th><th>{t('amount')}</th><th>{t('actorColumn')}</th><th>{t('timeUtc')}</th></tr></thead><tbody>{entry.statements.map((statement) =>
      <tr key={statement.reference}><td><b>{statement.reference}</b></td><td>{display(statement.amountMinor)}</td><td>{statement.by}</td><td>{date(statement.at)}</td></tr>)}</tbody></table></div> : <Empty>{t('noStatements')}</Empty>}
    <div className="pp-panel-heading pp-review-form"><div><h2>{t('disbursementHistory')}</h2><p>{t('externalOnly')}</p></div></div>
    {entry.disbursements.length ? <div className="pp-table-wrap"><table><thead><tr><th>{t('reference')}</th><th>{t('amount')}</th><th>{t('actorColumn')}</th><th>{t('timeUtc')}</th></tr></thead><tbody>{entry.disbursements.map((disbursement) =>
      <tr key={disbursement.reference}><td><b>{disbursement.reference}</b></td><td>{display(disbursement.amountMinor)}</td><td>{disbursement.by}</td><td>{date(disbursement.at)}</td></tr>)}</tbody></table></div> : <Empty>{t('noDisbursements')}</Empty>}
  </section>;
}

function ApplicationHistory({ entry }: { entry: Workspace['applications']['items'][number] }) {
  return <section className="pp-panel"><div className="pp-panel-heading"><div><span className="pp-eyebrow">{entry.id}</span><h2>{t('reviewDetails')}</h2></div></div>
    {entry.review && <p className="pp-muted"><b>{label(entry.review.role)} · {entry.review.by}</b> · {date(entry.review.at)}<br />{entry.review.note}</p>}
    {entry.route && <div><h3>{t('routeReasons')}</h3><p className="pp-muted">{label(entry.route.route)} · {entry.route.assignedTo}</p><ul>{entry.route.reasons.map((reason) => <li key={reason}>{reason}</li>)}</ul></div>}
    {entry.underwritingReview && <div><h3>{t('underwritingReviewDetails')}</h3><p className="pp-muted">{entry.underwritingReview.by} · {date(entry.underwritingReview.at)}<br />{entry.underwritingReview.note}</p></div>}
  </section>;
}

export function PartnerPortalApp() {
  const offline = Boolean((window as unknown as { __OFFLINE__?: unknown }).__OFFLINE__);
  const [access, setAccess] = useState<Access | null>(null);
  const [workspace, setWorkspace] = useState<Workspace | null>(null);
  const [partnerId, setPartnerId] = useState('');
  const [subChannelCode, setSubChannelCode] = useState('');
  const [page, setPage] = useState<Page>('overview');
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState(false);
  const [token, setToken] = useState('');
  const [actor, setActor] = useState('demo-agent');
  const [customer, setCustomer] = useState('');
  const [caseId, setCaseId] = useState('');
  const [details, setDetails] = useState<CaseDetails | null>(null);
  const [stageId, setStageId] = useState('');
  const [stageAnswers, setStageAnswers] = useState<Record<string, unknown>>({});
  const [reviewRole, setReviewRole] = useState('supervisor');
  const [reviewNote, setReviewNote] = useState('');
  const [termsReconciled, setTermsReconciled] = useState(false);
  const [applicationId, setApplicationId] = useState('');
  const [revisedSigner, setRevisedSigner] = useState('');
  const [reviewedRevised, setReviewedRevised] = useState(false);
  const [commissionId, setCommissionId] = useState('');
  const [policyId, setPolicyId] = useState('');
  const [period, setPeriod] = useState(new Date().toISOString().slice(0, 7));
  const [sourceRef, setSourceRef] = useState('');
  const [premium, setPremium] = useState('');
  const [policyYear, setPolicyYear] = useState('1');
  const [reference, setReference] = useState('');
  const [amount, setAmount] = useState('');
  const [requestKind, setRequestKind] = useState<ServiceKind>('policy-information');
  const [subject, setSubject] = useState('');
  const [message, setMessage] = useState('');
  const [requestId, setRequestId] = useState('');
  const [reply, setReply] = useState('');
  const [replyFrom, setReplyFrom] = useState<'partner' | 'insurer'>('partner');
  const [offset, setOffset] = useState(0);
  const workspaceRequest = useRef(0);

  const loadAccess = useCallback(async () => {
    const result = await api<Access>('/partner-portal/access');
    setAccess(result);
    setPartnerId((current) => result.partners.some((p) => p.partnerId === current) ? current : result.partners[0]?.partnerId ?? '');
  }, []);
  const loadWorkspace = useCallback(async () => {
    if (!partnerId) { setWorkspace(null); return; }
    const requestId = ++workspaceRequest.current;
    const subchannel = subChannelCode ? `&subChannelCode=${encodeURIComponent(subChannelCode)}` : '';
    const result = await api<Workspace>(`/partner-portal/workspace?partnerId=${encodeURIComponent(partnerId)}${subchannel}&offset=${offset}&limit=50`);
    // A slow response for the previous partner/filter must not overwrite the current workspace.
    if (requestId === workspaceRequest.current) setWorkspace(result);
  }, [partnerId, subChannelCode, offset]);
  useEffect(() => { void loadAccess().catch((e: unknown) => setError(e instanceof Error ? e.message : String(e))); }, [loadAccess]);
  useEffect(() => { void loadWorkspace().catch((e: unknown) => setError(e instanceof Error ? e.message : String(e))); }, [loadWorkspace]);
  const partner = access?.partners.find((p) => p.partnerId === partnerId);
  // A sub-channel-restricted token has no "all routes" option. Pick its first permitted
  // route on initial load as well as on partner changes, so the select and submitted scope agree.
  useEffect(() => {
    if (!partner) return;
    setSubChannelCode((current) => partner.subChannels.some((s) => s.code === current) ? current : partner.allSubchannels ? '' : partner.subChannels[0]?.code ?? '');
  }, [partner]);
  const canOperate = Boolean(access?.demo || access?.internal || access?.roles.some((r) => ['partner-agent', 'partner-supervisor', 'partner-manager', 'partner-senior-manager'].includes(r)));
  const canReview = Boolean(access?.demo || access?.roles.some((r) => ['partner-supervisor', 'partner-manager', 'partner-senior-manager'].includes(r)));
  const canFinance = Boolean(access?.demo || (access?.internal && access.roles.some((r) => ['admin', 'administration', 'partner-finance'].includes(r))));
  const canUnderwrite = Boolean(access?.demo || (access?.internal && access.roles.some((r) => ['admin', 'administration', 'partner-underwriter'].includes(r))));
  const selectedStage = details?.stages.find((s) => s.id === stageId);
  const by = access?.demo ? actor : undefined;
  const scope = { partnerId, channelCode: partner?.channelCode, subChannelCode: subChannelCode || null };
  const policies = workspace?.cases.items.filter((c) => c.policyId) ?? [];
  // The all-routes filter can display policies from different sub-channels. Policy-bound
  // operations must use the selected policy's actual attribution, not the filter itself.
  const selectedPolicy = policies.find((c) => c.policyId === policyId);
  const policyScope = selectedPolicy?.scope ?? scope;
  const currentCase = workspace?.cases.items.find((c) => c.caseId === caseId);
  const selectedApplication = workspace?.applications.items.find((a) => a.id === applicationId);
  const selectedCommission = workspace?.commissions.items.find((c) => c.id === commissionId);
  const pending = workspace?.summary.pendingApplications ?? 0;
  const openRequests = workspace?.summary.openRequests ?? 0;
  const awaitingCommission = workspace?.summary.awaitingCommission ?? 0;

  const perform = useCallback(async (path: string, body: Record<string, unknown>, success: string) => {
    setBusy(true); setError(''); setNotice('');
    try {
      const result = await api<Record<string, unknown>>(path, 'POST', { ...body, ...(by ? { by } : {}) });
      if (result['accepted'] === false) throw new Error(String(result['reason']));
      await loadAccess(); await loadWorkspace();
      setNotice(success);
      return result;
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); return null; }
    finally { setBusy(false); }
  }, [by, loadAccess, loadWorkspace]);
  const downloadRevised = async (id: string) => {
    setError('');
    try {
      const quote = await api<{ pdf: { fileName: string; base64: string } }>(`/partner-portal/quotation?id=${encodeURIComponent(id)}`);
      const bytes = Uint8Array.from(atob(quote.pdf.base64), (character) => character.charCodeAt(0));
      const url = URL.createObjectURL(new Blob([bytes], { type: 'application/pdf' }));
      const link = document.createElement('a'); link.href = url; link.download = quote.pdf.fileName; link.click();
      window.setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
  };
  const openDetails = useCallback(async (id: string) => {
    if (!id) { setDetails(null); return; }
    try {
      const result = await api<CaseDetails>(`/partner-portal/journey?caseId=${encodeURIComponent(id)}`);
      setDetails(result);
      const stage = result.stages.find((s) => s.id === result.nextRecommended) ?? result.stages[0];
      setStageId(stage?.id ?? ''); setStageAnswers(stage?.answers ?? {}); setError('');
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
  }, []);
  const changeStage = (id: string) => { setStageId(id); setStageAnswers(details?.stages.find((s) => s.id === id)?.answers ?? {}); };
  const updateAnswer = (id: string, value: unknown) => setStageAnswers((old) => ({ ...old, [id]: value }));
  const commitStage = async (action: 'save' | 'submit') => {
    const parsed: Record<string, unknown> = { ...stageAnswers };
    try {
      for (const field of selectedStage?.fields ?? []) {
        if (['list', 'questionnaire'].includes(field.kind) && typeof parsed[field.id] === 'string') {
          const value = String(parsed[field.id]).trim();
          if (value) parsed[field.id] = JSON.parse(value);
          else delete parsed[field.id];
        }
      }
    } catch { setError(t('invalidJson')); return; }
    const result = await perform('/partner-portal/journey/stage', { caseId, stageId, action, answers: parsed }, action === 'save' ? t('draftSaved') : t('sectionSubmitted'));
    if (result) await openDetails(caseId);
  };
  const reviewerOptions = useMemo(() => ['supervisor', 'manager', 'senior-manager'].filter((r) => access?.demo || access?.roles.includes(`partner-${r}`)), [access]);
  const navigate = (next: Page) => { setPage(next); setOffset(0); setPolicyId(''); };
  const selectPartner = (id: string) => {
    const selected = access?.partners.find((p) => p.partnerId === id);
    setPartnerId(id); setSubChannelCode(selected?.allSubchannels ? '' : selected?.subChannels[0]?.code ?? '');
    ++workspaceRequest.current; setWorkspace(null); setDetails(null); setCaseId(''); setApplicationId(''); setCommissionId(''); setRequestId(''); setPolicyId(''); setOffset(0);
  };

  return <div className="pp">
    <aside className="pp-sidebar">
      <a className="pp-brand" href={offline ? '#' : '/'} aria-label={t('back')}><span className="pp-brand-mark">✣</span><span><b>{t('brand')}</b><small>{t('brandSubtitle')}</small></span></a>
      <div className="pp-sidebar-label">{t('workspaceLabel')}</div>
      <nav aria-label={t('workspace')} className="pp-nav">{PAGES.map((item) => <button key={item.id} aria-label={t(item.id)} aria-current={page === item.id ? 'page' : undefined} className={page === item.id ? 'active' : ''} onClick={() => navigate(item.id)}><span className="pp-nav-icon">{item.icon}</span><span>{t(item.id)}</span>{item.id === 'applications' && pending > 0 && <em>{pending}</em>}</button>)}</nav>
      <div className="pp-sidebar-bottom"><span className="pp-side-dot" /> {t('connected')}<small>{access?.demo ? t('demo') : access?.actor ?? '—'}</small><a href={offline ? '#' : '/'}>← {t('back')}</a></div>
    </aside>
    <main className="pp-main">
      <header className="pp-topbar"><div><span className="pp-top-kicker">CENTRAL / {t('workspaceLabel')}</span><div className="pp-top-title">{t('workspace')}</div></div><div className="pp-top-actions">{access?.partners.length ? <label className="pp-partner-select"><span>{t('partner')}</span><select aria-label={t('partner')} value={partnerId} onChange={(e) => selectPartner(e.target.value)}>{access.partners.map((p) => <option value={p.partnerId} key={p.partnerId}>{p.name}</option>)}</select></label> : null}<div className="pp-avatar" title={access?.actor ?? ''}>{(partner?.name ?? 'C').slice(0, 1)}</div></div></header>
      <div className="pp-content">
        {access?.demo && <div className="pp-demo"><b>{t('demo')}</b><span>{t('demoNotice')}</span></div>}
        {error && <div className="pp-message error" role="alert">{error}</div>}
        {notice && <div className="pp-message success" role="status">{notice}</div>}
        {!access && <div className="pp-auth"><h1>{t('workspace')}</h1><p>{error ? t('error') : t('loading')}</p><Field label={t('token')}><input type="password" value={token} onChange={(e) => setToken(e.target.value)} /></Field><p>{t('tokenHelp')}</p><button onClick={() => { window.sessionStorage.setItem('portal-api-token', token); setError(''); void loadAccess().catch((e: unknown) => setError(e instanceof Error ? e.message : String(e))); }}>{t('saveToken')}</button></div>}
        {access && !partner && <div className="pp-welcome"><div className="pp-welcome-icon">✣</div><div className="pp-eyebrow">{t('workspaceLabel')}</div><h1>{t('portalTitle')}</h1><p>{t('portalIntro')}</p><div className="pp-empty-setup"><h3>{t('noPartners')}</h3><p>{t('noPartnersHelp')}</p>{access.demo && <button disabled={busy} onClick={() => void perform('/partner-portal/demo/setup', {}, t('sampleCreated'))}>{t('sample')} <span>→</span></button>}<a href={offline ? '#' : '/'}>{t('setup')} ↗</a></div></div>}
        {access && partner && <>
          <div className="pp-breadcrumb">{t('workspace')} <span>/</span> {t(page)}</div>
          <div className="pp-heading"><div><div className="pp-eyebrow">{partner.channelCode} <span>·</span> {partner.country} / {partner.currency}</div><h1>{page === 'overview' ? t('dashboard') : t(page)}</h1><p>{page === 'overview' ? t('dashboardSubtitle') : page === 'applications' ? t('applicationIntro') : page === 'commissions' ? t('commissionIntro') : page === 'requests' ? t('requestsIntro') : page === 'reports' ? t('reportsIntro') : t('auditIntro')}</p></div><button className="pp-outline" onClick={() => void loadWorkspace().catch((e: unknown) => setError(String(e)))}>↻ &nbsp;{t('refresh')}</button></div>
          <div className="pp-context"><div><span className="pp-context-icon">◈</span><div><b>{partner.name}</b><small>{partner.channelCode} · {partner.partnerId}</small></div></div><Field label={t('subchannel')}><select value={subChannelCode} onChange={(e) => { setSubChannelCode(e.target.value); ++workspaceRequest.current; setWorkspace(null); setDetails(null); setCaseId(''); setApplicationId(''); setCommissionId(''); setRequestId(''); setPolicyId(''); setOffset(0); }}>{partner.allSubchannels && <option value="">{t('allRoutes')}</option>}{partner.subChannels.map((s) => <option key={s.code} value={s.code}>{s.name}</option>)}</select></Field>{access.demo && <Field label={t('actor')}><input value={actor} onChange={(e) => setActor(e.target.value)} /></Field>}</div>
          {page === 'overview' && <>
            <div className="pp-stats"><button onClick={() => navigate('applications')}><span className="pp-stat-icon blue">▤</span><small>{t('caseCount')}</small><strong>{workspace?.cases.total ?? '—'}</strong><em>{t('viewApplications')} →</em></button><button onClick={() => navigate('applications')}><span className="pp-stat-icon gold">◷</span><small>{t('pending')}</small><strong>{pending}</strong><em>{t('viewApplications')} →</em></button><button onClick={() => navigate('commissions')}><span className="pp-stat-icon teal">◈</span><small>{t('reconciliations')}</small><strong>{awaitingCommission}</strong><em>{t('viewCommissions')} →</em></button><button onClick={() => navigate('requests')}><span className="pp-stat-icon violet">✉</span><small>{t('openRequests')}</small><strong>{openRequests}</strong><em>{t('viewRequests')} →</em></button></div>
            <div className="pp-overview-grid"><section className="pp-panel pp-action-panel"><div className="pp-panel-heading"><div><span className="pp-eyebrow">{t('eyebrowWorkspace')}</span><h2>{t('keepMoving')}</h2><p>{t('overviewHelp')}</p></div></div><div className="pp-quicklinks"><button onClick={() => navigate('applications')}><span className="pp-quick-icon blue">▤</span><span><b>{t('applicationQuickLink')}</b><small>{t('applicationQuickHelp')}</small></span><i>→</i></button><button onClick={() => navigate('commissions')}><span className="pp-quick-icon teal">◈</span><span><b>{t('commissionQuickLink')}</b><small>{t('commissionQuickHelp')}</small></span><i>→</i></button><button onClick={() => navigate('requests')}><span className="pp-quick-icon violet">✉</span><span><b>{t('serviceQuickLink')}</b><small>{t('serviceQuickHelp')}</small></span><i>→</i></button></div></section><section className="pp-panel pp-timeline"><div className="pp-panel-heading"><div><span className="pp-eyebrow">{t('eyebrowActivity')}</span><h2>{t('activity')}</h2></div><button className="pp-text" onClick={() => navigate('audit')}>{t('viewAll')} →</button></div>{!workspace?.audit.items.length ? <Empty>{t('noActivity')}</Empty> : workspace.audit.items.slice(0, 5).map((item, i) => <div className="pp-activity" key={`${item.recordId}-${i}`}><span className="pp-activity-dot" /><div><b>{label(item.action)}</b><small>{item.recordId} · {item.by}</small><time>{date(item.at)}</time></div></div>)}</section></div>
            <div className="pp-process"><div><span className="pp-process-icon">↗</span><span><small>{t('guidance')}</small><b>{t('steps')}</b></span></div><button className="pp-text" onClick={() => navigate('applications')}>{t('viewApplications')} →</button></div>
          </>}
          {page === 'applications' && <>
            <div className="pp-inline-warning">{t('quoteLimitation')}</div>
            {canOperate && <div className="pp-two-col"><section className="pp-panel"><div className="pp-panel-heading"><div><span className="pp-eyebrow">{t('eyebrowStart')}</span><h2>{t('newJourney')}</h2><p>{t('newJourneyHelp')}</p></div></div><div className="pp-form"><Field label={t('customer')}><input value={customer} onChange={(e) => setCustomer(e.target.value)} placeholder={t('customer')} /></Field><button disabled={busy || !customer} onClick={() => void perform('/partner-portal/journey/open', { ...scope, customerName: customer }, t('journeyCreated')).then((r) => { if (r?.['caseId']) { setCaseId(String(r['caseId'])); void openDetails(String(r['caseId'])); } })}>{t('create')} →</button></div></section><section className="pp-panel"><div className="pp-panel-heading"><div><span className="pp-eyebrow">{t('eyebrowExisting')}</span><h2>{t('attach')}</h2><p>{t('attachHelp')}</p></div></div><div className="pp-form"><Field label={t('case')}><input value={caseId} onChange={(e) => setCaseId(e.target.value)} placeholder="JNY-000001" /></Field><button className="pp-outline" disabled={busy || !caseId} onClick={() => void perform('/partner-portal/journey/attach', { ...scope, caseId }, t('journeyLinked'))}>{t('attach')}</button></div></section></div>}
            <section className="pp-panel"><div className="pp-panel-heading"><div><span className="pp-eyebrow">{t('eyebrowBusiness')}</span><h2>{t('caseCount')}</h2></div></div>{!workspace?.cases.items.length ? <Empty>{t('emptyApplications')}</Empty> : <div className="pp-table-wrap"><table><thead><tr><th>{t('journeyCustomer')}</th><th>{t('routeColumn')}</th><th>{t('quotation')}</th><th>{t('review')}</th><th>{t('policy')}</th><th></th></tr></thead><tbody>{workspace.cases.items.map((c) => <tr key={c.caseId}><td><b>{c.caseId}</b><small>{c.customerName}</small></td><td>{c.scope.subChannelCode ?? t('allRoutes')}</td><td>{c.quotationId ?? '—'}</td><td><Status value={c.partnerApplication} /></td><td>{c.policyId ?? '—'}</td><td><button className="pp-mini" onClick={() => { setCaseId(c.caseId); void openDetails(c.caseId); }}>{t('openJourney')}</button>{canOperate && c.quotationId && <button className="pp-mini" disabled={busy} onClick={() => void perform('/partner-portal/applications/submit', { caseId: c.caseId }, t('applicationSubmitted'))}>{t('submitReview')}</button>}</td></tr>)}</tbody></table></div>}</section>
            {details && <section className="pp-panel"><div className="pp-panel-heading"><div><span className="pp-eyebrow">{details.caseId} / {t('caseEditor').toUpperCase()}</span><h2>{t('caseEditor')}</h2><p>{t('editorHint')}</p></div></div><div className="pp-form"><Field label={t('stage')}><select value={stageId} onChange={(e) => changeStage(e.target.value)}>{details.stages.map((s) => <option key={s.id} value={s.id}>{s.title} — {s.status}</option>)}</select></Field><Status value={selectedStage?.status ?? ''} /></div>{selectedStage?.blockers.length ? <div className="pp-inline-warning">{selectedStage.blockers.join(' · ')}</div> : null}{selectedStage?.missing.length ? <p className="pp-muted">{t('required')}: {selectedStage.missing.join(', ')}</p> : null}{(stageId === 'uw-review' || stageId === 'medical') && !canUnderwrite ? <div className="pp-inline-warning">{t('insurerOnly')}</div> : <><div className="pp-form-grid">{selectedStage?.fields.map((f) => <Field key={f.id} label={`${f.label}${f.mandatory ? ' *' : ''}`} wide={['list', 'questionnaire'].includes(f.kind)}>{f.kind === 'boolean' ? <select value={stageAnswers[f.id] === true ? 'true' : stageAnswers[f.id] === false ? 'false' : ''} onChange={(e) => updateAnswer(f.id, e.target.value === '' ? undefined : e.target.value === 'true')}><option value="">—</option><option value="true">{t('yes')}</option><option value="false">{t('no')}</option></select> : ['list', 'questionnaire'].includes(f.kind) ? <textarea rows={3} value={typeof stageAnswers[f.id] === 'string' ? String(stageAnswers[f.id]) : stageAnswers[f.id] === undefined ? '' : JSON.stringify(stageAnswers[f.id], null, 2)} onChange={(e) => updateAnswer(f.id, e.target.value)} placeholder={f.hint || t('jsonArray')} /> : f.options.length ? <select value={String(stageAnswers[f.id] ?? '')} onChange={(e) => updateAnswer(f.id, e.target.value)}><option value="">—</option>{f.options.map((v) => <option key={v} value={v}>{v}</option>)}</select> : <input type={f.kind === 'date' ? 'date' : 'text'} value={String(stageAnswers[f.id] ?? '')} onChange={(e) => updateAnswer(f.id, e.target.value)} placeholder={f.hint} />}</Field>)}</div><div className="pp-actions"><button className="pp-outline" disabled={busy || !canOperate} onClick={() => void commitStage('save')}>{t('save')}</button><button disabled={busy || !canOperate} onClick={() => void commitStage('submit')}>{t('submit')}</button></div></>}</section>}
            <section className="pp-panel"><div className="pp-panel-heading"><div><span className="pp-eyebrow">{t('eyebrowReview')}</span><h2>{t('approval')}</h2></div></div>{!workspace?.applications.items.length ? <Empty>{t('emptyApprovals')}</Empty> : <><div className="pp-table-wrap"><table><thead><tr><th>{t('application')}</th><th>{t('submitted')}</th><th>{t('status')}</th><th>{t('route')}</th><th></th></tr></thead><tbody>{workspace.applications.items.map((a) => <tr key={a.id}><td><b>{a.id}</b><small>{a.caseId} · {a.quotationId} v{a.quotationVersion}</small></td><td>{a.submittedBy}<small>{date(a.submittedAt)}</small></td><td><Status value={a.status} /></td><td>{a.route ? <>{label(a.route.route)}<small>{a.route.assignedTo}</small></> : '—'}</td><td><button className="pp-mini" onClick={() => { setApplicationId(a.id); setRevisedSigner(''); setReviewedRevised(false); setTermsReconciled(false); }}>{t('select')}</button></td></tr>)}</tbody></table></div>{(canReview || canUnderwrite) && <div className="pp-form-grid pp-review-form"><Field label={t('application')}><select value={applicationId} onChange={(e) => { setApplicationId(e.target.value); setRevisedSigner(''); setReviewedRevised(false); setTermsReconciled(false); }}><option value="">—</option>{workspace.applications.items.map((a) => <option key={a.id} value={a.id}>{a.id} · {a.caseId}</option>)}</select></Field>{canReview && <Field label={t('role')}><select value={reviewerOptions.includes(reviewRole) ? reviewRole : reviewerOptions[0] ?? ''} onChange={(e) => setReviewRole(e.target.value)}>{reviewerOptions.map((r) => <option key={r} value={r}>{label(r)}</option>)}</select></Field>}<Field label={t('reviewNote')} wide><input value={reviewNote} onChange={(e) => setReviewNote(e.target.value)} placeholder={t('reviewPlaceholder')} /></Field>{canUnderwrite && <Field label={t('termsReconciled')} wide><input type="checkbox" checked={termsReconciled} onChange={(e) => setTermsReconciled(e.target.checked)} /></Field>}<div className="pp-actions wide">{canReview && ['approved', 'returned', 'rejected'].map((outcome) => <button key={outcome} className={outcome === 'approved' ? '' : 'pp-outline'} disabled={busy || !applicationId} onClick={() => void perform('/partner-portal/applications/review', { id: applicationId, role: reviewerOptions.includes(reviewRole) ? reviewRole : reviewerOptions[0], outcome, note: reviewNote }, t(`applicationOutcome.${outcome}`))}>{t(outcome === 'approved' ? 'approve' : outcome === 'returned' ? 'return' : 'reject')}</button>)}{canUnderwrite && <button className="pp-outline" disabled={busy || !applicationId || !termsReconciled} onClick={() => void perform('/partner-portal/underwriting/review', { id: applicationId, note: reviewNote, termsReconciled }, t('underwritingRecorded'))}>{t('underwriterReview')}</button>}</div></div>}</>}</section>
            {selectedApplication?.review && <ApplicationHistory entry={selectedApplication} />}
            {selectedApplication && <section className="pp-panel"><div className="pp-panel-heading"><div><span className="pp-eyebrow">{selectedApplication.id}</span><h2>{t('revisedTerms')}</h2></div></div><div className="pp-inline-warning">{t('revisedWarning')}</div>
              {selectedApplication.revisedQuotation && <p className="pp-muted">{selectedApplication.revisedQuotation.quotationId} · v{selectedApplication.revisedQuotation.version}</p>}
              <div className="pp-actions">{canUnderwrite && <button className="pp-outline" disabled={busy || selectedApplication.status !== 'approved'} onClick={() => void perform('/partner-portal/quotation/reissue', { id: selectedApplication.id }, t('revisedPrepared'))}>{t('reissueQuote')}</button>}
                {selectedApplication.revisedQuotation && <button className="pp-outline" disabled={busy} onClick={() => void downloadRevised(selectedApplication.id)}>{t('downloadRevised')}</button>}</div>
              {selectedApplication.revisedQuotation && canOperate && <div className="pp-form-grid pp-review-form"><Field label={t('revisedSignature')}><input value={revisedSigner} onChange={(e) => setRevisedSigner(e.target.value)} /></Field><Field label={t('reviewedRevised')} wide><input type="checkbox" checked={reviewedRevised} onChange={(e) => setReviewedRevised(e.target.checked)} /></Field><div className="pp-actions"><button disabled={busy || !revisedSigner.trim() || !reviewedRevised} onClick={() => void perform('/partner-portal/quotation/accept', { id: selectedApplication.id, signedBy: revisedSigner, reviewedWithCustomer: reviewedRevised }, t('revisedAccepted')).then((result) => { if (result) { setRevisedSigner(''); setReviewedRevised(false); } })}>{t('recordAcceptance')}</button></div></div>}
            </section>}
          </>}
          {page === 'commissions' && <>
            <div className="pp-inline-warning">{t('externalOnly')} {t('commissionWarning')}</div>
            {canFinance && <section className="pp-panel"><div className="pp-panel-heading"><div><span className="pp-eyebrow">{t('eyebrowFinance')}</span><h2>{t('addAccrual')}</h2></div></div><div className="pp-form-grid"><Field label={t('policy')}><select value={policyId} onChange={(e) => setPolicyId(e.target.value)}><option value="">—</option>{policies.map((c) => <option key={c.caseId} value={c.policyId!}>{c.policyId} · {c.customerName} · {c.scope.subChannelCode ?? t('allRoutes')}</option>)}</select></Field><Field label={t('period')}><input value={period} onChange={(e) => setPeriod(e.target.value)} placeholder="2026-10" /></Field><Field label={t('accrualRef')}><input value={sourceRef} onChange={(e) => setSourceRef(e.target.value)} /></Field><Field label={`${t('premium')} (${partner.currency})`}><input value={premium} onChange={(e) => setPremium(e.target.value)} /></Field><Field label={t('policyYear')}><input type="number" min="1" value={policyYear} onChange={(e) => setPolicyYear(e.target.value)} /></Field><div className="pp-actions"><button disabled={busy || !policyId} onClick={() => void perform('/partner-portal/commission/accrue', { ...policyScope, policyId, period, sourceRef, premium, policyYear: Number(policyYear) }, t('accrualRecorded'))}>{t('addAccrual')}</button></div></div></section>}
            <section className="pp-panel"><div className="pp-panel-heading"><div><span className="pp-eyebrow">{t('eyebrowReconciliation')}</span><h2>{t('commissions')}</h2></div></div>{!workspace?.commissions.items.length ? <Empty>{t('emptyCommission')}</Empty> : <><div className="pp-table-wrap"><table><thead><tr><th>{t('accrualPolicy')}</th><th>{t('periodColumn')}</th><th>{t('expected')}</th><th>{t('insurerStatement')}</th><th>{t('difference')}</th><th>{t('recordedPaid')}</th><th>{t('status')}</th><th></th></tr></thead><tbody>{workspace.commissions.items.map((c) => <tr key={c.id}><td><b>{c.id}</b><small>{c.policyId} · {c.sourceRef}</small></td><td>{c.period}</td><td>{c.expected}</td><td>{c.statement ?? '—'}</td><td>{c.difference ?? '—'}</td><td>{c.disbursed}</td><td><Status value={c.status} /></td><td><button className="pp-mini" onClick={() => setCommissionId(c.id)}>{t('select')}</button></td></tr>)}</tbody></table></div><div className="pp-form-grid pp-review-form"><Field label={t('commissions')}><select value={commissionId} onChange={(e) => setCommissionId(e.target.value)}><option value="">—</option>{workspace.commissions.items.map((c) => <option key={c.id} value={c.id}>{c.id} · {c.policyId}</option>)}</select></Field><Field label={t('reference')}><input value={reference} onChange={(e) => setReference(e.target.value)} /></Field><Field label={t('amount')}><input value={amount} onChange={(e) => setAmount(e.target.value)} /></Field>{canReview && <Field label={t('role')}><select value={reviewerOptions.includes(reviewRole) ? reviewRole : reviewerOptions[0] ?? ''} onChange={(e) => setReviewRole(e.target.value)}>{reviewerOptions.map((r) => <option key={r} value={r}>{label(r)}</option>)}</select></Field>}<Field label={t('reviewNote')} wide><input value={reviewNote} onChange={(e) => setReviewNote(e.target.value)} /></Field><div className="pp-actions wide">{canFinance && <><button className="pp-outline" disabled={busy || !commissionId} onClick={() => void perform('/partner-portal/commission/statement', { id: commissionId, reference, amount }, t('statementRecorded'))}>{t('addStatement')}</button><button className="pp-outline" disabled={busy || !commissionId} onClick={() => void perform('/partner-portal/commission/disbursement', { id: commissionId, reference, amount }, t('disbursementRecorded'))}>{t('addDisbursement')}</button></>}{canReview && ['approved', 'disputed'].map((outcome) => <button key={outcome} className={outcome === 'disputed' ? 'pp-outline' : ''} disabled={busy || !commissionId} onClick={() => void perform('/partner-portal/commission/review', { id: commissionId, role: reviewerOptions.includes(reviewRole) ? reviewRole : reviewerOptions[0], outcome, note: reviewNote }, t(`commissionOutcome.${outcome}`))}>{t(outcome === 'approved' ? 'approve' : 'dispute')}</button>)}</div></div></>}</section>
            {selectedCommission && <CommissionHistory entry={selectedCommission} />}
          </>}
          {page === 'requests' && <>
            {canOperate && <section className="pp-panel"><div className="pp-panel-heading"><div><span className="pp-eyebrow">{t('eyebrowConversation')}</span><h2>{t('requests')}</h2></div></div><div className="pp-form-grid"><Field label={t('requestType')}><select value={requestKind} onChange={(e) => setRequestKind(e.target.value as ServiceKind)}>{SERVICE_KINDS.map((k) => <option key={k} value={k}>{label(k)}</option>)}</select></Field><Field label={t('policy')}><select value={policyId} onChange={(e) => setPolicyId(e.target.value)}><option value="">—</option>{policies.map((c) => <option key={c.caseId} value={c.policyId!}>{c.policyId} · {c.customerName} · {c.scope.subChannelCode ?? t('allRoutes')}</option>)}</select></Field><Field label={t('subject')} wide><input value={subject} onChange={(e) => setSubject(e.target.value)} /></Field><Field label={t('message')} wide><textarea rows={3} value={message} onChange={(e) => setMessage(e.target.value)} /></Field><div className="pp-actions wide"><button disabled={busy} onClick={() => void perform('/partner-portal/requests/open', { ...(policyId ? policyScope : scope), kind: requestKind, policyId, subject, message }, t('requestSent')).then((r) => { if (r) { setSubject(''); setMessage(''); } })}>{t('send')} →</button></div></div></section>}
            <section className="pp-panel"><div className="pp-panel-heading"><div><span className="pp-eyebrow">{t('eyebrowConversations')}</span><h2>{t('requests')}</h2></div></div>{!workspace?.requests.items.length ? <Empty>{t('emptyRequests')}</Empty> : <div className="pp-request-list">{workspace.requests.items.map((r) => <article key={r.id} className="pp-request"><div className="pp-request-head"><div><b>{r.subject}</b><small>{r.id} · {label(r.kind)}{r.policyId ? ` · ${r.policyId}` : ''}</small></div><Status value={r.status} /></div>{r.messages.map((m, i) => <p key={i}><b>{m.from === 'insurer' ? t('insurer') : t('partner')} · {m.by}</b><span>{m.text}</span><small>{date(m.at)}</small></p>)}{r.status !== 'closed' && <button className="pp-mini" onClick={() => setRequestId(r.id)}>{t('reply')}</button>}</article>)}</div>}{workspace?.requests.items.length ? <div className="pp-form-grid pp-review-form"><Field label={t('requests')}><select value={requestId} onChange={(e) => setRequestId(e.target.value)}><option value="">—</option>{workspace.requests.items.filter((r) => r.status !== 'closed').map((r) => <option key={r.id} value={r.id}>{r.id} · {r.subject}</option>)}</select></Field>{access.demo && <Field label={t('demoReplyAs')}><select value={replyFrom} onChange={(e) => setReplyFrom(e.target.value as 'partner' | 'insurer')}><option value="partner">{t('partner')}</option><option value="insurer">{t('insurer')}</option></select></Field>}<Field label={t('message')} wide><textarea rows={2} value={reply} onChange={(e) => setReply(e.target.value)} /></Field><div className="pp-actions wide"><button disabled={busy || !requestId} onClick={() => void perform('/partner-portal/requests/reply', { id: requestId, from: replyFrom, message: reply }, t('replyRecorded')).then((r) => { if (r) setReply(''); })}>{t('reply')}</button>{(access.internal || (access.demo && replyFrom === 'insurer')) && <button className="pp-outline" disabled={busy || !requestId} onClick={() => void perform('/partner-portal/requests/reply', { id: requestId, from: replyFrom, message: reply, close: true }, t('requestClosed')).then((r) => { if (r) setReply(''); })}>{t('close')}</button>}</div></div> : null}</section>
          </>}
          {page === 'reports' && <><section className="pp-panel"><div className="pp-panel-heading"><div><h2>{t('operationalReport')}</h2></div></div>{workspace && <><div className="pp-report">{([
            ['caseCount', workspace.summary.journeys], ['issuedPolicies', workspace.summary.issuedPolicies], ['submittedApplications', workspace.summary.submittedApplications],
            ['pending', workspace.summary.pendingApplications], ['approvedApplications', workspace.summary.approvedApplications], ['openRequests', workspace.summary.openRequests], ['closedRequests', workspace.summary.closedRequests],
          ] as const).map(([name, count]) => <div key={name}><span>{count}</span><small>{t(name)}</small></div>)}</div>{workspace.summary.requestsByType.length > 0 && <div><h3>{t('requestsByType')}</h3><div className="pp-report">{workspace.summary.requestsByType.map((r) => <div key={r.kind}><span>{r.count}</span><small>{label(r.kind)}</small></div>)}</div></div>}</>}</section><section className="pp-panel"><div className="pp-panel-heading"><div><span className="pp-eyebrow">{t('eyebrowCommissionSummary')}</span><h2>{t('reports')}</h2><p>{t('reportsHelp')}</p></div></div>{!workspace?.reports.length ? <Empty>{t('emptyReports')}</Empty> : workspace.reports.map((r) => <div className="pp-report" key={r.currency}><div><span>{r.currency}</span><small>{t('currency')}</small></div>{(['accrued', 'stated', 'approved', 'disbursed', 'outstanding'] as const).map((k) => <div key={k}><span>{r[k]}</span><small>{t(k)}</small></div>)}</div>)}</section></>}
          {page === 'audit' && <section className="pp-panel"><div className="pp-panel-heading"><div><span className="pp-eyebrow">{t('eyebrowHistory')}</span><h2>{t('audit')}</h2></div></div>{!workspace?.audit.items.length ? <Empty>{t('noActivity')}</Empty> : <div className="pp-table-wrap"><table><thead><tr><th>{t('timeUtc')}</th><th>{t('actorColumn')}</th><th>{t('actionColumn')}</th><th>{t('reference')}</th><th>{t('details')}</th></tr></thead><tbody>{workspace.audit.items.map((a, i) => <tr key={`${a.recordId}-${i}`}><td>{date(a.at)}</td><td>{a.by}</td><td>{label(a.action)}</td><td>{a.recordId}</td><td>{a.detail}</td></tr>)}</tbody></table></div>}</section>}
          {workspace && <div className="pp-pagination"><button className="pp-text" disabled={offset === 0} onClick={() => setOffset(Math.max(0, offset - 50))}>{t('previous')}</button><span>{t('records')} {offset + 1}–{offset + 50}</span><button className="pp-text" disabled={Math.max(workspace.cases.total, workspace.applications.total, workspace.commissions.total, workspace.requests.total, workspace.audit.total) <= offset + 50} onClick={() => setOffset(offset + 50)}>{t('next')}</button></div>}
          {currentCase && details && <span className="pp-sr-only">{currentCase.caseId}</span>}
        </>}
      </div>
      <footer className="pp-footer"><span>{t('footer')}</span><span>{t('footerTagline')}<b>✣</b></span></footer>
    </main>
  </div>;
}
