/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  ExplainOutcome,
  ExplainOutcomeEvidence,
  ExplainPlan,
  ExplainRelNode,
} from './explain_types';
import {
  getPhysicalRels,
  getPushDownContext,
  getSourceBuilder,
  isResidualFilterRel,
  isResidualFilterRelOp,
  physicalPlanText,
} from './explain_tree_utils';

/** Increment when outcome interpretation changes so probe cache keys remain sound. */
export const EXPLAIN_OUTCOME_DETECTOR_VERSION = '3';

const SCRIPT_DISCRIMINATOR = 'opensearch_compounded_script';

/**
 * Join rel suffixes. Anchored suffix matching keeps this correct for both the
 * short rel names in older payloads (`EnumerableMergeJoin`) and the
 * fully-qualified class names real `json_tree` responses carry
 * (`org.apache.calcite.adapter.enumerable.EnumerableMergeJoin`). `in`/`exists`
 * subqueries compile to join rels too (semi HashJoin / NestedLoopJoin), so this
 * list covers them without a separate subquery operation.
 */
const JOIN_REL_SUFFIXES = ['MergeJoin', 'HashJoin', 'NestedLoopJoin'];

/** Rel suffix for an OpenSearch index scan (short or fully-qualified name). */
const SCAN_REL_SUFFIX = 'IndexScan';

/**
 * Coordinator outcomes that describe *bucket-space* work when the plan already
 * pushed its aggregation: with a single scan whose PushDownContext carries
 * `AGGREGATION->` (and no coordinator aggregate), every compute rel above the
 * scan operates on aggregation buckets, not raw rows — `top`/`rare` compile to
 * Window+Calc over the pushed aggregation, and a post-`stats` `where` is an
 * unpushable having-filter. Their cost is bounded by bucket count, not index
 * size, so reporting them as slow-path findings would be false positives.
 */
const BUCKET_SPACE_SUPPRESSED_OUTCOMES = new Set<ExplainOutcome>([
  'filter:coordinator',
  'sort:coordinator',
  'window:coordinator',
]);

interface PlanScanSignals {
  scanCount: number;
  hasPushedAggregation: boolean;
}

function suppressBucketSpaceOutcomes(
  evidence: ExplainOutcomeEvidence[],
  signals: PlanScanSignals
): ExplainOutcomeEvidence[] {
  const hasCoordinatorAggregate = evidence.some(
    ({ outcome }) => outcome === 'aggregation:coordinator'
  );
  if (signals.scanCount !== 1 || !signals.hasPushedAggregation || hasCoordinatorAggregate) {
    return evidence;
  }
  return evidence.filter(({ outcome }) => !BUCKET_SPACE_SUPPRESSED_OUTCOMES.has(outcome));
}

function add(
  evidence: ExplainOutcomeEvidence[],
  seen: Set<string>,
  outcome: ExplainOutcome,
  scope: string,
  format: 'tree' | 'legacy'
): void {
  const key = `${outcome}:${scope}:${format}`;
  if (!seen.has(key)) {
    seen.add(key);
    evidence.push({ outcome, scope, format });
  }
}

function relScope(rel: ExplainRelNode, index: number): string {
  return rel.id == null ? `rel:${index}` : `rel:${String(rel.id)}`;
}

/**
 * The per-relation signals both plan formats reduce to. Keeping the reduction
 * per scope (one rel, or one line of a legacy plan) is what makes the evidence
 * relation-local: a filter pushed on the scan cannot mask a residual filter on
 * a downstream Calc, and vice versa.
 */
interface ScopeSignals {
  /** The relation's operator name (text before `(` for a legacy line). */
  relOp: string;
  /** Text carrying push tags (`FILTER->` etc.) for this relation only. */
  pushDownText: string;
  /** Text carrying the compiled-script discriminator for this relation only. */
  scriptCarrierText: string;
  /** True when this relation carries a residual coordinator filter condition. */
  hasResidualCondition: boolean;
  scope: string;
}

/**
 * The single signal cascade shared by the tree and legacy paths, so the two
 * formats cannot drift in how they classify the same query.
 *
 * Coordinator aggregation/sort match on the relOp *suffix*: Calcite rel names
 * are `<Convention><Operator>` (EnumerableAggregate, EnumerableSortedAggregate,
 * EnumerableSort), so a suffix match is anchored — a bare substring match would
 * misread EnumerableSortMergeJoin (a join, not a sort) as a coordinator sort
 * and miss EnumerableSortedAggregate (which does not contain
 * "EnumerableAggregate").
 */
