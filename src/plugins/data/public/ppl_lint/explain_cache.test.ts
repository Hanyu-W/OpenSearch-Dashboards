/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

import { explainCache } from './explain_cache';

const CALCITE_RESPONSE = {
  calcite: { logical: 'L', physical: 'P-physical-plan' },
};

const V2_RESPONSE = {
  root: { name: 'ProjectOperator' },
};

describe('explainCache', () => {
  afterEach(() => {
    explainCache.clear();
  });

  const makeHttp = (impl?: (path: string, opts: any) => Promise<any>) => ({
    post: jest.fn(impl ?? (() => Promise.resolve(CALCITE_RESPONSE))),
  });

  it('POSTs to the explain endpoint with the query body and maps a Calcite plan', async () => {
    const http = makeHttp();
    const plan = await explainCache.resolve(http as any, 'source=accounts | head 1', 'ds-1');

    expect(http.post).toHaveBeenCalledWith('/api/enhancements/ppl/explain', {
      body: JSON.stringify({ query: 'source=accounts | head 1' }),
      query: { dataSourceId: 'ds-1' },
    });
    expect(plan).toEqual({ isCalcite: true, physical: 'P-physical-plan', logical: 'L' });
  });

  it('omits the dataSourceId query param for a local cluster', async () => {
    const http = makeHttp();
    await explainCache.resolve(http as any, 'source=accounts', undefined);
    expect(http.post).toHaveBeenCalledWith('/api/enhancements/ppl/explain', {
      body: JSON.stringify({ query: 'source=accounts' }),
      query: {},
    });
  });

  it('maps a v2 (non-Calcite) response to an empty, non-Calcite plan', async () => {
    const http = makeHttp(() => Promise.resolve(V2_RESPONSE));
    const plan = await explainCache.resolve(http as any, 'source=accounts', 'ds-1');
    expect(plan).toEqual({ isCalcite: false, physical: '', logical: '' });
  });

  it('returns an empty plan when the request rejects', async () => {
    const http = makeHttp(() => Promise.reject(new Error('boom')));
    const plan = await explainCache.resolve(http as any, 'source=accounts', 'ds-1');
    expect(plan).toEqual({ isCalcite: false, physical: '', logical: '' });
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
    resolveFn(CALCITE_RESPONSE);
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
