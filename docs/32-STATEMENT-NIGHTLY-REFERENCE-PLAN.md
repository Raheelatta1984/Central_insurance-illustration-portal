# Statement, nightly processing and reference IDs — work in progress

The statement's movement filter is shared by its movement summary and table. Movement totals add displayed transaction legs with exact currency minor units; they are not premium receipts or closing balances. Switches have two legs, so their gross volume can be counted twice. Unit totals across funds are not fungible. Closing policy balances remain unfiltered and are identified as such.

## Remaining financial design

The existing durable payments endpoint verifies a payment and invests it immediately. The existing scheduler catches up monthly deductions, but does not hold payments for a nightly investment run or enforce 02:00 policy-local. Changing only its timer would not implement the requested processing order. A durable verified-payment queue, atomic consumption, replay protection, migration/compatibility for existing checksummed state, per-policy local 02:00 cutoffs, and recovery of prior due cycles must be designed and tested together before changing live payment behavior. Charges and prices must continue to come from approved configuration and recorded NAVs, never invented defaults. Demo simulation must remain distinguishable from live processing.

## Remaining reference-ID design

The security surface catalogue provides a tab/section/subsection inventory. A persistent explicit mapping is needed so IDs are not renumbered when entries are inserted; badges and a searchable directory should use the same registry. Coverage must be tested against the catalogue and any UI areas outside it.
