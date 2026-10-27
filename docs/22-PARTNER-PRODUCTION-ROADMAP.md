# Partner workspace: production-readiness roadmap

## Current status

The omni-channel partner workspace is an **in-memory prototype**, not an approved production service. At the requester's direction it is being merged while named human approval and independent verifier evidence for the underwriting, commission and regulatory controls remain outstanding. This is not a claim that those reviews occurred, and merging does not authorize live customer transactions.

The items below remain open before production use. They are not scheduled, assigned or approved by this document.

## Open work

1. **Independent review and approvals.** Obtain a named human approval and an independent verifier's documented rerun of the high-risk underwriting and commission controls. Include legal, regulatory and actuarial review of filed rates, conditional-quote disclosures, authority limits, changed terms and the customer journey in each supported market. Resolve findings before enabling live operations.
2. **Verified customer acceptance.** Replace operator-entered names and generated signature references with authenticated, auditable electronic signing. Preserve the exact original and revised documents, their fingerprints, consent, signer identity and evidence of delivery; require a fresh verified acceptance whenever final terms change. Do not collect payment or issue cover on an unaccepted offer.
3. **Reliable communications.** Add a real insurer/customer messaging and document-delivery integration with consent, delivery status, retries and an auditable trail. A prepared email or workspace message is not proof of receipt.
4. **Durability and security.** Persist applications, decisions, quotations, commission and service requests transactionally; implement immutable, replayable audit, idempotency and recovery. Add production identity and provisioning, tenant/sub-channel isolation, least-privilege access, medical-data protection, retention and independent security testing.
5. **Underwriting and terms coverage.** Independently verify that all applicable premium, loading, exclusion and other conditions are represented and reconciled. Provide an authorized path for conditions the current engine cannot express, with fresh customer acceptance when necessary; preserve independent insurer review and referral/reinsurance gates.
6. **Financial and servicing integrations.** Integrate approved commission accrual, reconciliation, settlement and disbursement processes with authoritative ledgers and banking controls. Connect policy endorsements, claims and settlements to authorized insurer systems with appropriate approval, reconciliation and audit. Current entries and conversations are references only; they do not transfer funds or perform those operations.
7. **Operational assurance.** Expand end-to-end, failure/recovery, authorization, cross-channel, privacy and reconciliation tests against production-like integrations; establish monitoring, incident response, ownership, rollout and rollback procedures.

## Release gate

Do not use the prototype for actual payments, cover, claims settlement or policy changes until the outstanding controls are implemented and their evidence, independent verification and required named human approvals are recorded. Automated tests and the decision to merge are not substitutes for those approvals.
