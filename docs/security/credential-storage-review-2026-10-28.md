# Credential storage review — 2026-10-28

Scope: one vulnerability class, end to end — **credentials readable by JavaScript**, plus the
controls that make that attack possible or survivable (XSS sinks, cookie attributes, CORS/CSRF,
CSP and security headers, exposed tooling, supply chain).

Repository: `Raheelatta1984/Central_insurance-illustration-portal` · default branch `main`
Method: static review with `path:line` evidence, plus probes over a real socket
(`createPortalServer` started locally, see *Verification evidence*).

---

## 1. Applicability verdict

| Tier | Verdict | Why |
| --- | --- | --- |
| **A — credential exposure** | **APPLICABLE** | The console keeps an operator's access token in `sessionStorage`/`localStorage` and rebuilds an `Authorization: Bearer` header from it on every call (F1). Any XSS — or one compromised front-end dependency, since the whole UI is one 2.2 MB bundle — reads it and ships it elsewhere. The token is a static, long-lived, non-revocable secret from `PORTAL_AUTH_TOKENS`, so theft is permanent until the operator rotates it for everyone. |
| **B — defence in depth** | **APPLICABLE** | The process serves HTML and a JSON API on one port. It sends `x-content-type-options` and `referrer-policy` only (F4): no CSP, no `X-Frame-Options`, no `Permissions-Policy`, no HSTS. The static demo site sends two headers (F6). |
| **C — supply chain + regression guards** | **APPLICABLE** | Dependencies exist, a lockfile is committed and CI uses `npm ci` (good), but every GitHub Action is pinned by mutable tag (F7), there is no dependency-audit step and no regression guard that would stop F1 coming back (F8). |

Not a fork; `gh` authenticated; working tree clean at start; baseline checks green (§6).

---

## 2. Findings

| # | Severity | Finding | Evidence | Recommended action | Tier |
| --- | --- | --- | --- | --- | --- |
| F1 | **High** | The operator's access token is written to `sessionStorage` and read back from `sessionStorage`/`localStorage` to build `Authorization: Bearer …`. Script-readable ⇒ XSS/stolen-dependency exfiltration, and the token never expires server-side. | `src/ui/partner-portal.tsx:200` (write), `src/ui/api.ts:19` (read), `tools/partner-portal-e2e.mjs:98,112` (the e2e seeds it the same way) | Exchange the token once for an opaque server-side session in an `HttpOnly` cookie; delete the legacy key from every browser that has one. | A |
| F2 | High | No cookie authentication exists at all: `authenticate()` parses `authorization` and nothing else; `Set-Cookie` appears nowhere in the repository. Every browser call carries a bearer credential in JS. | `src/server/auth.ts:69-80`; `grep -rn 'Set-Cookie\|set_cookie\|res.cookie' src` → no matches | Add a `SessionStore` + `POST/DELETE /api/session`, cookie `HttpOnly; Secure; SameSite=Lax; Path=/`, `__Host-` prefixed when Secure. Keep `Authorization: Bearer` for non-browser clients. | A |
| F3 | Medium | Once a cookie authenticates requests, CSRF becomes possible; today the only CSRF defence is incidental (a custom header needs a CORS preflight, and an authenticated deployment allows no cross-origin callers). There is no Origin/Referer check anywhere. | `src/server/auth.ts:73` (header required); `src/server/auth.ts:156-162` (CORS closed when authenticated) | Add an Origin (fallback Referer) allowlist check on unsafe methods for cookie-authenticated requests — in addition to `SameSite=Lax`, not instead of it. | A |
| F4 | Medium | No `Content-Security-Policy`, no `X-Frame-Options`/`frame-ancestors` (the console can be framed ⇒ clickjacking on money-moving buttons), no `Permissions-Policy`, no HSTS. | `src/server/main.ts:93-98` (the only two security headers) | Send them centrally from `sendBuffer()`; enforce a strict CSP (the built `dist/index.html` has no inline script — `dist/index.html` after `npm run build`). | B |
| F5 | Low | `corsOriginFor()` returns `*` in demo mode. Harmless *today* because no credential travels automatically (no cookies, no `credentials: include`), but it is one careless `Access-Control-Allow-Credentials` away from being critical, and any future cookie mode must never see `*`. | `src/server/auth.ts:158` | Keep demo behaviour; refuse to emit `*` when a session cookie authenticated the call, and document the invariant. | B |
| F6 | Low | `vercel.json` (the public demo site) sends only `nosniff` + `referrer-policy`; no framing protection, no CSP, no `Permissions-Policy`. | `vercel.json:20-28` | Add the safe CSP subset + `X-Frame-Options` + `Permissions-Policy`. The offline bundle inlines its own script (`demo/offline.html` — 3 `<script>` tags incl. a 2.1 MB inlined bundle), so a strict `script-src` cannot be enforced there without build-time hashes; recorded as a follow-up. | B |
| F7 | Medium | Every GitHub Action is pinned by mutable tag, not commit SHA — a hijacked tag runs unreviewed code with `contents: write` in `whats-new.yml`. | `.github/workflows/ci.yml:10,11,46,47`; `pages.yml:31,50,54,66`; `whats-new.yml:47,53` | Pin to 40-char SHAs with a `# vX.Y.Z` comment. | C |
| F8 | Low | CI runs no dependency audit and no regression guard for credentials in web storage. | `.github/workflows/ci.yml` (no `audit` step); `grep -rni 'audit\|osv\|snyk' .github/workflows` → no matches | Add `tools/security-audit.mjs` (fails on High/Critical, with an allowlist) and `tools/security-guard.mjs` (storage-token guard) to CI. | C |
| F9 | Info | XSS sinks: none in application code. No `innerHTML`, `outerHTML`, `insertAdjacentHTML`, `document.write`, `dangerouslySetInnerHTML`, `eval`, `new Function`, `javascript:` and no `\|safe`/`html_safe`/`{{{`. The only `innerHTML` is a build-time progress bar in `tools/offline-build.mjs:184` (no user data). Escaping is **structural** (React text nodes), not per-call-site discipline — the right shape. | scans in §5 | No change. CSP is still added, because structural escaping is only as strong as the next contributor's `dangerouslySetInnerHTML`. | B |
| F10 | Info | `Cache-Control: no-store` is already set on every API/JSON response, including file exports; API responses carry `x-request-id`. | `src/server/main.ts:124` | No change. | B |
| F11 | Info | No `.env` file is tracked; `package-lock.json` is committed; CI installs with `npm ci`; Dependabot exists for npm **and** github-actions. | `git ls-files \| grep -iE '(^\|/)\.env'` → none; `.github/dependabot.yml` | No change. | C |
| F12 | Info | Tokens are compared by SHA-256 digest with a constant-work comparison, and the audit actor is stamped server-side from the principal, never from the body. | `src/server/auth.ts:53,75-79`; `src/server/main.ts:274` | No change. | A |
| F13 | Info | `npm audit --audit-level=high` at baseline: **0 vulnerabilities** (all dependencies, and `--omit=dev`). | §6 | Keep it that way with a CI gate. | C |

