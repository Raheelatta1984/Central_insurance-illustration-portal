/**
 * Enterprise Security Layer: Pre-Load Profile Gate, Granular RBAC (Tab -> Section -> Sub-Section),
 * AI-Powered Access & Segregation-of-Duties (SoD) Recommender, Entity x Channel x Sub-Channel
 * Supervision Mapping, Delegation of Authority (DOA) Approval Workflow & Real-Time Notifications.
 *
 * Principles (per AGENTS.md):
 *  - Every monetary DOA cap and request amount is decimal Money with explicit currency (never float).
 *  - Administration holds unrestricted complete access across every tab, section, sub-section and DOA gate.
 *  - Every profile switch, RBAC change, supervision mapping edit, AI recommendation apply, DOA request,
 *    approval/rejection/escalation and notification read is recorded on an append-only audit log.
 */
import { Money, compare, formatAmount, money, parseAmount } from './money.js';
import { CONSOLE_TABS } from './tour.js';

export type AccessLevel = 'full' | 'read' | 'none';

export type ProfileFamily =
  | 'governance-config'
  | 'underwriting-policy'
  | 'claims-reinsurance'
  | 'finance-funds'
  | 'agency-broker'
  | 'bancassurance-branch'
  | 'digital-partner';

export type DoaActionKind =
  | 'underwriting-approval'
  | 'quote-high-sum-assured'
  | 'discount-concession'
  | 'retention-waiver'
  | 'endorsement-alteration'
  | 'claim-approval'
  | 'settlement-release'
  | 'reinsurance-placement'
  | 'fund-nav-signoff'
  | 'accounting-voucher'
  | 'master-config-change'
  | 'restricted-section-access';

export interface SectionNode {
  readonly id: string;
  readonly label: string;
  readonly subSections: ReadonlyArray<{ readonly id: string; readonly label: string }>;
}

export interface TabCatalogueEntry {
  readonly tabId: string;
  readonly label: string;
  readonly sections: readonly SectionNode[];
}

export interface SecurityProfile {
  readonly id: string;
  readonly name: string;
  readonly title: string;
  readonly family: ProfileFamily;
  readonly badge: string;
  readonly summary: string;
  /** True only for full superuser profiles (e.g. Administration) that bypass all tab/DOA restrictions. */
  readonly unrestricted: boolean;
  readonly entityScope: string;       // e.g. '*', 'ALK-CONV', 'ALK-TKF', 'ALK-MY'
  readonly channelScope: string;      // e.g. '*', 'HEAD-OFFICE', 'AGENCY', 'BROKER-MARSH', 'BANCA', 'AGGREGATOR', 'DIRECT', 'REFERRAL'
  readonly subChannelScope: string;   // e.g. '*', 'AGENCY-DESK-1', 'MARSH-CALL-CENTRE', 'BANCA-PREMIER-1', 'BRANCH-RETAIL-01', ...
  readonly defaultLandingTab: string;
  readonly reportsToProfileId: string | null;
  readonly escalationProfileId: string | null;
  /** Decimal DOA limit for operational/monetary decisions in AED minor units (null = unlimited). */
  readonly doaLimitMinor: bigint | null;
  readonly currency: string;
  readonly doaActions: readonly DoaActionKind[];
  readonly piiAccess: 'full' | 'masked' | 'own-only';
  /** Tab-level access map: tabId -> AccessLevel */
  readonly tabAccess: Readonly<Record<string, AccessLevel>>;
  /** Section-level access overrides/grants: "tabId:sectionId" -> AccessLevel */
  readonly sectionAccess: Readonly<Record<string, AccessLevel>>;
  /** Sub-section access overrides/grants: "tabId:sectionId:subSectionId" -> AccessLevel */
  readonly subSectionAccess: Readonly<Record<string, AccessLevel>>;
  readonly aiConfidencePct: number;
  readonly aiRationale: string;
}

export interface SupervisionMapping {
  readonly id: string;
  readonly entityId: string;          // 'ALK-CONV' | 'ALK-TKF' | 'ALK-MY' | '*'
  readonly channelCode: string;       // 'AGENCY' | 'BROKER-MARSH' | 'BANCA' | 'AGGREGATOR' | 'DIRECT' | 'REFERRAL' | 'HEAD-OFFICE' | '*'
  readonly subChannelCode: string;    // e.g. 'AGENCY-DESK-1', 'MARSH-AGENCY', 'BRANCH-RETAIL-01', '*'
  readonly department: string;
  readonly officerProfileIds: readonly string[];
  readonly supervisorProfileId: string;
  readonly managerProfileId: string;
  readonly supervisorDoaLimitMinor: bigint;
  readonly managerDoaLimitMinor: bigint;
  readonly currency: string;
  readonly active: boolean;
  readonly note: string;
  readonly updatedAt: string;
  readonly updatedBy: string;
}

export type DoaRequestStatus = 'pending' | 'approved' | 'rejected' | 'escalated';

export interface DoaApprovalStep {
  readonly at: string;
  readonly actorProfileId: string;
  readonly actorName: string;
  readonly decision: 'submitted' | 'approved' | 'rejected' | 'escalated' | 'auto-approved';
  readonly note: string;
}

export interface DoaApprovalRequest {
  readonly id: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly requesterProfileId: string;
  readonly requesterName: string;
  readonly actionKind: DoaActionKind;
  readonly subjectRef: string;
  readonly tabId: string;
  readonly sectionId?: string;
  readonly entityId: string;
  readonly channelCode: string;
  readonly subChannelCode: string;
  readonly amount: Money;
  readonly requesterLimit: Money | null;
  readonly assignedApproverProfileId: string;
  readonly escalationApproverProfileId: string;
  readonly matchedMappingId: string | null;
  readonly status: DoaRequestStatus;
  readonly reason: string;
  readonly history: readonly DoaApprovalStep[];
}

export interface ApproverNotification {
  readonly id: string;
  readonly createdAt: string;
  readonly recipientProfileId: string;
  readonly senderProfileId: string;
  readonly kind: 'doa-approval-needed' | 'doa-approved' | 'doa-rejected' | 'doa-escalated' | 'security-alert';
  readonly priority: 'high' | 'normal';
  readonly title: string;
  readonly body: string;
  readonly doaRequestId?: string;
  readonly tabId?: string;
  readonly read: boolean;
  readonly readAt?: string;
}

export interface SecurityAuditEntry {
  readonly id: string;
  readonly at: string;
  readonly actorProfileId: string;
  readonly event: string;
  readonly detail: string;
}

export interface AiAccessRecommendation {
  readonly profileId: string;
  readonly profileName: string;
  readonly confidencePct: number;
  readonly recommendedLandingTab: string;
  readonly recommendedDoaLimit: string;
  readonly recommendedDoaMinor: string | null;
  readonly recommendedSupervisorProfileId: string | null;
  readonly recommendedEscalationProfileId: string | null;
  readonly piiAccess: 'full' | 'masked' | 'own-only';
  readonly tabs: Array<{
    readonly tabId: string;
    readonly label: string;
    readonly level: AccessLevel;
    readonly scorePct: number;
    readonly reason: string;
    readonly sections: Array<{
      readonly sectionId: string;
      readonly label: string;
      readonly level: AccessLevel;
      readonly subSections: Array<{ readonly subSectionId: string; readonly label: string; readonly level: AccessLevel }>;
    }>;
  }>;
  readonly sodWarnings: string[];
  readonly summary: string;
}

export class SecurityGovernanceError extends Error {}

export const PROFILE_FAMILIES: ReadonlyArray<{ id: ProfileFamily; label: string; description: string }> = Object.freeze([
  { id: 'governance-config', label: 'Governance & Configuration', description: 'Administration (complete unrestricted access), cross-desk Supervisor and Master Configurator' },
  { id: 'underwriting-policy', label: 'Underwriting, Retention & Endorsements', description: 'Underwriting, Retention/Conservation and Policy Alteration/Endorsement officers & managers' },
  { id: 'claims-reinsurance', label: 'Claims, Settlement & Reinsurance', description: 'Claims adjudication, payout settlement release and Treaty/Facultative Reinsurance desks' },
  { id: 'finance-funds', label: 'Finance, Accounting, Cost & Funds', description: 'Bancassurance Ops, Fund Configuration, Accountant, Finance, Cost Controller & Fund Investment' },
  { id: 'agency-broker', label: 'Agency & Marsh Broker Network', description: 'Agent 1, Agent 2, Agent Marsh multi-country desk and Agent Supervisor' },
  { id: 'bancassurance-branch', label: 'Bancassurance & Bank Branches', description: 'Banca Officers 1 & 2, Banca Supervisor, Branch Officer, Branch Manager and Bank Manager' },
  { id: 'digital-partner', label: 'Digital, Direct & Referral Partners', description: 'Aggregator, Direct Self-Service Customer, Referral Partner 1 and Referral Partner 2' },
]);

