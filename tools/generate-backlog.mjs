#!/usr/bin/env node
/**
 * generate-backlog.mjs — generates the chunk backlog for the Insurance ERP.
 *
 * Philosophy (see docs/03-ROGUE-BUILD-SYSTEM.md):
 *   work is done by CHUNKS, not by agents. The backlog is generated from a matrix
 *   (module x capability x layer x product line x country x locale x depth), so it
 *   never runs dry and any number of agents can be pointed at it.
 *
 * Usage:
 *   node tools/generate-backlog.mjs                              # critical path + base long tail
 *   node tools/generate-backlog.mjs --long-tail=50000            # cap the long tail
 *   node tools/generate-backlog.mjs --long-tail=99999999         # the full ask (writes ~9GB, do not run casually)
 *   node tools/generate-backlog.mjs --dry                        # counts only, writes nothing
 *   node tools/generate-backlog.mjs --out=backlog                # output directory
 *
 * Output:
 *   backlog/critical-path.jsonl   the v1 slice, sequenced (this is what Phase 0-1 works)
 *   backlog/long-tail.jsonl       the dimensional expansion, capped by --long-tail
 *   backlog/SUMMARY.md            counts, per-module breakdown, and how to scale to 9 digits
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/* ------------------------------------------------------------------ matrix */