### What was searched for and found *not* to apply

* **AsyncStorage / React Native** — no match; this is a browser build (`vite.config.ts`, `src/ui`).
* **IndexedDB / localforage / idb-keyval** — no match.
* **`document.cookie` writes / `js-cookie` / `universal-cookie`** — no match. Cookies are set by the server (after this change) only.
* **Vendor auth SDKs** (Auth0/Firebase/Supabase/MSAL/NextAuth/Clerk) — none present; hand-rolled auth in `src/server/auth.ts`.
* **JWT libraries** — none (`jsonwebtoken`, `jose`, `pyjwt` … no match). Tokens are opaque shared secrets, not JWTs, so there is no `alg` confusion, `exp` or audience claim to verify. **Follow-up:** a static token has no expiry and no per-session revocation; the session layer added here gives the *browser* a revocable, expiring handle, but a leaked `PORTAL_AUTH_TOKENS` value can still mint new sessions until it is rotated. Replacing the token file with a real IdP or short-lived signed tokens is the documented next step.
* **Persisted-state libraries / `__INITIAL_STATE__` blobs** — no match.
* **Exposed tooling** (`/docs`, `/swagger`, `/graphql`, `DEBUG=True`, source maps) — none. There is no OpenAPI UI route; `docs/API-REFERENCE.md` is a static markdown file. `vite build` sets `sourcemap: false` (`vite.config.ts`).
* **Tokens in URLs** — the only `?token=` is a *customer quotation buy-link* minted by the domain core (`src/core/journeydesk.ts:841`, `src/core/routes.ts:3367`), a CSPRNG value that is not an operator credential and is deliberately per-quotation. It is not in this vulnerability class, but it is a capability in a URL: it lands in referrers, logs and mail. Recorded as a follow-up (single-use, short TTL, `Referrer-Policy` already mitigates).
* **Third-party CDN scripts / SRI** — no `<script src="https://…">` in application code, so SRI is not applicable. Nothing to self-host.

