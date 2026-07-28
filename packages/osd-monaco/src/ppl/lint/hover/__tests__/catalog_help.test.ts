/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

import { getBundledCatalog, getBundledCatalogEntry } from '../../catalog';

// Coverage guard for task-oriented hover guidance in the catalog.

const catalog = getBundledCatalog();

describe('catalog hover guidance', () => {
  it('every entry has a concrete next action', () => {
    for (const entry of catalog) {
      expect(typeof entry.howToFix).toBe('string');
      expect(entry.howToFix.length).toBeGreaterThan(0);
    }
  });

  it('keeps engine implementation details out of beginner guidance', () => {
    const implementationTerms = /\b(?:HTTP|Calcite|Painless|coordinator|schema type)\b|Exception/;
    const offenders = catalog
      .filter((entry) => implementationTerms.test(entry.howToFix))
      .map((entry) => entry.id);
    expect(offenders).toEqual([]);
  });

  it('returns the full catalog entry by rule id', () => {
    const entry = getBundledCatalogEntry('division-by-zero');
    expect(entry?.howToFix).toContain('handle zero before dividing');
    expect(entry?.docUrl).toContain('arithmetic-operators');
  });

  it('returns undefined for an unknown rule', () => {
    expect(getBundledCatalogEntry('no-such-rule')).toBeUndefined();
  });
});
