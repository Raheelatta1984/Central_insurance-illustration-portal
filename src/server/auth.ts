/**
 * Authentication & authorisation for the HTTP layer.
 *
 * Before this module existed, every governance gate in the domain (claims authority caps,
 * "an AI may never decline", the actuary/Shariah/board surplus approvals) was checked against
 * `by` / `role` / `isAi` strings the caller put in the request body — the caller graded their
 * own homework, and `POST /reset` wiped the world for anyone who could reach the port.
 *
 * Model, deliberately small (a deployment fronts this with its IdP/SSO and maps identities to
 * tokens here, or replaces this module with JWT verification against its issuer):
 *  - A **principal** `{ name, roles[] }` is derived server-side from a Bearer token. The audit
 *    actor (`by`) is then stamped from the principal, never trusted from the body.
 *  - **Auth is configured by environment**: `PORTAL_AUTH_TOKENS` (preferred) or a single
 *    `PORTAL_API_TOKEN`. With neither set the server runs in **demo mode** — open, loudly
 *    labelled in `/health` and at boot. `NODE_ENV=production` refuses demo mode unless
 *    `PORTAL_ALLOW_DEMO=1` is also set (see `assertProductionSafe` in main.ts).
 *  - **Authorisation** is a short, explicit table for the routes that move money or grant
 *    approvals. Everything else needs any authenticated principal.
 *
 * Token format for `PORTAL_AUTH_TOKENS`: `token=name:role1,role2;token2=name:role`
 * e.g. `s3cr3t…=alice@insurer:admin;tok…=claims-bot:claims-officer,ai-straight-through`.
 * Tokens are compared by SHA-256 digest with a constant-work comparison.
 */
import { IncomingMessage } from 'node:http';
import { sha256Hex, timingSafeEqualHex } from '../core/hash.js';

export interface Principal {
  readonly name: string;
  readonly roles: readonly string[];
}

export interface AuthConfig {
  readonly enabled: boolean;
  /** token digest (sha256 hex) -> principal */
  readonly principals: ReadonlyMap<string, Principal>;
}

export const DEMO_PRINCIPAL: Principal = { name: 'demo-operator', roles: ['admin'] };

function parseTokens(spec: string): Map<string, Principal> {
  const out = new Map<string, Principal>();
  for (const entry of spec.split(';')) {
    const trimmed = entry.trim();
    if (!trimmed) continue;
    const eq = trimmed.indexOf('=');
    if (eq < 1) throw new Error(`PORTAL_AUTH_TOKENS entry "${trimmed.slice(0, 12)}…" is not token=name:roles`);
    const token = trimmed.slice(0, eq).trim();
    const rest = trimmed.slice(eq + 1);
    const colon = rest.indexOf(':');
    const name = (colon >= 0 ? rest.slice(0, colon) : rest).trim();
    const roles = (colon >= 0 ? rest.slice(colon + 1) : 'operator').split(',').map((r) => r.trim()).filter(Boolean);
    if (!token || !name || roles.length === 0) throw new Error(`PORTAL_AUTH_TOKENS entry for "${name || '?'}" needs a token, a name and at least one role`);
    out.set(sha256Hex(token), { name, roles });
  }
  return out;
}

export function loadAuthConfig(env: NodeJS.ProcessEnv = process.env): AuthConfig {
  const multi = env['PORTAL_AUTH_TOKENS']?.trim();
  if (multi) return { enabled: true, principals: parseTokens(multi) };
  const single = env['PORTAL_API_TOKEN']?.trim();
  if (single) {
    return { enabled: true, principals: new Map([[sha256Hex(single), { name: 'api-operator', roles: ['admin'] }]]) };
  }
  return { enabled: false, principals: new Map() };
}

/** The principal for this request, or `undefined` when auth is on and no valid token arrived. */
export function authenticate(config: AuthConfig, req: IncomingMessage): Principal | undefined {
  if (!config.enabled) return DEMO_PRINCIPAL;
  const header = req.headers['authorization'];
  const value = Array.isArray(header) ? header[0] : header;
  const match = value ? /^Bearer\s+(.+)$/i.exec(value.trim()) : null;
  if (!match) return undefined;
  const digest = sha256Hex(match[1]!.trim());
  for (const [known, principal] of config.principals) {
    if (timingSafeEqualHex(known, digest)) return principal;
  }
  return undefined;
}

const CLAIMS_ROLES = [
  'claims-officer', 'claims-manager', 'claim-officer', 'claim-manager',
  'settlement-officer', 'settlement-manager',
  'head-of-claims', 'chief-claims-officer', 'ai-straight-through',
];

function has(principal: Principal, roles: readonly string[]): boolean {
  return principal.roles.includes('admin') || principal.roles.includes('administration') || roles.some((r) => principal.roles.includes(r));
}

/**
 * Authorise one call. Returns `null` when allowed, else the refusal sentence (HTTP 403).
 * Only consulted when auth is enabled; demo mode is open by definition and says so.
 */
export function authorize(
  principal: Principal,
  method: string,
  path: string,
  payload: Record<string, unknown>,
): string | null {
  if (method === 'GET' || method === 'OPTIONS') return null;
  if (path === '/reset' && !principal.roles.includes('admin') && !principal.roles.includes('administration')) {
    return 'resetting the world requires an admin principal';
  }
  if (path.startsWith('/master/') && !has(principal, ['master-admin', 'configurator', 'fund-configuration'])) {
    return 'master settings require a master-admin, configurator or admin principal';
  }
  if (path.startsWith('/claims/')) {
    if (!has(principal, CLAIMS_ROLES)) return 'claims decisions require a claims authority role';
    const claimed = typeof payload['role'] === 'string' ? payload['role'] : undefined;
    if (claimed && !has(principal, [claimed])) {
      return `principal ${principal.name} may not act with role ${claimed}`;
    }
  }
  if (path === '/takaful/approve') {
    const gate = typeof payload['role'] === 'string' ? payload['role'] : 'actuary';
    if (!has(principal, [gate])) return `the ${gate} gate must be signed by a principal holding the ${gate} role`;
  }
  if (path === '/takaful/distribute' && !has(principal, ['board'])) {
    return 'distributing takaful surplus requires a board (or admin) principal';
  }
  if (path === '/ai/approve' && !has(principal, ['ai-governor', 'underwriter', 'underwriter-manager', 'claims-manager', 'claim-manager', 'supervisor'])) {
    return 'approving an AI action requires an ai-governor/underwriter/claims-manager (or admin) principal';
  }
  return null;
}

/**
 * CORS: an explicit allowlist from `PORTAL_CORS_ORIGIN` (comma-separated, or `*`). Unset, demo
 * mode allows `*` (local consoles), but an authenticated deployment allows no cross-origin
 * callers by default — the console is served same-origin by this process anyway.
 */
export function corsOriginFor(config: AuthConfig, reqOrigin: string | undefined, env: NodeJS.ProcessEnv = process.env): string | undefined {
  const spec = env['PORTAL_CORS_ORIGIN']?.trim();
  if (!spec) return config.enabled ? undefined : '*';
  if (spec === '*') return '*';
  const allowed = spec.split(',').map((s) => s.trim()).filter(Boolean);
  return reqOrigin && allowed.includes(reqOrigin) ? reqOrigin : undefined;
}
