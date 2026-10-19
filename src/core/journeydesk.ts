/**
 * The journey desk: the side effects behind the lifecycle sections.
 *
 * `journey.ts` decides whether a section is complete; this module is what happens when an operator
 * presses submit on one. Every stage runs real engine code rather than writing a flag — the customer
 * is created in the party registry, the proposal is registered with the underwriting engine, the
 * questionnaire amendments are recorded against the file, the quotation is written as a PDF and
 * dispatched, the payment is captured and reconciled, the binding route is decided (with capacity
 * hired in or the reinsurer asked when it must be), the policy is converted with its signed
 * allocation, and the in-force sections measure drift against what the customer signed.
 *
 * A section that is not 100% complete is refused here as well as in the console: the gate lives in
 * the core, so the API and the screen cannot disagree about what "done" means.
 */
import type { World } from './demo.js';
import { Money, formatAmount, money, parseAmount } from './money.js';
import { unitsToDecimal } from './units.js';
import { DecisionOutcome, OccupationClass, ProductRules, CONDITION_RULES, FAMILY_HISTORY_RULES, PURSUIT_RULES } from './underwriting.js';
import { AE_PACK, PACKS, RegulatoryPack } from './regulatory.js';
import { productVariety } from './products.js';
import { NeedsAnswer, ProductCandidate, evaluateNeeds, questionnaireFor } from './needs.js';
import { FundOption, RiskGrade, allocationProgress } from './allocation.js';
import { OCCUPATION_LABELS, RIDER_CATALOGUE, RiderSelection, loadingBreakdown, medicalRequirements } from './loadings.js';
import { PAYMENT_METHODS, PaymentBook, PaymentMethod } from './payments.js';
import { DEFAULT_VALIDITY_DAYS, QuotationBook, QuotationChargeLine, QuotationFacts } from './quotation.js';
import {
  DEFAULT_ROUTING_LIMITS, FREELANCE_PANEL, RoutingDecision, RoutingLimits, UnderwritingDesk,
  UnderwritingQueue, routeUnderwriting,
} from './uwroute.js';
import {
  Answers, JOURNEY_STAGES, JourneyArtefacts, JourneyCase, JourneyContext, JourneyProgress,
  JourneyStageId, JourneyStatus, JourneyFieldSettings, emptyAnswers, fieldLabel, journeyProgress, stageSpec,
} from './journey.js';

export class JourneyDeskError extends Error {}

export interface SubmitResult {
  readonly caseId: string;
  readonly stageId: JourneyStageId;
  readonly accepted: boolean;
  readonly reason: string;
  readonly artefacts: JourneyArtefacts;
  readonly progress: JourneyProgress;
  readonly detail: Record<string, unknown>;
}

/** How busy the in-house desk is, and what it promises the customer. Both are operating data. */
export const IN_HOUSE_QUEUE: UnderwritingQueue = {
  inHouseOpenCases: 9,
  inHouseCapacityPerDay: 6,
  oldestCaseHours: 4,
  promisedDecisionHours: 24,
  workingHoursPerDay: 8,
};

/**
 * What each product is *for*, in the vocabulary the questionnaire uses. Line decides first — a group
 * medical product must never be recommended as an individual's family protection — and the category
 * adds the investment or takaful objectives on top.
 */
export function objectivesFor(line: string, category: string): readonly string[] {
  // The objectives are the questionnaire's own vocabulary: a product answers one or more of them, and
  // the recommendation ranks it on that. Every line in the catalogue maps onto them, so widening the
  // catalogue cannot leave a product that silently matches nothing.
  switch (line) {
    case 'medical': return ['health-cover'];
    case 'motor': return ['debt-cover'];
    case 'travel': return ['health-cover', 'family-protection'];
    case 'group': return ['business-continuity', 'family-protection'];
    case 'critical-illness': return ['income-replacement', 'health-cover', 'family-protection'];
    case 'income-protection': return ['income-replacement', 'debt-cover', 'family-protection'];
    case 'endowment': return ['retirement-savings', 'education-funding', 'family-protection'];
    case 'mortgage': return ['debt-cover', 'family-protection'];
    case 'personal-accident': return ['income-replacement', 'family-protection'];
    case 'home': return ['family-protection', 'debt-cover'];
    case 'property': case 'liability': case 'engineering': case 'general': return ['business-continuity'];
    case 'marine': case 'hull': return ['business-continuity', 'debt-cover'];
    default: break;
  }
  switch (category) {
    case 'unit-linked': return ['family-protection', 'retirement-savings', 'education-funding', 'income-replacement'];
    case 'takaful': return ['family-protection', 'retirement-savings', 'education-funding'];
    default: return ['family-protection', 'income-replacement', 'debt-cover'];
  }
}

/**
 * Validate a display name coming from master settings. Wording that reaches a customer-facing form is
 * filed data: it is trimmed, it is bounded, and it carries no markup, because a label is read aloud by
 * a screen reader and printed on a schedule. An empty or absent label means "use the default".
 */
export function normaliseFieldLabel(value: unknown, stageId: string, fieldId: string, currentLabel: string): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'string') throw new JourneyDeskError(`the label for ${stageId}.${fieldId} must be text`);
  const text = value.replace(/\s+/g, ' ').trim();
  if (text === '') return undefined;
  if (text.length > 80) throw new JourneyDeskError(`the label for ${stageId}.${fieldId} must be 80 characters or fewer (${text.length} given)`);
  if (/[<>{}]/.test(text)) throw new JourneyDeskError(`the label for ${stageId}.${fieldId} cannot contain markup characters (<, >, {, })`);
  if (text === currentLabel) return undefined;
  return text;
}

/** A formatted money label back into money, without assuming the currency suffix is there. */
export function parseLabel(label: string, currency: string): Money {
  const cleaned = label.replace(currency, '').trim();
  return parseAmount(cleaned === '' ? '0' : cleaned, currency);
}

/** Grade a fund from its published composition: how much of it behaves like equity. */
export function gradeFund(w: World, fundId: string): RiskGrade {
  const fund = w.nav.listFunds().find((f) => f.id === fundId);
  if (!fund || fund.composition.length === 0) return 'balanced';
  let equityBps = 0;
  let total = 0;
  for (const c of fund.composition) {
    const instrument = w.nav.instrument(c.instrumentId);
    total += c.weightBps;
    if (instrument.assetClass === 'equity' || instrument.assetClass === 'commodity') equityBps += c.weightBps;
  }
  const share = total === 0 ? 0 : equityBps / total;
  return share >= 0.7 ? 'growth' : share >= 0.35 ? 'balanced' : 'cautious';
}

/** The catalogue the recommendation stage ranks: master data joined with the underwriting rules. */
export function productCatalogue(w: World): Array<ProductCandidate & { rules: ProductRules }> {
  return w.erp.listProductMasters().map((p) => {
    const rules = p.rules;
    const grades = p.defaultFunds.map((f) => gradeFund(w, f));
    const top: RiskGrade = grades.includes('growth') ? 'growth' : grades.includes('balanced') ? 'balanced' : 'cautious';
    return {
      productId: p.productId,
      name: p.name,
      line: rules.line,
      category: p.category,
      entityId: p.entityId,
      currency: p.currency,
      minAge: rules.minAge,
      maxAge: rules.maxAge,
      baseRatePerThousandMinor: rules.baseRatePerThousandMinor,
      defaultFunds: p.defaultFunds,
      objectives: objectivesFor(rules.line, p.category),
      investmentLinked: p.category === 'unit-linked' || p.defaultFunds.length > 0,
      shariahCompliant: p.category === 'takaful',
      minimumRiskAppetite: p.category === 'unit-linked' ? top : 'cautious',
      rules,
    };
  });
}

/** The funds the allocation stage may offer, at their latest published valuation. */
export function fundOptions(w: World): FundOption[] {
  return w.nav.listFunds().map((f) => {
    const v = w.nav.latestValuation(f.id);
    return {
      fundId: f.id,
      name: f.name,
      currency: f.currency,
      shariahScreened: f.shariahScreened,
      riskGrade: gradeFund(w, f.id),
      navPerUnit: v ? unitsToDecimal(v.pricePerUnit.micro) : '0',
      price: v?.pricePerUnit,
      navDate: v?.valuationDate ?? w.asOf,
      fmcBpsAnnual: f.fmcBpsAnnual,
    };
  });
}

export class JourneyDesk {
  private readonly cases = new Map<string, JourneyCase>();
  private seq = 0;
  private readonly fieldSettings: Record<string, Record<string, { mandatory: boolean; editable: boolean; label?: string }>> = Object.fromEntries(
    JOURNEY_STAGES.map((stage) => [stage.id, Object.fromEntries(stage.fields.map((field) => [field.id, { mandatory: field.mandatory, editable: field.editable }]))]),
  );
  /** Who renamed which field, from what to what. A label is user-facing wording, so it is audited. */
  private readonly fieldRenames: Array<{ at: string; by: string; stageId: string; stageTitle: string; fieldId: string; from: string; to: string }> = [];

  constructor(
    readonly quotations: QuotationBook,
    readonly payments: PaymentBook,
    readonly underwritingDesk: UnderwritingDesk,
  ) {}

  /* ------------------------------------------------------------------ case handling */

  list(): JourneyCase[] { return [...this.cases.values()]; }

  getFieldSettings(): JourneyFieldSettings {
    return Object.fromEntries(Object.entries(this.fieldSettings).map(([stage, fields]) => [stage, Object.fromEntries(Object.entries(fields).map(([id, value]) => [id, { ...value }]))]));
  }

  /** The renames on file, newest last: what a compliance reviewer asks for when a form reads oddly. */
  renameAudit(): ReadonlyArray<{ at: string; by: string; stageId: string; stageTitle: string; fieldId: string; from: string; to: string }> {
    return this.fieldRenames;
  }

