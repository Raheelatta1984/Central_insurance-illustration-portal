/**
 * Filing a return with the supervisor, and keeping the proof that it went.
 *
 * An extract that ties to the books is not yet a filing. This module closes the last gap in the
 * regulatory chain: it builds a **submission pack** (the issued return, the cover letter generated
 * from the wording book, the controls as filed and the rule book's decisions behind them), sends it
 * through a channel, and keeps a log with the answers that come back.
 *
 * What it refuses is the part that matters:
 *
 *  - a return that was never issued, or one with differences its approver did not accept, cannot be filed;
 *  - the same version cannot be filed twice — a corrected return supersedes the filing instead, which is
 *    recorded as such rather than as a second filing of the same thing;
 *  - **a filing outside the window is refused**, and can only be filed late with a named approver and a
 *    reason, which then stands on the record for as long as it exists;
 *  - an acknowledgement must name who acknowledged it and under what reference, and a rejection must say why.
 *
 * The window is data: each return code carries its period end, its deadline in days, its grace and its
 * channel. Filing before the window opens is refused too — a return filed early is as wrong as one filed late.
 */
import { IssuedExtract, IssuedExtractSummary } from './extracts.js';

export class SubmissionError extends Error {}

export interface FilingWindow {
  readonly returnCode: string;          // 'CBUAE-MONTHLY', 'CBUAE-ANNUAL'
  readonly name: string;
  readonly frequency: 'monthly' | 'annual';
  readonly deadlineDays: number;        // days after the period end
  readonly graceDays: number;           // days after the deadline before a filing is late
  readonly channel: string;
}

export interface SubmissionPack {
  readonly extractId: string;
  readonly extractVersion: number;
  readonly returnCode: string;
  readonly period: { readonly from: string; readonly to: string };
  readonly asOf: string;
  readonly coverLetterId: string;       // the generated cover letter that goes with the return
  readonly controls: readonly { code: string; state: string }[];
  readonly tiesToBooks: boolean;
  readonly differencesAccepted: { readonly by: string; readonly reason: string } | null;
  readonly supersedesExtract: string | null;   // the earlier return this one corrects, if any
  readonly ruleDecisions: readonly string[];   // the rule book's decision ids behind the figures
  readonly manifest: string;            // one line saying what is in the pack, fingerprintable
}

export interface SubmissionPackInput {
  readonly extract: IssuedExtract;
  readonly returnCode: string;
  readonly coverLetterId: string;
  readonly ruleDecisions?: readonly string[];
}

export type SubmissionStatus = 'filed' | 'acknowledged' | 'rejected' | 'superseded' | 'late-filed';

export interface Submission {
  readonly id: string;
  readonly reference: string;           // our filing reference
  readonly extractId: string;
  readonly extractVersion: number;
  readonly returnCode: string;
  readonly period: { readonly from: string; readonly to: string };
  readonly asOf: string;
  readonly filedAt: string;
  readonly filedBy: string;
  readonly channel: string;
  readonly status: SubmissionStatus;
  readonly onTime: boolean;
  readonly lateApprovedBy: string | null;
  readonly lateReason: string | null;
  readonly acknowledgedAt: string | null;
  readonly acknowledgedBy: string | null;
  readonly supervisorReference: string | null;
  readonly rejectionReason: string | null;
  readonly rejectedAt: string | null;
  readonly rejectedBy: string | null;
  /** How far the books had got when this return went out — see `IssuedExtract.booksThrough`. */
  readonly booksThrough: number;
  /** How many register actions had been taken when this return went out. */
  readonly actionsThrough: number;
  readonly resubmissionOf: string | null;
  readonly pack: SubmissionPack;
}

export interface FilingDecision {
  readonly allowed: boolean;
  readonly outcome: 'in-window' | 'late' | 'early' | 'closed';
  readonly detail: string;
  readonly deadline: string;
  readonly graceEnds: string;
}