/** Full 3-tier hierarchy of every Console Tab -> Section -> Sub-Section in the ERP. */
export const SECURITY_SURFACE_CATALOGUE: readonly TabCatalogueEntry[] = Object.freeze([
  {
    tabId: 'overview',
    label: 'Overview',
    sections: [
      { id: 'executive-kpis', label: 'Tenant & Executive KPIs', subSections: [{ id: 'entity-books', label: 'Entity Books Status' }, { id: 'quick-launch', label: 'Workflow Quick Launch' }] },
      { id: 'portfolio-cards', label: 'Live Portfolio Snapshots', subSections: [{ id: 'ul-snapshot', label: 'Unit-Linked Valuation' }, { id: 'takaful-snapshot', label: 'Takaful & Regulatory Gate' }] },
    ],
  },
  {
    tabId: 'access-doa',
    label: 'Access & DOA',
    sections: [
      { id: 'profile-directory', label: '36-Profile Security Directory', subSections: [{ id: 'profile-switcher', label: 'Session Switcher' }, { id: 'profile-clone', label: 'Profile Builder' }] },
      { id: 'ai-advisor', label: 'AI Access & SoD Advisor', subSections: [{ id: 'ai-scoring', label: 'Tab/Section AI Scoring' }, { id: 'sod-guard', label: 'Segregation of Duties Check' }] },
      { id: 'matrix-editor', label: 'Tab / Section / Sub-Section Matrix', subSections: [{ id: 'tab-grants', label: 'Tab Permissions' }, { id: 'section-grants', label: 'Section & Sub-Section Grants' }] },
      { id: 'supervision-map', label: 'Entity × Channel × Sub-Channel Mapping', subSections: [{ id: 'hierarchy-rules', label: 'Supervisor & Manager Chain' }, { id: 'channel-caps', label: 'Channel DOA Caps' }] },
      { id: 'doa-queue', label: 'DOA Approval Queue & Notifications', subSections: [{ id: 'doa-simulator', label: 'DOA Gate Simulator' }, { id: 'approver-inbox', label: 'Approver Decision Inbox' }] },
    ],
  },
  {
    tabId: 'journey',
    label: 'Customer journey',
    sections: [
      { id: 'onboarding-kyc', label: 'Stages 1–2: Identity, KYC & Profile', subSections: [{ id: 'identity-chip', label: 'Identity & Auto-Pick Lookup' }, { id: 'consent-residency', label: 'Consent & Tax Residency' }] },
      { id: 'needs-recommendation', label: 'Stages 3–4: Fact-Find & Product Recommendation', subSections: [{ id: 'needs-analysis', label: 'Financial Needs Analysis' }, { id: 'suitability-shelf', label: 'Ranked Product Suitability' }] },
      { id: 'coverage-pricing', label: 'Stages 5–9: Coverage, Loadings, Dependent Riders & Funds', subSections: [{ id: 'coverage-age', label: 'Cover, DOB Auto-Age & Build' }, { id: 'dependent-riders', label: 'Dependent Products & Riders' }, { id: 'fund-weights', label: 'Fund Allocation Weights' }] },
      { id: 'underwriting-decision', label: 'Stages 10–11: Beneficiaries & UW Decision', subSections: [{ id: 'beneficiary-shares', label: 'Beneficiary Nomination' }, { id: 'uw-signoff', label: 'Underwriting Decision & Referral' }] },
      { id: 'quotation-conversion', label: 'Stages 12–19: Quotation, Payment, Conversion & Servicing', subSections: [{ id: 'quote-illustration', label: 'Quotation PDF & Illustration Email' }, { id: 'payment-issue', label: 'Payment Capture & Policy Issue' }, { id: 'inforce-servicing', label: 'Allocation & Servicing Handover' }] },
    ],
  },
  {
    tabId: 'master',
    label: 'Master settings & ERP',
    sections: [
      { id: 'regional-age-autopick', label: 'Regional, Age Basis (ANB/ANxB/ALB) & Auto-Pick Rules', subSections: [{ id: 'regional-fx', label: 'Country, Timezone & Currencies' }, { id: 'age-basis-config', label: 'Age Nearest / Next / Last Setup' }, { id: 'dependent-products-config', label: 'Dependent Products Auto-Pick Setup' }] },
      { id: 'product-factory', label: 'Product Factory & Tariff Rating Engine', subSections: [{ id: 'product-grid', label: 'Editable Product Grid & Copy' }, { id: 'rating-tables', label: 'Age/Sex/Class Tariff Tables' }] },
      { id: 'omni-providers', label: 'Omni-Channel, Sub-Channels & Multi-Country Providers', subSections: [{ id: 'channels-commissions', label: 'Channels, Sub-Channels & Commission' }, { id: 'providers-branches', label: 'Carrier Branches & Conventional/Takaful Gate' }] },
      { id: 'charges-authority', label: 'Charges, Takaful Master, Authority & Vocabulary', subSections: [{ id: 'ul-charges', label: 'Unit-Linked & Takaful Fee Caps' }, { id: 'claims-authority', label: 'Claims Authority & Regulated Labels' }] },
    ],
  },
  {
    tabId: 'email',
    label: 'Email configuration',
    sections: [
      { id: 'mail-accounts', label: 'Departmental Sending Accounts', subSections: [{ id: 'account-setup', label: 'Mailbox & Env Credential Keys' }] },
      { id: 'event-routes', label: 'Business Event Routes & Delivery Test', subSections: [{ id: 'route-templates', label: 'Event Templates & Attachments' }, { id: 'live-preview', label: 'Preview & Transport Test' }] },
    ],
  },
  {
    tabId: 'policyholder',
    label: 'Policyholder',
    sections: [
      { id: 'policy-admin', label: 'Policy Conversion, Receipts & Endorsements', subSections: [{ id: 'premium-receipts', label: 'Premium Collection' }, { id: 'endorsements-retention', label: 'Financial/Non-Financial Alterations & Retention' }] },
      { id: 'look-through', label: 'Fund Look-Through & Unit Transactions', subSections: [{ id: 'instrument-exposure', label: 'Underlying Instrument Exposure' }, { id: 'dealing-audit', label: 'Unit Movement History' }] },
    ],
  },
  {
    tabId: 'decisions',
    label: 'Decision theatre',
    sections: [
      { id: 'switch-withdrawal', label: 'Switch, Withdrawal & Retention Previews', subSections: [{ id: 'fund-switch', label: 'Fund Switch Pricing' }, { id: 'partial-withdrawal', label: 'Withdrawal & Surrender Impact' }, { id: 'projection-envelopes', label: 'Adverse/Central/Favourable Envelope' }] },
    ],
  },
  {
    tabId: 'cover',
    label: 'Cover control',
    sections: [
      { id: 'micro-segments', label: 'Start/Stop Cover & Wallet Billing', subSections: [{ id: 'segment-toggle', label: 'Start / Stop Cover Toggle' }, { id: 'daily-statement', label: 'Wallet & Segment Statement' }] },
    ],
  },
  {
    tabId: 'funds',
    label: 'Funds & NAV',
    sections: [
      { id: 'nav-pricing', label: 'NAV Injection, Fund Creation & Cut-Off Rules', subSections: [{ id: 'nav-entry', label: 'Instrument Prices & Valuation Run' }, { id: 'fund-rules', label: 'Fund Creation & Shariah Screening' }] },
    ],
  },
  {
    tabId: 'funds-accounting',
    label: 'Funds accounting',
    sections: [
      { id: 'accounting-standards', label: 'Country Accounting Standards & Dynamic Vouchers', subSections: [{ id: 'account-mappings', label: 'Debit/Credit Mappings' }, { id: 'voucher-posting', label: 'Lifecycle Voucher Simulator & Post' }] },
    ],
  },
  {
    tabId: 'super-funds',
    label: 'Super funds',
    sections: [
      { id: 'super-admin', label: 'Super Accumulation, Contributions & Income Allocation', subSections: [{ id: 'member-accounts', label: 'Member Policies & Contributions' }, { id: 'monthly-economics', label: 'Fee Sweep & Pro-Rata Gain/Loss' }] },
    ],
  },
  {
    tabId: 'warehouse',
    label: 'Data warehouse',
    sections: [
      { id: 'warehouse-exports', label: 'Materialised Facts, BI Connectors & PII Masking', subSections: [{ id: 'fact-exports', label: 'CSV/JSON Fact Exports' }, { id: 'pii-security', label: 'Snowflake/BI & PII Masking Policy' }] },
    ],
  },
  {
    tabId: 'batch',
    label: 'Batch processing',
    sections: [
      { id: 'batch-engine', label: 'Scheduled Batch Setup & Execution', subSections: [{ id: 'batch-setup', label: 'GL Account Mapping per Job' }, { id: 'batch-runs', label: 'Monthly Anniversary & Clawback Runs' }] },
    ],
  },
  {
    tabId: 'takaful',
    label: 'Takaful',
    sections: [
      { id: 'takaful-pools', label: 'PRF / PIF / OPF Pools, Qard & Surplus Gate', subSections: [{ id: 'qard-pool', label: 'Pool Balances & Qard Hasan' }, { id: 'surplus-governance', label: 'Actuary / Shariah / Board Sign-Off' }] },
    ],
  },
  {
    tabId: 'group',
    label: 'Group finance',
    sections: [
      { id: 'group-consolidation', label: 'Multi-Entity Consolidation & IC Elimination', subSections: [{ id: 'fx-translation', label: 'FX Translation & Minority Interest' }, { id: 'ic-elimination', label: 'Intercompany Elimination Run' }] },
    ],
  },
  {
    tabId: 'underwriting',
    label: 'Underwriting',
    sections: [
      { id: 'proposal-quote', label: 'Proposal Registration & Auto-Picked Risk Quote', subSections: [{ id: 'proposal-entry', label: 'Customer Auto-Pick & Dependent Riders' }, { id: 'policy-conversion', label: 'Proposal-to-Policy Conversion' }] },
      { id: 'uw-adjudication', label: 'Manual Assessment, Referrals & Medical Amendment', subSections: [{ id: 'uw-decision', label: 'Underwriter Decision & AI Gate' }, { id: 'medical-amend', label: 'Questionnaire Amendment Trail' }] },
    ],
  },
  {
    tabId: 'claims',
    label: 'Claims',
    sections: [
      { id: 'fnol-triage', label: 'FNOL Registration, Triage & Reserve', subSections: [{ id: 'claim-register', label: 'Register Claim & Fraud Triage' }, { id: 'claim-reserve', label: 'Set / Revise Technical Reserve' }] },
      { id: 'adjudication-settlement', label: 'Claim Approval, Settlement Release & Recovery', subSections: [{ id: 'claim-approve', label: 'Adjudicate / Approve Within DOA' }, { id: 'claim-settle', label: 'Disburse Settlement & Subrogation' }] },
    ],
  },
  {
    tabId: 'reinsurance',
    label: 'Reinsurance',
    sections: [
      { id: 'treaty-facultative', label: 'Treaties, Cessions, Facultative & Counterparty Security', subSections: [{ id: 'treaty-admin', label: 'Quota/Surplus/XOL & Retakaful Treaties' }, { id: 'facultative-security', label: 'Facultative Placement, Cash Calls & LOC Security' }] },
    ],
  },
  {
    tabId: 'onboarding',
    label: 'Onboarding',
    sections: [
      { id: 'kyc-extraction', label: 'Chip Read, Gov Lookup & Multi-Engine OCR Queue', subSections: [{ id: 'chip-ocr', label: 'Document Extraction & Consensus' }, { id: 'review-queue', label: 'Human KYC Review Queue' }] },
    ],
  },
  {
    tabId: 'ingest',
    label: 'Ingestion',
    sections: [
      { id: 'feed-reconcile', label: 'Bank / Partner Feed Mapping & Quarantine Commit', subSections: [{ id: 'column-inference', label: 'Schema Mapping & Quarantine' }, { id: 'load-commit', label: 'Commit Reconciled Rows' }] },
    ],
  },
  {
    tabId: 'parties',
    label: 'Parties & consent',
    sections: [
      { id: 'customer-360', label: 'Centralized Golden Record, Consent & Deduplication', subSections: [{ id: 'golden-create', label: 'Create / Retrieve Customer & Profile' }, { id: 'consent-merge', label: 'Partner Consent Scope & Golden Merge' }] },
    ],
  },
  {
    tabId: 'regulatory',
    label: 'Regulatory',
    sections: [
      { id: 'compliance-filings', label: 'Pre-Sale Gates, Wording Book & Supervisor Filings', subSections: [{ id: 'presale-rules', label: 'Pre-Sale & Reinsurance Rule Checks' }, { id: 'statutory-returns', label: 'Mandated Wording & Regulator Returns' }] },
    ],
  },
  {
    tabId: 'ai',
    label: 'AI ledger',
    sections: [
      { id: 'agent-governance', label: 'Agent Action Ledger, Prohibited List & Cost Control', subSections: [{ id: 'human-gate', label: 'Approve / Reject Pending AI Actions' }, { id: 'cost-telemetry', label: 'Model Spend & Refusal Audit' }] },
    ],
  },
  {
    tabId: 'ledger',
    label: 'Books',
    sections: [
      { id: 'general-ledger', label: 'Double-Entry Trial Balance & Append-Only Journals', subSections: [{ id: 'trial-balance', label: 'Entity Trial Balance Proof' }, { id: 'journal-register', label: 'Posted Journal Entries' }] },
    ],
  },
  {
    tabId: 'labels',
    label: 'Labels & rename',
    sections: [
      { id: 'vocabulary-registry', label: 'Bilingual Label Registry & Audit Trail', subSections: [{ id: 'scoped-terms', label: 'Conventional vs Takaful Wording' }] },
    ],
  },
  {
    tabId: 'durability',
    label: 'Durability',
    sections: [
      { id: 'seal-restore', label: 'Cryptographic Snapshot Seal & Register Replay Drill', subSections: [{ id: 'ledger-drill', label: 'Seal & Rebuild Verification' }] },
    ],
  },
  {
    tabId: 'theme',
    label: 'Application theme',
    sections: [
      { id: 'brand-layers', label: 'Entity, Partner & Omni-Channel Brand Layers', subSections: [{ id: 'palette-studio', label: 'Logo Upload, AI Palette & Presets' }] },
    ],
  },
  {
    tabId: 'whats-new',
    label: "What's New",
    sections: [
      { id: 'release-ledger', label: 'Operator Change Log & Action Notes', subSections: [{ id: 'release-notes', label: 'Release History & Guidance' }] },
    ],
  },
  {
    tabId: 'tour',
    label: 'Tour',
    sections: [
      { id: 'guided-walkthrough', label: '60-Minute End-to-End Platform Walkthrough', subSections: [{ id: 'tour-steps', label: 'Timed Walkthrough Steps' }] },
    ],
  },
]);

interface ProfileSeedSpec {
  readonly id: string;
  readonly name: string;
  readonly title: string;
  readonly family: ProfileFamily;
  readonly badge: string;
  readonly summary: string;
  readonly unrestricted?: boolean;
  readonly entityScope: string;
  readonly channelScope: string;
  readonly subChannelScope: string;
  readonly defaultLandingTab: string;
  readonly reportsToProfileId: string | null;
  readonly escalationProfileId: string | null;
  readonly doaLimitAed: string | null; // null = Unlimited
  readonly doaActions: readonly DoaActionKind[];
  readonly piiAccess: 'full' | 'masked' | 'own-only';
  readonly fullTabs: readonly string[];
  readonly readTabs?: readonly string[];
  /** Restricted sub-sections or read-only section refinements (e.g. claim-officer read-only on claim-settle!) */
  readonly sectionOverrides?: Readonly<Record<string, AccessLevel>>;
  readonly subSectionOverrides?: Readonly<Record<string, AccessLevel>>;
  readonly aiConfidencePct: number;
  readonly aiRationale: string;
}

const ALL_TAB_IDS = CONSOLE_TABS.length > 0
  ? Array.from(new Set([...CONSOLE_TABS.map((t) => t.id), 'access-doa']))
  : SECURITY_SURFACE_CATALOGUE.map((c) => c.tabId);

function buildGranularMaps(spec: ProfileSeedSpec): {
  tabAccess: Record<string, AccessLevel>;
  sectionAccess: Record<string, AccessLevel>;
  subSectionAccess: Record<string, AccessLevel>;
} {
  const tabAccess: Record<string, AccessLevel> = {};
  const sectionAccess: Record<string, AccessLevel> = {};
  const subSectionAccess: Record<string, AccessLevel> = {};

  for (const tabId of ALL_TAB_IDS) {
    if (spec.unrestricted) {
      tabAccess[tabId] = 'full';
    } else if (spec.fullTabs.includes(tabId)) {
      tabAccess[tabId] = 'full';
    } else if ((spec.readTabs ?? []).includes(tabId)) {
      tabAccess[tabId] = 'read';
    } else {
      tabAccess[tabId] = 'none';
    }
  }

  for (const entry of SECURITY_SURFACE_CATALOGUE) {
    const baseLevel: AccessLevel = spec.unrestricted ? 'full' : (tabAccess[entry.tabId] ?? 'none');
    for (const sec of entry.sections) {
      const sKey = `${entry.tabId}:${sec.id}`;
      const secLevel: AccessLevel = spec.unrestricted
        ? 'full'
        : (spec.sectionOverrides?.[sKey] ?? baseLevel);
      sectionAccess[sKey] = secLevel;
      for (const sub of sec.subSections) {
        const subKey = `${entry.tabId}:${sec.id}:${sub.id}`;
        subSectionAccess[subKey] = spec.unrestricted
          ? 'full'
          : (spec.subSectionOverrides?.[subKey] ?? secLevel);
      }
    }
  }
  return { tabAccess, sectionAccess, subSectionAccess };
}