---

## 3. Plan

### Tier A — move the browser credential out of script-readable storage

Design (same-origin UI + API in one process, so an opaque session cookie is the right primitive):

1. **Server** (`src/server/auth.ts`)
   * `SessionStore` — in-memory `Map<sha256(sessionId) → { principal, expiresAt }>`, 12 h TTL,
     capped at 500 live sessions (sweeps expired entries on issue), `issue`/`resolve`/`revoke`.
     The store is the session's authority: deleting an entry ends the session everywhere.
   * `authenticate()` keeps `Authorization: Bearer …` (machine clients: scripts, the fleet
     simulator, mobile/API consumers — unchanged contract) and adds the cookie as a second path,
     reporting which one was used (`via: 'bearer' | 'cookie' | 'demo'`).
   * Cookie: `__Host-portal_session` (`portal_session` only when `PORTAL_INSECURE_COOKIES=1` for
     plain-HTTP LAN dev), `HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=43200`. No `Domain`
     (the `__Host-` invariant). `SameSite=Lax`, not `Strict`: the portal is linked from external
     systems and `Strict` would drop the session on arrival.
2. **Endpoints** (server layer, `src/server/main.ts`, so the domain dispatcher, the route catalogue,
   the Bloom gate and `docs/API-REFERENCE.md` are untouched):
   * `POST /api/session` `{ token }` → verified against `PORTAL_AUTH_TOKENS`/`PORTAL_API_TOKEN`
     exactly as a Bearer token is; issues a session and sets the cookie. `401` on a bad token,
     `400` in open demo mode (there is nothing to sign in with).
   * `DELETE /api/session` → revokes the server-side session **and** clears the cookie with the
     identical name/attributes (`Max-Age=0`).
   * Both are rate-limited by the existing request guard (it runs before them).
3. **CSRF** (`src/server/security.ts`) — for unsafe methods on a **cookie-authenticated** request,
   `Origin` (fallback `Referer`) must match the request `Host` or an entry in `PORTAL_CORS_ORIGIN`;
   otherwise `403`. `Origin: null` is refused. No header at all ⇒ allowed (non-browser clients).
   This is *in addition to* `SameSite=Lax`, and the existing mandatory custom header stays, so a
   Bearer call keeps its incidental preflight protection.