  /**
   * Save the field rules for the journey: mandatory, editable, and the label each field is shown with.
   *
   * A label is validated like the filed data it is: short wording, no markup, never a blank that would
   * leave a form field with no name. The change is written to the rename audit with the actor and the
   * time. An empty label is not an error — it means "go back to the default", which is how a tenant
   * undoes a rename without anyone having to remember what the default was.
   */
  updateFieldSettings(input: unknown, meta: { by?: string; at?: string } = {}): JourneyFieldSettings {
    if (!input || typeof input !== 'object' || Array.isArray(input)) throw new JourneyDeskError('field settings must be a stage-to-field object');
    const by = meta.by?.trim() || 'master-settings';
    const at = meta.at?.trim() || new Date().toISOString();
    const next = input as Record<string, unknown>;
    for (const [stageId, rawFields] of Object.entries(next)) {
      const stage = JOURNEY_STAGES.find((candidate) => candidate.id === stageId);
      if (!stage || !rawFields || typeof rawFields !== 'object' || Array.isArray(rawFields)) throw new JourneyDeskError(`unknown journey stage settings: ${stageId}`);
      for (const [fieldId, raw] of Object.entries(rawFields as Record<string, unknown>)) {
        const field = stage.fields.find((candidate) => candidate.id === fieldId);
        if (!field || !raw || typeof raw !== 'object' || Array.isArray(raw)) throw new JourneyDeskError(`unknown field setting: ${stageId}.${fieldId}`);
        const setting = raw as Record<string, unknown>;
        if (typeof setting['mandatory'] !== 'boolean' || typeof setting['editable'] !== 'boolean') throw new JourneyDeskError(`mandatory and editable must be boolean for ${stageId}.${fieldId}`);
        const prior = this.fieldSettings[stageId]![fieldId]!;
        const shownAs = fieldLabel(stageId, field, this.getFieldSettings());
        if (field.kind === 'readonly' && setting['editable']) throw new JourneyDeskError(`${shownAs} is a calculated read-only field`);
        const label = normaliseFieldLabel(setting['label'], stageId, fieldId, field.label);
        if (label !== (prior.label ?? field.label)) {
          this.fieldRenames.push({ at, by, stageId, stageTitle: stage.title, fieldId, from: prior.label ?? field.label, to: label ?? field.label });
        }
        this.fieldSettings[stageId]![fieldId] = { mandatory: setting['mandatory'], editable: setting['editable'], ...(label ? { label } : {}) };
      }
    }
    return this.getFieldSettings();
  }

  private assertEditable(stageId: JourneyStageId, incoming: Record<string, unknown>, existing: Record<string, unknown>): void {
    const stage = stageSpec(stageId);
    for (const field of stage.fields) {
      const setting = this.fieldSettings[stageId]?.[field.id];
      if (setting?.editable === false && Object.prototype.hasOwnProperty.call(incoming, field.id) && JSON.stringify(incoming[field.id]) !== JSON.stringify(existing[field.id])) {
        throw new JourneyDeskError(`${fieldLabel(stageId, field, this.getFieldSettings())} is locked by master settings`);
      }
    }
  }

  get(caseId: string): JourneyCase {
    const c = this.cases.get(caseId);
    if (!c) throw new JourneyDeskError(`unknown journey case ${caseId}`);
    return c;
  }

  open(w: World, input: { customerName?: string; country?: string; currency?: string; by?: string; at?: string } = {}): JourneyCase {
    const at = input.at ?? `${w.asOf}T09:00:00+04:00`;
    const by = input.by?.trim() || 'customer-onboarding-desk';
    const caze: JourneyCase = {
      caseId: `JNY-${String(++this.seq).padStart(6, '0')}`,
      openedAt: at,
      openedBy: by,
      customerName: input.customerName?.trim() || 'New customer',
      currency: input.currency ?? 'AED',
      country: (input.country ?? 'AE').toUpperCase(),
      status: 'draft',
      answers: emptyAnswers(),
      submitted: [],
      artefacts: {},
      log: [{ at, by, stageId: 'identity', action: 'saved', detail: 'Journey opened: every section starts closed and the first one opens itself.', completeAfter: false }],
      computed: {},
    };
    this.cases.set(caze.caseId, caze);
    return caze;
  }

  abandon(w: World, input: { caseId: string; by: string; at?: string; reason: string }): JourneyCase {
    const c = this.get(input.caseId);
    if (input.reason.trim().length < 24) throw new JourneyDeskError('abandoning a journey needs a reason of at least 24 characters');
    c.status = 'abandoned';
    c.log.push({ at: input.at ?? `${w.asOf}T17:00:00+04:00`, by: input.by, stageId: 'identity', action: 'abandoned', detail: input.reason.trim(), completeAfter: false });
    return c;
  }

  /* ------------------------------------------------------------------ context from the engines */

  context(w: World, caze: JourneyCase): JourneyContext {
    const pack: RegulatoryPack = PACKS[caze.country] ?? AE_PACK;
    const products = productCatalogue(w);
    const chosen = products.find((p) => p.productId === String(caze.answers['recommendation']?.['productId'] ?? ''));
    const rules = chosen?.rules ?? products[0]?.rules ?? w.underwriting.rulesFor('PROD-LIFE-TERM');
    const limits: RoutingLimits = {
      currency: caze.currency,
      aiStraightThroughMinor: rules.aiStraightThroughMinor,
      automaticBindingLimitMinor: rules.automaticBindingLimitMinor,
      facultativeThresholdMinor: rules.facultativeThresholdMinor,
      ...DEFAULT_ROUTING_LIMITS,
    };

    const applicationId = caze.artefacts.applicationId;
    const app = applicationId ? w.underwriting.list().find((a) => a.id === applicationId) ?? null : null;
    const assessment = app ? app.decision ?? w.underwriting.assess(app.id) : null;
    const decision = app?.decision ?? null;

    const medicalSet = app ? medicalRequirements({
      age: app.profile.age,
      sumAssured: app.sumAssured,
      rules: w.underwriting.rulesFor(app.productId),
      conditions: app.profile.conditions,
      pursuits: app.profile.pursuits,
      occupationClass: app.profile.occupationClass,
      riders: list(caze.answers['riders']?.['riders']),
      results: resultsFromAnswers(caze.answers['medical']?.['results']),
    }) : null;

    const quotationRecord = caze.artefacts.quotationId
      ? this.quotations.versions(caze.artefacts.quotationId).at(-1) ?? null
      : null;
    const due = quotationRecord ? quotationRecord.facts.totalPayable : money(0n, caze.currency);
    const payment = quotationRecord ? this.payments.reconcile(quotationRecord.quotationId, due) : null;

    const routing: RoutingDecision | null = assessment ? routeUnderwriting({
      sumAssured: assessment.sumAssured,
      outcome: decision?.outcome ?? assessment.outcome,
      extraMortalityBps: assessment.extraMortalityBps,
      referrals: assessment.referrals,
      outstandingMedical: medicalSet?.outstanding.length ?? 0,
      occupationClass: app?.profile.occupationClass ?? 1,
      limits,
      queue: IN_HOUSE_QUEUE,
      shariahProduct: chosen?.category === 'takaful',
      language: caze.country === 'AE' ? 'ar' : undefined,
      caseReference: caze.caseId,
      at: `${w.asOf}T09:00:00+04:00`,
    }) : null;

    const erpSnapshot = w.erp.snapshot(w);
    const policyId = caze.artefacts.policyId;
    const erpPolicy = policyId ? erpSnapshot.policies.find((p) => p.policyId === policyId) ?? null : null;
    const policy = erpPolicy
      ? {
        policyId: erpPolicy.policyId,
        status: erpPolicy.status,
        commencement: erpPolicy.commencement,
        contributionsToDate: parseLabel(erpPolicy.totalPremiumPaid, erpPolicy.currency),
        currentValue: parseLabel(erpPolicy.fundValue ?? erpPolicy.totalPremiumPaid, erpPolicy.currency),
        holdings: erpPolicy.fundHoldings.map((h) => ({
          fundId: h.fundId, fundName: h.fundName, units: h.units, price: h.price,
          value: parseLabel(h.value, erpPolicy.currency), priceAsOf: h.priceAsOf,
        })),
        targetWeights: erpPolicy.targetWeights.map((t) => ({ fundId: t.fundId, weightBps: t.weightBps })),
      }
      : null;

    return {
      fieldSettings: this.getFieldSettings(),
      asOf: w.asOf,
      currency: caze.currency,
      tenantName: w.tenant.name,
      pack: `${pack.country} ${pack.version}`,
      packCountry: pack.country,
      coolingOffDays: pack.illustration.coolingOffDays,
      illustrationWording: pack.illustration.wording,
      products,
      funds: fundOptions(w),
      limits,
      queue: IN_HOUSE_QUEUE,
      offers: w.quotes,
      application: assessment ? {
        sumAssured: assessment.sumAssured,
        standardPremium: assessment.standardPremium,
        loadedPremium: assessment.loadedPremium,
        extraMortalityBps: assessment.extraMortalityBps,
        outcome: assessment.outcome,
        referrals: assessment.referrals,
        exclusions: assessment.exclusions,
        evidence: assessment.evidence,
        decidedBy: assessment.decidedBy,
        decidedByAi: assessment.decidedByAi,
      } : null,
      decision: decision ? {
        outcome: decision.outcome, decidedBy: decision.decidedBy, decidedByAi: decision.decidedByAi,
        extraMortalityBps: decision.extraMortalityBps, loadedPremium: decision.loadedPremium,
      } : null,
      routing,
      payment,
      quotation: quotationRecord ? {
        quotationId: quotationRecord.quotationId,
        version: quotationRecord.version,
        status: quotationRecord.status,
        totalPayable: quotationRecord.facts.totalPayable,
        expiresAt: quotationRecord.expiresAt,
        dispatched: Boolean(quotationRecord.email),
        finalised: quotationRecord.status === 'finalised',
        blockers: quotationRecord.blockers,
      } : null,
      policy,
      servicing: policyId ? {
        alterations: erpSnapshot.alterations.filter((a) => a.policyId === policyId).length,
        openClaims: [...w.claims.list(), ...w.takafulClaims.list()].filter((cl) => cl.policyId === policyId && cl.status !== 'settled').length,
        settledClaims: [...w.claims.list(), ...w.takafulClaims.list()].filter((cl) => cl.policyId === policyId && cl.status === 'settled').length,
      } : null,
    };
  }

