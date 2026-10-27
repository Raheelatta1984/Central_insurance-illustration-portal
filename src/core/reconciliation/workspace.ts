import { proposeIdentityColumns, type ColumnSuggestion, type IdentityField } from './column-mapping.js';
import { reconciliationFeatureGate, type ReconciliationFeatureGateState } from './feature-gate.js';
import {
  matchIdentityRows,
  normalizePolicyNumber,
  type IdentityFinding,
  type IdentityMatch,
  type IdentityRow,
  type MatchingOptions,
  type MatchingScope,
} from './identity-matching.js';

export class ReconciliationFoundationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ReconciliationFoundationError';
  }
}

export const NON_FINANCIAL_RECONCILIATION_BOUNDARY =
  'Non-financial reconciliation foundation only: insurer/partner ownership metadata, configurable channel/sub-channel types, identity-only header mapping, deterministic policy matching, duplicate quarantine and human proposal review are unlocked. No premium, commission, free-look, clawback, FX, payable statement or AP payment is calculated.';

export interface ReconciliationInsurer {
  readonly insurerId: string;
  readonly name: string;
  readonly jurisdiction: string;
}

export interface ReconciliationChannelType {
  readonly insurerId: string;
  readonly code: string;
  readonly name: string;
}

export interface ReconciliationSubchannelType {
  readonly insurerId: string;
  readonly channelTypeCode: string;
  readonly code: string;
  readonly name: string;
}

export interface ReconciliationPartnerNode {
  readonly insurerId: string;
  readonly partnerId: string;
  readonly channelPartnerId: string;
  readonly parentPartnerId: string | null;
  readonly channelTypeCode: string;
  readonly subchannelTypeCode: string | null;
  readonly name: string;
}

export interface ReconciliationMappingRecord {
  readonly mappingId: string;
  readonly insurerId: string;
  readonly sourceLabel: string;
  readonly headers: readonly string[];
  readonly suggestions: readonly ColumnSuggestion[];
  readonly ignoredNonIdentityHeaders: readonly { readonly index: number; readonly header: string }[];
  readonly confirmed: boolean;
  readonly confirmedAssignments: Partial<Record<IdentityField, { readonly index: number; readonly header: string }>> | null;
  readonly proposedBy: string;
  readonly proposedAt: string;
  readonly confirmedBy: string | null;
  readonly confirmedAt: string | null;
}

export interface ReconciliationSourceRowView {
  readonly rowId: string;
  readonly policyNumber: string | null;
  readonly normalizedPolicyNumber: string | null;
  readonly insuredName: string | null;
}

export type ProposalReviewStatus = 'pending_review' | 'confirmed' | 'rejected';

export interface ReconciliationProposalRecord {
  readonly leftRowId: string;
  readonly rightRowId: string;
  readonly score: number;
  readonly status: ProposalReviewStatus;
  readonly reviewedBy: string | null;
  readonly reviewedAt: string | null;
  readonly reviewNote: string | null;
}

export interface ReconciliationRunSummary {
  readonly partnerRowCount: number;
  readonly insurerRowCount: number;
  readonly exactMatchCount: number;
  readonly safeVariantMatchCount: number;
  readonly confirmedProposalCount: number;
  readonly pendingProposalCount: number;
  readonly rejectedProposalCount: number;
  readonly quarantinedFindingCount: number;
  readonly unmatchedPartnerCount: number;
  readonly unmatchedInsurerCount: number;
}

export interface ReconciliationFoundationRun {
  readonly runId: string;
  readonly createdAt: string;
  readonly createdBy: string;
  readonly scope: MatchingScope;
  readonly options: MatchingOptions;
  readonly partnerRows: readonly ReconciliationSourceRowView[];
  readonly insurerRows: readonly ReconciliationSourceRowView[];
  readonly matches: readonly IdentityMatch[];
  readonly proposals: readonly ReconciliationProposalRecord[];
  readonly findings: readonly IdentityFinding[];
  readonly unmatchedLeftRowIds: readonly string[];
  readonly unmatchedRightRowIds: readonly string[];
  readonly summary: ReconciliationRunSummary;
  readonly financialBoundary: string;
}

