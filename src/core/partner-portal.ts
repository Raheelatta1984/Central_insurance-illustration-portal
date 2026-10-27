/**
 * Partner workspace. This register coordinates existing engines; it does not move money or
 * perform an endorsement/claim. It lives in the demo world and is not included in its replay store.
 * The public contract and the production gates are in docs/20-PARTNER-PORTAL.md.
 */
import type { World } from './demo.js';
import type { JourneyCase, JourneyStageId } from './journey.js';
import type { RoutingDecision, UnderwritingRoute } from './uwroute.js';
import { fingerprintOf } from './persistence.js';
import { formatAmount, money, parseAmount, scaleOf } from './money.js';

export class PartnerPortalError extends Error {}
export class PartnerAccessError extends Error {}

export interface PartnerScope {
  readonly partnerId: string;
  readonly channelCode: string;
  readonly subChannelCode: string | null;
}
export type PartnerReviewer = 'supervisor' | 'manager' | 'senior-manager';
export type ApplicationStatus = 'pending' | 'approved' | 'returned' | 'rejected';
export interface PartnerApplication {
  readonly id: string;
  readonly caseId: string;
  readonly scope: PartnerScope;
  readonly applicationId: string;
  readonly quotationId: string;
  readonly quotationVersion: number;
  readonly fingerprint: string;
  readonly submittedBy: string;
  readonly submittedAt: string;
  status: ApplicationStatus;
  review: { by: string; role: PartnerReviewer; at: string; outcome: 'approved' | 'returned' | 'rejected'; note: string } | null;
  route: { route: UnderwritingRoute; automatic: boolean; assignedTo: string; reasons: readonly string[] } | null;
  underwritingReview: { by: string; at: string; note: string; decisionFingerprint: string; termsReconciled: true } | null;
  revisedQuotation?: { quotationId: string; version: number; decisionFingerprint: string; issuedBy: string; issuedAt: string } | null;
}
export interface CommissionEntry {
  readonly id: string;
  readonly scope: PartnerScope;
  readonly policyId: string;
  readonly productId: string;
  readonly period: string;
  readonly sourceRef: string;
  readonly currency: string;
  readonly premiumMinor: string;
  readonly expectedMinor: string;
  readonly bps: number;
  readonly basis: string;
  readonly createdBy: string;
  readonly createdAt: string;
  statements: Array<{ reference: string; amountMinor: string; by: string; at: string }>;
  status: 'awaiting-statement' | 'awaiting-review' | 'disputed' | 'approved';
  review: { by: string; at: string; note: string; outcome: 'approved' | 'disputed' } | null;
  disbursements: Array<{ reference: string; amountMinor: string; by: string; at: string }>;
}
export type ServiceKind = 'policy-information' | 'financial-endorsement' | 'non-financial-endorsement' | 'claim' | 'claim-settlement' | 'commission-query' | 'reporting-request';
export const SERVICE_KINDS: readonly ServiceKind[] = ['policy-information', 'financial-endorsement', 'non-financial-endorsement', 'claim', 'claim-settlement', 'commission-query', 'reporting-request'];
export interface ServiceRequest {
  readonly id: string;
  readonly scope: PartnerScope;
  readonly kind: ServiceKind;
  readonly policyId: string | null;
  readonly subject: string;
  readonly openedBy: string;
  readonly openedAt: string;
  status: 'open' | 'in-review' | 'closed';
  messages: Array<{ by: string; at: string; from: 'partner' | 'insurer'; text: string }>;
}
export interface PortalAudit {
  readonly at: string;
  readonly by: string;
  readonly action: string;
  readonly recordId: string;
  readonly scope: PartnerScope;
  readonly detail: string;
}

const text = (v: string, name: string, min = 1): string => {
  const s = v.trim();
  if (s.length < min || s.length > 2000) throw new PartnerPortalError(`${name} must contain ${min}–2000 characters`);
  return s;
};
const key = (v: string): string => v.trim().toUpperCase();
const scopeEquals = (a: PartnerScope, b: PartnerScope): boolean => a.partnerId === b.partnerId && a.channelCode === b.channelCode && a.subChannelCode === b.subChannelCode;
function amount(input: string, currency: string): bigint {
  const scale = scaleOf(currency);
  const value = input.trim().replace(/,/g, '');
  if (!/^\d+(?:\.\d+)?$/.test(value) || (value.split('.')[1]?.length ?? 0) > scale) {
    throw new PartnerPortalError(`amount must be non-negative with at most ${scale} decimal places for ${currency}`);
  }
  return parseAmount(value, currency).minor;
}
function period(value: string): string {
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(value)) throw new PartnerPortalError('period must be YYYY-MM (calendar month)');
  return value;
}