  /** The whole journey as the console renders it, with every gate evaluated in order. */
  progress(w: World, caseId: string): JourneyProgress {
    const caze = this.get(caseId);
    return journeyProgress(caze, this.context(w, caze));
  }

  /* ------------------------------------------------------------------ saving and submitting */

  save(w: World, input: { caseId: string; stageId: JourneyStageId; answers: Answers; by?: string; at?: string }): JourneyProgress {
    const caze = this.get(input.caseId);
    const at = input.at ?? `${w.asOf}T10:00:00+04:00`;
    this.assertEditable(input.stageId, input.answers, caze.answers[input.stageId]);
    caze.answers[input.stageId] = { ...caze.answers[input.stageId], ...input.answers };
    if (input.stageId === 'identity' && String(input.answers['nameEn'] ?? '').trim()) {
      caze.customerName = String(input.answers['nameEn']).trim();
      caze.country = String(input.answers['country'] ?? caze.country).toUpperCase();
    }
    caze.log.push({ at, by: input.by?.trim() || 'operator', stageId: input.stageId, action: 'saved', detail: `Draft saved for ${stageSpec(input.stageId).shortTitle}`, completeAfter: false });
    if (caze.status === 'draft') caze.status = 'in-progress';
    return this.progress(w, caze.caseId);
  }

  /** Commit a section: run the gate, then the engine, then report the new position in the journey. */
  submit(w: World, input: { caseId: string; stageId: JourneyStageId; answers?: Answers; by?: string; at?: string }): SubmitResult {
    const caze = this.get(input.caseId);
    const stageId = input.stageId;
    const at = input.at ?? `${w.asOf}T11:00:00+04:00`;
    const by = input.by?.trim() || 'operator';
    if (input.answers) {
      this.assertEditable(stageId, input.answers, caze.answers[stageId]);
      caze.answers[stageId] = { ...caze.answers[stageId], ...input.answers };
    }

    // A full pass first: every gate is evaluated in order, so the values later sections read (the
    // loading breakdown, the allocation plan, the beneficiary set) exist before anything is written.
    const before = journeyProgress(caze, this.context(w, caze), { ignoreSubmittedFor: stageId });
    const gate = before.stages.find((s) => s.id === stageId);
    if (!gate) throw new JourneyDeskError(`unknown journey stage ${stageId}`);
    if (gate.status === 'locked') {
      const reason = `Section ${gate.order} (${gate.shortTitle}) is locked until "${gate.lockedByTitle}" is 100% complete`;
      caze.log.push({ at, by, stageId, action: 'refused', detail: reason, completeAfter: false });
      return { caseId: caze.caseId, stageId, accepted: false, reason, artefacts: caze.artefacts, progress: before, detail: {} };
    }
    if (!gate.complete) {
      const reason = [
        gate.missing.length > 0 ? `mandatory fields outstanding: ${gate.missing.join('; ')}` : '',
        ...gate.blockers,
      ].filter(Boolean).join(' · ');
      caze.log.push({ at, by, stageId, action: 'refused', detail: reason, completeAfter: false });
      return { caseId: caze.caseId, stageId, accepted: false, reason, artefacts: caze.artefacts, progress: before, detail: {} };
    }

    let detail: Record<string, unknown> = {};
    try {
      detail = this.apply(w, caze, stageId, caze.answers[stageId], by, at);
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      caze.log.push({ at, by, stageId, action: 'refused', detail: reason, completeAfter: false });
      return { caseId: caze.caseId, stageId, accepted: false, reason, artefacts: caze.artefacts, progress: this.progress(w, caze.caseId), detail: {} };
    }

    if (!caze.submitted.includes(stageId)) caze.submitted.push(stageId);
    this.moveStatus(caze);
    const progress = this.progress(w, caze.caseId);
    const after = progress.stages.find((s) => s.id === stageId)!;
    caze.log.push({
      at, by, stageId, action: 'submitted',
      detail: after.complete
        ? `${stageSpec(stageId).shortTitle} complete${progress.nextRecommendedTitle ? ` — next: ${progress.nextRecommendedTitle}` : ''}`
        : `${stageSpec(stageId).shortTitle} submitted at ${after.percent}%`,
      completeAfter: after.complete,
    });
    return {
      caseId: caze.caseId, stageId, accepted: true,
      reason: after.complete
        ? `${stageSpec(stageId).title} is 100% complete${progress.nextRecommendedTitle ? `; the next section to open is "${progress.nextRecommendedTitle}"` : '; every section is complete'}.`
        : `${stageSpec(stageId).title} was submitted but still reports ${after.percent}%: ${[...after.missing, ...after.blockers].join('; ')}`,
      artefacts: caze.artefacts, progress, detail,
    };
  }

  private moveStatus(caze: JourneyCase): void {
    const next: JourneyStatus = caze.artefacts.policyId ? 'servicing'
      : caze.artefacts.paymentId ? 'bound'
      : caze.artefacts.quotationId ? 'quoted'
      : caze.artefacts.applicationId ? 'in-progress'
      : caze.status === 'draft' ? 'in-progress' : caze.status;
    caze.status = next;
  }

  /* ------------------------------------------------------------------ the side effects, section by section */

