/**
 * What's New — the last tab in the console.
 *
 * Entries are curated for operators: WHY a change exists, WHAT changed, and WHAT TO DO.
 * Publication is automatic: `tools/whats-new-sync.mjs` (driven by `.github/workflows/whats-new.yml`)
 * files a `proposed` entry when a PR is opened and a `shipped` entry when it merges into `main`,
 * using `draftFromPullRequest` below. Those entries live in a generated, committed feed next to the
 * historical hand-written seed. Drafting is template-based and local — no external AI service is
 * called — so the PR body remains the source of truth and the generated file is the audit record.
 * `generateFromCommits` is kept for the on-screen "generate from a commit" tool and for commit
 * records that have no PR.
 */

import { AUTO_WHATS_NEW_ENTRIES } from './whatsnew.auto.js';

export type WhatsNewCategory = 'feature' | 'improvement' | 'fix' | 'security' | 'data' | 'breaking' | 'docs';
/** `proposed` = PR open, not shipped; `shipped` = merged into main. Undefined = curated seed. */
export type WhatsNewStage = 'proposed' | 'shipped';

export interface WhatsNewEntry {
  readonly id: string;
  readonly at: string; // ISO date the change shipped (or was proposed)
  readonly title: string;
  readonly category: WhatsNewCategory;
  readonly source: string; // commit hash, PR number or change-request id
  readonly commitSubject?: string;
  readonly why: string;
  readonly what: string;
  readonly whatYouNeedToDo: string;
  readonly area: string; // console tab / module the reader should open
  readonly risk: 'low' | 'medium' | 'high';
  readonly stage?: WhatsNewStage;
  readonly pr?: number;
  readonly url?: string; // only https://github.com/… links are generated
}

/** Committed, generated feed of PR-sourced entries. `lastMergedAt` is the backfill watermark. */
export interface AutoWhatsNewFeed {
  readonly version: 1;
  readonly lastMergedAt: string;
  readonly entries: ReadonlyArray<WhatsNewEntry>;
}

/** The subset of the GitHub pull-request payload the drafter needs (no repo code is executed). */
export interface PullRequestLike {
  readonly number: number;
  readonly title: string;
  readonly body?: string | null;
  readonly createdAt: string;
  readonly mergedAt?: string | null;
  readonly merged?: boolean;
  readonly htmlUrl?: string;
  readonly labels?: ReadonlyArray<string>;
  readonly author?: string;
  readonly authorIsBot?: boolean;
}

export const WHATS_NEW_SKIP_LABEL = 'whats-new:skip';
export const WHATS_NEW_INCLUDE_LABEL = 'whats-new:include';

export interface CommitLike { readonly hash: string; readonly subject: string; readonly body?: string; readonly at?: string; readonly pr?: string }

const CATEGORY_BY_PREFIX: Record<string, WhatsNewCategory> = {
  feat: 'feature', feature: 'feature', fix: 'fix', security: 'security', sec: 'security',
  data: 'data', perf: 'improvement', refactor: 'improvement', docs: 'docs', breaking: 'breaking',
};

export function categoriseCommit(subject: string): WhatsNewCategory {
  const match = subject.match(/^(\w+)(?:\([^)]*\))?!?:/);
  if (!match) return /warehouse|data|export/i.test(subject) ? 'data' : 'improvement';
  if (subject.includes('!')) return 'breaking';
  return CATEGORY_BY_PREFIX[match[1]!.toLowerCase()] ?? 'improvement';
}

function cleanSubject(subject: string): string {
  return subject.replace(/^\w+(?:\([^)]*\))?!?:\s*/, '').replace(/^./, (c) => c.toUpperCase());
}

export function generateFromCommits(commits: ReadonlyArray<CommitLike>): WhatsNewEntry[] {
  return commits.map((commit, i) => {
    const category = categoriseCommit(commit.subject);
    const title = cleanSubject(commit.subject);
    const body = (commit.body ?? '').trim();
    const why = body.split(/\n{2,}/)[0] || defaultWhy(category, title);
    const what = body.split(/\n{2,}/)[1] || `${title}. Shipped as commit ${commit.hash.slice(0, 7)}${commit.pr ? ` in PR ${commit.pr}` : ''} and filed here automatically from the commit record.`;
    return {
      id: `WN-AUTO-${String(i + 1).padStart(4, '0')}`,
      at: commit.at ?? new Date().toISOString().slice(0, 10),
      title, category,
      source: commit.pr ?? `commit ${commit.hash.slice(0, 7)}`,
      commitSubject: commit.subject,
      why, what,
      whatYouNeedToDo: defaultAction(category),
      area: areaFor(commit.subject),
      risk: category === 'breaking' || category === 'security' ? 'high' : category === 'feature' || category === 'data' ? 'medium' : 'low',
    };
  });
}