export interface ReconciliationAuditEntry {
  readonly id: string;
  readonly at: string;
  readonly actor: string;
  readonly event: string;
  readonly detail: string;
}

const IDENTITY_FIELDS: readonly IdentityField[] = ['policyNumber', 'insuredName', 'insurer', 'insuranceClass'];

function cleanId(value: string, label: string, maxLen = 200): string {
  if (typeof value !== 'string' || !value.trim() || value !== value.trim() || value.length > maxLen || value.includes('\0')) {
    throw new ReconciliationFoundationError(`Invalid ${label}`);
  }
  return value;
}

function cleanLabel(value: string, label: string, maxLen = 300): string {
  if (typeof value !== 'string' || !value.trim() || value.trim().length > maxLen || value.includes('\0')) {
    throw new ReconciliationFoundationError(`Invalid ${label}`);
  }
  return value.trim();
}

function computeSummary(
  partnerRows: readonly ReconciliationSourceRowView[],
  insurerRows: readonly ReconciliationSourceRowView[],
  matches: readonly IdentityMatch[],
  proposals: readonly ReconciliationProposalRecord[],
  findings: readonly IdentityFinding[],
  baseUnmatchedLeft: readonly string[],
  baseUnmatchedRight: readonly string[],
): ReconciliationRunSummary {
  const confirmedLeft = new Set(proposals.filter((p) => p.status === 'confirmed').map((p) => p.leftRowId));
  const confirmedRight = new Set(proposals.filter((p) => p.status === 'confirmed').map((p) => p.rightRowId));
  return {
    partnerRowCount: partnerRows.length,
    insurerRowCount: insurerRows.length,
    exactMatchCount: matches.filter((m) => m.kind === 'exact').length,
    safeVariantMatchCount: matches.filter((m) => m.kind === 'safe_variant').length,
    confirmedProposalCount: proposals.filter((p) => p.status === 'confirmed').length,
    pendingProposalCount: proposals.filter((p) => p.status === 'pending_review').length,
    rejectedProposalCount: proposals.filter((p) => p.status === 'rejected').length,
    quarantinedFindingCount: findings.length,
    unmatchedPartnerCount: baseUnmatchedLeft.filter((id) => !confirmedLeft.has(id)).length,
    unmatchedInsurerCount: baseUnmatchedRight.filter((id) => !confirmedRight.has(id)).length,
  };
}

export class ReconciliationFoundationWorkspace {
  private readonly insurers = new Map<string, ReconciliationInsurer>();
  private readonly channelTypes: ReconciliationChannelType[] = [];
  private readonly subchannelTypes: ReconciliationSubchannelType[] = [];
  private readonly partners = new Map<string, ReconciliationPartnerNode>(); // key: `${insurerId}:${partnerId}`
  private readonly mappings = new Map<string, ReconciliationMappingRecord>();
  private readonly runs = new Map<string, ReconciliationFoundationRun>();
  private readonly audit: ReconciliationAuditEntry[] = [];
  private mappingSeq = 0;
  private runSeq = 0;
  private auditSeq = 0;

  constructor(
    private readonly clockAt = '2026-10-05T09:00:00Z',
    private readonly env: Readonly<Record<string, string | undefined>> = {},
  ) {
    this.seedFoundation();
  }

  featureState(): ReconciliationFeatureGateState {
    return reconciliationFeatureGate(this.env);
  }

  private assertUnlocked(): void {
    const gate = this.featureState();
    if (!gate.enabled) {
      throw new ReconciliationFoundationError(
        'Non-financial reconciliation foundation is disabled via PARTNER_COMMISSION_RECONCILIATION_ENABLED',
      );
    }
  }

