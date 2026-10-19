/**
 * The omni-channel registry: who may sell what, under what name, at what rate, for what commission —
 * and what comes back when the policy does not persist.
 *
 * Distribution is not a dropdown on a proposal. A tenant that sells through a portal, an agency force,
 * three brokers, two bancassurance partners and an aggregator API has, in practice, five different
 * price lists, five different commission structures and five different names for the same plan — and
 * the regulator, the partner contract and the customer all expect the name on the quote to be the one
 * the customer recognised. This module holds that as data:
 *
 *  - a **channel** — the way business arrives, with what it is allowed to do (quote / bind / service /
 *    claim), the commission ceiling its contracts run inside, and the secondary name products take on
 *    it (`Direct`, `Al Khaleej Protect Online`, …);
 *  - a **partner** — a named body inside a channel, with the products it is licensed to sell, the
 *    settlement lag its contract pays on, and its own commission and clawback defaults;
 *  - a **partner product offer** — the variation on one product for one partner: a rate override or
 *    uplift on the premium and on the unit-linked mortality charge, its own commission schedule, its
 *    own clawback plan, and its own secondary name on that partner's shelf.
 *
 * Rates themselves stay in the rating tables (`rating.ts`); the offer says how a partner's price
 * differs from the tariff and the ERP composes the two. Commission and clawback are money and are
 * therefore bps applied to a `Money` — never a float — with the schedule written on the outcome, so a
 * statement can answer "why 18.75% of the first-year premium, and why 12.50 of it back".
 *
 * A tenant that has set none of this up is told so, plainly, by `status()`, and one button files the
 * standard omni-channel pattern to start from. Nothing here invents a commercial term: the caps, the
 * schedules and the settlement lag are filed by the operator and audited.
 */
import { applyBps, formatAmount, money, Money, parseAmount, toDecimalString } from './money.js';

export class ChannelError extends Error {}

export type ChannelKind = 'direct' | 'agency' | 'broker' | 'bancassurance' | 'aggregator' | 'embedded' | 'telemarketing' | 'renewals';
export type ChannelIntegration = 'portal' | 'api' | 'sdk' | 'sftp' | 'manual';
export type ClawbackTrigger = 'cancellation' | 'cancellation-or-lapse' | 'lapse' | 'free-look';
export type ClawbackBasis = 'policy-month' | 'policy-year';

export interface ChannelProductRef {
  readonly productId: string;
  readonly name: string;
  readonly category: string;
  readonly currency: string;
  /** The name filed on the product itself, used when no channel or partner alias exists. */
  readonly secondaryName?: string;
}

export type ChannelProductResolver = (productId: string) => ChannelProductRef | undefined;

export interface ChannelSupport {
  readonly quote: boolean;
  readonly bind: boolean;
  readonly service: boolean;
  readonly claim: boolean;
}

export interface OmniChannel {
  readonly code: string;
  readonly name: string;
  /** What this channel calls itself on a customer-facing screen (may be nil). */
  readonly secondaryName: string;
  readonly kind: ChannelKind;
  readonly integration: ChannelIntegration;
  readonly enabled: boolean;
  /** The ceiling every partner of this channel is filed inside, in basis points of first-year premium. */
  readonly commissionCapBps: number;
  readonly supports: ChannelSupport;
  readonly note: string;
  readonly updatedAt: string;
  readonly updatedBy: string;
}

export interface ClawbackPlan {
  readonly basis: ClawbackBasis;
  readonly trigger: ClawbackTrigger;
  /**
   * Recovery, in basis points of the commission already paid, indexed from the first period:
   * `[10000, 7500, 5000]` on a monthly basis clawbacks the whole commission back for a cancellation in
   * month 1, three quarters for month 2, half for month 3 and nothing thereafter.
   */
  readonly recoveryBps: readonly number[];
  readonly note: string;
}

export interface ChannelPartner {
  readonly partnerId: string;
  readonly name: string;
  readonly secondaryName: string;
  readonly channelCode: string;
  readonly country: string;
  readonly currency: string;
  readonly enabled: boolean;
  /** Days after the settlement period in which the commission is paid. */
  readonly settlementDays: number;
  readonly productIds: readonly string[];
  /** First-year, then renewal, in basis points; the last figure repeats for every later year. */
  readonly commissionBps: readonly number[];
  readonly clawback: ClawbackPlan;
  readonly note: string;
  readonly updatedAt: string;
  readonly updatedBy: string;
}

export interface SubChannel {
  readonly code: string;
  readonly name: string;
  readonly parentChannelCode: string;
  readonly partnerId?: string; // optional direct linkage to a partner subset
  readonly enabled: boolean;
  readonly description: string;
  readonly channelType: 'digital' | 'branch' | 'agency-post' | 'bancassurance-counter' | 'aggregator-feed' | 'embedded-journey';
  readonly supports: ChannelSupport;
  readonly commissionOverrideBps?: number; // if set, overrides channel cap for this sub-channel
  readonly updatedAt: string;
  readonly updatedBy: string;
}

