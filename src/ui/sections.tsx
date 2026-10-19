/**
 * Collapsible sections that open themselves.
 *
 * Every panel in this console used to render all of its cards at once, which is fine for a dashboard
 * and useless for a process: an operator creating a customer faces nine open forms and no idea which
 * one to fill in first. This component is the fix, and the rule it enforces is the one the domain
 * core computes:
 *
 *  - every section starts closed;
 *  - exactly one section is "recommended" — the first whose predecessors are all 100% complete;
 *  - the recommended section opens itself, and when the operator finishes it, it closes and the next
 *    one opens, with the scroll following;
 *  - a section behind an incomplete one is locked: clicking it explains what is missing instead of
 *    opening a form that cannot be submitted;
 *  - a completed section can be reopened to review or amend, because "review and update" screens
 *    exist for a reason.
 *
 * The component owns no business rules. It is given a status and a percentage per section, so the
 * same rail drives the customer journey, a quotation, a policy conversion, an alteration or a claim.
 */
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { GuideBanner } from './guide';

export type SectionStatus = 'complete' | 'in-progress' | 'ready' | 'blocked' | 'locked';

export interface SectionModel {
  readonly id: string;
  readonly order?: number;
  readonly title: string;
  readonly subtitle?: string;
  readonly status: SectionStatus;
  /** 0–100 over the section's mandatory fields and domain gates. */
  readonly percent: number;
  readonly missing?: readonly string[];
  readonly blockers?: readonly string[];
  readonly warnings?: readonly string[];
  readonly lockedByTitle?: string | null;
  /** The engine says this is the section to open now. */
  readonly autoOpen?: boolean;
  readonly meta?: React.ReactNode;
  readonly badges?: React.ReactNode;
  readonly children?: React.ReactNode;
  readonly footer?: React.ReactNode;
}

const STATUS_LABEL: Record<SectionStatus, string> = {
  complete: 'complete',
  'in-progress': 'in progress',
  ready: 'ready',
  blocked: 'blocked',
  locked: 'locked',
};

const STATUS_TONE: Record<SectionStatus, 'ok' | 'warn' | 'bad' | 'info'> = {
  complete: 'ok',
  'in-progress': 'warn',
  ready: 'info',
  blocked: 'bad',
  locked: 'info',
};

export const SectionPill: React.FC<{ status: SectionStatus; children?: React.ReactNode }> = ({ status, children }) => (
  <span className={`pill ${STATUS_TONE[status]}`}>{children ?? STATUS_LABEL[status]}</span>
);

const Bar: React.FC<{ percent: number; status: SectionStatus }> = ({ percent, status }) => (
  <span className={`bar ${status === 'complete' ? 'done' : ''}`} aria-hidden="true">
    <i style={{ width: `${Math.max(0, Math.min(100, percent))}%` }} />
  </span>
);

/** The mandatory fields still outstanding, as a checklist the operator can work down. */
export const MissingList: React.FC<{ missing?: readonly string[]; blockers?: readonly string[]; warnings?: readonly string[] }> = ({ missing, blockers, warnings }) => {
  const hasMissing = (missing?.length ?? 0) > 0;
  const hasBlockers = (blockers?.length ?? 0) > 0;
  const hasWarnings = (warnings?.length ?? 0) > 0;
  if (!hasMissing && !hasBlockers && !hasWarnings) return null;
  return (
    <div className="gateNotes">
      {hasBlockers && (
        <div className="errorBox small">
          <b>Stopped by:</b>
          <ul className="list">{blockers!.map((b, i) => <li key={`${i}-${b}`}>{b}</li>)}</ul>
        </div>
      )}
      {hasMissing && (
        <div className="checklist">
          <b className="small muted">Mandatory fields still outstanding ({missing!.length})</b>
          <ul>{missing!.map((m) => <li key={m}>{m}</li>)}</ul>
        </div>
      )}
      {hasWarnings && (
        <div className="warnBox small">
          <ul className="list">{warnings!.map((w, i) => <li key={`${i}-${w}`}>{w}</li>)}</ul>
        </div>
      )}
    </div>
  );
};

export interface SectionStackProps {
  readonly sections: readonly SectionModel[];
  readonly title?: string;
  readonly headline?: React.ReactNode;
  readonly overallPercent?: number;
  readonly completeCount?: number;
  readonly totalCount?: number;
  readonly aside?: React.ReactNode;
  /** Called when the operator opens or closes a section by hand. */
  readonly onManualToggle?: (id: string, open: boolean) => void;
  readonly storageKey?: string;
}

/**
 * The rail. Sections are rendered closed; the recommended one opens itself and the scroll follows.
 */
