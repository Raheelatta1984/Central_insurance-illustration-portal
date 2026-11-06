import { describe, expect, it } from 'vitest';
import { authorize } from './auth.js';

describe('unit-linked servicing authorization', () => {
  it('refuses configuration changes to unrelated operators while permitting servicing roles', () => {
    expect(authorize({ name: 'reader', roles: ['viewer'] }, 'POST', '/roundup/settings', {})).not.toBeNull();
    expect(authorize({ name: 'servicer', roles: ['endorsement-officer'] }, 'POST', '/roundup/settings', {})).toBeNull();
    expect(authorize({ name: 'reader', roles: ['viewer'] }, 'POST', '/roundup/preview', {})).toBeNull();
    expect(authorize({ name: 'partner', roles: ['partner-agent', 'partner:P1'] }, 'POST', '/roundup/preview', {})).not.toBeNull();
  });
});
