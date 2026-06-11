/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * PPL query corpus for the lint performance benchmark.
 *
 * The corpus is bucketed by *size* (a proxy for parse-tree depth / token count,
 * which is what drives parse + lint CPU) and tagged with which rules each query
 * is expected to exercise. Queries are real PPL drawn from the rule catalog's
 * own test cases (see `__tests__/analyzer_lint.test.ts`,
 * `silent_failure_rules.test.ts`) plus a few hand-written stress queries, so the
 * measured cost reflects the production detector set actually firing — not an
 * empty tree walk.
 */

export type SizeBucket = 'tiny' | 'small' | 'medium' | 'large' | 'xlarge';

export interface CorpusQuery {
  /** Stable id for reporting. */
  id: string;
  /** Size bucket (drives the latency-by-size chart). */
  bucket: SizeBucket;
  /** The PPL source. */
  ppl: string;
  /** Rule ids this query is expected to make fire (documentation aid). */
  triggers: string[];
  /** True when the query needs field metadata (Bucket-B context) to fire. */
  needsContext?: boolean;
}

/**
 * The benchmark corpus. Ordered roughly small → large within each bucket.
 */
export const CORPUS: CorpusQuery[] = [
  // ── tiny (~10–25 chars): the common "just started typing" case ───────────
  { id: 'tiny-source', bucket: 'tiny', ppl: 'source=logs', triggers: [] },
  { id: 'tiny-search', bucket: 'tiny', ppl: 'search source=logs', triggers: [] },
  {
    id: 'tiny-head',
    bucket: 'tiny',
    ppl: 'source=logs | head 10',
    triggers: ['head-without-sort'],
  },

  // ── small (~30–55 chars): one pipe, one rule ────────────────────────────
  {
    id: 'small-rex-bad',
    bucket: 'small',
    ppl: 'source=logs | rex field=msg "(?<bad-name>\\d+)"',
    triggers: ['invalid-capture-group-name'],
  },
  {
    id: 'small-rex-ok',
    bucket: 'small',
    ppl: 'source=logs | rex field=msg "(?<good>\\d+)"',
    triggers: [],
  },
  {
    id: 'small-eventstats-rank',
    bucket: 'small',
    ppl: 'source=logs | eventstats rank() as r by status',
    triggers: ['unsupported-window-function-in-eventstats'],
  },
  {
    id: 'small-cross-join',
    bucket: 'small',
    ppl: 'source=a | cross join left=l right=r on l.id = r.id b',
    triggers: ['disabled-join-type'],
  },
  {
    id: 'small-div-zero',
    bucket: 'small',
    ppl: 'source=logs | eval x = bytes / 0',
    triggers: ['division-by-zero'],
  },

  // ── medium (~60–100 chars): two or three pipes ──────────────────────────
  {
    id: 'medium-multi-pipe',
    bucket: 'medium',
    ppl: 'source=logs | where status = 500 | stats count() by host | head 5',
    triggers: ['head-without-sort'],
  },
  {
    id: 'medium-rex-stats',
    bucket: 'medium',
    ppl: 'source=logs | rex field=msg "(?<user_id>\\d+)" | stats avg(latency) by user_id',
    triggers: ['invalid-capture-group-name'],
  },
  {
    id: 'medium-field-validation',
    bucket: 'medium',
    ppl: 'source=logs | where nonexistent_field > 10 | fields nope, also_missing',
    triggers: ['field-validation'],
    needsContext: true,
  },
  {
    id: 'medium-type-mismatch',
    bucket: 'medium',
    ppl: 'source=logs | where response_bytes = "lots" | stats count() by host',
    triggers: ['type-mismatch-numeric'],
    needsContext: true,
  },

  // ── large (~120–180 chars): realistic dashboard query ───────────────────
  {
    id: 'large-pipeline',
    bucket: 'large',
    ppl:
      'source=logs | where status >= 400 and status < 600 | ' +
      'rex field=path "(?<endpoint>/[a-z]+)" | ' +
      'stats count() as errors, avg(latency_ms) as p by endpoint, status | ' +
      'sort - errors | head 20',
    triggers: [],
  },
  {
    id: 'large-multi-rule',
    bucket: 'large',
    ppl:
      'source=events | rex field=ua "(?<browser-name>[A-Za-z]+)" | ' +
      'eventstats rank() as r by session | ' +
      'eval ratio = hits / 0 | ' +
      'cross join left=l right=r on l.sid = r.sid sessions | head 50',
    triggers: [
      'invalid-capture-group-name',
      'unsupported-window-function-in-eventstats',
      'division-by-zero',
      'disabled-join-type',
      'head-without-sort',
    ],
  },

  // ── xlarge (~250–400 chars): pathological stress, many rex + pipes ──────
  {
    id: 'xlarge-rex-storm',
    bucket: 'xlarge',
    ppl:
      'source=logs | ' +
      Array.from({ length: 8 }, (_, i) => `rex field=f${i} "(?<grp_${i}>\\d+)"`).join(' | ') +
      ' | stats count() by grp_0 | sort - grp_0 | head 100',
    triggers: ['invalid-capture-group-name'],
  },
  {
    id: 'xlarge-deep-pipeline',
    bucket: 'xlarge',
    ppl:
      'source=logs | where a > 1 | where b < 2 | where c = 3 | ' +
      'eval x = p / 0 | eval y = q / 0 | eval z = r / 0 | ' +
      'rex field=m "(?<bad-1>\\d+)" | rex field=n "(?<bad-2>\\w+)" | ' +
      'eventstats rank() as rk by g | stats sum(x) as sx, avg(y) as ay by g | ' +
      'sort - sx | head 25 | head 10',
    triggers: [
      'division-by-zero',
      'invalid-capture-group-name',
      'unsupported-window-function-in-eventstats',
    ],
  },
];

/**
 * Realistic field metadata for the with-context (Bucket-B) measurement. Mirrors
 * the shape `LintRunContext` consumes: a `fields` name set + a `typeMap` of
 * name → es type. Chosen so that the `needsContext` corpus queries above both
 * fire (unknown fields, type mismatches) and pass (known fields).
 */
export interface BenchContext {
  fields: Set<string>;
  typeMap: Map<string, string>;
  visibleIndices: string[];
  isCalcite: boolean;
  dataSourceVersion: string;
}

export function makeBenchContext(): BenchContext {
  const typeMap = new Map<string, string>([
    ['status', 'integer'],
    ['host', 'keyword'],
    ['path', 'text'],
    ['latency_ms', 'float'],
    ['latency', 'float'],
    ['response_bytes', 'long'],
    ['bytes', 'long'],
    ['msg', 'text'],
    ['user_id', 'keyword'],
    ['session', 'keyword'],
    ['ua', 'text'],
    ['hits', 'long'],
    ['timestamp', 'date'],
  ]);
  return {
    fields: new Set(typeMap.keys()),
    typeMap,
    visibleIndices: ['logs', 'events', 'logs-2026.06.10', 'metrics'],
    isCalcite: true,
    dataSourceVersion: '3.7.0',
  };
}

/** Bucket → representative character length, for the report. */
export function bucketChars(bucket: SizeBucket): number {
  const sample = CORPUS.find((q) => q.bucket === bucket);
  return sample ? sample.ppl.length : 0;
}