export class PartnerPortal {
  private readonly applications: PartnerApplication[] = [];
  private readonly commissions: CommissionEntry[] = [];
  private readonly requests: ServiceRequest[] = [];
  private readonly trail: PortalAudit[] = [];
  private seq = 0;
  private id(prefix: string): string { return `${prefix}-${String(++this.seq).padStart(6, '0')}`; }
  private audit(at: string, by: string, action: string, recordId: string, scope: PartnerScope, detail: string): void {
    this.trail.push(Object.freeze({ at, by, action, recordId, scope: { ...scope }, detail }));
  }

  /** Resolve the actual registry; no fixed list of channel kinds is assumed. */
  scope(w: World, input: { partnerId: string; channelCode?: string; subChannelCode?: string | null }, quote = false): PartnerScope {
    const p = w.erp.channels.partner(key(input.partnerId));
    if (!p || !p.enabled) throw new PartnerPortalError('partner is not filed or is disabled');
    const c = w.erp.channels.channel(p.channelCode);
    if (!c || !c.enabled || (input.channelCode && key(input.channelCode) !== c.code)) throw new PartnerPortalError('partner and enabled channel do not match');
    const code = input.subChannelCode ? key(input.subChannelCode) : null;
    const sub = code ? w.erp.channels.subChannel(code) : undefined;
    if (code && (!sub || !sub.enabled || sub.parentChannelCode !== c.code || (sub.partnerId && sub.partnerId !== p.partnerId))) {
      throw new PartnerPortalError('sub-channel is unavailable for this partner and channel');
    }
    if (quote && (!c.supports.quote || (sub && !sub.supports.quote))) throw new PartnerPortalError('this distribution route is not enabled to quote');
    return { partnerId: p.partnerId, channelCode: c.code, subChannelCode: code };
  }

  attach(w: World, input: { caseId: string; scope: PartnerScope; by: string; at: string }): JourneyCase {
    const c = w.journey.get(input.caseId);
    const scope = this.scope(w, input.scope, true);
    const p = w.erp.channels.partner(scope.partnerId)!;
    if (c.distribution && !scopeEquals(c.distribution, scope)) throw new PartnerPortalError('the journey already belongs to another partner or sub-channel');
    if (c.artefacts.policyId || c.artefacts.routeId || c.submitted.includes('routing')) throw new PartnerPortalError('attribute the journey before underwriting routing or policy conversion');
    if (c.country !== p.country || c.currency !== p.currency) throw new PartnerPortalError('journey country and currency must match the partner');
    if (!c.distribution && c.artefacts.applicationId) throw new PartnerPortalError('attribute the partner before creating the coverage application or performing underwriting');
    if (!c.distribution) {
      c.distribution = scope;
      c.answers.quotation = { ...c.answers.quotation, buyLinkSent: false };
      this.audit(input.at, input.by, 'journey-attributed', c.caseId, scope, 'Partner and distribution route attached before routing.');
    }
    return c;
  }

  /** Only the stable signed application facts; payment credentials and case answers are not retained. */
  private signedFingerprint(w: World, c: JourneyCase, approved?: Pick<PartnerApplication, 'quotationId' | 'quotationVersion'>): string {
    if (!c.artefacts.applicationId || !c.artefacts.quotationId) throw new PartnerPortalError('an application and quotation are required');
    const app = w.underwriting.application(c.artefacts.applicationId);
    if (!c.distribution) throw new PartnerPortalError('partner attribution is required');
    this.scope(w, c.distribution, true);
    const partner = w.erp.channels.partner(c.distribution.partnerId)!;
    if (c.country !== partner.country || c.currency !== partner.currency) throw new PartnerPortalError('journey country and currency must match the partner');
    if (!partner.productIds.includes(app.productId) || w.erp.channels.offer(partner.partnerId, app.productId)?.enabled === false) throw new PartnerPortalError('the product is not enabled on this partner shelf');
    const quote = approved ? w.journey.quotations.get(approved.quotationId, approved.quotationVersion) : w.journey.quotations.get(c.artefacts.quotationId);
    if (quote.status !== 'finalised' || !quote.finalisation?.signatureReference) throw new PartnerPortalError('the current quotation must be signed by the customer');
    // A signed conditional quote and the application basis are frozen before any underwriting decision.
    if (!quote.facts.conditional) throw new PartnerPortalError('partner review requires a signed conditional quotation');
    const coverage = c.answers['coverage'];
    const loadings = c.answers['loadings'];
    const profile = app.profile;
    const list = (value: unknown) => (Array.isArray(value) ? value : typeof value === 'string' ? value.split(',') : []).map((item) => String(item).trim()).filter(Boolean);
    const matchesList = (value: unknown, actual: string[]) => JSON.stringify(list(value)) === JSON.stringify(actual);
    const income = parseAmount(String(coverage['annualIncome'] ?? '0'), c.currency);
    if (quote.facts.product.productId !== app.productId || quote.facts.customer.partyId !== app.partyId
      || quote.facts.sumAssured.minor !== app.sumAssured.minor || quote.facts.sumAssured.currency !== app.sumAssured.currency
      || profile.age !== Number(coverage['age'] ?? 35) || profile.sex !== (coverage['sex'] === 'female' ? 'female' : 'male')
      || profile.smoker !== (coverage['smoker'] === true) || profile.heightCm !== Number(coverage['heightCm'] ?? 175)
      || profile.weightKg !== Number(coverage['weightKg'] ?? 75) || profile.residenceCountry !== String(coverage['residenceCountry'] ?? c.country)
      || profile.annualIncome.minor !== income.minor || profile.annualIncome.currency !== income.currency
      || profile.occupationClass !== Number(loadings['occupationClass'] ?? 1) || !matchesList(loadings['conditions'], profile.conditions)
      || !matchesList(loadings['pursuits'], profile.pursuits) || !matchesList(loadings['familyHistory'], profile.familyHistory)) {
      throw new PartnerPortalError('the signed risk or underwriting terms changed; the quotation and underwriting file do not match. Start a new journey and obtain a new signed quotation');
    }
    const stages: JourneyStageId[] = ['identity', 'profile', 'needs', 'recommendation', 'coverage', 'loadings', 'riders', 'funds', 'beneficiaries', 'quotation', 'finalisation'];
    return fingerprintOf({
      scope: c.distribution, application: { id: app.id, partyId: app.partyId, productId: app.productId, sumAssured: app.sumAssured, profile: app.profile },
      stages: Object.fromEntries(stages.map((s) => [s, c.answers[s]])),
      quote: { id: quote.quotationId, version: quote.version, signature: quote.finalisation.signatureReference, pdf: quote.pdf.fingerprint },
    });
  }

