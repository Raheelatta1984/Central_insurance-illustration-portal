/**
 * Request-shape validation for the API boundary.
 *
 * The dispatcher used to coerce everything with `String(payload[x])` / `Number(payload[x])` /
 * `Boolean(payload[x])`. That turns a missing claim id into the literal string "undefined", an
 * object into "[object Object]", `"abc"` into a `RangeError` deep inside `BigInt(...)` (a 500),
 * and the string `"false"` into `true`. Worse, the pervasive demo defaults mean a misspelled
 * field name silently acts on a seeded policy instead of failing.
 *
 * These helpers are the boundary contract for money-moving and identity-bearing fields: present,
 * of the expected JSON type, and in range — or a `RequestValidationError`, which the transport
 * maps to HTTP 400 (see `httpStatusForError` in routes.ts). Domain rules still run afterwards,
 * in the engines, exactly as before.
 */
export class RequestValidationError extends Error {
  readonly status = 400;
}

type Payload = Record<string, unknown>;

function describe(value: unknown): string {
  if (value === undefined) return 'missing';
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'an array';
  return `a ${typeof value}`;
}

/** A required identifier/label: a non-empty string (numbers are accepted as ids, nothing else is). */
export function reqString(payload: Payload, key: string): string {
  const value = payload[key];
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  if (typeof value !== 'string' || value.trim() === '') {
    throw new RequestValidationError(`${key} is required and must be a non-empty string (got ${describe(value)})`);
  }
  return value.trim();
}

export function optString(payload: Payload, key: string): string | undefined {
  const value = payload[key];
  if (value === undefined || value === null || value === '') return undefined;
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  if (typeof value !== 'string') throw new RequestValidationError(`${key} must be a string (got ${describe(value)})`);
  return value;
}

/** A boolean that stays false when the client sends "false". */
export function reqBool(payload: Payload, key: string, fallback?: boolean): boolean {
  const value = payload[key];
  if (value === undefined) {
    if (fallback !== undefined) return fallback;
    throw new RequestValidationError(`${key} is required and must be a boolean`);
  }
  if (typeof value === 'boolean') return value;
  if (value === 'true') return true;
  if (value === 'false') return false;
  if (value === 1) return true;
  if (value === 0) return false;
  throw new RequestValidationError(`${key} must be a boolean (got ${describe(value)}: ${JSON.stringify(value)})`);
}

export function optBool(payload: Payload, key: string): boolean | undefined {
  return payload[key] === undefined ? undefined : reqBool(payload, key);
}

/** A whole number in range — minor units, counts, basis points. Never `NaN`, never a float. */
export function reqInt(payload: Payload, key: string, options: { min?: number; max?: number; fallback?: number } = {}): number {
  const value = payload[key];
  if (value === undefined) {
    if (options.fallback !== undefined) return options.fallback;
    throw new RequestValidationError(`${key} is required and must be a whole number`);
  }
  const n = typeof value === 'string' && value.trim() !== '' ? Number(value) : value;
  if (typeof n !== 'number' || !Number.isInteger(n)) {
    throw new RequestValidationError(`${key} must be a whole number (got ${describe(value)}: ${JSON.stringify(value)})`);
  }
  if (options.min !== undefined && n < options.min) throw new RequestValidationError(`${key} must be at least ${options.min} (got ${n})`);
  if (options.max !== undefined && n > options.max) throw new RequestValidationError(`${key} must be at most ${options.max} (got ${n})`);
  return n;
}

export function reqEnum<T extends string>(payload: Payload, key: string, allowed: readonly T[], fallback?: T): T {
  const value = payload[key];
  if (value === undefined && fallback !== undefined) return fallback;
  if (typeof value !== 'string' || !(allowed as readonly string[]).includes(value)) {
    throw new RequestValidationError(`${key} must be one of ${allowed.join(', ')} (got ${describe(value)}: ${JSON.stringify(value)})`);
  }
  return value as T;
}

/** Assert the JSON body itself is an object — arrays/scalars are not requests. */
export function assertPayloadObject(value: unknown): asserts value is Payload {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new RequestValidationError(`request body must be a JSON object (got ${describe(value)})`);
  }
}
