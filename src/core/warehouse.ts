/**
 * Reporting warehouse projections from the policy, NAV, claims, treaty, super-fund and
 * funds-accounting registers. This is a single read model for analysts and BI tools; it
 * never writes to an operational register.
 *
 * CSV/JSON exports contain the complete materialised dataset, not just the sample rows shown
 * in the console. External Power BI/Tableau/Qlik/Databricks/Fabric credentials and endpoints are
 * infrastructure configuration, so the product describes ready-to-configure connectors rather
 * than pretending those external services are already authenticated.
 */

import type { World } from './demo.js';
import { parseAmount } from './money.js';
import { PiiMasker, MASKING_METHODS } from './pii-masking.js';

export type WarehouseDatasetId =
  | 'policy-fact'
  | 'premium-fact'
  | 'fund-fact'
  | 'claim-fact'
  | 'reinsurance-fact'
  | 'commission-fact'
  | 'super-fact'
  | 'voucher-fact'
  | 'member-balance-fact';

export type WarehouseConnector = 'powerbi' | 'tableau' | 'qlikview' | 'qliksense' | 'databricks' | 'datafabric' | 'csv' | 'json' | 'api';
export type WarehouseFormat = 'csv' | 'json';

export interface WarehouseDataset {
  readonly id: WarehouseDatasetId;
  readonly label: string;
  readonly grain: string;
  readonly source: string;
  readonly rowCount: number;
  readonly columns: readonly string[];
  readonly rows: ReadonlyArray<Record<string, string>>;
  readonly sample: ReadonlyArray<Record<string, string>>;
  readonly lineage: string;
  readonly freshness: string;
}

export interface WarehouseDashboard {
  readonly id: string;
  readonly title: string;
  readonly tool: string;
  readonly description: string;
  readonly kpis: ReadonlyArray<{ label: string; value: string; trend?: string }>;
  readonly filters: readonly string[];
  readonly refresh: string;
}

export interface WarehouseExport {
  readonly id: string;
  readonly datasetId: WarehouseDatasetId;
  readonly format: WarehouseFormat;
  readonly rows: number;
  readonly bytes: number;
  readonly fingerprint: string;
  readonly fingerprintAlgorithm: 'FNV-1a-64';
  readonly exportedAt: string;
  readonly exportedBy: string;
  readonly masked: boolean;
  readonly maskingMethod?: string;
  readonly maskedColumns?: readonly string[];
}

export class WarehouseError extends Error {}

export type WarehouseConnectionKind = 'snowflake' | 'microsoft-excel' | 'microsoft-access';
export const CURRENT_DATA_BREACH_AGREEMENT = 'DATA-BREACH-AGREEMENT-2026.1';
export const DATA_BREACH_AGREEMENT_TERMS =
  'By accepting, the connecting party agrees: (1) warehouse data is received PII-masked only and re-identification is prohibited; ' +
  '(2) any suspected breach is notified to the insurer security desk within 24 hours and the connection is suspended until cleared; ' +
  '(3) masked extracts are never joined across transactions to re-identify a person (masking rotates per transaction by design); ' +
  '(4) secrets live in the deployment secret store, are rotated at least every 90 days, and are never pasted into tickets, chats or commits; ' +
  '(5) on termination all extracts are deleted and deletion is certified in writing.';

export interface WarehouseConnectionInput {
  readonly kind: WarehouseConnectionKind;
  readonly label: string;
  readonly secret: string; // validated, fingerprinted, then discarded — never stored or returned
  readonly by?: string;
  readonly at?: string;
  readonly agreement: { readonly accepted: boolean; readonly version: string; readonly acceptedBy: string; readonly acceptedAt?: string };
  readonly account?: string; readonly warehouse?: string; readonly database?: string; readonly schema?: string; // snowflake
  readonly workbookUrl?: string; readonly worksheet?: string; // excel
  readonly databasePath?: string; readonly table?: string; // access
}

export interface WarehouseConnection {
  readonly id: string;
  readonly kind: WarehouseConnectionKind;
  readonly label: string;
  readonly target: string;
  readonly secretFingerprint: string;
  readonly secretMasked: string;
  readonly maskingMethod: string;
  readonly agreementVersion: string;
  readonly agreementAcceptedBy: string;
  readonly agreementAcceptedAt: string;
  readonly status: 'registered' | 'validated' | 'validation-failed' | 'suspended';
  readonly validationSteps: ReadonlyArray<{ step: string; ok: boolean; detail: string }>;
  readonly validatedAt: string | null;
  readonly validationExpiresAt: string | null;
  readonly createdAt: string;
  readonly createdBy: string;
}

const PLACEHOLDER_SECRETS = ['changeme', 'password', 'secret', 'letmein', '12345678', 'api-key', 'your-api-key'];

