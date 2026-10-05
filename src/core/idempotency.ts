/**
 * Idempotency keys for mutating calls.
 *
 * A console that retries a POST — because the network blinked, because somebody pressed the button
 * twice, because a queue redelivered the message — must not place the same cession twice, file the
 * same return twice or approve the same surplus twice. The caller sends an `Idempotency-Key` header;
 * the server remembers the answer it gave for that key together with what the request *was*, and a
 * second call with the same key and the same request gets the first answer back **without the
 * operation being applied again**.
 *
 * Three answers, and they are different on purpose:
 *
 *   - **fresh** — the key has not been seen: the caller goes ahead and then calls `complete`.
 *   - **replay** — the key and the request match something already answered: hand back the recorded
 *     response, status included, and touch nothing.
 *   - **refused** — the key was used for a *different* request: two requests under one key is a bug in
 *     the caller, not a retry, and the honest answer is to say so rather than to guess which was meant.
 *
 * A key that is in flight (reserved but not yet completed) is refused as *in progress*: a retry that
 * arrives while the first is still running has no answer to be given yet, and inventing one would be
 * worse than asking the caller to wait.
 */

import { fingerprintOf } from './persistence.js';

export class IdempotencyError extends Error {}

export interface IdempotentRecord {
  readonly key: string;
  /** What the request was: method, path and body fingerprint. A retry must be the *same* request. */
  readonly request: string;
  readonly status: number;
  readonly body: unknown;
  readonly at: string;
  readonly replayed: number;
}

export type IdempotencyAnswer =
  | { readonly state: 'fresh' }
  | { readonly state: 'replay'; readonly status: number; readonly body: unknown; readonly at: string }
  | { readonly state: 'refused'; readonly reason: 'different-request' | 'in-progress'; readonly detail: string };

export class IdempotencyKeys {
  private readonly held = new Map<string, IdempotentRecord>();
  private readonly inFlight = new Map<string, string>();
  private readonly limit: number;

  constructor(options: { readonly limit?: number } = {}) {
    this.limit = Math.max(1, options.limit ?? 500);
  }

  /** What a request is, for the purpose of telling a retry from a different request. */
  static requestOf(method: string, path: string, body: unknown): string {
    return `${method.toUpperCase()} ${path} ${fingerprintOf(body ?? null)}`;
  }

  /**
   * What to do with this key. `fresh` means the caller may proceed — and must then call `complete`
   * (or `abort` if it fails), so a key is never left reserved by a request that did not finish.
   */
  begin(key: string, request: string, at: string): IdempotencyAnswer {
    if (typeof key !== 'string' || key.trim() === '') throw new IdempotencyError('an idempotency key has to be a non-empty string');
    if (key.length > 128) throw new IdempotencyError(`idempotency key of ${key.length} characters is longer than the 128 a caller may send`);
    const held = this.held.get(key);
    if (held) {
      if (held.request !== request) {
        return {
          state: 'refused', reason: 'different-request',
          detail: `key '${key}' was used at ${held.at} for a different request: `
            + 'a retry repeats a request, and two different requests under one key is a caller that has lost track of its keys',
        };
      }
      this.held.set(key, { ...held, replayed: held.replayed + 1 });
      return { state: 'replay', status: held.status, body: held.body, at: held.at };
    }
    const running = this.inFlight.get(key);
    if (running !== undefined) {
      if (running !== request) {
        return {
          state: 'refused', reason: 'different-request',
          detail: `key '${key}' is in flight for a different request`,
        };
      }
      return {
        state: 'refused', reason: 'in-progress',
        detail: `key '${key}' is in flight: the first call has not answered yet, and a second answer would be a guess`,
      };
    }
    this.inFlight.set(key, request);
    return { state: 'fresh' };
  }

  /** The answer this key gave. Recorded once, replayed for every retry afterwards. */
  complete(key: string, request: string, status: number, body: unknown, at: string): IdempotentRecord {
    const running = this.inFlight.get(key);
    if (running === undefined) throw new IdempotencyError(`key '${key}' was completed without being begun`);
    if (running !== request) throw new IdempotencyError(`key '${key}' is in flight for a different request`);
    this.inFlight.delete(key);
    const record: IdempotentRecord = Object.freeze({ key, request, status, body, at, replayed: 0 });
    this.held.set(key, record);
    // the oldest key goes when the ledger is full: a key is there to absorb a retry, not to live forever
    if (this.held.size > this.limit) {
      const oldest = this.held.keys().next().value as string | undefined;
      if (oldest !== undefined && oldest !== key) this.held.delete(oldest);
    }
    return record;
  }

  /** The request failed: release the key so an honest retry can run, and record nothing. */
  abort(key: string): void {
    this.inFlight.delete(key);
  }

  /** What the register holds: every key that has an answer, and every key still running. */
  held_(): readonly IdempotentRecord[] { return [...this.held.values()]; }

  summary(): {
    readonly answered: number; readonly inFlight: number; readonly replayed: number; readonly limit: number;
    readonly keys: readonly { key: string; request: string; status: number; at: string; replayed: number }[];
  } {
    const records = this.held_();
    return {
      answered: records.length,
      inFlight: this.inFlight.size,
      replayed: records.reduce((n, r) => n + r.replayed, 0),
      limit: this.limit,
      keys: records.map((r) => ({ key: r.key, request: r.request, status: r.status, at: r.at, replayed: r.replayed })),
    };
  }
}