  private apply(w: World, caze: JourneyCase, stageId: JourneyStageId, answers: Answers, by: string, at: string): Record<string, unknown> {
    switch (stageId) {
      case 'identity': {
        if (caze.artefacts.partyId) {
          const party = w.parties.get(caze.artefacts.partyId);
          return { partyId: caze.artefacts.partyId, customer: party?.names.en ?? caze.artefacts.partyId, note: 'The golden record already exists for this journey; the details were re-checked rather than duplicated.' };
        }
        const created = w.erp.createCustomer(w, {
          kind: String(answers['kind'] ?? 'person') === 'organisation' ? 'organisation' : 'person',
          nameEn: String(answers['nameEn'] ?? ''),
          nameAr: String(answers['nameAr'] ?? '') || undefined,
          dateOfBirth: String(answers['dateOfBirth'] ?? '') || undefined,
          idType: String(answers['idType'] ?? 'emirates-id') as 'emirates-id',
          idValue: String(answers['idNumber'] ?? ''),
          idSource: String(answers['idSource'] ?? 'manual') as 'manual',
          country: String(answers['country'] ?? caze.country),
          phone: String(answers['phone'] ?? '') || undefined,
          email: String(answers['email'] ?? '') || undefined,
          addressLine: String(answers['addressLine'] ?? '') || undefined,
          city: String(answers['city'] ?? '') || undefined,
          roles: ['policyholder', 'life-assured'],
          grantConsentTo: String(answers['consentTo'] ?? '') || undefined,
        });
        caze.artefacts = { ...caze.artefacts, partyId: created.party.id, ...(created.consentId ? { consentId: created.consentId } : {}) };
        caze.customerName = created.party.names.en;
        caze.answers['profile'] = { ...caze.answers['profile'], __duplicateMatches: created.duplicateMatches.length };
        return {
          partyId: created.party.id, customer: created.party.names.en, consentId: created.consentId ?? null,
          duplicateMatches: created.duplicateMatches.map((m) => ({ partyId: m.partyId, score: m.score, reasons: m.reasons })),
        };
      }

      case 'profile': {
        const partyId = caze.artefacts.partyId;
        if (!partyId) throw new JourneyDeskError('there is no golden record to update — submit the onboarding section first');
        const scopes = list(answers['consentScopes']);
        const consent = w.parties.grantConsent({
          partyId,
          grantedTo: String(caze.answers['identity']?.['consentTo'] ?? 'DXB-BROKER-01'),
          purpose: 'Needs analysis, quotation, policy issuance and servicing',
          scopes: scopes.length > 0 ? scopes : ['customer.exists', 'customer.name', 'customer.contact'],
          grantedAt: at,
          expiresAt: '2027-12-31T23:59:59+04:00',
          evidence: `journey-${caze.caseId}`,
        });
        caze.artefacts = { ...caze.artefacts, consentId: consent.id };
        return {
          consentId: consent.id, scopes: [...consent.scopes], purpose: consent.purpose,
          taxResidence: String(answers['taxResidence'] ?? ''), taxId: String(answers['taxId'] ?? ''),
          dataResidency: String(answers['dataResidency'] ?? ''),
          duplicates: Number(caze.answers['profile']?.['__duplicateMatches'] ?? 0),
        };
      }

      case 'needs': {
        const needId = caze.artefacts.needId ?? `NA-${caze.caseId}`;
        const evaluation = evaluateNeeds({
          needId,
          country: String(answers['country'] ?? caze.country),
          answers: (Array.isArray(answers['answers']) ? answers['answers'] : []) as NeedsAnswer[],
          attestationAgreed: answers['attestationAgreed'] === true,
        });
        caze.artefacts = { ...caze.artefacts, needId };
        caze.country = evaluation.country;
        caze.computed.__needsEvaluation = evaluation;
        return {
          needId, pack: evaluation.pack, percent: evaluation.percent,
          questions: questionnaireFor(evaluation.country).questions.length,
          riskAppetite: evaluation.riskAppetite, objective: evaluation.objective,
          shariahPreferred: evaluation.shariahPreferred,
          suggestedSumAssured: evaluation.need.suggestedSumAssured ? formatAmount(evaluation.need.suggestedSumAssured) : null,
          affordabilityCeiling: evaluation.need.affordabilityCeiling ? formatAmount(evaluation.need.affordabilityCeiling) : null,
          basis: evaluation.need.basis,
          preSale: evaluation.regulatory,
        };
      }

      case 'recommendation': {
        const productId = String(answers['productId'] ?? '');
        const product = productCatalogue(w).find((p) => p.productId === productId);
        if (!product) throw new JourneyDeskError(`unknown product ${productId}`);
        caze.answers['coverage'] = {
          ...caze.answers['coverage'],
          residenceCountry: String(caze.answers['identity']?.['country'] ?? caze.country),
        };
        return {
          productId, productName: product.name, category: product.category, entityId: product.entityId,
          comparisonPresented: answers['alternativesPresented'] === true,
          customerAccepted: answers['customerAccepted'] === true,
          note: String(answers['recommendationNote'] ?? ''),
        };
      }

      case 'coverage': {
        if (caze.artefacts.applicationId) {
          const existing = w.underwriting.assess(caze.artefacts.applicationId);
          return {
            applicationId: existing.applicationId, sumAssured: formatAmount(existing.sumAssured),
            standardPremium: formatAmount(existing.standardPremium), loadedPremium: formatAmount(existing.loadedPremium),
            outcome: existing.outcome, note: 'The underwriting application already exists for this journey; the coverage details were re-checked against it.',
          };
        }
        const product = productCatalogue(w).find((p) => p.productId === String(caze.answers['recommendation']?.['productId'] ?? ''));
        if (!product) throw new JourneyDeskError('no product chosen — complete the recommendation section first');
        const created = w.erp.createProposal(w, {
          partyId: caze.artefacts.partyId ?? 'PTY-0001',
          productId: product.productId,
          sumAssured: String(answers['sumAssured'] ?? '0'),
          paymentFrequency: String(answers['paymentFrequency'] ?? 'annual') as 'annual',
          termYears: Number(answers['termYears'] ?? 20),
          beneficiaryName: 'To be designated',
          beneficiaryRelationship: 'family',
          targetFunds: [...product.defaultFunds],
          age: Number(answers['age'] ?? 35),
          sex: answers['sex'] === 'female' ? 'female' : 'male',
          smoker: answers['smoker'] === true,
          heightCm: Number(answers['heightCm'] ?? 175),
          weightKg: Number(answers['weightKg'] ?? 75),
          occupationClass: Number(caze.answers['loadings']?.['occupationClass'] ?? 1) as OccupationClass,
          pursuits: list(caze.answers['loadings']?.['pursuits']),
          conditions: list(caze.answers['loadings']?.['conditions']),
          familyHistory: list(caze.answers['loadings']?.['familyHistory']),
          residenceCountry: String(answers['residenceCountry'] ?? caze.country),
          annualIncome: String(answers['annualIncome'] ?? '0'),
          at,
        });
        caze.artefacts = { ...caze.artefacts, applicationId: created.applicationId };
        return {
          applicationId: created.applicationId, sumAssured: created.sumAssured,
          standardPremium: created.standardPremium, loadedPremium: created.loadedPremium,
          extraMortalityBps: created.extraMortalityBps, outcome: created.outcome,
          referrals: created.referrals, evidence: created.evidence, exclusions: created.exclusions,
          reinsurance: created.reinsurance,
        };
      }

      case 'loadings': {
        const product = productCatalogue(w).find((p) => p.productId === String(caze.answers['recommendation']?.['productId'] ?? ''));
        if (!product) throw new JourneyDeskError('no product chosen');
        const breakdown = caze.computed.__loadingBreakdown;
        if (!breakdown) throw new JourneyDeskError('the loading breakdown could not be computed from the coverage on file');
        if (breakdown.reconciliation.agrees === false) throw new JourneyDeskError(breakdown.reconciliation.detail);

        // The questionnaire answers belong on the underwriting file, and an amendment is recorded.
        let amended: Record<string, unknown> | null = null;
        if (caze.artefacts.applicationId) {
          const result = w.underwriting.amendProfile(caze.artefacts.applicationId, {
            at, by: String(answers['loadingReviewedBy'] ?? by),
            reason: `Occupational and medical loading review in journey ${caze.caseId}: ${String(answers['occupationTitle'] ?? '').trim() || 'occupation and medical answers confirmed'}`,
            patch: {
              occupationClass: Number(answers['occupationClass'] ?? 1) as OccupationClass,
              conditions: list(answers['conditions']),
              pursuits: list(answers['pursuits']),
              familyHistory: list(answers['familyHistory']),
            },
          });
          amended = {
            amendments: result.amendments.map((a) => ({ field: a.field, from: a.from, to: a.to, by: a.by, at: a.at })),
            decisionSetAside: result.decisionSetAside,
            reassessedOutcome: result.reassessment.outcome,
            reassessedExtraBps: result.reassessment.extraMortalityBps,
          };
        }
        return {
          standardPremium: formatAmount(breakdown.standardPremium),
          components: breakdown.components.map((c) => ({ label: c.label, bps: c.extraMortalityBps, amount: formatAmount(c.amount), source: c.source, referToHuman: c.referToHuman })),
          loadedPremium: formatAmount(breakdown.loadedPremium),
          totalExtraBps: breakdown.totalExtraBps,
          exclusions: breakdown.exclusions,
          evidenceRequired: breakdown.evidenceRequired,
          reconciliation: breakdown.reconciliation.detail,
          fileAmendment: amended,
        };
      }

      case 'riders': {
        const selections = riderSelections(answers, at);
        const pricing = caze.computed.__riderPricing;
        caze.computed.__riderSelections = selections;
        return {
          riders: selections.map((s) => s.code),
          withoutLoading: selections.filter((s) => s.loadingWaived).map((s) => ({ code: s.code, by: s.loadingWaived?.by ?? '', reason: s.loadingWaived?.reason ?? '' })),
          riderPremium: pricing ? formatAmount(pricing.totalRiderPremium) : null,
          waivedLoadingValue: pricing ? formatAmount(pricing.waivedLoadingValue) : null,
          evidenceRequired: pricing ? pricing.evidenceRequired : [],
          lines: pricing ? pricing.lines.map((l) => ({ name: l.name, bps: l.appliedBps, amount: formatAmount(l.amount), waived: l.waived })) : [],
        };
      }

      case 'medical': {
        const set = caze.computed.__medicalRequirements;
        if (!set) throw new JourneyDeskError('the medical requirements could not be determined for this risk');
        return {
          requirements: set.requirements.map((r) => ({ label: r.label, status: r.status, source: r.source, reason: r.reason, waiver: r.waiver ?? null })),
          outstanding: set.outstanding.length,
          percent: set.percent,
          reviewedBy: String(answers['reviewedBy'] ?? ''),
          reviewNote: String(answers['reviewNote'] ?? ''),
        };
      }

      case 'funds': {
        const plan = caze.computed.__allocationPlan;
        if (!plan) throw new JourneyDeskError('the allocation has not been built — choose funds and weights first');
        return {
          weights: plan.lines.map((l) => ({ fundId: l.fundId, weightBps: l.weightBps })),
          investable: plan.investableLabel,
          lines: plan.lines.map((l) => ({ fund: l.name, weightPct: l.weightPct, amount: l.amountLabel, units: l.units, nav: l.navPerUnit, navDate: l.navDate })),
          weightedChargeBps: plan.weightedChargeBps,
          weightedRiskScore: plan.weightedRiskScore,
          acknowledgements: plan.acknowledgementsRequired,
        };
      }

      case 'beneficiaries': {
        const set = caze.computed.__beneficiaries;
        if (!set) throw new JourneyDeskError('there is no beneficiary designation to record');
        if (caze.artefacts.policyId) {
          const primary = set.primaries[0];
          w.erp.alterPolicyNonFinancial(w, {
            policyId: caze.artefacts.policyId, kind: 'beneficiary-change',
            beneficiaryName: primary?.name ?? caze.customerName,
            beneficiaryRelationship: primary?.relationship ?? 'family',
            beneficiarySharePct: primary?.sharePct ?? 100,
            reason: 'Beneficiary schedule confirmed during the customer journey', by, at,
          });
        }
        return {
          primaries: set.primaries.map((b) => ({ name: b.name, relationship: b.relationship, sharePct: b.sharePct, share: b.shareOfProceeds ? formatAmount(b.shareOfProceeds) : null })),
          contingents: set.contingents.map((b) => ({ name: b.name, sharePct: b.sharePct })),
          primaryTotalPct: set.primaryTotalBps / 100,
        };
      }

      case 'uw-review': {
        if (!caze.artefacts.applicationId) throw new JourneyDeskError('there is no underwriting application to decide');
        const outcome = String(answers['decisionOutcome'] ?? '') as DecisionOutcome;
        const decidedByAi = answers['decidedByAi'] === true;
        const decision = w.underwriting.decide(caze.artefacts.applicationId, {
          at,
          by: String(answers['decidedBy'] ?? by),
          isAi: decidedByAi,
          ...(outcome && outcome !== 'referred' ? { override: outcome } : {}),
          acceptReferralReasonCodes: list(answers['acceptedReferrals']),
        });
        return {
          applicationId: decision.applicationId, outcome: decision.outcome, decidedBy: decision.decidedBy,
          decidedByAi: decision.decidedByAi, extraMortalityBps: decision.extraMortalityBps,
          loadedPremium: formatAmount(decision.loadedPremium), exclusions: decision.exclusions,
          referrals: decision.referrals,
          questionnaireReviewed: answers['questionnaireReviewed'] === true,
          notes: String(answers['questionnaireNotes'] ?? ''),
          reasons: decision.reasons.map((r) => ({ code: r.code, detail: r.detail, source: r.source, referral: r.referral === true })),
        };
      }

      case 'quotation': {
        const facts = this.quotationFacts(w, caze, at, by);
        const issued = this.quotations.issue(facts, caze.artefacts.quotationId ? { quotationId: caze.artefacts.quotationId } : {});
        caze.artefacts = { ...caze.artefacts, quotationId: issued.record.quotationId, quotationVersion: issued.record.version };
        if (issued.refused) throw new JourneyDeskError(issued.reason);
        let email: Record<string, unknown> | null = null;
        if (answers['sendEmail'] === true) {
          const dispatch = this.quotations.dispatch({
            quotationId: issued.record.quotationId,
            to: String(answers['emailTo'] ?? facts.customer.email),
            language: String(answers['emailLanguage'] ?? 'both') as 'en' | 'ar' | 'both',
            consentId: caze.artefacts.consentId,
            at, by,
            buyLink: `https://portal.example/buy/${issued.record.quotationId}?token=${issued.record.quotationId}`,
          });
          caze.artefacts = { ...caze.artefacts, emailMessageId: dispatch.messageId };
          email = {
            messageId: dispatch.messageId, to: dispatch.to, subject: dispatch.subject,
            attachment: dispatch.attachment, dispatchedAt: dispatch.dispatchedAt, language: dispatch.language,
          };
        }
        return {
          quotationId: issued.record.quotationId, version: issued.record.version, status: issued.record.status,
          totalPayable: issued.record.totalPayable, expiresAt: issued.record.expiresAt,
          pdf: issued.record.pdf.fileName === '—' ? null : {
            fileName: issued.record.pdf.fileName, bytes: issued.record.pdf.bytes,
            pages: issued.record.pdf.pages, fingerprint: issued.record.pdf.fingerprint, opens: issued.record.pdf.opens,
          },
          compliance: issued.record.compliance.map((c) => ({ label: c.label, passes: c.passes, hard: c.hard, detail: c.detail })),
          email,
        };
      }

      case 'finalisation': {
        if (!caze.artefacts.quotationId) throw new JourneyDeskError('there is no quotation for the customer to accept');
        const finalisation = this.quotations.finalise({
          quotationId: caze.artefacts.quotationId,
          signedBy: String(answers['signedBy'] ?? caze.customerName),
          at: `${String(answers['signedAt'] ?? at.slice(0, 10))}T12:00:00+04:00`,
        });
        caze.artefacts = { ...caze.artefacts, buyToken: finalisation.buyToken };
        return {
          signedBy: finalisation.signedBy, signatureReference: finalisation.signatureReference,
          signedAt: finalisation.signedAt, coolingOffEndsOn: finalisation.coolingOffEndsOn,
          coolingOffStatement: finalisation.coolingOffStatement,
          buyToken: finalisation.buyToken, daysRemainingInValidity: finalisation.daysRemaining,
          readyToBuyOnline: finalisation.readyToBuyOnline,
        };
      }

      case 'payment': {
        if (!caze.artefacts.quotationId) throw new JourneyDeskError('there is no quotation to pay against');
        const record = this.quotations.get(caze.artefacts.quotationId);
        const due = record.facts.totalPayable;
        const amountRaw = String(answers['amount'] ?? '').trim();
        const amount = amountRaw === '' ? due : parseAmount(amountRaw.replace(due.currency, '').trim(), caze.currency);
        const method = String(answers['method'] ?? 'cash') as PaymentMethod;
        const captured = this.payments.capture({
          reference: record.quotationId,
          partyId: caze.artefacts.partyId ?? 'PTY-0001',
          customerName: caze.customerName,
          amount,
          method,
          at, by,
          currency: caze.currency,
          pan: answers['pan'] ? String(answers['pan']) : undefined,
          expiry: answers['expiry'] ? String(answers['expiry']) : undefined,
          cardholder: caze.customerName,
          authentication: answers['authentication'] ? String(answers['authentication']) as 'sca-3ds' : undefined,
          iban: answers['iban'] ? String(answers['iban']) : undefined,
          bankName: answers['bankName'] ? String(answers['bankName']) : undefined,
          depositSlip: answers['depositSlip'] ? String(answers['depositSlip']) : undefined,
          branch: answers['branch'] ? String(answers['branch']) : undefined,
          bnplProvider: answers['bnplProvider'] ? String(answers['bnplProvider']) : undefined,
          bnplInstalments: answers['bnplInstalments'] ? Number(answers['bnplInstalments']) : undefined,
          shariahProduct: record.facts.product.category === 'takaful',
          amountDue: due,
          idempotencyKey: `${caze.caseId}|${record.quotationId}|${method}|${amount.minor}`,
        });
        caze.artefacts = { ...caze.artefacts, paymentId: captured.id };
        return {
          paymentId: captured.id, method: captured.methodLabel, amount: captured.amountLabel,
          fee: captured.feeLabel, netToInsurer: captured.netLabel, status: captured.status,
          settlesOn: captured.settlesOn, proof: captured.proof, card: captured.card, bank: captured.bank,
          branch: captured.branch,
          bnpl: captured.bnpl ? { provider: captured.bnpl.provider, instalments: captured.bnpl.instalments, disclosure: captured.bnpl.disclosure, schedule: captured.bnpl.schedule.map((s) => ({ number: s.number, dueDate: s.dueDate, amount: formatAmount(s.amount), status: s.status })) } : null,
          reconciliation: captured.reconciliation,
        };
      }

      case 'routing': {
        const ctx = this.context(w, caze);
        const routing = ctx.routing;
        if (!routing) throw new JourneyDeskError('the case has not been assessed, so there is nothing to route');
        let engagement: Record<string, unknown> | null = null;
        if (routing.freelance && answers['engageFreelance'] === true) {
          const engaged = this.underwritingDesk.engageFreelance({
            caseReference: caze.caseId, offer: routing.freelance, at, by: String(answers['freelanceAcceptedBy'] ?? by),
          });
          caze.artefacts = { ...caze.artefacts, engagementId: engaged.engagementId };
          engagement = {
            engagementId: engaged.engagementId, underwriter: engaged.name, specialty: engaged.specialty,
            cost: engaged.costLabel, expectedDecisionAt: engaged.expectedDecisionAt, authority: engaged.authorityNote,
          };
        }
        let assist: Record<string, unknown> | null = null;
        if (routing.reinsuranceAssist && answers['reinsuranceAssist'] === true) {
          const treatyId = String(answers['treatyId'] ?? '').trim();
          const request = this.underwritingDesk.requestReinsuranceAssist({
            caseReference: caze.caseId,
            sumAssured: ctx.application?.sumAssured ?? money(0n, caze.currency),
            treatyId: treatyId || undefined,
            cessionBps: 2500,
            at, by,
          });
          caze.artefacts = { ...caze.artefacts, reinsuranceRequestId: request.requestId };
          const answer = String(answers['reinsuranceAnswer'] ?? 'awaiting');
          if (answer === 'awaiting') {
            assist = { requestId: request.requestId, status: request.status, answer: null, questions: request.questions };
          } else {
            const answered = this.underwritingDesk.answerReinsuranceAssist({
              requestId: request.requestId, at, byReinsurer: 'reinsurance-underwriter',
              decision: answer as 'accept' | 'accept-with-conditions' | 'decline',
              conditions: answer === 'accept-with-conditions' ? ['Special acceptance terms recorded on the facultative slip'] : [],
            });
            let treatyNote = 'no treaty supplied; the assist request stands as the record';
            if (treatyId && answered.answer?.decision !== 'decline' && caze.artefacts.applicationId) {
              try {
                w.reinsurance.acceptFacultative(treatyId, caze.artefacts.applicationId, { at, by: 'reinsurance-underwriter' });
                treatyNote = `risk accepted on treaty ${treatyId}`;
              } catch (error) {
                treatyNote = `treaty ${treatyId} could not be updated: ${error instanceof Error ? error.message : String(error)}`;
              }
            }
            assist = { requestId: answered.requestId, status: answered.status, answer: answered.answer ?? null, treatyNote };
          }
        }
        caze.artefacts = { ...caze.artefacts, routeId: `${caze.caseId}:${routing.route}` };
        return { routing: summariseRouting(routing), engagement, assist, confirmedBy: String(answers['confirmedBy'] ?? by) };
      }

      case 'conversion': {
        if (!caze.artefacts.applicationId) throw new JourneyDeskError('there is no application to convert');
        if (caze.artefacts.policyId) return { policyId: caze.artefacts.policyId, note: 'This journey has already been converted; the policy is in force.' };
        const plan = caze.computed.__allocationPlan;
        const beneficiaries = caze.computed.__beneficiaries;
        const primary = beneficiaries?.primaries[0];
        const recon = caze.artefacts.quotationId
          ? this.payments.reconcile(caze.artefacts.quotationId, this.quotations.get(caze.artefacts.quotationId).facts.totalPayable)
          : null;
        const converted = w.erp.convertProposalToPolicy(w, {
          applicationId: caze.artefacts.applicationId,
          paymentFrequency: String(caze.answers['coverage']?.['paymentFrequency'] ?? 'annual') as 'annual',
          beneficiaryName: primary?.name ?? caze.customerName,
          beneficiaryRelationship: primary?.relationship ?? 'family',
          targetWeights: plan ? plan.lines.map((l) => ({ fundId: l.fundId, weightBps: l.weightBps })) : undefined,
          initialPremium: recon && recon.paid.minor > 0n ? formatAmount(recon.paid).replace(` ${recon.paid.currency}`, '') : undefined,
          initialFundId: String(answers['initialFundId'] ?? plan?.lines[0]?.fundId ?? 'FGLOBAL'),
          by: String(answers['convertedBy'] ?? by),
          at: `${String(answers['commencement'] ?? w.asOf).slice(0, 10)}T11:30:00+04:00`,
        });
        caze.artefacts = {
          ...caze.artefacts, policyId: converted.policy.policyId,
          ...(converted.initialReceipt ? { receiptId: converted.initialReceipt.id } : {}),
        };
        return {
          policyId: converted.policy.policyId, holder: converted.policy.holderName,
          product: converted.policy.productName, category: converted.policy.category,
          sumAssured: formatAmount(converted.policy.sumAssured),
          annualPremium: formatAmount(converted.policy.annualPremium),
          status: converted.policy.status, commencement: converted.policy.commencement,
          receipt: converted.initialReceipt ? {
            id: converted.initialReceipt.id, amount: formatAmount(converted.initialReceipt.amount),
            units: converted.initialReceipt.unitsAllocated, fund: converted.initialReceipt.fundId,
            journals: converted.initialReceipt.journalIds,
          } : null,
        };
      }

      case 'allocation': {
        if (!caze.artefacts.policyId) throw new JourneyDeskError('there is no policy in force to manage');
        const policyId = caze.artefacts.policyId;
        const plan = caze.computed.__allocationPlan;
        if (answers['rebalanceRequested'] === true && plan) {
          const alteration = w.erp.alterPolicyNonFinancial(w, {
            policyId, kind: 'rebalance-weights',
            targetWeights: plan.lines.map((l) => ({ fundId: l.fundId, weightBps: l.weightBps })),
            autoRebalanceMonths: 12,
            reason: String(answers['rebalanceNote'] ?? 'Policyholder asked to be rebalanced back to the signed target weights'),
            by: String(answers['reviewedBy'] ?? by), at,
          });
          return { policyId, alterationId: alteration.id, summary: alteration.summary, before: alteration.before, after: alteration.after };
        }
        return {
          policyId, reviewedOn: String(answers['reviewedAt'] ?? at.slice(0, 10)),
          reviewedBy: String(answers['reviewedBy'] ?? by), note: String(answers['rebalanceNote'] ?? ''),
        };
      }

      case 'investment': {
        if (!caze.artefacts.policyId) throw new JourneyDeskError('there is no policy in force to report on');
        const ctx = this.context(w, caze);
        if (!ctx.policy) throw new JourneyDeskError('the policy has no published valuation yet');
        const report = allocationProgress({
          policyId: ctx.policy.policyId,
          contributionsToDate: ctx.policy.contributionsToDate,
          holdings: ctx.policy.holdings,
          targetWeights: ctx.policy.targetWeights,
          commencement: ctx.policy.commencement,
          asOf: ctx.asOf,
        });
        return {
          policyId: report.policyId, contributions: formatAmount(report.contributionsToDate),
          currentValue: formatAmount(report.currentValue), gainLoss: formatAmount(report.gainLoss),
          gainLossPct: report.gainLossPct, maxDriftBps: report.maxDriftBps,
          withinTolerance: report.withinTolerance, nextReview: report.nextReviewDate,
          monthsInForce: report.monthsInForce,
          holdings: report.holdings.map((h) => ({ fund: h.fundName, target: `${(h.targetBps / 100).toFixed(2)}%`, actual: `${(h.actualBps / 100).toFixed(2)}%`, action: h.action })),
          statementSent: answers['statementSent'] === true,
        };
      }

      case 'servicing': {
        if (!caze.artefacts.policyId) throw new JourneyDeskError('servicing begins when the policy is issued');
        return {
          policyId: caze.artefacts.policyId,
          serviceChannel: String(answers['serviceChannel'] ?? 'portal'),
          handedOverBy: String(answers['handoverBy'] ?? by),
          routes: [
            'Non-financial alterations: beneficiary, contact, name, payment frequency, rebalance weights, status',
            'Financial alterations: sum assured, fund switch, partial withdrawal, surrender, policy charge, portfolio rebalance',
            'Claims: register → triage → reserve → approve or decline → settle → recover',
          ],
        };
      }

      default:
        throw new JourneyDeskError(`stage ${stageId} has no submit action`);
    }
  }