/** Complete catalogue of all 36 enterprise profiles requested for the Insurance ERP. */
const PROFILE_SEEDS: readonly ProfileSeedSpec[] = [
  // ======================== 1. GOVERNANCE & CONFIGURATION (3) ========================
  {
    id: 'administration',
    name: 'Administration',
    title: 'Chief Platform & Security Administrator (Complete Access)',
    family: 'governance-config',
    badge: 'FULL UNRESTRICTED ACCESS',
    summary: 'Complete unrestricted superuser access across all 29 tabs, all sections & sub-sections, Master Settings, RBAC & DOA governance, and unlimited override authority.',
    unrestricted: true,
    entityScope: '*',
    channelScope: '*',
    subChannelScope: '*',
    defaultLandingTab: 'overview',
    reportsToProfileId: null,
    escalationProfileId: null,
    doaLimitAed: null,
    doaActions: [
      'underwriting-approval', 'quote-high-sum-assured', 'discount-concession', 'retention-waiver',
      'endorsement-alteration', 'claim-approval', 'settlement-release', 'reinsurance-placement',
      'fund-nav-signoff', 'accounting-voucher', 'master-config-change', 'restricted-section-access',
    ],
    piiAccess: 'full',
    fullTabs: ALL_TAB_IDS,
    aiConfidencePct: 100,
    aiRationale: 'Root enterprise administrator: full read/write/approve across every operational, actuarial, financial and governance surface.',
  },
  {
    id: 'supervisor',
    name: 'Supervisor',
    title: 'Cross-Operations & Distribution Supervisor',
    family: 'governance-config',
    badge: 'CROSS-DESK SUPERVISOR',
    summary: 'Cross-functional supervision over operational queues, customer journeys, escalations, AI human-in-the-loop reviews and first-line DOA approvals.',
    entityScope: '*',
    channelScope: '*',
    subChannelScope: '*',
    defaultLandingTab: 'access-doa',
    reportsToProfileId: 'administration',
    escalationProfileId: 'administration',
    doaLimitAed: '1,500,000.00',
    doaActions: ['quote-high-sum-assured', 'discount-concession', 'endorsement-alteration', 'restricted-section-access'],
    piiAccess: 'full',
    fullTabs: ['overview', 'access-doa', 'journey', 'policyholder', 'onboarding', 'parties', 'ingest', 'ai'],
    readTabs: ['underwriting', 'claims', 'email', 'warehouse', 'whats-new', 'tour'],
    aiConfidencePct: 96,
    aiRationale: 'Cross-desk queue oversight, human AI review, DOA inbox management, and read-only visibility into technical claims/underwriting.',
  },
  {
    id: 'configurator',
    name: 'Configurator',
    title: 'Product, Rating, Wording & Platform Configurator',
    family: 'governance-config',
    badge: 'MASTER CONFIGURATOR',
    summary: 'Configures product shelf, tariff tables, age calculation rules (ANB/ANxB/ALB), dependent product rules, omni-channels, providers, email templates and branding.',
    entityScope: '*',
    channelScope: '*',
    subChannelScope: '*',
    defaultLandingTab: 'master',
    reportsToProfileId: 'administration',
    escalationProfileId: 'administration',
    doaLimitAed: '500,000.00',
    doaActions: ['master-config-change'],
    piiAccess: 'masked',
    fullTabs: ['master', 'email', 'labels', 'theme'],
    readTabs: ['overview', 'journey', 'funds', 'regulatory', 'access-doa', 'whats-new', 'tour'],
    aiConfidencePct: 98,
    aiRationale: 'Full control over non-cash configuration surfaces while masking customer PII and blocking direct claim payouts or GL postings (SoD safe).',
  },

  // ======================== 2. UNDERWRITING, RETENTION & ENDORSEMENTS (6) ========================
  {
    id: 'underwriter-officer',
    name: 'Underwriter Officer',
    title: 'Life, Medical & General Risk Underwriter Officer',
    family: 'underwriting-policy',
    badge: 'UW OFFICER',
    summary: 'Evaluates proposals, medical evidence, BMI/occupation loadings and issues standard/rated decisions within officer DOA; refers higher risks to Underwriter Manager.',
    entityScope: 'ALK-CONV',
    channelScope: 'HEAD-OFFICE',
    subChannelScope: 'UW-DESK',
    defaultLandingTab: 'underwriting',
    reportsToProfileId: 'underwriter-manager',
    escalationProfileId: 'reinsurance-manager',
    doaLimitAed: '500,000.00',
    doaActions: ['underwriting-approval', 'quote-high-sum-assured'],
    piiAccess: 'full',
    fullTabs: ['underwriting', 'onboarding'],
    readTabs: ['overview', 'journey', 'parties', 'reinsurance', 'regulatory', 'access-doa'],
    subSectionOverrides: { 'underwriting:proposal-quote:policy-conversion': 'read' },
    aiConfidencePct: 97,
    aiRationale: 'Full risk scoring, medical questionnaire review and standard binding up to 500k AED; escalates jumbo risks automatically to Underwriter Manager.',
  },
  {
    id: 'underwriter-manager',
    name: 'Underwriter Manager',
    title: 'Head of Underwriting & Chief Risk Signatory',
    family: 'underwriting-policy',
    badge: 'UW MANAGER · APPROVER',
    summary: 'Approves high-sum-assured proposals, substandard mortality loadings, medical waivers and agent/banca underwriting referrals up to treaty limits.',
    entityScope: '*',
    channelScope: '*',
    subChannelScope: 'UW-DESK',
    defaultLandingTab: 'underwriting',
    reportsToProfileId: 'administration',
    escalationProfileId: 'reinsurance-manager',
    doaLimitAed: '5,000,000.00',
    doaActions: ['underwriting-approval', 'quote-high-sum-assured', 'discount-concession'],
    piiAccess: 'full',
    fullTabs: ['overview', 'underwriting', 'journey', 'onboarding', 'parties', 'ai', 'access-doa'],
    readTabs: ['reinsurance', 'regulatory', 'policyholder', 'master'],
    aiConfidencePct: 99,
    aiRationale: 'Full underwriting authority up to 5M AED across Conventional & Takaful books, plus human sign-off on AI referrals and officer escalations.',
  },
  {
    id: 'retention-officer',
    name: 'Retention Office',
    title: 'Policy Conservation & Renewal Retention Officer',
    family: 'underwriting-policy',
    badge: 'RETENTION OFFICER',
    summary: 'Manages policy conservation, renewal outreach, surrender rescue illustrations, fund switches and fee-waiver concessions within retention officer DOA.',
    entityScope: '*',
    channelScope: 'HEAD-OFFICE',
    subChannelScope: 'RETENTION-DESK',
    defaultLandingTab: 'decisions',
    reportsToProfileId: 'retention-manager',
    escalationProfileId: 'administration',
    doaLimitAed: '15,000.00',
    doaActions: ['retention-waiver', 'discount-concession'],
    piiAccess: 'full',
    fullTabs: ['policyholder', 'decisions', 'cover'],
    readTabs: ['overview', 'journey', 'parties', 'email', 'funds', 'access-doa'],
    subSectionOverrides: { 'policyholder:policy-admin:endorsements-retention': 'full' },
    aiConfidencePct: 95,
    aiRationale: 'Equipped with Decision Theatre switch/withdrawal previews, Policyholder conservation tools and Cover Control, escalating fee waivers >15k AED to Retention Manager.',
  },
  {
    id: 'retention-manager',
    name: 'Retention Manager',
    title: 'Head of Portfolio Persistency & Retention',
    family: 'underwriting-policy',
    badge: 'RETENTION MANAGER · APPROVER',
    summary: 'Oversees renewal persistency, conservation campaigns, surrender rescue DOA concessions and retention email triggers across all channels.',
    entityScope: '*',
    channelScope: '*',
    subChannelScope: 'RETENTION-DESK',
    defaultLandingTab: 'policyholder',
    reportsToProfileId: 'administration',
    escalationProfileId: 'administration',
    doaLimitAed: '150,000.00',
    doaActions: ['retention-waiver', 'discount-concession', 'endorsement-alteration'],
    piiAccess: 'full',
    fullTabs: ['overview', 'policyholder', 'decisions', 'cover', 'email', 'access-doa'],
    readTabs: ['journey', 'parties', 'warehouse', 'batch'],
    aiConfidencePct: 96,
    aiRationale: 'Approves retention waivers up to 150k AED with full visibility into persistency cohorts, renewal email routes and policyholder look-through.',
  },
  {
    id: 'endorsement-officer',
    name: 'Endorsement Officer',
    title: 'Policy Alterations & Endorsement Officer',
    family: 'underwriting-policy',
    badge: 'ENDORSEMENT OFFICER',
    summary: 'Processes non-financial changes (address, beneficiary, contact) and financial endorsements (sum assured, riders, payment frequency) within DOA.',
    entityScope: '*',
    channelScope: 'HEAD-OFFICE',
    subChannelScope: 'ENDORSEMENT-DESK',
    defaultLandingTab: 'policyholder',
    reportsToProfileId: 'endorsement-supervisor',
    escalationProfileId: 'underwriter-manager',
    doaLimitAed: '50,000.00',
    doaActions: ['endorsement-alteration'],
    piiAccess: 'full',
    fullTabs: ['policyholder', 'parties', 'cover'],
    readTabs: ['overview', 'decisions', 'underwriting', 'email', 'access-doa'],
    aiConfidencePct: 96,
    aiRationale: 'Direct access to Policyholder alterations, Customer 360 updates and Cover segments; financial alterations above 50k AED route to Endorsement Supervisor.',
  },
  {
    id: 'endorsement-supervisor',
    name: 'Endorsement Supervisor',
    title: 'Policy Servicing & Endorsement Supervisor',
    family: 'underwriting-policy',
    badge: 'ENDORSEMENT SUPERVISOR · APPROVER',
    summary: 'Supervises policy servicing SLAs and approves high-value financial alterations, backdated endorsements and beneficiary overrides.',
    entityScope: '*',
    channelScope: '*',
    subChannelScope: 'ENDORSEMENT-DESK',
    defaultLandingTab: 'policyholder',
    reportsToProfileId: 'underwriter-manager',
    escalationProfileId: 'administration',
    doaLimitAed: '500,000.00',
    doaActions: ['endorsement-alteration', 'retention-waiver'],
    piiAccess: 'full',
    fullTabs: ['overview', 'policyholder', 'parties', 'decisions', 'cover', 'access-doa'],
    readTabs: ['underwriting', 'email', 'funds', 'ledger'],
    aiConfidencePct: 97,
    aiRationale: 'Approves financial endorsements up to 500k AED and escalates underwriting-impacting increases above 500k AED to Underwriter Manager.',
  },

  // ======================== 3. CLAIMS, SETTLEMENT & REINSURANCE (6) ========================
  {
    id: 'claim-officer',
    name: 'Claim Officer',
    title: 'Claims FNOL, Triage & Assessment Officer',
    family: 'claims-reinsurance',
    badge: 'CLAIM OFFICER',
    summary: 'Registers FNOL claims, verifies cover/exclusions, sets initial technical reserves and approves straightforward claims up to officer DOA.',
    entityScope: '*',
    channelScope: 'HEAD-OFFICE',
    subChannelScope: 'CLAIMS-DESK',
    defaultLandingTab: 'claims',
    reportsToProfileId: 'claim-manager',
    escalationProfileId: 'settlement-manager',
    doaLimitAed: '50,000.00',
    doaActions: ['claim-approval'],
    piiAccess: 'full',
    fullTabs: ['claims'],
    readTabs: ['overview', 'policyholder', 'parties', 'cover', 'underwriting', 'access-doa'],
    subSectionOverrides: { 'claims:adjudication-settlement:claim-settle': 'read' },
    aiConfidencePct: 98,
    aiRationale: 'Segregation of Duties enforced: Claim Officer assesses & approves within 50k AED but cash disbursement belongs to Settlement Desk; >50k AED routes to Claim Manager.',
  },
  {
    id: 'claim-manager',
    name: 'Claim Manager',
    title: 'Head of Claims Adjudication & Technical Reserves',
    family: 'claims-reinsurance',
    badge: 'CLAIM MANAGER · APPROVER',
    summary: 'Adjudicates complex/high-severity Conventional & Takaful claims, signs off reserves, declines invalid claims with rationale and triggers reinsurance recovery.',
    entityScope: '*',
    channelScope: '*',
    subChannelScope: 'CLAIMS-DESK',
    defaultLandingTab: 'claims',
    reportsToProfileId: 'administration',
    escalationProfileId: 'settlement-manager',
    doaLimitAed: '500,000.00',
    doaActions: ['claim-approval'],
    piiAccess: 'full',
    fullTabs: ['overview', 'claims', 'takaful', 'ai', 'access-doa'],
    readTabs: ['policyholder', 'reinsurance', 'parties', 'regulatory', 'ledger'],
    subSectionOverrides: { 'claims:adjudication-settlement:claim-settle': 'read' },
    aiConfidencePct: 99,
    aiRationale: 'Full adjudication authority up to 500k AED across Conventional & Takaful pools while preserving four-eyes separation from Settlement cash release.',
  },
  {
    id: 'settlement-officer',
    name: 'Settlement Officer',
    title: 'Claims, Maturity & Surrender Settlement Officer',
    family: 'claims-reinsurance',
    badge: 'SETTLEMENT OFFICER',
    summary: 'Verifies discharge vouchers, payee IBAN/KYC and releases approved claim, maturity and surrender settlements up to officer disbursement DOA.',
    entityScope: '*',
    channelScope: 'HEAD-OFFICE',
    subChannelScope: 'SETTLEMENT-DESK',
    defaultLandingTab: 'claims',
    reportsToProfileId: 'settlement-manager',
    escalationProfileId: 'finance',
    doaLimitAed: '100,000.00',
    doaActions: ['settlement-release'],
    piiAccess: 'full',
    fullTabs: ['claims', 'policyholder'],
    readTabs: ['overview', 'parties', 'ledger', 'funds-accounting', 'access-doa'],
    subSectionOverrides: { 'claims:adjudication-settlement:claim-approve': 'read', 'claims:adjudication-settlement:claim-settle': 'full' },
    aiConfidencePct: 97,
    aiRationale: 'Four-eyes payout control: executes settlement disbursements up to 100k AED on already-adjudicated claims and routes larger releases to Settlement Manager.',
  },
  {
    id: 'settlement-manager',
    name: 'Settlement Manager',
    title: 'Head of Disbursements, Settlements & Subrogation',
    family: 'claims-reinsurance',
    badge: 'SETTLEMENT MANAGER · APPROVER',
    summary: 'Authorizes high-value claim payouts, maturity/surrender batch disbursements, salvage/subrogation recoveries and treasury payment releases.',
    entityScope: '*',
    channelScope: '*',
    subChannelScope: 'SETTLEMENT-DESK',
    defaultLandingTab: 'claims',
    reportsToProfileId: 'finance',
    escalationProfileId: 'administration',
    doaLimitAed: '2,000,000.00',
    doaActions: ['settlement-release', 'accounting-voucher'],
    piiAccess: 'full',
    fullTabs: ['overview', 'claims', 'policyholder', 'batch', 'access-doa'],
    readTabs: ['ledger', 'funds-accounting', 'reinsurance', 'parties'],
    aiConfidencePct: 98,
    aiRationale: 'High-value settlement release up to 2M AED with visibility into GL books, batch payment runs and reinsurance recoveries.',
  },
  {
    id: 'reinsurance-officer',
    name: 'Reinsurance Officer',
    title: 'Treaty Administration, Cession & Facultative Officer',
    family: 'claims-reinsurance',
    badge: 'REINSURANCE OFFICER',
    summary: 'Administers quota-share/surplus/XOL cessions, retakaful treaties, facultative placements, cash calls and LOC security tracking within officer DOA.',
    entityScope: '*',
    channelScope: 'HEAD-OFFICE',
    subChannelScope: 'REINSURANCE-DESK',
    defaultLandingTab: 'reinsurance',
    reportsToProfileId: 'reinsurance-manager',
    escalationProfileId: 'administration',
    doaLimitAed: '1,000,000.00',
    doaActions: ['reinsurance-placement'],
    piiAccess: 'masked',
    fullTabs: ['reinsurance'],
    readTabs: ['overview', 'underwriting', 'claims', 'takaful', 'regulatory', 'access-doa'],
    aiConfidencePct: 97,
    aiRationale: 'Full access to treaty bordereaux, facultative placement prep and collateral monitoring up to 1M AED; routes treaty changes & >1M placements to Reinsurance Manager.',
  },
  {
    id: 'reinsurance-manager',
    name: 'Reinsurance Manager',
    title: 'Head of Reinsurance, Retakaful & Counterparty Security',
    family: 'claims-reinsurance',
    badge: 'REINSURANCE MANAGER · APPROVER',
    summary: 'Approves treaty structures, net retention limits, jumbo facultative bindings, catastrophe reinstatements, cash calls and regulatory reinsurance filings.',
    entityScope: '*',
    channelScope: '*',
    subChannelScope: 'REINSURANCE-DESK',
    defaultLandingTab: 'reinsurance',
    reportsToProfileId: 'administration',
    escalationProfileId: 'administration',
    doaLimitAed: '10,000,000.00',
    doaActions: ['reinsurance-placement', 'underwriting-approval'],
    piiAccess: 'masked',
    fullTabs: ['overview', 'reinsurance', 'takaful', 'regulatory', 'access-doa'],
    readTabs: ['underwriting', 'claims', 'group', 'ledger', 'warehouse'],
    aiConfidencePct: 99,
    aiRationale: 'Authorizes ceded placements & security releases up to 10M AED with full UAE reinsurance rule-book and statutory return access.',
  },

  // ======================== 4. BANCASSURANCE OPS, FINANCE & FUNDS (7) ========================
  {
    id: 'bancassurance-operations-officer',
    name: 'Bancassurance Operation Officer',
    title: 'Bancassurance Middle-Office & Bank Feed Operations Officer',
    family: 'finance-funds',
    badge: 'BANCA OPS OFFICER',
    summary: 'Reconciles daily bank feed files, clears quarantined rows, supports bank policy issuance, bank direct-debit batch runs and branch servicing requests.',
    entityScope: '*',
    channelScope: 'BANCA',
    subChannelScope: '*',
    defaultLandingTab: 'ingest',
    reportsToProfileId: 'banca-supervisor',
    escalationProfileId: 'bank-manager',
    doaLimitAed: '250,000.00',
    doaActions: ['endorsement-alteration', 'accounting-voucher'],
    piiAccess: 'full',
    fullTabs: ['ingest', 'onboarding', 'journey', 'policyholder', 'batch'],
    readTabs: ['overview', 'parties', 'email', 'warehouse', 'access-doa'],
    aiConfidencePct: 96,
    aiRationale: 'Tailored for bank middle-office operations: Ingestion feed reconciliation, KYC queue, Policy issuance & Batch sweeps, reporting to Banca Supervisor.',
  },
  {
    id: 'fund-configuration',
    name: 'Fund Configuration',
    title: 'Unit-Linked & Superannuation Fund Configuration Specialist',
    family: 'finance-funds',
    badge: 'FUND CONFIG',
    summary: 'Configures unit-linked funds, Super investment products, dealing cut-offs, FMC basis points, Shariah screening flags and fund-to-product mappings.',
    entityScope: '*',
    channelScope: 'HEAD-OFFICE',
    subChannelScope: 'FUNDS-DESK',
    defaultLandingTab: 'funds',
    reportsToProfileId: 'fund-investment-manager',
    escalationProfileId: 'administration',
    doaLimitAed: '250,000.00',
    doaActions: ['fund-nav-signoff', 'master-config-change'],
    piiAccess: 'masked',
    fullTabs: ['funds', 'super-funds', 'funds-accounting'],
    readTabs: ['overview', 'master', 'takaful', 'policyholder', 'access-doa'],
    aiConfidencePct: 97,
    aiRationale: 'Focused control over Funds, Super Funds and Fund Accounting rules while escalating live fee or valuation sign-offs >250k AED to Fund Investment Manager.',
  },
  {
    id: 'accountant',
    name: 'Accountant',
    title: 'Financial & Policy Ledger Accountant',
    family: 'finance-funds',
    badge: 'ACCOUNTANT',
    summary: 'Maintains chart of accounts mappings, posts balanced vouchers, verifies trial balances, runs monthly accounting batches and prepares statutory extracts.',
    entityScope: '*',
    channelScope: 'HEAD-OFFICE',
    subChannelScope: 'FINANCE-DESK',
    defaultLandingTab: 'ledger',
    reportsToProfileId: 'finance',
    escalationProfileId: 'administration',
    doaLimitAed: '100,000.00',
    doaActions: ['accounting-voucher'],
    piiAccess: 'masked',
    fullTabs: ['ledger', 'funds-accounting', 'batch'],
    readTabs: ['overview', 'group', 'takaful', 'warehouse', 'claims', 'reinsurance', 'access-doa'],
    aiConfidencePct: 98,
    aiRationale: 'Full access to double-entry Books, Funds Accounting vouchers and scheduled Batch postings within 100k AED; >100k AED routes to Finance.',
  },
  {
    id: 'finance',
    name: 'Finance',
    title: 'Head of Finance, Group Consolidation & Treasury',
    family: 'finance-funds',
    badge: 'FINANCE LEAD · APPROVER',
    summary: 'Governs multi-entity IFRS/local consolidation, FX translation reserves, intercompany eliminations, treasury releases, statutory filings and accounting approvals.',
    entityScope: '*',
    channelScope: '*',
    subChannelScope: 'FINANCE-DESK',
    defaultLandingTab: 'group',
    reportsToProfileId: 'administration',
    escalationProfileId: 'administration',
    doaLimitAed: '2,500,000.00',
    doaActions: ['accounting-voucher', 'settlement-release'],
    piiAccess: 'masked',
    fullTabs: ['overview', 'group', 'ledger', 'funds-accounting', 'batch', 'warehouse', 'durability', 'access-doa'],
    readTabs: ['takaful', 'super-funds', 'claims', 'reinsurance', 'regulatory', 'master'],
    aiConfidencePct: 99,
    aiRationale: 'Full group finance, ledger proof, voucher approval up to 2.5M AED and cryptographic durability verification.',
  },
  {
    id: 'cost-controller',
    name: 'Cost Controller',
    title: 'Acquisition Cost, Commission, Fee & AI Spend Controller',
    family: 'finance-funds',
    badge: 'COST CONTROLLER · APPROVER',
    summary: 'Controls partner/channel commission schedules, clawback rules, policy admin/allocation charges, expense budgets and AI token/agent spend governance.',
    entityScope: '*',
    channelScope: '*',
    subChannelScope: 'FINANCE-DESK',
    defaultLandingTab: 'warehouse',
    reportsToProfileId: 'finance',
    escalationProfileId: 'administration',
    doaLimitAed: '500,000.00',
    doaActions: ['discount-concession', 'retention-waiver', 'accounting-voucher'],
    piiAccess: 'masked',
    fullTabs: ['warehouse', 'ai', 'batch'],
    readTabs: ['overview', 'group', 'ledger', 'funds-accounting', 'super-funds', 'master', 'access-doa'],
    subSectionOverrides: {
      'master:omni-providers:channels-commissions': 'full',
      'master:charges-authority:ul-charges': 'full',
    },
    aiConfidencePct: 96,
    aiRationale: 'Pinpoint visibility into commission schedules, charge tables, clawback batches, warehouse cost lineage and AI spend telemetry.',
  },
  {
    id: 'fund-investment-officer',
    name: 'Fund Investment Office',
    title: 'Portfolio Valuation, NAV Pricing & Dealing Officer',
    family: 'finance-funds',
    badge: 'FUND INVESTMENT OFFICER',
    summary: 'Records daily market instrument prices, runs unit-linked NAV calculations, checks Shariah asset screens and executes member dealing allocations.',
    entityScope: '*',
    channelScope: 'HEAD-OFFICE',
    subChannelScope: 'FUNDS-DESK',
    defaultLandingTab: 'funds',
    reportsToProfileId: 'fund-investment-manager',
    escalationProfileId: 'finance',
    doaLimitAed: '500,000.00',
    doaActions: ['fund-nav-signoff'],
    piiAccess: 'masked',
    fullTabs: ['funds', 'super-funds', 'decisions'],
    readTabs: ['overview', 'policyholder', 'funds-accounting', 'takaful', 'access-doa'],
    aiConfidencePct: 97,
    aiRationale: 'Operational NAV valuation, look-through pricing and Super investment runs up to 500k AED; escalates seed/rebalance sign-off to Fund Investment Manager.',
  },
  {
    id: 'fund-investment-manager',
    name: 'Fund Investment Manager',
    title: 'Chief Investment Officer & Fund Governance Approver',
    family: 'finance-funds',
    badge: 'FUND INVESTMENT MANAGER · APPROVER',
    summary: 'Approves daily NAV publication exceptions, Super fund income/loss distributions, Shariah portfolio purification actions and fund launches up to 10M AED.',
    entityScope: '*',
    channelScope: '*',
    subChannelScope: 'FUNDS-DESK',
    defaultLandingTab: 'funds',
    reportsToProfileId: 'administration',
    escalationProfileId: 'administration',
    doaLimitAed: '10,000,000.00',
    doaActions: ['fund-nav-signoff', 'accounting-voucher', 'master-config-change'],
    piiAccess: 'masked',
    fullTabs: ['overview', 'funds', 'super-funds', 'funds-accounting', 'takaful', 'decisions', 'access-doa'],
    readTabs: ['policyholder', 'warehouse', 'ledger', 'group'],
    aiConfidencePct: 99,
    aiRationale: 'Full investment governance across Unit-Linked, Takaful PIF and Superannuation portfolios with 10M AED DOA authority.',
  },

  // ======================== 5. AGENCY & MARSH BROKER NETWORK (4) ========================
  {
    id: 'agent-1',
    name: 'Agent 1',
    title: 'Tied Life & Wealth Advisor — Agency Desk 1 (Conventional)',
    family: 'agency-broker',
    badge: 'TIED AGENT · DESK 1',
    summary: 'Conducts customer onboarding, fact-find needs analysis, suitability recommendations, benefit illustrations, quotations and proposal submissions on Agency Desk 1.',
    entityScope: 'ALK-CONV',
    channelScope: 'AGENCY',
    subChannelScope: 'AGENCY-DESK-1',
    defaultLandingTab: 'journey',
    reportsToProfileId: 'agent-supervisor',
    escalationProfileId: 'underwriter-manager',
    doaLimitAed: '250,000.00',
    doaActions: ['quote-high-sum-assured', 'discount-concession'],
    piiAccess: 'full',
    fullTabs: ['journey', 'onboarding', 'parties', 'decisions'],
    readTabs: ['overview', 'policyholder', 'cover', 'access-doa'],
    subSectionOverrides: {
      'journey:underwriting-decision:uw-signoff': 'read',
      'parties:customer-360:consent-merge': 'read',
    },
    aiConfidencePct: 98,
    aiRationale: 'Frontline sales productivity on Agency Desk 1 without underwriting self-approval; quotes >250k AED or fee concessions notify Agent Supervisor immediately.',
  },
  {
    id: 'agent-2',
    name: 'Agent 2',
    title: 'Family Takaful & Protection Advisor — Agency Desk 2',
    family: 'agency-broker',
    badge: 'TAKAFUL & LIFE AGENT · DESK 2',
    summary: 'Advises Conventional & Family Takaful clients on Agency Desk 2 across customer onboarding, Shariah-screened fund illustrations and policy applications.',
    entityScope: 'ALK-TKF',
    channelScope: 'AGENCY',
    subChannelScope: 'AGENCY-DESK-2',
    defaultLandingTab: 'journey',
    reportsToProfileId: 'agent-supervisor',
    escalationProfileId: 'underwriter-manager',
    doaLimitAed: '250,000.00',
    doaActions: ['quote-high-sum-assured', 'discount-concession'],
    piiAccess: 'full',
    fullTabs: ['journey', 'onboarding', 'parties', 'decisions'],
    readTabs: ['overview', 'policyholder', 'takaful', 'cover', 'access-doa'],
    subSectionOverrides: {
      'journey:underwriting-decision:uw-signoff': 'read',
      'parties:customer-360:consent-merge': 'read',
    },
    aiConfidencePct: 98,
    aiRationale: 'Scoped to Agency Desk 2 with Takaful pool read visibility for transparent Wakalah/Tabarru client disclosures; supervised by Agent Supervisor.',
  },
  {
    id: 'agent-marsh',
    name: 'Agent Marsh',
    title: 'Marsh Multinational Broker Producer (UAE / UK / Singapore Shelf)',
    family: 'agency-broker',
    badge: 'BROKER · MARSH DESK',
    summary: 'Places multinational corporate & high-net-worth risks under licensed Marsh Call-Centre and Marsh Agency sub-channels with country/currency sellability enforcement.',
    entityScope: 'ALK-CONV',
    channelScope: 'BROKER-MARSH',
    subChannelScope: 'MARSH-AGENCY',
    defaultLandingTab: 'journey',
    reportsToProfileId: 'agent-supervisor',
    escalationProfileId: 'underwriter-manager',
    doaLimitAed: '1,000,000.00',
    doaActions: ['quote-high-sum-assured', 'discount-concession'],
    piiAccess: 'full',
    fullTabs: ['journey', 'underwriting', 'onboarding', 'parties', 'decisions'],
    readTabs: ['overview', 'policyholder', 'reinsurance', 'regulatory', 'access-doa'],
    subSectionOverrides: {
      'underwriting:uw-adjudication:uw-decision': 'read',
      'master:omni-providers:providers-branches': 'read',
    },
    aiConfidencePct: 99,
    aiRationale: 'Aligned with the Marsh multi-country broker setup (Conventional allowed on MARSH-AGENCY; both books on MARSH-CALL-CENTRE) with 1M AED broker quote threshold.',
  },
  {
    id: 'agent-supervisor',
    name: 'Agent Supervisor',
    title: 'Agency & Broker Distribution Supervisor (Approver)',
    family: 'agency-broker',
    badge: 'AGENT SUPERVISOR · APPROVER',
    summary: 'Supervises Agent 1, Agent 2 and Agent Marsh across Agency & Broker channels; approves commission concessions, large quotes and rider waivers up to 1.5M AED.',
    entityScope: '*',
    channelScope: 'AGENCY',
    subChannelScope: '*',
    defaultLandingTab: 'access-doa',
    reportsToProfileId: 'underwriter-manager',
    escalationProfileId: 'administration',
    doaLimitAed: '1,500,000.00',
    doaActions: ['quote-high-sum-assured', 'discount-concession', 'retention-waiver'],
    piiAccess: 'full',
    fullTabs: ['overview', 'access-doa', 'journey', 'onboarding', 'parties', 'decisions'],
    readTabs: ['underwriting', 'policyholder', 'warehouse', 'master'],
    aiConfidencePct: 98,
    aiRationale: 'First-line DOA approver for all Agency & Marsh broker producers up to 1.5M AED, escalating technical risk decisions above cap to Underwriter Manager.',
  },

  // ======================== 6. BANCASSURANCE & BANK BRANCH NETWORK (6) ========================
  {
    id: 'banca-officer-1',
    name: 'Banca Officer 1',
    title: 'Bancassurance Wealth Specialist — Premier Bank Desk 1',
    family: 'bancassurance-branch',
    badge: 'BANCA OFFICER 1',
    summary: 'Originates unit-linked wealth, mortgage protection and endowment plans for premier bank customers on Bancassurance Desk 1.',
    entityScope: 'ALK-CONV',
    channelScope: 'BANCA',
    subChannelScope: 'BANCA-PREMIER-1',
    defaultLandingTab: 'journey',
    reportsToProfileId: 'banca-supervisor',
    escalationProfileId: 'bank-manager',
    doaLimitAed: '300,000.00',
    doaActions: ['quote-high-sum-assured', 'discount-concession'],
    piiAccess: 'full',
    fullTabs: ['journey', 'onboarding', 'parties', 'decisions'],
    readTabs: ['overview', 'policyholder', 'funds', 'access-doa'],
    subSectionOverrides: { 'journey:underwriting-decision:uw-signoff': 'read' },
    aiConfidencePct: 97,
    aiRationale: 'Scoped to BANCA-PREMIER-1 with customer auto-pick, fund look-through visibility and 300k AED straight-through quote cap; reports to Banca Supervisor.',
  },
  {
    id: 'banca-officer-2',
    name: 'Banca Officer 2',
    title: 'Bancatakaful & Retail Protection Specialist — Islamic Bank Desk 2',
    family: 'bancassurance-branch',
    badge: 'BANCA OFFICER 2',
    summary: 'Originates Family Takaful savings, credit takaful and retail protection plans on Bancassurance Islamic Desk 2.',
    entityScope: 'ALK-TKF',
    channelScope: 'BANCA',
    subChannelScope: 'BANCA-ISLAMIC-2',
    defaultLandingTab: 'journey',
    reportsToProfileId: 'banca-supervisor',
    escalationProfileId: 'bank-manager',
    doaLimitAed: '300,000.00',
    doaActions: ['quote-high-sum-assured', 'discount-concession'],
    piiAccess: 'full',
    fullTabs: ['journey', 'onboarding', 'parties', 'decisions'],
    readTabs: ['overview', 'policyholder', 'takaful', 'funds', 'access-doa'],
    subSectionOverrides: { 'journey:underwriting-decision:uw-signoff': 'read' },
    aiConfidencePct: 97,
    aiRationale: 'Scoped to BANCA-ISLAMIC-2 with Shariah fund & Takaful pool visibility; routes >300k AED cases automatically to Banca Supervisor.',
  },
  {
    id: 'banca-supervisor',
    name: 'Banca Supervisor',
    title: 'Bancassurance Channel Supervisor (Approver)',
    family: 'bancassurance-branch',
    badge: 'BANCA SUPERVISOR · APPROVER',
    summary: 'Supervises Banca Officer 1, Banca Officer 2 and Bancassurance Operations across bank sub-channels; approves banca quotes & concessions up to 1.5M AED.',
    entityScope: '*',
    channelScope: 'BANCA',
    subChannelScope: '*',
    defaultLandingTab: 'access-doa',
    reportsToProfileId: 'bank-manager',
    escalationProfileId: 'underwriter-manager',
    doaLimitAed: '1,500,000.00',
    doaActions: ['quote-high-sum-assured', 'discount-concession', 'endorsement-alteration'],
    piiAccess: 'full',
    fullTabs: ['overview', 'access-doa', 'journey', 'onboarding', 'parties', 'ingest', 'decisions'],
    readTabs: ['underwriting', 'policyholder', 'warehouse', 'batch'],
    aiConfidencePct: 98,
    aiRationale: 'Supervises all bancassurance specialists and feed operations up to 1.5M AED, escalating larger private-bank cases to Bank Manager.',
  },
  {
    id: 'branch-officer',
    name: 'Branch Officer',
    title: 'Retail Bank Branch Insurance Officer',
    family: 'bancassurance-branch',
    badge: 'BRANCH OFFICER',
    summary: 'Handles walk-in retail bank customer KYC capture, auto-picked needs check, simple protection/motor quotes and branch referrals.',
    entityScope: 'ALK-CONV',
    channelScope: 'BANCA',
    subChannelScope: 'BRANCH-RETAIL-01',
    defaultLandingTab: 'journey',
    reportsToProfileId: 'branch-manager',
    escalationProfileId: 'bank-manager',
    doaLimitAed: '150,000.00',
    doaActions: ['quote-high-sum-assured'],
    piiAccess: 'full',
    fullTabs: ['journey', 'onboarding', 'parties'],
    readTabs: ['overview', 'cover', 'access-doa'],
    subSectionOverrides: {
      'journey:underwriting-decision:uw-signoff': 'read',
      'parties:customer-360:consent-merge': 'read',
    },
    aiConfidencePct: 96,
    aiRationale: 'Streamlined branch desk footprint with 150k AED walk-in DOA; cases above 150k AED notify Branch Manager immediately.',
  },
  {
    id: 'branch-manager',
    name: 'Branch Manager',
    title: 'Bank Branch Manager — BranchBancassurance Approver',
    family: 'bancassurance-branch',
    badge: 'BRANCH MANAGER · APPROVER',
    summary: 'Manages branch insurance production, supervises Branch Officers, reviews customer suitability sign-offs and approves branch exceptions up to 750k AED.',
    entityScope: 'ALK-CONV',
    channelScope: 'BANCA',
    subChannelScope: 'BRANCH-RETAIL-01',
    defaultLandingTab: 'access-doa',
    reportsToProfileId: 'bank-manager',
    escalationProfileId: 'underwriter-manager',
    doaLimitAed: '750,000.00',
    doaActions: ['quote-high-sum-assured', 'discount-concession', 'retention-waiver'],
    piiAccess: 'full',
    fullTabs: ['overview', 'access-doa', 'journey', 'onboarding', 'parties', 'policyholder'],
    readTabs: ['decisions', 'underwriting', 'warehouse'],
    aiConfidencePct: 97,
    aiRationale: 'Approves retail branch referrals up to 750k AED and escalates HNW/corporate bank cases cleanly to Bank Manager.',
  },
  {
    id: 'bank-manager',
    name: 'Bank Manager',
    title: 'Executive Head of Partner Bank & Multi-Branch Network',
    family: 'bancassurance-branch',
    badge: 'BANK MANAGER · TOP CHANNEL APPROVER',
    summary: 'Executive authority across all bank branches and bancassurance sub-channels; approves HNW/private-banking cases up to 5M AED and monitors bank-wide KPIs.',
    entityScope: '*',
    channelScope: 'BANCA',
    subChannelScope: '*',
    defaultLandingTab: 'overview',
    reportsToProfileId: 'administration',
    escalationProfileId: 'administration',
    doaLimitAed: '5,000,000.00',
    doaActions: ['quote-high-sum-assured', 'discount-concession', 'retention-waiver', 'endorsement-alteration'],
    piiAccess: 'full',
    fullTabs: ['overview', 'access-doa', 'journey', 'policyholder', 'decisions', 'warehouse'],
    readTabs: ['underwriting', 'funds', 'takaful', 'ingest', 'batch'],
    aiConfidencePct: 99,
    aiRationale: 'Top distribution governance across the entire bank partnership up to 5M AED with full warehouse analytics and multi-branch supervision.',
  },

  // ======================== 7. DIGITAL, DIRECT & REFERRAL PARTNERS (4) ========================
  {
    id: 'aggregator',
    name: 'Aggregator',
    title: 'Digital Comparison & API Aggregator Partner',
    family: 'digital-partner',
    badge: 'DIGITAL AGGREGATOR',
    summary: 'Generates instant comparative quotes, pre-sale regulatory compliance checks and straight-through digital submissions within aggregator shelf limits.',
    entityScope: 'ALK-CONV',
    channelScope: 'AGGREGATOR',
    subChannelScope: 'AGG-COMPARE-API',
    defaultLandingTab: 'journey',
    reportsToProfileId: 'supervisor',
    escalationProfileId: 'underwriter-officer',
    doaLimitAed: '200,000.00',
    doaActions: ['quote-high-sum-assured'],
    piiAccess: 'masked',
    fullTabs: ['journey', 'cover'],
    readTabs: ['regulatory', 'decisions', 'access-doa'],
    subSectionOverrides: {
      'journey:underwriting-decision:uw-signoff': 'none',
      'journey:quotation-conversion:inforce-servicing': 'read',
    },
    aiConfidencePct: 97,
    aiRationale: 'Strictly isolated digital aggregator surface: instant quoting, comparison matrix and micro-cover without back-office ledger or cross-customer PII access.',
  },
  {
    id: 'direct-customer',
    name: 'Direct Customer',
    title: 'Self-Service Policyholder & Direct Digital Customer',
    family: 'digital-partner',
    badge: 'DIRECT CUSTOMER (D2C)',
    summary: 'Self-service customer portal: complete personal digital purchase journey, inspect own unit-linked look-through, toggle micro-cover and request alterations/claims.',
    entityScope: 'ALK-CONV',
    channelScope: 'DIRECT',
    subChannelScope: 'D2C-PORTAL',
    defaultLandingTab: 'policyholder',
    reportsToProfileId: 'endorsement-officer',
    escalationProfileId: 'supervisor',
    doaLimitAed: '150,000.00',
    doaActions: ['quote-high-sum-assured', 'endorsement-alteration'],
    piiAccess: 'own-only',
    fullTabs: ['policyholder', 'decisions', 'cover', 'journey'],
    readTabs: ['tour'],
    subSectionOverrides: {
      'journey:underwriting-decision:uw-signoff': 'none',
      'policyholder:policy-admin:endorsements-retention': 'read',
    },
    aiConfidencePct: 99,
    aiRationale: 'Own-policy isolation only: zero visibility into back-office queues, other parties, books or master configuration; service changes route to Endorsement Officer.',
  },
  {
    id: 'referral-partner-1',
    name: 'Referral Partner 1',
    title: 'Wealth & Family Office Introducer — Referral Partner 1',
    family: 'digital-partner',
    badge: 'REFERRAL PARTNER 1',
    summary: 'Captures consented client introductions, runs initial needs & indicative illustrations and hands qualified leads to licensed Agency/Advisory desks.',
    entityScope: 'ALK-CONV',
    channelScope: 'REFERRAL',
    subChannelScope: 'REF-WEALTH-01',
    defaultLandingTab: 'onboarding',
    reportsToProfileId: 'agent-supervisor',
    escalationProfileId: 'supervisor',
    doaLimitAed: '100,000.00',
    doaActions: ['quote-high-sum-assured'],
    piiAccess: 'masked',
    fullTabs: ['onboarding', 'journey'],
    readTabs: ['decisions', 'access-doa'],
    subSectionOverrides: {
      'journey:underwriting-decision:uw-signoff': 'none',
      'journey:quotation-conversion:payment-issue': 'none',
      'journey:quotation-conversion:inforce-servicing': 'none',
    },
    aiConfidencePct: 98,
    aiRationale: 'Regulatory introducer perimeter: permitted to onboard KYC leads and generate indicative illustrations only; binding & payment hand off to licensed advisors.',
  },
  {
    id: 'referral-partner-2',
    name: 'Referral Partner 2',
    title: 'Corporate & Affinity Introducer — Referral Partner 2',
    family: 'digital-partner',
    badge: 'REFERRAL PARTNER 2',
    summary: 'Submits affinity/corporate employee leads and Takaful/Conventional indicative benefit illustrations under Referral Sub-Channel 2.',
    entityScope: 'ALK-TKF',
    channelScope: 'REFERRAL',
    subChannelScope: 'REF-AFFINITY-02',
    defaultLandingTab: 'onboarding',
    reportsToProfileId: 'agent-supervisor',
    escalationProfileId: 'supervisor',
    doaLimitAed: '100,000.00',
    doaActions: ['quote-high-sum-assured'],
    piiAccess: 'masked',
    fullTabs: ['onboarding', 'journey'],
    readTabs: ['decisions', 'takaful', 'access-doa'],
    subSectionOverrides: {
      'journey:underwriting-decision:uw-signoff': 'none',
      'journey:quotation-conversion:payment-issue': 'none',
      'journey:quotation-conversion:inforce-servicing': 'none',
    },
    aiConfidencePct: 98,
    aiRationale: 'Scoped to REF-AFFINITY-02 with indicative Takaful/Conventional illustration access; policy binding strictly gated behind licensed supervisor approval.',
  },
];

