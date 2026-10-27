/**
 * Enterprise Security Layer: Pre-Load Profile Gate, Granular RBAC (Tab -> Section -> Sub-Section),
 * AI-Powered Access & Segregation-of-Duties (SoD) Recommender, Entity x Channel x Sub-Channel
 * Supervision Mapping, Delegation of Authority (DOA) Approval Workflow & Real-Time Notifications.
 *
 * Principles (per AGENTS.md):
 *  - Every monetary DOA cap and request amount is decimal Money with explicit currency (never float).
 *  - Administration holds unrestricted complete access across every tab, section, sub-section and DOA gate.
 *  - Every role switch, RBAC change, supervision mapping edit, AI recommendation apply, DOA request,
 *    approval/rejection/escalation and notification read is recorded on an append-only audit log.
 */
import { Money, compare, formatAmount, money, parseAmount } from './money.js';
import { CONSOLE_TABS, DISTRIBUTION_CONFIG_TAB_IDS } from './tour.js';

export type AccessLevel = 'full' | 'read' | 'none';

/**
 * Authority tier of a security role. This governs who may *change* access and Delegation-of-Authority
 * (DOA) limits — never whether the role can do its own operational job.
 *
 *  - officer     — frontline/desk role. Can raise a DOA limit-increase request, cannot approve one,
 *                  cannot change any role's section visibility or DOA cap.
 *  - supervisor  — first-line approver. May change officer-level roles only.
 *  - manager     — second-line approver. May change officer- and supervisor-level roles.
 *  - executive   — platform owner (Administration). May change everything; DOA is unlimited.
 */
export type RoleAuthorityLevel = 'officer' | 'supervisor' | 'manager' | 'executive';

export type RoleFamily =
  | 'governance-config'
  | 'distribution-config'
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
  | 'restricted-section-access'
  /** An officer-level role asking its supervisor/manager to raise its own DOA cap. */
  | 'doa-limit-increase';

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

