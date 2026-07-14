/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

import { explainCache, toExplainPlan } from './explain_cache';

const LOGICAL_TREE = { rels: [{ id: '1', relOp: 'LogicalFilter' }] };
const PHYSICAL_TREE = {
  rels: [
    {
      id: '2',
      relOp: 'CalciteEnumerableIndexScan',
      PushDownContext: ['FILTER->>($0, 30)', 'LIMIT->10000'],
      sourceBuilder: { query: { range: { age: { from: 30 } } } },
    },
  ],
};

const JSON_TREE_RESPONSE = {
  calcite: { logical: LOGICAL_TREE, physical: PHYSICAL_TREE },
};

const STRING_RESPONSE = {
  calcite: { logical: 'L', physical: 'P-physical-plan' },
};

const V2_RESPONSE = {
  root: { name: 'ProjectOperator' },
};

describe('toExplainPlan', () => {
  it('maps a json_tree Calcite response to physicalTree/logicalTree', () => {
    expect(toExplainPlan(JSON_TREE_RESPONSE)).toEqual({
      isCalcite: true,
      logicalTree: LOGICAL_TREE,
      physicalTree: PHYSICAL_TREE,
      logicalText: undefined,
      physicalText: undefined,
    });
  });

  it('maps a legacy string Calcite response to physicalText/logicalText', () => {
    expect(toExplainPlan(STRING_RESPONSE)).toEqual({
      isCalcite: true,
      logicalTree: undefined,
      physicalTree: undefined,
      logicalText: 'L',
      physicalText: 'P-physical-plan',
    });
  });

  it('maps a v2 (non-Calcite) response to an empty, non-Calcite plan', () => {
    expect(toExplainPlan(V2_RESPONSE)).toEqual({ isCalcite: false });
  });

  it('maps malformed Calcite bodies to an empty, non-Calcite plan', () => {
    expect(toExplainPlan({ calcite: { logical: 1, physical: null } })).toEqual({
      isCalcite: false,
    });
  });
});

