# 17 · Pre-Load Security Gate, 36-Role RBAC, Role Authority Tiers, DOA Approval Engine, Smart Auto-Pick & Actuarial Age Rules

This document describes the enterprise security governance layer, Delegation of Authority (DOA) approval & notification engine, zero-duplicate Smart Auto-Pick memory, reusable AI-assisted `<SmartComboBox />` controls, and configurable Master Settings DOB-to-Insurance-Age engine built into `Central_insurance-illustration-portal`.

> **Terminology: a *role*, not a *profile*.** Everything in this layer is a permission template called a **role** (`SecurityRole`, aliased `SecurityProfile` for source compatibility). A role is not a person and does not carry credentials: named user accounts, passwords and provisioning will be added later as a separate layer that references a role id, exactly as `WorldSnapshot.security.userProfileLayer` states (`implemented: false`). All UI copy, tabs and endpoints speak in role terms; `profile` survives only inside legacy identifiers and the `x-portal-profile` header.

---

## 1. Pre-Load Security & 36-Role Workspace Gate

Prior to opening the ERP console, operators land on **`<ProfileSelectionGate />`** (`src/ui/rbac-views.tsx`, exported too as `<RoleSelectionGate />`), backed by `SecurityGovernanceRegistry` (`src/core/rbac.ts`). The gate lists all 36 roles with their authority tier, searchable and filterable by family, and offers access guard banners (`<ProfileAccessGuardBanner />` / `<RoleAccessGuardBanner />`) when the active role is missing a tab.

### Supported Enterprise Roles (All 36 Built-In)

1. **`administration`** — **Executive** · **Unrestricted Complete Access** across **all 31 tabs** (the **only** role granted the `Access & DOA` and `Role access matrix` governance tabs), **every section**, **every sub-section**, full unmasked PII, and unlimited DOA override authority (`doaLimitMinor = null`).
2. **`supervisor`** — **Supervisor** · Operations Desk Supervisor.
3. **`configurator`** — **Officer** · Product, Tariff & Master Data Configurator.
4. **`underwriter-officer`** — **Officer** · Life, Medical & General Risk Underwriter Officer.
5. **`underwriter-manager`** — **Manager** · Head of Underwriting & Facultative Referrals.
6. **`retention-officer`** — **Officer** · Policy Conservation & Retention Officer.
7. **`retention-manager`** — **Manager** · Head of Policy Retention & Conservation.
8. **`endorsement-officer`** — **Officer** · Policy Servicing & Alteration Officer.
9. **`endorsement-supervisor`** — **Supervisor** · Policy Endorsement & Servicing Supervisor.
10. **`claim-officer`** — **Officer** · Claims Registration & Adjudication Officer.
11. **`claim-manager`** — **Manager** · Head of Claims & Reserves.
12. **`settlement-officer`** — **Officer** · Claims & Maturity Payout Settlement Officer.
13. **`settlement-manager`** — **Manager** · Head of Claims & Benefit Settlements.
14. **`reinsurance-officer`** — **Officer** · Treaty Cession, Bordereaux & Recovery Officer.
15. **`reinsurance-manager`** — **Manager** · Head of Reinsurance & Retakaful Placement.
16. **`bancassurance-operations-officer`** — **Officer** · Head-Office Bancassurance Operations & Reconciliation Officer.
17. **`fund-configuration`** — **Officer** · Unit-Linked & Takaful Fund Setup & Charge Configurator.
18. **`accountant`** — **Officer** · Insurance Sub-Ledger & General Ledger Accountant.
19. **`finance`** — **Manager** · Group Finance, IFRS-17 & Statutory Controller.
20. **`cost-controller`** — **Officer** · Expense, Commission Leakage & Budget Cost Controller.
21. **`fund-investment-officer`** — **Officer** · Fund Investment Dealing & NAV Valuation Officer.
22. **`fund-investment-manager`** — **Manager** · Chief Fund Investment Manager & NAV Sign-Off Authority.
23. **`agent-1`** — **Officer** · Tied Agency Sales Officer (Desk 1).
24. **`agent-2`** — **Officer** · Tied Agency Sales Officer (Desk 2).
25. **`agent-marsh`** — **Officer** · Marsh Corporate Broker / Agency Officer (`BROKER-MARSH` / `MARSH-AGENCY`).
26. **`agent-supervisor`** — **Supervisor** · Agency & Broker Distribution Supervisor.
27. **`banca-officer-1`** — **Officer** · Bancassurance Specialist Officer (Desk 1).
28. **`banca-officer-2`** — **Officer** · Bancassurance Specialist Officer (Desk 2).
29. **`banca-supervisor`** — **Supervisor** · Bancassurance Channel Supervisor.
30. **`aggregator`** — **Officer** · Digital Comparison Aggregator API / Desk User.
31. **`direct-customer`** — **Officer** · Direct Self-Service Policyholder / Applicant Portal View.
32. **`referral-partner-1`** — **Officer** · Introducer / Corporate Referral Partner 1.
33. **`referral-partner-2`** — **Officer** · Wealth Advisory Introducer / Referral Partner 2.
34. **`bank-manager`** — **Manager** · Partner Bank Regional / Head Manager.
35. **`branch-officer`** — **Officer** · Retail Bank Branch Frontline Officer.
36. **`branch-manager`** — **Manager** · Retail Bank Branch Manager.