  private recordAudit(actor: string, event: string, detail: string, at?: string): void {
    this.audit.push({
      id: `RECON-AUD-${String(++this.auditSeq).padStart(5, '0')}`,
      at: at?.trim() || this.clockAt,
      actor: actor.trim() || 'system',
      event,
      detail,
    });
  }

  private seedFoundation(): void {
    const seedInsurers: ReconciliationInsurer[] = [
      { insurerId: 'ALK-CONV', name: 'Al Khaleej Insurance (Conventional)', jurisdiction: 'AE' },
      { insurerId: 'ALK-TKF', name: 'Al Khaleej Takaful Window', jurisdiction: 'AE' },
    ];
    for (const ins of seedInsurers) this.insurers.set(ins.insurerId, ins);

    const seedChannels: ReconciliationChannelType[] = [
      { insurerId: 'ALK-CONV', code: 'broker', name: 'Corporate & Retail Broker' },
      { insurerId: 'ALK-CONV', code: 'bancassurance', name: 'Partner Bank Bancassurance' },
      { insurerId: 'ALK-CONV', code: 'agency', name: 'Tied Agency Network' },
      { insurerId: 'ALK-CONV', code: 'aggregator', name: 'Digital Comparison Aggregator' },
      { insurerId: 'ALK-TKF', code: 'broker', name: 'Takaful Broker Distribution' },
      { insurerId: 'ALK-TKF', code: 'bancassurance', name: 'Islamic Bank Bancatakaful' },
    ];
    this.channelTypes.push(...seedChannels);

    const seedSubchannels: ReconciliationSubchannelType[] = [
      { insurerId: 'ALK-CONV', channelTypeCode: 'broker', code: 'marsh-agency', name: 'Marsh Agency Desk' },
      { insurerId: 'ALK-CONV', channelTypeCode: 'broker', code: 'marsh-call-centre', name: 'Marsh Call Centre' },
      { insurerId: 'ALK-CONV', channelTypeCode: 'bancassurance', code: 'banca-premier-1', name: 'Premier Bank Wealth Desk 1' },
      { insurerId: 'ALK-CONV', channelTypeCode: 'agency', code: 'agency-desk-1', name: 'Tied Agency Desk 1' },
      { insurerId: 'ALK-TKF', channelTypeCode: 'broker', code: 'marsh-call-centre', name: 'Marsh Takaful Call Centre' },
      { insurerId: 'ALK-TKF', channelTypeCode: 'bancassurance', code: 'banca-islamic-2', name: 'Islamic Window Desk 2' },
    ];
    this.subchannelTypes.push(...seedSubchannels);

    const seedPartners: ReconciliationPartnerNode[] = [
      {
        insurerId: 'ALK-CONV', partnerId: 'MARSH-UAE', channelPartnerId: 'MARSH-UAE', parentPartnerId: null,
        channelTypeCode: 'broker', subchannelTypeCode: null, name: 'Marsh UAE Brokerage (Root)',
      },
      {
        insurerId: 'ALK-CONV', partnerId: 'MARSH-UAE-AGENCY', channelPartnerId: 'MARSH-UAE', parentPartnerId: 'MARSH-UAE',
        channelTypeCode: 'broker', subchannelTypeCode: 'marsh-agency', name: 'Marsh UAE — Agency Desk',
      },
      {
        insurerId: 'ALK-CONV', partnerId: 'MARSH-UAE-CALL', channelPartnerId: 'MARSH-UAE', parentPartnerId: 'MARSH-UAE',
        channelTypeCode: 'broker', subchannelTypeCode: 'marsh-call-centre', name: 'Marsh UAE — Call Centre',
      },
      {
        insurerId: 'ALK-CONV', partnerId: 'PREMIER-BANK', channelPartnerId: 'PREMIER-BANK', parentPartnerId: null,
        channelTypeCode: 'bancassurance', subchannelTypeCode: null, name: 'Premier Partner Bank (Root)',
      },
      {
        insurerId: 'ALK-CONV', partnerId: 'PREMIER-DESK-1', channelPartnerId: 'PREMIER-BANK', parentPartnerId: 'PREMIER-BANK',
        channelTypeCode: 'bancassurance', subchannelTypeCode: 'banca-premier-1', name: 'Premier Bank — Wealth Desk 1',
      },
      {
        insurerId: 'ALK-TKF', partnerId: 'ISLAMIC-BANK', channelPartnerId: 'ISLAMIC-BANK', parentPartnerId: null,
        channelTypeCode: 'bancassurance', subchannelTypeCode: null, name: 'Al Noor Islamic Bank (Root)',
      },
      {
        insurerId: 'ALK-TKF', partnerId: 'ISLAMIC-DESK-2', channelPartnerId: 'ISLAMIC-BANK', parentPartnerId: 'ISLAMIC-BANK',
        channelTypeCode: 'bancassurance', subchannelTypeCode: 'banca-islamic-2', name: 'Al Noor Bank — Bancatakaful Desk 2',
      },
    ];
    for (const p of seedPartners) {
      this.partners.set(`${p.insurerId}:${p.partnerId}`, p);
    }

    if (!this.featureState().enabled) return;

    const sampleMapping = this.proposeMapping({
      insurerId: 'ALK-CONV',
      sourceLabel: 'MARSH-OCT-2026-IDENTITY.csv',
      headers: ['Policy Number', 'Insured Name', 'Insurer', 'Class of Business', 'Gross Premium', 'Commission %', 'Net Payable'],
      by: 'reconciliation-seed',
      at: this.clockAt,
    });
    this.confirmMapping({
      mappingId: sampleMapping.mappingId,
      assignments: { policyNumber: 0, insuredName: 1, insurer: 2, insuranceClass: 3 },
      by: 'administration',
      at: this.clockAt,
    });

    const scope: MatchingScope = {
      insurerId: 'ALK-CONV',
      channelPartnerId: 'MARSH-UAE',
      subpartnerId: 'MARSH-UAE-AGENCY',
      insuranceClass: 'life',
    };
    this.runIdentityMatch({
      scope,
      partnerRows: [
        { rowId: 'P-ROW-01', policyNumber: ' pol-2026-00101 ', insuredName: 'Fatima Al Zaabi' },
        { rowId: 'P-ROW-02', policyNumber: 'POL-000205', insuredName: 'Aisha Al Mansoori' },
        { rowId: 'P-ROW-03A', policyNumber: 'POL-2026-00310', insuredName: 'Omar Al Hashimi' },
        { rowId: 'P-ROW-03B', policyNumber: 'POL-2026-00310', insuredName: 'Omar Al Hashimi' },
        { rowId: 'P-ROW-04', policyNumber: 'POL-2026-00419', insuredName: 'Tariq Al Nuaimi' },
        { rowId: 'P-ROW-05', policyNumber: 'POL-000999', insuredName: null },
      ],
      insurerRows: [
        { rowId: 'I-ROW-01', policyNumber: 'POL-2026-00101', insuredName: 'FATIMA AL ZAABI' },
        { rowId: 'I-ROW-02', policyNumber: 'POL-205', insuredName: 'AISHA AL MANSOORI' },
        { rowId: 'I-ROW-03', policyNumber: 'POL-2026-00310', insuredName: 'OMAR AL HASHIMI' },
        { rowId: 'I-ROW-04', policyNumber: 'POL-2026-00418', insuredName: 'Tariq Al Nuaimy' },
        { rowId: 'I-ROW-05', policyNumber: 'POL-999', insuredName: null },
      ],
      proposalThreshold: 0.65,
      maxProposalComparisons: 250,
      by: 'reconciliation-seed',
      at: this.clockAt,
    });
  }

