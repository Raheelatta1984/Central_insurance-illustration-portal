# Illustrative policy rule samples

`src/core/demo-policy-rule-scenarios.ts` contains disabled, **unapproved, demo-only** global
rule samples derived from `DEFAULT_CHARGES` in `src/core/unitlinked.ts`. They are not registered
with the active rule engine, are not an approval and must not be used to post money. They cover
allocation (500 bps of gross premium), administration (2,500 minor units per month in the
two-decimal-currency demonstration) and mortality (0.9 per 1,000 of sum assured monthly). These
are examples from the demo, not recommendations for production or a guarantee that a particular
product's contract permits these charges. The synthetic distribution scope has no connection to a
real or seeded policy. The fixtures may be adjusted for tests without changing customer holdings.

The demo contains an accounting event for `UL-000123` with a broker, channel and sub-channel in
`src/core/demo.ts`. That event is a seeded transaction example, not proof of the original policy
sale's distribution attribution. The policy ID itself also does not encode distribution. Do not
backfill these fields from the event or ID. Existing exact journey links can be examined using
`ErpManager.backfillPolicyDistribution`; missing or conflicting attribution remains flagged. That
method and its audit log are in-memory only, not a durable migration.

The planning resolver and anniversary calendar are not integrated with a financial scheduler.
The P1 configuration request draft is not automatically submitted, and high-level deductions
remain blocked. Real rules, provenance, durable processing, independent verification and the
repository's named-human approval gate remain required before financial release.