const SOD_RULES: ReadonlyArray<{
  readonly a: string;
  readonly b: string;
  readonly message: string;
}> = [
  {
    a: 'claims:adjudication-settlement:claim-approve',
    b: 'claims:adjudication-settlement:claim-settle',
    message: 'Segregation-of-Duties alert: granting full Claim Approval AND full Cash Settlement Release to the same non-admin role weakens four-eyes payout control.',
  },
  {
    a: 'journey:onboarding-kyc:identity-chip',
    b: 'underwriting:uw-adjudication:uw-decision',
    message: 'Segregation-of-Duties alert: frontline sales/onboarding combined with final Underwriting Risk Binding allows self-underwriting unless capped by DOA.',
  },
  {
    a: 'master:product-factory:rating-tables',
    b: 'ledger:general-ledger:journal-register',
    message: 'Segregation-of-Duties alert: combining Tariff Table mutation with General Ledger posting mixes actuarial configuration and financial accounting.',
  },
];

export class SecurityGovernanceRegistry {
  private readonly profiles = new Map<string, SecurityProfile>();
  private readonly mappings = new Map<string, SupervisionMapping>();
  private readonly doaRequests = new Map<string, DoaApprovalRequest>();
  private readonly notifications: ApproverNotification[] = [];
  private readonly audit: SecurityAuditEntry[] = [];
  private doaSeq = 0;
  private notifSeq = 0;
  private auditSeq = 0;
  private mapSeq = 0;
  private activeProfileId = 'administration';

