import { createRuntimeState, dispatchApiRoute, httpStatusForError } from '../core/routes';
import { randomTokenHex } from '../core/hash';

// Never construct or mutate a second world in live mode. Offline mode is explicitly set by the demo.
let localState: ReturnType<typeof createRuntimeState> | undefined;

/**
 * A refused call, with the status kept so the caller can tell "you are not signed in" (401) from
 * "you may not do that" (403) without parsing the message.
 */
export class ApiError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
    this.name = 'ApiError';
  }
}

export interface ApiOptions {
  /**
   * Reuse one idempotency key across the retries of a single user intent (double-click,
   * network retry) so the server replays the first answer instead of applying the change
   * twice. A fresh key is minted per call when not supplied.
   */
  readonly idempotencyKey?: string;
}

const LEGACY_TOKEN_KEY = 'portal-api-token';

/**
 * The access token used to live here, in `sessionStorage`/`localStorage`, and every call rebuilt an
 * `Authorization: Bearer` header from it. Anything that can run script in this page could therefore
 * read a static, non-revocable operator credential and post it somewhere else.
 *
 * It is gone: the token is exchanged once for an `HttpOnly` session cookie (`signIn`) that script
 * cannot read, and every call is authenticated by the browser attaching that cookie. This sweep runs
 * once per load and destroys the copy that is already sitting in existing browsers — a fix that
 * leaves the old value behind has not fixed anything.
 */
function purgeLegacyToken(): void {
  try {
    const win = window as unknown as { localStorage?: Storage; sessionStorage?: Storage };
    win.sessionStorage?.removeItem(LEGACY_TOKEN_KEY);
    win.localStorage?.removeItem(LEGACY_TOKEN_KEY);
  } catch {
    /* storage can be blocked entirely; nothing to purge then */
  }
}
purgeLegacyToken();

/**
 * The only headers a browser session needs. `x-portal-role` is the operator's chosen role in the
 * demo — a selector, not a credential: the server stamps the audit actor from the session and never
 * trusts a role from a header or a body on an authenticated deployment.
 */
function sessionHeaders(win: { localStorage?: { getItem(key: string): string | null } }): Record<string, string> {
  try {
    const headers: Record<string, string> = {};
    const roleId = win.localStorage?.getItem('portal-active-role') ?? win.localStorage?.getItem('portal-active-profile');
    if (roleId) {
      headers['x-portal-role'] = roleId;
      // Kept for servers/clients that still read the old header name.
      headers['x-portal-profile'] = roleId;
    }
    return headers;
  } catch {
    return {};
  }
}

/** Exchange an operator's access token for a server-side session. The token is never stored. */
export async function signIn(token: string): Promise<void> {
  if ((window as unknown as { __OFFLINE__?: unknown }).__OFFLINE__) return;
  await api('/session', 'POST', { token });
}

/** End the session on the server (so the id cannot be replayed) and clear the cookie. */
export async function signOut(): Promise<void> {
  if ((window as unknown as { __OFFLINE__?: unknown }).__OFFLINE__) return;
  await api('/session', 'DELETE');
}

export async function api<T>(path: string, method: 'GET' | 'POST' | 'DELETE' = 'GET', body?: unknown, options: ApiOptions = {}): Promise<T> {
  const win = window as unknown as { __OFFLINE__?: unknown; localStorage?: { getItem(key: string): string | null } };
  if (!win.__OFFLINE__) {
    const res = await fetch(`/api${path}`, {
      method,
      // Same-origin: the session cookie is attached by the browser without exposing it to script.
      // Never `include` — that is for cross-origin calls, and it must never be paired with a
      // wildcard or reflected Access-Control-Allow-Origin.
      credentials: 'same-origin',
      headers: {
        ...sessionHeaders(win),
        ...(method === 'POST' ? { 'idempotency-key': options.idempotencyKey ?? randomTokenHex(16) } : {}),
        ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    if (!(res.headers.get('content-type') ?? '').includes('application/json')) {
      throw new ApiError(`${path} returned a non-JSON response (${res.status}); live state was not changed locally`, res.status);
    }
    const response = await res.json();
    if (!res.ok) {
      const detail = response?.error ?? response?.message;
      const what = res.status < 500 ? `${path} refused (${res.status})` : `${path} failed: ${res.status}`;
      throw new ApiError(`${what}${detail ? ` — ${detail}` : ''}`, res.status);
    }
    return response as T;
  }

  const [pathname, search = ''] = path.split('?');
  const payload = (body && typeof body === 'object' ? body : {}) as Record<string, unknown>;
  try {
    const result = await dispatchApiRoute(
      localState ??= createRuntimeState(1),
      method,
      pathname ?? path,
      new URLSearchParams(search),
      payload,
    );
    if (result.status >= 400) {
      const errObj = result.body as { error?: string; message?: string } | undefined;
      const sentence = errObj?.error ?? errObj?.message;
      const detail = sentence ? ` — ${sentence}` : '';
      const what = result.status < 500 ? `${path} refused (${result.status})` : `${path} failed: ${result.status}`;
      throw new ApiError(`${what}${detail}`, result.status);
    }
    const serialized = JSON.parse(
      JSON.stringify(result.body, (_k, v) => (typeof v === 'bigint' ? v.toString() : v)),
    );
    return serialized as T;
  } catch (err) {
    if (err instanceof ApiError) throw err;
    const status = httpStatusForError(err);
    const sentence = err instanceof Error ? err.message : String(err);
    const what = status < 500 ? `${path} refused (${status})` : `${path} failed: ${status}`;
    throw new ApiError(`${what} — ${sentence}`, status);
  }
}