  current(caseId: string): PartnerApplication | undefined { return [...this.applications].reverse().find((a) => a.caseId === caseId); }
  application(id: string): PartnerApplication {
    const row = this.applications.find((a) => a.id === id);
    if (!row) throw new PartnerPortalError('unknown partner application');
    return row;
  }
  submit(w: World, input: { caseId: string; by: string; at: string }): PartnerApplication {
    const c = w.journey.get(input.caseId);
    if (!c.distribution) throw new PartnerPortalError('attribute this journey to a partner first');
    this.scope(w, c.distribution, true);
    const prior = this.current(c.caseId);
    if (prior && (prior.status === 'pending' || prior.status === 'approved')) throw new PartnerPortalError('return the current application before submitting a revision');
    if (c.artefacts.routeId || c.artefacts.policyId) throw new PartnerPortalError('an already routed or issued case cannot be submitted');
    const progress = w.journey.progress(w, c.caseId);
    if (!progress.stages.find((s) => s.id === 'finalisation')?.complete) throw new PartnerPortalError('complete customer review and sign-off before submitting for partner approval');
    const fingerprint = this.signedFingerprint(w, c);
    const app = w.underwriting.application(c.artefacts.applicationId!);
    if (!w.underwriting.isHeldForPartnerApproval(app.id) || app.decision) throw new PartnerPortalError('the application must not be underwritten before partner approval');
    const quote = w.journey.quotations.get(c.artefacts.quotationId!);
    const row: PartnerApplication = {
      id: this.id('PAPP'), caseId: c.caseId, scope: { ...c.distribution }, applicationId: app.id,
      quotationId: quote.quotationId, quotationVersion: quote.version, fingerprint,
      submittedBy: text(input.by, 'submitter'), submittedAt: input.at, status: 'pending', review: null, route: null, underwritingReview: null, revisedQuotation: null,
    };
    this.applications.push(row);
    this.audit(input.at, input.by, 'application-submitted', row.id, row.scope, `Signed quotation ${quote.quotationId} v${quote.version}; application ${app.id}.`);
    return row;
  }