function addScopeOutcomes(
  evidence: ExplainOutcomeEvidence[],
  seen: Set<string>,
  signals: ScopeSignals,
  format: 'tree' | 'legacy'
): void {
  const { relOp, pushDownText, scriptCarrierText, hasResidualCondition, scope } = signals;
  const hasFilter = pushDownText.includes('FILTER->');
  const hasFilterScript =
    pushDownText.includes('SCRIPT->') && scriptCarrierText.includes(SCRIPT_DISCRIMINATOR);
  const hasAggregation = pushDownText.includes('AGGREGATION->');
  const hasSortExpression =
    pushDownText.includes('SORT_EXPR->') && scriptCarrierText.includes(SCRIPT_DISCRIMINATOR);
  const hasSort = pushDownText.includes('SORT->');

  if (hasFilter) {
    add(evidence, seen, 'filter:native', scope, format);
  }
  if (hasFilterScript) {
    add(evidence, seen, 'filter:script', scope, format);
  }
  if (hasResidualCondition && !hasFilter && !hasFilterScript) {
    add(evidence, seen, 'filter:coordinator', scope, format);
  }

  if (hasAggregation) {
    add(evidence, seen, 'aggregation:native', scope, format);
  }
  if (relOp.endsWith('Aggregate') && !hasAggregation) {
    add(evidence, seen, 'aggregation:coordinator', scope, format);
  }

  if (hasSort) {
    add(evidence, seen, 'sort:native', scope, format);
  }
  if (hasSortExpression) {
    add(evidence, seen, 'sort:script', scope, format);
  }
  if (relOp.endsWith('Sort') && !hasSort && !hasSortExpression) {
    add(evidence, seen, 'sort:coordinator', scope, format);
  }

  // Window and join rels only ever appear above the scan; the engine has no
  // push tag for them, so their presence alone means coordinator execution.
  // (`EnumerableSortMergeJoin` ends with `MergeJoin`, not `Sort`, so the sort
  // branch above cannot double-report a join.)
  if (relOp.endsWith('Window')) {
    add(evidence, seen, 'window:coordinator', scope, format);
  }
  if (JOIN_REL_SUFFIXES.some((suffix) => relOp.endsWith(suffix))) {
    add(evidence, seen, 'join:coordinator', scope, format);
  }
}

function detectTreeOutcomes(plan: ExplainPlan): ExplainOutcomeEvidence[] {
  const evidence: ExplainOutcomeEvidence[] = [];
  const seen = new Set<string>();
  const scanSignals: PlanScanSignals = { scanCount: 0, hasPushedAggregation: false };

  getPhysicalRels(plan).forEach((rel, index) => {
    const relOp = String(rel.relOp ?? '');
    const pushDownText = getPushDownContext(rel);
    if (relOp.endsWith(SCAN_REL_SUFFIX)) {
      scanSignals.scanCount += 1;
      scanSignals.hasPushedAggregation =
        scanSignals.hasPushedAggregation || pushDownText.includes('AGGREGATION->');
    }
    addScopeOutcomes(
      evidence,
      seen,
      {
        relOp,
        pushDownText,
        scriptCarrierText: getSourceBuilder(rel),
        hasResidualCondition: isResidualFilterRel(rel),
        scope: relScope(rel, index),
      },
      'tree'
    );
  });

  return suppressBucketSpaceOutcomes(evidence, scanSignals);
}

/** The relation's operator name on one line of a formatted legacy plan. */
function parseLegacyRelOp(line: string): string {
  const trimmed = line.trimStart();
  const parenIndex = trimmed.indexOf('(');
  return (parenIndex === -1 ? trimmed : trimmed.slice(0, parenIndex)).trim();
}

/**
 * Legacy plans expose one formatted string with one relation per line, so the
 * per-line pass keeps the same relation-locality as the tree path: a `FILTER->`
 * pushed on the index-scan line cannot mask a residual `$condition=` on a
 * downstream Calc line (partial pushdown, e.g. a second `where` after
 * `eventstats`). Recognize the version-tested tags and residual operators, but
 * never infer source ownership from them.
 */
function detectLegacyOutcomes(plan: ExplainPlan): ExplainOutcomeEvidence[] {
  const text = physicalPlanText(plan);
  if (!text) {
    return [];
  }

  const evidence: ExplainOutcomeEvidence[] = [];
  const seen = new Set<string>();
  const scanSignals: PlanScanSignals = { scanCount: 0, hasPushedAggregation: false };

  text.split('\n').forEach((line, index) => {
    const relOp = parseLegacyRelOp(line);
    if (!relOp) {
      return;
    }
    if (relOp.endsWith(SCAN_REL_SUFFIX)) {
      scanSignals.scanCount += 1;
      scanSignals.hasPushedAggregation =
        scanSignals.hasPushedAggregation || line.includes('AGGREGATION->');
    }
    addScopeOutcomes(
      evidence,
      seen,
      {
        relOp,
        pushDownText: line,
        scriptCarrierText: line,
        hasResidualCondition: isResidualFilterRelOp(relOp) && line.includes('$condition='),
        scope: `line:${index}`,
      },
      'legacy'
    );
  });

  return suppressBucketSpaceOutcomes(evidence, scanSignals);
}

export function detectExplainOutcomes(plan: ExplainPlan): ExplainOutcomeEvidence[] {
  if (!plan.isCalcite) {
    return [];
  }
  // toExplainPlan makes the formats mutually exclusive per field: `physical` is
  // either a rel tree or a legacy string, never both. An unrecognized tree
  // fails closed (no evidence) rather than falling back to text it cannot have.
  return plan.physicalTree ? detectTreeOutcomes(plan) : detectLegacyOutcomes(plan);
}

export function hasExplainOutcome(plan: ExplainPlan, outcome: ExplainOutcome): boolean {
  return detectExplainOutcomes(plan).some((evidence) => evidence.outcome === outcome);
}
