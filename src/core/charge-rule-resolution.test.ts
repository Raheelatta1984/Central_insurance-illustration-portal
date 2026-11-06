import { describe, expect, it } from 'vitest';
import { resolveChargeRule, type ChargeScope, type FiledChargeRule } from './charge-rule-resolution.js';

const scope: ChargeScope = { category: 'unit-linked', productId: 'P', channelCode: 'BROKER', subChannelCode: 'DESK', partnerId: 'PARTNER' };
const scoped: FiledChargeRule = { id: 'S', kind: 'administration', enabled: true, scope };
const global: FiledChargeRule = { id: 'G', kind: 'administration', enabled: true, scope: 'global' };

describe('charge rule resolution planning', () => {
  it('prefers exact policy scope, then an explicitly filed global rule', () => {
    expect(resolveChargeRule({ kind: 'administration', scope, rules: [global, scoped] })).toMatchObject({ status: 'resolved', source: 'scoped', rule: { id: 'S' } });
    expect(resolveChargeRule({ kind: 'administration', scope, rules: [global, { ...scoped, enabled: false }] })).toMatchObject({ status: 'resolved', source: 'global', rule: { id: 'G' } });
    expect(resolveChargeRule({ kind: 'administration', scope: { ...scope, partnerId: 'OTHER' }, rules: [global, scoped] })).toMatchObject({ status: 'resolved', source: 'global' });
  });
  it('proposes a P1 configuration request without inventing a rate', () => {
    expect(resolveChargeRule({ kind: 'mortality', scope, rules: [global] })).toMatchObject({ status: 'blocked', reason: 'missing-global', request: { priority: 'P1', kind: 'mortality', proposedScope: 'global', proposedValues: null } });
    expect(resolveChargeRule({ kind: 'administration', scope, rules: [scoped] })).toMatchObject({ status: 'resolved', source: 'scoped' });
  });
  it('distinguishes an unknown scope from explicitly not applicable', () => {
    expect(resolveChargeRule({ kind: 'administration', scope: { ...scope, partnerId: undefined }, rules: [global] })).toMatchObject({ status: 'blocked', reason: 'missing-distribution', request: null });
    expect(resolveChargeRule({ kind: 'administration', scope: { ...scope, partnerId: null, subChannelCode: null }, rules: [global] })).toMatchObject({ status: 'resolved', source: 'global' });
    expect(resolveChargeRule({ kind: 'administration', scope: { ...scope, subChannelCode: undefined }, rules: [] })).toMatchObject({ status: 'blocked', reason: 'missing-distribution', request: { priority: 'P1' } });
  });
  it('rejects ambiguous duplicate rules', () => {
    expect(() => resolveChargeRule({ kind: 'administration', scope, rules: [global, { ...global, id: 'G2' }] })).toThrow(/Multiple enabled global/);
    expect(() => resolveChargeRule({ kind: 'administration', scope, rules: [scoped, { ...scoped, id: 'S2' }] })).toThrow(/Multiple enabled scoped/);
  });
});
