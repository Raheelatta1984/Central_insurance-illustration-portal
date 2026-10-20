/** The API boundary contract: bad shapes are 400s with a reason, never coercions. */
import { describe, expect, it } from 'vitest';
import { assertPayloadObject, optBool, reqBool, reqEnum, reqInt, reqString, RequestValidationError } from './validate.js';

describe('request validation', () => {
  it('requires identifiers instead of inventing the string "undefined"', () => {
    expect(reqString({ claimId: ' CLM-1 ' }, 'claimId')).toBe('CLM-1');
    expect(() => reqString({}, 'claimId')).toThrow(RequestValidationError);
    expect(() => reqString({ claimId: { x: 1 } }, 'claimId')).toThrow(/must be a non-empty string/);
    expect(() => reqString({ claimId: '   ' }, 'claimId')).toThrow(RequestValidationError);
  });

  it('keeps "false" false (Boolean("false") is true)', () => {
    expect(reqBool({ isAi: 'false' }, 'isAi')).toBe(false);
    expect(reqBool({ isAi: true }, 'isAi')).toBe(true);
    expect(optBool({}, 'isAi')).toBeUndefined();
    expect(() => reqBool({ isAi: 'yes' }, 'isAi')).toThrow(/must be a boolean/);
  });

  it('accepts whole numbers and refuses NaN/floats before they reach BigInt', () => {
    expect(reqInt({ amountMinor: 200000 }, 'amountMinor', { min: 0 })).toBe(200000);
    expect(reqInt({ amountMinor: '42' }, 'amountMinor')).toBe(42);
    expect(reqInt({}, 'amountMinor', { fallback: 7 })).toBe(7);
    expect(() => reqInt({ amountMinor: 'abc' }, 'amountMinor')).toThrow(/whole number/);
    expect(() => reqInt({ amountMinor: 1.5 }, 'amountMinor')).toThrow(RequestValidationError);
    expect(() => reqInt({ amountMinor: -1 }, 'amountMinor', { min: 0 })).toThrow(/at least 0/);
  });

  it('closes enums and bodies to the shapes the engines expect', () => {
    expect(reqEnum({ role: 'board' }, 'role', ['actuary', 'shariah', 'board'] as const)).toBe('board');
    expect(() => reqEnum({ role: 'ceo' }, 'role', ['actuary'] as const)).toThrow(/must be one of/);
    expect(() => assertPayloadObject([1, 2])).toThrow(RequestValidationError);
    expect(() => assertPayloadObject('x')).toThrow(/JSON object/);
  });
});