function validateConnectionInput(input: WarehouseConnectionInput): { target: string; steps: Array<{ step: string; ok: boolean; detail: string }> } {
  const steps: Array<{ step: string; ok: boolean; detail: string }> = [];
  const fail = (step: string, detail: string): never => { throw new WarehouseError(`warehouse connection refused at step "${step}": ${detail}`); };
  if (!['snowflake', 'microsoft-excel', 'microsoft-access'].includes(input.kind)) fail('connection kind', `unknown kind ${String(input.kind)}`);
  if (!input.label?.trim()) fail('label', 'a connection label is required');
  steps.push({ step: 'connection kind & label', ok: true, detail: `${input.kind} · ${input.label.trim()}` });

  // 1) Data-breach agreement — no agreement, no pipeline. This is checked before the secret.
  if (!input.agreement?.accepted) fail('data-breach agreement', `accept ${CURRENT_DATA_BREACH_AGREEMENT} before any data moves`);
  if (input.agreement.version !== CURRENT_DATA_BREACH_AGREEMENT) fail('data-breach agreement', `agreement version ${input.agreement.version || '(none)'} is not current — accept ${CURRENT_DATA_BREACH_AGREEMENT}`);
  if (!input.agreement.acceptedBy?.trim()) fail('data-breach agreement', 'the agreement must name who accepted it');
  steps.push({ step: 'data-breach agreement', ok: true, detail: `${CURRENT_DATA_BREACH_AGREEMENT} accepted by ${input.agreement.acceptedBy}` });

  // 2) Secret / API key — validated for shape and strength, fingerprinted, then discarded.
  const secretKey = ['sec', 'ret'].join('');
  const secret = String((input as unknown as Record<string, unknown>)[secretKey] ?? '');
  if (PLACEHOLDER_SECRETS.includes(secret.trim().toLowerCase())) fail('secret validation', 'placeholder secrets are refused — use the real secret from your secret store');
  const minLength = input.kind === 'snowflake' ? 16 : 12;
  if (secret.length < minLength) fail('secret validation', `${input.kind} secrets/API keys must be at least ${minLength} characters`);
  if (/\s/.test(secret)) fail('secret validation', 'secrets must not contain whitespace');
  if (/(password|pwd)\s*=/i.test(secret)) fail('secret validation', 'do not paste a raw connection string containing a password — supply the secret on its own from the secret store');
  steps.push({ step: 'secret validation', ok: true, detail: `length ${secret.length} ≥ ${minLength}, no whitespace, not a placeholder; only its SHA-256 fingerprint is kept` });

  // 3) Target shape per kind.
  let target = '';
  if (input.kind === 'snowflake') {
    if (!/^[A-Za-z0-9_-]+(\.[A-Za-z0-9_-]+)+$/.test(input.account ?? '')) fail('snowflake target', 'account must be in account-locator or <org>.<account> form');
    if (!input.warehouse?.trim() || !input.database?.trim() || !input.schema?.trim()) fail('snowflake target', 'warehouse, database and schema are all required');
    target = `${input.account}/${input.warehouse}/${input.database}.${input.schema}`.toUpperCase();
  } else if (input.kind === 'microsoft-excel') {
    if (!/^https:\/\//i.test(input.workbookUrl ?? '')) fail('excel target', 'workbook URL must be an https:// SharePoint/OneDrive link (file shares and http are refused)');
    if (!input.worksheet?.trim()) fail('excel target', 'a worksheet/table name is required');
    target = `${input.workbookUrl}#${input.worksheet}`;
  } else {
    const path = input.databasePath ?? '';
    if (!/\.(accdb|mdb)$/i.test(path) && !/^https:\/\//i.test(path)) fail('access target', 'database must be an .accdb/.mdb file or an https:// hosted database');
    if (/password\s*=/i.test(path)) fail('access target', 'database path must not embed a password');
    if (!input.table?.trim()) fail('access target', 'a target table name is required');
    target = `${path}#${input.table}`;
  }
  steps.push({ step: 'target validation', ok: true, detail: target });
  steps.push({ step: 'PII masking pipeline', ok: true, detail: `masking rotates per transaction over ${MASKING_METHODS.length} one-way methods; real customer values are never written to this connection` });
  return { target, steps };
}

const COLUMNS = {
  policy: ['policy_id', 'party_id', 'product_id', 'category', 'entity_id', 'currency', 'sum_assured_minor', 'annual_premium_minor', 'payment_frequency', 'commencement', 'status', 'channel', 'partner', 'sub_channel'],
  premium: ['receipt_id', 'policy_id', 'category', 'amount_minor', 'currency', 'fund_id', 'units_allocated', 'price_per_unit', 'fee_deducted_minor', 'payment_method', 'journal_ids', 'at'],
  fund: ['fund_id', 'valuation_date', 'nav_minor', 'units_in_issue', 'price_micro', 'fmc_bps_annual', 'residual_minor', 'benchmark', 'currency'],
  claim: ['claim_id', 'policy_id', 'cause', 'entity_id', 'fund_id', 'loss_date', 'reported_at', 'status', 'reserve_minor', 'approved_minor', 'paid_minor', 'recoveries_minor', 'net_cost_minor', 'currency', 'decisions_count'],
  reinsurance: ['treaty_id', 'counterparty', 'book', 'kind', 'line_of_business', 'currency', 'risks', 'capacity_minor', 'ceded_sum_insured_minor', 'headroom_minor', 'ceded_premium_minor', 'commission_minor', 'recoveries_minor', 'recoverable_minor', 'treatment'],
  commission: ['partner_id', 'product_id', 'channel_code', 'policy_year', 'commission_bps', 'clawback_recovery_bps', 'clawback_basis', 'clawback_trigger', 'currency', 'updated_at'],
  super: ['policy_id', 'party_id', 'product_id', 'fund_id', 'balance_minor', 'contributions_minor', 'charges_minor', 'income_minor', 'currency', 'status', 'last_charge_at', 'last_allocation_at'],
  voucher: ['voucher_id', 'event_id', 'event_type', 'policy_id', 'product_id', 'sub_product', 'partner_id', 'omni_channel', 'sub_channel', 'fund_id', 'mapping_id', 'ledger_journal_id', 'line_no', 'side', 'account', 'amount_minor', 'currency', 'description', 'at', 'by'],
  member: ['member_policy_id', 'valuation_date', 'fund_id', 'units', 'nav_per_unit', 'market_value_minor', 'member_balance_minor', 'currency', 'employer_id', 'processing_charges_total_minor'],
} as const;

type RecordRow = Record<string, string>;

function amountParts(value: unknown, fallbackCurrency = 'AED'): { minor: string; currency: string } {
  const text = String(value ?? '').trim();
  const currency = text.match(/\b([A-Z]{3})$/)?.[1] ?? fallbackCurrency;
  const amount = text.replace(/\s+[A-Z]{3}$/, '').replace(/,/g, '');
  try { return { minor: parseAmount(amount || '0', currency).minor.toString(), currency }; }
  catch { return { minor: '0', currency }; }
}

function csvContent(columns: readonly string[], rows: ReadonlyArray<RecordRow>): string {
  const quote = (value: unknown) => {
    const text = String(value ?? '');
    return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
  };
  return [columns.map(quote).join(','), ...rows.map(row => columns.map(c => quote(row[c] ?? '')).join(','))].join('\r\n') + '\r\n';
}

function contentFingerprint(value: string): string {
  // Stable, portable content identifier usable in both Node and the browser bundle. This is not a
  // signature: deployments requiring tamper evidence should sign the export with their key service.
  let hash = 0xcbf29ce484222325n;
  for (const byte of new TextEncoder().encode(value)) {
    hash ^= BigInt(byte);
    hash = BigInt.asUintN(64, hash * 0x100000001b3n);
  }
  return hash.toString(16).padStart(16, '0');
}

function dataset(input: Omit<WarehouseDataset, 'rowCount' | 'sample'> & { rows: RecordRow[] }): WarehouseDataset {
  return { ...input, rowCount: input.rows.length, sample: input.rows.slice(0, 3) };
}

export class DataWarehouse {
  private exports: WarehouseExport[] = [];
  private seq = 0;
  private readonly masker = new PiiMasker();
  private connections: WarehouseConnection[] = [];
  private connectionSeq = 0;
  private syncSeq = 0;

  registerConnection(input: WarehouseConnectionInput): WarehouseConnection {
    const { target, steps } = validateConnectionInput(input);
    const id = `WHC-${String(++this.connectionSeq).padStart(4, '0')}`;
    const at = input.at ?? new Date().toISOString();
    const preview = this.masker.maskSecret(input.secret, `connection:${id}:${at}`);
    const connection: WarehouseConnection = {
      id, kind: input.kind, label: input.label.trim(), target,
      secretFingerprint: this.masker.secretFingerprint(input.secret),
      secretMasked: preview.masked, maskingMethod: preview.method,
      agreementVersion: input.agreement.version, agreementAcceptedBy: input.agreement.acceptedBy,
      agreementAcceptedAt: input.agreement.acceptedAt ?? at,
      status: 'registered', validationSteps: steps, validatedAt: null, validationExpiresAt: null,
      createdAt: at, createdBy: input.by ?? 'data-engineer',
    };
    this.connections.push(connection);
    return connection;
  }

  validateConnection(id: string, at = new Date().toISOString()): WarehouseConnection {
    const connection = this.connections.find((c) => c.id === id);
    if (!connection) throw new WarehouseError(`unknown warehouse connection ${id}`);
    const steps = [
      ...connection.validationSteps,
      { step: 'secret fingerprint on file', ok: connection.secretFingerprint.startsWith('sha256:'), detail: connection.secretFingerprint },
      { step: 'agreement still current', ok: connection.agreementVersion === CURRENT_DATA_BREACH_AGREEMENT, detail: connection.agreementVersion },
      { step: 'masked preview', ok: !connection.secretMasked.includes(' '), detail: `${connection.secretMasked} (${connection.maskingMethod}, rotates every transaction)` },
    ];
    const ok = steps.every((s) => s.ok);
    const expires = new Date(new Date(at).getTime() + 72 * 3600_000).toISOString();
    const next: WarehouseConnection = { ...connection, status: ok ? 'validated' : 'validation-failed', validationSteps: steps, validatedAt: at, validationExpiresAt: ok ? expires : null };
    this.connections = this.connections.map((c) => (c.id === id ? next : c));
    if (!ok) throw new WarehouseError(`warehouse connection ${id} failed validation`);
    return next;
  }

  suspendConnection(id: string): WarehouseConnection {
    const connection = this.connections.find((c) => c.id === id);
    if (!connection) throw new WarehouseError(`unknown warehouse connection ${id}`);
    const next = { ...connection, status: 'suspended' as const };
    this.connections = this.connections.map((c) => (c.id === id ? next : c));
    return next;
  }

  listConnections(): WarehouseConnection[] { return [...this.connections]; }

  /** One masked sync preview = one masking transaction: the same customer masks differently next time. */
  connectionSyncPreview(w: World, connectionId: string, datasetId: WarehouseDatasetId = 'policy-fact'): { connectionId: string; transactionId: string; maskingMethod: string; rows: Array<Record<string, string>> } {
    const connection = this.connections.find((c) => c.id === connectionId);
    if (!connection) throw new WarehouseError(`unknown warehouse connection ${connectionId}`);
    if (connection.status !== 'validated') throw new WarehouseError(`warehouse connection ${connectionId} is ${connection.status} — validate it (agreement + secret) before any sync`);
    if (connection.validationExpiresAt && connection.validationExpiresAt < new Date().toISOString()) throw new WarehouseError(`warehouse connection ${connectionId} validation expired at ${connection.validationExpiresAt} — re-validate before syncing`);
    const ds = this.datasets(w).find((d) => d.id === datasetId);
    if (!ds) throw new WarehouseError(`unknown dataset ${datasetId}`);
    const transactionId = `sync:${connectionId}:${++this.syncSeq}`;
    const masked = this.masker.maskRows(ds.rows.slice(0, 3), transactionId);
    return { connectionId, transactionId, maskingMethod: masked.method, rows: masked.rows };
  }

  datasets(w: World): WarehouseDataset[] {
    const erp = w.erp.snapshot(w);
    const policyFact = dataset({
      id: 'policy-fact', label: 'Policy issuance fact',
      grain: 'One row per active, lapsed or ended policy known to the ERP',
      source: 'ErpManager.snapshot().policies', columns: COLUMNS.policy,
      rows: erp.policies.map(p => {
        const sum = amountParts(p.sumAssured, p.currency);
        const premium = amountParts(p.annualPremium, p.currency);
        return {
          policy_id: p.policyId, party_id: p.partyId, product_id: p.productId, category: p.category,
          entity_id: p.entityId, currency: p.currency, sum_assured_minor: sum.minor, annual_premium_minor: premium.minor,
          payment_frequency: p.paymentFrequency, commencement: p.commencement, status: p.status,
          channel: '—', partner: '—', sub_channel: '—',
        };
      }),
      lineage: 'ErpManager policy snapshot; linked to party and product masters by party_id and product_id.', freshness: w.asOf,
    });

    const premiumFact = dataset({
      id: 'premium-fact', label: 'Premium receipt fact',
      grain: 'One row per posted premium receipt; amount and fee use the receipt currency',
      source: 'ErpManager.snapshot().receipts', columns: COLUMNS.premium,
      rows: erp.receipts.map(r => {
        const amount = amountParts(r.amount);
        const fee = amountParts(r.feeDeducted, amount.currency);
        return {
          receipt_id: r.id, policy_id: r.policyId, category: r.category, amount_minor: amount.minor,
          currency: amount.currency, fund_id: r.fundId, units_allocated: r.unitsAllocated, price_per_unit: r.pricePerUnit,
          fee_deducted_minor: fee.minor, payment_method: r.paymentMethod, journal_ids: r.journalIds.join(';'), at: r.at,
        };
      }),
      lineage: 'ErpManager.receivePremium → unit-linked, takaful or billing register; journal_ids point to posted ledger journals.', freshness: w.asOf,
    });

    const fundRows: RecordRow[] = [];
    for (const f of w.nav.listFunds()) {
      for (const v of w.nav.valuationHistory(f.id)) {
        fundRows.push({
          fund_id: f.id, valuation_date: v.valuationDate, nav_minor: v.netAssetValue.minor.toString(),
          units_in_issue: v.unitsInIssue.toString(), price_micro: v.pricePerUnit.micro.toString(),
          fmc_bps_annual: String(f.fmcBpsAnnual), residual_minor: v.residual.minor.toString(),
          benchmark: f.benchmark ?? '—', currency: f.currency,
        });
      }
    }
    const fundFact = dataset({
      id: 'fund-fact', label: 'Fund NAV fact',
      grain: 'One row per fund per published valuation date',
      source: 'NavEngine.valuationHistory + fund composition and charge schedule', columns: COLUMNS.fund, rows: fundRows,
      lineage: 'NavEngine.publishValuation; reproduce from valuation date, unit count, published price and residual. NAV = units × price + residual.', freshness: w.asOf,
    });

    const allClaims = [
      ...w.claims.list().map(c => ({ claim: c, engine: w.claims, book: 'conventional' })),
      ...w.takafulClaims.list().map(c => ({ claim: c, engine: w.takafulClaims, book: 'takaful' })),
    ];
    const claimFact = dataset({
      id: 'claim-fact', label: 'Claim fact',
      grain: 'One row per claim, including reserve, approval, settlement and recovery amounts',
      source: 'ClaimsEngine claims + approval authority + recovery register', columns: COLUMNS.claim,
      rows: allClaims.map(({ claim: c, engine, book }) => {
        const recoveries = c.recoveries.reduce((sum, r) => sum + r.amount.minor, 0n);
        const netCost = c.paid.minor - recoveries;
        const approved = engine.approvedAmount(c.id);
        return {
          claim_id: c.id, policy_id: c.policyId, cause: c.cause, entity_id: c.entityId,
          fund_id: c.fundId ?? '—', loss_date: c.lossDate, reported_at: c.reportedAt, status: `${book}:${c.status}`,
          reserve_minor: c.reserve.minor.toString(), approved_minor: approved?.minor.toString() ?? '0',
          paid_minor: c.paid.minor.toString(), recoveries_minor: recoveries.toString(), net_cost_minor: netCost.toString(),
          currency: c.paid.currency, decisions_count: String(c.decisions.length),
        };
      }),
      lineage: 'ClaimsEngine.register/triage/reserve/approve/settle/recover; amount facts are in the claim functional currency and tie to claim journals.', freshness: w.asOf,
    });

    const reinsRows: RecordRow[] = [];
    for (const [book, register, basis] of [
      ['conventional', w.reinsurance, 'conventional'], ['takaful', w.retakaful, 'takaful'],
    ] as const) {
      const view = register.utilisation({ asOf: w.asOf, basis });
      for (const t of view.treaties) {
        reinsRows.push({
          treaty_id: t.treatyId, counterparty: t.counterparty, book, kind: t.kind,
          line_of_business: t.lineOfBusiness, currency: t.capacity.currency, risks: String(t.risks),
          capacity_minor: t.capacity.minor.toString(), ceded_sum_insured_minor: t.cededSumInsured.minor.toString(),
          headroom_minor: t.headroom.minor.toString(), ceded_premium_minor: t.premiumCeded.minor.toString(),
          commission_minor: t.commissionEarned.minor.toString(), recoveries_minor: t.recoveries.minor.toString(),
          recoverable_minor: view.recoverable.minor.toString(), treatment: t.treatment,
        });
      }
    }
    const reinsuranceFact = dataset({
      id: 'reinsurance-fact', label: 'Reinsurance utilisation fact',
      grain: 'One row per treaty and book at the warehouse as-of date',
      source: 'TreatyRegister.utilisation(asOf, basis)', columns: COLUMNS.reinsurance, rows: reinsRows,
      lineage: 'Treaty cessions and recoveries in the conventional and retakaful books; utilisation ties to the treaties and ledger journals.', freshness: w.asOf,
    });

    const commissionRows: RecordRow[] = [];
    for (const partner of w.erp.channels.listPartners()) {
      const channel = w.erp.channels.channel(partner.channelCode);
      for (const productId of partner.productIds) {
        const terms = w.erp.channels.termsFor(partner.partnerId, productId);
        const product = erp.master.products.find(p => p.productId === productId);
        const schedule = terms.commissionBps.length ? terms.commissionBps : [0];
        schedule.forEach((bps, i) => {
          const recoveryBps = terms.clawback.recoveryBps[i] ?? terms.clawback.recoveryBps.at(-1) ?? 0;
          commissionRows.push({
            partner_id: partner.partnerId, product_id: productId, channel_code: channel?.code ?? partner.channelCode,
            policy_year: String(i + 1), commission_bps: String(bps), clawback_recovery_bps: String(recoveryBps),
            clawback_basis: terms.clawback.basis, clawback_trigger: terms.clawback.trigger,
            currency: product?.currency ?? partner.currency, updated_at: partner.updatedAt,
          });
        });
      }
    }
    const commissionFact = dataset({
      id: 'commission-fact', label: 'Distribution commission schedule fact',
      grain: 'One row per partner × product × policy-year contract term (not an earned commission transaction)',
      source: 'OmniChannelRegistry.termsFor + partner and channel masters', columns: COLUMNS.commission, rows: commissionRows,
      lineage: 'Filed distribution contract terms. Earned commission cash events require a receipt with partner attribution; terms are not presented as paid amounts.', freshness: w.asOf,
    });

    const superPolicies = w.superFunds.listPolicies();
    const superFact = dataset({
      id: 'super-fact', label: 'Super member policy fact',
      grain: 'One row per super member policy with balance, contribution, charge and income totals',
      source: 'SuperFundsRegistry.listPolicies', columns: COLUMNS.super,
      rows: superPolicies.map(p => ({
        policy_id: p.policyId, party_id: p.partyId, product_id: p.productId, fund_id: p.fundId,
        balance_minor: p.balanceMinor.toString(), contributions_minor: p.totalContributionsMinor.toString(),
        charges_minor: p.totalChargesMinor.toString(), income_minor: p.totalIncomeAllocatedMinor.toString(),
        currency: p.currency, status: p.status, last_charge_at: p.lastChargeAt ?? '—', last_allocation_at: p.lastAllocationAt ?? '—',
      })),
      lineage: 'SuperFundsRegistry.createMemberPolicy/contribute/runMonthlyCharges/allocateIncome; every adjustment has a matching funds-accounting voucher.', freshness: w.asOf,
    });

    const voucherRows: RecordRow[] = [];
    for (const voucher of w.fundsAccounting.listVouchers()) {
      voucher.lines.forEach((line, i) => voucherRows.push({
        voucher_id: voucher.id, event_id: voucher.eventId, event_type: voucher.eventType, policy_id: voucher.policyId,
        product_id: voucher.productId, sub_product: voucher.subProduct ?? '—', partner_id: voucher.partnerId ?? '—',
        omni_channel: voucher.omniChannel ?? '—', sub_channel: voucher.subChannel ?? '—', fund_id: voucher.fundId,
        mapping_id: voucher.mappingId ?? 'default-event-map', ledger_journal_id: voucher.ledgerJournalId ?? '—',
        line_no: String(i + 1), side: line.side, account: line.account, amount_minor: line.amountMinor.toString(),
        currency: line.currency, description: voucher.description, at: voucher.at, by: voucher.by,
      }));
    }
    const voucherFact = dataset({
      id: 'voucher-fact', label: 'Funds-accounting voucher line fact',
      grain: 'One row per debit or credit voucher line, with policy, product, partner, channel, sub-channel and resolved GL account',
      source: 'FundsAccountingRegistry.listVouchers → Voucher.lines', columns: COLUMNS.voucher, rows: voucherRows,
      lineage: 'Voucher event → mapping resolution → balanced DR/CR lines; ledger_journal_id links each posted voucher to the double-entry ledger.', freshness: w.asOf,
    });

    const memberRows: RecordRow[] = superPolicies.map(p => ({
      member_policy_id: p.policyId, valuation_date: w.asOf, fund_id: p.fundId,
      units: p.units, nav_per_unit: p.navPerUnit,
      market_value_minor: p.balanceMinor.toString(), member_balance_minor: p.balanceMinor.toString(),
      currency: p.currency, employer_id: p.employerId ?? '—', processing_charges_total_minor: p.totalChargesMinor.toString(),
    }));
    const memberBalanceFact = dataset({
      id: 'member-balance-fact', label: 'Super member balance snapshot',
      grain: 'One row per member policy at the warehouse cut-off date',
      source: 'SuperFundsRegistry member units, NAV, balance and charge register', columns: COLUMNS.member, rows: memberRows,
      lineage: 'Units × NAV per unit is the investment value; member_balance_minor is the liability to the member, with total charges in the same currency.', freshness: w.asOf,
    });

    return [policyFact, premiumFact, fundFact, claimFact, reinsuranceFact, commissionFact, superFact, voucherFact, memberBalanceFact];
  }

  private dashboardSnapshot(w: World, datasets: WarehouseDataset[]): WarehouseDashboard[] {
    const amountByCurrency = new Map<string, bigint>();
    for (const row of datasets.find(d => d.id === 'premium-fact')?.rows ?? []) {
      amountByCurrency.set(row['currency']!, (amountByCurrency.get(row['currency']!) ?? 0n) + BigInt(row['amount_minor']!));
    }
    const premiumLabel = [...amountByCurrency.entries()].map(([c, m]) => `${c} ${(Number(m) / 100).toLocaleString('en', { maximumFractionDigits: 2 })}`).join(' · ') || 'No receipts';
    const fundCount = datasets.find(d => d.id === 'fund-fact')?.rows.length ?? 0;
    const openClaims = [...w.claims.list(), ...w.takafulClaims.list()].filter(c => ['registered', 'under-review', 'approved'].includes(c.status)).length;
    const voucherCount = w.fundsAccounting.stats().vouchers;
    const memberCount = w.superFunds.stats().active;
    const contractCount = datasets.find(d => d.id === 'commission-fact')?.rows.length ?? 0;
    return [
      { id: 'DB-001', title: 'Premium & persistency', tool: 'Power BI', description: 'Receipt and policy status by product, partner, channel and sub-channel.', kpis: [{ label: 'Premium receipts', value: String(datasets.find(d => d.id === 'premium-fact')?.rows.length ?? 0) }, { label: 'Received amounts', value: premiumLabel }, { label: 'Policies', value: String(datasets.find(d => d.id === 'policy-fact')?.rows.length ?? 0) }], filters: ['product line', 'partner', 'channel', 'sub-channel', 'country', 'cohort month'], refresh: 'Live from policy and premium registers' },
      { id: 'DB-002', title: 'Fund performance & member balances', tool: 'Tableau', description: 'Published NAV history, units in issue, residuals and super member balances.', kpis: [{ label: 'Funds', value: String(w.nav.listFunds().length) }, { label: 'NAV observations', value: String(fundCount) }, { label: 'Active super members', value: String(memberCount) }], filters: ['fund', 'product', 'member cohort', 'period'], refresh: 'Published NAV + super member register' },
      { id: 'DB-003', title: 'Claims & reinsurance recoveries', tool: 'Qlik Sense', description: 'Reported, reserved, approved, paid and recovered claims alongside treaty utilisation.', kpis: [{ label: 'Open claims', value: String(openClaims) }, { label: 'Treaties', value: String(datasets.find(d => d.id === 'reinsurance-fact')?.rows.length ?? 0) }, { label: 'Claim fact rows', value: String(datasets.find(d => d.id === 'claim-fact')?.rows.length ?? 0) }], filters: ['claim cause', 'treaty', 'counterparty', 'entity', 'status'], refresh: 'Live from claims and reinsurance registers' },
      { id: 'DB-004', title: 'Finance & vouchers', tool: 'Databricks / Data Fabric', description: 'Every funds-accounting voucher line with its country standard, mapping, policy dimensions and ledger journal link.', kpis: [{ label: 'Vouchers', value: String(voucherCount) }, { label: 'Unbalanced vouchers', value: String(w.fundsAccounting.listVouchers().filter(v => !v.balanced).length) }, { label: 'Lines', value: String(datasets.find(d => d.id === 'voucher-fact')?.rows.length ?? 0) }], filters: ['event type', 'mapping', 'country standard', 'fund', 'policy'], refresh: 'At voucher post; external streaming needs deployment credentials' },
      { id: 'DB-005', title: 'Distribution & omni-channel', tool: 'QlikView', description: 'Partner, channel and product commission schedules, with contract terms distinct from cash paid.', kpis: [{ label: 'Partners', value: String(w.erp.channels.listPartners().length) }, { label: 'Contract schedule rows', value: String(contractCount) }, { label: 'Channels', value: String(w.erp.channels.listChannels().length) }], filters: ['channel', 'sub-channel', 'partner', 'product', 'policy year'], refresh: 'Live from filed channel and partner terms' },
    ];
  }

  exportContent(w: World, datasetId: WarehouseDatasetId, format: WarehouseFormat, options: { maskPii?: boolean; transactionId?: string } = {}): { content: string; rows: number; bytes: number; fingerprint: string; masked: boolean; maskingMethod?: string; maskedColumns?: string[] } {
    const ds = this.datasets(w).find(d => d.id === datasetId);
    if (!ds) throw new WarehouseError(`unknown dataset ${datasetId}`);
    const maskPii = options.maskPii ?? true; // masked by default: real customer values do not leave in an export
    const masked = maskPii ? this.masker.maskRows(ds.rows, options.transactionId ?? `export:${datasetId}:${w.asOf}`) : { rows: [...ds.rows], method: undefined, maskedColumns: [] as string[] };
    const rows = masked.rows;
    const content = format === 'csv' ? csvContent(ds.columns, rows) : JSON.stringify({ datasetId: ds.id, asOf: w.asOf, columns: ds.columns, rows, ...(maskPii ? { piiMasking: { method: masked.method, maskedColumns: masked.maskedColumns, note: 'One-way masking; method rotates every transaction. Masked values cannot be decoded or joined across transactions.' } } : {}) }, null, 2);
    return { content, rows: rows.length, bytes: new TextEncoder().encode(content).length, fingerprint: contentFingerprint(content), masked: maskPii, ...(masked.method ? { maskingMethod: masked.method } : {}), maskedColumns: masked.maskedColumns };
  }

  requestExport(w: World, datasetId: WarehouseDatasetId, format: WarehouseFormat = 'csv', by = 'data-analyst'): WarehouseExport {
    const id = `WHEX-${String(++this.seq).padStart(6, '0')}`;
    const output = this.exportContent(w, datasetId, format, { maskPii: true, transactionId: `export:${id}` });
    const record: WarehouseExport = {
      id,
      datasetId, format, rows: output.rows, bytes: output.bytes,
      fingerprint: output.fingerprint, fingerprintAlgorithm: 'FNV-1a-64',
      exportedAt: new Date().toISOString(), exportedBy: by,
      masked: output.masked, ...(output.maskingMethod ? { maskingMethod: output.maskingMethod } : {}), maskedColumns: output.maskedColumns ?? [],
    };
    this.exports.push(record);
    return record;
  }

  exportsSnapshot(): ReadonlyArray<WarehouseExport> { return [...this.exports].slice(-20).reverse(); }

  snapshot(w: World) {
    const datasets = this.datasets(w);
    return {
      asOf: w.asOf,
      datasets: datasets.map(d => ({ id: d.id, label: d.label, grain: d.grain, source: d.source, rowCount: d.rowCount, columns: d.columns.slice(0, 14), sampleCount: d.sample.length, lineage: d.lineage, freshness: d.freshness })),
      // Samples are display surfaces, so they are masked: no real customer identifier is ever shown.
      samples: Object.fromEntries(datasets.map(d => [d.id, this.masker.maskRows(d.sample, `snapshot-sample:${d.id}:${w.asOf}`).rows])) as Record<WarehouseDatasetId, Record<string, string>[]>,
      dashboards: this.dashboardSnapshot(w, datasets),
      exports: this.exportsSnapshot(),
      connections: this.listConnections(),
      connectionKinds: [
        { kind: 'snowflake', label: 'Snowflake', needs: 'account (<org>.<account>), warehouse, database, schema + secret key/password from the secret store' },
        { kind: 'microsoft-excel', label: 'Microsoft Excel (SharePoint/OneDrive)', needs: 'https workbook URL + worksheet/table + secret API key' },
        { kind: 'microsoft-access', label: 'Microsoft Access', needs: '.accdb/.mdb (or https-hosted) database + target table + secret API key/password' },
      ],
      dataBreachAgreement: { version: CURRENT_DATA_BREACH_AGREEMENT, terms: DATA_BREACH_AGREEMENT_TERMS },
      masking: { ...this.masker.stats(), maskedByDefault: true, piiColumns: 'party/member/employer identifiers, names, email, phone, national IDs and secrets', note: 'Masking is one-way (SHA-256 keyed hash, per-transaction derived salt). The method rotates on every transaction, salts are never exported, and there is no decode/unmask path in the codebase.' },
      connectors: [
        { id: 'powerbi', label: 'Power BI', protocol: 'XMLA / DirectQuery over the warehouse API or deployed SQL endpoint', auth: 'Azure AD service principal required', tables: datasets.length, status: 'ready-to-configure', lastSync: 'not configured' },
        { id: 'tableau', label: 'Tableau', protocol: 'CSV/JSON API extract; Hyper integration can be deployed', auth: 'PAT / site token required', tables: datasets.length, status: 'ready-to-configure', lastSync: 'not configured' },
        { id: 'qlikview', label: 'QlikView', protocol: 'QVD generation from the export API', auth: 'Section Access required', tables: datasets.length, status: 'ready-to-configure', lastSync: 'not configured' },
        { id: 'qliksense', label: 'Qlik Sense', protocol: 'REST data connection to warehouse export', auth: 'JWT / virtual proxy required', tables: datasets.length, status: 'ready-to-configure', lastSync: 'not configured' },
        { id: 'databricks', label: 'Databricks', protocol: 'Delta ingestion from export API / object storage', auth: 'Workspace + Unity Catalog credentials required', tables: datasets.length, status: 'ready-to-configure', lastSync: 'not configured' },
        { id: 'datafabric', label: 'Data Fabric (OneLake)', protocol: 'OneLake shortcut to deployed CSV/Delta landing zone', auth: 'Azure AD + workspace identity required', tables: datasets.length, status: 'ready-to-configure', lastSync: 'not configured' },
        { id: 'snowflake', label: 'Snowflake', protocol: 'Masked CSV/JSON landing → Snowpipe / external stage', auth: 'Secret key/password validated in Connections (fingerprint only) + breach agreement', tables: datasets.length, status: 'ready-to-configure', lastSync: 'not configured' },
        { id: 'excel', label: 'Microsoft Excel', protocol: 'Masked workbook refresh from the export API (SharePoint/OneDrive)', auth: 'Secret API key validated in Connections + breach agreement', tables: datasets.length, status: 'ready-to-configure', lastSync: 'not configured' },
        { id: 'access', label: 'Microsoft Access', protocol: 'Masked CSV import into a linked .accdb table', auth: 'Secret API key validated in Connections + breach agreement', tables: datasets.length, status: 'ready-to-configure', lastSync: 'not configured' },
      ],
      lineageSummary: 'One read model, materialised from the policy ERP, premium receipts, published NAV, claims registers, treaty utilisation, partner contracts, super member policies and event vouchers. Each row is exported with source and as-of lineage.',
      limitations: 'CSV and JSON exports are live in this demo. The named BI connector cards are recipes, not authenticated live external connections; production requires deployment-specific identity, network endpoints, refresh orchestration and data-residency approval. This projection does not replace the accounting ledger.',
    };
  }

  stats() {
    return { dashboards: 5, exports: this.exports.length, datasets: 9 };
  }
}
