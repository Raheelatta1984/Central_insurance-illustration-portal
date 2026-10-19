/**
 * The AI guide: a sticky note against every section and subsection of the console.
 *
 * The note is the thing the operator is actually looking at: a piece of paper in the corner of the
 * section, with the step number, one "Do this" line and one "Watch" line, an arrow down at the form,
 * and a close button for when it has done its job. The words come from the domain guide registry and
 * are enriched with the live figures from the engine, so the note says "40% complete, still
 * outstanding: Amount of cover" rather than "complete the section".
 *
 * Dismissing a note is local tidying: it is remembered for the browser, and the master switch in the
 * console header still hides and shows every note at once. Flipping the master switch back on shows
 * everything again, because "show me the guidance" was asked for explicitly.
 */
import React, { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
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
  /** Note ids the operator closed with the × on this browser. */
  readonly dismissed: ReadonlySet<string>;
  readonly dismiss: (id: string) => void;
  readonly restore: (id: string) => void;
}

const GuideContext = createContext<GuideContextValue | null>(null);

export { GuideContext };

/** The notes for the tree below, or `null` when nothing is providing them. */
export function useGuide(): GuideContextValue | null {
  return useContext(GuideContext);
}

/* ------------------------------------------------------------------ remembering dismissed notes */

const DISMISS_KEY = 'ci-guide-dismissed';

function readDismissed(): string[] {
  try {
    if (typeof window === 'undefined' || !window.localStorage) return [];
    const raw = window.localStorage.getItem(DISMISS_KEY);
    const value: unknown = raw ? JSON.parse(raw) : [];
    return Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : [];
  } catch {
    return [];
  }
}

function writeDismissed(ids: string[]): void {
  try {
    if (typeof window !== 'undefined' && window.localStorage) window.localStorage.setItem(DISMISS_KEY, JSON.stringify(ids));
  } catch {
    // A window that refuses storage (private mode, embed) just does not remember the dismissal.
  }
}

/** A small, deterministic tilt per note, so the stack of papers looks stuck on, not stamped. */
function tiltFor(id: string): number {
  let h = 0;
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) >>> 0;
  return ((h % 9) - 4) * 0.45;
}

/* ------------------------------------------------------------------ the provider */

export const GuideProvider: React.FC<{
  readonly data?: WorldSnapshot | null;
  readonly tab: string;
  readonly enabled: boolean;
  readonly children?: React.ReactNode;
}> = ({ data, tab, enabled, children }) => {
  const guide = data?.guide ?? null;
  const [dismissed, setDismissed] = useState<ReadonlySet<string>>(() => new Set(readDismissed()));
  const prevEnabled = useRef(enabled);

  // Dismissing a note is local tidying; flipping the master switch off and back on is "show me
  // again", so a false→true transition brings every note back. (Not on first mount: a reload must
  // keep what the operator already tidied.)
  useEffect(() => {
    if (enabled && !prevEnabled.current) {
      writeDismissed([]);
      setDismissed(new Set());
    }
    prevEnabled.current = enabled;
  }, [enabled]);

  const dismiss = useCallback((id: string) => {
    setDismissed((current) => {
      if (current.has(id)) return current;
      const next = new Set(current);
      next.add(id);
      writeDismissed([...next]);
      return next;
    });
  }, []);

  const restore = useCallback((id: string) => {
    setDismissed((current) => {
      if (!current.has(id)) return current;
      const next = new Set(current);
      next.delete(id);
      writeDismissed([...next]);
      return next;
    });
  }, []);

  const value = useMemo<GuideContextValue>(() => ({
    enabled,
    tab,
    guide,
    limitation: guide?.limitation || GUIDE_LIMITATION,
    dismissed,
    dismiss,
    restore,
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
  }), [guide, tab, enabled, dismissed, dismiss, restore]);

  return <GuideContext.Provider value={value}>{children}</GuideContext.Provider>;
};

/* ------------------------------------------------------------------ the paper */

/** The hand-drawn arrow: the note points down at the section it is stuck against. */
const stickyArrow = (
  <svg className="stickyArrow" viewBox="0 0 64 44" aria-hidden="true">
    <path d="M42 3 C 33 10, 27 16, 17 29" fill="none" stroke="#a8871f" strokeWidth="3.4" strokeLinecap="round" />
    <path d="M8 24 L17 31 L26 26" fill="none" stroke="#a8871f" strokeWidth="3.4" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
);

export interface GuideStickyProps {
  readonly note: GuideNoteData;
  readonly limitation: string;
  /** A tighter paper for cards and subsections: the why-paragraph and the limitation step down. */
  readonly compact?: boolean;
  /** The wide note at the top of a screen. */
  readonly screen?: boolean;
  /** The step number for the title, "Step 3 · …". */
  readonly step?: number;
  readonly onDismiss: (id: string) => void;
}

