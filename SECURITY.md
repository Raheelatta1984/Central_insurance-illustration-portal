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

## How a browser authenticates (and why)

A browser never holds the access token. It sends it **once** to `POST /api/session`, which verifies
it exactly as a Bearer token and returns an opaque session id in a cookie:

```
__Host-portal_session=<256-bit random>; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=43200
```

- `HttpOnly` — injected script can drive the session but cannot read, copy or exfiltrate the
  credential. This is why the console must never put a token in `localStorage`/`sessionStorage`;
  `tools/security-guard.mjs` fails CI if anyone does.
- `SameSite=Lax` — not `Strict`: the portal is reached from external links, and `Strict` would
  arrive logged out. Lax alone is **not** a CSRF defence, so every unsafe method on a
  cookie-authenticated request is also checked against its `Origin` (fallback `Referer`) — see
  `src/server/security.ts`. `Origin: null` is refused.
- `__Host-` — Secure, `Path=/`, no `Domain`: a sibling or subdomain host cannot set or overwrite it.
  A plain-HTTP LAN deployment sets `PORTAL_INSECURE_COOKIES=1`, which drops the prefix (`__Host-`
  without `Secure` is discarded by browsers) and keeps the other attributes.
- `DELETE /api/session` revokes the session **server-side** and clears the cookie with the same
  attributes, so signing out ends the session rather than just asking the browser to forget an id
  that would still replay.

Machine clients (scripts, integrations, the fleet simulator) are unchanged: they send
`Authorization: Bearer <token>` and are not subject to the cookie rules, because their credential is
never ambient.

The session store is in memory, like the rest of the demo world: a restart signs every browser out,
and a multi-instance deployment must put the store behind shared storage. Static tokens from
`PORTAL_AUTH_TOKENS` do not expire — rotate them, and treat an IdP (or short-lived signed tokens)
as the correct end state.

## Response headers

Every response carries `Content-Security-Policy` (strict: `'self'` scripts, `'unsafe-inline'` only in
`style-src`), `X-Content-Type-Options: nosniff`, `Referrer-Policy: strict-origin-when-cross-origin`,
`X-Frame-Options: DENY`, `Permissions-Policy`, and `Strict-Transport-Security` **only** when the
request arrived over HTTPS. The static demo (`vercel.json`) sends the framing/object/base/form subset
because `demo/offline.html` inlines its own bundle.