export interface PartnerProductOffer {
  readonly partnerId: string;
  readonly productId: string;
  readonly enabled: boolean;
  /** The name this partner sells this product under — the secondary name, per channel and partner. */
  readonly secondaryName: string;
  /** Multiplier on the tariff premium, in basis points (300 = +3%). */
  readonly premiumUpliftBps: number;
  /** Multiplier on the tariff mortality charge, in basis points. */
  readonly mortalityUpliftBps: number;
  /** An absolute rate per 1,000 that replaces the tariff rather than uplifting it. */
  readonly ratePerThousand: string | null;
  readonly commissionBps: readonly number[] | null;
  readonly clawback: ClawbackPlan | null;
  readonly note: string;
  readonly updatedAt: string;
  readonly updatedBy: string;
}

const KINDS: readonly ChannelKind[] = ['direct', 'agency', 'broker', 'bancassurance', 'aggregator', 'embedded', 'telemarketing', 'renewals'];
const INTEGRATIONS: readonly ChannelIntegration[] = ['portal', 'api', 'sdk', 'sftp', 'manual'];
const TRIGGERS: readonly ClawbackTrigger[] = ['cancellation', 'cancellation-or-lapse', 'lapse', 'free-look'];
const BASES: readonly ClawbackBasis[] = ['policy-month', 'policy-year'];

/** The pattern a tenant starts from when it has not decided yet: the six doors business comes through. */
export const STANDARD_OMNI_CHANNELS: ReadonlyArray<Omit<OmniChannel, 'updatedAt' | 'updatedBy'>> = Object.freeze([
  { code: 'DIRECT-PORTAL', name: 'Direct — customer portal & app', secondaryName: 'Online', kind: 'direct', integration: 'portal', enabled: true, commissionCapBps: 0, supports: { quote: true, bind: true, service: true, claim: true }, note: 'No intermediary, so no commission: the cap is nil by design.' },
  { code: 'AGENCY', name: 'Field agency force', secondaryName: 'Agent Assured', kind: 'agency', integration: 'portal', enabled: true, commissionCapBps: 4000, supports: { quote: true, bind: true, service: true, claim: false }, note: 'Advisory sale, signed on the customer’s device.' },
  { code: 'BROKER', name: 'Intermediated brokers', secondaryName: 'Broker Panel', kind: 'broker', integration: 'api', enabled: true, commissionCapBps: 3000, supports: { quote: true, bind: false, service: true, claim: false }, note: 'Brokers quote and submit; binding sits with the insurer.' },
  { code: 'BANCASSURANCE', name: 'Bancassurance partners', secondaryName: 'Bank Life Counter', kind: 'bancassurance', integration: 'sftp', enabled: true, commissionCapBps: 3500, supports: { quote: true, bind: true, service: false, claim: false }, note: 'Sold at the counter, serviced by the insurer, Bordereau-filed monthly.' },
  { code: 'AGGREGATOR', name: 'Price comparison & aggregator', secondaryName: 'Compare Rate', kind: 'aggregator', integration: 'api', enabled: true, commissionCapBps: 1200, supports: { quote: true, bind: false, service: false, claim: false }, note: 'Rate-driven, thin commission, no servicing.' },
  { code: 'EMBEDDED', name: 'Embedded / partner API', secondaryName: 'Powered by Al Khaleej', kind: 'embedded', integration: 'api', enabled: true, commissionCapBps: 1500, supports: { quote: true, bind: true, service: false, claim: false }, note: 'Cover sold inside somebody else’s checkout.' },
]);

const clampKey = (a: string, b: string) => `${a.toUpperCase()}|${b.toUpperCase()}`;

export interface CommissionOutcome {
  readonly commission: Money;
  readonly bps: number;
  readonly policyYear: number;
  readonly basis: string;
  readonly schedule: readonly number[];
}

export interface ClawbackOutcome {
  readonly recoverable: Money;
  readonly recoveryBps: number;
  readonly period: number;
  readonly basis: string;
  readonly recoverableNow: boolean;
}

/**
 * The registry. Products are not copied here — they are referenced, and every reference is checked
 * against the product factory, so a channel cannot be told to sell a variety that was never filed and
 * a partner cannot be given a product that has since been withdrawn.
 */
export class OmniChannelRegistry {
  private readonly channels = new Map<string, OmniChannel>();
  private readonly partners = new Map<string, ChannelPartner>();
  private readonly subChannels = new Map<string, SubChannel>();
  private readonly offers = new Map<string, PartnerProductOffer>();
  /** Product name aliases per channel: the secondary name a plan carries on that channel's shelf. */
  private readonly channelNames = new Map<string, string>();
  private readonly trail: Array<{ at: string; by: string; action: string; detail: string }> = [];

  constructor(
    private readonly resolveProduct: ChannelProductResolver,
    private readonly defaultCurrency: () => string,
  ) {}

  /* ------------------------------------------------------------------ reading */

  listChannels(): OmniChannel[] { return [...this.channels.values()].sort((a, b) => a.code.localeCompare(b.code)); }
  listPartners(channelCode?: string): ChannelPartner[] {
    return [...this.partners.values()]
      .filter((p) => channelCode === undefined || p.channelCode === channelCode.toUpperCase())
      .sort((a, b) => a.partnerId.localeCompare(b.partnerId));
  }
  listOffers(partnerId?: string): PartnerProductOffer[] {
    return [...this.offers.values()].filter((o) => partnerId === undefined || o.partnerId === partnerId.toUpperCase());
  }
  listSubChannels(parentChannelCode?: string): SubChannel[] {
    return [...this.subChannels.values()]
      .filter((s) => parentChannelCode === undefined || s.parentChannelCode === parentChannelCode.toUpperCase())
      .sort((a, b) => a.code.localeCompare(b.code));
  }
  subChannel(code: string): SubChannel | undefined { return this.subChannels.get(code.trim().toUpperCase()); }
  channel(code: string): OmniChannel | undefined { return this.channels.get(code.trim().toUpperCase()); }
  partner(id: string): ChannelPartner | undefined { return this.partners.get(id.trim().toUpperCase()); }
  offer(partnerId: string, productId: string): PartnerProductOffer | undefined {
    return this.offers.get(clampKey(partnerId, productId));
  }
  audit(limit = 8) { return this.trail.slice(-limit).reverse(); }

