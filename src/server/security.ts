/**
 * HTTP hardening: the headers every response carries, and the origin check that makes a cookie
 * session safe against cross-site request forgery.
 *
 * Two things this module deliberately does *not* do:
 *  - it never emits `unsafe-inline` in `script-src`. The console's `dist/index.html` contains no
 *    inline script (`npm run build` emits one external module tag), so the strict policy is
 *    enforceable rather than aspirational. `style-src` does allow inline styles because the console
 *    sets React `style={}` attributes throughout — that is a presentation risk, not an execution one.
 *  - it never sends HSTS over plain HTTP. HSTS on a hostname that is not entirely HTTPS (a laptop,
 *    a LAN demo) teaches browsers to refuse the only URL that works.
 *
 * CORS stays where it was (`auth.ts:corsOriginFor`): closed for an authenticated deployment, `*`
 * only in the open demo. That is safe *because* no credential travels automatically — and this
 * module's job is to keep it that way: a request authenticated by the session cookie is
 * origin-checked on every unsafe method, so a permissive `Access-Control-Allow-Origin` can never
 * turn into a cross-site write with the operator's session.
 */
import { IncomingMessage } from 'node:http';

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

function single(value: string | string[] | undefined): string | undefined {
  const first = Array.isArray(value) ? value[0] : value;
  const trimmed = first?.trim();
  return trimmed ? trimmed : undefined;
}

/** Whether this request reached the process over TLS (directly, or via a proxy that says so). */
export function isSecureRequest(req: IncomingMessage): boolean {
  const socket = req.socket as { encrypted?: boolean };
  if (socket.encrypted) return true;
  return single(req.headers['x-forwarded-proto'])?.split(',')[0]?.trim().toLowerCase() === 'https';
}

export function contentSecurityPolicy(env: NodeJS.ProcessEnv = process.env): string {
  const directives = [
    "default-src 'self'",
    "script-src 'self'",
    // React style attributes (and the build's inlined component CSS) need this; never script-src.
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data:",
    "font-src 'self'",
    "connect-src 'self'",
    "object-src 'none'",
    "base-uri 'none'",
    "frame-ancestors 'none'",
    "form-action 'self'",
  ];
  if (env['NODE_ENV'] === 'production') directives.push('upgrade-insecure-requests');
  return directives.join('; ');
}

/**
 * Every response — HTML, JS, CSS and JSON — gets the same baseline, set in one place so a new route
 * cannot forget it. `Referrer-Policy` keeps the customer's quotation buy-link token out of the
 * `Referer` of any outbound navigation.
 */
export function securityHeaders(req: IncomingMessage, env: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const headers: Record<string, string> = {
    'content-security-policy': contentSecurityPolicy(env),
    'x-content-type-options': 'nosniff',
    'referrer-policy': 'strict-origin-when-cross-origin',
    'x-frame-options': 'DENY',
    'permissions-policy': 'camera=(), microphone=(), geolocation=(), payment=(), usb=()',
  };
  if (isSecureRequest(req)) headers['strict-transport-security'] = 'max-age=31536000; includeSubDomains';
  return headers;
}

/**
 * The origins this process answers to: its own `Host`, plus the explicit allowlist in
 * `PORTAL_CORS_ORIGIN`. `*` is never an allowed origin here — a wildcard cannot be the answer to
 * "did this request come from my own page?".
 */
function allowedOrigins(req: IncomingMessage, env: NodeJS.ProcessEnv): Set<string> {
  const origins = new Set<string>();
  for (const host of [single(req.headers['host']), single(req.headers['x-forwarded-host'])?.split(',')[0]?.trim()]) {
    if (!host) continue;
    origins.add(`https://${host}`);
    origins.add(`http://${host}`);
  }
  const spec = env['PORTAL_CORS_ORIGIN']?.trim();
  if (spec && spec !== '*') {
    for (const entry of spec.split(',')) {
      const origin = entry.trim();
      if (origin && origin !== '*') origins.add(origin);
    }
  }
  return origins;
}

/**
 * Refuse an unsafe request that arrived with a session cookie and a foreign origin.
 *
 * Returned as a sentence (or `null` when allowed) so the caller answers 403 with a reason an
 * operator can act on, exactly like `authorize()` does for roles. A request with **no** `Origin`
 * and no `Referer` is allowed: that is a non-browser client that deliberately presented the cookie,
 * and no cross-site form or `fetch` can strip both.
 *
 * This runs *in addition to* `SameSite=Lax`, never instead of it: SameSite is enforced by the
 * browser (and not at all by a client that ignores it), while this check is enforced here.
 */
export function originRefusal(req: IncomingMessage, env: NodeJS.ProcessEnv = process.env): string | null {
  const method = (req.method ?? 'GET').toUpperCase();
  if (SAFE_METHODS.has(method)) return null;
  const allowed = allowedOrigins(req, env);
  const origin = single(req.headers['origin']);
  if (origin !== undefined) {
    if (origin === 'null') return `${method} refused: an opaque (sandboxed or file://) origin may not use a signed-in session`;
    return allowed.has(origin) ? null : `${method} refused: Origin ${origin} is not this portal`;
  }
  const referer = single(req.headers['referer']);
  if (referer) {
    try {
      if (allowed.has(new URL(referer).origin)) return null;
    } catch {
      // fall through to the refusal: an unparseable Referer proves nothing
    }
    return `${method} refused: the Referer does not match this portal`;
  }
  return null;
}
