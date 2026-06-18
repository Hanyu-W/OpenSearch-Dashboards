/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

// The `@osd/monaco/target/...` path is a deep import into the built output
// rather than the '@osd/monaco' barrel, for the same reason as runtime_lint.ts:
// the barrel pulls in monaco-editor browser ESM (with .css side effects) and is
// globally jest.mock()'d, so its value/type exports are unavailable under bare
// Node resolution and Jest.
import type { ExplainPlan } from '@osd/monaco/target/ppl/lint/explain/explain_types';
import { HttpSetup } from '../../../../core/public';

// Hardcoded rather than imported from query_enhancements/common to avoid a
// cross-plugin import, matching calcite_settings.ts.
const EXPLAIN_PATH = '/api/enhancements/ppl/explain';

// Bound memory: identical query text is cached, editing produces a new key. A
// small cap is plenty for an interactive editing session.
const MAX_ENTRIES = 50;

const EMPTY: ExplainPlan = { isCalcite: false, physical: '', logical: '' };

/**
 * Map a raw `_explain` response into an {@link ExplainPlan}. On a Calcite
 * cluster the response is `{ calcite: { logical, physical } }`; anything else
 * (the `{ root: {...} }` v2 shape, an error body) maps to a non-Calcite empty
 * plan, which makes every explain detector no-op.
 */
function toPlan(res: any): ExplainPlan {
  if (res?.calcite) {
    return {
      isCalcite: true,
      physical: res.calcite.physical ?? '',
      logical: res.calcite.logical ?? '',
    };
  }
  return EMPTY;
}

/**
 * Caches `_explain` results per (dataSourceId, query) with in-flight dedup, so
 * repeated lint passes over the same text issue at most one network call.
 * Modeled on `calcite_settings.ts`, with an added LRU cap because the key space
 * (query text) is unbounded.
 */
class ExplainCache {
  private cache = new Map<string, ExplainPlan>();
  private pending = new Map<string, Promise<ExplainPlan>>();

  private key(query: string, dataSourceId?: string): string {
    return `${dataSourceId ?? '__local__'}::${query}`;
  }

  async resolve(http: HttpSetup, query: string, dataSourceId?: string): Promise<ExplainPlan> {
    const k = this.key(query, dataSourceId);
    if (this.cache.has(k)) {
      return this.cache.get(k)!;
    }
    if (this.pending.has(k)) {
      return this.pending.get(k)!;
    }

    const promise = http
      .post(EXPLAIN_PATH, {
        body: JSON.stringify({ query }),
        query: dataSourceId ? { dataSourceId } : {},
      })
      .then(toPlan)
      .catch(() => EMPTY)
      .then((plan) => {
        // Evict the oldest entry (insertion order) once the cap is reached.
        if (this.cache.size >= MAX_ENTRIES) {
          const oldest = this.cache.keys().next().value;
          if (oldest !== undefined) {
            this.cache.delete(oldest);
          }
        }
        this.cache.set(k, plan);
        this.pending.delete(k);
        return plan;
      });

    this.pending.set(k, promise);
    return promise;
  }

  invalidate(query: string, dataSourceId?: string) {
    const k = this.key(query, dataSourceId);
    this.cache.delete(k);
    this.pending.delete(k);
  }

  clear() {
    this.cache.clear();
    this.pending.clear();
  }
}

export const explainCache = new ExplainCache();