  /** The channels a product is on sale through, and under what name. */
  channelsForProduct(productId: string): Array<{ channel: OmniChannel; partners: number; secondaryName: string }> {
    const wanted = productId.trim().toUpperCase();
    const out: Array<{ channel: OmniChannel; partners: number; secondaryName: string }> = [];
    for (const channel of this.listChannels()) {
      const partners = this.listPartners(channel.code).filter((p) => p.productIds.includes(wanted));
      const aliases = partners.map((p) => this.offer(p.partnerId, wanted)?.secondaryName ?? '').find((s) => s.length > 0);
      const alias = aliases ?? this.channelNames.get(clampKey(channel.code, wanted)) ?? '';
      if (partners.length > 0 || alias.length > 0) out.push({ channel, partners: partners.length, secondaryName: alias });
    }
    return out;
  }

  /** Every partner that may sell this product, whatever the channel — the "which partners have it" answer. */
  partnersForProduct(productId: string): ChannelPartner[] {
    const wanted = productId.trim().toUpperCase();
    return this.listPartners().filter((p) => p.productIds.includes(wanted));
  }

  upsertSubChannel(input: Partial<SubChannel> & { code: string; parentChannelCode: string; at?: string; by?: string }): SubChannel {
    const code = input.code.trim().toUpperCase();
    if (!code) throw new ChannelError('a sub-channel code is required');
    const parent = this.channels.get(input.parentChannelCode.trim().toUpperCase());
    if (!parent) throw new ChannelError(`${input.parentChannelCode} is not a configured parent channel`);
    const current = this.subChannels.get(code);
    const name = (input.name ?? current?.name ?? code).trim();
    if (!name) throw new ChannelError(`${code} needs a sub-channel name`);
    const kind = (input.channelType ?? current?.channelType ?? 'digital') as SubChannel['channelType'];
    const types: SubChannel['channelType'][] = ['digital', 'branch', 'agency-post', 'bancassurance-counter', 'aggregator-feed', 'embedded-journey'];
    if (!types.includes(kind)) throw new ChannelError(`sub-channel type ${kind} is not one of ${types.join(', ')}`);
    const commissionOverrideBps = input.commissionOverrideBps ?? current?.commissionOverrideBps;
    if (commissionOverrideBps !== undefined && (!Number.isInteger(commissionOverrideBps) || commissionOverrideBps < 0 || commissionOverrideBps > 10000)) throw new ChannelError('sub-channel commission override must be 0–10000 bps');
    const sc: SubChannel = {
      code,
      name,
      parentChannelCode: parent.code,
      partnerId: input.partnerId !== undefined ? (input.partnerId ? input.partnerId.trim().toUpperCase() : undefined) : current?.partnerId,
      enabled: input.enabled ?? current?.enabled ?? true,
      description: (input.description ?? current?.description ?? '').trim(),
      channelType: kind,
      supports: input.supports ?? current?.supports ?? { quote: true, bind: false, service: true, claim: false },
      commissionOverrideBps,
      updatedAt: input.at ?? '', updatedBy: input.by ?? 'master-settings',
    };
    if (sc.partnerId) {
      const partner = this.partners.get(sc.partnerId);
      if (!partner) throw new ChannelError(`sub-channel partner ${sc.partnerId} is not a filed partner`);
      if (partner.channelCode !== parent.code) throw new ChannelError(`${sc.partnerId} is filed on ${partner.channelCode}, not parent channel ${parent.code}`);
    }
    this.subChannels.set(code, sc);
    this.record(current ? 'subchannel-updated' : 'subchannel-created', `${code} on ${parent.code} (${sc.channelType})`, sc.updatedAt, sc.updatedBy);
    return sc;
  }

  removeSubChannel(code: string, at = '', by = 'master-settings'): void {
    const key = code.trim().toUpperCase();
    if (!this.subChannels.has(key)) throw new ChannelError(`no sub-channel ${key}`);
    this.subChannels.delete(key);
    this.record('subchannel-removed', key, at, by);
  }

  /**
   * What a customer sees: the partner's own alias, else the channel's, else the name filed on the
   * product, else the product's registered name. The source travels with it, because "why is it called
   * that on this screen" is a question a distribution manager asks.
   */
  secondaryNameFor(productId: string, scope: { channelCode?: string | null; partnerId?: string | null } = {}): { name: string; source: string } {
    const wanted = productId.trim().toUpperCase();
    const product = this.resolveProduct(wanted);
    if (scope.partnerId) {
      const alias = this.offer(scope.partnerId, wanted)?.secondaryName ?? '';
      if (alias) return { name: alias, source: `the ${scope.partnerId.toUpperCase()} shelf` };
    }
    if (scope.channelCode) {
      const alias = this.channelNames.get(clampKey(scope.channelCode, wanted));
      if (alias) return { name: alias, source: `the ${scope.channelCode.toUpperCase()} channel` };
    }
    // A channel's or a partner's own brand is not a product's name: it says who sold it, not what it
    // is. Only a name filed against the product — for this shelf, this channel, or the master — is used.
    if (product?.secondaryName) return { name: product.secondaryName, source: 'the product master' };
    return { name: product?.name ?? wanted, source: 'the registered product name' };
  }