  private assertScopeConfigured(scope: MatchingScope): void {
    const insurerId = cleanId(scope.insurerId, 'insurer identifier');
    const rootId = cleanId(scope.channelPartnerId, 'channel partner identifier');
    cleanId(scope.insuranceClass, 'insurance class', 100);
    if (!this.insurers.has(insurerId)) {
      throw new ReconciliationFoundationError(`Unknown insurer "${insurerId}"`);
    }
    const root = this.partners.get(`${insurerId}:${rootId}`);
    if (!root || root.parentPartnerId !== null || root.channelPartnerId !== rootId) {
      throw new ReconciliationFoundationError(`Root channel partner "${rootId}" is not configured under insurer "${insurerId}"`);
    }
    if (scope.subpartnerId !== null) {
      const subId = cleanId(scope.subpartnerId, 'sub-partner identifier');
      const sub = this.partners.get(`${insurerId}:${subId}`);
      if (!sub || sub.channelPartnerId !== rootId || sub.parentPartnerId === null) {
        throw new ReconciliationFoundationError(
          `Sub-partner "${subId}" does not belong to root partner "${rootId}" under insurer "${insurerId}"`,
        );
      }
    }
  }

  addChannelType(input: {
    insurerId: string;
    code: string;
    name: string;
    parentChannelTypeCode?: string | null;
    by?: string;
    at?: string;
  }): ReconciliationChannelType | ReconciliationSubchannelType {
    this.assertUnlocked();
    const insurerId = cleanId(input.insurerId.trim(), 'insurer identifier');
    if (!this.insurers.has(insurerId)) throw new ReconciliationFoundationError(`Unknown insurer "${insurerId}"`);
    const code = cleanId(input.code.trim().toLowerCase(), 'type code', 100);
    const name = cleanLabel(input.name, 'type name', 500);
    const actor = input.by?.trim() || 'operator';

    if (input.parentChannelTypeCode && input.parentChannelTypeCode.trim()) {
      const parentCode = cleanId(input.parentChannelTypeCode.trim().toLowerCase(), 'parent channel type code', 100);
      const parentExists = this.channelTypes.some((c) => c.insurerId === insurerId && c.code === parentCode);
      if (!parentExists) {
        throw new ReconciliationFoundationError(`Channel type "${parentCode}" is not configured for insurer "${insurerId}"`);
      }
      if (this.subchannelTypes.some((s) => s.insurerId === insurerId && s.channelTypeCode === parentCode && s.code === code)) {
        throw new ReconciliationFoundationError(`Sub-channel type "${code}" already exists under "${parentCode}" for "${insurerId}"`);
      }
      const created: ReconciliationSubchannelType = { insurerId, channelTypeCode: parentCode, code, name };
      this.subchannelTypes.push(created);
      this.recordAudit(actor, 'reconciliation.subchannel-type-added', `Added sub-channel type "${code}" (${name}) under ${insurerId}/${parentCode}.`, input.at);
      return created;
    }

    if (this.channelTypes.some((c) => c.insurerId === insurerId && c.code === code)) {
      throw new ReconciliationFoundationError(`Channel type "${code}" already exists for insurer "${insurerId}"`);
    }
    const created: ReconciliationChannelType = { insurerId, code, name };
    this.channelTypes.push(created);
    this.recordAudit(actor, 'reconciliation.channel-type-added', `Added channel type "${code}" (${name}) for insurer ${insurerId}.`, input.at);
    return created;
  }

