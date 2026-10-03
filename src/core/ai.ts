/**
 * The AI layer: agents propose, humans dispose.
 *
 * Every agent action is recorded with its inputs, output, model, cost and risk class. Anything
 * that moves money, sets a final price, rules on Shariah matters, certifies a valuation or
 * approves a payout above limits is on the prohibited list: the runtime refuses it before an
 * agent can try.
 */
export type RiskClass = 'low' | 'medium' | 'high';
export type ActionStatus = 'proposed' | 'dry-run' | 'awaiting-approval' | 'approved' | 'rejected' | 'executed' | 'refused';

export interface AgentAction {
  readonly id: string;
  readonly agent: string;
  readonly module: string;
  readonly intent: string;
  readonly riskClass: RiskClass;
  readonly at: string;
  readonly inputs: Record<string, unknown>;
  readonly output: Record<string, unknown>;
  readonly dryRun: boolean;
  readonly status: ActionStatus;
  readonly requiresHuman: boolean;
  approvedBy?: string;
  rejectedBy?: string;
  readonly note: string;
  readonly costUsd: number;
}

export const PROHIBITED_ACTIONS: ReadonlyArray<{ pattern: RegExp; reason: string }> = [
  { pattern: /approve[-_ ]?claim|pay[-_ ]?claim/i, reason: 'Payout decisions above limits require a named human approver' },
  { pattern: /set[-_ ]?final[-_ ]?premium|price[-_ ]?final/i, reason: 'Final pricing is a filed-tariff decision, not an agent decision' },
  { pattern: /shariah[-_ ]?ruling|fatwa/i, reason: 'Shariah rulings belong to the Shariah Committee alone' },
  { pattern: /actuarial[-_ ]?certif|sign[-_ ]?valuation/i, reason: 'Actuarial certification requires a qualified actuary' },
  { pattern: /override[-_ ]?ledger|delete[-_ ]?journal/i, reason: 'The ledger is append-only; corrections are reversals' },
  { pattern: /distribute[-_ ]?surplus/i, reason: 'Surplus distribution requires actuary, Shariah and board gates' },
];

export class AgentRuntimeError extends Error {}

export class AgentRuntime {
  private readonly actions: AgentAction[] = [];
  private seq = 0;

  constructor(private readonly tenantId: string) {}

  /** Propose an action. Dry-run actions never change state, by construction. */
  propose(input: {
    agent: string; module: string; intent: string; riskClass: RiskClass; at: string;
    inputs: Record<string, unknown>; output: Record<string, unknown>; dryRun: boolean; costUsd?: number;
  }): AgentAction {
    const prohibited = PROHIBITED_ACTIONS.find((p) => p.pattern.test(input.intent));
    if (prohibited) {
      const refused: AgentAction = {
        id: this.nextId(), ...input, costUsd: input.costUsd ?? 0, status: 'refused', requiresHuman: true,
        note: `Refused: ${prohibited.reason}`,
      };
      this.actions.push(refused);
      return refused;
    }
    const requiresHuman = input.riskClass === 'high' || input.riskClass === 'medium';
    const status: ActionStatus = input.dryRun ? 'dry-run' : requiresHuman ? 'awaiting-approval' : 'proposed';
    const action: AgentAction = {
      id: this.nextId(), ...input, costUsd: input.costUsd ?? 0, status, requiresHuman,
      note: input.dryRun ? 'Preview only — no state changed' : requiresHuman ? 'Waiting for a human decision' : 'Low risk: eligible for automatic execution with review',
    };
    this.actions.push(action);
    return action;
  }

  approve(id: string, by: string): AgentAction { return this.transition(id, 'approved', by, `Approved by ${by}`); }
  reject(id: string, by: string): AgentAction { return this.transition(id, 'rejected', by, `Rejected by ${by}`); }
  execute(id: string): AgentAction {
    const a = this.find(id);
    if (a.requiresHuman && a.status !== 'approved') throw new AgentRuntimeError(`action ${id} needs human approval before execution`);
    return this.transition(id, 'executed', 'system', 'Executed');
  }

  private transition(id: string, status: ActionStatus, by: string, note: string): AgentAction {
    const idx = this.actions.findIndex((a) => a.id === id);
    if (idx < 0) throw new AgentRuntimeError(`unknown action ${id}`);
    const updated: AgentAction = {
      ...this.actions[idx]!, status, note,
      ...(status === 'approved' ? { approvedBy: by } : {}),
      ...(status === 'rejected' ? { rejectedBy: by } : {}),
    };
    this.actions[idx] = updated;
    return updated;
  }

  private find(id: string): AgentAction {
    const a = this.actions.find((x) => x.id === id);
    if (!a) throw new AgentRuntimeError(`unknown action ${id}`);
    return a;
  }

  private nextId(): string { return `AIA-${String(++this.seq).padStart(5, '0')}`; }

  list(filter?: { module?: string; status?: ActionStatus }): AgentAction[] {
    return this.actions
      .filter((a) => (filter?.module ? a.module === filter.module : true))
      .filter((a) => (filter?.status ? a.status === filter.status : true));
  }

  awaitingHuman(): AgentAction[] { return this.actions.filter((a) => a.status === 'awaiting-approval'); }
  totalCost(): number { return Math.round(this.actions.reduce((s, a) => s + a.costUsd, 0) * 100) / 100; }
}
