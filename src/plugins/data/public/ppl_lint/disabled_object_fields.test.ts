/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

import { collectDisabledObjectFields } from './disabled_object_fields';

describe('collectDisabledObjectFields', () => {
  it('collects top-level enabled:false objects', () => {
    const mapping = {
      'otel-logs-demo': {
        mappings: {
          properties: {
            raw: { type: 'object', enabled: false, properties: { k: { type: 'object' } } },
            message: { type: 'text' },
          },
        },
      },
    };
    expect(collectDisabledObjectFields(mapping)).toEqual(['raw']);
  });

  it('collects nested enabled:false objects with a dotted path', () => {
    const mapping = {
      idx: {
        mappings: {
          properties: {
            outer: {
              properties: {
                inner: { enabled: false, properties: { deep: { type: 'long' } } },
                other: { type: 'keyword' },
              },
            },
          },
        },
      },
    };
    expect(collectDisabledObjectFields(mapping)).toEqual(['outer.inner']);
  });

  it('does not descend into a disabled subtree', () => {
    const mapping = {
      idx: {
        mappings: {
          properties: {
            raw: {
              enabled: false,
              properties: {
                // Even though this child also has enabled:false, the parent
                // already halts indexing, so only `raw` is reported.
                child: { enabled: false, properties: {} },
              },
            },
          },
        },
      },
    };
    expect(collectDisabledObjectFields(mapping)).toEqual(['raw']);
  });

  it('unwraps a transport `body` envelope', () => {
    const response = {
      body: {
        idx: { mappings: { properties: { raw: { enabled: false } } } },
      },
    };
    expect(collectDisabledObjectFields(response)).toEqual(['raw']);
  });

  it('merges results across multiple indices and de-duplicates', () => {
    const mapping = {
      'idx-1': { mappings: { properties: { raw: { enabled: false } } } },
      'idx-2': { mappings: { properties: { raw: { enabled: false }, more: { enabled: false } } } },
    };
    expect(collectDisabledObjectFields(mapping).sort()).toEqual(['more', 'raw']);
  });

  it('returns an empty array when there are no disabled objects', () => {
    const mapping = {
      idx: { mappings: { properties: { a: { type: 'text' }, b: { type: 'long' } } } },
    };
    expect(collectDisabledObjectFields(mapping)).toEqual([]);
  });

  it('returns an empty array for malformed input', () => {
    expect(collectDisabledObjectFields(undefined)).toEqual([]);
    expect(collectDisabledObjectFields(null)).toEqual([]);
    expect(collectDisabledObjectFields('nope')).toEqual([]);
    expect(collectDisabledObjectFields({ idx: {} })).toEqual([]);
  });
});