  proposeMapping(input: {
    insurerId?: string;
    sourceLabel: string;
    headers: readonly string[];
    by?: string;
    at?: string;
  }): ReconciliationMappingRecord {
    this.assertUnlocked();
    const insurerId = cleanId((input.insurerId ?? 'ALK-CONV').trim(), 'insurer identifier');
    if (!this.insurers.has(insurerId)) throw new ReconciliationFoundationError(`Unknown insurer "${insurerId}"`);
    const sourceLabel = cleanLabel(input.sourceLabel, 'source label', 200);
    if (!Array.isArray(input.headers) || input.headers.length === 0) {
      throw new ReconciliationFoundationError('At least one source header is required');
    }
    let suggestions: ColumnSuggestion[];
    try {
      suggestions = proposeIdentityColumns(input.headers);
    } catch (error) {
      throw new ReconciliationFoundationError(error instanceof Error ? error.message : String(error));
    }
    const candidateIndices = new Set(suggestions.flatMap((s) => s.candidates.map((c) => c.index)));
    const ignoredNonIdentityHeaders = input.headers
      .map((header, index) => ({ index, header }))
      .filter((item) => !candidateIndices.has(item.index));

    const mappingId = `RECON-MAP-${String(++this.mappingSeq).padStart(4, '0')}`;
    const actor = input.by?.trim() || 'operator';
    const at = input.at?.trim() || this.clockAt;
    const record: ReconciliationMappingRecord = {
      mappingId,
      insurerId,
      sourceLabel,
      headers: [...input.headers],
      suggestions,
      ignoredNonIdentityHeaders,
      confirmed: false,
      confirmedAssignments: null,
      proposedBy: actor,
      proposedAt: at,
      confirmedBy: null,
      confirmedAt: null,
    };
    this.mappings.set(mappingId, record);
    this.recordAudit(
      actor,
      'reconciliation.mapping-proposed',
      `Proposed identity-only column mapping ${mappingId} for "${sourceLabel}" (${input.headers.length} headers; ${ignoredNonIdentityHeaders.length} non-identity/financial headers ignored).`,
      at,
    );
    return record;
  }

