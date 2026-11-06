/**
 * Read-only planning contract for charge configuration. This module neither files rules nor
 * issues tickets, calculates amounts, or authorizes postings. Explicit null means not applicable;
 * undefined means the policy's distribution information is unknown.
 */
export type ChargeRuleKind = 'allocation' | 'administration' | 'mortality';
export interface ChargeScope {
  readonly category: string;
  readonly productId: string;
  readonly channelCode: string;
  readonly subChannelCode: string | null;
  readonly partnerId: string | null;
}
export interface FiledChargeRule {
  readonly id: string;
  readonly kind: ChargeRuleKind;
  readonly enabled: boolean;
  readonly scope: ChargeScope | 'global';
}
export type ChargeResolution =
  | { readonly status: 'resolved'; readonly source: 'scoped' | 'global'; readonly rule: FiledChargeRule }
  | { readonly status: 'blocked'; readonly reason: 'missing-distribution' | 'missing-global'; readonly request: ConfigurationRequestDraft | null };
export interface ConfigurationRequestDraft {
  readonly priority: 'P1';
  readonly kind: ChargeRuleKind;
  readonly proposedScope: 'global';
  readonly proposedValues: null;
  readonly note: string;
}

/**
 * Exact-scope rules precede an explicitly filed global rule. A missing channel or unknown
 * sub-channel/partner is not the same as a known absence, so do not select a rule in that case.
 * Duplicate matching rules are rejected instead of choosing based on insertion order.
 */
export function resolveChargeRule(input: {
  readonly kind: ChargeRuleKind;
  readonly scope: Partial<ChargeScope>;
  readonly rules: readonly FiledChargeRule[];
}): ChargeResolution {
  const applicable = input.rules.filter((rule) => rule.enabled && rule.kind === input.kind);
  const global = applicable.filter((rule) => rule.scope === 'global');
  if (global.length > 1) throw new Error(`Multiple enabled global ${input.kind} rules`);
  const draft: ConfigurationRequestDraft | null = global.length ? null : {
    priority: 'P1', kind: input.kind, proposedScope: 'global', proposedValues: null,
    note: 'File and review a global rule; rate and calculation basis require authorized configuration.',
  };
  const scope = input.scope;
  if (!scope.category?.trim() || !scope.productId?.trim() || !scope.channelCode?.trim() || scope.subChannelCode === undefined || scope.partnerId === undefined || scope.subChannelCode === '' || scope.partnerId === '') {
    return { status: 'blocked', reason: 'missing-distribution', request: draft };
  }
  const scoped = applicable.filter((rule) => rule.scope !== 'global'
    && rule.scope.category === scope.category
    && rule.scope.productId === scope.productId
    && rule.scope.channelCode === scope.channelCode
    && rule.scope.subChannelCode === scope.subChannelCode
    && rule.scope.partnerId === scope.partnerId);
  if (scoped.length > 1) throw new Error(`Multiple enabled scoped ${input.kind} rules`);
  if (scoped[0]) return { status: 'resolved', source: 'scoped', rule: scoped[0] };
  if (global[0]) return { status: 'resolved', source: 'global', rule: global[0] };
  return { status: 'blocked', reason: 'missing-global', request: draft };
}