const MODULES = [
  { code: 'PLAT', name: 'Platform services', path: 'packages/platform', capabilities: [
    'tenancy isolation per operator with schema and row-level security',
    'entity registry for legal entities inside a tenant',
    'role and permission model with entitlement checks on every call',
    'append-only audit ledger for every state change',
    'outbox pattern guaranteeing event delivery with the transaction',
    'idempotency keys on every mutating API',
    'scheduler and job queue with retries and dead-letter handling',
    'secret and key management with rotation',
    'environment parity and infrastructure as code',
    'label registry with per-tenant overrides and RTL',
  ]},
  { code: 'PARTY', name: 'Party and Customer 360', path: 'packages/party', capabilities: [
    'person and organisation records with roles',
    'golden record with deterministic and probabilistic matching',
    'merge and split with full history and reversals',
    'relationship graph (policyholder, life assured, beneficiary, payer, broker)',
    'contact and communication preferences with consent linkage',
    'identity documents with OCR-extracted fields and confidence',
    'sanctions and PEP screening hooks',
    'customer 360 view across holdings and intermediaries',
    'cross-party existence lookup API with consent scoping',
    'data minimisation and retention rules per jurisdiction',
  ]},
  { code: 'PROD', name: 'Product factory', path: 'packages/product', capabilities: [
    'data-defined product with coverage, riders and options',
    'charge schedule modelling (allocation, COI, admin, fund management, surrender, switching)',
    'fund mapping and allocation rules per product',
    'illustration rule set and prescribed assumptions',
    'tariff tables versioned by effective date',
    'underwriting rules and evidence requirements',
    'regulatory admission prerequisites per country',
    'product versioning, clone and change control',
    'eligibility, waiting periods and exclusions',
    'product catalogue API for channels and partners',
  ]},
  { code: 'QUOT', name: 'Quotation and illustration', path: 'packages/quote', capabilities: [
    'multi-line quote engine (life, medical, motor, travel, group)',
    'need analysis and gap analysis driven by country pack',
    'premium and contribution calculation with loadings and discounts',
    'unit-linked projection engine producing illustrations',
    'illustration scenarios and assumptions with prescribed wording',
    'comparison matrix across insurers and products',
    'best-product recommendation with rationale and audit',
    'quote versions, validity, and conversion to application',
    'intermediary and direct channel quoting',
    'quote-to-policy conversion with data carried through',
  ]},
  { code: 'UW', name: 'Underwriting', path: 'packages/underwriting', capabilities: [
    'rules-based underwriting with decision trees',
    'medical evidence ordering and result ingestion',
    'referral queues with authority limits',
    'rating and exclusions applied to issued policy',
    'reinsurance notification on acceptance',
    'decline and postpone handling with correspondence',
    'tele-underwriting scripts and evidence capture',
    'AI-assisted evidence assembly with human decision',
    'underwriting audit trail and reproducibility',
    'aggregate and anti-selection monitoring',
  ]},
  { code: 'POL', name: 'Policy administration', path: 'packages/policy', capabilities: [
    'issuance from application with document pack generation',
    'policy alteration engine for financial and non-financial changes',
    'rider addition and removal with re-rating',
    'premium holiday, lapse, grace and reinstatement',
    'renewal processing and rate revision',
    'endowment, maturity and survival benefit processing',
    'surrender and partial withdrawal with charge calculation',
    'policy loan and repayment',
    'assignment, nomination and beneficiary changes',
    'policy servicing API for portals and partners',
  ]},
  { code: 'FUND', name: 'Fund management and NAV', path: 'packages/fund', capabilities: [
    'fund master with currency, dealing calendar and pricing basis',
    'fund valuation run producing per-unit price with revision history',
    'unit pricing with rounding policy and residual account',
    'valuation calendar and dealing calendar resolution',
    'market data ingestion (vendor feed, administrator file, manual upload)',
    'instrument master and corporate action handling',
    'fund composition with look-through depth for funds of funds',
    'fund accounting with asset, liability and unit reconciliation',
    'segregated fund tracking per account and sub-fund',
    'NAV publication, staleness alerts and blocking controls',
  ]},
  { code: 'ULNK', name: 'Unit-linked engine', path: 'packages/unitlinked', capabilities: [
    'unit allocation on premium with premium allocation charge',
    'dealing cut-off resolution to evaluation point',
    'cost of insurance and admin charge by unit cancellation',
    'fund switch as atomic cancel and allocate with one instruction id',
    'partial withdrawal with charge, tax and cover impact',
    'top-up and premium redirection',
    'automatic switching and periodic rebalancing',
    'dynamic de-risking approaching maturity',
    'lock-in, minimum value floor and lapse outcomes',
    'full audit spine and reproducible policy value',
  ]},
  { code: 'TAKF', name: 'Takaful engine', path: 'packages/takaful', capabilities: [
    'takaful model registry (wakalah, mudarabah, waqf, cooperative, hybrid)',
    'participant risk fund and participant investment fund segregation',
    'tabarru contribution routing and operator fee',
    'qard hasan detection, issuance and repayment tracking',
    'surplus determination with actuarial valuation',
    'surplus approval gates (actuary, Shariah Committee, board)',
    'surplus distribution and retention policy per fund and sub-fund',
    'Shariah screening of instruments with purification',
    'takaful window operation inside a conventional insurer',
    'standalone takaful entity with separate ledgers and reporting',
  ]},
  { code: 'CLM', name: 'Claims', path: 'packages/claims', capabilities: [
    'FNOL from any channel with document capture',
    'claim registration, validation and coverage verification',
    'medical pre-authorisation and provider network',
    'motor survey, assessment and repair authorisation',
    'reserve setting and revision with audit',
    'fraud and anomaly signals with investigation workflow',
    'settlement calculation with excess, depreciation and limits',
    'payment instruction, reconciliation and recovery',
    'subrogation and salvage tracking',
    'claim correspondence and regulatory notification',
  ]},
  { code: 'RI', name: 'Reinsurance and retakaful', path: 'packages/reinsurance', capabilities: [
    'treaty programme definition (quota share, surplus, excess of loss)',
    'facultative placement workflow',
    'automatic cession calculation per risk and per event',
    'cession bordereaux and statement generation',
    'recovery tracking and ageing',
    'reinstatement premium and deposit accounting',
    'retakaful variants with model-consistent funds',
    'cash call and collateral management',
    'reinsurance data quality and reconciliation',
    'regulatory and actuarial reporting extracts',
  ]},
  { code: 'BILL', name: 'Billing and collections', path: 'packages/billing', capabilities: [
    'premium induction and instalment schedules',
    'daily cover segments with start and stop events',
    'pay-as-you-go usage event rating',
    'no-auto-start rule with customer election and scheduling',
    'wallet (prepaid) and arrears (post-paid) accounts',
    'grace, suspension, reinstatement and lapse',
    'dunning ladders with suppression rules',
    'receipting, allocation and refunds',
    'commission calculation and payable',
    'pro-rata and short-rate mid-term adjustments',
  ]},
  { code: 'GL', name: 'Centralised and group finance', path: 'packages/finance', capabilities: [
    'double-entry ledger with multi-currency base and foreign amounts',
    'chart of accounts per entity with mapping rules',
    'sub-ledgers for receivable, payable, commission, claims, reinsurance',
    'fund ledger integration for every unit transaction',
    'inter-company transactions with matching and elimination',
    'consolidation across entities and reporting currencies',
    'FX revaluation and translation with realised and unrealised split',
    'cost centres, allocations and budgeting',
    'IFRS 17-shaped groupings available as warehouse dimensions',
    'period close, trial balance and statutory reporting',
  ]},
  { code: 'CRM', name: 'Customer service and care', path: 'packages/crm', capabilities: [
    'case management with SLAs and escalation',
    'complaint handling with regulator escalation',
    'interaction history across channels',
    'service request templates with outcome capture',
    'voice of customer and satisfaction tracking',
    'retention offers and save journeys',
    'knowledge base and scripted responses',
    'quality assurance sampling and coaching',
    'agent performance and workload dashboards',
    'vulnerable customer and hardship handling',
  ]},
  { code: 'DOC', name: 'Documents and correspondence', path: 'packages/documents', capabilities: [
    'template engine with locale-aware merge fields',
    'batch and on-demand generation with delivery evidence',
    'letter and notice library per country pack',
    'endowment and statement generation',
    'reminders and scheduled communications',
    'electronic signature integration and evidence',
    'archive with retention and legal hold',
    'brand assets per tenant and entity',
    'accessibility and plain language checks',
    'correspondence audit and reprint control',
  ]},
  { code: 'CONS', name: 'Consent and data sharing', path: 'packages/consent', capabilities: [
    'consent capture with purpose, scope and expiry',
    'revocation and downstream propagation',
    'consented partner API with scoped response',
    'data sharing audit and subject access requests',
    'cross-border transfer rules per jurisdiction',
    'third-party onboarding and credential lifecycle',
    'rate limits and anomaly detection on partner traffic',
    'purpose limitation enforcement at query time',
    'minor and guardian consent handling',
    'marketing preference and do-not-contact register',
  ]},
  { code: 'ING', name: 'Integration and ingestion fabric', path: 'packages/ingest', capabilities: [
    'file, Excel, JSON, XML, fixed-width and email attachment intake',
    'schema inference with human-confirmed mapping',
    'saved mappings per partner and per file signature',
    'asynchronous bulk processing with resume and replay',
    'per-row validation with partial-success semantics',
    'natural-key dedupe and idempotent commit',
    'quarantine and error file generation',
    'rogue validation fleet with anomaly scoring',
    'reconciliation pack for every load',
    'webhook and subscription egress with retries',
  ]},
  { code: 'REG', name: 'Regulatory packs', path: 'packages/regulatory', capabilities: [
    'rule set schema per country with effective dating',
    'need analysis enforcement before product sale',
    'motor survey and insurer comparison matrix requirement',
    'product admission prerequisites (e.g. health cover prerequisites)',
    'illustration wording and prescribed assumptions',
    'disclosure and cooling-off obligations',
    'takaful-specific rules and surplus restrictions',
    'data residency and record retention',
    'regulator return generation and submission evidence',
    'historical evaluation reproducibility',
  ]},
  { code: 'I18N', name: 'Localisation and renaming', path: 'packages/locale', capabilities: [
    'label registry with plurals, gender and RTL support',
    'tenant-level rename of any label or field',
    'propagation of renaming to API, documents, statements, warehouse',
    'Arabic and English first-class with transliteration policy',
    'number, date, hijri and currency formatting per locale',
    'data translation separated from label translation',
    'translation coverage reporting and fallback rules',
    'regulator-approved wording lock',
    'multi-script search and collation',
    'locale-aware validation messages',
  ]},
  { code: 'ONBD', name: 'Smart onboarding', path: 'packages/onboarding', capabilities: [
    'NFC chip read of ICAO 9303 travel and identity documents',
    'government data source lookup adapters with consent',
    'multi-engine OCR with per-field consensus scoring',
    'driver licence, Emirates ID, national ID, iqama and passport handling',
    'bilingual field extraction with per-field translation',
    'liveness and selfie match with liveness assurance',
    'review queue for low-confidence fields',
    'need analysis trigger before any product suggestion',
    'onboarding audit trail and evidence retention',
    'assisted onboarding at branch or kiosk',
  ]},
  { code: 'DWH', name: 'Data warehouse and reporting', path: 'packages/warehouse', capabilities: [
    'change data capture from operational stores',
    'star schemas per subject area (policy, unit, fund, claim, billing, finance)',
    'actuarial valuation extracts',
    'regulatory marts per country',
    'management dashboards with drill to transaction',
    'fund performance attribution',
    'agent action audit mart',
    'retention and anonymisation pipelines',
    'data quality monitoring with alerts',
    'self-service semantic layer',
  ]},
  { code: 'AI', name: 'AI layer and governance', path: 'packages/ai', capabilities: [
    'agent runtime with scoped tool contracts',
    'action ledger recording inputs, outputs, model and cost',
    'dry-run and preview mode for every agent action',
    'risk-class gated human-in-the-loop',
    'document intelligence for intake and correspondence',
    'claims triage with reserve suggestion and human approval',
    'underwriting evidence assembly',
    'anomaly detection across ingestion and payments',
    'evaluation harness with regression suites per agent',
    'prohibited-action register and policy enforcement',
  ]},
];