  confirmMapping(input: {
    mappingId: string;
    assignments: Partial<Record<IdentityField, number | null>>;
    by?: string;
    at?: string;
  }): ReconciliationMappingRecord {
    this.assertUnlocked();
    const existing = this.mappings.get(input.mappingId.trim());
    if (!existing) throw new ReconciliationFoundationError(`Unknown column mapping "${input.mappingId}"`);
    if (!input.assignments || typeof input.assignments !== 'object') {
      throw new ReconciliationFoundationError('Explicit column assignments are required');
    }
    const policyIdx = input.assignments.policyNumber;
    if (policyIdx === undefined || policyIdx === null) {
      throw new ReconciliationFoundationError('Confirmed mapping must assign a policyNumber column');
    }

    const used = new Set<number>();
    const confirmedAssignments: Partial<Record<IdentityField, { readonly index: number; readonly header: string }>> = {};
    for (const field of IDENTITY_FIELDS) {
      const idx = input.assignments[field];
      if (idx === undefined || idx === null) continue;
      if (!Number.isInteger(idx) || idx < 0 || idx >= existing.headers.length) {
        throw new ReconciliationFoundationError(`Column index ${String(idx)} for "${field}" is out of range`);
      }
      if (used.has(idx)) {
        throw new ReconciliationFoundationError(`Column index ${idx} ("${existing.headers[idx]}") cannot be assigned to multiple identity fields`);
      }
      used.add(idx);
      confirmedAssignments[field] = { index: idx, header: existing.headers[idx]! };
    }

    const actor = input.by?.trim() || 'operator';
    const at = input.at?.trim() || this.clockAt;
    const updated: ReconciliationMappingRecord = {
      ...existing,
      confirmed: true,
      confirmedAssignments,
      confirmedBy: actor,
      confirmedAt: at,
    };
    this.mappings.set(existing.mappingId, updated);
    this.recordAudit(
      actor,
      'reconciliation.mapping-confirmed',
      `Confirmed identity column mapping ${existing.mappingId} (${Object.entries(confirmedAssignments).map(([k, v]) => `${k}=#${v!.index}:${v!.header}`).join(', ')}).`,
      at,
    );
    return updated;
  }

