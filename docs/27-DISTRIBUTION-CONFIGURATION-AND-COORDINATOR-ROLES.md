# 27 · Separate distribution configuration tabs and coordinator roles

**Status:** implemented · 2026-10-27

## 1. Why this change exists

The console already had a capable omni-channel registry, but it exposed it only as section 8 of
**Master settings & ERP**. That made the three commercial scopes look like one screen:

- a whole **omni channel**,
- one **partner** inside that channel,
- one **sub-channel × partner** desk inside that partner.

Operators could not see separate **Omni Channel**, **Partner** and **Sub Channel Partners**
configuration tabs, and the role catalogue had no coordinator template scoped to a channel, a
partner or a sub-channel partner. The commercial terms were also scattered across partner defaults,
per-product offers and channel commission caps. This change gives each scope its own visible,
role-gated configuration surface while keeping one domain source of truth.

## 2. Decision

Three top-level tabs were added after Master settings:

| Tab id | Scope | Primary owner |
| --- | --- | --- |
| `distribution-channels` | `omni-channel` | Configuration Analyst, Administration, **Omni-Channel Coordinator** |
| `distribution-partners` | `partner` | Configuration Analyst, Administration, **Partner Coordinator** |
| `distribution-subchannels` | `sub-channel-partner` | Configuration Analyst, Administration, **Sub-Channel Coordinator** |

Each tab configures the same complete contract:

1. **Type of products** — the product line from the priced product master.
2. **Products** — one filed `productId`.
3. **Sub-products** — one or more varieties inside that line.
4. **Commission** — a schedule of percentages, stored as integer basis points.
5. **Premium rate uplift** — a signed percentage, stored as basis points.
6. **Commission disbursement terms** — frequency, payout trigger, settlement days, holdback and note.
7. **Clawback rules** — trigger, policy-year/month basis, declining recovery schedule and note.

The `configurator` role is now displayed as **Configuration Analyst**; its stable id is retained for
API compatibility. Three new supervisor-tier role templates were added in a new
`distribution-config` family. Each has `channelScope`, `subChannelScope` and `partnerScope` fields
and is intended to be cloned once per real channel, partner or sub-channel partner. The Role Builder
can now clone a template and set those three scopes explicitly.

## 3. Alternatives considered

| Alternative | Why it was rejected |
| --- | --- |
| Add three nested sub-sections inside the existing Master settings omni-channel panel. | It would not produce the three visible tabs the request asks for, and a single tab cannot be granted to three different coordinator roles with different read/write levels. |
| Duplicate the existing `ChannelPartner` and `PartnerProductOffer` structures into the UI state. | It would create a second commercial source of truth and let the screen disagree with the pricing, commission and clawback engines. |
| Add only navigation entries pointing back to the same combined panel. | It would hide the governance problem without giving each scope its own auditable row and role. |
| Create one unrestricted coordinator role for all three scopes. | It would not satisfy “for each channel and sub channel and partner”; scoped templates allow one clone per real distribution node. |

## 4. Domain and API shape

`src/core/distribution-configuration.ts` holds `DistributionConfigurationRegistry`. A row is keyed
by `scope | channelCode | partnerId | subChannelCode | productId`. Re-filing the same key updates the
row. Every write records an audit entry; disabled rows do not resolve.

Percentage helpers convert human percentages into integer basis points without floating-point
multipliers: `15.00 → 1500`, `0.25 → 25`, `-2.5 → -250`. Money remains decimal `Money` and is
uplifted/commissioned by the existing `applyBps` engine.

The API surface is:

- `GET /api/distribution/config` — snapshot, statistics, catalogue and audit trail.
- `POST /api/distribution/config` — validate and file/update one row.
- `POST /api/distribution/config/remove` — remove one row.

Writes check the active console role against the relevant tab's `full` access. The Node HTTP
authorizer additionally accepts `master-admin`, `configurator`, `configuration-analyst` and the
three coordinator role ids on `/distribution/*` writes.

Reference validation uses the live masters: the channel must exist, a partner must belong to that
channel, a sub-channel must belong to that channel and (where linked) to that partner, the product
must exist in the priced product factory, the product type must match the product line, every
sub-product must be a variety of that line, and the maximum commission must fit the channel or
sub-channel cap. A malformed value is refused at the boundary; a domain contradiction is refused
with a sentence that names the rule.

## 5. Pricing and commission integration

`ErpManager` wires the registry into `OmniChannelRegistry` through
`setDistributionTermsResolver`. `termsFor(...)`, `commissionFor(...)`, `clawbackFor(...)` and
`priceRisk(...)` resolve the most specific enabled row:

```text
sub-channel partner  →  partner  →  omni-channel  →  existing offer / partner default
```

`priceRisk` and the commission endpoint can now receive `subChannelCode`, so a desk-specific row
really wins. The partner portal passes its own scoped sub-channel when accruing commission. The old
Master settings panel remains as a compatibility view of the underlying masters.

Commission disbursement terms are filed as data and shown in the configuration row and audit
trail. They do **not** execute a payment: no bank file, ledger posting or external settlement is
created by this change. That boundary is deliberate; payment execution remains a separate,
high-risk workflow.

## 6. RBAC enforcement

`DISTRIBUTION_CONFIG_TAB_ID_SET` contains the three tab ids. `SecurityGovernanceRegistry`:

- seeds them to `none` for every unrelated non-administration role;
- gives all three `full` access to `administration` and the Configuration Analyst;
- gives each coordinator `full` access to its own tab and `read` access to the other two;
- refuses `setRoleNodeAccess`, `upsertProfile` and AI recommendation application from granting the
  tabs to an unrelated role;
- allows clones of the `distribution-config` family so an administrator can create a role for each
  real channel, partner and sub-channel partner.

`ADMIN_ONLY_TAB_IDS` is untouched: `access-doa` and `role-matrix` remain Administration-only.

## 7. Evidence

- `src/core/distribution-configuration.test.ts` — exact percentages, audit, precedence, caps, scope
  validation, disbursement/clawback refusals, and pricing/commission/clawback integration.
- `src/core/distribution-routes.test.ts` — GET/POST/remove routes, 400 boundary refusals, live-master
  refusals and active-role write enforcement.
- `src/core/distribution-rbac.test.ts` — tab registry, 39-role seed, coordinator scopes, guards and
  role cloning.
- `src/ui/distribution-config-views.test.ts` — three separate SSR panels, all requested field
  groups, and read-only enforcement.
- `src/core/guide.test.ts`, `src/core/requestguard.test.ts`, `src/core/rbac.test.ts`,
  `src/ui/rbac-autopick-views.test.ts`, `src/ui/role-matrix-views.test.ts` — guide coverage, route
  catalogue drift and role-count regressions.

Run `npm run verify` for typecheck, lint, coverage and build evidence.