  /* ------------------------------------------------------------------ the quotation, assembled from the journey */

  private quotationFacts(w: World, caze: JourneyCase, at: string, by: string): QuotationFacts {
    const ctx = this.context(w, caze);
    const product = ctx.products.find((p) => p.productId === String(caze.answers['recommendation']?.['productId'] ?? ''));
    if (!product) throw new JourneyDeskError('no product chosen — the quotation cannot be assembled');
    const party = caze.artefacts.partyId ? w.parties.get(caze.artefacts.partyId) : null;
    const identity = caze.answers['identity'];
    const coverage = caze.answers['coverage'];
    const sumAssured = parseAmount(String(coverage?.['sumAssured'] ?? '0'), caze.currency);
    const standardPremium = money((sumAssured.minor * product.baseRatePerThousandMinor) / (1000n * 100n), caze.currency);
    const breakdown = caze.computed.__loadingBreakdown ?? loadingBreakdown({
      standardPremium, rules: product.rules, age: Number(coverage?.['age'] ?? 35),
      smoker: coverage?.['smoker'] === true, bmi: bmiOf(coverage),
      occupationClass: Number(caze.answers['loadings']?.['occupationClass'] ?? 1) as OccupationClass,
      conditions: list(caze.answers['loadings']?.['conditions']),
      pursuits: list(caze.answers['loadings']?.['pursuits']),
      familyHistory: list(caze.answers['loadings']?.['familyHistory']),
      riders: riderSelections(caze.answers['riders'], at),
      shariahProduct: product.category === 'takaful',
    });
    // Riders are quoted on their own lines: the risk loading is what has to reconcile with the
    // underwriting file, and mixing the two would make the quotation disagree with the decision.
    const loadingLines: QuotationChargeLine[] = breakdown.components
      .filter((c) => c.source !== 'rider')
      .map((c) => ({ label: c.label, amount: c.amount, bps: c.extraMortalityBps, basis: c.reason }));
    const riderLines: QuotationChargeLine[] = breakdown.riders
      ? breakdown.riders.lines.map((l) => ({
        label: l.name, amount: l.amount, bps: l.appliedBps, waived: l.waived,
        basis: l.waived
          ? `Attached without loading on the authority of ${l.waiver?.by ?? 'unnamed'}: ${l.waiver?.reason ?? 'no reason recorded'}. The loading given away is worth ${formatAmount(money((breakdown.loadedPremium.minor * BigInt(l.loadingBps)) / 10_000n, caze.currency))}.`
          : `${l.note} ${l.appliedBps} bps on the loaded premium.`,
      }))
      : [];
    const totalPayable = breakdown.totalPayable;
    const frequency = String(coverage?.['paymentFrequency'] ?? 'annual');
    const divisor = frequency === 'monthly' ? 12n : frequency === 'quarterly' ? 4n : frequency === 'semi-annual' ? 2n : 1n;
    const plan = caze.computed.__allocationPlan ?? null;
    const beneficiaries = caze.computed.__beneficiaries ?? null;
    const medical = caze.computed.__medicalRequirements ?? null;
    const evaluation = caze.computed.__needsEvaluation ?? evaluateNeeds({
      needId: caze.artefacts.needId ?? `${caze.caseId}-NEED`, country: caze.country,
      answers: (caze.answers['needs']?.['answers'] ?? []) as NeedsAnswer[],
      attestationAgreed: caze.answers['needs']?.['attestationAgreed'] === true,
    });
    const decision = ctx.decision ?? ctx.application;
    if (!decision) throw new JourneyDeskError('the case has not been assessed — a quotation cannot be issued on an unassessed risk');
    const charges = w.unitLinked.chargeSchedule();

    return {
      tenant: { name: w.tenant.name },
      customer: {
        partyId: caze.artefacts.partyId ?? '—',
        name: party?.names.en ?? caze.customerName,
        nameAr: party?.names.ar,
        idType: String(identity?.['idType'] ?? ''),
        idNumber: String(identity?.['idNumber'] ?? ''),
        email: String(caze.answers['quotation']?.['emailTo'] ?? party?.emails[0] ?? identity?.['email'] ?? ''),
        phone: party?.phones[0] ?? String(identity?.['phone'] ?? ''),
        address: party?.addresses[0]?.line ?? String(identity?.['addressLine'] ?? ''),
        city: party?.addresses[0]?.city ?? String(identity?.['city'] ?? ''),
        country: caze.country,
      },
      product: {
        productId: product.productId, name: product.name, category: product.category,
        entityId: product.entityId, currency: product.currency, shariahCompliant: product.shariahCompliant,
      },
      sumAssured,
      termYears: Number(coverage?.['termYears'] ?? 20),
      paymentFrequency: frequency as QuotationFacts['paymentFrequency'],
      premiumPerFrequency: plan && plan.investable.minor > 0n ? plan.investable : { minor: totalPayable.minor / divisor, currency: totalPayable.currency },
      standardPremium,
      loadingLines,
      loadedPremium: breakdown.loadedPremium,
      riderLines,
      totalPayable,
      exclusions: breakdown.exclusions,
      fundLines: plan ? plan.lines.map((l) => ({ fundId: l.fundId, name: l.name, weightBps: l.weightBps, amount: l.amount, navPerUnit: l.navPerUnit, navDate: l.navDate, units: l.units })) : [],
      beneficiaryLines: beneficiaries
        ? [...beneficiaries.primaries, ...beneficiaries.contingents].map((b) => ({ name: b.name, relationship: b.relationship, shareBps: b.shareBps, kind: b.kind }))
        : [],
      medicalRequirements: medical ? medical.requirements.map((r) => ({ label: r.label, status: r.status, source: r.source })) : [],
      outstandingMedical: medical ? medical.outstanding.map((r) => r.label) : [],
      underwriting: {
        outcome: String(caze.answers['uw-review']?.['decisionOutcome'] ?? decision.outcome),
        decidedBy: decision.decidedBy || String(caze.answers['uw-review']?.['decidedBy'] ?? by),
        decidedByAi: decision.decidedByAi,
        extraMortalityBps: breakdown.totalExtraBps,
        referrals: ctx.application?.referrals ?? [],
      },
      needs: { needId: evaluation.needId, pack: evaluation.pack, completed: evaluation.completed, percent: evaluation.percent },
      illustration: { wording: ctx.illustrationWording, scenariosShown: 3, coolingOffDays: ctx.coolingOffDays },
      comparisonPresented: caze.answers['recommendation']?.['alternativesPresented'] === true,
      consentId: caze.artefacts.consentId,
      issuedAt: at,
      issuedBy: by,
      chargeNotes: [
        `Allocation charge ${(charges.allocationChargeBps / 100).toFixed(2)}% on each contribution invested`,
        `Cost of insurance ${(charges.coiPerMilleMonthly / 100).toFixed(2)} per mille of the sum assured each month`,
        `Policy administration fee ${formatAmount(money(BigInt(charges.adminFeeMonthlyMinor), caze.currency))} each month`,
      ],
    };
  }

