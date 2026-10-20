# 17 · Pre-Load Security Gate, 36-Profile RBAC, DOA Approval Engine, Smart Auto-Pick & Actuarial Age Rules

This document describes the enterprise security governance layer, Delegation of Authority (DOA) approval & notification engine, zero-duplicate Smart Auto-Pick memory, reusable AI-assisted `<SmartComboBox />` controls, and configurable Master Settings DOB-to-Insurance-Age engine built into `Central_insurance-illustration-portal`.

---

## 1. Pre-Load Security & 36-Profile Workspace Gate

Prior to opening the ERP console, operators land on **`<ProfileSelectionGate />`** (`src/ui/rbac-views.tsx`), backed by `SecurityGovernanceRegistry` (`src/core/rbac.ts`).

### Supported Enterprise Profiles (All 36 Built-In)

1. **`administration`** — **Unrestricted Complete Access** across **all 29 tabs**, **every section**, **every sub-section**, full unmasked PII, and unlimited executive DOA override authority (`doaLimitMinor = null`).
2. **`supervisor`** — Operations Desk Supervisor.
3. **`configurator`** — Product, Tariff & Master Data Configurator.
4. **`underwriter-officer`** — Life, Medical & General Risk Underwriter Officer.
5. **`underwriter-manager`** — Head of Underwriting & Facultative Referrals.
6. **`retention-officer`** — Policy Conservation & Retention Office Specialist.
7. **`retention-manager`** — Head of Policy Retention & Conservation.
8. **`endorsement-officer`** — Policy Servicing & Alteration Officer.
9. **`endorsement-supervisor`** — Policy Endorsement & Servicing Supervisor.
10. **`claim-officer`** — Claims Registration & Adjudication Officer.
11. **`claim-manager`** — Head of Claims & Reserves.
12. **`settlement-officer`** — Claims & Maturity Payout Settlement Officer.
13. **`settlement-manager`** — Head of Claims & Benefit Settlements.
14. **`reinsurance-officer`** — Treaty Cession, Bordereaux & Recovery Officer.
15. **`reinsurance-manager`** — Head of Reinsurance & Retakaful Placement.
16. **`bancassurance-operations-officer`** — Head-Office Bancassurance Operations & Reconciliation Officer.
17. **`fund-configuration`** — Unit-Linked & Takaful Fund Setup & Charge Configurator.
18. **`accountant`** — Insurance Sub-Ledger & General Ledger Accountant.
19. **`finance`** — Group Finance, IFRS-17 & Statutory Controller.
20. **`cost-controller`** — Expense, Commission Leakage & Budget Cost Controller.
21. **`fund-investment-officer`** — Fund Investment Office Dealing & NAV Valuation Officer.
22. **`fund-investment-manager`** — Chief Fund Investment Manager & NAV Sign-Off Authority.
23. **`agent-1`** — Tied Agency Sales Officer (Desk 1).
24. **`agent-2`** — Tied Agency Sales Officer (Desk 2).
25. **`agent-marsh`** — Marsh Corporate Broker / Agency Officer (`BROKER-MARSH` / `MARSH-AGENCY`).
26. **`agent-supervisor`** — Agency & Broker Distribution Supervisor.
27. **`banca-officer-1`** — Bancassurance Specialist Officer (Desk 1).
28. **`banca-officer-2`** — Bancassurance Specialist Officer (Desk 2).
29. **`banca-supervisor`** — Bancassurance Channel Supervisor.
30. **`aggregator`** — Digital Comparison Aggregator API / Desk User.
31. **`direct-customer`** — Direct Self-Service Policyholder / Applicant Portal View.
32. **`referral-partner-1`** — Introducer / Corporate Referral Partner 1.
33. **`referral-partner-2`** — Wealth Advisory Introducer / Referral Partner 2.
34. **`bank-manager`** — Partner Bank Regional / Head Manager.
35. **`branch-officer`** — Retail Bank Branch Frontline Officer.
36. **`branch-manager`** — Retail Bank Branch Manager.

---

## 2. Granular 3-Tier RBAC + AI Access & Segregation-of-Duties (SoD) Advisor

Permissions resolve deterministically across three levels (`'full' | 'read' | 'none'`):

1. **Tab Level** (`tabAccess[tabId]`) across all **29** console tabs.
2. **Section Level** (`sectionAccess['tabId:sectionId']`).
3. **Sub-Section Level** (`subSectionAccess['tabId:sectionId:subSectionId']`).

The **AI Access & Segregation-of-Duties (SoD) Advisor** (`recommendAccess(profileId)`) computes optimal access for any profile and detects regulatory dual-control conflicts (e.g., separating Claims Adjudication from Cash Settlement Release, Fund Configuration from Daily NAV Sign-Off, and Distribution Quoting from Underwriting Final Sign-Off), with one-click **Apply AI Optimal Matrix** (`POST /security/profile/ai-apply`) and **Reset to Baseline** (`POST /security/profile/reset`).

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

## 4. Zero-Duplicate Smart Auto-Pick & Editable `<SmartComboBox />` Controls

- **Customer Golden Record Memory (`src/core/autopick.ts`)**: Once a customer's `dateOfBirth`, `sex`, `smoker`, `heightCm`, `weightKg` (and live BMI), `occupationClass`, `annualIncome`, `beneficiary`, or `dependentProducts` (linked riders/companion covers) have been entered on Customer 360, Proposal Registration, or Customer Journey, `resolveCustomerAutoPick(...)` automatically pre-populates them across downstream workflows while keeping every field editable.
- **Editable + Suggested `<SmartComboBox />` & `<SmartMultiComboBox />` (`src/ui/combobox.tsx`)**: Combines instant ranked domain/AI suggestions with unrestricted custom text entry across **Product Name**, **Product Description / Omni-Channel Shelf Name**, **Dependent Products & Riders**, **Channel / Sub-Channel codes**, **Medical Conditions**, **Pursuits**, **Cities**, **Partner Consents**, and **Beneficiary Relationships**.

---

## 5. Configurable Actuarial Age Calculation in Master Settings (`Master -> age-autopick`)

Configured via `AgeCalculationRegistry` (`src/core/autopick.ts`) and exposed under **Master Settings → Actuarial age calculation (Nearest / Age Next / Age Last)** (`GET/POST /master/age-calculation`):

| Mode ID | Code | Actuarial Rule |
| --- | --- | --- |
| `age-nearest` | **ANB** | **Age Nearest Birthday** — `ALB + 1` once elapsed time since last birthday reaches 6 calendar months (`six-months` rule) or `182.5` days (`days` rule); otherwise `ALB`. |
| `age-next` | **ANxB** | **Age Next Birthday** — `ALB` on exact birthday; `ALB + 1` on every other calendar day of the year. |
| `age-last` | **ALB** | **Age Last Birthday** — Completed integer years since Date of Birth as of the valuation date. |

Supports both **Global Tenant Default** and **Per-Product Overrides**, updating age live across Customer 360, Proposal Registration, and the 19-Stage Customer Journey.