function defaultWhy(category: WhatsNewCategory, title: string): string {
  switch (category) {
    case 'feature': return `Operators asked for this capability in the console rather than in a spreadsheet or a side system: ${title.toLowerCase()}.`;
    case 'security': return 'This closes a security or privacy gap. Treat it as mandatory reading before the next data extract or connection change.';
    case 'data': return 'Analysts need trustworthy, lineage-bearing data outside the operational screens without touching the ledger directly.';
    case 'breaking': return 'Behaviour changed in a way existing operators will notice, so it is announced here before it surprises anyone.';
    case 'fix': return 'Something behaved incorrectly or misleadingly; this restores the behaviour the screens promise.';
    default: return `This improves day-to-day operation: ${title.toLowerCase()}.`;
  }
}

function defaultAction(category: WhatsNewCategory): string {
  switch (category) {
    case 'breaking': return 'Read the What section, check any saved exports, bookmarks or procedures that rely on the old behaviour, and re-run the affected flow once in the console.';
    case 'security': return 'Review the change with your data-protection owner, rotate any affected secret from your secret store, and re-validate the connection before the next sync.';
    case 'data': return 'Open the Data warehouse tab, check the dataset lineage and masked sample, and refresh your BI extract — masked values change every transaction, so do not join extracts on them.';
    case 'feature': return 'Open the named tab, read its AI guide note, and run the flow once on demo data before using it for a real customer.';
    default: return 'No action required. Open the named area if you want to see the change in place.';
  }
}

function areaFor(subject: string): string {
  const s = subject.toLowerCase();
  if (s.includes('reconcil')) return 'Partner reconciliation';
  if (s.includes('security') || s.includes('rbac') || s.includes('doa') || s.includes('profile')) return 'Access & DOA';
  if (s.includes('batch') || s.includes('anniversary') || s.includes('clawback')) return 'Batch processing';
  if (s.includes('warehouse') || s.includes('snowflake') || s.includes('mask')) return 'Data warehouse';
  if (s.includes('theme') || s.includes('brand')) return 'Application theme';
  if (s.includes("what's new") || s.includes('whats-new') || s.includes('changelog')) return "What's New";
  if (s.includes('journey')) return 'Customer journey';
  if (s.includes('claim')) return 'Claims';
  return 'Overview';
}

/* ------------------------------------------------ automatic publication from pull requests */

const LABEL_CATEGORY: Record<string, WhatsNewCategory> = {
  feature: 'feature', enhancement: 'feature', feat: 'feature',
  bug: 'fix', fix: 'fix', bugfix: 'fix',
  security: 'security', data: 'data', breaking: 'breaking',
  docs: 'docs', documentation: 'docs',
  improvement: 'improvement', performance: 'improvement', refactor: 'improvement',
};

/** Strip C0 controls and JS line separators without losing the newlines the section parser needs. */
function stripControlCharacters(value: string): string {
  let out = '';
  for (const ch of value) {
    const code = ch.codePointAt(0) ?? 0;
    const lineBreak = code === 0x09 || code === 0x0a || code === 0x0d;
    out += !lineBreak && (code <= 0x1f || code === 0x2028 || code === 0x2029) ? ' ' : ch;
  }
  return out;
}

/**
 * PR titles and bodies are untrusted text that ends up inside a generated TypeScript module,
 * an offline HTML page and the console. Reduce every field to bounded plain text: no tags,
 * no HTML-significant characters, no control characters, no markdown decoration.
 */
export function plainText(value: string, max = 1500): string {
  const text = stripControlCharacters(value)
    .replace(/<[^>]*>/g, ' ')
    .replace(/[<>]/g, '')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/^\s*```.*$/gm, '')
    .replace(/^\s*(?:[-*+]|\d+\.)\s+/gm, '')
    .replace(/[`*_~>#]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  return text.length <= max ? text : `${text.slice(0, max - 1).trimEnd()}…`;
}