  /* ------------------------------------------------------------------ what the console renders */

  snapshot(w: World): JourneySnapshot {
    const pack: RegulatoryPack = PACKS['AE'] ?? AE_PACK;
    const products = productCatalogue(w);
    return {
      asOf: w.asOf,
      currency: 'AED',
      tenant: w.tenant.name,
      pack: `${pack.country} ${pack.version}`,
      coolingOffDays: pack.illustration.coolingOffDays,
      illustrationWording: pack.illustration.wording,
      quotationValidityDays: DEFAULT_VALIDITY_DAYS,
      fieldSettings: this.getFieldSettings(),
      fieldRenames: this.fieldRenames.map((r) => ({ ...r })),
      renamedFieldCount: this.fieldRenames.length,
      stages: JOURNEY_STAGES.map((s) => ({
        id: s.id, order: s.order, title: s.title, shortTitle: s.shortTitle, purpose: s.purpose,
        regulatoryBasis: s.regulatoryBasis, owner: s.owner, detailTab: s.detailTab,
        produces: [...s.produces],
        fields: s.fields.map((fd) => ({
          id: fd.id,
          label: fieldLabel(s.id, fd, this.getFieldSettings()),
          defaultLabel: fd.label,
          renamed: (this.fieldSettings[s.id]?.[fd.id]?.label ?? '') !== '',
          kind: fd.kind,
          mandatory: this.fieldSettings[s.id]?.[fd.id]?.mandatory ?? fd.mandatory,
          editable: this.fieldSettings[s.id]?.[fd.id]?.editable ?? fd.editable,
          options: fd.options ? [...fd.options] : undefined, hint: fd.hint, group: fd.group,
        })),
      })),
      products: products.map((p) => ({
        productId: p.productId, name: p.name, category: p.category, entityId: p.entityId, currency: p.currency,
        // The line and the variety travel with the candidate, so the console can group ninety
        // varieties into the shelves an underwriter actually thinks in.
        line: p.line, variety: productVariety(p.productId)?.variety ?? p.name,
        blurb: productVariety(p.productId)?.blurb ?? '',
        minAge: p.minAge, maxAge: p.maxAge, objectives: [...p.objectives], shariahCompliant: p.shariahCompliant,
        investmentLinked: p.investmentLinked, minimumRiskAppetite: p.minimumRiskAppetite, defaultFunds: [...p.defaultFunds],
        baseRatePerThousand: formatAmount(money(p.baseRatePerThousandMinor, p.currency)),
        incomeMultiple: p.rules.incomeMultiple,
        aiStraightThroughLimit: formatAmount(money(p.rules.aiStraightThroughMinor, p.currency)),
        automaticBindingLimit: formatAmount(money(p.rules.automaticBindingLimitMinor, p.currency)),
        facultativeThreshold: formatAmount(money(p.rules.facultativeThresholdMinor, p.currency)),
      })),
      funds: fundOptions(w),
      riders: RIDER_CATALOGUE.map((r) => ({ ...r, requiresEvidence: [...r.requiresEvidence], objectives: [...r.objectives] })),
      questionnaire: questionnaireFor(pack.country).questions.map((q) => ({ ...q, ...(q.options ? { options: [...q.options] } : {}) })),
      questionnaireAttestation: questionnaireFor(pack.country).attestation,
      paymentMethods: PAYMENT_METHODS.map((m) => ({
        code: m.code, label: m.label, feeBps: m.feeBps, settlementDays: m.settlementDays,
        settlesOnCapture: m.settlesOnCapture, requiresAuthentication: m.requiresAuthentication,
        shariahEligible: m.shariahEligible, supportsInstalments: m.supportsInstalments,
        minAmount: formatAmount(money(m.minAmountMinor, 'AED')), maxAmount: formatAmount(money(m.maxAmountMinor, 'AED')),
        note: m.note,
      })),
      freelancePanel: FREELANCE_PANEL.map((p) => ({
        id: p.id, name: p.name, specialty: p.specialty, maxOccupationClass: p.maxOccupationClass,
        turnaroundHours: p.turnaroundHours, available: p.available, shariahQualified: p.shariahQualified,
        languages: [...p.languages], limit: formatAmount(money(p.limitMinor, 'AED')),
        dayRate: formatAmount(money(p.dayRateMinor, 'AED')),
      })),
      queue: IN_HOUSE_QUEUE,
      occupationLabels: Object.entries(OCCUPATION_LABELS).map(([klass, label]) => ({ class: Number(klass), label: String(label) })),
      manualCodes: {
        conditions: CONDITION_RULES.map((c) => ({ code: c.code, label: c.label, bps: c.extraMortalityBps, evidence: [...(c.evidence ?? [])], referToHuman: c.referToHuman === true })),
        pursuits: PURSUIT_RULES.map((p) => ({ code: p.code, bps: p.extraMortalityBps, ...(p.exclusion ? { exclusion: p.exclusion } : {}) })),
        familyHistory: FAMILY_HISTORY_RULES.map((f) => ({ code: f.code, bps: f.extraMortalityBps })),
      },
      engagements: this.underwritingDesk.engagementsList().map((e) => ({
        engagementId: e.engagementId, caseReference: e.caseReference, underwriter: e.name, specialty: e.specialty,
        cost: e.costLabel, status: e.status, engagedAt: e.engagedAt, expectedDecisionAt: e.expectedDecisionAt,
        report: e.report ? { at: e.report.at, recommendation: e.report.recommendation, notes: e.report.notes } : null,
      })),
      reinsuranceAssists: this.underwritingDesk.assistList().map((a) => ({
        requestId: a.requestId, caseReference: a.caseReference, treatyId: a.treatyId, sumAssured: a.sumAssuredLabel,
        status: a.status, requestedAt: a.requestedAt, questions: [...a.questions],
        answer: a.answer ? { at: a.answer.at, decision: a.answer.decision, conditions: [...a.answer.conditions], byReinsurer: a.answer.byReinsurer } : null,
      })),
      quotations: this.quotations.list().map((q) => ({
        quotationId: q.quotationId, version: q.version, status: q.status, partyId: q.partyId,
        customerName: q.customerName, productName: q.productName, sumAssured: q.sumAssured,
        totalPayable: q.totalPayable, issuedAt: q.issuedAt, expiresAt: q.expiresAt,
        pdf: { fileName: q.pdf.fileName, bytes: q.pdf.bytes, pages: q.pdf.pages, fingerprint: q.pdf.fingerprint, opens: q.pdf.opens },
        email: q.email ? { messageId: q.email.messageId, to: q.email.to, subject: q.email.subject, dispatchedAt: q.email.dispatchedAt, attachment: q.email.attachment } : null,
        finalisation: q.finalisation ? { signedBy: q.finalisation.signedBy, signedAt: q.finalisation.signedAt, buyToken: q.finalisation.buyToken, coolingOffEndsOn: q.finalisation.coolingOffEndsOn } : null,
        compliance: q.compliance.map((c) => ({ label: c.label, passes: c.passes, hard: c.hard, detail: c.detail })),
        blockers: [...q.blockers], warnings: [...q.warnings],
      })),
      payments: this.payments.list().map((p) => ({
        id: p.id, reference: p.reference, customerName: p.customerName, method: p.methodLabel,
        amount: p.amountLabel, fee: p.feeLabel, net: p.netLabel, status: p.status, settlesOn: p.settlesOn,
        at: p.at, by: p.by, proof: [...p.proof], card: p.card, bank: p.bank, branch: p.branch,
        bnpl: p.bnpl ? {
          provider: p.bnpl.provider, instalments: p.bnpl.instalments, firstPayment: formatAmount(p.bnpl.firstPayment),
          providerFee: formatAmount(p.bnpl.providerFee), disclosure: p.bnpl.disclosure,
          schedule: p.bnpl.schedule.map((s) => ({ number: s.number, dueDate: s.dueDate, amount: formatAmount(s.amount), status: s.status })),
        } : null,
        reconciliation: p.reconciliation, note: p.note,
      })),
      cases: this.list().map((c) => {
        const progress = this.progress(w, c.caseId);
        return {
          caseId: c.caseId, customerName: c.customerName, status: c.status, openedAt: c.openedAt,
          openedBy: c.openedBy, country: c.country, currency: c.currency,
          artefacts: { ...c.artefacts },
          log: [...c.log].reverse().map((l) => ({ ...l })),
          progress: serialiseJourneyProgress(progress),
        };
      }),
    };
  }
}

