# 31 — Render live operations and Pages publishing

## Authority and hosting decision

Raheel Atta (`Raheelatta1984`) authorized live financial operations and instructed the work to continue
through configuration, source and provider wiring rather than adding review gates. The live deployment
target is **Render**. Vercel is intentionally out of scope for this change.

The static offline demo and the live financial API are different artifacts:

- the static demo is published by the GitHub Pages workflow;
- the live API/financial book runs as one Node process on Render with PostgreSQL.

## Render blueprint

[`render.yaml`](../render.yaml) declares:

- one `web` service, `npm ci && npm run build`, `npm start`, health check `/api/health`;
- one PostgreSQL 16 database;
- `FINANCE_DATABASE_URL` and `FINANCE_MIGRATION_DATABASE_URL` injected from the database;
- `FINANCE_ENVIRONMENT=live`, `FINANCE_APPROVER_NAME=Raheel Atta`, scheduler enabled;
- a pre-deploy command `npm run finance:bootstrap`;
- secrets declared with `sync: false` so Render prompts for them and they never enter Git.

`finance:bootstrap` is idempotent: it applies explicit migrations, initializes an empty live book only
when no book exists, and refuses to overwrite an existing book or change its environment. It never seeds
rates, policies, NAVs, approvals or demo data.

## Provider and source adapters

The runtime now wires environment-configured adapters into the durable financial service:

| Environment | Purpose | Contract |
| --- | --- | --- |
| `FINANCE_PAYMENT_VERIFIER_URL` + `_TOKEN` | authoritative cash verification | `POST` payment evidence; returns the same `provider`, `reference`, `amountMinor`, `currency`, `policyId` plus `verifiedAt` |
| `FINANCE_CARD_PROVIDER_URL` + `_TOKEN` | token/mandate and round-up collection verification | `POST {base}/verify-token` and `POST {base}/verify-collection`; returns `verifiedAt` |
| `FINANCE_SOURCE_READER_URL` + `_TOKEN` | authoritative legacy distribution source | `GET ?sourceRecordId=…&policyId=…`; returns the exact source record or `404` when missing |
| `FINANCE_PROVIDER_TIMEOUT_MS` | provider timeout | 1–60000 ms, default 10000 |

Adapters require HTTPS except loopback HTTP for tests, send bearer auth and an idempotency key, fail
closed on non-2xx/invalid payloads/timeouts, and never accept raw PAN/CVV. If an adapter is not
configured, the corresponding live money path remains refused; there is no demo fallback.

## GitHub Pages fix

The failed Pages runs used `actions/configure-pages` with `enablement: true`. The workflow token can
deploy to an existing Pages site but cannot create the site, producing:

```text
Get Pages site failed: Not Found
Create Pages site failed: Resource not accessible by integration
```

The workflow now preflights the Pages API, removes the forbidden auto-create attempt, assembles the site
with `tools/demo-site.mjs`, and publishes after pushes or successful What's New runs. If Pages has not
been enabled yet it records a warning and skips instead of leaving `main` red. The one-time repository
setting is **Settings → Pages → Build and deployment → Source: GitHub Actions**.

## Configuration work that continues

Issue #47 remains the configuration request for authorized effective-dated charge rules and the
authoritative legacy distribution source. The live book can be deployed and initialized now; charge
rules are filed through `/finance/rules/propose` and approved through `/finance/rules/approve` by the
designated approver. Source backfill uses the configured source reader. No illustrative rate is promoted
to a live rule.
