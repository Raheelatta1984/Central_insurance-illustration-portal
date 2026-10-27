import { describe, expect, it } from 'vitest';
import React from 'react';
import { renderToString } from 'react-dom/server';
import { buildWorld, worldSnapshot } from '../core/demo.js';
import { GuideProvider } from './guide.js';
import { RoleAccessMatrixPanel } from './role-matrix-views.js';

const h = React.createElement;
const noop = async () => {};

function renderPanel(
  world = buildWorld(),
  initialSection?: 'role-directory' | 'access-tree' | 'doa-limits' | 'role-audit',
): string {
  const data = worldSnapshot(world);
  return renderToString(
    h(
      GuideProvider,
      { data, enabled: true, tab: 'role-matrix' },
      h(RoleAccessMatrixPanel, { data, onReload: noop, onSwitchRole: noop, ...(initialSection ? { initialSection } : {}) }),
    ),
  );
}

describe('Role access matrix tab', () => {
  it('renders the role directory, the tree with inherit levels, DOA limits and the audit trail', () => {
    const html = renderPanel();

    expect(html).toContain('Role access matrix — tabs, sections, sub-sections &amp; DOA authority');
    const expectedRoles = worldSnapshot(buildWorld()).security.roleCount;
    expect(html).toContain(`${expectedRoles} roles across 4 authority tiers`);
    expect(html).toContain('roles only — user logins are a later layer');
    expect(html).toContain('Tab → Section → Sub-section visibility tree');
    expect(html).toContain('DOA limits &amp; limit-increase requests');
    expect(html).toContain('Access &amp; DOA change audit trail');

    const tree = renderPanel(undefined, 'access-tree');
    expect(tree).toContain('Full — visible &amp; editable');
    expect(tree).toContain('Read-only — visible, locked');
    expect(tree).toContain('Hidden — not in navigation');
    expect(tree).toContain('inherit from tab');

    const doa = renderPanel(undefined, 'doa-limits');
    expect(doa).toContain('Request a DOA limit increase');

    // Every section carries its curated guide note.
    for (const id of ['role-directory', 'access-tree', 'doa-limits', 'role-audit']) {
      expect(html, id).toContain(`data-guide="role-matrix:${id}"`);
    }
  });

  it('renders read-only controls and a request path for an officer-tier role', () => {
    const world = buildWorld();
    world.rbac.selectActiveRole('claim-officer');
    const tree = renderPanel(world, 'access-tree');
    expect(tree).toContain('Officer-tier roles cannot change section visibility or DOA limits');
    // The tree selects are disabled for an officer.
    expect(tree).toContain('disabled=""');

    const doa = renderPanel(world, 'doa-limits');
    expect(doa).toContain('Officer — request only');
    expect(doa).toContain('Request a DOA limit increase');
  });

  it('enables the DOA editor for a manager editing a lower-tier role', () => {
    const world = buildWorld();
    world.rbac.selectActiveRole('claim-manager');
    const html = renderPanel(world, 'doa-limits');

    expect(html).toContain('Supervisor/manager editing enabled');
    expect(html).not.toContain('Officer-tier roles cannot change section visibility or DOA limits');
    expect(html).toContain('Save DOA authority');
  });
});