Tier counts are derived from the seed ids, not hand-maintained: **22 officer · 4 supervisor · 9 manager · 1 executive** (`worldSnapshot().security.authorities`).

---

## 2. Granular 3-Tier RBAC + AI Access & Segregation-of-Duties (SoD) Advisor

Permissions resolve deterministically across three levels (`'full' | 'read' | 'none'`):

1. **Tab Level** (`tabAccess[tabId]`) across all **31** console tabs (`TABS`, matching `CONSOLE_TABS`). `access-doa` (**Access & DOA**) and `role-matrix` (**Role access matrix**) are restricted strictly to **`administration`** (`ADMIN_ONLY_TAB_IDS`) and deleted from all 35 non-administrator profiles.
2. **Section Level** (`sectionAccess['tabId:sectionId']`).
3. **Sub-Section Level** (`subSectionAccess['tabId:sectionId:subSectionId']`).

The **AI Access & Segregation-of-Duties (SoD) Advisor** (`recommendAccess(roleId)`) computes optimal access for any role and detects regulatory dual-control conflicts (e.g., separating Claims Adjudication from Cash Settlement Release, Fund Configuration from Daily NAV Sign-Off, and Distribution Quoting from Underwriting Final Sign-Off), with one-click **Apply AI Optimal Matrix** (`POST /security/profile/ai-apply`) and **Reset to Baseline** (`POST /security/profile/reset`).

---

## 3. Entity × Channel × Sub-Channel Supervision Mapping & DOA Notification Engine

In the dedicated **`Role Access & DOA`** tab (`access-doa`):

- **Supervision Hierarchy Matrix** maps **`Entity` (`ALK-CONV`, `ALK-TKF`, `ALK-MY`, `*`) × `Channel` (`AGENCY`, `BROKER-MARSH`, `BANCA`, `AGGREGATOR`, `DIRECT`, `REFERRAL`, `HEAD-OFFICE`) × `Sub-Channel` (`MARSH-AGENCY`, `AGENCY-DESK-1`, `BANCA-DESK-1`, `BRANCH-RETAIL-01`, etc.)** to:
  - Immediate **Supervisor Profile** + exact decimal **Supervisor DOA Cap (`Money`)**
  - Escalation **Manager Profile** + exact decimal **Manager DOA Cap (`Money`)**