  decide(w: World, input: { id: string; by: string; role: PartnerReviewer; outcome: 'approved' | 'returned' | 'rejected'; note: string; at: string }): PartnerApplication {
    const row = this.application(input.id);
    if (this.current(row.caseId) !== row || row.status !== 'pending') throw new PartnerPortalError('only the current pending application can be reviewed');
    if (row.submittedBy === input.by) throw new PartnerPortalError('the submitter cannot approve or review their own application');
    if (!(['supervisor', 'manager', 'senior-manager'] as string[]).includes(input.role)) throw new PartnerPortalError('a supervisor, manager or senior manager must review the application');
    const note = text(input.note, 'review note', 8);
    const c = w.journey.get(row.caseId);
    const review = { by: input.by, role: input.role, at: input.at, outcome: input.outcome, note };
    if (input.outcome === 'approved') {
      this.scope(w, row.scope, true);
      if (this.signedFingerprint(w, c, row) !== row.fingerprint) throw new PartnerPortalError('the signed application changed; return and submit it again');
      if (!w.underwriting.isHeldForPartnerApproval(row.applicationId)) throw new PartnerPortalError('the application is not held for partner approval');
      // Approval is recorded before releasing the underwriting hold. On a route error the hold and
      // pending state are restored; an unsuccessful review must never release underwriting.
      row.review = review;
      row.status = 'approved';
      w.underwriting.releasePartnerHold(row.applicationId);
      try {
        const route = w.journey.context(w, c).routing;
        if (!route) throw new PartnerPortalError('the underwriting rules cannot route this application');
        row.route = { route: route.route, automatic: route.automatic, assignedTo: route.assignedTo, reasons: [...route.reasons] };
        if (route.automatic) {
          const decision = w.underwriting.decide(row.applicationId, { at: input.at, by: 'partner-routing-rules', isAi: true });
          c.answers['uw-review'] = { questionnaireReviewed: true, questionnaireUpdatedBy: 'partner-routing-rules', questionnaireNotes: 'Automatic assessment after partner approval.', decisionOutcome: decision.outcome, decidedBy: decision.decidedBy, decidedByAi: true };
          // An automatic route has no outstanding evidence; complete the empty medical section only now.
          if (!c.submitted.includes('medical')) c.submitted.push('medical');
          if (!c.submitted.includes('uw-review')) c.submitted.push('uw-review');
        }
      } catch (error) {
        row.review = null; row.status = 'pending'; row.route = null;
        w.underwriting.restorePartnerHold(row.applicationId);
        throw error;
      }
    } else {
      row.review = review;
      row.status = input.outcome;
    }
    this.audit(input.at, input.by, `application-${input.outcome}`, row.id, row.scope, row.route ? `${input.role}: ${note} Routed to ${row.route.route}.` : `${input.role}: ${note}`);
    return row;
  }

  /** Return an approved case for amendment, preserving the original decision and route on the log. */
  returnApproved(w: World, input: { id: string; by: string; note: string; at: string }): PartnerApplication {
    const row = this.application(input.id);
    if (this.current(row.caseId) !== row || row.status !== 'approved') throw new PartnerPortalError('only the current approved case can be returned for amendment');
    const c = w.journey.get(row.caseId);
    if (c.artefacts.paymentId || c.artefacts.routeId || c.artefacts.policyId || w.underwriting.application(row.applicationId).decision) throw new PartnerPortalError('an underwritten, paid, routed or issued case cannot be returned here; contact the insurer for cancellation or correction');
    // Validate the audit reason before changing status so a refused request cannot mutate the case.
    const reason = text(input.note, 'reason', 8);
    w.underwriting.restorePartnerHold(row.applicationId);
    row.status = 'returned';
    this.audit(input.at, input.by, 'application-returned-for-amendment', row.id, row.scope, reason);
    return row;
  }

  /** Human underwriting review follows partner approval. It is not an automated decline or issuance. */
  underwritingReview(w: World, input: { id: string; by: string; note: string; at: string; termsReconciled: boolean }): PartnerApplication {
    const row = this.application(input.id);
    const c = w.journey.get(row.caseId);
    if (row.status !== 'approved' || !row.route || row.route.automatic) throw new PartnerPortalError('this case is not awaiting a manual underwriting review');
    if (row.submittedBy === input.by || row.review?.by === input.by) throw new PartnerPortalError('manual underwriting must be reviewed independently of the partner submission and approval');
    if (this.signedFingerprint(w, c, row) !== row.fingerprint) throw new PartnerPortalError('the signed application changed; return and resubmit it');
    const decision = w.underwriting.application(row.applicationId).decision;
    if (!decision || decision.decidedByAi || decision.decidedBy !== input.by || ['referred', 'declined', 'postponed'].includes(decision.outcome)) throw new PartnerPortalError('the same independent underwriter must record a current human decision accepting the risk');
    const note = text(input.note, 'underwriting review note', 8);
    if (input.termsReconciled !== true) throw new PartnerPortalError('the underwriter must confirm all final terms are represented in the decision and quotation; unsupported conditions require insurer resolution');
    // Evidence review can remove an initial outstanding-evidence route and reveal a senior or
    // reinsurance route. Keep human review mandatory, and retain the reroute in the audit trail.
    const route = w.journey.context(w, c).routing;
    if (!route) throw new PartnerPortalError('the post-evidence underwriting route cannot be determined');
    if (route.route !== row.route.route || route.automatic !== row.route.automatic) {
      const previous = row.route.route;
      row.route = { route: route.route, automatic: false, assignedTo: route.automatic ? input.by : route.assignedTo, reasons: [...route.reasons] };
      this.audit(input.at, input.by, 'underwriting-rerouted', row.id, row.scope, `Post-evidence route ${previous} → ${route.route}; human review remains required.`);
    }
    row.underwritingReview = { by: input.by, at: input.at, note, decisionFingerprint: fingerprintOf(decision), termsReconciled: true };
    this.audit(input.at, input.by, 'underwriting-reviewed', row.id, row.scope, `Human underwriting review recorded: ${row.underwritingReview.note}`);
    return row;
  }