export interface JourneySnapshot {
  asOf: string;
  currency: string;
  tenant: string;
  pack: string;
  coolingOffDays: number;
  illustrationWording: string;
  quotationValidityDays: number;
  stages: Array<Record<string, unknown>>;
  fieldSettings: JourneyFieldSettings;
  /** The rename trail: who changed which field's wording, from what to what, and when. */
  fieldRenames: ReadonlyArray<{ at: string; by: string; stageId: string; stageTitle: string; fieldId: string; from: string; to: string }>;
  renamedFieldCount: number;
  products: Array<Record<string, unknown>>;
  funds: FundOption[];
  riders: Array<Record<string, unknown>>;
  questionnaire: Array<Record<string, unknown>>;
  questionnaireAttestation: string;
  paymentMethods: Array<Record<string, unknown>>;
  freelancePanel: Array<Record<string, unknown>>;
  queue: UnderwritingQueue;
  occupationLabels: Array<{ class: number; label: string }>;
  manualCodes: {
    conditions: Array<{ code: string; label: string; bps: number; evidence: string[]; referToHuman: boolean }>;
    pursuits: Array<{ code: string; bps: number; exclusion?: string }>;
    familyHistory: Array<{ code: string; bps: number }>;
  };
  engagements: Array<Record<string, unknown>>;
  reinsuranceAssists: Array<Record<string, unknown>>;
  quotations: Array<Record<string, unknown>>;
  payments: Array<Record<string, unknown>>;
  cases: Array<{
    caseId: string; customerName: string; status: JourneyStatus; openedAt: string; openedBy: string;
    country: string; currency: string; artefacts: JourneyArtefacts;
    log: Array<Record<string, unknown>>; progress: Record<string, unknown>;
  }>;
}

