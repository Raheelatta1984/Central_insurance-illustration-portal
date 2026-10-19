/**
 * Contextual guide notes share a small trigger beside screen, section and subsection headings.
 * Notes are written in the domain guide registry and enriched with live engine facts; the control
 * stays optional in embeds, and the tenant's audited preference hides every trigger at once.
 */
import React, { createContext, useCallback, useContext, useMemo } from 'react';
import type { WorldSnapshot } from '../core/demo';
import { GUIDE_LIMITATION, sectionGuide } from '../core/guide';
import type { GuideNote as GuideNoteData } from '../core/guide';

export type GuideSnapshotView = WorldSnapshot['guide'];

export interface GuideContextValue {
  readonly enabled: boolean;
  readonly tab: string;
  /** The curated notes and live facts, or `null` for a provider that has no snapshot yet. */
  readonly guide: GuideSnapshotView | null;
  /** Compose the note for one section (or, with no section, for the screen itself). */
  readonly noteFor: (input: { tab?: string; section?: string | null; title?: string; status?: string; percent?: number; missing?: readonly string[]; blockers?: readonly string[] }) => GuideNoteData;
  readonly limitation: string;
}

const GuideContext = createContext<GuideContextValue | null>(null);

export { GuideContext };

/** The notes for the tree below, or `null` when nothing is providing them. */
export function useGuide(): GuideContextValue | null {
  return useContext(GuideContext);
}

export const GuideProvider: React.FC<{
  readonly data?: WorldSnapshot | null;
  readonly tab: string;
  readonly enabled: boolean;
  readonly children?: React.ReactNode;
}> = ({ data, tab, enabled, children }) => {
  const guide = data?.guide ?? null;
  const value = useMemo<GuideContextValue>(() => ({
    enabled,
    tab,
    guide,
    limitation: guide?.limitation || GUIDE_LIMITATION,
    noteFor: (input) => sectionGuide({
      tab: input.tab ?? tab,
      ...(input.section === undefined ? {} : { section: input.section ?? undefined }),
      title: input.title ?? (input.section ?? tab),
      ...(input.status === undefined ? {} : { status: input.status }),
      ...(typeof input.percent === 'number' ? { percent: input.percent } : {}),
      ...(input.missing ? { missing: input.missing } : {}),
      ...(input.blockers ? { blockers: input.blockers } : {}),
      facts: guide?.facts[input.tab ?? tab] ?? [],
    }),
  }), [guide, tab, enabled]);
  return <GuideContext.Provider value={value}>{children}</GuideContext.Provider>;
};

export interface GuideBannerProps {
  /** Defaults to the tab the provider was given. */
  readonly tab?: string;
  /** The gate or stage id. Without it the note is composed from the title. */
  readonly section?: string | null;
  readonly title?: string;
  readonly status?: string;
  readonly percent?: number;
  readonly missing?: readonly string[];
  readonly blockers?: readonly string[];
  /** A one-line note for a small card: same content, tighter chrome. */
  readonly compact?: boolean;
}

/** A small comic-style note beside a heading. Opening it never changes the section's open state. */
const GuidePopover: React.FC<{
  note: GuideNoteData;
  limitation: string;
  compact?: boolean;
  screen?: boolean;
}> = ({ note, limitation, compact, screen }) => (
  <details className={`guideNote ${note.tone}${compact ? ' compact' : ''}${screen ? ' screen' : ''}`}
    data-guide={note.id} data-curated={note.curated ? 'yes' : 'composed'}>
    <summary aria-label={`AI guide for ${note.title}`}>
      <span className="guideMark" aria-hidden="true">✳</span>
      <span>{screen ? note.headline : 'AI guide'}</span>
      <span className="guideCue" aria-hidden="true">▾</span>
    </summary>
    <div className="guideBody" role="note">
      <strong>{note.headline}</strong>
      <p>{note.body}</p>
      {note.doThis.length > 0 && (
        <div className="guideDo"><b>Next step</b><p>{note.doThis[0]}</p></div>
      )}
      {note.watch && <p className="guideWatch"><b>Watch:</b> {note.watch}</p>}
      {note.facts.length > 0 && (
        <details className="guideMore">
          <summary>Live context ({note.facts.length})</summary>
          <ul>{note.facts.map((fact, i) => <li key={`${i}-${fact.slice(0, 24)}`}>{fact}</li>)}</ul>
        </details>
      )}
      <small className="guideLimit">{limitation}</small>
    </div>
  </details>
);

export const GuideBanner: React.FC<GuideBannerProps> = (props) => {
  const ctx = useGuide();
  const note = useMemo(() => (ctx ? ctx.noteFor(props) : null), [ctx, props.tab, props.section, props.title, props.status, props.percent, props.missing, props.blockers]);
  if (!ctx || !ctx.enabled || !note) return null;
  return <GuidePopover note={note} limitation={ctx.limitation} compact={props.compact} />;
};

/** One overview note for the screen, not a second full-width banner. */
export const ScreenGuide: React.FC<{ readonly tab?: string }> = ({ tab }) => {
  const ctx = useGuide();
  if (!ctx || !ctx.enabled || !ctx.guide) return null;
  const entry = ctx.guide.tabs.find((t) => t.id === (tab ?? ctx.tab));
  if (!entry) return null;
  return <div className="screenGuide"><span className="small muted">On this screen</span><GuidePopover
    note={{ ...entry.note, id: `screen:${entry.id}` }} limitation={ctx.limitation} screen
  /></div>;
};

/** Use beside a subsection heading, so even the smaller groups have guidance in place. */
export const GuideHeading: React.FC<{ readonly title: string }> = ({ title }) => (
  <div className="guideHeading"><h4 className="small">{title}</h4><GuideBanner compact title={title} /></div>
);

/**
 * The switch. It lives in the console header so it is above every tab, and it is a plain button with
 * `aria-pressed` rather than a checkbox in a settings page nobody opens.
 */
export const GuideToggle: React.FC<{
  readonly enabled: boolean;
  readonly busy?: boolean;
  readonly onToggle: (next: boolean) => void;
}> = ({ enabled, busy, onToggle }) => {
  const onClick = useCallback(() => onToggle(!enabled), [enabled, onToggle]);
  return (
    <button
      type="button"
      className={`ghost guideToggle${enabled ? ' on' : ''}`}
      aria-pressed={enabled}
      disabled={busy}
      onClick={onClick}
      title={enabled ? 'Hide the guide notes on every section' : 'Show the guide notes on every section'}
    >
      <span aria-hidden="true">✳</span> AI guide: {enabled ? 'on' : 'off'}
    </button>
  );
};