export interface SecurityRole {
  readonly id: string;
  readonly name: string;
  readonly title: string;
  readonly family: RoleFamily;
  readonly badge: string;
  readonly summary: string;
  /** True only for the executive superuser role (Administration) that bypasses all tab/DOA restrictions. */
  readonly unrestricted: boolean;
  /** Operational rank used for DOA and access-change authority. */
  readonly authorityLevel: RoleAuthorityLevel;
  readonly entityScope: string;       // e.g. '*', 'ALK-CONV', 'ALK-TKF', 'ALK-MY'
  readonly channelScope: string;      // e.g. '*', 'HEAD-OFFICE', 'AGENCY', 'BROKER-MARSH', 'BANCA', 'AGGREGATOR', 'DIRECT', 'REFERRAL'
  readonly subChannelScope: string;   // e.g. '*', 'AGENCY-DESK-1', 'MARSH-CALL-CENTRE', 'BANCA-PREMIER-1', 'BRANCH-RETAIL-01', ...
  /** Optional named partner a coordinator role is scoped to; `*` means every partner. */
  readonly partnerScope?: string;
  readonly defaultLandingTab: string;
  /** @deprecated use reportsToRoleId — kept for API compatibility. */
  readonly reportsToProfileId: string | null;
  readonly reportsToRoleId: string | null;
  /** @deprecated use escalationRoleId — kept for API compatibility. */
  readonly escalationProfileId: string | null;
  readonly escalationRoleId: string | null;
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

/** A role is not a user account. A future UserAccount/login layer will reference one role id. */
export type SecurityProfile = SecurityRole;
export type ProfileFamily = RoleFamily;

export interface AuthorityTier {
  readonly id: RoleAuthorityLevel;
  readonly rank: number;
  readonly label: string;
  readonly description: string;
  readonly canChangeDoa: boolean;
  readonly canManageRoleAccess: boolean;
}

export const AUTHORITY_TIERS: readonly AuthorityTier[] = Object.freeze([
  { id: 'officer', rank: 1, label: 'Officer', description: 'Operates within an assigned DOA cap; can request a limit increase but cannot change access or caps.', canChangeDoa: false, canManageRoleAccess: false },
  { id: 'supervisor', rank: 2, label: 'Supervisor', description: 'First-line approver; may change officer-level DOA caps and section visibility.', canChangeDoa: true, canManageRoleAccess: true },
  { id: 'manager', rank: 3, label: 'Manager', description: 'Second-line approver; may change officer- and supervisor-level DOA caps and section visibility.', canChangeDoa: true, canManageRoleAccess: true },
  { id: 'executive', rank: 4, label: 'Executive', description: 'Platform owner with unrestricted access and unlimited DOA authority.', canChangeDoa: true, canManageRoleAccess: true },
]);

export function authorityTier(level: RoleAuthorityLevel): AuthorityTier {
  return AUTHORITY_TIERS.find((t) => t.id === level) ?? AUTHORITY_TIERS[0]!;
}

export function authorityRank(level: RoleAuthorityLevel): number {
  return authorityTier(level).rank;
}

export function canChangeDoa(role: Pick<SecurityRole, 'unrestricted' | 'authorityLevel'>): boolean {
  return role.unrestricted || authorityTier(role.authorityLevel).canChangeDoa;
}

export function canManageRoleAccess(role: Pick<SecurityRole, 'unrestricted' | 'authorityLevel'>): boolean {
  return role.unrestricted || authorityTier(role.authorityLevel).canManageRoleAccess;
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
  /** Set when an approved `doa-limit-increase` request actually moved the role's cap. */
  readonly appliedDoaLimitLabel?: string | null;
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
  /** Role-first aliases for the same recommendation. */
  readonly roleId: string;
  readonly roleName: string;
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
  { id: 'governance-config', label: 'Governance & Configuration', description: 'Administration (complete unrestricted access), cross-desk Supervisor and Configuration Analyst' },
  { id: 'distribution-config', label: 'Omni-Channel Coordination', description: 'Channel, partner and sub-channel-partner coordinator role templates; clone and scope them per route' },
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
      { id: 'profile-directory', label: 'Security Role Directory', subSections: [{ id: 'profile-switcher', label: 'Role Session Switcher' }, { id: 'profile-clone', label: 'Role Builder' }] },
      { id: 'ai-advisor', label: 'AI Access & SoD Advisor', subSections: [{ id: 'ai-scoring', label: 'Tab/Section AI Scoring' }, { id: 'sod-guard', label: 'Segregation of Duties Check' }] },
      { id: 'matrix-editor', label: 'Tab / Section / Sub-Section Matrix', subSections: [{ id: 'tab-grants', label: 'Tab Permissions' }, { id: 'section-grants', label: 'Section & Sub-Section Grants' }] },
      { id: 'supervision-map', label: 'Entity × Channel × Sub-Channel Mapping', subSections: [{ id: 'hierarchy-rules', label: 'Supervisor & Manager Chain' }, { id: 'channel-caps', label: 'Channel DOA Caps' }] },
      { id: 'doa-queue', label: 'DOA Approval Queue & Notifications', subSections: [{ id: 'doa-simulator', label: 'DOA Gate Simulator' }, { id: 'approver-inbox', label: 'Approver Decision Inbox' }] },
    ],
  },
  {
    tabId: 'role-matrix',
    label: 'Role access matrix',
    sections: [
      { id: 'role-directory', label: 'Role Directory & Authority Tiers', subSections: [{ id: 'role-switcher', label: 'Role Session Switcher' }, { id: 'authority-tier', label: 'Officer / Supervisor / Manager Tiers' }] },
      { id: 'access-tree', label: 'Tab → Section → Sub-Section Visibility Tree', subSections: [{ id: 'tab-visibility', label: 'Tab Visibility & Edit Rights' }, { id: 'section-visibility', label: 'Section Enable / Disable' }, { id: 'sub-section-visibility', label: 'Sub-Section Enable / Disable' }] },
      { id: 'doa-limits', label: 'DOA Limit Governance & Increase Requests', subSections: [{ id: 'doa-limit-editor', label: 'Supervisor & Manager Limit Editor' }, { id: 'doa-increase-requests', label: 'Officer Limit-Increase Requests' }] },
      { id: 'role-audit', label: 'Role, Access & DOA Change Audit Trail', subSections: [{ id: 'access-change-log', label: 'Access Change Log' }] },
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
    tabId: DISTRIBUTION_CONFIG_TAB_IDS['omni-channel'],
    label: 'Omni-channel configuration',
    sections: [
      { id: 'scope-directory', label: 'Channel Scope Directory', subSections: [{ id: 'scope-picker', label: 'Channel & Coordinator Scope' }, { id: 'scope-audit', label: 'Configuration Audit Trail' }] },
      { id: 'product-assignment', label: 'Product Type, Product & Sub-Product Assignment', subSections: [{ id: 'product-type', label: 'Product Type' }, { id: 'product', label: 'Product' }, { id: 'sub-products', label: 'Sub-Products' }] },
      { id: 'commercial-terms', label: 'Commission, Premium Uplift & Disbursement', subSections: [{ id: 'commission', label: 'Commission Schedule' }, { id: 'premium-uplift', label: 'Premium Uplift Percentage' }, { id: 'disbursement', label: 'Commission Disbursement Terms' }] },
      { id: 'clawback-rules', label: 'Clawback Rules', subSections: [{ id: 'clawback-schedule', label: 'Recovery Schedule' }, { id: 'clawback-trigger', label: 'Trigger & Basis' }] },
    ],
  },
  {
    tabId: DISTRIBUTION_CONFIG_TAB_IDS.partner,
    label: 'Partner configuration',
    sections: [
      { id: 'scope-directory', label: 'Partner Scope Directory', subSections: [{ id: 'scope-picker', label: 'Channel & Partner Scope' }, { id: 'scope-audit', label: 'Configuration Audit Trail' }] },
      { id: 'product-assignment', label: 'Product Type, Product & Sub-Product Assignment', subSections: [{ id: 'product-type', label: 'Product Type' }, { id: 'product', label: 'Product' }, { id: 'sub-products', label: 'Sub-Products' }] },
      { id: 'commercial-terms', label: 'Commission, Premium Uplift & Disbursement', subSections: [{ id: 'commission', label: 'Commission Schedule' }, { id: 'premium-uplift', label: 'Premium Uplift Percentage' }, { id: 'disbursement', label: 'Commission Disbursement Terms' }] },
      { id: 'clawback-rules', label: 'Clawback Rules', subSections: [{ id: 'clawback-schedule', label: 'Recovery Schedule' }, { id: 'clawback-trigger', label: 'Trigger & Basis' }] },
    ],
  },
  {
    tabId: DISTRIBUTION_CONFIG_TAB_IDS['sub-channel-partner'],
    label: 'Sub-channel partners',
    sections: [
      { id: 'scope-directory', label: 'Sub-Channel Partner Scope Directory', subSections: [{ id: 'scope-picker', label: 'Channel, Partner & Sub-Channel Scope' }, { id: 'scope-audit', label: 'Configuration Audit Trail' }] },
      { id: 'product-assignment', label: 'Product Type, Product & Sub-Product Assignment', subSections: [{ id: 'product-type', label: 'Product Type' }, { id: 'product', label: 'Product' }, { id: 'sub-products', label: 'Sub-Products' }] },
      { id: 'commercial-terms', label: 'Commission, Premium Uplift & Disbursement', subSections: [{ id: 'commission', label: 'Commission Schedule' }, { id: 'premium-uplift', label: 'Premium Uplift Percentage' }, { id: 'disbursement', label: 'Commission Disbursement Terms' }] },
      { id: 'clawback-rules', label: 'Clawback Rules', subSections: [{ id: 'clawback-schedule', label: 'Recovery Schedule' }, { id: 'clawback-trigger', label: 'Trigger & Basis' }] },
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
    tabId: 'reconciliation',
    label: 'Partner reconciliation',
    sections: [
      { id: 'scope-hierarchy', label: 'Insurer Channel Types & Partner Ownership Scope', subSections: [{ id: 'channel-types', label: 'Configurable Channel & Sub-Channel Types' }] },
      { id: 'column-mapping', label: 'Identity-Only Header Mapping & Human Confirmation', subSections: [{ id: 'header-confirm', label: 'Source Header Proposal & Confirmation' }] },
      { id: 'identity-matching', label: 'Deterministic Scoped Policy Identity Matching', subSections: [{ id: 'scoped-runs', label: 'Exact, Safe Variant & Quarantine Findings' }] },
      { id: 'proposal-review', label: 'Tentative Proposal Human Review & Audit Trail', subSections: [{ id: 'review-queue', label: 'Confirm or Reject Tentative Proposals' }] },
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
  readonly family: RoleFamily;
  readonly badge: string;
  readonly summary: string;
  readonly unrestricted?: boolean;
  readonly entityScope: string;
  readonly channelScope: string;
  readonly subChannelScope: string;
  readonly partnerScope?: string;
  readonly defaultLandingTab: string;
  readonly reportsToProfileId: string | null;
  readonly escalationProfileId: string | null;
  /** Optional explicit authority tier; otherwise derived from the role id. */
  readonly authorityLevel?: RoleAuthorityLevel;
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

export const ROLE_MATRIX_TAB_ID = 'role-matrix';
export const ADMIN_ONLY_TAB_IDS: ReadonlySet<string> = new Set(['access-doa', ROLE_MATRIX_TAB_ID]);
/** Dedicated distribution-configuration tabs are never handed out to unrelated operational roles. */
export const DISTRIBUTION_CONFIG_TAB_ID_SET: ReadonlySet<string> = new Set(Object.values(DISTRIBUTION_CONFIG_TAB_IDS));
export const DISTRIBUTION_CONFIG_ALLOWED_ROLE_IDS: ReadonlySet<string> = new Set([
  'administration', 'configurator', 'omni-channel-coordinator', 'partner-coordinator', 'sub-channel-coordinator',
]);

function mayUseDistributionConfigTabs(role: Pick<SecurityRole, 'id' | 'family' | 'unrestricted'>): boolean {
  return role.unrestricted
    || DISTRIBUTION_CONFIG_ALLOWED_ROLE_IDS.has(role.id)
    || role.family === 'distribution-config';
}

const ALL_TAB_IDS = CONSOLE_TABS.length > 0
  ? Array.from(new Set([...CONSOLE_TABS.map((t) => t.id), 'access-doa', ROLE_MATRIX_TAB_ID]))
  : SECURITY_SURFACE_CATALOGUE.map((c) => c.tabId);

/** Roles that hold second-line manager authority (may change officer and supervisor roles). */
const MANAGER_ROLE_IDS = new Set([
  'underwriter-manager', 'retention-manager', 'claim-manager', 'settlement-manager',
  'reinsurance-manager', 'fund-investment-manager', 'bank-manager', 'branch-manager', 'finance',
]);

/** Roles that hold first-line supervisor authority (may change officer roles only). */
const SUPERVISOR_ROLE_IDS = new Set([
  'supervisor', 'endorsement-supervisor', 'agent-supervisor', 'banca-supervisor',
  'omni-channel-coordinator', 'partner-coordinator', 'sub-channel-coordinator',
]);

function authorityLevelForSeed(spec: ProfileSeedSpec): RoleAuthorityLevel {
  if (spec.authorityLevel) return spec.authorityLevel;
  if (spec.unrestricted) return 'executive';
  if (MANAGER_ROLE_IDS.has(spec.id)) return 'manager';
  if (SUPERVISOR_ROLE_IDS.has(spec.id)) return 'supervisor';
  return 'officer';
}

function buildGranularMaps(spec: ProfileSeedSpec): {
  tabAccess: Record<string, AccessLevel>;
  sectionAccess: Record<string, AccessLevel>;
  subSectionAccess: Record<string, AccessLevel>;
} {
  const tabAccess: Record<string, AccessLevel> = {};
  const sectionAccess: Record<string, AccessLevel> = {};
  const subSectionAccess: Record<string, AccessLevel> = {};
  const distributionAllowed = mayUseDistributionConfigTabs({
    id: spec.id, family: spec.family, unrestricted: Boolean(spec.unrestricted),
  });

  for (const tabId of ALL_TAB_IDS) {
    if (spec.unrestricted) {
      tabAccess[tabId] = 'full';
    } else if (ADMIN_ONLY_TAB_IDS.has(tabId)) {
      // Access & DOA and Role access matrix tabs are restricted strictly to Administration.
      tabAccess[tabId] = 'none';
    } else if (DISTRIBUTION_CONFIG_TAB_ID_SET.has(tabId) && !distributionAllowed) {
      // The three distribution configuration screens belong to the configuration analyst and the
      // scoped coordinator templates, never to a general operational or partner role.
      tabAccess[tabId] = 'none';
    } else if (spec.fullTabs.includes(tabId)) {
      tabAccess[tabId] = 'full';
    } else if ((spec.readTabs ?? []).includes(tabId)) {
      tabAccess[tabId] = 'read';
    } else {
      tabAccess[tabId] = 'none';
    }
  }

  // Only *explicit* section / sub-section grants are stored. Everything else inherits from its
  // parent at read time, which is what makes the enable/disable tree explainable: a node marked
  // "inherit" really has no override of its own, and moving the tab moves the whole branch.
  for (const entry of SECURITY_SURFACE_CATALOGUE) {
    const adminOnly = ADMIN_ONLY_TAB_IDS.has(entry.tabId);
    const blockedDistribution = DISTRIBUTION_CONFIG_TAB_ID_SET.has(entry.tabId) && !distributionAllowed;
    for (const sec of entry.sections) {
      const sKey = `${entry.tabId}:${sec.id}`;
      if (spec.unrestricted) {
        sectionAccess[sKey] = 'full';
      } else if (!adminOnly && !blockedDistribution && spec.sectionOverrides?.[sKey] !== undefined) {
        sectionAccess[sKey] = spec.sectionOverrides[sKey]!;
      }
      for (const sub of sec.subSections) {
        const subKey = `${entry.tabId}:${sec.id}:${sub.id}`;
        if (spec.unrestricted) {
          subSectionAccess[subKey] = 'full';
        } else if (!adminOnly && !blockedDistribution && spec.subSectionOverrides?.[subKey] !== undefined) {
          subSectionAccess[subKey] = spec.subSectionOverrides[subKey]!;
        }
      }
    }
  }
  return { tabAccess, sectionAccess, subSectionAccess };
}

/** Built-in enterprise role templates. Roles are permission templates, not named user logins. */
const PROFILE_SEEDS: readonly ProfileSeedSpec[] = [
  // ======================== 1. GOVERNANCE & CONFIGURATION (3) ========================
  {
    id: 'administration',
    name: 'Administration',
    title: 'Chief Platform & Security Administrator (Complete Access)',
    family: 'governance-config',
    badge: 'FULL UNRESTRICTED ACCESS',
    summary: 'Complete unrestricted superuser access across every console tab, section and sub-section, Master Settings, RBAC & DOA governance, and unlimited override authority.',
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
    defaultLandingTab: 'overview',
    reportsToProfileId: 'administration',
    escalationProfileId: 'administration',
    doaLimitAed: '1,500,000.00',
    doaActions: ['quote-high-sum-assured', 'discount-concession', 'endorsement-alteration', 'restricted-section-access'],
    piiAccess: 'full',
    fullTabs: ['overview', 'journey', 'policyholder', 'onboarding', 'parties', 'ingest', 'reconciliation', 'ai'],
    readTabs: ['underwriting', 'claims', 'email', 'warehouse', 'whats-new', 'tour'],
    aiConfidencePct: 96,
    aiRationale: 'Cross-desk queue oversight, human AI review, DOA inbox management, and read-only visibility into technical claims/underwriting.',
  },
  {
    id: 'configurator',
    name: 'Configuration Analyst',
    title: 'Product, Rating, Distribution & Platform Configuration Analyst',
    family: 'governance-config',
    badge: 'CONFIGURATION ANALYST',
    summary: 'The configuration-analyst role (id retained as `configurator` for API compatibility): files product shelf, tariff, distribution, commission, uplift, disbursement, clawback, email and branding settings.',
    entityScope: '*',
    channelScope: '*',
    subChannelScope: '*',
    partnerScope: '*',
    defaultLandingTab: 'master',
    reportsToProfileId: 'administration',
    escalationProfileId: 'administration',
    doaLimitAed: '500,000.00',
    doaActions: ['master-config-change'],
    piiAccess: 'masked',
    fullTabs: [
      'master', 'email', 'labels', 'theme', 'reconciliation',
      DISTRIBUTION_CONFIG_TAB_IDS['omni-channel'], DISTRIBUTION_CONFIG_TAB_IDS.partner, DISTRIBUTION_CONFIG_TAB_IDS['sub-channel-partner'],
    ],
    readTabs: ['overview', 'journey', 'funds', 'regulatory', 'whats-new', 'tour'],
    aiConfidencePct: 98,
    aiRationale: 'Full control over non-cash configuration surfaces while masking customer PII and blocking direct claim payouts or GL postings (SoD safe).',
  },

  // ======================== 1b. OMNI-CHANNEL COORDINATION (3) ========================
  {
    id: 'omni-channel-coordinator',
    name: 'Omni-Channel Coordinator',
    title: 'Per-Channel Distribution Configuration Coordinator',
    family: 'distribution-config',
    badge: 'CHANNEL COORDINATOR',
    summary: 'Supervisor-tier template for one omni-channel (clone and set `channelScope` per channel). Files channel-wide product, commission, uplift, disbursement and clawback terms; partner and sub-channel tabs remain read-only.',
    entityScope: 'ALK-CONV',
    channelScope: '*',
    subChannelScope: '*',
    partnerScope: '*',
    defaultLandingTab: DISTRIBUTION_CONFIG_TAB_IDS['omni-channel'],
    reportsToProfileId: 'supervisor',
    escalationProfileId: 'administration',
    doaLimitAed: '250,000.00',
    doaActions: ['master-config-change', 'discount-concession'],
    piiAccess: 'masked',
    fullTabs: ['overview', 'tour', DISTRIBUTION_CONFIG_TAB_IDS['omni-channel']],
    readTabs: ['master', 'whats-new', DISTRIBUTION_CONFIG_TAB_IDS.partner, DISTRIBUTION_CONFIG_TAB_IDS['sub-channel-partner']],
    aiConfidencePct: 94,
    aiRationale: 'Owns channel-level distribution terms and needs read-only sight of narrower partner and sub-channel overrides to keep escalation coherent.',
  },
  {
    id: 'partner-coordinator',
    name: 'Partner Coordinator',
    title: 'Per-Partner Distribution Configuration Coordinator',
    family: 'distribution-config',
    badge: 'PARTNER COORDINATOR',
    summary: 'Supervisor-tier template for one named partner (clone and set `partnerScope`). Files partner-specific products, commission, premium uplift, disbursement and clawback terms, with channel and sub-channel context visible read-only.',
    entityScope: 'ALK-CONV',
    channelScope: '*',
    subChannelScope: '*',
    partnerScope: '*',
    defaultLandingTab: DISTRIBUTION_CONFIG_TAB_IDS.partner,
    reportsToProfileId: 'supervisor',
    escalationProfileId: 'administration',
    doaLimitAed: '200,000.00',
    doaActions: ['master-config-change', 'discount-concession'],
    piiAccess: 'masked',
    fullTabs: ['overview', 'tour', DISTRIBUTION_CONFIG_TAB_IDS.partner],
    readTabs: ['master', 'whats-new', DISTRIBUTION_CONFIG_TAB_IDS['omni-channel'], DISTRIBUTION_CONFIG_TAB_IDS['sub-channel-partner']],
    aiConfidencePct: 94,
    aiRationale: 'Owns partner contract terms while inheriting channel ceilings and inspecting narrower sub-channel partner overrides.',
  },
  {
    id: 'sub-channel-coordinator',
    name: 'Sub-Channel Coordinator',
    title: 'Per-Sub-Channel Partner Distribution Configuration Coordinator',
    family: 'distribution-config',
    badge: 'SUB-CHANNEL COORDINATOR',
    summary: 'Supervisor-tier template for one sub-channel × partner pair (clone and set `subChannelScope` and `partnerScope`). Files the most specific product, commission, uplift, disbursement and clawback terms.',
    entityScope: 'ALK-CONV',
    channelScope: '*',
    subChannelScope: '*',
    partnerScope: '*',
    defaultLandingTab: DISTRIBUTION_CONFIG_TAB_IDS['sub-channel-partner'],
    reportsToProfileId: 'supervisor',
    escalationProfileId: 'administration',
    doaLimitAed: '150,000.00',
    doaActions: ['master-config-change', 'discount-concession'],
    piiAccess: 'masked',
    fullTabs: ['overview', 'tour', DISTRIBUTION_CONFIG_TAB_IDS['sub-channel-partner']],
    readTabs: ['master', 'whats-new', DISTRIBUTION_CONFIG_TAB_IDS['omni-channel'], DISTRIBUTION_CONFIG_TAB_IDS.partner],
    aiConfidencePct: 95,
    aiRationale: 'Owns the narrowest commercial scope and needs read-only sight of the parent channel and partner terms it can override.',
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
    readTabs: ['overview', 'journey', 'parties', 'reinsurance', 'regulatory'],
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
    fullTabs: ['overview', 'underwriting', 'journey', 'onboarding', 'parties', 'ai'],
    readTabs: ['reinsurance', 'regulatory', 'policyholder', 'master'],
    aiConfidencePct: 99,
    aiRationale: 'Full underwriting authority up to 5M AED across Conventional & Takaful books, plus human sign-off on AI referrals and officer escalations.',
  },
  {
    id: 'retention-officer',
    name: 'Retention Officer',
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
    readTabs: ['overview', 'journey', 'parties', 'email', 'funds'],
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
    fullTabs: ['overview', 'policyholder', 'decisions', 'cover', 'email'],
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
    readTabs: ['overview', 'decisions', 'underwriting', 'email'],
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
    fullTabs: ['overview', 'policyholder', 'parties', 'decisions', 'cover'],
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
    readTabs: ['overview', 'policyholder', 'parties', 'cover', 'underwriting'],
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
    fullTabs: ['overview', 'claims', 'takaful', 'ai'],
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
    readTabs: ['overview', 'parties', 'ledger', 'funds-accounting'],
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
    fullTabs: ['overview', 'claims', 'policyholder', 'batch'],
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
    readTabs: ['overview', 'underwriting', 'claims', 'takaful', 'regulatory'],
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
    fullTabs: ['overview', 'reinsurance', 'takaful', 'regulatory'],
    readTabs: ['underwriting', 'claims', 'group', 'ledger', 'warehouse'],
    aiConfidencePct: 99,
    aiRationale: 'Authorizes ceded placements & security releases up to 10M AED with full UAE reinsurance rule-book and statutory return access.',
  },

  // ======================== 4. BANCASSURANCE OPS, FINANCE & FUNDS (7) ========================
  {
    id: 'bancassurance-operations-officer',
    name: 'Bancassurance Operations Officer',
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
    fullTabs: ['ingest', 'reconciliation', 'onboarding', 'journey', 'policyholder', 'batch'],
    readTabs: ['overview', 'parties', 'email', 'warehouse'],
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
    readTabs: ['overview', 'master', 'takaful', 'policyholder'],
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
    fullTabs: ['ledger', 'funds-accounting', 'batch', 'reconciliation'],
    readTabs: ['overview', 'group', 'takaful', 'warehouse', 'claims', 'reinsurance'],
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
    fullTabs: ['overview', 'group', 'ledger', 'funds-accounting', 'batch', 'reconciliation', 'warehouse', 'durability'],
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
    fullTabs: ['warehouse', 'reconciliation', 'ai', 'batch'],
    readTabs: ['overview', 'group', 'ledger', 'funds-accounting', 'super-funds', 'master'],
    subSectionOverrides: {
      'master:omni-providers:channels-commissions': 'full',
      'master:charges-authority:ul-charges': 'full',
    },
    aiConfidencePct: 96,
    aiRationale: 'Pinpoint visibility into commission schedules, charge tables, clawback batches, warehouse cost lineage and AI spend telemetry.',
  },
  {
    id: 'fund-investment-officer',
    name: 'Fund Investment Officer',
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
    readTabs: ['overview', 'policyholder', 'funds-accounting', 'takaful'],
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
    fullTabs: ['overview', 'funds', 'super-funds', 'funds-accounting', 'takaful', 'decisions'],
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
    readTabs: ['overview', 'policyholder', 'cover'],
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
    readTabs: ['overview', 'policyholder', 'takaful', 'cover'],
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
    readTabs: ['overview', 'policyholder', 'reinsurance', 'regulatory'],
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
    defaultLandingTab: 'overview',
    reportsToProfileId: 'underwriter-manager',
    escalationProfileId: 'administration',
    doaLimitAed: '1,500,000.00',
    doaActions: ['quote-high-sum-assured', 'discount-concession', 'retention-waiver'],
    piiAccess: 'full',
    fullTabs: ['overview', 'journey', 'onboarding', 'parties', 'decisions', 'reconciliation'],
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
    readTabs: ['overview', 'policyholder', 'funds'],
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
    readTabs: ['overview', 'policyholder', 'takaful', 'funds'],
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
    defaultLandingTab: 'overview',
    reportsToProfileId: 'bank-manager',
    escalationProfileId: 'underwriter-manager',
    doaLimitAed: '1,500,000.00',
    doaActions: ['quote-high-sum-assured', 'discount-concession', 'endorsement-alteration'],
    piiAccess: 'full',
    fullTabs: ['overview', 'journey', 'onboarding', 'parties', 'ingest', 'reconciliation', 'decisions'],
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
    readTabs: ['overview', 'cover'],
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
    defaultLandingTab: 'overview',
    reportsToProfileId: 'bank-manager',
    escalationProfileId: 'underwriter-manager',
    doaLimitAed: '750,000.00',
    doaActions: ['quote-high-sum-assured', 'discount-concession', 'retention-waiver'],
    piiAccess: 'full',
    fullTabs: ['overview', 'journey', 'onboarding', 'parties', 'policyholder'],
    readTabs: ['decisions', 'underwriting', 'warehouse', 'reconciliation'],
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
    fullTabs: ['overview', 'journey', 'policyholder', 'decisions', 'warehouse', 'reconciliation'],
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
    readTabs: ['regulatory', 'decisions'],
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
    readTabs: ['decisions'],
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
    readTabs: ['decisions', 'takaful'],
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
        authorityLevel: authorityLevelForSeed(seed),
        entityScope: seed.entityScope,
        channelScope: seed.channelScope,
        subChannelScope: seed.subChannelScope,
        ...(seed.partnerScope ? { partnerScope: seed.partnerScope } : {}),
        defaultLandingTab: seed.defaultLandingTab,
        reportsToProfileId: seed.reportsToProfileId,
        reportsToRoleId: seed.reportsToProfileId,
        escalationProfileId: seed.escalationProfileId,
        escalationRoleId: seed.escalationProfileId,
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

  listProfiles(): SecurityRole[] {
    return [...this.profiles.values()];
  }

  /** Roles are the unit of access; a future UserAccount/login layer will reference one role id. */
  listRoles(): SecurityRole[] {
    return this.listProfiles();
  }

  getProfile(profileId: string): SecurityRole {
    const p = this.profiles.get(profileId.trim());
    if (!p) throw new SecurityGovernanceError(`unknown security role "${profileId}"`);
    return p;
  }

  getRole(roleId: string): SecurityRole {
    return this.getProfile(roleId);
  }

  selectActiveProfile(profileId: string, at?: string): SecurityRole {
    const role = this.getProfile(profileId);
    this.activeProfileId = role.id;
    this.recordAudit(role.id, 'session.role-selected', `Entered ERP session as role "${role.name}" (${role.title}, ${authorityTier(role.authorityLevel).label}) on landing tab "${role.defaultLandingTab}".`, at);
    return role;
  }

  selectActiveRole(roleId: string, at?: string): SecurityRole {
    return this.selectActiveProfile(roleId, at);
  }

  activeProfile(): SecurityRole {
    return this.getProfile(this.activeProfileId);
  }

  activeRole(): SecurityRole {
    return this.activeProfile();
  }

  activeRoleId(): string {
    return this.activeProfileId;
  }

  private resolveActor(actorId?: string): SecurityRole {
    const id = (actorId ?? this.activeProfileId).trim();
    const role = this.profiles.get(id);
    if (role) return role;
    // Internal automation is allowed to write through the security administrator, never silently
    // through a made-up higher role supplied by a caller.
    if (id === 'ai-rbac-advisor' || id === 'security-seed' || id === 'system') {
      return this.getProfile('administration');
    }
    throw new SecurityGovernanceError(`unknown acting role "${actorId}"`);
  }

  private assertHigherAuthority(actor: SecurityRole, target: SecurityRole, verb: string): void {
    if (actor.unrestricted) return;
    if (authorityRank(actor.authorityLevel) <= authorityRank(target.authorityLevel)) {
      throw new SecurityGovernanceError(
        `Authority refusal: ${authorityTier(actor.authorityLevel).label} role "${actor.name}" cannot ${verb} ${authorityTier(target.authorityLevel).label} role "${target.name}". ` +
        `Only a higher authority tier may do that.`,
      );
    }
  }

  private levelRank(level: AccessLevel): number {
    return level === 'full' ? 3 : level === 'read' ? 2 : 1;
  }

  private assertGrantWithinActor(input: {
    actor: SecurityRole;
    actorLevel: AccessLevel;
    requested: AccessLevel;
    label: string;
  }): void {
    if (input.actor.unrestricted || input.requested === 'none') return;
    if (this.levelRank(input.requested) > this.levelRank(input.actorLevel)) {
      throw new SecurityGovernanceError(
        `Authority refusal: ${input.actor.name} holds ${input.actorLevel} on ${input.label} and cannot grant ${input.requested}. ` +
        `A role cannot delegate more access than it holds itself.`,
      );
    }
  }

  private assertCanManageAccess(actor: SecurityRole, target: SecurityRole, verb: string): void {
    if (!canManageRoleAccess(actor)) {
      throw new SecurityGovernanceError(
        `Officer-level role "${actor.name}" cannot ${verb}. ` +
        `Tab / section visibility and DOA limits are changed at supervisor or manager level only; officers raise a DOA limit-increase request instead.`,
      );
    }
    this.assertHigherAuthority(actor, target, verb);
  }

  canAccessTab(profileId: string, tabId: string): AccessLevel {
    const p = this.getProfile(profileId);
    if (p.unrestricted) return 'full';
    if (ADMIN_ONLY_TAB_IDS.has(tabId)) return 'none';
    if (DISTRIBUTION_CONFIG_TAB_ID_SET.has(tabId) && !mayUseDistributionConfigTabs(p)) return 'none';
    return p.tabAccess[tabId] ?? 'none';
  }

  canAccessSection(profileId: string, tabId: string, sectionId: string): AccessLevel {
    const p = this.getProfile(profileId);
    if (p.unrestricted) return 'full';
    if (ADMIN_ONLY_TAB_IDS.has(tabId)) return 'none';
    if (DISTRIBUTION_CONFIG_TAB_ID_SET.has(tabId) && !mayUseDistributionConfigTabs(p)) return 'none';
    return p.sectionAccess[`${tabId}:${sectionId}`] ?? this.canAccessTab(profileId, tabId);
  }

  canAccessSubSection(profileId: string, tabId: string, sectionId: string, subSectionId: string): AccessLevel {
    const p = this.getProfile(profileId);
    if (p.unrestricted) return 'full';
    if (ADMIN_ONLY_TAB_IDS.has(tabId)) return 'none';
    if (DISTRIBUTION_CONFIG_TAB_ID_SET.has(tabId) && !mayUseDistributionConfigTabs(p)) return 'none';
    return p.subSectionAccess[`${tabId}:${sectionId}:${subSectionId}`] ?? this.canAccessSection(profileId, tabId, sectionId);
  }

  upsertProfile(input: {
    id: string;
    name?: string;
    title?: string;
    family?: RoleFamily;
    badge?: string;
    summary?: string;
    entityScope?: string;
    channelScope?: string;
    subChannelScope?: string;
    partnerScope?: string;
    defaultLandingTab?: string;
    reportsToProfileId?: string | null;
    escalationProfileId?: string | null;
    authorityLevel?: RoleAuthorityLevel;
    doaLimitAed?: string | null;
    doaActions?: readonly DoaActionKind[];
    piiAccess?: 'full' | 'masked' | 'own-only';
    tabAccess?: Record<string, AccessLevel>;
    sectionAccess?: Record<string, AccessLevel>;
    subSectionAccess?: Record<string, AccessLevel>;
    cloneFromProfileId?: string;
    /** The role making the change. Without it `by` is used, then the active session role. */
    actorProfileId?: string;
    by?: string;
    at?: string;
  }): SecurityRole {
    const cleanId = input.id.trim().toLowerCase().replace(/[^a-z0-9-]+/g, '-');
    if (!cleanId) throw new SecurityGovernanceError('role id is required');

    const existing = this.profiles.get(cleanId)
      ?? (input.cloneFromProfileId ? this.getProfile(input.cloneFromProfileId) : this.getProfile('agent-1'));
    const isNew = !this.profiles.has(cleanId);
    const actor = this.resolveActor(input.actorProfileId ?? input.by);
    const targetRole = { id: cleanId, family: input.family ?? existing.family, unrestricted: false };

    if (cleanId === 'administration') {
      throw new SecurityGovernanceError('Administration holds permanent complete unrestricted access and cannot have permissions removed');
    }

    // Changing a role is itself an authority act. Officers cannot change roles at all; a supervisor or
    // manager may only change roles below their own tier.
    this.assertCanManageAccess(actor, existing, isNew ? 'create or clone a role' : 'change this role');
    if (input.authorityLevel && input.authorityLevel !== existing.authorityLevel && !actor.unrestricted) {
      throw new SecurityGovernanceError('Only the executive Administration role may change a role authority tier');
    }

    if (input.reportsToProfileId) this.getProfile(input.reportsToProfileId);
    if (input.escalationProfileId) this.getProfile(input.escalationProfileId);

    if (input.defaultLandingTab && ADMIN_ONLY_TAB_IDS.has(input.defaultLandingTab.trim())) {
      throw new SecurityGovernanceError('Access & DOA and Role access matrix tabs are restricted to the Administration profile only');
    }

    // A tab change re-seats its whole branch: child overrides are cleared so they inherit the new tab
    // level, unless the caller supplied an explicit child grant in the same request.
    const nextTabAccess: Record<string, AccessLevel> = { ...existing.tabAccess, ...(input.tabAccess ?? {}) };
    const nextSectionAccess: Record<string, AccessLevel> = { ...existing.sectionAccess, ...(input.sectionAccess ?? {}) };
    const nextSubAccess: Record<string, AccessLevel> = { ...existing.subSectionAccess, ...(input.subSectionAccess ?? {}) };

    if (input.tabAccess) {
      for (const [tabId, level] of Object.entries(input.tabAccess)) {
        if (ADMIN_ONLY_TAB_IDS.has(tabId) && level !== 'none') {
          throw new SecurityGovernanceError('Access & DOA and Role access matrix tabs are restricted to the Administration profile only');
        }
        if (DISTRIBUTION_CONFIG_TAB_ID_SET.has(tabId) && level !== 'none' && !mayUseDistributionConfigTabs(targetRole)) {
          throw new SecurityGovernanceError('Distribution configuration tabs are restricted to the Configuration Analyst, Administration and coordinator role family');
        }
        const cat = SECURITY_SURFACE_CATALOGUE.find((c) => c.tabId === tabId);
        this.assertGrantWithinActor({
          actor,
          actorLevel: this.canAccessTab(actor.id, tabId),
          requested: level,
          label: `tab "${tabId}"`,
        });
        if (!cat) continue;
        for (const sec of cat.sections) {
          const sKey = `${tabId}:${sec.id}`;
          if (!input.sectionAccess || !(sKey in input.sectionAccess)) delete nextSectionAccess[sKey];
          for (const sub of sec.subSections) {
            const subKey = `${tabId}:${sec.id}:${sub.id}`;
            if (!input.subSectionAccess || !(subKey in input.subSectionAccess)) delete nextSubAccess[subKey];
          }
        }
      }
    }

    if (input.sectionAccess) {
      for (const [sKey, level] of Object.entries(input.sectionAccess)) {
        const [tabId, sectionId] = sKey.split(':');
        if (tabId && ADMIN_ONLY_TAB_IDS.has(tabId) && level !== 'none') {
          throw new SecurityGovernanceError('Access & DOA and Role access matrix tabs are restricted to the Administration profile only');
        }
        if (tabId && DISTRIBUTION_CONFIG_TAB_ID_SET.has(tabId) && level !== 'none' && !mayUseDistributionConfigTabs(targetRole)) {
          throw new SecurityGovernanceError('Distribution configuration tabs are restricted to the Configuration Analyst, Administration and coordinator role family');
        }
        if (!actor.unrestricted) {
          this.assertGrantWithinActor({
            actor,
            actorLevel: tabId && sectionId ? this.canAccessSection(actor.id, tabId, sectionId) : 'none',
            requested: level,
            label: `section "${sKey}"`,
          });
        }
      }
    }
    if (input.subSectionAccess) {
      for (const [subKey, level] of Object.entries(input.subSectionAccess)) {
        const [tabId, sectionId, subId] = subKey.split(':');
        if (tabId && ADMIN_ONLY_TAB_IDS.has(tabId) && level !== 'none') {
          throw new SecurityGovernanceError('Access & DOA and Role access matrix tabs are restricted to the Administration profile only');
        }
        if (tabId && DISTRIBUTION_CONFIG_TAB_ID_SET.has(tabId) && level !== 'none' && !mayUseDistributionConfigTabs(targetRole)) {
          throw new SecurityGovernanceError('Distribution configuration tabs are restricted to the Configuration Analyst, Administration and coordinator role family');
        }
        if (!actor.unrestricted) {
          this.assertGrantWithinActor({
            actor,
            actorLevel: tabId && sectionId && subId ? this.canAccessSubSection(actor.id, tabId, sectionId, subId) : 'none',
            requested: level,
            label: `sub-section "${subKey}"`,
          });
        }
      }
    }

    for (const adminTabId of ADMIN_ONLY_TAB_IDS) {
      nextTabAccess[adminTabId] = 'none';
    }
    for (const key of Object.keys(nextSectionAccess)) {
      const tabId = key.split(':')[0];
      if (tabId && ADMIN_ONLY_TAB_IDS.has(tabId)) delete nextSectionAccess[key];
    }
    for (const key of Object.keys(nextSubAccess)) {
      const tabId = key.split(':')[0];
      if (tabId && ADMIN_ONLY_TAB_IDS.has(tabId)) delete nextSubAccess[key];
    }

    const doaLimitMinor = input.doaLimitAed === undefined
      ? existing.doaLimitMinor
      : input.doaLimitAed === null || String(input.doaLimitAed).trim().toLowerCase() === 'unlimited' || String(input.doaLimitAed).trim() === ''
        ? null
        : parseAmount(String(input.doaLimitAed), 'AED').minor;

    if (input.doaLimitAed !== undefined && !actor.unrestricted) {
      if (!canChangeDoa(actor)) {
        throw new SecurityGovernanceError(
          `Officer-level role "${actor.name}" cannot change a DOA limit. ` +
          'Ask your supervisor or manager to approve a limit-increase request instead.',
        );
      }
      if (doaLimitMinor === null) {
        throw new SecurityGovernanceError('Only the executive Administration role may set an unlimited DOA');
      }
      if (actor.doaLimitMinor !== null && doaLimitMinor > actor.doaLimitMinor) {
        throw new SecurityGovernanceError(
          `Authority refusal: ${actor.name} cannot grant a DOA limit above its own cap of ${formatAmount(money(actor.doaLimitMinor, actor.currency))}`,
        );
      }
    }

    if (input.doaActions && !actor.unrestricted) {
      for (const action of input.doaActions) {
        if (!actor.doaActions.includes(action)) {
          throw new SecurityGovernanceError(
            `Authority refusal: ${actor.name} cannot grant DOA action "${action}" that it does not hold itself`,
          );
        }
      }
    }

    const updated: SecurityRole = {
      ...existing,
      id: cleanId,
      unrestricted: false,
      authorityLevel: input.authorityLevel ?? existing.authorityLevel,
      name: input.name?.trim() || existing.name,
      title: input.title?.trim() || existing.title,
      family: input.family ?? existing.family,
      badge: input.badge?.trim() || existing.badge,
      summary: input.summary?.trim() || existing.summary,
      entityScope: input.entityScope?.trim() || existing.entityScope,
      channelScope: input.channelScope?.trim() || existing.channelScope,
      subChannelScope: input.subChannelScope?.trim() || existing.subChannelScope,
      ...(input.partnerScope !== undefined || existing.partnerScope !== undefined
        ? { partnerScope: input.partnerScope?.trim() || existing.partnerScope || '*' }
        : {}),
      defaultLandingTab: input.defaultLandingTab?.trim() || existing.defaultLandingTab,
      reportsToProfileId: input.reportsToProfileId === undefined ? existing.reportsToProfileId : input.reportsToProfileId,
      reportsToRoleId: input.reportsToProfileId === undefined ? existing.reportsToRoleId : input.reportsToProfileId,
      escalationProfileId: input.escalationProfileId === undefined ? existing.escalationProfileId : input.escalationProfileId,
      escalationRoleId: input.escalationProfileId === undefined ? existing.escalationRoleId : input.escalationProfileId,
      doaLimitMinor,
      doaActions: input.doaActions ? [...new Set(input.doaActions)] : existing.doaActions,
      piiAccess: input.piiAccess ?? existing.piiAccess,
      tabAccess: nextTabAccess,
      sectionAccess: nextSectionAccess,
      subSectionAccess: nextSubAccess,
    };
    this.profiles.set(cleanId, updated);
    this.recordAudit(actor.id, 'rbac.role-upserted', `${isNew ? 'Created' : 'Updated'} role "${updated.name}" (${updated.id}) at ${authorityTier(updated.authorityLevel).label} tier.`, input.at);
    return updated;
  }

  /** Role-first alias; the old name remains for API compatibility. */
  upsertRole(input: Parameters<SecurityGovernanceRegistry['upsertProfile']>[0]): SecurityRole {
    return this.upsertProfile(input);
  }

  /**
   * Explicitly set one node of a role's Tab -> Section -> Sub-Section tree, or reset it to inherit.
   *
   * This is the write path behind the Role access matrix tab. It refuses officer-level actors, refuses
   * changes to roles at or above the actor's own tier, refuses delegating more access than the actor
   * holds, and cascades a parent change so a hidden section cannot leak a visible sub-section.
   */
  setRoleNodeAccess(input: {
    roleId: string;
    kind: 'tab' | 'section' | 'subSection';
    key: string;
    level: AccessLevel | 'inherit';
    actorProfileId?: string;
    by?: string;
    at?: string;
  }): SecurityRole {
    const actor = this.resolveActor(input.actorProfileId ?? input.by);
    const role = this.getRole(input.roleId);
    if (role.id === 'administration') {
      throw new SecurityGovernanceError('Administration is permanently unrestricted across every tab, section and sub-section');
    }
    this.assertCanManageAccess(actor, role, 'change section visibility for this role');

    const tabAccess = { ...role.tabAccess };
    const sectionAccess = { ...role.sectionAccess };
    const subSectionAccess = { ...role.subSectionAccess };
    const kindLabel = input.kind === 'subSection' ? 'sub-section' : input.kind;

    const targetTabId = input.kind === 'tab' ? input.key : input.key.split(':')[0] ?? '';
    if (ADMIN_ONLY_TAB_IDS.has(targetTabId) && input.level !== 'none' && input.level !== 'inherit') {
      throw new SecurityGovernanceError('Access & DOA and Role access matrix tabs are restricted to the Administration profile only');
    }
    if (
      DISTRIBUTION_CONFIG_TAB_ID_SET.has(targetTabId)
      && !mayUseDistributionConfigTabs(role)
      && input.level !== 'none'
      && input.level !== 'inherit'
    ) {
      throw new SecurityGovernanceError('Distribution configuration tabs are restricted to the Configuration Analyst, Administration and coordinator role family');
    }

    if (input.kind === 'tab') {
      const cat = SECURITY_SURFACE_CATALOGUE.find((c) => c.tabId === input.key);
      if (!cat) throw new SecurityGovernanceError(`unknown tab "${input.key}"`);
      if (input.level === 'inherit') throw new SecurityGovernanceError('A tab has no parent to inherit from; choose full, read or none');
      this.assertGrantWithinActor({
        actor,
        actorLevel: this.canAccessTab(actor.id, input.key),
        requested: input.level,
        label: `tab "${input.key}"`,
      });
      tabAccess[input.key] = input.level;
      // Cascading the branch keeps visibility explainable: hide the tab and nothing inside it leaks.
      for (const sec of cat.sections) {
        delete sectionAccess[`${input.key}:${sec.id}`];
        for (const sub of sec.subSections) delete subSectionAccess[`${input.key}:${sec.id}:${sub.id}`];
      }
    } else if (input.kind === 'section') {
      const [tabId, sectionId, ...rest] = input.key.split(':');
      const cat = SECURITY_SURFACE_CATALOGUE.find((c) => c.tabId === tabId);
      const sec = cat?.sections.find((x) => x.id === sectionId);
      if (!cat || !sec || rest.length > 0) throw new SecurityGovernanceError(`unknown section "${input.key}"`);
      if (input.level === 'inherit') {
        delete sectionAccess[input.key];
      } else {
        this.assertGrantWithinActor({
          actor,
          actorLevel: this.canAccessSection(actor.id, tabId!, sectionId!),
          requested: input.level,
          label: `section "${input.key}"`,
        });
        sectionAccess[input.key] = input.level;
      }
      for (const sub of sec.subSections) delete subSectionAccess[`${input.key}:${sub.id}`];
    } else {
      const [tabId, sectionId, subId, ...rest] = input.key.split(':');
      const cat = SECURITY_SURFACE_CATALOGUE.find((c) => c.tabId === tabId);
      const sec = cat?.sections.find((x) => x.id === sectionId);
      const sub = sec?.subSections.find((x) => x.id === subId);
      if (!cat || !sec || !sub || rest.length > 0) throw new SecurityGovernanceError(`unknown sub-section "${input.key}"`);
      if (input.level === 'inherit') {
        delete subSectionAccess[input.key];
      } else {
        this.assertGrantWithinActor({
          actor,
          actorLevel: this.canAccessSubSection(actor.id, tabId!, sectionId!, subId!),
          requested: input.level,
          label: `sub-section "${input.key}"`,
        });
        subSectionAccess[input.key] = input.level;
      }
    }

    const updated: SecurityRole = { ...role, tabAccess, sectionAccess, subSectionAccess };
    this.profiles.set(role.id, updated);
    this.recordAudit(
      actor.id,
      'rbac.access-node-changed',
      `${kindLabel} "${input.key}" on role "${role.name}" set to ${input.level.toUpperCase()}.`,
      input.at,
    );
    return updated;
  }

  /**
   * Change a role's DOA cap and/or the DOA action kinds it may exercise. Supervisor / manager only,
   * and only downward in the authority hierarchy. An officer never reaches this path directly.
   */
  changeRoleDoa(input: {
    roleId: string;
    doaLimitAed?: string | null;
    doaActions?: readonly DoaActionKind[];
    actorProfileId?: string;
    by?: string;
    at?: string;
  }): SecurityRole {
    const actor = this.resolveActor(input.actorProfileId ?? input.by);
    const role = this.getRole(input.roleId);
    if (role.id === 'administration') {
      throw new SecurityGovernanceError('Administration holds unlimited DOA authority and cannot be re-capped');
    }
    if (!canChangeDoa(actor)) {
      throw new SecurityGovernanceError(
        `Officer-level role "${actor.name}" cannot change DOA authority. Submit a DOA limit-increase request for supervisor or manager approval instead.`,
      );
    }
    this.assertHigherAuthority(actor, role, 'change DOA authority for');

    const doaLimitMinor = input.doaLimitAed === undefined
      ? role.doaLimitMinor
      : input.doaLimitAed === null || String(input.doaLimitAed).trim().toLowerCase() === 'unlimited' || String(input.doaLimitAed).trim() === ''
        ? null
        : parseAmount(String(input.doaLimitAed), 'AED').minor;

    if (!actor.unrestricted) {
      if (doaLimitMinor === null) throw new SecurityGovernanceError('Only Administration may grant an unlimited DOA');
      if (actor.doaLimitMinor !== null && doaLimitMinor > actor.doaLimitMinor) {
        throw new SecurityGovernanceError(
          `Authority refusal: ${actor.name} cannot grant a DOA limit above its own cap of ${formatAmount(money(actor.doaLimitMinor, actor.currency))}`,
        );
      }
      for (const action of input.doaActions ?? []) {
        if (!actor.doaActions.includes(action)) {
          throw new SecurityGovernanceError(`Authority refusal: ${actor.name} does not hold DOA action "${action}" and cannot grant it`);
        }
      }
    }

    const updated: SecurityRole = {
      ...role,
      doaLimitMinor,
      doaActions: input.doaActions ? [...new Set(input.doaActions)] : role.doaActions,
    };
    this.profiles.set(role.id, updated);
    this.recordAudit(
      actor.id,
      'rbac.doa-authority-changed',
      `DOA authority for role "${role.name}" set to ${doaLimitMinor === null ? 'Unlimited' : formatAmount(money(doaLimitMinor, role.currency))}${input.doaActions ? ` with ${updated.doaActions.length} action kind(s)` : ''}.`,
      input.at,
    );
    return updated;
  }

  /**
   * An officer (or a higher role acting for them) asks for a DOA limit increase. The request is a
   * normal tracked DOA request, routed through the mapped supervisor/manager chain; approving it is
   * what applies the new cap. The requester cannot set the cap directly.
   */
  submitDoaLimitIncreaseRequest(input: {
    roleId: string;
    requestedLimitAed: string;
    reason: string;
    actorProfileId?: string;
    at?: string;
  }): {
    request: DoaApprovalRequest;
    notificationsSent: ApproverNotification[];
    currentLimitLabel: string;
    requestedLimitLabel: string;
  } {
    const actor = this.resolveActor(input.actorProfileId);
    const role = this.getRole(input.roleId);
    if (role.unrestricted || role.doaLimitMinor === null) {
      throw new SecurityGovernanceError(`Role "${role.name}" already holds unlimited DOA authority`);
    }
    if (actor.id !== role.id) this.assertHigherAuthority(actor, role, 'request a DOA increase for');
    if (!canChangeDoa(actor) && actor.id !== role.id) {
      throw new SecurityGovernanceError(`Role "${actor.name}" cannot raise a DOA request for another role`);
    }
    const requestedMinor = parseAmount(input.requestedLimitAed, role.currency).minor;
    if (requestedMinor <= role.doaLimitMinor) {
      throw new SecurityGovernanceError(
        `The requested limit ${formatAmount(money(requestedMinor, role.currency))} must be higher than the current cap ${formatAmount(money(role.doaLimitMinor, role.currency))}`,
      );
    }
    const result = this.submitDoaRequest({
      requesterProfileId: role.id,
      actionKind: 'doa-limit-increase',
      subjectRef: `DOA limit increase — ${role.name} (${formatAmount(money(role.doaLimitMinor, role.currency))} → ${formatAmount(money(requestedMinor, role.currency))})`,
      tabId: ROLE_MATRIX_TAB_ID,
      sectionId: 'doa-limits',
      entityId: role.entityScope === '*' ? 'ALK-CONV' : role.entityScope,
      channelCode: role.channelScope === '*' ? 'HEAD-OFFICE' : role.channelScope,
      subChannelCode: role.subChannelScope === '*' ? 'HEAD-OFFICE' : role.subChannelScope,
      amount: input.requestedLimitAed,
      currency: role.currency,
      reason: input.reason.trim() || 'Requested DOA limit increase for operational workload.',
      at: input.at,
    });
    this.recordAudit(actor.id, 'doa.limit-increase-requested', `${result.request.id} requested by ${actor.name} for role "${role.name}": ${formatAmount(money(role.doaLimitMinor, role.currency))} → ${formatAmount(money(requestedMinor, role.currency))}.`, input.at);
    return {
      request: result.request,
      notificationsSent: result.notificationsSent,
      currentLimitLabel: formatAmount(money(role.doaLimitMinor, role.currency)),
      requestedLimitLabel: formatAmount(money(requestedMinor, role.currency)),
    };
  }

  /**
   * AI Role & Access Advisor: scores every Tab, Section and Sub-Section for a role or custom role
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
      roleId: baseProfile.id,
      roleName: baseProfile.name,
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
    const distributionAllowed = mayUseDistributionConfigTabs(this.getProfile(targetProfileId));
    for (const t of rec.tabs) {
      const adminOnly = ADMIN_ONLY_TAB_IDS.has(t.tabId);
      const blockedDistribution = DISTRIBUTION_CONFIG_TAB_ID_SET.has(t.tabId) && !distributionAllowed;
      tabAccess[t.tabId] = adminOnly || blockedDistribution ? 'none' : t.level;
      if (adminOnly || blockedDistribution) continue;
      for (const s of t.sections) {
        sectionAccess[`${t.tabId}:${s.sectionId}`] = s.level;
        for (const sub of s.subSections) {
          subSectionAccess[`${t.tabId}:${s.sectionId}:${sub.subSectionId}`] = sub.level;
        }
      }
    }
    const safeLandingTab = ADMIN_ONLY_TAB_IDS.has(rec.recommendedLandingTab) ? 'overview' : rec.recommendedLandingTab;
    const profile = this.upsertProfile({
      id: targetProfileId,
      defaultLandingTab: safeLandingTab,
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
    const actor = this.resolveActor(input.by);
    if (!canManageRoleAccess(actor)) {
      throw new SecurityGovernanceError(
        `Officer-level role "${actor.name}" cannot change supervision mappings; supervisor or manager authority is required`,
      );
    }
    const supervisorRole = this.getProfile(input.supervisorProfileId);
    const managerRole = this.getProfile(input.managerProfileId);
    for (const o of input.officerProfileIds) {
      const officerRole = this.getProfile(o);
      if (!actor.unrestricted) this.assertHigherAuthority(actor, officerRole, 'map this role');
    }
    if (!actor.unrestricted && authorityRank(supervisorRole.authorityLevel) < authorityRank(actor.authorityLevel)) {
      throw new SecurityGovernanceError(`A ${authorityTier(actor.authorityLevel).label} cannot appoint a lower-tier first-line supervisor`);
    }
    if (!actor.unrestricted && authorityRank(managerRole.authorityLevel) < authorityRank(actor.authorityLevel)) {
      throw new SecurityGovernanceError(`A ${authorityTier(actor.authorityLevel).label} cannot appoint a lower-tier escalation manager`);
    }

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
    const actor = this.resolveActor(by);
    if (!canManageRoleAccess(actor)) {
      throw new SecurityGovernanceError(`Officer-level role "${actor.name}" cannot delete supervision mappings`);
    }
    if (!this.mappings.has(id)) throw new SecurityGovernanceError(`unknown supervision mapping "${id}"`);
    this.mappings.delete(id);
    this.recordAudit(actor.id, 'rbac.mapping-deleted', `Deleted supervision mapping ${id}.`, at);
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

    const forceApproval = input.actionKind === 'doa-limit-increase';
    const tabAllowed = forceApproval || (input.tabId ? this.canAccessTab(profile.id, input.tabId) !== 'none' : true);
    const actionAllowed = profile.doaActions.includes(input.actionKind);
    const limitMoney = money(profile.doaLimitMinor, profile.currency);
    const withinCap = compare(amount, limitMoney) <= 0;

    if (!forceApproval && tabAllowed && actionAllowed && withinCap) {
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

    const why = forceApproval
      ? `A DOA limit increase for ${profile.name} must be approved by a supervisor or manager — the requester cannot raise its own cap`
      : !tabAllowed
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
    let appliedDoaLimitLabel: string | null = null;
    if (finalStatus === 'approved' && existing.actionKind === 'doa-limit-increase') {
      const target = this.getProfile(existing.requesterProfileId);
      if (!actor.unrestricted && authorityRank(actor.authorityLevel) <= authorityRank(target.authorityLevel)) {
        throw new SecurityGovernanceError(
          `A DOA limit increase for ${authorityTier(target.authorityLevel).label} role "${target.name}" must be approved above that tier — ${actor.name} (${authorityTier(actor.authorityLevel).label}) cannot apply it`,
        );
      }
      const recapped: SecurityRole = { ...target, doaLimitMinor: existing.amount.minor };
      this.profiles.set(target.id, recapped);
      appliedDoaLimitLabel = formatAmount(money(existing.amount.minor, target.currency));
      this.recordAudit(actor.id, 'doa.limit-increase-applied', `${existing.id} applied: role "${target.name}" DOA cap is now ${appliedDoaLimitLabel}.`, at);
    }
    const stepNote = `${input.note?.trim() || `${finalStatus === 'approved' ? 'Approved' : 'Rejected'} by ${actor.name}.`}${appliedDoaLimitLabel ? ` New DOA cap applied: ${appliedDoaLimitLabel}.` : ''}`;
    const updated: DoaApprovalRequest = {
      ...existing,
      updatedAt: at,
      status: finalStatus,
      ...(appliedDoaLimitLabel ? { appliedDoaLimitLabel } : {}),
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
        authorityLevel: p.authorityLevel,
        authorityLabel: authorityTier(p.authorityLevel).label,
        authorityRank: authorityRank(p.authorityLevel),
        canChangeDoa: canChangeDoa(p),
        canManageRoleAccess: canManageRoleAccess(p),
        entityScope: p.entityScope,
        channelScope: p.channelScope,
        subChannelScope: p.subChannelScope,
        partnerScope: p.partnerScope ?? '*',
        defaultLandingTab: p.defaultLandingTab,
        reportsToProfileId: p.reportsToProfileId,
        reportsToRoleId: p.reportsToRoleId,
        escalationProfileId: p.escalationProfileId,
        escalationRoleId: p.escalationRoleId,
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
        /** Explicit overrides only; a missing key means "inherit from the parent node". */
        sectionOverrides: { ...p.sectionAccess },
        subSectionOverrides: { ...p.subSectionAccess },
        aiConfidencePct: p.aiConfidencePct,
        aiRationale: p.aiRationale,
        unreadNotifications,
        pendingApprovals,
      };
    });

    return {
      /** Roles are the access model; `profiles` / `profileCount` remain as compatibility aliases. */
      activeRoleId: this.activeProfileId,
      roleCount: profiles.length,
      authorities: AUTHORITY_TIERS.map((t) => ({ ...t })),
      userProfileLayer: {
        implemented: false,
        description: 'Roles are the access template, not user accounts. Login credentials, individual user profiles and provisioning will be added later and will reference a role id.',
      },
      accessAudit: this.audit
        .filter((a) => a.event.startsWith('rbac.') || a.event.startsWith('doa.limit') || a.event.startsWith('session.role'))
        .slice(-25)
        .reverse()
        .map((a) => ({ ...a })),
      activeProfileId: this.activeProfileId,
      profileCount: profiles.length,
      families: PROFILE_FAMILIES.map((f) => ({ ...f })),
      roleFamilies: PROFILE_FAMILIES.map((f) => ({ ...f })),
      catalogue: SECURITY_SURFACE_CATALOGUE.map((c) => ({
        tabId: c.tabId,
        label: c.label,
        sections: c.sections.map((s) => ({
          id: s.id,
          label: s.label,
          subSections: s.subSections.map((sub) => ({ ...sub })),
        })),
      })),
      roles: profiles,
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
        appliedDoaLimitLabel: r.appliedDoaLimitLabel ?? null,
        history: r.history.map((h) => ({ ...h })),
      })),
      notifications: [...this.notifications].reverse().map((n) => ({ ...n })),
      audit: this.audit.slice(-25).reverse().map((a) => ({ ...a })),
    };
  }
}