  /** An insurer can prepare a new final offer when underwriting changes the indication. */
  reissueQuotation(w: World, input: { id: string; by: string; at: string }): PartnerApplication {
    const row = this.application(input.id);
    const c = w.journey.get(row.caseId);
    const blocker = this.underwritingApprovalBlocker(w, c);
    if (blocker) throw new PartnerPortalError(blocker);
    if (c.artefacts.paymentId || c.artefacts.routeId || c.artefacts.policyId) throw new PartnerPortalError('a paid, routed or issued case cannot be re-quoted here');
    const decision = w.underwriting.application(row.applicationId).decision;
    if (!decision || ['referred', 'declined', 'postponed'].includes(decision.outcome)) throw new PartnerPortalError('an accepting underwriting decision is required before a revised quotation');
    if (!row.route?.automatic && (!row.underwritingReview || !row.underwritingReview.termsReconciled || row.underwritingReview.decisionFingerprint !== fingerprintOf(decision))) throw new PartnerPortalError('a current independent insurer underwriting review is required before a revised quotation');
    const issued = w.journey.issueRevisedPartnerQuote(w, c.caseId, input.by, input.at);
    row.revisedQuotation = { ...issued, decisionFingerprint: fingerprintOf(decision), issuedBy: text(input.by, 'issuer'), issuedAt: input.at };
    this.audit(input.at, input.by, 'revised-quotation-issued', row.id, row.scope, `Revised quotation ${issued.quotationId} v${issued.version} requires new customer acceptance.`);
    return row;
  }

  /** Record a fresh signature against the revised document; the original remains unchanged. */
  acceptRevisedQuotation(w: World, input: { id: string; signedBy: string; by: string; at: string; reviewedWithCustomer: boolean }): PartnerApplication {
    const row = this.application(input.id);
    const c = w.journey.get(row.caseId);
    const blocker = this.underwritingApprovalBlocker(w, c);
    if (blocker) throw new PartnerPortalError(blocker);
    if (c.artefacts.paymentId || c.artefacts.routeId || c.artefacts.policyId) throw new PartnerPortalError('a paid, routed or issued case cannot accept a revised quotation here');
    const revised = row.revisedQuotation;
    const decision = w.underwriting.application(row.applicationId).decision;
    if (!revised || !decision || revised.decisionFingerprint !== fingerprintOf(decision)) throw new PartnerPortalError('a current revised quotation is required');
    if (input.reviewedWithCustomer !== true) throw new PartnerPortalError('confirm the revised quotation was reviewed with the customer before recording acceptance');
    const original = w.journey.quotations.get(row.quotationId, row.quotationVersion);
    const signedBy = text(input.signedBy, 'customer signature');
    if (signedBy !== original.finalisation?.signedBy) throw new PartnerPortalError('the revised quotation must be accepted by the same customer who signed the original');
    const quote = w.journey.quotations.get(revised.quotationId, revised.version);
    if (!quote.email || quote.status !== 'dispatched' || !quote.facts.requiresFreshAcceptance) throw new PartnerPortalError('the current revised quotation must be prepared for the customer before acceptance');
    const acceptance = w.journey.quotations.finalise({ quotationId: revised.quotationId, version: revised.version, signedBy, at: input.at });
    c.artefacts = { ...c.artefacts, quotationId: revised.quotationId, quotationVersion: revised.version, buyToken: acceptance.buyToken };
    this.audit(input.at, input.by, 'revised-quotation-accepted', row.id, row.scope, `Customer ${signedBy} accepted revised quotation ${revised.quotationId} v${revised.version}.`);
    return row;
  }

  /** Partner review must be current before any human underwriting can be started. */
  underwritingApprovalBlocker(w: World, c: JourneyCase): string | null {
    if (!c.distribution) return null;
    const row = this.current(c.caseId);
    if (!row || row.status !== 'approved' || !row.route) return 'Partner supervisor, manager or senior manager approval is required before underwriting';
    try {
      if (!scopeEquals(row.scope, c.distribution) || this.signedFingerprint(w, c, row) !== row.fingerprint) return 'The signed application changed; return it for a new partner approval';
    } catch { return 'The partner scope or signed quotation is no longer valid; return it for a new approval'; }
    return null;
  }