  constructor(private readonly clockAt = '2026-10-05T09:00:00+04:00') {
    for (const seed of PROFILE_SEEDS) {
      const maps = buildGranularMaps(seed);
      this.profiles.set(seed.id, {
        id: seed.id,
        name: seed.name,
        title: seed.title,
        family: seed.family,
        badge: seed.badge,
        summary: seed.summary,
        unrestricted: Boolean(seed.unrestricted),
        entityScope: seed.entityScope,
        channelScope: seed.channelScope,
        subChannelScope: seed.subChannelScope,
        defaultLandingTab: seed.defaultLandingTab,
        reportsToProfileId: seed.reportsToProfileId,
        escalationProfileId: seed.escalationProfileId,
        doaLimitMinor: seed.doaLimitAed === null ? null : parseAmount(seed.doaLimitAed, 'AED').minor,
        currency: 'AED',
        doaActions: [...seed.doaActions],
        piiAccess: seed.piiAccess,
        tabAccess: maps.tabAccess,
        sectionAccess: maps.sectionAccess,
        subSectionAccess: maps.subSectionAccess,
        aiConfidencePct: seed.aiConfidencePct,
        aiRationale: seed.aiRationale,
      });
    }

    this.seedSupervisionMappings();
    this.seedInitialDoaExamples();
  }