const LAYERS = [
  { code: 'design',   name: 'Design and decision record',   role: 'designer',        time: 60 },
  { code: 'contract', name: 'Contract and schema',          role: 'contract-writer', time: 45 },
  { code: 'domain',   name: 'Domain implementation',        role: 'implementer',     time: 90 },
  { code: 'store',    name: 'Persistence and migration',    role: 'implementer',     time: 45 },
  { code: 'api',      name: 'API and events',               role: 'implementer',     time: 60 },
  { code: 'ui',       name: 'Screen, labels and rename',    role: 'implementer',     time: 75 },
  { code: 'test',     name: 'Verification and journey',     role: 'tester',          time: 60 },
  { code: 'docs',     name: 'Documentation and runbook',    role: 'doc-writer',      time: 30 },
];

const PRODUCT_LINES = ['life', 'medical', 'motor', 'travel', 'group', 'unit-linked', 'takaful'];
const COUNTRIES = [
  { code: 'AE', name: 'United Arab Emirates' }, { code: 'SA', name: 'Saudi Arabia' },
  { code: 'MY', name: 'Malaysia' },             { code: 'ID', name: 'Indonesia' },
  { code: 'IN', name: 'India' },                { code: 'BH', name: 'Bahrain' },
  { code: 'QA', name: 'Qatar' },                { code: 'PK', name: 'Pakistan' },
];
const LOCALES = ['en', 'ar', 'ms', 'id', 'ur', 'hi', 'fr', 'zh'];
const DEPTH = ['unit', 'integration', 'regulatory'];