  /** Called by both the journey gate and the direct conversion path. */
  gate(w: World, c: JourneyCase, route?: RoutingDecision | null, requireUnderwriter = false): string | null {
    if (!c.distribution) return null;
    const row = this.current(c.caseId);
    if (!row || row.status !== 'approved' || !row.route) return 'Partner supervisor, manager or senior manager approval is required before underwriting routing';
    try {
      this.scope(w, c.distribution, true);
      if (!scopeEquals(row.scope, c.distribution) || this.signedFingerprint(w, c, row) !== row.fingerprint) return 'The signed application changed; return it for a new partner approval';
    } catch { return 'The partner scope or signed quotation is no longer valid; return it for a new approval'; }
    if (route && (route.route !== row.route.route || (route.automatic !== row.route.automatic && !(route.automatic && !row.route.automatic)))) return 'The underwriting route changed; obtain a current insurer review before payment or conversion';
    const decision = w.underwriting.application(row.applicationId).decision;
    if (!decision || ['referred', 'declined', 'postponed'].includes(decision.outcome)) return 'An accepting underwriting decision is required before payment or conversion';
    let quote = w.journey.quotations.get(row.quotationId, row.quotationVersion);
    if (row.revisedQuotation) {
      const revised = row.revisedQuotation;
      if (revised.decisionFingerprint !== fingerprintOf(decision)) return 'The underwriting decision changed; issue and accept a new revised quotation';
      quote = w.journey.quotations.get(revised.quotationId, revised.version);
      if (quote.status !== 'finalised' || !quote.finalisation?.signatureReference || c.artefacts.quotationId !== revised.quotationId) return 'The customer must accept the revised quotation before payment or conversion';
    }
    const sameMoney = (a: { minor: bigint; currency: string }, b: { minor: bigint; currency: string }) => a.minor === b.minor && a.currency === b.currency;
    const sameExclusions = JSON.stringify([...quote.facts.exclusions].sort()) === JSON.stringify([...decision.exclusions].sort());
    if (decision.applicationId !== row.applicationId || decision.productId !== quote.facts.product.productId || decision.partyId !== quote.facts.customer.partyId || !sameMoney(quote.facts.sumAssured, decision.sumAssured)
      || !sameMoney(quote.facts.standardPremium, decision.standardPremium) || !sameMoney(quote.facts.loadedPremium, decision.loadedPremium)
      || quote.facts.underwriting.extraMortalityBps !== decision.extraMortalityBps
      || (!quote.facts.conditional && quote.facts.underwriting.outcome !== decision.outcome) || !sameExclusions) {
      return 'Underwriting changed the quoted terms: a new quotation and fresh customer acceptance are required before payment or conversion';
    }
    if (!row.route.automatic && (!row.underwritingReview || !row.underwritingReview.termsReconciled || row.underwritingReview.decisionFingerprint !== fingerprintOf(decision))) {
      return 'A current independent insurer underwriting review is required before payment or conversion';
    }
    void requireUnderwriter;
    return null;
  }

  /** Application answers are locked while a review is pending or approved. */
  assertEditable(c: JourneyCase, stage: JourneyStageId): void {
    const row = this.current(c.caseId);
    const protectedStages: JourneyStageId[] = ['identity', 'profile', 'needs', 'recommendation', 'coverage', 'loadings', 'riders', 'medical', 'funds', 'beneficiaries', 'uw-review', 'quotation', 'finalisation'];
    const manualUnderwriting = (stage === 'medical' || stage === 'uw-review') && row?.status === 'approved' && row.route && !row.route.automatic && !c.submitted.includes(stage);
    if (c.distribution && (stage === 'medical' || stage === 'uw-review') && !manualUnderwriting) throw new PartnerPortalError('medical and underwriting review require an approved manual insurer route');
    if (row && (row.status === 'pending' || row.status === 'approved') && protectedStages.includes(stage) && !manualUnderwriting) {
      throw new PartnerPortalError('return the partner application before editing the signed application');
    }
    if (!c.distribution) return;
    // The legacy desk does not replace an existing application when coverage is re-submitted.
    // Avoid inconsistent risk / quote facts rather than silently treating the old file as updated.
    const applicationBasis: JourneyStageId[] = ['identity', 'profile', 'needs', 'recommendation', 'coverage'];
    if (c.artefacts.applicationId && c.submitted.includes(stage) && applicationBasis.includes(stage)) {
      throw new PartnerPortalError('this application basis cannot be revised here after the underwriting file is created; start a new journey');
    }
    if (c.artefacts.quotationId && c.submitted.includes('quotation') && protectedStages.includes(stage) && !manualUnderwriting
      && (stage !== 'finalisation' || c.submitted.includes('finalisation'))) {
      throw new PartnerPortalError('a quoted partner application cannot be amended here; start a new journey and obtain a new signed quotation');
    }
  }

