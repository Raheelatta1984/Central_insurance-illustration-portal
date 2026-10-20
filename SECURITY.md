# Security policy

## Reporting a vulnerability

Please report security issues privately via GitHub's "Report a vulnerability" (Security
Advisories) on this repository. Do not open a public issue for a vulnerability. We aim to
acknowledge within 3 working days.

## Deployment posture (read before exposing this server)

- The server is an **in-memory demo world** unless you have wired durable storage (see
  `docs/14-REVIEW-REMEDIATION.md`). State does not survive a restart.
- Without `PORTAL_AUTH_TOKENS` (or `PORTAL_API_TOKEN`) the API runs in **open demo mode**.
  With `NODE_ENV=production` it refuses to start that way unless `PORTAL_ALLOW_DEMO=1`.
- Set `PII_VAULT_SECRET` from your KMS/secret store; production refuses the public demo
  secret. Masked exports made with the demo secret must be treated as reversible.
- Terminate TLS in front of the process; tokens are Bearer credentials.
- Customer-facing tokens (quotation buy links) are CSPRNG values; snapshot seals are SHA-256
  fingerprints, not signatures — sign exports/snapshots with your key service if you need
  non-repudiation.
