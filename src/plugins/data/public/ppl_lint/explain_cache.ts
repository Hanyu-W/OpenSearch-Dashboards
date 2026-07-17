/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

// The `@osd/monaco/target/...` path is a deep import into the built output
// rather than the '@osd/monaco' barrel, for the same reason as runtime_lint.ts:
// the barrel pulls in monaco-editor browser ESM (with .css side effects) and is
// globally jest.mock()'d, so its value/type exports are unavailable under bare
// Node resolution and Jest.
import type {
  ExplainPlan,
  ExplainRelTree,
} from '@osd/monaco/target/ppl/lint/explain/explain_types';
import { EXPLAIN_OUTCOME_DETECTOR_VERSION } from '@osd/monaco/target/ppl/lint/explain/explain_outcomes';
import type { PPLLintHttpClient } from '@osd/monaco/target/ppl/lint_bridge';

// Hardcoded rather than imported from query_enhancements/common to avoid a
// cross-plugin import, matching calcite_settings.ts.
const EXPLAIN_PATH = '/api/enhancements/ppl/explain';

// Bound memory: identical query text is cached, editing produces a new key. A
// small cap is plenty for an interactive editing session.
const MAX_BASELINE_ENTRIES = 50;
const MAX_PROBE_ENTRIES = 50;

const EMPTY: ExplainPlan = { isCalcite: false };

export type ExplainResolution =
  | { status: 'ok'; plan: ExplainPlan }
  | { status: 'unsupported' }
  | { status: 'error'; error?: unknown };

export interface ExplainResolveOptions {
  partition?: 'baseline' | 'probe';
  signal?: AbortSignal;
}

function isRelTree(value: unknown): value is ExplainRelTree {
  return !!value && typeof value === 'object' && Array.isArray((value as { rels?: unknown }).rels);
}

/**
 * Map a raw `_explain` response into an {@link ExplainPlan}. Newer Calcite
 * clusters return rel-tree objects for `logical`/`physical`; older clusters
 * return strings. Anything else (the `{ root: {...} }` v2 shape, malformed
 * bodies, error bodies) maps to a non-Calcite empty plan, which makes every
 * explain detector no-op.
 */
export function toExplainPlan(res: unknown): ExplainPlan {
  const calcite = (res as { calcite?: { physical?: unknown; logical?: unknown } })?.calcite;
  if (!calcite || typeof calcite !== 'object') {
    return EMPTY;
  }

  const logical = calcite.logical;
  const physical = calcite.physical;
  const logicalTree = isRelTree(logical) ? logical : undefined;
  const physicalTree = isRelTree(physical) ? physical : undefined;
  const logicalText = typeof logical === 'string' ? logical : undefined;
  const physicalText = typeof physical === 'string' ? physical : undefined;

  if (!logicalTree && !physicalTree && !logicalText && !physicalText) {
    return EMPTY;
  }

  return {
    isCalcite: true,
    logicalTree,
    physicalTree,
    logicalText,
    physicalText,
  };
}

/**
 * Caches `_explain` results per (dataSourceId, query) with in-flight dedup, so
 * repeated lint passes over the same text issue at most one network call.
 * Modeled on `calcite_settings.ts`, with an added LRU cap because the key space
 * (query text) is unbounded.
 */
class ExplainCache {
  private baselineCache = new Map<string, ExplainResolution>();
  private probeCache = new Map<string, ExplainResolution>();
  private baselinePending = new Map<string, Promise<ExplainResolution>>();
  private probePending = new Map<string, Promise<ExplainResolution>>();

  private key(
    query: string,
    dataSourceId: string | undefined,
    partition: 'baseline' | 'probe'
  ): string {
    const version = partition === 'probe' ? `::outcomes-${EXPLAIN_OUTCOME_DETECTOR_VERSION}` : '';
    return `${dataSourceId ?? '__local__'}${version}::${query}`;
  }

  async resolveResult(
    http: PPLLintHttpClient,
    query: string,
    dataSourceId?: string,
    options: ExplainResolveOptions = {}
  ): Promise<ExplainResolution> {
    const partition = options.partition ?? 'baseline';
    const cache = partition === 'probe' ? this.probeCache : this.baselineCache;
    const pending = partition === 'probe' ? this.probePending : this.baselinePending;
    const cap = partition === 'probe' ? MAX_PROBE_ENTRIES : MAX_BASELINE_ENTRIES;
    const k = this.key(query, dataSourceId, partition);
    if (cache.has(k)) {
      return cache.get(k)!;
    }
    if (pending.has(k)) {
      return pending.get(k)!;
    }

    const promise = http
      .post(EXPLAIN_PATH, {
        body: JSON.stringify({ query }),
        query: dataSourceId ? { dataSourceId } : {},
        signal: options.signal,
      })
      .then(toExplainPlan)
      .then((plan) => {
        const resolution: ExplainResolution = plan.isCalcite
          ? { status: 'ok', plan }
          : { status: 'unsupported' };
        if (cache.size >= cap) {
          const oldest = cache.keys().next().value;
          if (oldest !== undefined) {
            cache.delete(oldest);
          }
        }
        cache.set(k, resolution);
        pending.delete(k);
        return resolution;
      })
      .catch((error) => {
        pending.delete(k);
        // Errors are deliberately not cached. A transient failure must not
        // become a permanent "no outcome" result for a later control probe.
        return { status: 'error', error } as ExplainResolution;
      });

    pending.set(k, promise);
    return promise;
  }

  clear() {
    this.baselineCache.clear();
    this.probeCache.clear();
    this.baselinePending.clear();
    this.probePending.clear();
  }
}

export const explainCache = new ExplainCache();