const RISKY = new Set(['FUND', 'ULNK', 'TAKF', 'GL', 'BILL', 'CLM']);

/* ------------------------------------------------------------- generation */

const arg = (k, d) => {
  const hit = process.argv.find((a) => a.startsWith(`--${k}=`));
  return hit ? hit.split('=')[1] : d;
};
const has = (k) => process.argv.includes(`--${k}`);
const OUT = arg('out', 'backlog');
const LONG_TAIL_CAP = Number(arg('long-tail', 30000));
const DRY = has('dry');
const CUTOFF = new Date().toISOString();

let seq = 0;
const nextId = (mod, layer) => `${mod}-${layer.toUpperCase()}-${String(++seq).padStart(5, '0')}`;

function chunk(mod, capIdx, cap, layer, dims = {}) {
  const m = MODULES.find((x) => x.code === mod);
  const L = LAYERS.find((x) => x.code === layer);
  const id = `${m.code}-${L.code.toUpperCase()}-${String(++seq).padStart(6, '0')}`;
  const dimensionTag = [dims.product && `product:${dims.product}`, dims.country && `country:${dims.country}`,
    dims.locale && `locale:${dims.locale}`, dims.depth && `depth:${dims.depth}`].filter(Boolean).join(' ');
  const risk = RISKY.has(m.code) && ['domain', 'store', 'test'].includes(layer) ? 'high'
    : layer === 'docs' ? 'low' : 'medium';
  return {
    id,
    title: `${L.name} — ${cap}${dimensionTag ? ` [${dimensionTag}]` : ''}`,
    module: m.code,
    moduleName: m.name,
    capability: capIdx + 1,
    layer,
    product: dims.product ?? null,
    country: dims.country ?? 'AE',
    locale: dims.locale ?? 'en',
    depth: dims.depth ?? null,
    type: layer,
    dependsOn: dims.prev ? [dims.prev] : [],
    ownerPath: `${m.path}/**`,
    contract: `docs/contracts/${m.code.toLowerCase()}.md#${(capIdx + 1)}-${layer}`,
    acceptance: [
      `${cap} — behaviour demonstrable in isolation`,
      layer === 'test' ? 'independent re-run reproduces the result' : 'typecheck clean and unit tests green',
      'evidence stored under reports/<chunkId>/',
    ],
    evidenceRequired: layer === 'test' ? ['test-run', 'code-diff'] : ['code-diff', 'unit-tests'],
    risk,
    agentRole: L.role,
    estimateMinutes: L.time,
    generatedAt: CUTOFF,
  };
}