  /* ------------------------------------------------------------------ writing */

  private record(action: string, detail: string, at: string, by: string): void {
    this.trail.push({ at, by, action, detail });
    if (this.trail.length > 200) this.trail.splice(0, this.trail.length - 200);
  }

  /**
   * One button for a tenant with nothing set up: the six standard doors, each with its own ceiling and
   * its own permissions. Partners are deliberately not invented by it — who signs a contract is a
   * commercial fact, not a default.
   */
  bootstrap(at = '', by = 'master-settings'): { created: string[]; skipped: boolean } {
    if (this.channels.size > 0) return { created: [], skipped: true };
    const created: string[] = [];
    for (const seed of STANDARD_OMNI_CHANNELS) {
      const channel: OmniChannel = { ...seed, updatedAt: at, updatedBy: by };
      this.channels.set(channel.code, channel);
      created.push(channel.code);
    }
    this.record('channel-bootstrap', `${created.length} standard omni-channel(s) filed`, at, by);
    return { created, skipped: false };
  }

  upsertChannel(input: Partial<OmniChannel> & { code: string; at?: string; by?: string }): OmniChannel {
    const code = input.code.trim().toUpperCase();
    if (!code) throw new ChannelError('a channel code is required');
    const current = this.channels.get(code);
    const kind = (input.kind ?? current?.kind ?? 'broker') as ChannelKind;
    if (!KINDS.includes(kind)) throw new ChannelError(`channel kind "${kind}" is not one of ${KINDS.join(', ')}`);
    const integration = (input.integration ?? current?.integration ?? 'portal') as ChannelIntegration;
    if (!INTEGRATIONS.includes(integration)) throw new ChannelError(`integration "${integration}" is not one of ${INTEGRATIONS.join(', ')}`);
    const cap = Number(input.commissionCapBps ?? current?.commissionCapBps ?? 0);
    if (!Number.isFinite(cap) || cap < 0 || cap > 10000) throw new ChannelError(`a commission cap of ${input.commissionCapBps ?? 0} bps is not a share of anything`);
    const supports: ChannelSupport = {
      quote: input.supports?.quote ?? current?.supports.quote ?? true,
      bind: input.supports?.bind ?? current?.supports.bind ?? false,
      service: input.supports?.service ?? current?.supports.service ?? true,
      claim: input.supports?.claim ?? current?.supports.claim ?? false,
    };
    if (!supports.quote && supports.bind) throw new ChannelError(`${code} could not bind a quote it is not allowed to take`);
    const channel: OmniChannel = {
      code,
      name: (input.name ?? current?.name ?? code).trim(),
      secondaryName: (input.secondaryName ?? current?.secondaryName ?? '').trim(),
      kind, integration,
      enabled: input.enabled ?? current?.enabled ?? true,
      commissionCapBps: cap,
      supports,
      note: input.note ?? current?.note ?? '',
      updatedAt: input.at ?? '', updatedBy: input.by ?? 'master-settings',
    };
    // Turning a channel off with live partners on it is a contract question, not a switch.
    const partners = this.listPartners(code).filter((p) => p.enabled);
    if (!channel.enabled && partners.length > 0) {
      throw new ChannelError(`${code} still has ${partners.length} enabled partner(s): ${partners.map((p) => p.partnerId).join(', ')} — suspend them first or the commission book has no home`);
    }
    this.channels.set(code, channel);
    this.record(current ? 'channel-updated' : 'channel-created', `${code} (${channel.name}) cap ${cap} bps`, channel.updatedAt, channel.updatedBy);
    return channel;
  }

  removeChannel(code: string, at = '', by = 'master-settings'): void {
    const key = code.trim().toUpperCase();
    const channel = this.channels.get(key);
    if (!channel) throw new ChannelError(`no channel ${key}`);
    const partners = this.listPartners(key);
    if (partners.length > 0) throw new ChannelError(`${key} still holds ${partners.length} partner(s) — remove them first`);
    const subChannels = this.listSubChannels(key);
    if (subChannels.length > 0) throw new ChannelError(`${key} still holds ${subChannels.length} sub-channel(s) — remove them first`);
    this.channels.delete(key);
    for (const mapKey of [...this.channelNames.keys()]) if (mapKey.startsWith(`${key}|`)) this.channelNames.delete(mapKey);
    this.record('channel-removed', key, at, by);
  }

