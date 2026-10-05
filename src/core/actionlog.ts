/**
 * The register's own log: the actions it took, and the journal each one posted.
 *
 * A reporting register is not only the rows it holds at the end — it is the actions that put them
 * there. A cession, a catastrophe recovery, a reinstatement, a deposit settled, a claim reserve
 * moved: each of those is a decision somebody took and a posting the books carry, and a store that
 * keeps only the end state cannot tell how the register got there.
 *
 * So every money-moving action is recorded as it happens, with the inputs it was given and the
 * journal it posted. The journal is what anchors the action in time: the books are the timeline, and
 * an action belongs at the point its journal was written. A restore replays the actions in that
 * order — which is why the replay has to be deterministic, and why it is checked rather than
 * trusted: a replayed action must post a journal identical to the one the snapshot holds, or the
 * restore says which action drifted and refuses to call itself good.
 *
 * One honest limit, stated rather than hidden: an action that posts no journal — a free
 * reinstatement, a cash call — has no journal to anchor it, so it carries the number of journals the
 * books held when it happened instead. That places it in the right window between two journals, and
 * if two such actions and a return all happen inside one window, the window is all the books can
 * say. Actions that move money all post journals, so the returns themselves are anchored exactly.
 */

/**
 * The registers' clock. Every recorded action takes the next ticket, so the order the registers
 * lived their actions in survives a restart — including the actions that post no journal and
 * therefore share a book position with whatever else happened at the same moment.
 */
export class ActionClock {
  private taken = 0;
  next(): number { return ++this.taken; }
  get count(): number { return this.taken; }
}

export interface RegisterAction {
  /** The place this action took on the registers' own clock. */
  readonly seq: number;
  /** Which register took the action: `reinsurance`, `retakaful`, `claims`, `takaful-claims`. */
  readonly engine: string;
  /** What it did, in the register's own vocabulary: `cede-premium`, `event-recovery`, … */
  readonly kind: string;
  readonly at: string;
  /** The journal it posted, or `''` when it posted none. */
  readonly journalId: string;
  /** How many journals the books held when the action completed — where it belongs in the timeline. */
  readonly mark: number;
  /** Exactly what the action was given. Kept so the action can be taken again from its own inputs. */
  readonly input: Readonly<Record<string, unknown>>;
}

/**
 * A register that can say what it did and do it again. The reporting store talks to registers
 * through this and nothing else, so a new register joins the snapshot by implementing it.
 */
export interface ReplayContext {
  /** Find another register by name — an action that was taken against a claim needs the claims register back. */
  readonly register: (name: string) => ReplayableRegister | undefined;
}

export interface ReplayableRegister {
  readonly engineName: string;
  actionLog(): readonly RegisterAction[];
  /** Take the action again, from its own recorded inputs. Must be deterministic. */
  replay(action: RegisterAction, context?: ReplayContext): void;
}

/** Copy what an action was given, all the way down, so nothing can be edited behind the log. */
export function captureInput<T>(input: T): T {
  const walk = (value: unknown): unknown => {
    if (value === null || typeof value !== 'object') return value;
    if (value instanceof Map) return new Map([...value.entries()].map(([k, v]) => [k, walk(v)]));
    if (value instanceof Set) return new Set([...value.values()].map(walk));
    if (value instanceof Date) return new Date(value.getTime());
    if (Array.isArray(value)) return Object.freeze(value.map(walk));
    return Object.freeze(Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([k, v]) => [k, walk(v)])));
  };
  return walk(input) as T;
}