  private seedSupervisionMappings(): void {
    const seeds: Array<Omit<SupervisionMapping, 'id' | 'updatedAt' | 'updatedBy'>> = [
      {
        entityId: 'ALK-CONV',
        channelCode: 'AGENCY',
        subChannelCode: 'AGENCY-DESK-1',
        department: 'Tied Agency — Conventional Desk 1',
        officerProfileIds: ['agent-1'],
        supervisorProfileId: 'agent-supervisor',
        managerProfileId: 'underwriter-manager',
        supervisorDoaLimitMinor: parseAmount('1,500,000.00', 'AED').minor,
        managerDoaLimitMinor: parseAmount('5,000,000.00', 'AED').minor,
        currency: 'AED',
        active: true,
        note: 'Agent 1 quotes >250k AED or commission waivers route to Agent Supervisor, then Underwriter Manager.',
      },
      {
        entityId: 'ALK-TKF',
        channelCode: 'AGENCY',
        subChannelCode: 'AGENCY-DESK-2',
        department: 'Tied Agency — Family Takaful Desk 2',
        officerProfileIds: ['agent-2'],
        supervisorProfileId: 'agent-supervisor',
        managerProfileId: 'underwriter-manager',
        supervisorDoaLimitMinor: parseAmount('1,500,000.00', 'AED').minor,
        managerDoaLimitMinor: parseAmount('5,000,000.00', 'AED').minor,
        currency: 'AED',
        active: true,
        note: 'Agent 2 Takaful & protection referrals route to Agent Supervisor, then Underwriter Manager.',
      },
      {
        entityId: 'ALK-CONV',
        channelCode: 'BROKER-MARSH',
        subChannelCode: 'MARSH-AGENCY',
        department: 'Marsh Multinational Broker — Agency & Call-Centre Desks',
        officerProfileIds: ['agent-marsh'],
        supervisorProfileId: 'agent-supervisor',
        managerProfileId: 'underwriter-manager',
        supervisorDoaLimitMinor: parseAmount('1,500,000.00', 'AED').minor,
        managerDoaLimitMinor: parseAmount('5,000,000.00', 'AED').minor,
        currency: 'AED',
        active: true,
        note: 'Marsh broker multi-country risks >1M AED route to Agent Supervisor then Underwriter Manager / Reinsurance Manager.',
      },
      {
        entityId: 'ALK-CONV',
        channelCode: 'BANCA',
        subChannelCode: 'BANCA-PREMIER-1',
        department: 'Bancassurance Premier Wealth Desk 1',
        officerProfileIds: ['banca-officer-1', 'bancassurance-operations-officer'],
        supervisorProfileId: 'banca-supervisor',
        managerProfileId: 'bank-manager',
        supervisorDoaLimitMinor: parseAmount('1,500,000.00', 'AED').minor,
        managerDoaLimitMinor: parseAmount('5,000,000.00', 'AED').minor,
        currency: 'AED',
        active: true,
        note: 'Premier bank wealth proposals >300k AED route to Banca Supervisor, escalating >1.5M AED to Bank Manager.',
      },
      {
        entityId: 'ALK-TKF',
        channelCode: 'BANCA',
        subChannelCode: 'BANCA-ISLAMIC-2',
        department: 'Bancatakaful Islamic Desk 2',
        officerProfileIds: ['banca-officer-2', 'bancassurance-operations-officer'],
        supervisorProfileId: 'banca-supervisor',
        managerProfileId: 'bank-manager',
        supervisorDoaLimitMinor: parseAmount('1,500,000.00', 'AED').minor,
        managerDoaLimitMinor: parseAmount('5,000,000.00', 'AED').minor,
        currency: 'AED',
        active: true,
        note: 'Islamic bancatakaful referrals >300k AED route to Banca Supervisor, escalating >1.5M AED to Bank Manager.',
      },
      {
        entityId: 'ALK-CONV',
        channelCode: 'BANCA',
        subChannelCode: 'BRANCH-RETAIL-01',
        department: 'Retail Bank Branch Network',
        officerProfileIds: ['branch-officer'],
        supervisorProfileId: 'branch-manager',
        managerProfileId: 'bank-manager',
        supervisorDoaLimitMinor: parseAmount('750,000.00', 'AED').minor,
        managerDoaLimitMinor: parseAmount('5,000,000.00', 'AED').minor,
        currency: 'AED',
        active: true,
        note: 'Walk-in Branch Officer cases >150k AED route to Branch Manager (up to 750k AED), then Bank Manager.',
      },
      {
        entityId: '*',
        channelCode: 'HEAD-OFFICE',
        subChannelCode: 'UW-DESK',
        department: 'Technical Underwriting Desk',
        officerProfileIds: ['underwriter-officer'],
        supervisorProfileId: 'underwriter-manager',
        managerProfileId: 'reinsurance-manager',
        supervisorDoaLimitMinor: parseAmount('5,000,000.00', 'AED').minor,
        managerDoaLimitMinor: parseAmount('10,000,000.00', 'AED').minor,
        currency: 'AED',
        active: true,
        note: 'Underwriter Officer cases >500k AED route to Underwriter Manager; facultative >5M AED escalates to Reinsurance Manager.',
      },
      {
        entityId: '*',
        channelCode: 'HEAD-OFFICE',
        subChannelCode: 'RETENTION-DESK',
        department: 'Customer Retention & Conservation Desk',
        officerProfileIds: ['retention-officer'],
        supervisorProfileId: 'retention-manager',
        managerProfileId: 'administration',
        supervisorDoaLimitMinor: parseAmount('150,000.00', 'AED').minor,
        managerDoaLimitMinor: parseAmount('10,000,000.00', 'AED').minor,
        currency: 'AED',
        active: true,
        note: 'Retention fee waivers >15k AED route to Retention Manager.',
      },
      {
        entityId: '*',
        channelCode: 'HEAD-OFFICE',
        subChannelCode: 'ENDORSEMENT-DESK',
        department: 'Policy Alterations & Endorsement Desk',
        officerProfileIds: ['endorsement-officer', 'direct-customer'],
        supervisorProfileId: 'endorsement-supervisor',
        managerProfileId: 'underwriter-manager',
        supervisorDoaLimitMinor: parseAmount('500,000.00', 'AED').minor,
        managerDoaLimitMinor: parseAmount('5,000,000.00', 'AED').minor,
        currency: 'AED',
        active: true,
        note: 'Endorsement alterations >50k AED or D2C service changes route to Endorsement Supervisor.',
      },
      {
        entityId: '*',
        channelCode: 'HEAD-OFFICE',
        subChannelCode: 'CLAIMS-DESK',
        department: 'Claims Adjudication Desk',
        officerProfileIds: ['claim-officer'],
        supervisorProfileId: 'claim-manager',
        managerProfileId: 'settlement-manager',
        supervisorDoaLimitMinor: parseAmount('500,000.00', 'AED').minor,
        managerDoaLimitMinor: parseAmount('2,000,000.00', 'AED').minor,
        currency: 'AED',
        active: true,
        note: 'Claim assessments >50k AED route to Claim Manager; approved payouts route to Settlement Desk.',
      },
      {
        entityId: '*',
        channelCode: 'HEAD-OFFICE',
        subChannelCode: 'SETTLEMENT-DESK',
        department: 'Claims & Maturity Settlement Desk',
        officerProfileIds: ['settlement-officer'],
        supervisorProfileId: 'settlement-manager',
        managerProfileId: 'finance',
        supervisorDoaLimitMinor: parseAmount('2,000,000.00', 'AED').minor,
        managerDoaLimitMinor: parseAmount('2,500,000.00', 'AED').minor,
        currency: 'AED',
        active: true,
        note: 'Disbursements >100k AED route to Settlement Manager, then Head of Finance.',
      },
      {
        entityId: '*',
        channelCode: 'HEAD-OFFICE',
        subChannelCode: 'REINSURANCE-DESK',
        department: 'Treaty & Facultative Reinsurance Desk',
        officerProfileIds: ['reinsurance-officer'],
        supervisorProfileId: 'reinsurance-manager',
        managerProfileId: 'administration',
        supervisorDoaLimitMinor: parseAmount('10,000,000.00', 'AED').minor,
        managerDoaLimitMinor: parseAmount('50,000,000.00', 'AED').minor,
        currency: 'AED',
        active: true,
        note: 'Facultative placements & cash calls >1M AED route to Reinsurance Manager.',
      },
      {
        entityId: '*',
        channelCode: 'HEAD-OFFICE',
        subChannelCode: 'FUNDS-DESK',
        department: 'Fund Configuration & Investment Governance',
        officerProfileIds: ['fund-configuration', 'fund-investment-officer'],
        supervisorProfileId: 'fund-investment-manager',
        managerProfileId: 'finance',
        supervisorDoaLimitMinor: parseAmount('10,000,000.00', 'AED').minor,
        managerDoaLimitMinor: parseAmount('25,000,000.00', 'AED').minor,
        currency: 'AED',
        active: true,
        note: 'Fund setup changes & NAV sign-offs >500k AED route to Fund Investment Manager.',
      },
      {
        entityId: '*',
        channelCode: 'HEAD-OFFICE',
        subChannelCode: 'FINANCE-DESK',
        department: 'Accounting, Cost Control & Group Finance',
        officerProfileIds: ['accountant', 'cost-controller'],
        supervisorProfileId: 'finance',
        managerProfileId: 'administration',
        supervisorDoaLimitMinor: parseAmount('2,500,000.00', 'AED').minor,
        managerDoaLimitMinor: parseAmount('50,000,000.00', 'AED').minor,
        currency: 'AED',
        active: true,
        note: 'Accounting journals >100k AED & cost waivers >500k AED route to Finance.',
      },
      {
        entityId: '*',
        channelCode: 'AGGREGATOR',
        subChannelCode: 'AGG-COMPARE-API',
        department: 'Digital Aggregator Channel Supervision',
        officerProfileIds: ['aggregator'],
        supervisorProfileId: 'supervisor',
        managerProfileId: 'underwriter-manager',
        supervisorDoaLimitMinor: parseAmount('1,500,000.00', 'AED').minor,
        managerDoaLimitMinor: parseAmount('5,000,000.00', 'AED').minor,
        currency: 'AED',
        active: true,
        note: 'Aggregator quotes >200k AED route to Cross-Desk Supervisor, then Underwriter Manager.',
      },
      {
        entityId: '*',
        channelCode: 'REFERRAL',
        subChannelCode: '*',
        department: 'Introducer & Referral Partners Supervision',
        officerProfileIds: ['referral-partner-1', 'referral-partner-2'],
        supervisorProfileId: 'agent-supervisor',
        managerProfileId: 'supervisor',
        supervisorDoaLimitMinor: parseAmount('1,500,000.00', 'AED').minor,
        managerDoaLimitMinor: parseAmount('5,000,000.00', 'AED').minor,
        currency: 'AED',
        active: true,
        note: 'All referral partner leads >100k AED or ready for binding route to Agent Supervisor.',
      },
    ];

    for (const s of seeds) {
      const id = `MAP-${String(++this.mapSeq).padStart(4, '0')}`;
      this.mappings.set(id, { ...s, id, updatedAt: this.clockAt, updatedBy: 'security-seed' });
    }
  }

  private seedInitialDoaExamples(): void {
    this.submitDoaRequest({
      requesterProfileId: 'agent-marsh',
      actionKind: 'quote-high-sum-assured',
      subjectRef: 'QTE-MARSH-0091 (PROD-UL-GLOBAL)',
      tabId: 'journey',
      sectionId: 'coverage-pricing',
      entityId: 'ALK-CONV',
      channelCode: 'BROKER-MARSH',
      subChannelCode: 'MARSH-AGENCY',
      amount: '1,350,000.00',
      currency: 'AED',
      reason: 'Multinational executive key-person quote exceeds Agent Marsh 1,000,000.00 AED DOA threshold.',
      at: '2026-10-05T09:15:00+04:00',
    });
    this.submitDoaRequest({
      requesterProfileId: 'claim-officer',
      actionKind: 'claim-approval',
      subjectRef: 'CLM-000104 (Policy UL-000123)',
      tabId: 'claims',
      sectionId: 'adjudication-settlement',
      entityId: 'ALK-CONV',
      channelCode: 'HEAD-OFFICE',
      subChannelCode: 'CLAIMS-DESK',
      amount: '125,000.00',
      currency: 'AED',
      reason: 'Hospitalisation & critical illness claim assessment exceeds Claim Officer 50,000.00 AED authority limit.',
      at: '2026-10-05T09:30:00+04:00',
    });
    this.submitDoaRequest({
      requesterProfileId: 'branch-officer',
      actionKind: 'quote-high-sum-assured',
      subjectRef: 'JNY-BRANCH-0042 (Mortgage Protection)',
      tabId: 'journey',
      sectionId: 'coverage-pricing',
      entityId: 'ALK-CONV',
      channelCode: 'BANCA',
      subChannelCode: 'BRANCH-RETAIL-01',
      amount: '420,000.00',
      currency: 'AED',
      reason: 'Walk-in mortgage life protection exceeds Branch Officer 150,000.00 AED limit; routed to Branch Manager.',
      at: '2026-10-05T09:45:00+04:00',
    });
  }

  private recordAudit(actorProfileId: string, event: string, detail: string, at?: string): void {
    this.audit.push({
      id: `SEC-AUD-${String(++this.auditSeq).padStart(5, '0')}`,
      at: at?.trim() || this.clockAt,
      actorProfileId,
      event,
      detail,
    });
  }

  private pushNotification(input: Omit<ApproverNotification, 'id' | 'read'>): ApproverNotification {
    const item: ApproverNotification = {
      ...input,
      id: `NTF-${String(++this.notifSeq).padStart(5, '0')}`,
      read: false,
    };
    this.notifications.push(item);
    return item;
  }

  listProfiles(): SecurityProfile[] {
    return [...this.profiles.values()];
  }

  getProfile(profileId: string): SecurityProfile {
    const p = this.profiles.get(profileId.trim());
    if (!p) throw new SecurityGovernanceError(`unknown security profile "${profileId}"`);
    return p;
  }

  selectActiveProfile(profileId: string, at?: string): SecurityProfile {
    const profile = this.getProfile(profileId);
    this.activeProfileId = profile.id;
    this.recordAudit(profile.id, 'session.profile-selected', `Entered ERP session as "${profile.name}" (${profile.title}) on landing tab "${profile.defaultLandingTab}".`, at);
    return profile;
  }

  activeProfile(): SecurityProfile {
    return this.getProfile(this.activeProfileId);
  }

  canAccessTab(profileId: string, tabId: string): AccessLevel {
    const p = this.getProfile(profileId);
    if (p.unrestricted) return 'full';
    return p.tabAccess[tabId] ?? 'none';
  }

  canAccessSection(profileId: string, tabId: string, sectionId: string): AccessLevel {
    const p = this.getProfile(profileId);
    if (p.unrestricted) return 'full';
    return p.sectionAccess[`${tabId}:${sectionId}`] ?? this.canAccessTab(profileId, tabId);
  }

  canAccessSubSection(profileId: string, tabId: string, sectionId: string, subSectionId: string): AccessLevel {
    const p = this.getProfile(profileId);
    if (p.unrestricted) return 'full';
    return p.subSectionAccess[`${tabId}:${sectionId}:${subSectionId}`] ?? this.canAccessSection(profileId, tabId, sectionId);
  }

  upsertProfile(input: {
    id: string;
    name?: string;
    title?: string;
    family?: ProfileFamily;
    badge?: string;
    summary?: string;
    entityScope?: string;
    channelScope?: string;
    subChannelScope?: string;
    defaultLandingTab?: string;
    reportsToProfileId?: string | null;
    escalationProfileId?: string | null;
    doaLimitAed?: string | null;
    piiAccess?: 'full' | 'masked' | 'own-only';
    tabAccess?: Record<string, AccessLevel>;
    sectionAccess?: Record<string, AccessLevel>;
    subSectionAccess?: Record<string, AccessLevel>;
    cloneFromProfileId?: string;
    by?: string;
    at?: string;
  }): SecurityProfile {
    const cleanId = input.id.trim().toLowerCase().replace(/[^a-z0-9-]+/g, '-');
    if (!cleanId) throw new SecurityGovernanceError('profile id is required');

    const existing = this.profiles.get(cleanId)
      ?? (input.cloneFromProfileId ? this.getProfile(input.cloneFromProfileId) : this.getProfile('agent-1'));

    if (cleanId === 'administration') {
      throw new SecurityGovernanceError('Administration holds permanent complete unrestricted access and cannot have permissions removed');
    }

    if (input.reportsToProfileId) this.getProfile(input.reportsToProfileId);
    if (input.escalationProfileId) this.getProfile(input.escalationProfileId);

    const nextTabAccess: Record<string, AccessLevel> = { ...existing.tabAccess, ...(input.tabAccess ?? {}) };
    const nextSectionAccess: Record<string, AccessLevel> = { ...existing.sectionAccess, ...(input.sectionAccess ?? {}) };
    const nextSubAccess: Record<string, AccessLevel> = { ...existing.subSectionAccess, ...(input.subSectionAccess ?? {}) };

    // Propagate tab updates down to child sections unless explicitly specified in input.sectionAccess
    if (input.tabAccess) {
      for (const [tabId, level] of Object.entries(input.tabAccess)) {
        const cat = SECURITY_SURFACE_CATALOGUE.find((c) => c.tabId === tabId);
        if (!cat) continue;
        for (const sec of cat.sections) {
          const sKey = `${tabId}:${sec.id}`;
          if (!input.sectionAccess || !(sKey in input.sectionAccess)) {
            nextSectionAccess[sKey] = level;
          }
          for (const sub of sec.subSections) {
            const subKey = `${tabId}:${sec.id}:${sub.id}`;
            if (!input.subSectionAccess || !(subKey in input.subSectionAccess)) {
              nextSubAccess[subKey] = nextSectionAccess[sKey]!;
            }
          }
        }
      }
    }

    const doaLimitMinor = input.doaLimitAed === undefined
      ? existing.doaLimitMinor
      : input.doaLimitAed === null || String(input.doaLimitAed).trim().toLowerCase() === 'unlimited' || String(input.doaLimitAed).trim() === ''
        ? null
        : parseAmount(String(input.doaLimitAed), 'AED').minor;

    const updated: SecurityProfile = {
      ...existing,
      id: cleanId,
      unrestricted: false,
      name: input.name?.trim() || existing.name,
      title: input.title?.trim() || existing.title,
      family: input.family ?? existing.family,
      badge: input.badge?.trim() || existing.badge,
      summary: input.summary?.trim() || existing.summary,
      entityScope: input.entityScope?.trim() || existing.entityScope,
      channelScope: input.channelScope?.trim() || existing.channelScope,
      subChannelScope: input.subChannelScope?.trim() || existing.subChannelScope,
      defaultLandingTab: input.defaultLandingTab?.trim() || existing.defaultLandingTab,
      reportsToProfileId: input.reportsToProfileId === undefined ? existing.reportsToProfileId : input.reportsToProfileId,
      escalationProfileId: input.escalationProfileId === undefined ? existing.escalationProfileId : input.escalationProfileId,
      doaLimitMinor,
      piiAccess: input.piiAccess ?? existing.piiAccess,
      tabAccess: nextTabAccess,
      sectionAccess: nextSectionAccess,
      subSectionAccess: nextSubAccess,
    };
    this.profiles.set(cleanId, updated);
    this.recordAudit(input.by?.trim() || 'administration', 'rbac.profile-upserted', `Updated profile "${updated.name}" (${updated.id}).`, input.at);
    return updated;
  }

