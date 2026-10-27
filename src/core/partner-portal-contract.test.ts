import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { API_ROUTE_KEYS } from './route-catalogue.js';
import { createRuntimeState, dispatchApiRoute } from './routes.js';

type Schema = {
  $ref?: string; allOf?: Schema[]; type?: string; nullable?: boolean;
  required?: string[]; properties?: Record<string, Schema>; items?: Schema;
  enum?: unknown[]; minLength?: number; maxLength?: number; minimum?: number; maximum?: number; pattern?: string;
};
type Operation = {
  requestBody?: { content: { 'application/json': { schema: Schema } } };
  responses: Record<string, { content?: { 'application/json': { schema: Schema } } }>;
};
const contract = JSON.parse(readFileSync(new URL('../../docs/partner-portal.openapi.json', import.meta.url), 'utf8')) as {
  paths: Record<string, Record<string, Operation>>;
  components: { schemas: Record<string, Schema> };
};

/** The subset of the OpenAPI schema vocabulary used in this contract. */
function conform(schema: Schema, value: unknown, at = '$'): void {
  if (value === null && schema.nullable) return;
  if (schema.$ref) {
    const name = schema.$ref.split('/').at(-1)!;
    const target = contract.components.schemas[name];
    expect(target, `missing ${schema.$ref}`).toBeDefined();
    conform(target!, value, at);
  }
  for (const part of schema.allOf ?? []) conform(part, value, at);
  if (schema.enum) expect(schema.enum, at).toContain(value);
  if (schema.type === 'object') {
    expect(value !== null && typeof value === 'object' && !Array.isArray(value), at).toBe(true);
    const data = value as Record<string, unknown>;
    for (const key of schema.required ?? []) expect(Object.hasOwn(data, key), `${at}.${key}`).toBe(true);
    for (const [key, child] of Object.entries(schema.properties ?? {})) if (Object.hasOwn(data, key)) conform(child, data[key], `${at}.${key}`);
  } else if (schema.type === 'array') {
    expect(Array.isArray(value), at).toBe(true);
    if (schema.items) (value as unknown[]).forEach((entry, index) => conform(schema.items!, entry, `${at}[${index}]`));
  } else if (schema.type === 'string') {
    expect(typeof value, at).toBe('string');
    if (schema.minLength !== undefined) expect((value as string).length, at).toBeGreaterThanOrEqual(schema.minLength);
    if (schema.maxLength !== undefined) expect((value as string).length, at).toBeLessThanOrEqual(schema.maxLength);
    if (schema.pattern) expect(value as string, at).toMatch(new RegExp(schema.pattern));
  } else if (schema.type === 'boolean') expect(typeof value, at).toBe('boolean');
  else if (schema.type === 'integer' || schema.type === 'number') {
    expect(typeof value, at).toBe('number');
    if (schema.type === 'integer') expect(Number.isInteger(value), at).toBe(true);
    if (schema.minimum !== undefined) expect(value as number, at).toBeGreaterThanOrEqual(schema.minimum);
    if (schema.maximum !== undefined) expect(value as number, at).toBeLessThanOrEqual(schema.maximum);
  }
}

describe('partner portal OpenAPI contract', () => {
  it('matches every partner route in the request-guard catalogue and defines request schemas', () => {
    const documented = Object.entries(contract.paths).flatMap(([path, methods]) => Object.keys(methods).map((method) => `${method.toUpperCase()} ${path}`)).sort();
    expect(documented).toEqual(API_ROUTE_KEYS.filter((key) => key.includes(' /partner-portal/')).slice().sort());
    for (const [path, methods] of Object.entries(contract.paths)) for (const [method, operation] of Object.entries(methods)) {
      expect(operation.responses['200'], `${method} ${path}`).toBeDefined();
      if (method === 'post') expect(operation.requestBody?.content['application/json'].schema, `${method} ${path}`).toBeDefined();
    }
  });

  it('validates demo requests and real dispatcher responses against the published shapes', async () => {
    const state = createRuntimeState(1, () => '2026-10-05T12:00:00Z');
    const check = async (method: 'get' | 'post', path: string, payload: Record<string, unknown> = {}, query = '') => {
      const operation = contract.paths[path]![method]!;
      if (method === 'post') conform(operation.requestBody!.content['application/json'].schema, payload);
      const result = await dispatchApiRoute(state, method.toUpperCase(), path, new URLSearchParams(query), payload);
      expect(result.status, `${method} ${path}`).toBe(200);
      const serialized = JSON.parse(JSON.stringify(result.body, (_key, value) => typeof value === 'bigint' ? String(value) : value)) as unknown;
      const responseSchema = operation.responses['200']?.content?.['application/json'].schema;
      expect(responseSchema).toBeDefined();
      conform(responseSchema!, serialized);
      return serialized as Record<string, unknown>;
    };
    await check('post', '/partner-portal/demo/setup');
    await check('get', '/partner-portal/access');
    await check('get', '/partner-portal/workspace', {}, 'partnerId=DEMO-BROKER');
    const scope = { partnerId: 'DEMO-BROKER', channelCode: 'BROKER', subChannelCode: 'DEMO-BROKER-DESK' };
    const opened = await check('post', '/partner-portal/journey/open', { ...scope, customerName: 'Contract sample' });
    await check('get', '/partner-portal/journey', {}, `caseId=${opened['caseId']}`);
    await check('post', '/partner-portal/journey/stage', { caseId: opened['caseId'], stageId: 'identity', action: 'save', answers: {} });
    const request = await check('post', '/partner-portal/requests/open', { ...scope, kind: 'reporting-request', subject: 'Report request', message: 'Please send the monthly report.' });
    await check('post', '/partner-portal/requests/reply', { id: request['id'], from: 'insurer', message: 'The report is being prepared.', close: true });
  });
});
