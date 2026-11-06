import React from 'react';
import { renderToString } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { buildWorld, worldSnapshot } from '../core/demo.js';
import { UnitLinkedStatementPanel } from './unitlinked-policy-views.js';
import { RoundUpPanel } from './roundup-views.js';

describe('unit-linked and round-up views', () => {
  const data = worldSnapshot(buildWorld());
  it('renders the policy statement and six stages', () => {
    const html = renderToString(React.createElement(UnitLinkedStatementPanel, { data }));
    expect(html).toContain('Unit-linked policy statement');
    expect(html).toContain('UL-000123');
    for (const stage of data.unitLinkedStatements[0]!.processFlow) expect(html).toContain(stage.title.replaceAll('&', '&amp;'));
  });
  it('labels round-up as a simulation and shows only masked card details', () => {
    const html = renderToString(React.createElement(RoundUpPanel, { data }));
    expect(html).toContain('Demo simulation only');
    expect(html).toContain('0366');
    expect(html).not.toContain('4532015112830366');
    expect(html).toContain('Arabica Coffee DIFC');
  });
});