  private policyCase(w: World, scope: PartnerScope, policyId: string): JourneyCase {
    const c = w.journey.list().find((j) => j.artefacts.policyId === policyId && j.distribution && scopeEquals(j.distribution, scope));
    if (!c) throw new PartnerPortalError('policy is not attributed to this partner and sub-channel');
    return c;
  }
  commission(id: string): CommissionEntry {
    const row = this.commissions.find((c) => c.id === id);
    if (!row) throw new PartnerPortalError('unknown commission accrual');
    return row;
  }
  accrue(w: World, input: { scope: PartnerScope; policyId: string; period: string; sourceRef: string; premium: string; policyYear: number; by: string; at: string }): CommissionEntry {
    const scope = this.scope(w, input.scope);
    const c = this.policyCase(w, scope, input.policyId);
    const app = w.underwriting.application(c.artefacts.applicationId!);
    const partner = w.erp.channels.partner(scope.partnerId)!;
    const ref = text(input.sourceRef, 'accrual source reference');
    if (this.commissions.some((r) => r.scope.partnerId === scope.partnerId && r.sourceRef === ref)) throw new PartnerPortalError('this accrual source reference is already recorded for the partner');
    if (!Number.isInteger(input.policyYear) || input.policyYear < 1 || input.policyYear > 100) throw new PartnerPortalError('policy year must be between 1 and 100');
    const premiumMinor = amount(input.premium, partner.currency);
    if (premiumMinor <= 0n) throw new PartnerPortalError('premium basis must be positive');
    const expected = w.erp.channels.commissionFor({ partnerId: partner.partnerId, productId: app.productId, premium: money(premiumMinor, partner.currency), policyYear: input.policyYear, subChannelCode: scope.subChannelCode });
    const row: CommissionEntry = {
      id: this.id('COM'), scope, policyId: c.artefacts.policyId!, productId: app.productId, period: period(input.period), sourceRef: ref,
      currency: partner.currency, premiumMinor: String(premiumMinor), expectedMinor: String(expected.commission.minor), bps: expected.bps, basis: expected.basis,
      createdBy: input.by, createdAt: input.at, statements: [], status: 'awaiting-statement', review: null, disbursements: [],
    };
    this.commissions.push(row);
    this.audit(input.at, input.by, 'commission-accrual-recorded', row.id, scope, `${ref}: ${formatAmount(expected.commission)} expected; externally supplied premium basis.`);
    return row;
  }
  statement(input: { id: string; reference: string; amount: string; by: string; at: string }): CommissionEntry {
    const row = this.commission(input.id);
    if (row.status === 'approved') throw new PartnerPortalError('an approved statement cannot be replaced');
    const reference = text(input.reference, 'statement reference');
    if (this.commissions.some((c) => c.scope.partnerId === row.scope.partnerId && c.statements.some((s) => s.reference === reference))) throw new PartnerPortalError('statement reference already used for this partner');
    const minor = amount(input.amount, row.currency);
    row.statements.push({ reference, amountMinor: String(minor), by: input.by, at: input.at });
    row.status = 'awaiting-review'; row.review = null;
    this.audit(input.at, input.by, 'commission-statement-recorded', row.id, row.scope, `Statement ${reference}: ${formatAmount(money(minor, row.currency))}.`);
    return row;
  }
  reviewCommission(input: { id: string; outcome: 'approved' | 'disputed'; note: string; by: string; at: string }): CommissionEntry {
    const row = this.commission(input.id);
    const last = row.statements.at(-1);
    if (!last || row.status !== 'awaiting-review') throw new PartnerPortalError('a current statement awaiting review is required');
    if (input.by === last.by || input.by === row.createdBy) throw new PartnerPortalError('the accrual or statement author cannot review their own reconciliation');
    if (input.outcome === 'approved' && last.amountMinor !== row.expectedMinor) throw new PartnerPortalError('commission differs from the statement; dispute the difference before approval');
    row.review = { by: input.by, at: input.at, note: text(input.note, 'review note', 8), outcome: input.outcome };
    row.status = input.outcome;
    this.audit(input.at, input.by, `commission-${input.outcome}`, row.id, row.scope, row.review.note);
    return row;
  }
  disbursement(input: { id: string; reference: string; amount: string; by: string; at: string }): CommissionEntry {
    const row = this.commission(input.id);
    if (row.status !== 'approved') throw new PartnerPortalError('commission reconciliation must be approved before recording an external settlement');
    const reference = text(input.reference, 'external settlement reference');
    if (this.commissions.some((c) => c.disbursements.some((d) => d.reference === reference))) throw new PartnerPortalError('external settlement reference is already recorded');
    const minor = amount(input.amount, row.currency);
    const paid = row.disbursements.reduce((n, d) => n + BigInt(d.amountMinor), 0n);
    if (minor <= 0n || paid + minor > BigInt(row.expectedMinor)) throw new PartnerPortalError('settlement must be positive and no more than the approved outstanding amount');
    row.disbursements.push({ reference, amountMinor: String(minor), by: input.by, at: input.at });
    this.audit(input.at, input.by, 'external-disbursement-recorded', row.id, row.scope, `Reference ${reference}; ${formatAmount(money(minor, row.currency))}. No payment was sent.`);
    return row;
  }