  /**
   * AI Role & Access Advisor: scores every Tab, Section and Sub-Section for a profile or custom role
   * description, proposes optimal DOA limits + supervisor chain, and flags Segregation-of-Duties risks.
   */
  recommendAccess(input: { profileId?: string; roleDescription?: string }): AiAccessRecommendation {
    const baseProfile = input.profileId && this.profiles.has(input.profileId)
      ? this.getProfile(input.profileId)
      : this.inferArchetypeFromText(input.roleDescription ?? '');

    const sodWarnings: string[] = [];
    if (!baseProfile.unrestricted) {
      for (const rule of SOD_RULES) {
        if (baseProfile.subSectionAccess[rule.a] === 'full' && baseProfile.subSectionAccess[rule.b] === 'full') {
          sodWarnings.push(rule.message);
        }
      }
    }

    const tabs = SECURITY_SURFACE_CATALOGUE.map((entry) => {
      const level: AccessLevel = baseProfile.unrestricted ? 'full' : (baseProfile.tabAccess[entry.tabId] ?? 'none');
      const scorePct = baseProfile.unrestricted
        ? 100
        : level === 'full'
          ? (entry.tabId === baseProfile.defaultLandingTab ? 99 : 92)
          : level === 'read'
            ? 68
            : 8;
      const reason = baseProfile.unrestricted
        ? 'Unrestricted superuser mandate across all enterprise modules'
        : level === 'full'
          ? `Core operational workspace for ${baseProfile.name} (${baseProfile.channelScope}/${baseProfile.subChannelScope})`
          : level === 'read'
            ? `Read-only contextual lookup to avoid duplicate entry while preserving Segregation of Duties`
            : `Hidden outside ${baseProfile.name}'s least-privilege perimeter`;

      return {
        tabId: entry.tabId,
        label: entry.label,
        level,
        scorePct,
        reason,
        sections: entry.sections.map((sec) => {
          const sKey = `${entry.tabId}:${sec.id}`;
          const sLevel: AccessLevel = baseProfile.unrestricted ? 'full' : (baseProfile.sectionAccess[sKey] ?? level);
          return {
            sectionId: sec.id,
            label: sec.label,
            level: sLevel,
            subSections: sec.subSections.map((sub) => ({
              subSectionId: sub.id,
              label: sub.label,
              level: baseProfile.unrestricted ? 'full' : (baseProfile.subSectionAccess[`${sKey}:${sub.id}`] ?? sLevel),
            })),
          };
        }),
      };
    });

    const limitLabel = baseProfile.doaLimitMinor === null
      ? 'Unlimited (Superuser Authority)'
      : formatAmount(money(baseProfile.doaLimitMinor, baseProfile.currency));

    return {
      profileId: baseProfile.id,
      profileName: baseProfile.name,
      confidencePct: baseProfile.aiConfidencePct,
      recommendedLandingTab: baseProfile.defaultLandingTab,
      recommendedDoaLimit: limitLabel,
      recommendedDoaMinor: baseProfile.doaLimitMinor === null ? null : baseProfile.doaLimitMinor.toString(),
      recommendedSupervisorProfileId: baseProfile.reportsToProfileId,
      recommendedEscalationProfileId: baseProfile.escalationProfileId,
      piiAccess: baseProfile.piiAccess,
      tabs,
      sodWarnings,
      summary: `${baseProfile.aiRationale} Recommended DOA cap: ${limitLabel}; reports to ${baseProfile.reportsToProfileId ?? 'Board / Root'}.`,
    };
  }

  applyAiRecommendation(targetProfileId: string, archetypeProfileId?: string, meta: { by?: string; at?: string } = {}): {
    profile: SecurityProfile;
    recommendation: AiAccessRecommendation;
  } {
    const rec = this.recommendAccess({ profileId: archetypeProfileId ?? targetProfileId });
    if (targetProfileId === 'administration') {
      return { profile: this.getProfile('administration'), recommendation: rec };
    }
    const tabAccess: Record<string, AccessLevel> = {};
    const sectionAccess: Record<string, AccessLevel> = {};
    const subSectionAccess: Record<string, AccessLevel> = {};
    for (const t of rec.tabs) {
      tabAccess[t.tabId] = t.level;
      for (const s of t.sections) {
        sectionAccess[`${t.tabId}:${s.sectionId}`] = s.level;
        for (const sub of s.subSections) {
          subSectionAccess[`${t.tabId}:${s.sectionId}:${sub.subSectionId}`] = sub.level;
        }
      }
    }
    const profile = this.upsertProfile({
      id: targetProfileId,
      defaultLandingTab: rec.recommendedLandingTab,
      reportsToProfileId: rec.recommendedSupervisorProfileId,
      escalationProfileId: rec.recommendedEscalationProfileId,
      doaLimitAed: rec.recommendedDoaMinor === null
        ? null
        : formatAmount(money(BigInt(rec.recommendedDoaMinor), 'AED')).replace(/\s+AED$/, ''),
      piiAccess: rec.piiAccess,
      tabAccess,
      sectionAccess,
      subSectionAccess,
      by: meta.by ?? 'ai-rbac-advisor',
      at: meta.at,
    });
    this.recordAudit(meta.by ?? 'ai-rbac-advisor', 'rbac.ai-applied', `Applied AI-recommended RBAC & DOA template to "${profile.name}".`, meta.at);
    return { profile, recommendation: rec };
  }

  private inferArchetypeFromText(text: string): SecurityProfile {
    const q = text.toLowerCase();
    if (/admin|chief|superuser/.test(q)) return this.getProfile('administration');
    if (/settlement/.test(q) && /manager|head/.test(q)) return this.getProfile('settlement-manager');
    if (/settlement/.test(q)) return this.getProfile('settlement-officer');
    if (/claim/.test(q) && /manager|head/.test(q)) return this.getProfile('claim-manager');
    if (/claim/.test(q)) return this.getProfile('claim-officer');
    if (/reinsur|retakaful/.test(q) && /manager|head/.test(q)) return this.getProfile('reinsurance-manager');
    if (/reinsur|retakaful/.test(q)) return this.getProfile('reinsurance-officer');
    if (/underwrit/.test(q) && /manager|head|senior/.test(q)) return this.getProfile('underwriter-manager');
    if (/underwrit/.test(q)) return this.getProfile('underwriter-officer');
    if (/retention|conserv|renewal/.test(q) && /manager|head/.test(q)) return this.getProfile('retention-manager');
    if (/retention|conserv|renewal/.test(q)) return this.getProfile('retention-officer');
    if (/endorse|alteration/.test(q) && /supervisor|manager/.test(q)) return this.getProfile('endorsement-supervisor');
    if (/endorse|alteration/.test(q)) return this.getProfile('endorsement-officer');
    if (/marsh|broker/.test(q)) return this.getProfile('agent-marsh');
    if (/bank\s*manager/.test(q)) return this.getProfile('bank-manager');
    if (/branch\s*manager/.test(q)) return this.getProfile('branch-manager');
    if (/branch/.test(q)) return this.getProfile('branch-officer');
    if (/banca/.test(q) && /op/.test(q)) return this.getProfile('bancassurance-operations-officer');
    if (/banca/.test(q) && /supervisor/.test(q)) return this.getProfile('banca-supervisor');
    if (/banca/.test(q)) return this.getProfile('banca-officer-1');
    if (/fund/.test(q) && /config/.test(q)) return this.getProfile('fund-configuration');
    if (/fund|invest/.test(q) && /manager|cio/.test(q)) return this.getProfile('fund-investment-manager');
    if (/fund|invest|nav/.test(q)) return this.getProfile('fund-investment-officer');
    if (/cost|commission/.test(q)) return this.getProfile('cost-controller');
    if (/accountant|gl|journal/.test(q)) return this.getProfile('accountant');
    if (/finance|treasury|consolidat/.test(q)) return this.getProfile('finance');
    if (/aggregat/.test(q)) return this.getProfile('aggregator');
    if (/direct|customer|self/.test(q)) return this.getProfile('direct-customer');
    if (/referral|introduc/.test(q)) return this.getProfile('referral-partner-1');
    if (/config|product|tariff/.test(q)) return this.getProfile('configurator');
    if (/agent/.test(q) && /supervisor/.test(q)) return this.getProfile('agent-supervisor');
    if (/agent/.test(q)) return this.getProfile('agent-1');
    return this.getProfile('supervisor');
  }

  /* ======================== ENTITY × CHANNEL × SUB-CHANNEL SUPERVISION ======================== */

  upsertSupervisionMapping(input: {
    id?: string;
    entityId: string;
    channelCode: string;
    subChannelCode: string;
    department: string;
    officerProfileIds: readonly string[];
    supervisorProfileId: string;
    managerProfileId: string;
    supervisorDoaLimitAed: string;
    managerDoaLimitAed: string;
    active?: boolean;
    note?: string;
    by?: string;
    at?: string;
  }): SupervisionMapping {
    this.getProfile(input.supervisorProfileId);
    this.getProfile(input.managerProfileId);
    for (const o of input.officerProfileIds) this.getProfile(o);

    const id = input.id?.trim() || `MAP-${String(++this.mapSeq).padStart(4, '0')}`;
    const record: SupervisionMapping = {
      id,
      entityId: input.entityId.trim().toUpperCase() || '*',
      channelCode: input.channelCode.trim().toUpperCase() || '*',
      subChannelCode: input.subChannelCode.trim().toUpperCase() || '*',
      department: input.department.trim() || 'Channel Supervision',
      officerProfileIds: [...new Set(input.officerProfileIds.map((x) => x.trim()))],
      supervisorProfileId: input.supervisorProfileId.trim(),
      managerProfileId: input.managerProfileId.trim(),
      supervisorDoaLimitMinor: parseAmount(input.supervisorDoaLimitAed, 'AED').minor,
      managerDoaLimitMinor: parseAmount(input.managerDoaLimitAed, 'AED').minor,
      currency: 'AED',
      active: input.active ?? true,
      note: input.note?.trim() || '',
      updatedAt: input.at?.trim() || this.clockAt,
      updatedBy: input.by?.trim() || 'administration',
    };
    this.mappings.set(id, record);
    this.recordAudit(record.updatedBy, 'rbac.mapping-upserted', `Mapped ${record.entityId} / ${record.channelCode} / ${record.subChannelCode} -> supervisor ${record.supervisorProfileId}, manager ${record.managerProfileId}.`, record.updatedAt);
    return record;
  }

  deleteSupervisionMapping(id: string, by = 'administration', at?: string): void {
    if (!this.mappings.has(id)) throw new SecurityGovernanceError(`unknown supervision mapping "${id}"`);
    this.mappings.delete(id);
    this.recordAudit(by, 'rbac.mapping-deleted', `Deleted supervision mapping ${id}.`, at);
  }

  resolveSupervisorChain(input: {
    requesterProfileId: string;
    entityId?: string;
    channelCode?: string;
    subChannelCode?: string;
  }): {
    mapping: SupervisionMapping | null;
    supervisorProfileId: string;
    escalationProfileId: string;
  } {
    const requester = this.getProfile(input.requesterProfileId);
    const entity = (input.entityId?.trim() || requester.entityScope || '*').toUpperCase();
    const channel = (input.channelCode?.trim() || requester.channelScope || '*').toUpperCase();
    const sub = (input.subChannelCode?.trim() || requester.subChannelScope || '*').toUpperCase();

    let best: { score: number; map: SupervisionMapping } | null = null;
    for (const m of this.mappings.values()) {
      if (!m.active) continue;
      const entityOk = m.entityId === '*' || m.entityId === entity || entity === '*';
      const channelOk = m.channelCode === '*' || m.channelCode === channel || channel === '*';
      const subOk = m.subChannelCode === '*' || m.subChannelCode === sub || sub === '*';
      if (!entityOk || !channelOk || !subOk) continue;
      let score = 0;
      if (m.officerProfileIds.includes(requester.id)) score += 50;
      if (m.entityId === entity) score += 10;
      if (m.channelCode === channel) score += 20;
      if (m.subChannelCode === sub) score += 30;
      if (!best || score > best.score) best = { score, map: m };
    }

    const supervisorProfileId = best?.map.supervisorProfileId
      ?? requester.reportsToProfileId
      ?? 'administration';
    const escalationProfileId = best?.map.managerProfileId
      ?? requester.escalationProfileId
      ?? 'administration';

    return {
      mapping: best?.map ?? null,
      supervisorProfileId,
      escalationProfileId,
    };
  }

  /* ======================== DOA EVALUATION, APPROVALS & NOTIFICATIONS ======================== */

  evaluateDoa(input: {
    requesterProfileId: string;
    actionKind: DoaActionKind;
    amount: string | number;
    currency?: string;
    entityId?: string;
    channelCode?: string;
    subChannelCode?: string;
    tabId?: string;
  }) {
    const profile = this.getProfile(input.requesterProfileId);
    const currency = (input.currency?.trim() || profile.currency || 'AED').toUpperCase();
    const amount = parseAmount(String(input.amount), currency);
    const chain = this.resolveSupervisorChain({
      requesterProfileId: profile.id,
      entityId: input.entityId,
      channelCode: input.channelCode,
      subChannelCode: input.subChannelCode,
    });

    if (profile.unrestricted || profile.doaLimitMinor === null) {
      return {
        authorizedWithinDoa: true,
        requiresApproval: false,
        requesterProfileId: profile.id,
        requesterName: profile.name,
        amount: formatAmount(amount),
        requesterLimit: 'Unlimited',
        assignedApproverProfileId: null as string | null,
        escalationApproverProfileId: null as string | null,
        matchedMappingId: chain.mapping?.id ?? null,
        explanation: `${profile.name} holds unrestricted complete authority — approved immediately without escalation.`,
      };
    }

    const tabAllowed = input.tabId ? this.canAccessTab(profile.id, input.tabId) !== 'none' : true;
    const actionAllowed = profile.doaActions.includes(input.actionKind);
    const limitMoney = money(profile.doaLimitMinor, profile.currency);
    const withinCap = compare(amount, limitMoney) <= 0;

    if (tabAllowed && actionAllowed && withinCap) {
      return {
        authorizedWithinDoa: true,
        requiresApproval: false,
        requesterProfileId: profile.id,
        requesterName: profile.name,
        amount: formatAmount(amount),
        requesterLimit: formatAmount(limitMoney),
        assignedApproverProfileId: null as string | null,
        escalationApproverProfileId: chain.escalationProfileId,
        matchedMappingId: chain.mapping?.id ?? null,
        explanation: `Authorized within ${profile.name}'s DOA cap of ${formatAmount(limitMoney)}.`,
      };
    }

    const why = !tabAllowed
      ? `Tab "${input.tabId}" is outside ${profile.name}'s standard access`
      : !actionAllowed
        ? `Action "${input.actionKind}" requires supervisor authority for ${profile.name}`
        : `Amount ${formatAmount(amount)} exceeds ${profile.name}'s DOA limit of ${formatAmount(limitMoney)}`;

    return {
      authorizedWithinDoa: false,
      requiresApproval: true,
      requesterProfileId: profile.id,
      requesterName: profile.name,
      amount: formatAmount(amount),
      requesterLimit: formatAmount(limitMoney),
      assignedApproverProfileId: chain.supervisorProfileId,
      escalationApproverProfileId: chain.escalationProfileId,
      matchedMappingId: chain.mapping?.id ?? null,
      explanation: `${why} — routed to ${this.getProfile(chain.supervisorProfileId).name} (escalation: ${this.getProfile(chain.escalationProfileId).name}).`,
    };
  }