4. **Browser**
   * `src/ui/api.ts` — stop reading the token; purge `portal-api-token` from `sessionStorage` **and**
     `localStorage` once on load (destroys the copy already sitting in users' browsers);
     `credentials: 'same-origin'` (never `include`, and never with `Access-Control-Allow-Origin: *`);
     `ApiError` carries `status` so a `401` returns the operator to the sign-in form.
   * `src/ui/partner-portal.tsx` — the token form now exchanges the token for a session instead of
     storing it; a "Sign out" control ends the session.
   * The `x-portal-role` header keeps coming from `localStorage`: it is a role *selector*, not a
     credential, and the server never trusts it as an identity (the actor comes from the session).
5. **Legacy grace**: `LEGACY_TOKEN_GRACE_DAYS=0` for the browser path — cutover, no `Authorization`
   header is sent by the UI any more. Non-browser clients keep Bearer permanently (documented API
   contract, not a grace period). Users who had a token in storage are signed out once.

### Tier B — defence in depth

* `src/server/security.ts` — one `securityHeaders(req, env)` used by `sendBuffer()`, so **every**
  response (HTML, JS, CSS, JSON) carries: `Content-Security-Policy`, `X-Content-Type-Options`,
  `Referrer-Policy`, `X-Frame-Options: DENY`, `Permissions-Policy`, and `Strict-Transport-Security`
  **only** when the request arrived over HTTPS (never on plain HTTP/localhost).
* CSP (enforced, `CSP_MODE=auto` → strict, because §5 found no inline script, no inline handler and
  no eval-style code, and every external origin is a non-existent one):
  `default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:;
  font-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none';
  form-action 'self'` + `upgrade-insecure-requests` in production.
  `'unsafe-inline'` is confined to `style-src` because the console sets React `style={}` attributes
  throughout; **never** in `script-src`.
* `vercel.json` — the safe CSP subset (`frame-ancestors`, `object-src`, `base-uri`, `form-action`)
  plus `X-Frame-Options`, `Permissions-Policy`, `nosniff`, `Referrer-Policy` for the static demo.

### Tier C — supply chain and regression guards

* `tools/security-guard.mjs` — fails when a credential-shaped key is read from or written to
  `localStorage`/`sessionStorage` in `src/`; allowlist `.security-storage-allowlist` (empty today).
* `tools/security-audit.mjs` — runs `npm audit --json`, fails on High/Critical unless the package is
  listed in `.security-audit-allowlist` with a reason.
* CI: both as steps, plus `npm audit` signal; Actions pinned to 40-char SHAs.
* Tests (`src/server/security.test.ts`) over a real socket: headers on `/` and `/api/health`; cookie
  attributes on the login response; cookie-only authentication; foreign `Origin` on an unsafe method
  ⇒ 403; same-origin ⇒ allowed; logout revokes + clears; bad token ⇒ 401 and no cookie; Bearer still
  works; the CSP contains `script-src 'self'` and no `unsafe-inline` in `script-src`.

### Deferred (recorded, not silently dropped)

1. **Strict `script-src` on the static demo** (`demo/offline.html` inlines its bundle) — needs
   build-time `sha256` emission from `tools/offline-build.mjs`; the demo is a read-only replay with
   no credentials, so the framing/object/base/form subset is shipped now.
2. **GitHub Pages cannot set response headers** (no `_headers`/`netlify.toml` support on Pages), so
   the Pages deployment gets no CSP. Vercel, the deployed site, does.
3. **Static bearer tokens have no expiry/rotation** — the browser no longer holds them, but a real
   IdP (or short-lived signed tokens with `iss`/`aud`/`exp`) remains the correct end state.
4. **Customer buy-links carry a capability in a URL** — out of this vulnerability class; needs a
   single-use/short-TTL review of its own.

---

## 4. Risk register for the change itself

| Risk | Mitigation |
| --- | --- |
| Cookie replaces header ⇒ new CSRF surface | `SameSite=Lax` **and** Origin/Referer check on unsafe methods, both tested against `Origin: https://evil.example`. |
| `Secure` cookie breaks local HTTP dev | Browsers treat `http://localhost` as a secure context and accept `Secure` (and `__Host-`) cookies; `PORTAL_INSECURE_COOKIES=1` exists for a plain-HTTP LAN deployment and is documented in `SECURITY.md`. |
| Enforced CSP breaks the console | Policy derived from the built `dist/index.html` (no inline script) and from a scan that found no external origin, no `eval` and no inline handler; verified against the built artefact in §6. |
| Machine clients break | Bearer is untouched and still tested (`main.test.ts` + `security.test.ts`). |
| e2e browser test breaks | `tools/partner-portal-e2e.mjs` signs in through the form instead of seeding `sessionStorage` (same coverage, new path). |

---

## 5. Discovery output (trimmed)

```
### web-storage credential writes/reads   (src/, tools/, .github/)
src/ui/api.ts:19                 win.sessionStorage?.getItem('portal-api-token') ?? …
src/ui/partner-portal.tsx:200    window.sessionStorage.setItem('portal-api-token', token)
tools/partner-portal-e2e.mjs:98  addInitScript(() => sessionStorage.setItem('portal-api-token','finance'))
tools/partner-portal-e2e.mjs:112 addInitScript(() => sessionStorage.setItem('portal-api-token','service'))
### cookie set sites                      (no matches)
### credentialed CORS                    (no matches)
### CORS config
src/server/main.ts:126,362        access-control-allow-origin (from corsOriginFor)
src/server/auth.ts:156-162        PORTAL_CORS_ORIGIN, '*' only when auth is disabled
### CSRF defences                        none (no Origin/Referer check; SameSite not used)
### DOM sinks                            none (only tools/offline-build.mjs:184, build-time)
### code-execution sinks                 none
### server-template raw output           none
### security header mechanisms
src/server/main.ts:93-98          x-content-type-options, referrer-policy (only)
vercel.json:20-28                 X-Content-Type-Options, Referrer-Policy (only)
### inline scripts / handlers / styles  src/ui/index.html: no inline <script>; React style={} attributes present
### third-party script origins          none in application code
### env files tracked                   none
### lockfiles tracked                   package-lock.json
### actions pinned by tag              ci.yml:10,11,46,47 · pages.yml:31,50,54,66 · whats-new.yml:47,53
### actions pinned by SHA              (none)
```

---

## 6. Verification evidence

### 6.1 Baseline (before any edit)

| Check | Baseline | After |
| --- | --- | --- |
| `npm run typecheck` | pass | **pass** |
| `npm run lint` | 0 errors, 82 warnings | **0 errors, 82 warnings** (no new warning) |
| `npm run test:coverage` | 88 files / 1055 tests pass, lines 89.96 % | **89 files / 1072 tests pass, lines 90.13 %** |
| `npm run build` | pass; `git status` clean (artefacts in sync) | **pass; `demo/` regenerated and committed, idempotent on re-run (identical md5)** |
| `npm audit --audit-level=high` | 0 vulnerabilities | **0 vulnerabilities** |

No test was disabled, skipped or loosened; the coverage floors in `vitest.config.ts` are unchanged and
were cleared by a wider margin than before.

### 6.2 Re-run of the 1.2 scans (the finding itself)

```
$ node tools/security-guard.mjs
security-guard: ok — no credentials in web storage (0 allowlisted exception(s)).

$ grep -rniE '(localStorage|sessionStorage)\.(setItem|getItem)\(' src/
(no matches)
```

The guard was proved to still bite: reintroducing the original line in a scratch file
(`sessionStorage.getItem('portal-api-token')`) made it exit 1 with `FAIL — 1 credential(s) readable by
JavaScript`, while `localStorage.getItem('portal-active-role')` (a role selector, not a secret) was
correctly ignored.

### 6.3 Runtime probe — real process, real socket

`PORTAL_AUTH_TOKENS='admintoken=alice:admin;…' node dist-server/server/main.js`

```
== /                      == /api/health
  ok   content-security-policy: default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; …
  ok   x-content-type-options: nosniff
  ok   referrer-policy: strict-origin-when-cross-origin
  ok   x-frame-options: DENY
  ok   permissions-policy: camera=(), microphone=(), geolocation=(), payment=(), usb=()
  MISS strict-transport-security      <- correct: the request is plain HTTP
  ok   cache-control: no-store (API) / no-cache (shell)

x-forwarded-proto: https  ->  strict-transport-security: max-age=31536000; includeSubDomains
```

### 6.4 Cookie attributes, CSRF probe, session lifecycle

```
POST /api/session {"token":"admintoken"}  -> 200
  set-cookie: __Host-portal_session=b30eed88…; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=43200
  body: {"principal":{"name":"alice","roles":["admin"]},"expiresAt":"2026-10-28T22:54:33.909Z"}   <- no token

GET /api/world with the cookie only            -> 200   (no Authorization header anywhere)
GET /api/world without any credential          -> 401
POST /api/cover/start  Origin: https://evil.example -> 403  {"error":"POST refused: Origin https://evil.example is not this portal"}
POST /api/cover/start  Origin: null                 -> 403
POST /api/cover/start  Origin: http://127.0.0.1:8788 -> 200  (the console still works)
DELETE /api/session    same-origin                  -> 200  set-cookie: __Host-portal_session=; … Max-Age=0; Expires=Thu, 01 Jan 1970
GET  /api/world with the revoked cookie             -> 401  (revoked server-side, not just cleared)
```

With the request guard **on** (the production default) `POST /api/session` answers `200` and carries
`x-ratelimit-limit: 60` — the sign-in route is behind the rate limiter, not in front of it.

### 6.5 Exposed tooling

`/docs /api/docs /swagger /swagger-ui /graphql /__debug__/ /redoc` return either the SPA shell
(`text/html`, one external `<script type="module">`, no inline script) or `401/404` from the API —
there is no Swagger/GraphQL/debug handler in this codebase to gate. `vite build` keeps
`sourcemap: false`, so no source maps ship.

### 6.6 Browser harness

`tools/partner-portal-e2e.mjs` is updated to sign in through the form (a token in `sessionStorage` is
no longer a supported way in). **It was not executed here**: Playwright's browser download is blocked
in this sandbox (`npx playwright install chromium` → `Download failure`), and no harness result is
claimed on its behalf. The flows it covers are covered at the HTTP level by
`src/server/security.test.ts` (17 cases), and the sign-in path itself is exercised end to end by the
runtime probes in §6.4.

### 6.7 Supply chain

```
$ node tools/security-audit.mjs
security-audit: 0 info · 0 low · 0 moderate · 0 high · 0 critical
security-audit: ok — no unaccepted high or critical advisories.

$ grep -rnE 'uses:[[:space:]]*[^@ ]+@v?[0-9]' .github/workflows
(none pinned by tag)
$ grep -rnE 'uses:[[:space:]]*[^@ ]+@[0-9a-f]{40}' .github/workflows | wc -l
10
```

`package-lock.json` remains committed and CI still installs with `npm ci`; Dependabot already covers
both npm and github-actions, so no new `dependabot.yml` entry was needed.