  request(id: string): ServiceRequest {
    const row = this.requests.find((r) => r.id === id);
    if (!row) throw new PartnerPortalError('unknown service request');
    return row;
  }
  openRequest(w: World, input: { scope: PartnerScope; kind: ServiceKind; policyId?: string; subject: string; message: string; by: string; at: string }): ServiceRequest {
    const scope = this.scope(w, input.scope);
    if (!SERVICE_KINDS.includes(input.kind)) throw new PartnerPortalError('unknown service request type');
    const policyId = input.policyId?.trim() || null;
    if (['policy-information', 'financial-endorsement', 'non-financial-endorsement', 'claim', 'claim-settlement'].includes(input.kind) && !policyId) throw new PartnerPortalError('a policy is required for this request');
    if (policyId) this.policyCase(w, scope, policyId);
    const row: ServiceRequest = { id: this.id('PSR'), scope, kind: input.kind, policyId, subject: text(input.subject, 'subject', 4), openedBy: input.by, openedAt: input.at, status: 'open', messages: [{ by: input.by, at: input.at, from: 'partner', text: text(input.message, 'message', 8) }] };
    this.requests.push(row);
    this.audit(input.at, input.by, 'service-request-opened', row.id, scope, `${row.kind}: ${row.subject}`);
    return row;
  }
  reply(input: { id: string; by: string; at: string; from: 'partner' | 'insurer'; message: string; close?: boolean }): ServiceRequest {
    const row = this.request(input.id);
    if (row.status === 'closed') throw new PartnerPortalError('a closed request cannot be changed');
    if (input.close && input.from !== 'insurer') throw new PartnerPortalError('only the insurer may close a service request');
    row.messages.push({ by: input.by, at: input.at, from: input.from, text: text(input.message, 'message', 8) });
    row.status = input.close ? 'closed' : input.from === 'insurer' ? 'in-review' : row.status;
    this.audit(input.at, input.by, input.close ? 'service-request-closed' : 'service-message', row.id, row.scope, `${input.from} replied.`);
    return row;
  }

  /** Caller supplies the scope predicate derived from authentication, never from a UI role selector. */
  workspace(w: World, partnerId: string, allowed: (scope: PartnerScope) => boolean, offset: number, limit: number) {
    const belongs = (s: PartnerScope) => s.partnerId === partnerId && allowed(s);
    const applications = this.applications.filter((r) => belongs(r.scope));
    const commissions = this.commissions.filter((r) => belongs(r.scope));
    const requests = this.requests.filter((r) => belongs(r.scope));
    const cases = w.journey.list().filter((c) => c.distribution && belongs(c.distribution));
    const sums = new Map<string, { accrued: bigint; stated: bigint; approved: bigint; paid: bigint }>();
    for (const c of commissions) {
      const totals = sums.get(c.currency) ?? { accrued: 0n, stated: 0n, approved: 0n, paid: 0n };
      totals.accrued += BigInt(c.expectedMinor);
      totals.stated += BigInt(c.statements.at(-1)?.amountMinor ?? '0');
      if (c.status === 'approved') totals.approved += BigInt(c.expectedMinor);
      totals.paid += c.disbursements.reduce((n, d) => n + BigInt(d.amountMinor), 0n);
      sums.set(c.currency, totals);
    }
    const page = <T>(rows: T[]) => ({ total: rows.length, offset, limit, items: rows.slice().reverse().slice(offset, offset + limit) });
    return {
      partnerId,
      summary: {
        journeys: cases.length,
        issuedPolicies: cases.filter((c) => Boolean(c.artefacts.policyId)).length,
        submittedApplications: applications.length,
        pendingApplications: applications.filter((a) => a.status === 'pending').length,
        approvedApplications: applications.filter((a) => a.status === 'approved').length,
        awaitingCommission: commissions.filter((c) => c.status === 'awaiting-review').length,
        openRequests: requests.filter((r) => r.status !== 'closed').length,
        closedRequests: requests.filter((r) => r.status === 'closed').length,
        requestsByType: SERVICE_KINDS.map((kind) => ({ kind, count: requests.filter((r) => r.kind === kind).length })).filter((r) => r.count > 0),
      },
      cases: page(cases.map((c) => ({ caseId: c.caseId, customerName: c.customerName, scope: c.distribution!, status: c.status, quotationId: c.artefacts.quotationId ?? null, applicationId: c.artefacts.applicationId ?? null, policyId: c.artefacts.policyId ?? null, partnerApplication: this.current(c.caseId)?.status ?? 'not submitted' }))),
      applications: page(applications), commissions: page(commissions.map((c) => ({ ...c, expected: formatAmount(money(BigInt(c.expectedMinor), c.currency)), statement: c.statements.length ? formatAmount(money(BigInt(c.statements.at(-1)!.amountMinor), c.currency)) : null, difference: c.statements.length ? formatAmount(money(BigInt(c.statements.at(-1)!.amountMinor) - BigInt(c.expectedMinor), c.currency)) : null, disbursed: formatAmount(money(c.disbursements.reduce((n, d) => n + BigInt(d.amountMinor), 0n), c.currency)) }))),
      requests: page(requests), audit: page(this.trail.filter((e) => belongs(e.scope))),
      reports: [...sums.entries()].map(([currency, n]) => ({ currency, accrued: formatAmount(money(n.accrued, currency)), stated: formatAmount(money(n.stated, currency)), approved: formatAmount(money(n.approved, currency)), disbursed: formatAmount(money(n.paid, currency)), outstanding: formatAmount(money(n.approved - n.paid, currency)) })),
      limitation: 'Demo records only: no external payment, policy change or claim settlement is performed. Records are lost on restart.',
    };
  }
}