/* ------------------------------------------------------------------ small helpers */

function list(value: unknown): string[] {
  if (Array.isArray(value)) return value.map((v) => String(v).trim()).filter(Boolean);
  if (typeof value === 'string') return value.split(',').map((s) => s.trim()).filter(Boolean);
  return [];
}

function bmiOf(coverage: Answers | undefined): number | undefined {
  const h = Number(coverage?.['heightCm'] ?? 0);
  const kg = Number(coverage?.['weightKg'] ?? 0);
  if (h <= 0 || kg <= 0) return undefined;
  return Math.round((kg / ((h / 100) ** 2)) * 10) / 10;
}

function riderSelections(answers: Answers | undefined, at: string): RiderSelection[] {
  const codes = list(answers?.['riders']);
  const without = list(answers?.['withoutLoading']);
  return codes.map((code) => (without.includes(code)
    ? { code, loadingWaived: { by: String(answers?.['waiverBy'] ?? ''), at, reason: String(answers?.['waiverReason'] ?? '') } }
    : { code }));
}

function resultsFromAnswers(value: unknown): Array<{ code: string; status: 'ordered' | 'received' | 'reviewed' | 'waived'; at?: string; by?: string; waiverReason?: string }> {
  if (!Array.isArray(value)) return [];
  return value.map((entry) => {
    const row = (typeof entry === 'string' ? { label: entry, status: 'received' } : entry) as Record<string, unknown>;
    const status = String(row['status'] ?? 'ordered');
    return {
      code: String(row['label'] ?? row['code'] ?? ''),
      status: (['ordered', 'received', 'reviewed', 'waived'].includes(status) ? status : 'ordered') as 'ordered' | 'received' | 'reviewed' | 'waived',
      at: row['at'] ? String(row['at']) : undefined,
      by: row['by'] ? String(row['by']) : undefined,
      waiverReason: row['waiverReason'] ? String(row['waiverReason']) : undefined,
    };
  });
}

function summariseRouting(routing: RoutingDecision): Record<string, unknown> {
  return {
    route: routing.route, automatic: routing.automatic, assignedTo: routing.assignedTo, headline: routing.headline,
    reasons: [...routing.reasons], escalations: [...routing.escalations],
    expectedDecisionHours: routing.expectedDecisionHours, promisedDecisionHours: routing.promisedDecisionHours,
    withinPromise: routing.withinPromise, reinsuranceAssist: routing.reinsuranceAssist, cost: routing.costEstimateLabel,
    freelance: routing.freelance ? {
      underwriterId: routing.freelance.underwriterId, name: routing.freelance.name, cost: routing.freelance.costLabel,
      turnaroundHours: routing.freelance.turnaroundHours, authority: routing.freelance.authorityNote,
    } : null,
  };
}

/** The journey progress with money already formatted: ready for JSON and for the console. */
export function serialiseJourneyProgress(progress: JourneyProgress): Record<string, unknown> {
  return {
    caseId: progress.caseId,
    customerName: progress.customerName,
    status: progress.status,
    percent: progress.percent,
    completeStages: progress.completeStages,
    totalStages: progress.totalStages,
    nextRecommended: progress.nextRecommended,
    nextRecommendedTitle: progress.nextRecommendedTitle,
    headline: progress.headline,
    blockers: [...progress.blockers],
    stages: progress.stages.map((s) => ({
      id: s.id, order: s.order, title: s.title, shortTitle: s.shortTitle, purpose: s.purpose,
      regulatoryBasis: s.regulatoryBasis, owner: s.owner, detailTab: s.detailTab,
      status: s.status, percent: s.percent, complete: s.complete, autoOpen: s.autoOpen,
      submitted: s.submitted, lockedBy: s.lockedBy, lockedByTitle: s.lockedByTitle,
      missing: [...s.missing], blockers: [...s.blockers], warnings: [...s.warnings],
      summary: s.summary.map((r) => ({ ...r })), artefacts: [...s.artefacts], produces: [...s.produces],
      fields: s.fields.map((fd) => ({ id: fd.id, label: fd.label, kind: fd.kind, mandatory: fd.mandatory, editable: fd.editable, options: fd.options ? [...fd.options] : undefined, hint: fd.hint, group: fd.group })),
      answers: plainAnswers(s.answers),
    })),
  };
}

/** Strip the computed blobs that carry Money (bigint) out of the payload the console renders. */
function plainAnswers(answers: Answers): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(answers)) {
    if (key.startsWith('__')) continue;
    out[key] = ['evaluation', 'breakdown', 'pricing', 'requirements', 'plan', 'set'].includes(key)
      ? describeComputed(key, value)
      : value;
  }
  return out;
}

function describeComputed(key: string, value: unknown): unknown {
  if (!value || typeof value !== 'object') return null;
  switch (key) {
    case 'evaluation': {
      const v = value as { needId: string; percent: number; completed: boolean; missing: string[]; pack: string; riskAppetite: string | null; objective: string | null; shariahPreferred: boolean; smoker: boolean; medicalConditions: boolean; age: number | null; occupationClass: number | null; need: { suggestedSumAssured: Money | null; affordabilityCeiling: Money | null; incomeReplacement: Money | null; debtCover: Money | null; lessExistingCover: Money | null; replacementYears: number | null; basis: string[] }; blockers: string[]; attestation: { text: string; agreed: boolean } };
      return {
        needId: v.needId, percent: v.percent, completed: v.completed, missing: v.missing, pack: v.pack,
        riskAppetite: v.riskAppetite, objective: v.objective, shariahPreferred: v.shariahPreferred,
        smoker: v.smoker, medicalConditions: v.medicalConditions, age: v.age, occupationClass: v.occupationClass,
        suggestedSumAssured: v.need.suggestedSumAssured ? formatAmount(v.need.suggestedSumAssured) : null,
        affordabilityCeiling: v.need.affordabilityCeiling ? formatAmount(v.need.affordabilityCeiling) : null,
        incomeReplacement: v.need.incomeReplacement ? formatAmount(v.need.incomeReplacement) : null,
        debtCover: v.need.debtCover ? formatAmount(v.need.debtCover) : null,
        lessExistingCover: v.need.lessExistingCover ? formatAmount(v.need.lessExistingCover) : null,
        replacementYears: v.need.replacementYears, basis: v.need.basis, blockers: v.blockers, attestation: v.attestation,
      };
    }
    case 'breakdown': {
      const b = value as { standardPremium: Money; components: Array<{ label: string; extraMortalityBps: number; amount: Money; reason: string; source: string; referToHuman: boolean }>; loadedPremium: Money; totalPayable: Money; exclusions: string[]; evidenceRequired: string[]; totalExtraBps: number; reconciliation: { detail: string; agrees: boolean | null } };
      return {
        standardPremium: formatAmount(b.standardPremium), loadedPremium: formatAmount(b.loadedPremium),
        totalPayable: formatAmount(b.totalPayable), totalExtraBps: b.totalExtraBps,
        components: b.components.map((c) => ({ label: c.label, bps: c.extraMortalityBps, amount: formatAmount(c.amount), reason: c.reason, source: c.source, referToHuman: c.referToHuman })),
        exclusions: b.exclusions, evidenceRequired: b.evidenceRequired, reconciliation: b.reconciliation,
      };
    }
    case 'pricing': {
      const p = value as { lines: Array<{ name: string; code: string; appliedBps: number; loadingBps: number; amount: Money; waived: boolean; note: string }>; totalRiderPremium: Money; waivedLoadingValue: Money; waivedLoadingBps: number; blockers: string[]; evidenceRequired: string[] };
      return {
        lines: p.lines.map((l) => ({ code: l.code, name: l.name, bps: l.appliedBps, loadingBps: l.loadingBps, amount: formatAmount(l.amount), waived: l.waived, note: l.note })),
        total: formatAmount(p.totalRiderPremium), waivedValue: formatAmount(p.waivedLoadingValue),
        waivedBps: p.waivedLoadingBps, blockers: p.blockers, evidenceRequired: p.evidenceRequired,
      };
    }
    case 'requirements':
      return (value as Array<{ label: string; status: string; source: string; reason: string }>).map((r) => ({ label: r.label, status: r.status, source: r.source, reason: r.reason }));
    case 'plan': {
      const plan = value as { investableLabel: string; lines: Array<{ fundId: string; name: string; weightPct: number; amountLabel: string; units: string; navPerUnit: string; navDate: string; riskGrade: string; shariahScreened: boolean; fundManagementChargeBps: number }>; totalWeightBps: number; weightedChargeBps: number; weightedRiskScore: number; appetite: string | null; appetiteAgrees: boolean | null; shariahRequired: boolean; shariahAgrees: boolean; blockers: string[]; warnings: string[]; acknowledgementsRequired: string[]; complete: boolean; balances: boolean };
      return { ...plan };
    }
    case 'set': {
      const set = value as { primaries: Array<{ name: string; relationship: string; sharePct: number; shareOfProceeds: Money | null; age: number | null }>; contingents: Array<{ name: string; relationship: string; sharePct: number }>; primaryTotalBps: number; complete: boolean; percent: number; blockers: string[]; warnings: string[] };
      return {
        primaries: set.primaries.map((b) => ({ name: b.name, relationship: b.relationship, sharePct: b.sharePct, age: b.age, share: b.shareOfProceeds ? formatAmount(b.shareOfProceeds) : null })),
        contingents: set.contingents.map((b) => ({ name: b.name, relationship: b.relationship, sharePct: b.sharePct })),
        primaryTotalPct: set.primaryTotalBps / 100, complete: set.complete, percent: set.percent,
        blockers: set.blockers, warnings: set.warnings,
      };
    }
    default:
      return null;
  }
}