  /** The secondary name a product carries on a channel's shelf, as opposed to on a partner's. */
  setChannelProductName(input: { productId: string; channelCode: string; secondaryName: string; at?: string; by?: string }): { productId: string; channelCode: string; secondaryName: string } {
    const productId = input.productId.trim().toUpperCase();
    const channelCode = input.channelCode.trim().toUpperCase();
    if (!this.resolveProduct(productId)) throw new ChannelError(`${productId} is not filed in the product factory`);
    if (!this.channels.has(channelCode)) throw new ChannelError(`${channelCode} is not a configured channel`);
    const name = input.secondaryName.trim();
    const key = clampKey(channelCode, productId);
    if (name) this.channelNames.set(key, name); else this.channelNames.delete(key);
    this.record('channel-product-name', `${productId} on ${channelCode} shown as “${name || '(the registered name)'}”`, input.at ?? '', input.by ?? 'master-settings');
    return { productId, channelCode, secondaryName: name };
  }

  upsertPartner(input: Partial<ChannelPartner> & { partnerId: string; name: string; channelCode: string; at?: string; by?: string }): ChannelPartner {
    const partnerId = input.partnerId.trim().toUpperCase();
    if (!partnerId) throw new ChannelError('a partner id is required');
    if (!input.name.trim()) throw new ChannelError(`${partnerId} needs a trading name`);
    const channelCode = input.channelCode.trim().toUpperCase();
    const channel = this.channels.get(channelCode);
    if (!channel) throw new ChannelError(`${channelCode} is not a configured channel — set the channel up before its partners`);
    if (!channel.enabled && (input.enabled ?? this.partners.get(partnerId)?.enabled ?? true)) {
      throw new ChannelError(`${channelCode} is switched off, so ${partnerId} cannot be enabled on it`);
    }
    const current = this.partners.get(partnerId);
    if (current && current.channelCode !== channelCode && current.productIds.length > 0) {
      throw new ChannelError(`${partnerId} sells ${current.productIds.length} product(s) on ${current.channelCode}; move them to ${channelCode} by re-filing the products, not by re-pointing the partner`);
    }
    const currency = (input.currency ?? current?.currency ?? this.defaultCurrency()).trim().toUpperCase();
    parseAmount('0.00', currency);            // an unknown currency is refused here rather than at the first statement
    const productIds = [...new Set((input.productIds ?? current?.productIds ?? []).map((p) => p.trim().toUpperCase()))];
    const unknown = productIds.filter((p) => !this.resolveProduct(p));
    if (unknown.length > 0) throw new ChannelError(`not filed in the product factory, so nobody can be licensed to sell them: ${unknown.join(', ')}`);
    const commissionBps = (input.commissionBps ?? current?.commissionBps ?? [0]).map((n) => Number(n));
    const clawback = input.clawback ?? current?.clawback ?? DEFAULT_CLAWBACK;
    this.assertCommissionInsideCap(channelCode, commissionBps, clawback, partnerId);
    const settlementDays = Number(input.settlementDays ?? current?.settlementDays ?? 30);
    if (!Number.isFinite(settlementDays) || settlementDays < 0 || settlementDays > 365) {
      throw new ChannelError(`a settlement lag of ${input.settlementDays} days is not a payment term anyone could reconcile`);
    }
    const partner: ChannelPartner = {
      partnerId,
      name: input.name.trim(),
      secondaryName: (input.secondaryName ?? current?.secondaryName ?? '').trim(),
      channelCode, currency,
      country: (input.country ?? current?.country ?? '').trim().toUpperCase(),
      enabled: input.enabled ?? current?.enabled ?? true,
      settlementDays,
      productIds,
      commissionBps,
      clawback: this.assertClawback(clawback),
      note: input.note ?? current?.note ?? '',
      updatedAt: input.at ?? '', updatedBy: input.by ?? 'master-settings',
    };
    this.partners.set(partnerId, partner);
    // A product taken off a partner's shelf takes its offer with it: a stale override nobody sells is
    // a rate waiting to be quoted by accident.
    for (const offer of this.listOffers(partnerId)) {
      if (!partner.productIds.includes(offer.productId)) this.offers.delete(clampKey(partnerId, offer.productId));
    }
    this.record(current ? 'partner-updated' : 'partner-created', `${partnerId} on ${channelCode}: ${partner.productIds.length} product(s), ${partner.commissionBps[0] ?? 0} bps first year`, partner.updatedAt, partner.updatedBy);
    return partner;
  }

  removePartner(partnerId: string, at = '', by = 'master-settings'): void {
    const key = partnerId.trim().toUpperCase();
    if (!this.partners.has(key)) throw new ChannelError(`no partner ${key}`);
    const subChannels = this.listSubChannels().filter(s => s.partnerId === key);
    if (subChannels.length > 0) throw new ChannelError(`${key} still owns ${subChannels.length} sub-channel(s) — remove or reassign them first`);
    this.partners.delete(key);
    for (const offer of this.listOffers(key)) this.offers.delete(clampKey(key, offer.productId));
    this.record('partner-removed', key, at, by);
  }

  /** Which products a partner may sell — the shelf, filed as a list rather than one at a time. */
  setPartnerProducts(partnerId: string, productIds: readonly string[], at = '', by = 'master-settings'): ChannelPartner {
    const partner = this.partner(partnerId);
    if (!partner) throw new ChannelError(`no partner ${partnerId}`);
    return this.upsertPartner({ ...partner, productIds, at, by });
  }