  runIdentityMatch(input: {
    scope: MatchingScope;
    partnerRows: ReadonlyArray<{ readonly rowId: string; readonly policyNumber: string | null; readonly insuredName: string | null; readonly scope?: MatchingScope }>;
    insurerRows: ReadonlyArray<{ readonly rowId: string; readonly policyNumber: string | null; readonly insuredName: string | null; readonly scope?: MatchingScope }>;
    proposalThreshold?: number;
    maxProposalComparisons?: number;
    by?: string;
    at?: string;
  }): ReconciliationFoundationRun {
    this.assertUnlocked();
    const normalizedScope: MatchingScope = {
      insurerId: String(input.scope?.insurerId ?? '').trim(),
      channelPartnerId: String(input.scope?.channelPartnerId ?? '').trim(),
      subpartnerId: input.scope?.subpartnerId === null || input.scope?.subpartnerId === undefined || String(input.scope.subpartnerId).trim() === ''
        ? null
        : String(input.scope.subpartnerId).trim(),
      insuranceClass: String(input.scope?.insuranceClass ?? '').trim().toLowerCase(),
    };
    this.assertScopeConfigured(normalizedScope);

    const options: MatchingOptions = {
      proposalThreshold: input.proposalThreshold ?? 0.65,
      maxProposalComparisons: input.maxProposalComparisons ?? 5_000,
    };

    const leftRows: IdentityRow[] = (input.partnerRows ?? []).map((r) => ({
      rowId: r.rowId,
      scope: r.scope ?? normalizedScope,
      policyNumber: r.policyNumber ?? null,
      insuredName: r.insuredName ?? null,
    }));
    const rightRows: IdentityRow[] = (input.insurerRows ?? []).map((r) => ({
      rowId: r.rowId,
      scope: r.scope ?? normalizedScope,
      policyNumber: r.policyNumber ?? null,
      insuredName: r.insuredName ?? null,
    }));

    let matched;
    try {
      matched = matchIdentityRows(normalizedScope, leftRows, rightRows, options);
    } catch (error) {
      throw new ReconciliationFoundationError(error instanceof Error ? error.message : String(error));
    }

    const toView = (rows: readonly IdentityRow[]): ReconciliationSourceRowView[] =>
      rows.map((r) => ({
        rowId: r.rowId,
        policyNumber: r.policyNumber,
        normalizedPolicyNumber: normalizePolicyNumber(r.policyNumber),
        insuredName: r.insuredName,
      }));

    const partnerViews = toView(leftRows);
    const insurerViews = toView(rightRows);
    const proposals: ReconciliationProposalRecord[] = matched.proposals.map((p) => ({
      leftRowId: p.leftRowId,
      rightRowId: p.rightRowId,
      score: Math.round(p.score * 10_000) / 10_000,
      status: 'pending_review',
      reviewedBy: null,
      reviewedAt: null,
      reviewNote: null,
    }));

    const summary = computeSummary(
      partnerViews,
      insurerViews,
      matched.matches,
      proposals,
      matched.findings,
      matched.unmatchedLeftRowIds,
      matched.unmatchedRightRowIds,
    );

    const runId = `RECON-RUN-${String(++this.runSeq).padStart(4, '0')}`;
    const actor = input.by?.trim() || 'operator';
    const at = input.at?.trim() || this.clockAt;
    const run: ReconciliationFoundationRun = {
      runId,
      createdAt: at,
      createdBy: actor,
      scope: normalizedScope,
      options,
      partnerRows: partnerViews,
      insurerRows: insurerViews,
      matches: matched.matches,
      proposals,
      findings: matched.findings,
      unmatchedLeftRowIds: matched.unmatchedLeftRowIds,
      unmatchedRightRowIds: matched.unmatchedRightRowIds,
      summary,
      financialBoundary: NON_FINANCIAL_RECONCILIATION_BOUNDARY,
    };
    this.runs.set(runId, run);
    this.recordAudit(
      actor,
      'reconciliation.identity-run-completed',
      `${runId} (${normalizedScope.insurerId}/${normalizedScope.channelPartnerId}${normalizedScope.subpartnerId ? `/${normalizedScope.subpartnerId}` : ''}/${normalizedScope.insuranceClass}): ${summary.exactMatchCount} exact, ${summary.safeVariantMatchCount} safe variant, ${summary.quarantinedFindingCount} quarantined, ${summary.pendingProposalCount} proposal(s).`,
      at,
    );
    return run;
  }