const criticalPath = [];
const longTail = [];

/* 1. Critical path: every module x capability x layer, chained design -> docs. */
for (const m of MODULES) {
  m.capabilities.forEach((cap, i) => {
    let prev = null;
    for (const L of LAYERS) {
      const c = chunk(m.code, i, cap, L.code, { prev, country: 'AE' });
      prev = c.id;
      criticalPath.push(c);
    }
  });
}

/* 2. Critical path additions: UAE regulatory pack slice + product-line seeding. */
for (const m of MODULES) {
  for (const cap of ['UAE rule enforcement and evidence', 'UAE wording and disclaimer generation', 'UAE regulator return and submission']) {
    const c = chunk(m.code, 90, cap, 'test', { prev: null, country: 'AE', depth: 'regulatory' });
    criticalPath.push(c);
  }
}
for (const pl of PRODUCT_LINES) {
  for (const cap of [`${pl} product template seeded end to end`, `${pl} journey test from quote to first payment`, `${pl} charge and tax configuration`, `${pl} regulator wording pack`]) {
    const c = chunk('PROD', 91, cap, 'test', { prev: null, product: pl, country: 'AE' });
    criticalPath.push(c);
  }
}

/* 3. Long tail: dimensional expansion. */
let tailBuilt = 0;
outer: for (const m of MODULES) {
  for (let i = 0; i < m.capabilities.length; i++) {
    const cap = m.capabilities[i];
    const combos = [];
    for (const pl of PRODUCT_LINES) combos.push({ layer: 'domain', product: pl });
    for (const pl of PRODUCT_LINES) combos.push({ layer: 'api', product: pl });
    for (const loc of LOCALES) combos.push({ layer: 'ui', locale: loc });
    for (const co of COUNTRIES) combos.push({ layer: 'test', country: co.code, depth: 'integration' });
    for (const co of COUNTRIES) for (const d of DEPTH) combos.push({ layer: 'test', country: co.code, depth: d });
    for (const co of COUNTRIES) combos.push({ layer: 'docs', country: co.code });
    for (const co of COUNTRIES) combos.push({ layer: 'store', country: co.code });
    for (const loc of LOCALES) combos.push({ layer: 'docs', locale: loc });
    for (const c of combos) {
      longTail.push(chunk(m.code, i, cap, c.layer, c));
      if (++tailBuilt >= LONG_TAIL_CAP) break outer;
    }
  }
}