  submitDoaRequest(input: {
    requesterProfileId: string;
    actionKind: DoaActionKind;
    subjectRef: string;
    tabId: string;
    sectionId?: string;
    entityId?: string;
    channelCode?: string;
    subChannelCode?: string;
    amount: string | number;
    currency?: string;
    reason: string;
    at?: string;
  }): {
    autoApproved: boolean;
    request: DoaApprovalRequest;
    notificationsSent: ApproverNotification[];
  } {
    const profile = this.getProfile(input.requesterProfileId);
    const currency = (input.currency?.trim() || profile.currency || 'AED').toUpperCase();
    const amount = parseAmount(String(input.amount), currency);
    const evalResult = this.evaluateDoa({
      requesterProfileId: profile.id,
      actionKind: input.actionKind,
      amount: String(input.amount),
      currency,
      entityId: input.entityId,
      channelCode: input.channelCode,
      subChannelCode: input.subChannelCode,
      tabId: input.tabId,
    });
    const at = input.at?.trim() || this.clockAt;
    const id = `DOA-${String(++this.doaSeq).padStart(4, '0')}`;
    const entityId = (input.entityId?.trim() || profile.entityScope || 'ALK-CONV').toUpperCase();
    const channelCode = (input.channelCode?.trim() || profile.channelScope || 'HEAD-OFFICE').toUpperCase();
    const subChannelCode = (input.subChannelCode?.trim() || profile.subChannelScope || '*').toUpperCase();
    const approverId = evalResult.assignedApproverProfileId ?? profile.id;
    const escalationId = evalResult.escalationApproverProfileId ?? 'administration';

    const autoApproved = evalResult.authorizedWithinDoa;
    const request: DoaApprovalRequest = {
      id,
      createdAt: at,
      updatedAt: at,
      requesterProfileId: profile.id,
      requesterName: profile.name,
      actionKind: input.actionKind,
      subjectRef: input.subjectRef.trim() || 'Operational request',
      tabId: input.tabId.trim() || 'overview',
      ...(input.sectionId ? { sectionId: input.sectionId } : {}),
      entityId,
      channelCode,
      subChannelCode,
      amount,
      requesterLimit: profile.doaLimitMinor === null ? null : money(profile.doaLimitMinor, profile.currency),
      assignedApproverProfileId: approverId,
      escalationApproverProfileId: escalationId,
      matchedMappingId: evalResult.matchedMappingId,
      status: autoApproved ? 'approved' : 'pending',
      reason: input.reason.trim() || evalResult.explanation,
      history: [{
        at,
        actorProfileId: profile.id,
        actorName: profile.name,
        decision: autoApproved ? 'auto-approved' : 'submitted',
        note: evalResult.explanation,
      }],
    };
    this.doaRequests.set(id, request);

    const notificationsSent: ApproverNotification[] = [];
    if (!autoApproved) {
      const approver = this.getProfile(approverId);
      notificationsSent.push(this.pushNotification({
        createdAt: at,
        recipientProfileId: approver.id,
        senderProfileId: profile.id,
        kind: 'doa-approval-needed',
        priority: 'high',
        title: `DOA Approval Required (${id}): ${formatAmount(amount)} — ${request.subjectRef}`,
        body: `${profile.name} (${entityId}/${channelCode}/${subChannelCode}) requested "${input.actionKind}" above cap (${evalResult.requesterLimit}). Reason: ${request.reason}`,
        doaRequestId: id,
        tabId: request.tabId,
      }));
      if (approver.id !== 'administration') {
        notificationsSent.push(this.pushNotification({
          createdAt: at,
          recipientProfileId: 'administration',
          senderProfileId: profile.id,
          kind: 'doa-approval-needed',
          priority: 'normal',
          title: `[Admin Copy] ${id} routed to ${approver.name} (${formatAmount(amount)})`,
          body: `${profile.name} raised ${input.actionKind} on ${request.subjectRef}; assigned to ${approver.name} with Administration override visibility.`,
          doaRequestId: id,
          tabId: request.tabId,
        }));
      }
      this.recordAudit(profile.id, 'doa.submitted', `${id} (${formatAmount(amount)}) routed to ${approver.name}.`, at);
    } else {
      this.recordAudit(profile.id, 'doa.auto-approved', `${id} (${formatAmount(amount)}) authorized within ${profile.name} DOA.`, at);
    }

    return { autoApproved, request, notificationsSent };
  }

  decideDoaRequest(input: {
    requestId: string;
    actorProfileId: string;
    decision: 'approve' | 'reject' | 'escalate';
    note?: string;
    at?: string;
  }): {
    request: DoaApprovalRequest;
    notificationsSent: ApproverNotification[];
  } {
    const existing = this.doaRequests.get(input.requestId);
    if (!existing) throw new SecurityGovernanceError(`unknown DOA request "${input.requestId}"`);
    if (existing.status === 'approved' || existing.status === 'rejected') {
      throw new SecurityGovernanceError(`DOA request ${existing.id} is already finalised as "${existing.status}"`);
    }

    const actor = this.getProfile(input.actorProfileId);
    const at = input.at?.trim() || this.clockAt;

    if (!actor.unrestricted && actor.id === existing.requesterProfileId && input.decision === 'approve') {
      throw new SecurityGovernanceError(`Segregation-of-Duties refusal: requester "${actor.name}" cannot self-approve their own DOA request ${existing.id}`);
    }

    const authorizedApprover = actor.unrestricted
      || actor.id === existing.assignedApproverProfileId
      || actor.id === existing.escalationApproverProfileId;
    if (!authorizedApprover) {
      throw new SecurityGovernanceError(
        `Profile "${actor.name}" is not an authorized approver for ${existing.id} — assigned to "${existing.assignedApproverProfileId}" (escalation: "${existing.escalationApproverProfileId}" or Administration)`,
      );
    }

    const notificationsSent: ApproverNotification[] = [];

    // If non-unrestricted supervisor tries to approve an amount exceeding THEIR OWN DOA cap, automatically escalate!
    const actorExceedsOwnDoa = !actor.unrestricted
      && actor.doaLimitMinor !== null
      && compare(existing.amount, money(actor.doaLimitMinor, actor.currency)) > 0;

    if (input.decision === 'escalate' || (input.decision === 'approve' && actorExceedsOwnDoa)) {
      const nextApproverId = actor.id === existing.escalationApproverProfileId
        ? 'administration'
        : existing.escalationApproverProfileId;
      const nextApprover = this.getProfile(nextApproverId);
      const stepNote = actorExceedsOwnDoa && input.decision === 'approve'
        ? `Amount ${formatAmount(existing.amount)} exceeds ${actor.name}'s own DOA cap (${formatAmount(money(actor.doaLimitMinor!, actor.currency))}); automatically escalated to ${nextApprover.name}. ${input.note ?? ''}`.trim()
        : (input.note?.trim() || `Escalated by ${actor.name} to ${nextApprover.name}.`);

      const updated: DoaApprovalRequest = {
        ...existing,
        updatedAt: at,
        status: 'escalated',
        assignedApproverProfileId: nextApprover.id,
        escalationApproverProfileId: 'administration',
        history: [...existing.history, { at, actorProfileId: actor.id, actorName: actor.name, decision: 'escalated', note: stepNote }],
      };
      this.doaRequests.set(updated.id, updated);

      notificationsSent.push(this.pushNotification({
        createdAt: at,
        recipientProfileId: nextApprover.id,
        senderProfileId: actor.id,
        kind: 'doa-escalated',
        priority: 'high',
        title: `Escalated DOA (${updated.id}): ${formatAmount(updated.amount)} — ${updated.subjectRef}`,
        body: stepNote,
        doaRequestId: updated.id,
        tabId: updated.tabId,
      }));
      this.recordAudit(actor.id, 'doa.escalated', `${updated.id} escalated to ${nextApprover.name}.`, at);
      return { request: updated, notificationsSent };
    }

    const finalStatus: DoaRequestStatus = input.decision === 'approve' ? 'approved' : 'rejected';
    const stepNote = input.note?.trim() || `${finalStatus === 'approved' ? 'Approved' : 'Rejected'} by ${actor.name}.`;
    const updated: DoaApprovalRequest = {
      ...existing,
      updatedAt: at,
      status: finalStatus,
      history: [...existing.history, { at, actorProfileId: actor.id, actorName: actor.name, decision: finalStatus, note: stepNote }],
    };
    this.doaRequests.set(updated.id, updated);

    notificationsSent.push(this.pushNotification({
      createdAt: at,
      recipientProfileId: updated.requesterProfileId,
      senderProfileId: actor.id,
      kind: finalStatus === 'approved' ? 'doa-approved' : 'doa-rejected',
      priority: 'high',
      title: `DOA ${finalStatus.toUpperCase()} (${updated.id}): ${updated.subjectRef}`,
      body: `${actor.name} ${finalStatus} ${formatAmount(updated.amount)} (${updated.actionKind}). Note: ${stepNote}`,
      doaRequestId: updated.id,
      tabId: updated.tabId,
    }));
    this.recordAudit(actor.id, `doa.${finalStatus}`, `${updated.id} ${finalStatus} by ${actor.name}.`, at);
    return { request: updated, notificationsSent };
  }

  markNotificationsRead(input: { profileId?: string; notificationId?: string; at?: string }): number {
    const at = input.at?.trim() || this.clockAt;
    let marked = 0;
    for (let i = 0; i < this.notifications.length; i += 1) {
      const n = this.notifications[i]!;
      if (n.read) continue;
      if (input.notificationId && n.id !== input.notificationId) continue;
      if (input.profileId && n.recipientProfileId !== input.profileId) continue;
      this.notifications[i] = { ...n, read: true, readAt: at };
      marked += 1;
    }
    return marked;
  }

  snapshot() {
    const profiles = this.listProfiles().map((p) => {
      const unreadNotifications = this.notifications.filter((n) => n.recipientProfileId === p.id && !n.read).length;
      const pendingApprovals = [...this.doaRequests.values()].filter(
        (r) => (r.status === 'pending' || r.status === 'escalated')
          && (p.unrestricted || r.assignedApproverProfileId === p.id),
      ).length;
      const allowedTabs = Object.entries(p.tabAccess)
        .filter(([, level]) => p.unrestricted || level !== 'none')
        .map(([tabId]) => tabId);
      const fullTabs = Object.entries(p.tabAccess)
        .filter(([, level]) => p.unrestricted || level === 'full')
        .map(([tabId]) => tabId);
      const readTabs = Object.entries(p.tabAccess)
        .filter(([, level]) => !p.unrestricted && level === 'read')
        .map(([tabId]) => tabId);

      return {
        id: p.id,
        name: p.name,
        title: p.title,
        family: p.family,
        badge: p.badge,
        summary: p.summary,
        unrestricted: p.unrestricted,
        entityScope: p.entityScope,
        channelScope: p.channelScope,
        subChannelScope: p.subChannelScope,
        defaultLandingTab: p.defaultLandingTab,
        reportsToProfileId: p.reportsToProfileId,
        escalationProfileId: p.escalationProfileId,
        doaLimitLabel: p.doaLimitMinor === null ? 'Unlimited' : formatAmount(money(p.doaLimitMinor, p.currency)),
        doaLimitMinor: p.doaLimitMinor === null ? null : p.doaLimitMinor.toString(),
        currency: p.currency,
        doaActions: [...p.doaActions],
        piiAccess: p.piiAccess,
        allowedTabs,
        fullTabs,
        readTabs,
        tabAccess: { ...p.tabAccess },
        sectionAccess: { ...p.sectionAccess },
        subSectionAccess: { ...p.subSectionAccess },
        aiConfidencePct: p.aiConfidencePct,
        aiRationale: p.aiRationale,
        unreadNotifications,
        pendingApprovals,
      };
    });

    return {
      activeProfileId: this.activeProfileId,
      profileCount: profiles.length,
      families: PROFILE_FAMILIES.map((f) => ({ ...f })),
      catalogue: SECURITY_SURFACE_CATALOGUE.map((c) => ({
        tabId: c.tabId,
        label: c.label,
        sections: c.sections.map((s) => ({
          id: s.id,
          label: s.label,
          subSections: s.subSections.map((sub) => ({ ...sub })),
        })),
      })),
      profiles,
      supervisionMappings: [...this.mappings.values()].map((m) => ({
        id: m.id,
        entityId: m.entityId,
        channelCode: m.channelCode,
        subChannelCode: m.subChannelCode,
        department: m.department,
        officerProfileIds: [...m.officerProfileIds],
        supervisorProfileId: m.supervisorProfileId,
        managerProfileId: m.managerProfileId,
        supervisorDoaLimitLabel: formatAmount(money(m.supervisorDoaLimitMinor, m.currency)),
        managerDoaLimitLabel: formatAmount(money(m.managerDoaLimitMinor, m.currency)),
        currency: m.currency,
        active: m.active,
        note: m.note,
        updatedAt: m.updatedAt,
        updatedBy: m.updatedBy,
      })),
      doaRequests: [...this.doaRequests.values()].reverse().map((r) => ({
        id: r.id,
        createdAt: r.createdAt,
        updatedAt: r.updatedAt,
        requesterProfileId: r.requesterProfileId,
        requesterName: r.requesterName,
        actionKind: r.actionKind,
        subjectRef: r.subjectRef,
        tabId: r.tabId,
        sectionId: r.sectionId ?? null,
        entityId: r.entityId,
        channelCode: r.channelCode,
        subChannelCode: r.subChannelCode,
        amountLabel: formatAmount(r.amount),
        requesterLimitLabel: r.requesterLimit === null ? 'Unlimited' : formatAmount(r.requesterLimit),
        assignedApproverProfileId: r.assignedApproverProfileId,
        assignedApproverName: this.profiles.get(r.assignedApproverProfileId)?.name ?? r.assignedApproverProfileId,
        escalationApproverProfileId: r.escalationApproverProfileId,
        escalationApproverName: this.profiles.get(r.escalationApproverProfileId)?.name ?? r.escalationApproverProfileId,
        matchedMappingId: r.matchedMappingId,
        status: r.status,
        reason: r.reason,
        history: r.history.map((h) => ({ ...h })),
      })),
      notifications: [...this.notifications].reverse().map((n) => ({ ...n })),
      audit: this.audit.slice(-25).reverse().map((a) => ({ ...a })),
    };
  }
}