  reviewProposal(input: {
    runId: string;
    leftRowId: string;
    rightRowId: string;
    decision: 'confirm' | 'reject';
    note: string;
    by?: string;
    at?: string;
  }): ReconciliationFoundationRun {
    this.assertUnlocked();
    const run = this.runs.get(input.runId.trim());
    if (!run) throw new ReconciliationFoundationError(`Unknown reconciliation run "${input.runId}"`);
    const note = cleanLabel(input.note, 'review note', 500);
    const actor = cleanLabel(input.by ?? 'operator', 'reviewer identity', 200);
    const at = input.at?.trim() || this.clockAt;

    const idx = run.proposals.findIndex((p) => p.leftRowId === input.leftRowId && p.rightRowId === input.rightRowId);
    if (idx < 0) {
      throw new ReconciliationFoundationError(
        `Proposal (${input.leftRowId} ↔ ${input.rightRowId}) does not exist on run ${run.runId}`,
      );
    }

    if (input.decision === 'confirm') {
      const conflicting = run.proposals.find(
        (p, i) =>
          i !== idx
          && p.status === 'confirmed'
          && (p.leftRowId === input.leftRowId || p.rightRowId === input.rightRowId),
      );
      if (conflicting) {
        throw new ReconciliationFoundationError(
          `Row already confirmed in another proposal (${conflicting.leftRowId} ↔ ${conflicting.rightRowId})`,
        );
      }
    }

    const nextStatus: ProposalReviewStatus = input.decision === 'confirm' ? 'confirmed' : 'rejected';
    const nextProposals = run.proposals.map((p, i) =>
      i === idx
        ? { ...p, status: nextStatus, reviewedBy: actor, reviewedAt: at, reviewNote: note }
        : p,
    );
    const confirmedLeft = new Set(nextProposals.filter((p) => p.status === 'confirmed').map((p) => p.leftRowId));
    const confirmedRight = new Set(nextProposals.filter((p) => p.status === 'confirmed').map((p) => p.rightRowId));
    const baseUnmatchedLeft = run.partnerRows
      .map((r) => r.rowId)
      .filter((id) => !run.matches.some((m) => m.leftRowId === id));
    const baseUnmatchedRight = run.insurerRows
      .map((r) => r.rowId)
      .filter((id) => !run.matches.some((m) => m.rightRowId === id));

    const summary = computeSummary(
      run.partnerRows,
      run.insurerRows,
      run.matches,
      nextProposals,
      run.findings,
      baseUnmatchedLeft,
      baseUnmatchedRight,
    );

    const updated: ReconciliationFoundationRun = {
      ...run,
      proposals: nextProposals,
      unmatchedLeftRowIds: baseUnmatchedLeft.filter((id) => !confirmedLeft.has(id)),
      unmatchedRightRowIds: baseUnmatchedRight.filter((id) => !confirmedRight.has(id)),
      summary,
    };
    this.runs.set(run.runId, updated);
    this.recordAudit(
      actor,
      `reconciliation.proposal-${nextStatus}`,
      `${run.runId} proposal (${input.leftRowId} ↔ ${input.rightRowId}) ${nextStatus} by ${actor}: ${note}`,
      at,
    );
    return updated;
  }

  snapshot() {
    const runs = [...this.runs.values()].reverse();
    const mappings = [...this.mappings.values()].reverse();
    return {
      featureGate: this.featureState(),
      financialBoundary: NON_FINANCIAL_RECONCILIATION_BOUNDARY,
      insurers: [...this.insurers.values()],
      channelTypes: [...this.channelTypes],
      subchannelTypes: [...this.subchannelTypes],
      partners: [...this.partners.values()],
      insuranceClasses: ['life', 'medical', 'motor', 'property', 'marine', 'takaful-family'],
      mappings,
      runs,
      audit: this.audit.slice(-30).reverse(),
    };
  }
}