/* ------------------------------------------------------------- reporting */

const counts = (rows) => {
  const by = {};
  for (const r of rows) by[r.module] = (by[r.module] ?? 0) + 1;
  return by;
};
const cpBy = counts(criticalPath);
const ltBy = counts(longTail);
const matrix =
  MODULES.length * LAYERS.length * PRODUCT_LINES.length * COUNTRIES.length * LOCALES.length * DEPTH.length;

const lines = [];
lines.push('# Backlog summary', '');
lines.push(`Generated: ${CUTOFF}`);
lines.push('');
lines.push(`- **Critical path (v1):** ${criticalPath.length.toLocaleString()} chunks`);
lines.push(`- **Long tail generated:** ${longTail.length.toLocaleString()} chunks (cap \`--long-tail=${LONG_TAIL_CAP}\`)`);
lines.push(`- **Total in this build:** ${(criticalPath.length + longTail.length).toLocaleString()} chunks`);
lines.push('');
lines.push('## The matrix');
lines.push('');
lines.push('```');
lines.push(`${MODULES.length} modules x ${LAYERS.length} layers x ${PRODUCT_LINES.length} product lines x ${COUNTRIES.length} countries x ${LOCALES.length} locales x ${DEPTH.length} depths`);
lines.push(`= ${matrix.toLocaleString()} combinatorial chunks`);
lines.push('```');
lines.push('');
lines.push('Add per-field decomposition (every field of every form in every locale) and per-document decomposition');
lines.push('(every letter, statement and regulator return, in every language) and the addressable space passes');
lines.push('**100,000,000 chunks** — the "99999999 agents" scale. Regenerate with a bigger `--long-tail` at any time;');
lines.push('the backlog is a reservoir, the fleet is a faucet.');
lines.push('');
lines.push('## Critical path by module');
lines.push('');
lines.push('| Module | Chunks |');
lines.push('| --- | --- |');
for (const m of MODULES) lines.push(`| ${m.code} — ${m.name} | ${(cpBy[m.code] ?? 0).toLocaleString()} |`);
lines.push('');
lines.push('## Long tail by module');
lines.push('');
lines.push('| Module | Chunks |');
lines.push('| --- | --- |');
for (const m of MODULES) lines.push(`| ${m.code} — ${m.name} | ${(ltBy[m.code] ?? 0).toLocaleString()} |`);
lines.push('');
lines.push('## Entry format');
lines.push('');
lines.push('One JSON object per line; see `docs/03-ROGUE-BUILD-SYSTEM.md` §2 and `AGENTS.md` for the worker contract.');
lines.push('');

if (DRY) {
  console.log(`critical-path: ${criticalPath.length}`);
  console.log(`long-tail:     ${longTail.length}`);
  console.log(`matrix total:  ${matrix}`);
} else {
  mkdirSync(OUT, { recursive: true });
  const jl = (rows) => rows.map((r) => JSON.stringify(r)).join('\n') + '\n';
  writeFileSync(join(OUT, 'critical-path.jsonl'), jl(criticalPath));
  writeFileSync(join(OUT, 'long-tail.jsonl'), jl(longTail));
  writeFileSync(join(OUT, 'SUMMARY.md'), lines.join('\n'));
  console.log(`wrote ${OUT}/critical-path.jsonl  (${criticalPath.length} chunks)`);
  console.log(`wrote ${OUT}/long-tail.jsonl      (${longTail.length} chunks)`);
  console.log(`wrote ${OUT}/SUMMARY.md`);
  console.log(`matrix total: ${matrix.toLocaleString()} combinatorial chunks`);
}