  private assertClawback(plan: ClawbackPlan): ClawbackPlan {
    if (!BASES.includes(plan.basis)) throw new ChannelError(`clawback basis "${plan.basis}" is not one of ${BASES.join(', ')}`);
    if (!TRIGGERS.includes(plan.trigger)) throw new ChannelError(`clawback trigger "${plan.trigger}" is not one of ${TRIGGERS.join(', ')}`);
    if (plan.recoveryBps.length === 0) throw new ChannelError('a clawback plan with no schedule recovers nothing and should say so instead');
    for (const bps of plan.recoveryBps) {
      if (!Number.isFinite(bps) || bps < 0 || bps > 10000) throw new ChannelError(`a recovery of ${bps} bps is not a share of a commission`);
    }
    return { basis: plan.basis, trigger: plan.trigger, recoveryBps: [...plan.recoveryBps], note: plan.note };
  }

  private assertCommissionInsideCap(channelCode: string, commissionBps: readonly number[], clawback: ClawbackPlan, partnerId: string): void {
    const channel = this.channels.get(channelCode);
    if (!channel) throw new ChannelError(`${channelCode} is not a configured channel`);
    if (commissionBps.some((n) => !Number.isFinite(n) || n < 0 || n > 10000)) {
      throw new ChannelError(`a commission schedule of ${commissionBps.join('/')} bps is not a percentage of anything`);
    }
    const highest = Math.max(0, ...commissionBps);
    if (highest > channel.commissionCapBps) {
      throw new ChannelError(`${partnerId}'s commission of ${highest} bps exceeds the ${channel.commissionCapBps} bps ceiling filed on ${channelCode} — raise the ceiling on the channel or lower the schedule`);
    }
    this.assertClawback(clawback);
  }

  /** File a partner's variation on one product. Everything unset falls back to the partner's defaults. */
  upsertOffer(input: Partial<PartnerProductOffer> & { partnerId: string; productId: string; at?: string; by?: string }): PartnerProductOffer {
    const partnerId = input.partnerId.trim().toUpperCase();
    const productId = input.productId.trim().toUpperCase();
    const partner = this.partners.get(partnerId);
    if (!partner) throw new ChannelError(`no partner ${partnerId} — file the partner before its rates`);
    if (!partner.productIds.includes(productId)) {
      throw new ChannelError(`${partnerId} is not licensed for ${productId}; add it to the partner's shelf first (${partner.productIds.length} product(s) on file)`);
    }
    const current = this.offers.get(clampKey(partnerId, productId));
    const premiumUplift = Number(input.premiumUpliftBps ?? current?.premiumUpliftBps ?? 0);
    const mortalityUplift = Number(input.mortalityUpliftBps ?? current?.mortalityUpliftBps ?? 0);
    for (const [label, value] of [['premium', premiumUplift], ['mortality', mortalityUplift]] as const) {
      if (!Number.isFinite(value) || value < -10000 || value > 10000) {
        throw new ChannelError(`a ${label} uplift of ${value} bps is not a multiplier anyone could price with`);
      }
    }
    const product = this.resolveProduct(productId);
    const currency = product?.currency ?? partner.currency;
    let ratePerThousand: string | null = null;
    const rateInput = input.ratePerThousand === undefined ? current?.ratePerThousand ?? null : input.ratePerThousand;
    if (rateInput !== null && String(rateInput).trim() !== '') {
      const parsed = parseAmount(String(rateInput), currency);
      if (parsed.minor < 0n) throw new ChannelError('an absolute rate per 1,000 cannot be negative');
      // Held as the decimal the contract quoted, not as a float and not as a bare number of minor
      // units: the sheet, the statement and the tariff all speak in the currency's own notation.
      ratePerThousand = toDecimalString(parsed);
    }
    const commissionBps = input.commissionBps === undefined
      ? current?.commissionBps ?? null
      : (input.commissionBps === null || input.commissionBps.length === 0 ? null : input.commissionBps.map(Number));
    if (commissionBps !== null) this.assertCommissionInsideCap(partner.channelCode, commissionBps, input.clawback ?? current?.clawback ?? partner.clawback, partnerId);
    const clawback = input.clawback === undefined
      ? current?.clawback ?? null
      : (input.clawback === null ? null : this.assertClawback(input.clawback));
    const offer: PartnerProductOffer = {
      partnerId, productId,
      enabled: input.enabled ?? current?.enabled ?? true,
      secondaryName: (input.secondaryName ?? current?.secondaryName ?? '').trim(),
      premiumUpliftBps: premiumUplift,
      mortalityUpliftBps: mortalityUplift,
      ratePerThousand,
      commissionBps,
      clawback,
      note: input.note ?? current?.note ?? '',
      updatedAt: input.at ?? '', updatedBy: input.by ?? 'master-settings',
    };
    this.offers.set(clampKey(partnerId, productId), offer);
    this.record(current ? 'offer-updated' : 'offer-created', `${partnerId} × ${productId}: ${offer.ratePerThousand ?? `+${offer.premiumUpliftBps} bps on the tariff`}, commission ${offer.commissionBps ? offer.commissionBps.join('/') : 'partner default'}`, offer.updatedAt, offer.updatedBy);
    return offer;
  }

  removeOffer(partnerId: string, productId: string, at = '', by = 'master-settings'): void {
    const key = clampKey(partnerId, productId);
    if (!this.offers.has(key)) throw new ChannelError(`no offer for ${partnerId} × ${productId} to remove`);
    this.offers.delete(key);
    this.record('offer-removed', key.replace('|', ' × '), at, by);
  }