const day = (iso: string): string => iso.slice(0, 10);
const daysBetween = (from: string, to: string): number => {
  const a = Date.parse(`${day(from)}T00:00:00Z`);
  const b = Date.parse(`${day(to)}T00:00:00Z`);
  return Math.round((b - a) / 86_400_000);
};
const addDays = (iso: string, days: number): string => {
  const d = new Date(`${day(iso)}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
};

export class SubmissionRegister {
  private readonly log: Submission[] = [];
  private seq = 0;

  constructor(private readonly options: {
    readonly windows: readonly FilingWindow[];
    /**
     * Recompute an extract from the live books. A return that was issued and has since stopped
     * reproducing cannot be filed: the corrected return is filed instead, which is what the
     * supersession route exists for.
     */
    readonly verify?: (extractId: string) => { readonly intact: boolean; readonly detail: string };
    /**
     * How far the books have got, read at the moment a return is filed. The register recomputes the
     * return from the books before it accepts the pack, so the filing has to remember the books it
     * was accepted against for the same reason an extract does.
     */
    readonly booksThrough?: () => number;
    /** How many register actions have been taken, read at the moment a return is filed. */
    readonly actionsThrough?: () => number;
    /** Days after filing at which an unacknowledged submission becomes a finding. */
    readonly acknowledgementDays?: number;
    /** Filing an earlier period after a later one needs the same treatment as a late filing. */
    readonly reasonMinimum?: number;
  }) {}

  window(returnCode: string): FilingWindow {
    const found = this.options.windows.find((w) => w.returnCode === returnCode);
    if (!found) throw new SubmissionError(`no filing window is defined for ${returnCode}`);
    return found;
  }

  /** Whether the window is open, and what would happen if you filed now. */
  assess(returnCode: string, period: { from: string; to: string }, at: string): FilingDecision {
    const w = this.window(returnCode);
    const deadline = addDays(period.to, w.deadlineDays);
    const graceEnds = addDays(deadline, w.graceDays);
    const today = day(at);
    if (today < period.to) {
      return {
        allowed: false, outcome: 'early', deadline, graceEnds,
        detail: `the period covered by this ${w.name} runs to ${period.to} and is not over on ${today} — a return cannot be filed for a period that is still running`,
      };
    }
    if (today <= graceEnds) {
      // The deadline is the last day to file, not the first: filing as soon as the period closes is
      // the normal case, and it is on time.
      return { allowed: true, outcome: 'in-window', deadline, graceEnds, detail: `inside the window: due by ${deadline}, filed ${today}` };
    }
    return {
      allowed: false, outcome: 'closed', deadline, graceEnds,
      detail: `the window for the ${w.name} closed on ${graceEnds}, ${daysBetween(graceEnds, today)} day(s) ago; filing now needs a named approver and a reason`,
    };
  }

  /** Build the pack. Everything a reviewer needs to see what went, without opening the return. */
  pack(input: SubmissionPackInput): SubmissionPack {
    const { extract, returnCode } = input;
    this.window(returnCode);   // an unknown return code is refused here, not at filing time
    if (extract.kind !== 'regulatory-return') {
      throw new SubmissionError(`${extract.id} is a ${extract.kind}; only a regulatory return is filed with the supervisor`);
    }
    const controls = extract.controls.map((c) => ({ code: c.code, state: c.state }));
    const disagreeing = controls.filter((c) => c.state !== 'agrees' && c.state !== 'informational');
    if (!extract.tiesToBooks && !extract.differencesAccepted) {
      throw new SubmissionError(`${extract.id} does not tie to the books and no one has accepted the difference; an untied return cannot be filed`);
    }
    if (this.options.verify) {
      const check = this.options.verify(extract.id);
      if (!check.intact) {
        throw new SubmissionError(`${extract.id} no longer reproduces from the books — ${check.detail}; issue the corrected return and file that one`);
      }
    }
    return Object.freeze({
      extractId: extract.id,
      extractVersion: extract.version,
      returnCode,
      period: { from: extract.period.from, to: extract.period.to },
      asOf: extract.asOf,
      coverLetterId: input.coverLetterId,
      controls: Object.freeze(controls.map((c) => Object.freeze(c))),
      tiesToBooks: extract.tiesToBooks,
      differencesAccepted: extract.differencesAccepted ? { ...extract.differencesAccepted } : null,
      supersedesExtract: extract.supersedes,
      ruleDecisions: Object.freeze([...(input.ruleDecisions ?? [])]),
      manifest: [
        `return ${extract.id} v${extract.version} for ${extract.period.from} to ${extract.period.to}, prepared ${extract.asOf}`,
        `cover letter ${input.coverLetterId}`,
        `${checksWord(extract.controls.length)} controls`,
        `${disagreeing.length} difference(s) open`,
        extract.differencesAccepted ? `differences accepted by ${extract.differencesAccepted.by}` : 'every control agrees',
        input.ruleDecisions?.length ? `${input.ruleDecisions.length} rule decision(s) behind the figures` : 'no rule decisions attached',
      ].join('; '),
    });
  }

  /** File it. The window, the duplicate check and the late route all live here. */
  file(input: {
    pack: SubmissionPack;
    at: string;
    by: string;
    lateApprovedBy?: string;
    lateReason?: string;
    resubmissionOf?: string;
    late?: boolean;
  }): Submission {
    const { pack } = input;
    const w = this.window(pack.returnCode);
    const decision = this.assess(pack.returnCode, pack.period, input.at);
    const samePeriod = this.log.filter((s) => s.returnCode === pack.returnCode
      && s.period.from === pack.period.from && s.period.to === pack.period.to);
    const sameVersion = samePeriod.find((s) => s.extractId === pack.extractId && s.status !== 'rejected' && s.status !== 'superseded');
    if (sameVersion && !input.resubmissionOf) {
      throw new SubmissionError(`${pack.extractId} has already been filed as ${sameVersion.reference} on ${sameVersion.filedAt}; a corrected return supersedes the filing rather than filing the same version twice`);
    }
    // A second return for a period that already has one does not sit beside it: either this return
    // corrects the earlier one — it supersedes it, and so does its filing — or it is refused.
    const priorFiled = samePeriod.filter((s) => s.status === 'filed' || s.status === 'late-filed' || s.status === 'acknowledged').at(-1) ?? null;
    if (priorFiled && !input.resubmissionOf) {
      if (!pack.supersedesExtract) {
        throw new SubmissionError(`a return for ${pack.period.from} to ${pack.period.to} was already filed as ${priorFiled.reference}; this return does not supersede an earlier one, so it cannot be filed beside it`);
      }
      input = { ...input, resubmissionOf: priorFiled.id };
    }
    if (!decision.allowed && decision.outcome === 'early') throw new SubmissionError(decision.detail);
    if (!decision.allowed && decision.outcome === 'closed') {
      if (!input.lateApprovedBy || !input.lateReason) {
        throw new SubmissionError(`${decision.detail} — no late filing without a named approver and a reason`);
      }
      if (input.lateReason.trim().length < (this.options.reasonMinimum ?? 24)) {
        throw new SubmissionError(`a late filing needs a reason of at least ${this.options.reasonMinimum ?? 24} characters`);
      }
    }
    const late = !decision.allowed && decision.outcome === 'closed';
    const submission: Submission = Object.freeze({
      id: `SUB-${String(++this.seq).padStart(6, '0')}`,
      reference: `${pack.returnCode}/${pack.period.to}/${String(this.seq).padStart(3, '0')}`,
      extractId: pack.extractId,
      extractVersion: pack.extractVersion,
      returnCode: pack.returnCode,
      period: { ...pack.period },
      asOf: pack.asOf,
      filedAt: input.at,
      filedBy: input.by,
      channel: w.channel,
      status: late ? 'late-filed' : 'filed',
      onTime: !late,
      lateApprovedBy: late ? input.lateApprovedBy! : null,
      lateReason: late ? input.lateReason! : null,
      acknowledgedAt: null, acknowledgedBy: null, supervisorReference: null,
      rejectionReason: null, rejectedAt: null, rejectedBy: null,
      booksThrough: this.options.booksThrough?.() ?? 0,
      actionsThrough: this.options.actionsThrough?.() ?? 0,
      resubmissionOf: input.resubmissionOf ?? null,
      pack,
    });
    this.log.push(submission);
    if (input.resubmissionOf) {
      const index = this.log.findIndex((s) => s.id === input.resubmissionOf);
      const prior = index >= 0 ? this.log[index]! : null;
      // A filed submission that a corrected filing replaces is superseded. A rejected one stays
      // rejected: that is what happened to it, and a correction does not rewrite the rejection.
      if (prior && (prior.status === 'filed' || prior.status === 'late-filed' || prior.status === 'acknowledged')) {
        this.log[index] = Object.freeze({ ...prior, status: 'superseded' as SubmissionStatus });
      }
    }
    return submission;
  }

  /** The supervisor answers. An acknowledgement names who and under what reference. */
  acknowledge(id: string, input: { at: string; by: string; supervisorReference: string }): Submission {
    const index = this.log.findIndex((s) => s.id === id);
    if (index < 0) throw new SubmissionError(`no submission ${id}`);
    const current = this.log[index]!;
    if (current.status === 'acknowledged') throw new SubmissionError(`${current.reference} is already acknowledged under ${current.supervisorReference}`);
    if (current.status === 'rejected') throw new SubmissionError(`${current.reference} was rejected; file the corrected return and acknowledge that filing instead`);
    if (!input.supervisorReference.trim()) throw new SubmissionError('an acknowledgement must carry the supervisor’s own reference');
    if (!input.by.trim()) throw new SubmissionError('an acknowledgement must say who recorded it');
    const updated: Submission = Object.freeze({
      ...current, status: 'acknowledged' as SubmissionStatus,
      acknowledgedAt: input.at, acknowledgedBy: input.by, supervisorReference: input.supervisorReference,
    });
    this.log[index] = updated;
    return updated;
  }

  /** A rejection is not a lost filing: it says why, and the corrected return is filed against it. */
  reject(id: string, input: { at: string; by: string; reason: string }): Submission {
    const index = this.log.findIndex((s) => s.id === id);
    if (index < 0) throw new SubmissionError(`no submission ${id}`);
    const current = this.log[index]!;
    if (current.status === 'rejected') throw new SubmissionError(`${current.reference} is already recorded as rejected`);
    if (input.reason.trim().length < (this.options.reasonMinimum ?? 24)) {
      throw new SubmissionError(`a rejection must say why, in at least ${this.options.reasonMinimum ?? 24} characters`);
    }
    const updated: Submission = Object.freeze({
      ...current, status: 'rejected' as SubmissionStatus,
      rejectionReason: input.reason, rejectedAt: input.at, rejectedBy: input.by,
    });
    this.log[index] = updated;
    return updated;
  }

  submissions(): readonly Submission[] { return this.log; }

  submission(id: string): Submission {
    const found = this.log.find((s) => s.id === id);
    if (!found) throw new SubmissionError(`no submission ${id}`);
    return found;
  }

  awaitingAcknowledgement(at: string): readonly { submission: Submission; days: number; overdue: boolean }[] {
    const limit = this.options.acknowledgementDays ?? 30;
    return this.log
      .filter((s) => (s.status === 'filed' || s.status === 'late-filed') && s.extractId)
      .map((s) => {
        const days = daysBetween(s.filedAt, at);
        return { submission: s, days, overdue: days > limit };
      });
  }

  /** Findings a controller reads on a Monday: what is unacknowledged, what was rejected, what was late. */
  findings(at: string): readonly { code: string; severity: 'error' | 'warning' | 'info'; detail: string; submissionId: string }[] {
    const out: { code: string; severity: 'error' | 'warning' | 'info'; detail: string; submissionId: string }[] = [];
    for (const entry of this.awaitingAcknowledgement(at)) {
      out.push({
        code: entry.overdue ? 'SUBM-001' : 'SUBM-002',
        severity: entry.overdue ? 'error' : 'warning',
        detail: `${entry.submission.reference} was filed ${entry.days} day(s) ago and is not acknowledged`,
        submissionId: entry.submission.id,
      });
    }
    for (const s of this.log) {
      if (s.status === 'rejected') out.push({ code: 'SUBM-003', severity: 'error', detail: `${s.reference} was rejected: ${s.rejectionReason}`, submissionId: s.id });
      if (s.status === 'late-filed') out.push({ code: 'SUBM-004', severity: 'warning', detail: `${s.reference} was filed late, approved by ${s.lateApprovedBy}: ${s.lateReason}`, submissionId: s.id });
      if (s.status === 'superseded') out.push({ code: 'SUBM-005', severity: 'info', detail: `${s.reference} was superseded by a corrected filing`, submissionId: s.id });
    }
    return out;
  }

  statement(at: string): {
    readonly filings: number; readonly acknowledged: number; readonly awaiting: number;
    readonly rejected: number; readonly late: number; readonly findings: number;
    readonly window: readonly { returnCode: string; name: string; deadlineDays: number; graceDays: number; channel: string }[];
    readonly limitation: string;
  } {
    const awaiting = this.awaitingAcknowledgement(at).length;
    return {
      filings: this.log.length,
      acknowledged: this.log.filter((s) => s.status === 'acknowledged').length,
      awaiting,
      rejected: this.log.filter((s) => s.status === 'rejected').length,
      late: this.log.filter((s) => s.status === 'late-filed').length,
      findings: this.findings(at).length,
      window: this.options.windows.map((w) => ({ returnCode: w.returnCode, name: w.name, deadlineDays: w.deadlineDays, graceDays: w.graceDays, channel: w.channel })),
      limitation: 'The log records what was filed, through which channel, on whose authority and under what reference. It does not speak for the '
        + 'supervisor: an acknowledgement is recorded from the notice received, and a filing without one stays outstanding for as long as that is true.',
    };
  }
}

const checksWord = (n: number): string => `${n}`;

/** The windows the UAE pack files under, held as data so a change is a reviewed edit. */
export const AE_FILING_WINDOWS: readonly FilingWindow[] = [
  { returnCode: 'CBUAE-MONTHLY', name: 'Monthly regulatory return', frequency: 'monthly', deadlineDays: 15, graceDays: 5, channel: 'CBUAE e-services portal (XML + signed PDF)' },
  { returnCode: 'CBUAE-ANNUAL', name: 'Annual financial return', frequency: 'annual', deadlineDays: 90, graceDays: 15, channel: 'CBUAE e-services portal (audited accounts + actuary’s report)' },
];

export type { IssuedExtractSummary };