function bodySections(body: string): Map<string, string[]> {
  const out = new Map<string, string[]>();
  let current = 'preamble';
  for (const line of body.split(/\r?\n/)) {
    const heading = line.match(/^\s{0,3}#{1,6}\s+(.+?)\s*#*\s*$/);
    if (heading) {
      current = (heading[1] ?? '').toLowerCase().replace(/[^a-z0-9 ]/g, '').replace(/\s+/g, ' ').trim();
      if (!out.has(current)) out.set(current, []);
      continue;
    }
    if (!out.has(current)) out.set(current, []);
    out.get(current)!.push(line);
  }
  return out;
}

function sectionText(sections: Map<string, string[]>, matches: (key: string) => boolean): string {
  for (const [key, lines] of sections) if (matches(key) && lines.join('').trim()) return lines.join('\n');
  return '';
}

/** Why / What changed / What you need to do — from PR body headings, with honest fallbacks. */
export function draftSections(pr: PullRequestLike): { why: string; what: string; action: string } {
  const sections = bodySections(pr.body ?? '');
  const preamble = sectionText(sections, (k) => k === 'preamble');
  return {
    why: plainText(sectionText(sections, (k) => /why|background|motivation|problem/.test(k)), 700),
    what: plainText(
      sectionText(sections, (k) => /what changed|^what$|summary|changes|description/.test(k)) || preamble,
      1400,
    ),
    action: plainText(sectionText(sections, (k) => /what you need to do|what to do|action|next step|operator action/.test(k)), 600),
  };
}

export function categoryForPullRequest(pr: PullRequestLike): WhatsNewCategory {
  for (const raw of pr.labels ?? []) {
    const label = raw.toLowerCase().trim();
    const scoped = label.startsWith('type:') ? label.slice(5).trim() : label;
    if (LABEL_CATEGORY[scoped]) return LABEL_CATEGORY[scoped];
  }
  const declared = (pr.body ?? '').match(/^\s*(?:category|type)\s*:\s*([a-z]+)\s*$/im)?.[1]?.toLowerCase();
  if (declared && LABEL_CATEGORY[declared]) return LABEL_CATEGORY[declared];
  return categoriseCommit(pr.title);
}

function riskFor(category: WhatsNewCategory, labels: ReadonlyArray<string>): WhatsNewEntry['risk'] {
  const normalised = labels.map((l) => l.toLowerCase().trim());
  if (normalised.includes('risk:high')) return 'high';
  if (normalised.includes('risk:low')) return 'low';
  return category === 'breaking' || category === 'security' ? 'high' : category === 'feature' || category === 'data' ? 'medium' : 'low';
}

/** Internal PRs can opt out; bots are excluded unless a maintainer explicitly opts them in. */
export function shouldPublishPullRequest(pr: PullRequestLike): boolean {
  const labels = (pr.labels ?? []).map((l) => l.toLowerCase().trim());
  if (labels.includes(WHATS_NEW_INCLUDE_LABEL)) return true;
  if (labels.includes(WHATS_NEW_SKIP_LABEL) || /\[skip whats-new\]/i.test(`${pr.title}\n${pr.body ?? ''}`)) return false;
  return !(pr.authorIsBot || /\[bot\]$/i.test(pr.author ?? ''));
}

/**
 * One pull request becomes one operator-facing entry. Re-running for the same PR overwrites
 * its entry (stable `WN-PR-<n>` id), so PR edits, re-runs and merge events are idempotent.
 */
export function draftFromPullRequest(pr: PullRequestLike, stage?: WhatsNewStage): WhatsNewEntry {
  const resolved = stage ?? (pr.merged ? 'shipped' : 'proposed');
  const title = plainText(cleanSubject(pr.title), 160) || `Change from PR #${pr.number}`;
  const category = categoryForPullRequest(pr);
  const at = (resolved === 'shipped' ? pr.mergedAt ?? pr.createdAt : pr.createdAt).slice(0, 10);
  const parts = draftSections(pr);
  const what = parts.what || `${title}. Filed automatically from PR #${pr.number}; the pull request had no "What changed" section, so read the linked PR for the full diff.`;
  const action = parts.action || defaultAction(category);
  const url = pr.htmlUrl && /^https:\/\/github\.com\/[^\s<>"']+$/.test(pr.htmlUrl) ? pr.htmlUrl : undefined;
  return {
    id: `WN-PR-${pr.number}`,
    at, title, category,
    source: `PR #${pr.number} · ${resolved === 'shipped' ? 'merged' : 'opened'} ${at} · auto-filed`,
    why: parts.why || defaultWhy(category, title),
    what,
    whatYouNeedToDo: resolved === 'proposed' ? `In review — not shipped yet. ${action}` : action,
    area: areaFor(pr.title),
    risk: riskFor(category, pr.labels ?? []),
    stage: resolved,
    pr: pr.number,
    ...(url ? { url } : {}),
  };
}

/**
 * Newest first; on a tie, higher PR number first. Array#sort is stable, so the hand-written
 * seed keeps its authored order and the generated feed keeps its committed order.
 */
export function sortWhatsNewEntries(entries: ReadonlyArray<WhatsNewEntry>): WhatsNewEntry[] {
  return [...entries].sort((a, b) => b.at.localeCompare(a.at) || (b.pr ?? 0) - (a.pr ?? 0));
}

export function upsertPullRequestFeed(feed: AutoWhatsNewFeed, pr: PullRequestLike, stage?: WhatsNewStage): AutoWhatsNewFeed {
  const entry = draftFromPullRequest(pr, stage);
  const entries = sortWhatsNewEntries([...feed.entries.filter((e) => e.id !== entry.id), entry]);
  const lastMergedAt = entry.stage === 'shipped' && pr.mergedAt && pr.mergedAt > feed.lastMergedAt ? pr.mergedAt : feed.lastMergedAt;
  return { ...feed, entries, lastMergedAt };
}

/** A PR closed without merging never shipped, so its proposed entry must disappear. */
export function removeProposedPullRequest(feed: AutoWhatsNewFeed, number: number): AutoWhatsNewFeed {
  return { ...feed, entries: feed.entries.filter((e) => !(e.id === `WN-PR-${number}` && e.stage === 'proposed')) };
}

/** Historical, hand-written release notes. New releases are filed automatically from PRs. */
export const WHATS_NEW_SEED: ReadonlyArray<WhatsNewEntry> = [
  {
    id: 'WN-0014', at: '2026-10-27', title: 'Access & DOA and Role access matrix tabs restricted to Administration only', category: 'security',
    source: 'RBAC governance tightening · 2026-10-27', area: 'Access & DOA', risk: 'medium',
    why: 'Role governance, Tab → Section → Sub-Section permission trees and DOA matrix administration belong exclusively to the executive Administration profile and should not appear in operational, supervisor, manager, broker, bancassurance or partner workspaces.',
    what: 'Deleted Access & DOA (access-doa) and Role access matrix (role-matrix) from all 35 non-administrator profiles, enforced Administration-only tab guards in SecurityGovernanceRegistry and the console UI, updated supervisor and branch/agent/banca supervisor default landing tabs to Overview, and removed non-admin matrix shortcut buttons.',
    whatYouNeedToDo: 'Switch into Administration via the Role Gate whenever inspecting or editing role permissions, supervision chains or DOA matrices. Non-administrator roles continue raising and deciding operational DOA requests through their header notifications and guard banner.',
  },
  {
    id: 'WN-0013', at: '2026-10-27', title: 'Unlocked non-financial partner reconciliation foundation', category: 'feature',
    source: 'Reconciliation foundation unlock · 2026-10-27', area: 'Partner reconciliation', risk: 'medium',
    why: 'Insurer operations, distribution supervisors and finance desks need configurable channel/sub-channel reference types, human-confirmed identity header mapping and deterministic scoped policy matching now, while keeping unapproved financial commission formulas safely locked.',
    what: 'Unlocked reconciliationFeatureGate in non_financial_foundation mode by default (financialCalculationsEnabled: false), added ReconciliationFoundationWorkspace, /api/reconciliation endpoints, and the Partner reconciliation console tab with insurer/partner ownership hierarchy, identity-only header confirmation, exact and insured-corroborated zero-padding matching, duplicate quarantine and auditable human review of tentative proposals.',
    whatYouNeedToDo: 'Open Partner reconciliation to configure insurer channel/sub-channel types, confirm identity-only CSV headers, run scoped partner-versus-insurer policy matching and review tentative proposals. Financial commission, free-look, clawback, payable statement and AP payment calculations remain disabled until business rules are signed off.',
  },
  {
    id: 'WN-0012', at: '2026-10-27', title: "What's New publication corrected", category: 'fix',
    source: "What's New publication correction", area: "What's New", risk: 'low',
    why: 'The merged reconciliation foundation was absent because release entries are curated manually and the deployed demo uses a committed snapshot.',
    what: 'Added the missing PR #38 entry, rebuilt the static demo, and added checks that detect a stale demo when published entries change. Merged PRs are not imported automatically.',
    whatYouNeedToDo: 'Read the reconciliation entry below. For future releases, maintainers must add an entry and rebuild the demo; filing an entry on this screen is temporary.',
  },
  {
    id: 'WN-0011', at: '2026-10-27', title: 'Partner reconciliation foundation — not yet available', category: 'improvement',
    source: 'PR #38 · merged 2026-10-27', area: 'Partner reconciliation', risk: 'medium',
    why: 'Partner commission reconciliation needs insurer- and partner-scoped groundwork before any commission is calculated or paid.',
    what: 'Added disabled, non-financial groundwork: ownership metadata and read-only database isolation, guarded migrations, and offline identity-matching and column-mapping helpers. This did not add a reconciliation screen, file uploads, commission calculations, approvals or payment processing.',
    whatYouNeedToDo: 'No new reconciliation workflow is available to use. Provide the approved free-look, commission and clawback rules; keep the feature disabled and do not use real customer data until the required finance, security, privacy and payment acceptance is complete.',
  },
  {
    id: 'WN-0010', at: '2026-10-21', title: 'Security profiles renamed to roles, four authority tiers, DOA change only at supervisor/manager level, officer limit-increase requests, and a role access matrix with a tab → section → sub-section enable/disable tree', category: 'security',
    source: 'branch arena/b567474d-central-insurance-illustration · docs/17-RBAC-DOA-AUTOPICK-AND-SMART-COMBOBOX.md', area: 'Role access matrix', risk: 'high',
    why: 'The pre-load security layer called each permission template a “profile”, which reads like a person and would collide with the user-account layer that has to come later. It also let any tier change DOA caps and section visibility, so an officer could widen its own authority, and there was no single screen that showed, per role, exactly which tabs, sections and sub-sections are visible and editable.',
    what: 'Renamed the concept to role everywhere in the UI, guides and endpoints (the internal SecurityProfile alias and the legacy x-portal-profile header are kept so nothing breaks), added four authority tiers — 22 officer, 4 supervisor, 9 manager, 1 executive — with rank-ordered rules the registry enforces: officers can never change a DOA cap or the access tree, supervisors and managers may only edit lower tiers and never above their own cap, and an officer instead raises a tracked DOA limit-increase request that routes to its mapped supervisor and applies only on approval, never automatically. A new Role access matrix tab sets each role’s tab → section → sub-section tree to full, read-only, hidden or inherit, storing only explicit overrides so inherited levels stay explainable, next to the 36-role directory, the DOA cap editor and the access change audit trail. The access guard banner now shows the active tier and carries the officer request form.',
    whatYouNeedToDo: 'Open Role access matrix, pick the role you want to inspect, and walk the tree tab by tab — inherit means the node follows its parent, and the effective badge shows what will actually be enforced. If you are an officer, use Request a DOA limit increase in the access banner instead of editing a cap; your supervisor receives it in the approver inbox. Named user logins are still a later layer and will reference a role id.',
  },
  {
    id: 'WN-0009', at: '2026-10-20', title: 'Enterprise 36-profile pre-load security gate, AI RBAC & DOA approvals (including Batch processing authority), zero-duplicate auto-pick & configurable Age Nearest/Next/Last setup', category: 'security',
    source: 'PR #31 · docs/17-RBAC-DOA-AUTOPICK-AND-SMART-COMBOBOX.md', area: 'Access & DOA', risk: 'high',
    why: 'The platform previously opened straight into full operational menus with no persona security gate, no Delegation-of-Authority (DOA) approval workflow with approver notifications, repeated entry of customer DOB/age/height/weight/dependent products across screens, and fixed age entry without configurable actuarial age rules.',
    what: 'Added a pre-load Security Profile Selection Gate covering all 36 enterprise profiles (Administration with complete unrestricted access, Supervisor, Configurator, Underwriting, Retention, Endorsement, Claims, Settlement, Reinsurance, Bancassurance Ops, Fund Config, Accountant, Finance, Cost Controller, Fund Investment, Agents 1/2/Marsh/Supervisor, Banca 1/2/Supervisor, Branch Officer/Manager, Bank Manager, Aggregator, Direct Customer, Referral Partners 1/2), a dedicated Access & DOA tab with AI tab/section/sub-section recommendations + Segregation-of-Duties checks, Entity × Channel × Sub-Channel supervisor mapping with live approver notifications, automatic customer/proposal/dependent-product Auto-Pick memory, editable + suggested SmartComboBox controls, and Master Settings actuarial age configuration (Age Nearest Birthday, Age Next Birthday, Age Last Birthday).',
    whatYouNeedToDo: 'Select your profile at the pre-load gate (choose Administration for complete unrestricted access), review Entity × Channel × Sub-Channel DOA chains in Access & DOA, and verify your tenant default Age Calculation Basis (ANB / ANxB / ALB) and dependent-product auto-pick rules in Master settings.',
  },
  {
    id: 'WN-0008', at: '2026-10-20', title: 'Live ERP / portal / application theme engine, Batch processing & warehouse offline bundle sync, and PR #10 / PR #11 audit logs', category: 'fix',
    source: 'PR #12 · live theme & deployment sync', area: 'Application theme', risk: 'medium',
    why: 'Two previous changes (PR #10 — Funds accounting, Super funds, Data warehouse & Brand onboarding; PR #11 — Batch processing, What’s New, Warehouse Snowflake/Excel/Access security & Application theme tab) were missing from the live deployed console and from ledger/runs.jsonl and backlog/status.jsonl because demo/offline.html stayed frozen at PR #8 (4cd7802). In addition, theme changes did not visibly re-skin the application because ThemeRegistry sorted alphabetically by ownerId (always picking ALK-CONV / DXB-BROKER-01 / BROKER), ThemePanel sent default dark hex values over AI-generated palettes, and inputs/tables/grids used hardcoded dark hex colours.',
    what: 'Rebuilt demo/offline.html and demo/offline-responses.json and wired the build pipeline so every build keeps the deployed console current across all 26 tabs. Added active-layer tracking (POST /themes/activate), six one-click brand presets (Midnight Slate, Royal Takaful Emerald & Gold, Gulf Sovereign Gold & Navy, DIFC Executive Crimson, Arabian Sea Cyan & Violet, Executive Daylight), full 8-token WCAG-AA AI palette derivation, and CSS variable wiring across inputs, tables, grids and scoped customer/partner surfaces. Backfilled PR #10 and PR #11 in ledger/runs.jsonl, backlog/status.jsonl, docs/06-QA-REPORT.md and the unified module audit log on the AI ledger tab.',
    whatYouNeedToDo: 'Open Application theme, click any one-click brand preset or click Apply / Set active on ALK-TKF (Royal Takaful Emerald & Gold) to watch the entire ERP console re-skin immediately, or test Partner / Omni-channel themes on Customer journey and Underwriting.',
  },
  {
    id: 'WN-0007', at: '2026-10-19', title: 'Batch processing for quotations, issuance and monthly anniversaries', category: 'feature',
    source: 'PR #11 · commit f8eb9e8 (merged 02806d2)', area: 'Batch processing', risk: 'high',
    why: 'Quotation generation, illustration generation, policy issuance and the monthly anniversary charges (mortality, premium accrual, commission accrual and clawback, fund management charges and dividend distribution) were individual actions. Operations needs them as governed, repeatable batches with accounting filed once per event — and a hard stop the moment a policy lapses, is fully withdrawn or is surrendered.',
    what: 'A new Batch processing tab holds one event-setup register (debit account, credit account, schedule, basis, rate, applicable statuses) for all nine events, a Run panel per event and period, and run history. Subjects are the live quotations and policies plus any leavers. Terminal subjects are reported as skipped-terminal, never charged; clawback is the one job that targets leavers. Re-running a period is safe — job + period + subject is the idempotency key, and re-runs report duplicate-skipped instead of double-charging.',
    whatYouNeedToDo: 'Open Batch processing, review each event’s debit/credit setup with Finance before the first live run, then run one monthly period and check the voucher references and totals by currency. High-risk (money-moving) runs still need the named human approval your AGENTS.md risk gate requires.',
  },
  {
    id: 'WN-0006', at: '2026-10-19', title: "What's New — this tab, generated from commits and change requests", category: 'feature',
    source: 'PR #11 · commit f8eb9e8 (merged 02806d2)', area: "What's New", risk: 'low',
    why: 'Changes were only visible in git history, which operators never read. Every implementation and change request deserves a plain-language record: why it exists, what changed, and what the reader must do.',
    what: "A new final tab lists every shipped change newest-first, with category, source (commit/PR/change request), Why / What / What you need to do, the console area to open, and risk. A generator turns future commit subjects and bodies into entries in exactly this shape, so filing a change becomes part of shipping it.",
    whatYouNeedToDo: 'Check this tab after each release. When you ship a change, write the commit body as two paragraphs (why, then what) — it will be drafted into an entry automatically.',
  },
  {
    id: 'WN-0005', at: '2026-10-19', title: 'Snowflake, Excel and Access warehouse connections — validated secrets, breach agreement, rotating PII masking', category: 'security',
    source: 'PR #11 · commit f8eb9e8 (merged 02806d2)', area: 'Data warehouse', risk: 'high',
    why: 'The warehouse could export CSV/JSON and describe BI connectors, but Snowflake, Microsoft Excel and Microsoft Access pipelines need governed connections: a secret that is validated but never displayed, a signed data-breach agreement before any sync, and a guarantee that no real customer information reaches an analyst tool.',
    what: 'The Data warehouse tab gains a Connections & PII masking section for Snowflake, Excel and Access. Registering a connection requires the current data-breach agreement (version, signer, date), stores only a SHA-256 fingerprint of the secret (the secret itself is never shown or returned), and runs a step-by-step validation (shape, secret strength, agreement, target) with an expiry. Every sample, export and connection preview is PII-masked with a one-way keyed hash whose method rotates on every transaction — the same customer masks differently in every drop, there is no decode function, and per-transaction salts are never exported.',
    whatYouNeedToDo: 'Have your data-protection owner accept the current breach agreement, put connection secrets in your secret store (never in a ticket), register and validate each Snowflake/Excel/Access connection, and re-point BI tools at masked extracts. Never join two extracts on a masked value — masking rotates per transaction on purpose.',
  },
  {
    id: 'WN-0004', at: '2026-10-19', title: 'Application theme — now a top-level tab', category: 'feature',
    source: 'PR #11 · commit f8eb9e8 (merged 02806d2) · PR #10 · commit a6468eb', area: 'Application theme', risk: 'low',
    why: 'Theme onboarding existed — entity, partner and omni-channel brand layers with AI-assisted palettes — but it lived inside Master settings, so brand owners could not find it and reasonably reported it missing.',
    what: 'A new Application theme tab brings the three existing panels to the top level: entity theme (applies globally), partner theme and omni-channel theme (both scoped to partner detail, the customer journey and quotation). Upload a logo/header/footer, let the local palette assistant sample dominant colours, review the swatches, generate, preview, enable/disable — and the console shell re-skins immediately. The Master settings sections remain in place.',
    whatYouNeedToDo: 'Open Application theme, upload your entity logo, review the generated palette for contrast, and generate. Partner and channel owners should file their scoped layers there too, then check the Customer journey to see the scoped surface.',
  },
  {
    id: 'WN-0003', at: '2026-10-19', title: 'Data warehouse — nine lineage-bearing datasets for analysts', category: 'data',
    source: 'PR #10 · commit a6468eb (merged ccf51a3) · docs/12-FUNDS-SUPER-WAREHOUSE-AND-BRANDING.md', area: 'Data warehouse', risk: 'medium',
    why: 'Analysts were screenshotting operational screens. They need one read model with grain, lineage and fingerprinted exports that never becomes a second ledger.',
    what: 'Nine datasets (policy, premium, fund NAV, claim, reinsurance, commission schedule, super, voucher lines, member balances) with source, grain, sample rows and lineage; five native dashboard definitions; full CSV/JSON exports with content fingerprints; connector recipes for Power BI, Tableau, Qlik, Databricks and Data Fabric.',
    whatYouNeedToDo: 'Use exports from the Data warehouse tab rather than screen copies, and record the fingerprint with anything you publish. External BI sessions still need your deployment credentials — see WN-0005 for governed Snowflake/Excel/Access connections and masking.',
  },
  {
    id: 'WN-0002', at: '2026-10-19', title: 'Funds accounting, super funds and event-based vouchers', category: 'feature',
    source: 'PR #10 · commit a6468eb (merged ccf51a3) · docs/12-FUNDS-SUPER-WAREHOUSE-AND-BRANDING.md', area: 'Funds accounting', risk: 'medium',
    why: 'Accounting treatment differed by country and fund but was implicit. Finance needs the mapping from a policy event to a balanced debit/credit voucher to be filed data, not code.',
    what: 'Country accounting standards, fund rules and dynamic mappings (event × product × partner × channel × policy) resolve every event — premium, deposit, accrual, allocation, gain/loss, withdrawal, charge — into a balanced voucher linked to a ledger journal. Super funds add monthly charges and pro-rata income allocation through the same vouchers. The Batch processing tab (WN-0007) now schedules these event types over the whole book.',
    whatYouNeedToDo: 'Finance should review the filed mappings in Funds accounting before relying on batch runs, and check that every batch voucher reference traces to a balanced voucher.',
  },
  {
    id: 'WN-0001', at: '2026-10-04', title: 'The guided customer journey, tenant master settings and the AI guide', category: 'feature',
    source: 'docs/09-CUSTOMER-JOURNEY.md · docs/10-TENANT-MASTER-AND-GUIDE.md', area: 'Customer journey', risk: 'medium',
    why: 'A sale crossed nineteen screens with no enforced order, and every tenant hardcoded its own country, currency and vocabulary.',
    what: 'Nineteen gated journey sections that unlock only at 100% completion, tenant master settings (39 country packs, currencies, field renaming, the 96-product factory, rating tables, omni-channel commission/clawback), and an AI guide note on every section with a filed on/off switch.',
    whatYouNeedToDo: 'Set your country, calendar and currencies in Master settings first — every other screen reads them. Use the guide switch in the header if you want the notes hidden; the change is audited.',
  },
];

export class WhatsNewError extends Error {}

const CATEGORIES: ReadonlySet<string> = new Set<WhatsNewCategory>([
  'feature', 'improvement', 'fix', 'security', 'data', 'breaking', 'docs',
]);

/** Generated entries are validated before they are written and again when the registry loads. */
export function assertPublishableEntry(entry: WhatsNewEntry): void {
  if (!entry.id?.trim() || !/^\d{4}-\d{2}-\d{2}$/.test(entry.at) || !entry.title?.trim()) throw new WhatsNewError("What's New entry needs an id, date and title");
  if (!entry.why?.trim() || !entry.what?.trim() || !entry.whatYouNeedToDo?.trim()) throw new WhatsNewError("What's New entries must say why, what changed, and what the reader needs to do");
  if (!CATEGORIES.has(entry.category)) throw new WhatsNewError(`Unknown What's New category: ${String(entry.category)}`);
  if (!['low', 'medium', 'high'].includes(entry.risk)) throw new WhatsNewError(`Unknown What's New risk: ${String(entry.risk)}`);
  if (entry.stage && !['proposed', 'shipped'].includes(entry.stage)) throw new WhatsNewError(`Unknown What's New stage: ${String(entry.stage)}`);
  if (entry.url && !/^https:\/\/github\.com\/[^\s<>"']+$/.test(entry.url)) throw new WhatsNewError("What's New PR links must be https://github.com/ URLs");
}

export class WhatsNewRegistry {
  private entries: WhatsNewEntry[] = sortWhatsNewEntries([...AUTO_WHATS_NEW_ENTRIES, ...WHATS_NEW_SEED]);
  private seq = Math.max(0, ...this.entries.map((e) => Number(/^WN-(\d+)$/.exec(e.id)?.[1] ?? 0)));

  constructor() { AUTO_WHATS_NEW_ENTRIES.forEach(assertPublishableEntry); }

  list(category?: WhatsNewCategory): WhatsNewEntry[] {
    return category ? this.entries.filter((e) => e.category === category) : [...this.entries];
  }

  file(entry: Omit<WhatsNewEntry, 'id'> & { id?: string }): WhatsNewEntry {
    if (!entry.title?.trim()) throw new WhatsNewError("What's New entry needs a title");
    if (!entry.why?.trim() || !entry.what?.trim() || !entry.whatYouNeedToDo?.trim()) throw new WhatsNewError("What's New entries must say why, what changed, and what the reader needs to do");
    const filed: WhatsNewEntry = { ...entry, id: entry.id ?? `WN-${String(++this.seq).padStart(4, '0')}` };
    this.entries = [filed, ...this.entries.filter((e) => e.id !== filed.id)];
    return filed;
  }

  fileFromCommits(commits: ReadonlyArray<CommitLike>): WhatsNewEntry[] {
    return generateFromCommits(commits).map((entry) => this.file(entry));
  }

  snapshot() {
    return {
      entries: this.list(),
      categories: [...new Set(this.entries.map((e) => e.category))],
      latestAt: this.entries[0]?.at ?? null,
      pending: this.entries.filter((e) => e.stage === 'proposed').length,
      howEntriesAreMade: 'Entries are published automatically from pull requests: opening a PR files a proposed entry and merging it into main ships it with the merge date. The PR title, labels, and its Why / What changed / What you need to do sections become the operator note; label an internal PR whats-new:skip to leave it out. Older releases remain in the curated seed. Entries filed using this screen are temporary and do not survive a restart.',
    };
  }

  stats() { return { entries: this.entries.length, latestAt: this.entries[0]?.at ?? null }; }
}
