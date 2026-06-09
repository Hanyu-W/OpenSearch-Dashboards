/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

import { getBundledCatalog, loadCatalog, validateCatalogEntry } from '../catalog';

describe('catalog loading', () => {
  it('loads the bundled catalog with the expected rule ids', () => {
    const ids = getBundledCatalog().map((c) => c.id);
    expect(ids).toEqual(
      expect.arrayContaining([
        'invalid-capture-group-name',
        'unsupported-window-function-in-eventstats',
        'dedup-consecutive-unsupported',
        'replace-wildcard-asymmetry',
        'union-min-datasets',
        'multisearch-min-subsearch',
        'disabled-join-type',
        'head-without-sort',
        'field-validation',
        'expand-on-non-array',
        'wildcard-source-zero-match',
      ])
    );
  });

  it('keeps exactly the valid entries and drops malformed ones', () => {
    const entries = [
      {
        id: 'a',
        detector: 'a',
        enabled: true,
        severity: 'error',
        message: 'm',
        docUrl: 'd',
        appliesTo: {},
      },
      { id: 'b' }, // malformed
      {
        id: 'c',
        detector: 'c',
        enabled: true,
        severity: 'bogus',
        message: 'm',
        docUrl: 'd',
        appliesTo: {},
      },
      null,
      'not an object',
    ];
    const result = loadCatalog(entries);
    expect(result.map((e) => e.id)).toEqual(['a']);
  });

  it('returns an empty catalog for a non-array', () => {
    expect(loadCatalog({} as unknown)).toEqual([]);
  });

  it('validates a single entry', () => {
    expect(validateCatalogEntry({ id: 'x' })).toBeNull();
    expect(
      validateCatalogEntry({
        id: 'x',
        detector: 'x',
        enabled: true,
        severity: 'warning',
        message: 'm',
        docUrl: 'd',
        appliesTo: { minVersion: '3.4.0', engine: 'calcite' },
      })
    ).not.toBeNull();
  });

  it('rejects an invalid engine predicate', () => {
    expect(
      validateCatalogEntry({
        id: 'x',
        detector: 'x',
        enabled: true,
        severity: 'warning',
        message: 'm',
        docUrl: 'd',
        appliesTo: { engine: 'spark' },
      })
    ).toBeNull();
  });
});