/**
 * The sticky note itself. It is plain markup — no disclosure, no button that carries the note — so a
 * stack of notes can never be mistaken for open sections: the rail's "exactly one section open"
 * count is about `aria-expanded` on the section toggles, and the note writes none.
 */
const GuideSticky: React.FC<GuideStickyProps> = ({ note, limitation, compact, screen, step, onDismiss }) => (
  <div
    className={`guideNote ${note.tone}${compact ? ' compact' : ''}${screen ? ' screen' : ''}`}
    data-guide={note.id}
    data-curated={note.curated ? 'yes' : 'composed'}
    data-tone={note.tone}
    aria-label={`AI guide for ${note.title}`}
    style={{ ['--tilt' as never]: `${tiltFor(note.id)}deg` }}
  >
    <span className="stickyTape" aria-hidden="true" />
    <button
      type="button"
      className="stickyClose"
      aria-label="Dismiss this guide note"
      title="Tuck this note away — the switch at the top brings every note back"
      onClick={() => onDismiss(note.id)}
    >×</button>
    <span className="stickyBadge">GUIDE</span>
    <b className="stickyTitle">{step && step > 0 ? `Step ${step} · ${note.title}` : note.title}</b>
    {note.headline && <span className="stickyHeadline">{note.headline}</span>}
    {/* The full note and the compact one carry the same words: the paper trims the why-paragraph
        and the limitation by CSS, so the curated text is never dropped from the screen. */}
    {note.body && <p className="stickyWhy">{note.body}</p>}
    <div className="stickyDo"><b>Do this:</b> <span>{note.doThis[0]}</span></div>
    {note.doThis.length > 1 && (
      <ol className="stickySteps">{note.doThis.slice(1).map((s, i) => <li key={`${i}-${s.slice(0, 24)}`}>{s}</li>)}</ol>
    )}
    {note.watch && <p className="stickyWatch"><b>Watch:</b> {note.watch}</p>}
    {note.facts.length > 0 && (
      <details className="guideMore">
        <summary>Live context ({note.facts.length})</summary>
        <ul>{note.facts.map((fact, i) => <li key={`${i}-${fact.slice(0, 24)}`}>{fact}</li>)}</ul>
      </details>
    )}
    <small className="guideLimit">{limitation}</small>
    {stickyArrow}
  </div>
);

/** A dismissed note leaves a pin, so it can be brought back without hunting the switch. */
const ReshowPin: React.FC<{ id: string; title: string; onRestore: (id: string) => void }> = ({ id, title, onRestore }) => (
  <button
    type="button"
    className="ghost stickyReshow"
    aria-label={`Show the AI guide for ${title} again`}
    onClick={() => onRestore(id)}
  >📌 note</button>
);

/* ------------------------------------------------------------------ the public components */

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
  /** A tighter paper for a small card or subsection. */
  readonly compact?: boolean;
  /** The step number, for the "Step N · …" title. */
  readonly step?: number;
}

/** The note against one section: stuck below its heading, arrow pointing down at the form. */
export const GuideBanner: React.FC<GuideBannerProps> = (props) => {
  const ctx = useGuide();
  const note = useMemo(() => (ctx ? ctx.noteFor(props) : null), [ctx, props.tab, props.section, props.title, props.status, props.percent, props.missing, props.blockers]);
  if (!ctx || !ctx.enabled || !note) return null;
  if (ctx.dismissed.has(note.id)) return <ReshowPin id={note.id} title={note.title} onRestore={ctx.restore} />;
  return <GuideSticky note={note} limitation={ctx.limitation} compact={props.compact} step={props.step} onDismiss={ctx.dismiss} />;
};

/** One overview note for the screen, above its sections. */
export const ScreenGuide: React.FC<{ readonly tab?: string }> = ({ tab }) => {
  const ctx = useGuide();
  if (!ctx || !ctx.enabled || !ctx.guide) return null;
  const entry = ctx.guide.tabs.find((t) => t.id === (tab ?? ctx.tab));
  if (!entry) return null;
  const note: GuideNoteData = { ...entry.note, id: `screen:${entry.id}` };
  return (
    <div className="screenGuide">
      {ctx.dismissed.has(note.id)
        ? <ReshowPin id={note.id} title={note.title} onRestore={ctx.restore} />
        : <GuideSticky note={note} limitation={ctx.limitation} screen onDismiss={ctx.dismiss} />}
    </div>
  );
};

/** Use below a subsection heading, so even the smaller groups have guidance in place. */
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