  /** The terms that apply to a partner selling one product: the offer where it speaks, the partner elsewhere. */
  termsFor(partnerId: string, productId: string): {
    commissionBps: readonly number[]; clawback: ClawbackPlan; premiumUpliftBps: number; mortalityUpliftBps: number;
    ratePerThousand: string | null; source: string;
  } {
    const partner = this.partners.get(partnerId.trim().toUpperCase());
    if (!partner) throw new ChannelError(`no partner ${partnerId}`);
    const offer = this.offer(partner.partnerId, productId);
    return {
      commissionBps: offer?.commissionBps ?? partner.commissionBps,
      clawback: offer?.clawback ?? partner.clawback,
      premiumUpliftBps: offer?.premiumUpliftBps ?? 0,
      mortalityUpliftBps: offer?.mortalityUpliftBps ?? 0,
      ratePerThousand: offer?.ratePerThousand ?? null,
      source: offer ? `the ${partner.partnerId} × ${productId.toUpperCase()} offer` : `the ${partner.partnerId} partner defaults`,
    };
  }

  /** Commission on a premium, by policy year: the schedule's last figure repeats for later years. */
  commissionFor(input: { partnerId: string; productId: string; premium: Money; policyYear?: number }): CommissionOutcome {
    const terms = this.termsFor(input.partnerId, input.productId);
    const year = Math.max(1, Math.trunc(input.policyYear ?? 1));
    const schedule = terms.commissionBps.length > 0 ? terms.commissionBps : [0];
    const bps = schedule[year - 1] ?? schedule[schedule.length - 1] ?? 0;
    const commission = applyBps(input.premium, bps);
    return {
      commission, bps, policyYear: year,
      schedule: [...schedule],
      basis: `${bps} bps of ${formatAmount(input.premium)} for policy year ${year}, on ${terms.source} (partner ${input.partnerId.toUpperCase()}, product ${input.productId.toUpperCase()})`,
    };
  }

  /**
   * What comes back when a policy cancels or lapses inside the clawback window. The recovery is a share
   * of the commission that was paid, applied to that same money, so it can never over-recover.
   */
  clawbackFor(input: { partnerId: string; productId: string; commission: Money; periodsSinceInception: number }): ClawbackOutcome {
    const terms = this.termsFor(input.partnerId, input.productId);
    const plan = terms.clawback;
    const period = Math.max(0, Math.trunc(input.periodsSinceInception));
    const recoveryBps = period >= 1 && period <= plan.recoveryBps.length ? plan.recoveryBps[period - 1] ?? 0 : 0;
    const recoverable = applyBps(input.commission, recoveryBps);
    return {
      recoverable, recoveryBps, period,
      recoverableNow: recoverable.minor > 0n,
      basis: recoveryBps === 0
        ? `nothing is recoverable at ${plan.basis} ${period} — the ${plan.trigger} window on ${terms.source} runs ${plan.recoveryBps.length} period(s)`
        : `${recoveryBps} bps of ${formatAmount(input.commission)} of commission is recoverable on a ${plan.trigger} at ${plan.basis} ${period} (${plan.note})`,
    };
  }

  /* ------------------------------------------------------------------ the setup answer */

  /**
   * Whether the omni-channel is set up, and what it still needs. The console puts this on the section
   * as blockers and warnings, and `POST /master/channels/bootstrap` is what clears the first of them.
   */
  status(): {
    configured: boolean; channelCount: number; enabledChannelCount: number; partnerCount: number;
    enabledPartnerCount: number; offerCount: number; productsOnShelf: number;
    subChannelCount: number; subChannelEnabled: number;
    blockers: string[]; warnings: string[]; next: string[];
  } {
    const channels = this.listChannels();
    const partners = this.listPartners();
    const offers = this.listOffers();
    const blockers: string[] = [];
    const warnings: string[] = [];
    const next: string[] = [];

    if (channels.length === 0) blockers.push('No omni-channel is set up: nothing can be filed to a channel or a partner until at least one exists.');
    if (channels.length > 0 && channels.every((c) => !c.enabled)) blockers.push('Every channel is switched off, so no partner of theirs can be enabled.');

    for (const channel of channels) {
      const own = partners.filter((p) => p.channelCode === channel.code);
      if (channel.enabled && own.length === 0) next.push(`${channel.code} has no partner filed on it yet — a channel with no partners sells nothing.`);
      const over = own.filter((p) => p.enabled && Math.max(0, ...p.commissionBps) > channel.commissionCapBps);
      for (const p of over) blockers.push(`${p.partnerId} is filed above the ${channel.code} ceiling (${Math.max(0, ...p.commissionBps)} bps against ${channel.commissionCapBps} bps).`);
      if (channel.kind === 'direct' && channel.commissionCapBps > 0) warnings.push(`${channel.code} is a direct channel with a ${channel.commissionCapBps} bps ceiling — say who is being paid.`);
    }
    for (const partner of partners) {
      if (partner.productIds.length === 0) warnings.push(`${partner.partnerId} has no products on its shelf, so it can quote nothing.`);
      if ((partner.commissionBps[0] ?? 0) > 0 && partner.clawback.recoveryBps.length === 0) {
        warnings.push(`${partner.partnerId} pays a first-year commission with no clawback schedule behind it.`);
      }
      const missing = partner.productIds.filter((p) => !this.resolveProduct(p));
      if (missing.length > 0) blockers.push(`${partner.partnerId} is filed with products that are no longer on file: ${missing.join(', ')}.`);
      const orphanOffers = this.listOffers(partner.partnerId).filter((o) => !partner.productIds.includes(o.productId));
      if (orphanOffers.length > 0) warnings.push(`${partner.partnerId} keeps ${orphanOffers.length} rate offer(s) for products it no longer sells.`);
    }
    if (offers.length > 0 && channels.length === 0) blockers.push('Partner product offers exist without a channel: file the channels first.');

    const subChannels = this.listSubChannels();
    for (const subChannel of subChannels) {
      const parent = this.channels.get(subChannel.parentChannelCode);
      if (!parent) blockers.push(`${subChannel.code} points at a missing parent channel ${subChannel.parentChannelCode}.`);
      else if (subChannel.enabled && !parent.enabled) blockers.push(`${subChannel.code} is enabled under disabled channel ${parent.code}.`);
    }
    const productsOnShelf = new Set(partners.flatMap((p) => p.productIds)).size;
    return {
      configured: channels.length > 0,
      channelCount: channels.length,
      enabledChannelCount: channels.filter((c) => c.enabled).length,
      partnerCount: partners.length,
      enabledPartnerCount: partners.filter((p) => p.enabled).length,
      offerCount: offers.length,
      productsOnShelf,
      subChannelCount: subChannels.length,
      subChannelEnabled: subChannels.filter(s => s.enabled).length,
      blockers, warnings,
      next: next.slice(0, 4),
    };
  }