describe('explainCache', () => {
  afterEach(() => {
    explainCache.clear();
  });

  const makeHttp = (impl?: (path: string, opts: any) => Promise<any>) => ({
    post: jest.fn(impl ?? (() => Promise.resolve(JSON_TREE_RESPONSE))),
  });

  it('POSTs to the explain endpoint with the query body and maps a json_tree Calcite plan', async () => {
    const http = makeHttp();
    const plan = await explainCache.resolve(http as any, 'source=accounts | head 1', 'ds-1');

    expect(http.post).toHaveBeenCalledWith('/api/enhancements/ppl/explain', {
      body: JSON.stringify({ query: 'source=accounts | head 1' }),
      query: { dataSourceId: 'ds-1' },
    });
    expect(plan).toEqual({
      isCalcite: true,
      logicalTree: LOGICAL_TREE,
      physicalTree: PHYSICAL_TREE,
      logicalText: undefined,
      physicalText: undefined,
    });
  });

  it('omits the dataSourceId query param for a local cluster', async () => {
    const http = makeHttp();
    await explainCache.resolve(http as any, 'source=accounts', undefined);
    expect(http.post).toHaveBeenCalledWith('/api/enhancements/ppl/explain', {
      body: JSON.stringify({ query: 'source=accounts' }),
      query: {},
    });
  });

  it('keeps legacy string explain fallback responses usable', async () => {
    const http = makeHttp(() => Promise.resolve(STRING_RESPONSE));
    const plan = await explainCache.resolve(http as any, 'source=accounts', 'ds-1');
    expect(plan).toEqual({
      isCalcite: true,
      logicalTree: undefined,
      physicalTree: undefined,
      logicalText: 'L',
      physicalText: 'P-physical-plan',
    });
  });

  it('maps a v2 (non-Calcite) response to an empty, non-Calcite plan', async () => {
    const http = makeHttp(() => Promise.resolve(V2_RESPONSE));
    const plan = await explainCache.resolve(http as any, 'source=accounts', 'ds-1');
    expect(plan).toEqual({ isCalcite: false });
  });

  it('returns an empty plan when the request rejects', async () => {
    const http = makeHttp(() => Promise.reject(new Error('boom')));
    const plan = await explainCache.resolve(http as any, 'source=accounts', 'ds-1');
    expect(plan).toEqual({ isCalcite: false });
  });

  it('keeps rejected requests distinct from unsupported responses and retries them', async () => {
    const errorHttp = makeHttp(() => Promise.reject(new Error('boom')));
    await expect(
      explainCache.resolveResult(errorHttp as any, 'source=accounts', 'ds-error')
    ).resolves.toEqual(expect.objectContaining({ status: 'error' }));
    await explainCache.resolveResult(errorHttp as any, 'source=accounts', 'ds-error');
    expect(errorHttp.post).toHaveBeenCalledTimes(2);

    const unsupportedHttp = makeHttp(() => Promise.resolve(V2_RESPONSE));
    await expect(
      explainCache.resolveResult(unsupportedHttp as any, 'source=accounts', 'ds-unsupported')
    ).resolves.toEqual({ status: 'unsupported' });
  });

  it('partitions synthetic probe entries from baseline entries', async () => {
    const http = makeHttp();
    await explainCache.resolveResult(http as any, 'source=accounts', 'ds-1');
    await explainCache.resolveResult(http as any, 'source=accounts', 'ds-1', {
      partition: 'probe',
    });
    await explainCache.resolveResult(http as any, 'source=accounts', 'ds-1', {
      partition: 'probe',
    });
    expect(http.post).toHaveBeenCalledTimes(2);
  });

  it('caches by (dataSourceId, query): a repeat hit makes no second call', async () => {
    const http = makeHttp();
    await explainCache.resolve(http as any, 'source=accounts', 'ds-1');
    await explainCache.resolve(http as any, 'source=accounts', 'ds-1');
    expect(http.post).toHaveBeenCalledTimes(1);
  });

  it('keys distinctly by dataSourceId and by query text', async () => {
    const http = makeHttp();
    await explainCache.resolve(http as any, 'source=accounts', 'ds-1');
    await explainCache.resolve(http as any, 'source=accounts', 'ds-2'); // different source
    await explainCache.resolve(http as any, 'source=other', 'ds-1'); // different query
    expect(http.post).toHaveBeenCalledTimes(3);
  });

  it('dedupes concurrent in-flight calls for the same key', async () => {
    let resolveFn: (v: any) => void = () => {};
    const http = {
      post: jest.fn(
        () =>
          new Promise((resolve) => {
            resolveFn = resolve;
          })
      ),
    };
    const p1 = explainCache.resolve(http as any, 'source=accounts', 'ds-1');
    const p2 = explainCache.resolve(http as any, 'source=accounts', 'ds-1');
    resolveFn(JSON_TREE_RESPONSE);
    const [r1, r2] = await Promise.all([p1, p2]);
    expect(http.post).toHaveBeenCalledTimes(1);
    expect(r1).toEqual(r2);
  });

  it('evicts the oldest entry past the 50-entry cap', async () => {
    const http = makeHttp();
    // Fill the cache to its cap with 50 distinct queries.
    for (let i = 0; i < 50; i++) {
      await explainCache.resolve(http as any, `source=q${i}`, 'ds-1');
    }
    expect(http.post).toHaveBeenCalledTimes(50);

    // One more eviction-triggering query (51st).
    await explainCache.resolve(http as any, 'source=q50', 'ds-1');
    expect(http.post).toHaveBeenCalledTimes(51);

    // q0 (oldest) was evicted → re-resolving it issues a fresh call.
    await explainCache.resolve(http as any, 'source=q0', 'ds-1');
    expect(http.post).toHaveBeenCalledTimes(52);

    // q50 (most recent) is still cached → no new call.
    await explainCache.resolve(http as any, 'source=q50', 'ds-1');
    expect(http.post).toHaveBeenCalledTimes(52);
  });

  it('invalidate drops a single cached key', async () => {
    const http = makeHttp();
    await explainCache.resolve(http as any, 'source=accounts', 'ds-1');
    explainCache.invalidate('source=accounts', 'ds-1');
    await explainCache.resolve(http as any, 'source=accounts', 'ds-1');
    expect(http.post).toHaveBeenCalledTimes(2);
  });
});