export const SectionStack: React.FC<SectionStackProps> = ({
  sections, title = 'Sections', headline, overallPercent, completeCount, totalCount, aside, onManualToggle,
}) => {
  const recommended = useMemo(() => {
    const flagged = sections.find((s) => s.autoOpen);
    if (flagged) return flagged.id;
    const open = sections.find((s) => s.status !== 'complete' && s.status !== 'locked');
    return open?.id ?? null;
  }, [sections]);

  const [openId, setOpenId] = useState<string | null>(recommended);
  const lastAuto = useRef<string | null | undefined>(undefined);
  const refs = useRef(new Map<string, HTMLElement>());

  // Auto-advance: only when the recommendation *changes*, so an operator who deliberately closes the
  // current section is not fighting the console, and a re-render does not re-open it behind them.
  useEffect(() => {
    if (recommended === lastAuto.current) return;
    lastAuto.current = recommended;
    setOpenId(recommended);
    if (!recommended) return;
    const node = refs.current.get(recommended);
    if (node && typeof node.scrollIntoView === 'function') {
      node.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }
  }, [recommended]);

  const toggle = useCallback((section: SectionModel) => {
    if (section.status === 'locked') {
      setOpenId((current) => (current === section.id ? null : section.id));   // shows the lock note only
      return;
    }
    setOpenId((current) => {
      const next = current === section.id ? null : section.id;
      onManualToggle?.(section.id, next === section.id);
      return next;
    });
  }, [onManualToggle]);

  const total = totalCount ?? sections.length;
  const done = completeCount ?? sections.filter((s) => s.status === 'complete').length;

  return (
    <section className="card sections" style={{ gridColumn: '1 / -1' }}>
      <header className="sectionsHead">
        <div>
          <h3>{title}</h3>
          {headline && <p>{headline}</p>}
        </div>
        <div className="sectionsRail">
          {typeof overallPercent === 'number' && (
            <span className="railPercent"><b>{overallPercent}%</b><Bar percent={overallPercent} status={overallPercent === 100 ? 'complete' : 'in-progress'} /></span>
          )}
          <span className="pill info">{done} of {total} complete</span>
          {recommended && (
            <button className="ghost" onClick={() => {
              setOpenId(recommended);
              const node = refs.current.get(recommended);
              node?.scrollIntoView({ behavior: 'smooth', block: 'start' });
            }}>
              Jump to the open section
            </button>
          )}
        </div>
      </header>

      {aside}

      <div className="sectionList">
        {sections.map((section, index) => {
          const open = openId === section.id;
          const locked = section.status === 'locked';
          const isRecommended = recommended === section.id;
          return (
            <div
              key={section.id}
              className={`section ${section.status}${open ? ' open' : ''}${isRecommended ? ' recommended' : ''}`}
              ref={(node) => { if (node) refs.current.set(section.id, node); else refs.current.delete(section.id); }}
            >
              <div className="sectionHead">
                <button
                  type="button"
                  className="sectionToggle"
                  aria-expanded={open}
                  aria-controls={`section-body-${section.id}`}
                  onClick={() => toggle(section)}
                >
                  <span className="sectionNo">{section.order ?? index + 1}</span>
                  <span className="sectionTitle">
                    <b>{section.title}</b>
                    {section.subtitle && <small>{section.subtitle}</small>}
                  </span>
                  <span className="sectionState">
                    {section.badges}
                    <Bar percent={section.percent} status={section.status} />
                    <span className="sectionPct">{section.percent}%</span>
                    <SectionPill status={section.status} />
                    <span className="chev" aria-hidden="true">{locked ? '🔒' : open ? '▾' : '▸'}</span>
                  </span>
                </button>
              </div>
              {/* The sticky note: stuck below the heading, arrow down at the form. The section the
                  engine recommends gets the full paper; the ones behind it get the tighter one. */}
              <div className="sectionGuideSlot">
                <GuideBanner compact={!isRecommended} section={section.id} title={section.title} status={section.status}
                  percent={section.percent} missing={section.missing} blockers={section.blockers} step={section.order ?? index + 1} />
              </div>

              {locked && open && (
                <div className="sectionBody" id={`section-body-${section.id}`}>
                  <div className="warnBox small">
                    This section is closed until <b>{section.lockedByTitle ?? 'the section before it'}</b> is 100% complete.
                    The sequence is enforced by the same gate the API uses, so nothing here can be submitted early.
                  </div>
                  <MissingList missing={section.missing} blockers={section.blockers} />
                </div>
              )}

              {!locked && open && (
                <div className="sectionBody" id={`section-body-${section.id}`}>
                  {section.meta && <div className="sectionMeta">{section.meta}</div>}
                  <MissingList missing={section.missing} blockers={section.blockers} warnings={section.warnings} />
                  {section.children}
                  {section.footer && <div className="sectionFooter">{section.footer}</div>}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </section>
  );
};

/** A read-only summary table inside a section: label, value, optional tone. */
export const SummaryRows: React.FC<{ rows: ReadonlyArray<{ label: string; value: string; tone?: 'ok' | 'warn' | 'bad' | 'info' }> }> = ({ rows }) => {
  if (rows.length === 0) return null;
  return (
    <div className="summaryRows">
      {rows.map((r, i) => (
        <div className="stat" key={`${i}-${r.label}`}>
          <span>{r.label}</span>
          <b className={r.tone === 'bad' ? 'bad' : r.tone === 'warn' ? 'warnText' : undefined}>{r.value}</b>
        </div>
      ))}
    </div>
  );
};


/* ------------------------------------------------------------------ gate-driven sections
 * Panels that are a process rather than a dashboard describe their sections as gates: what has to be
 * filled in, whether the step has been taken, and what the section renders. `gateSections` turns that
 * into the same rail the customer journey uses — everything closed, one section open, the next one
 * opening itself when this one is complete — so an operator gets the same behaviour on a claim, a
 * conversion or an alteration as they do on a new sale.
 */

export interface GateField { readonly label: string; readonly filled: boolean }

export interface SectionGate {
  readonly id: string;
  readonly title: string;
  readonly subtitle?: string;
  readonly fields?: readonly GateField[];
  /** Has the step actually been taken? Defaults to "every mandatory field is filled". */
  readonly done?: boolean;
  /** A read-only listing: it never blocks the section behind it and never opens itself. */
  readonly informational?: boolean;
  readonly blockers?: readonly string[];
  readonly warnings?: readonly string[];
  readonly badges?: React.ReactNode;
  readonly children?: React.ReactNode;
  readonly footer?: React.ReactNode;
}

export function gateSections(gates: readonly SectionGate[], options: { sequential?: boolean } = {}): SectionModel[] {
  const sequential = options.sequential ?? true;
  let blockedBy: string | null = null;

  const built = gates.map((gate, index) => {
    const fieldsList = gate.fields ?? [];
    const missing = fieldsList.filter((f) => !f.filled).map((f) => f.label);
    const percent = fieldsList.length === 0
      ? (gate.done === false ? 0 : 100)
      : Math.round(((fieldsList.length - missing.length) / fieldsList.length) * 100);
    const blockers = gate.blockers ?? [];
    const complete = gate.informational ? true : (gate.done ?? missing.length === 0) && blockers.length === 0;
    const locked = sequential && !gate.informational && blockedBy !== null;
    const status: SectionStatus = locked
      ? 'locked'
      : complete ? 'complete'
      : missing.length === 0 && blockers.length > 0 ? 'blocked'
      : percent > 0 ? 'in-progress'
      : 'ready';
    const model: SectionModel = {
      id: gate.id,
      order: index + 1,
      title: `${index + 1}. ${gate.title}`,
      subtitle: gate.informational
        ? 'reference — opens on request'
        : complete ? 'complete' : locked ? `closed — waiting on ${blockedBy ?? 'the previous section'}` : gate.subtitle,
      status,
      percent: complete ? 100 : locked ? 0 : percent,
      missing,
      blockers,
      warnings: gate.warnings ?? [],
      lockedByTitle: locked ? blockedBy : null,
      autoOpen: false,
      badges: gate.badges,
      children: gate.children,
      footer: gate.footer,
    };
    if (!complete && !gate.informational && blockedBy === null) blockedBy = gate.title;
    return { model, complete };
  });

  // A panel always opens something: the first section that is not finished, or — when an operator
  // arrives to find every field already filled — the first section that has work in it.
  const recommended = built.find((b) => !b.complete && b.model.status !== 'locked')
    ?? built.find((b) => !b.model.id.startsWith('reference'));
  return built.map((b) => (recommended && b.model.id === recommended.model.id ? { ...b.model, autoOpen: true } : b.model));
}

/** A panel rendered as a rail of gated sections. */
export const SectionGroup: React.FC<{
  readonly gates: readonly SectionGate[];
  readonly sequential?: boolean;
  readonly title?: string;
  readonly headline?: React.ReactNode;
  readonly aside?: React.ReactNode;
}> = ({ gates, sequential = true, title = 'Sections', headline, aside }) => {
  const sections = useMemo(() => gateSections(gates, { sequential }), [gates, sequential]);
  const complete = sections.filter((s) => s.status === 'complete').length;
  const recommended = sections.find((s) => s.autoOpen);
  return (
    <SectionStack
      sections={sections}
      title={title}
      headline={headline ?? (sequential
        ? `${complete} of ${sections.length} sections complete${recommended ? ` — “${recommended.title}” is open; the rest stay closed until it is 100% complete.` : '.'}`
        : `${complete} of ${sections.length} sections complete — each one opens on its own; nothing here is blocked by anything else.`)}
      overallPercent={Math.round((complete / Math.max(1, sections.length)) * 100)}
      completeCount={complete}
      totalCount={sections.length}
      aside={aside}
    />
  );
};

/** A mandatory-field checklist for a gate: `[label, isItFilled]` pairs, or a filled string. */
export const filled = (value: unknown, minLength = 1): boolean => {
  if (value === undefined || value === null) return false;
  if (typeof value === 'boolean') return true;                 // answered either way
  if (typeof value === 'number') return Number.isFinite(value);
  if (Array.isArray(value)) return value.length > 0;
  return String(value).trim().length >= minLength;
};

export const fields = (...pairs: Array<[string, unknown, number?]>): GateField[] =>
  pairs.map(([label, value, minLength]) => ({ label, filled: filled(value, minLength ?? 1) }));