- When an action exceeds the operator's DOA limit (`POST /security/doa/request`):
  1. `resolveApprover(...)` selects the mapped Supervisor (or auto-escalates directly to the Manager / Executive Administration when the amount exceeds the Supervisor's cap).
  2. An in-app **Notification (`NTF-*`)** is immediately pushed to the target approver's inbox (`HeaderSecurityStrip` bell drawer + `GET /security/notifications`).
  3. Self-approval is strictly rejected (`SecurityGovernanceError`); approvers can **Approve**, **Reject**, or **Escalate** (`POST /security/doa/decide`), generating audit log entries and requester notifications at every transition.

---

## 4. Role Authority Tiers: DOA Change Control vs. Officer Limit-Increase Requests

Every role carries an `authorityLevel` in `RoleAuthorityLevel = 'officer' | 'supervisor' | 'manager' | 'executive'`, defined once in `AUTHORITY_TIERS`:

| Tier | Rank | May change DOA (`canChangeDoa`) | May manage role access (`canManageRoleAccess`) | Typical roles |
| --- | --- | --- | --- | --- |
| `officer` | 1 | **no** | **no** | underwriter-officer, claim-officer, retention-officer, agents, banca officers, branch-officer, aggregator, direct-customer, referral partners |
| `supervisor` | 2 | **yes** | **yes** | supervisor, endorsement-supervisor, agent-supervisor, banca-supervisor |
| `manager` | 3 | **yes** | **yes** | underwriter/retention/claim/settlement/reinsurance/fund-investment/bank/branch managers, finance |
| `executive` | 4 | **yes** | **yes** | administration (unlimited cap) |

The rules the engine actually enforces:

- **Officers can never change a DOA cap or the access tree.** `changeRoleDoa`, `setRoleNodeAccess` and `POST /security/role/access|doa` refuse an officer actor with `SecurityGovernanceError` ("…changed at supervisor or manager level only; officers raise a DOA limit-increase request instead.").
- **Officers request, supervisors decide.** `submitDoaLimitIncreaseRequest` (`POST /security/doa/limit-request`) accepts `{ roleId, requestedLimitAed, reason }`, rejects a request that is not strictly above the current cap, routes it to the mapped supervisor/manager (`resolveApprover` over Entity × Channel × Sub-Channel), and **never auto-approves**. The officer sees the request id and the current/requested labels in the access guard banner; `worldSnapshot().security.doaRequests` carries the pending item.
- **Only approval applies the cap.** `decideDoaRequest` (`POST /security/doa/decide`) applies the new cap on `approve`, files `doa.limit-increase-applied` on the audit trail and notifies the requester. Rejection leaves the cap untouched.
- **No upward edits, no self-recap.** A supervisor/manager may only edit roles strictly below its own rank, and may not set a cap above its own cap; self-approval of one's own request is rejected. Authority-level changes are Administration-only.
- **The audit trail records authority, not intent** — a refused officer attempt is itself evidence that the control held (`worldSnapshot().security.accessAudit`).

---

## 5. Role Access Matrix Tab (`role-matrix`): Tab → Section → Sub-Section Enable/Disable Tree

A dedicated console tab, **`role-matrix`** ("Role Access Matrix"), placed directly after `access-doa`, gives each role its own hierarchical enable/disable surface:

- **Role directory** (`role-directory`): all 36 roles with tier, family, Entity × Channel × Sub-Channel scope, DOA cap, full/read tab counts, landing tab, *Inspect tree* and *Switch session* actions, family filters and search.
- **Visibility tree** (`access-tree`): every tab expands into its sections and sub-sections (`SECURITY_SURFACE_CATALOGUE`, 30 tabs). Each node is set to **Full — visible & editable**, **Read-only — visible, locked**, **Hidden — not in navigation**, or **inherit** from its parent. Nodes carry their *effective* level so inherited values are visible, not guessed. This is the mechanism that decides, for example, which tabs and sections a banker sees on the policyholder tab.
- **DOA limits & limit-increase requests** (`doa-limits`): cap editor for supervisor/manager actors, plus the officer "Request a DOA limit increase" form and the approver path that applies it.
- **Access & DOA change audit trail** (`role-audit`): every role creation, node override, DOA action grant, cap change and applied limit increase.

Storage is override-only: `tabAccess` holds a level for every tab, while `sectionAccess` / `subSectionAccess` only hold **explicit** overrides. A missing key means *inherit*, which is what makes the tree explainable: moving a tab moves the whole branch unless a child was deliberately pinned. `'inherit'` is accepted by `setRoleNodeAccess` and clears the override; `'full'` / `'read'` / `'none'` cascade down the branch.

Enforcement is server-side in the registry, not just hidden in the UI: **both `access-doa` and `role-matrix` are restricted strictly to `administration`** (`ADMIN_ONLY_TAB_IDS`), deleted from all 35 non-administrator profiles, blocked from being granted to non-administrator roles via `setRoleNodeAccess` or `upsertProfile`, and every mutation re-checks the actor's tier, rank and DOA cap before writing.

---

## 6. Zero-Duplicate Smart Auto-Pick & Editable `<SmartComboBox />` Controls

- **Customer Golden Record Memory (`src/core/autopick.ts`)**: Once a customer's `dateOfBirth`, `sex`, `smoker`, `heightCm`, `weightKg` (and live BMI), `occupationClass`, `annualIncome`, `beneficiary`, or `dependentProducts` (linked riders/companion covers) have been entered on Customer 360, Proposal Registration, or Customer Journey, `resolveCustomerAutoPick(...)` automatically pre-populates them across downstream workflows while keeping every field editable.
- **Editable + Suggested `<SmartComboBox />` & `<SmartMultiComboBox />` (`src/ui/combobox.tsx`)**: Combines instant ranked domain/AI suggestions with unrestricted custom text entry across **Product Name**, **Product Description / Omni-Channel Shelf Name**, **Dependent Products & Riders**, **Channel / Sub-Channel codes**, **Medical Conditions**, **Pursuits**, **Cities**, **Partner Consents**, and **Beneficiary Relationships**.

---

## 7. Configurable Actuarial Age Calculation in Master Settings (`Master -> age-autopick`)

Configured via `AgeCalculationRegistry` (`src/core/autopick.ts`) and exposed under **Master Settings → Actuarial age calculation (Nearest / Age Next / Age Last)** (`GET/POST /master/age-calculation`):

| Mode ID | Code | Actuarial Rule |
| --- | --- | --- |
| `age-nearest` | **ANB** | **Age Nearest Birthday** — `ALB + 1` once elapsed time since last birthday reaches 6 calendar months (`six-months` rule) or `182.5` days (`days` rule); otherwise `ALB`. |
| `age-next` | **ANxB** | **Age Next Birthday** — `ALB` on exact birthday; `ALB + 1` on every other calendar day of the year. |
| `age-last` | **ALB** | **Age Last Birthday** — Completed integer years since Date of Birth as of the valuation date. |

Supports both **Global Tenant Default** and **Per-Product Overrides**, updating age live across Customer 360, Proposal Registration, and the 19-Stage Customer Journey.

---

## 8. Role & DOA API Surface

| Method & path | Purpose |
| --- | --- |
| `GET /security/rbac` · `GET /security/roles` | Full security snapshot: `roles`, `roleFamilies`, `authorities`, `activeRoleId`, `roleCount`, `doaRequests`, `accessAudit`, `userProfileLayer` |
| `POST /security/session` | Switch the session role — `{ roleId }` (or legacy `{ profileId }`) |
| `POST /security/profile` · `POST /security/role` | Create/update a role (tier, rank, scopes, caps, action grants) |
| `POST /security/role/access` | Set one tree node — `{ roleId, kind: 'tab'|'section'|'subSection', key, level, actorRoleId }` |
| `POST /security/role/doa` | Change cap and/or action grants — `{ roleId, doaLimitAed?, doaActions?, actorRoleId? }`; supervisor/manager only |
| `POST /security/doa/limit-request` | Officer request — `{ roleId, requestedLimitAed, reason }` → `{ requestId, currentLimitLabel, requestedLimitLabel }` |
| `POST /security/doa/decide` | Approve/reject/escalate — `{ requestId, actorRoleId, decision, note? }` |
| `POST /security/doa/request` · `POST /security/doa/decide` | Transaction-level DOA approval for a single deal |
| `GET /security/notifications` | Approver inbox / requester notifications (`NTF-*`) |

`SecurityGovernanceError` is a domain error raised by the registry; the console surfaces its message directly in the access guard banners and the role matrix panels.
