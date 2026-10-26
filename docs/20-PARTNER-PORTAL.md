# Partner portal: contract and decision record

## Scope and decision

The live workspace is mounted at `/partner-portal`. The standalone `demo/offline.html` opens it at `#partner-portal` and keeps state only in the browser tab.

The partner workspace applies to every filed, enabled omni-channel partner and its permitted sub-channels; it is not broker- or agency-specific. The existing customer journey remains the source of quotations, signatures, risk information, underwriting and issuance. A journey must be attributed to a partner before it is routed or converted. A signed, current quotation and a completed application are submitted for **one** review: a supervisor, manager or senior manager may approve, return or reject it. An approver must be a different principal from the submitter. A higher level does not need a previous level to have rejected or timed out; this is fallback authority, not three consecutive approvals.

Approval records the route calculated by the existing underwriting rules: straight-through / rules, insurer or senior manual review, independent panel assistance, or reinsurance. A manual route needs a separate, named insurer underwriting review after partner approval. Neither partner approval nor a route alone issues cover; the existing medical, reinsurance, payment and conversion gates remain in force. Partner payment is blocked before approval. The review is bound to a fingerprint of the signed quotation, risk facts and underwriting decision. Because the legacy journey does not reliably rebuild its underwriting application after a coverage change, a quoted case cannot be amended in this prototype: start a new journey and obtain a fresh signed quotation. A paid, routed or issued application cannot be returned through this path; insurer cancellation or correction is required.

**Unmet sequencing requirement:** the legacy quotation stage requires `underwriting.decide` before issuing the quotation. That call records a decision and simulated accepted exposure *before* the customer signs and before partner approval. This implementation gates the subsequent routing and conversion, but does **not** defer all underwriting until after the partner review. Achieving the requested ordering requires an explicitly approved conditional-quotation contract, changes to the quotation/underwriting engines and independent regulatory and financial review; the portal does not pretend those changes already exist.

A partner may reconcile an insurer-entered commission accrual against its statement, request clarification, and approve a matching figure. Accruals use the existing filed partner/product commission schedule and exact minor-unit currency arithmetic. Settlement entries are **references to externally performed disbursements**; no endpoint sends money, posts a GL journal, or settles a claim. Policy information, financial and non-financial endorsements, claims, settlement and reporting are communication requests, not changes to the underlying policy or claim. The insurer remains responsible for performing the actual downstream work. Commission totals and operational reports are scoped to the partner and, when selected, the sub-channel; money totals are grouped by currency. Statement and external disbursement references are visible with their histories.

## Identity and boundary

The HTTP server derives the actor and roles from its bearer-token principal, not from request fields or the UI role selector. A partner token has `partner:<PARTNER-ID>` plus one or more of `partner-agent`, `partner-supervisor`, `partner-manager`, `partner-senior-manager` or `partner-viewer`. Optional `subchannel:<CODE>` claims narrow access further. Partner principals may only use partner-portal endpoints and health, and partner-scoped requests are checked server-side against the filed channel, partner and sub-channel. A partner may link an existing unattributed journey only when its creator is the authenticated principal; an insurer can attribute one on the partner's behalf. Internal work needs `admin`, `partner-insurer`, `partner-underwriter`, or `partner-finance`, according to the operation. Demo/offline mode is openly unauthenticated; actor names there are simulations.

## Alternatives considered

- Three sequential approvals: rejected because the request calls for any available authorized level to decide, not all three.
- A separate parallel quote/policy engine: rejected because it would drift from existing signature, underwriting and payment gates.
- Partner-provided commission totals as the source of truth: rejected; the recorded expectation is derived from filed schedules and compared to a separately supplied insurer statement.
- Automatic payout or direct endorsement/claim mutation: rejected because there is no bank integration, durable transactional store or named finance/claims authority in this demo.

## Contract and limitations

The `/api/partner-portal/*` routes share the existing in-memory runtime and `/api` transport rules. Every row and audit event disappears on restart/reset; the reporting-store replay does **not** include this workspace. The portal is a working prototype, not a production multi-tenant boundary, durable queue, external notification system, bank integration, claims settlement service or regulatory approval. Production use requires durable transactions/outbox and immutable audit, verified identity/provisioning and tenant isolation, independently reviewed authority and financial controls, secure document storage/consent, insurer and banking integrations, and named human approval for money-related controls under `AGENTS.md`. Do not treat a reference record as proof that external work or payment occurred.

## Verification

The endpoint and payload contract is published as [`partner-portal.openapi.json`](partner-portal.openapi.json). A contract test checks it against the registered route catalogue and validates representative request/response shapes.

See `src/core/partner-portal.test.ts` and `src/server/partner-portal.test.ts` for workflow and HTTP authorization evidence. After building the UI and server and installing Playwright Chromium, `npm run test:e2e:partner` checks login, sub-channel selection, editor, review, commission, requests, reporting, mobile navigation and the standalone offline workspace in a browser. The UI review/commission rows are test fixtures; the domain test exercises a real signed-and-issued journey. These are automated checks, not an independent verifier or named human approval for live financial operations.