  /** The snapshot the console reads: everything, already ordered, with the names resolved. */
  snapshot() {
    const subChannels = this.listSubChannels();
    const channels = this.listChannels().map((c) => ({
      ...c,
      subChannels: this.listSubChannels(c.code),
      partners: this.listPartners(c.code).map((p) => ({
        ...p,
        products: p.productIds.map((productId) => {
          const product = this.resolveProduct(productId);
          const terms = this.termsFor(p.partnerId, productId);
          const named = this.secondaryNameFor(productId, { channelCode: c.code, partnerId: p.partnerId });
          return {
            productId,
            name: product?.name ?? productId,
            secondaryName: named.name,
            nameSource: named.source,
            category: product?.category ?? '—',
            rateOverride: terms.ratePerThousand,
            premiumUpliftBps: terms.premiumUpliftBps,
            mortalityUpliftBps: terms.mortalityUpliftBps,
            commissionBps: terms.commissionBps,
            clawback: terms.clawback,
            offerNote: this.offer(p.partnerId, productId)?.note ?? '',
          };
        }),
      })),
    }));
    const unfiled = this.listChannels().filter((c) => this.listPartners(c.code).length === 0).map((c) => c.code);
    return {
      channels,
      subChannels,
      partners: this.listPartners(),
      offers: this.listOffers(),
      productNames: [...this.channelNames.entries()].map(([key, secondaryName]) => {
        const [channelCode, productId] = key.split('|') as [string, string];
        return { channelCode, productId, secondaryName };
      }),
      ...this.status(),
      unfiled,
      standardAvailable: STANDARD_OMNI_CHANNELS.length,
      trail: this.audit(6),
    };
  }

  /** The per-product distribution card: which channels, which partners, at what commission. */
  distributionFor(productId: string) {
    const wanted = productId.trim().toUpperCase();
    if (!this.resolveProduct(wanted)) throw new ChannelError(`${wanted} is not filed in the product factory`);
    const rows: Array<{
      channelCode: string; channelName: string; partnerId: string; partnerName: string; enabled: boolean;
      secondaryName: string; ratePerThousand: string | null; premiumUpliftBps: number; mortalityUpliftBps: number;
      commissionBps: readonly number[]; clawback: ClawbackPlan; firstYearCommissionOn: Money;
    }> = [];
    for (const partner of this.listPartners()) {
      if (!partner.productIds.includes(wanted)) continue;
      const channel = this.channel(partner.channelCode);
      const terms = this.termsFor(partner.partnerId, wanted);
      const named = this.secondaryNameFor(wanted, { channelCode: partner.channelCode, partnerId: partner.partnerId });
      rows.push({
        channelCode: partner.channelCode,
        channelName: channel?.name ?? partner.channelCode,
        partnerId: partner.partnerId, partnerName: partner.name, enabled: partner.enabled,
        secondaryName: named.name,
        ratePerThousand: terms.ratePerThousand,
        premiumUpliftBps: terms.premiumUpliftBps,
        mortalityUpliftBps: terms.mortalityUpliftBps,
        commissionBps: terms.commissionBps,
        clawback: terms.clawback,
        // The commission a standard 1,000.00 of first-year premium would earn under these terms: a
        // figure the partner can check with a calculator rather than a percentage they have to derive.
        firstYearCommissionOn: applyBps(money(100_000n, partner.currency), terms.commissionBps[0] ?? 0),
      });
    }
    return rows;
  }
}

/** Three years of declining recovery: the shape most distribution agreements actually sign. */
export const DEFAULT_CLAWBACK: ClawbackPlan = Object.freeze({
  basis: 'policy-year',
  trigger: 'cancellation-or-lapse',
  recoveryBps: [10000, 5000, 2500],
  note: 'Full recovery in year 1, half in year 2, a quarter in year 3, nothing thereafter.',
});
