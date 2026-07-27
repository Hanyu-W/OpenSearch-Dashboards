/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

import { detectExplainOutcomes } from '../explain_outcomes';
import { ExplainPlan, ExplainRelTree } from '../explain_types';

import havingOverPushedAggTree from '../__fixtures__/having_over_pushed_agg_tree.json';
import sortTextTopkLegacy from '../__fixtures__/sort_text_topk_legacy.json';
import sortTextTopkTree from '../__fixtures__/sort_text_topk_tree.json';
import joinMergeJoinLegacy from '../__fixtures__/join_mergejoin_legacy.json';
import joinMergeJoinTree from '../__fixtures__/join_mergejoin_tree.json';
import subqueryInSemijoinTree from '../__fixtures__/subquery_in_semijoin_tree.json';
import topOverPushedAggLegacy from '../__fixtures__/top_over_pushed_agg_legacy.json';
import topOverPushedAggTree from '../__fixtures__/top_over_pushed_agg_tree.json';
import windowEventstatsLegacy from '../__fixtures__/window_eventstats_legacy.json';
import windowEventstatsTree from '../__fixtures__/window_eventstats_tree.json';

/**
 * Captured live from `POST /_plugins/_ppl/_explain?format=json_tree` on a
 * 3.8.0-SNAPSHOT engine — rel names are fully-qualified Java class names
 * (`org.apache.calcite.adapter.enumerable.EnumerableWindow`), unlike the
 * hand-written short-name fixtures elsewhere in this suite.
 */
function capturedTreePlan(payload: { calcite: { physical: unknown } }): ExplainPlan {
  return {
    isCalcite: true,
    physicalTree: payload.calcite.physical as ExplainRelTree,
  };
}

/** Captured live from a 3.6 engine, which only emits formatted string plans. */
function capturedLegacyPlan(payload: { calcite: { physical: unknown } }): ExplainPlan {
  return {
    isCalcite: true,
    physicalText: String(payload.calcite.physical),
  };
}

describe('detectExplainOutcomes', () => {
  it('keeps tree evidence relation-local so a native filter cannot hide a residual filter', () => {
    const plan: ExplainPlan = {
      isCalcite: true,
      physicalTree: {
        rels: [
          {
            id: 'scan',
            relOp: 'CalciteEnumerableIndexScan',
            PushDownContext: ['FILTER->>($0, 1)'],
          },
          {
            id: 'calc',
            relOp: 'EnumerableCalc',
            $condition: '[$t2]',
          },
        ],
      },
    };

    expect(detectExplainOutcomes(plan)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ outcome: 'filter:native', scope: 'rel:scan' }),
        expect.objectContaining({ outcome: 'filter:coordinator', scope: 'rel:calc' }),
      ])
    );
  });

  it('requires a script tag and discriminator on the same tree relation', () => {
    const plan: ExplainPlan = {
      isCalcite: true,
      physicalTree: {
        rels: [
          {
            id: 'tag',
            relOp: 'CalciteEnumerableIndexScan',
            PushDownContext: ['SCRIPT->>($0, 1)'],
          },
          {
            id: 'builder',
            relOp: 'EnumerableCalc',
            sourceBuilder: { lang: 'opensearch_compounded_script' },
          },
        ],
      },
    };

    expect(detectExplainOutcomes(plan).map(({ outcome }) => outcome)).not.toContain(
      'filter:script'
    );
  });

  it('recognizes native, scripted, and coordinator sort outcomes', () => {
    const native: ExplainPlan = {
      isCalcite: true,
      physicalText: 'CalciteEnumerableIndexScan(PushDownContext=[[SORT->[bytes ASC]]])',
    };
    const script: ExplainPlan = {
      isCalcite: true,
      physicalText:
        'CalciteEnumerableIndexScan(PushDownContext=[[SORT_EXPR->[x ASC]]], sourceBuilder=opensearch_compounded_script)',
    };
    const coordinator: ExplainPlan = {
      isCalcite: true,
      physicalText: 'EnumerableSort(input=EnumerableCalc)',
    };

    expect(detectExplainOutcomes(native).map(({ outcome }) => outcome)).toContain('sort:native');
    expect(detectExplainOutcomes(script).map(({ outcome }) => outcome)).toContain('sort:script');
    expect(detectExplainOutcomes(coordinator).map(({ outcome }) => outcome)).toContain(
      'sort:coordinator'
    );
  });

  it('fails closed for unknown tree fields and non-Calcite plans', () => {
    expect(
      detectExplainOutcomes({
        isCalcite: true,
        physicalTree: { rels: [{ relOp: 'FutureRel', PushDownContext: ['FAST_FILTER'] }] },
      })
    ).toEqual([]);
    expect(detectExplainOutcomes({ isCalcite: false })).toEqual([]);
  });

  it('keeps legacy text evidence line-local so a pushed filter cannot mask a residual filter', () => {
    // Partial pushdown (e.g. `where age > 30 | eventstats ... | where balance > ab`):
    // the scan line carries FILTER-> while a downstream Calc line carries a
    // residual $condition. Plan-wide matching would suppress the coordinator
    // signal; per-line matching must surface both.
    const plan: ExplainPlan = {
      isCalcite: true,
      physicalText:
        'EnumerableLimit(fetch=[10000])\n' +
        '  EnumerableCalc(expr#0..2=[{inputs}], balance=[$t0], $condition=[$t5])\n' +
        '    CalciteEnumerableIndexScan(table=[[OpenSearch, accounts]], PushDownContext=[[FILTER->>($0, 30)]])\n',
    };

    const outcomes = detectExplainOutcomes(plan).map(({ outcome }) => outcome);
    expect(outcomes).toContain('filter:native');
    expect(outcomes).toContain('filter:coordinator');
  });

  it('does not read a join condition as a residual filter (tree and legacy)', () => {
    // Calcite join rels serialize their join predicate as a `condition`
    // attribute; a join condition always evaluates at the coordinator by design
    // and is not a filter that failed to push down.
    const tree: ExplainPlan = {
      isCalcite: true,
      physicalTree: {
        rels: [
          {
            id: 'join',
            relOp: 'EnumerableHashJoin',
            condition: { op: '=', operands: [0, 1] },
            joinType: 'inner',
          },
        ],
      },
    };
    const legacy: ExplainPlan = {
      isCalcite: true,
      physicalText: 'EnumerableHashJoin(condition=[=($0, $1)], joinType=[inner])',
    };

    expect(detectExplainOutcomes(tree).map(({ outcome }) => outcome)).not.toContain(
      'filter:coordinator'
    );
    expect(detectExplainOutcomes(legacy).map(({ outcome }) => outcome)).not.toContain(
      'filter:coordinator'
    );
  });

  it('anchors coordinator sort/aggregation on the relOp suffix, not a substring', () => {
    // EnumerableSortMergeJoin is a join, not a sort: a substring match on
    // 'EnumerableSort' would misfire on it. EnumerableSortedAggregate IS a
    // coordinator aggregate: a substring match on 'EnumerableAggregate' would
    // miss it.
    const sortMergeJoin: ExplainPlan = {
      isCalcite: true,
      physicalTree: { rels: [{ relOp: 'EnumerableSortMergeJoin' }] },
    };
    const sortedAggregate: ExplainPlan = {
      isCalcite: true,
      physicalTree: { rels: [{ relOp: 'EnumerableSortedAggregate' }] },
    };

    expect(detectExplainOutcomes(sortMergeJoin).map(({ outcome }) => outcome)).not.toContain(
      'sort:coordinator'
    );
    expect(detectExplainOutcomes(sortedAggregate).map(({ outcome }) => outcome)).toContain(
      'aggregation:coordinator'
    );
  });

  it('reports a coordinator window from a live FQCN tree plan and its 3.6 legacy twin', () => {
    // source=... | eventstats avg(...) | head 5
    const treeOutcomes = detectExplainOutcomes(capturedTreePlan(windowEventstatsTree)).map(
      ({ outcome }) => outcome
    );
    const legacyOutcomes = detectExplainOutcomes(capturedLegacyPlan(windowEventstatsLegacy)).map(
      ({ outcome }) => outcome
    );

    expect(treeOutcomes).toContain('window:coordinator');
    expect(legacyOutcomes).toContain('window:coordinator');
    // The scan pushed no aggregation, so nothing suppresses the window outcome,
    // and the projection-only Calc above the window must not read as a filter.
    expect(treeOutcomes).not.toContain('filter:coordinator');
  });

  it('reports a coordinator join for join and in-subquery plans without misreading sort/filter', () => {
    // `EnumerableMergeJoin` / semi `EnumerableHashJoin`; subqueries have no
    // Correlate rel on the live engine — they are join rels too.
    const joinTree = detectExplainOutcomes(capturedTreePlan(joinMergeJoinTree)).map(
      ({ outcome }) => outcome
    );
    const joinLegacy = detectExplainOutcomes(capturedLegacyPlan(joinMergeJoinLegacy)).map(
      ({ outcome }) => outcome
    );
    const semiJoinTree = detectExplainOutcomes(capturedTreePlan(subqueryInSemijoinTree)).map(
      ({ outcome }) => outcome
    );

    expect(joinTree).toContain('join:coordinator');
    expect(joinLegacy).toContain('join:coordinator');
    expect(semiJoinTree).toContain('join:coordinator');
    // A join condition is not a residual filter, and a MergeJoin is not a sort.
    expect(joinTree).not.toContain('filter:coordinator');
    expect(joinTree).not.toContain('sort:coordinator');
  });

  it('suppresses bucket-space outcomes above a pushed single-scan aggregation', () => {
    // `top 3 state` compiles to Window+Calc($condition) OVER a pushed
    // AGGREGATION->: those rels process buckets, not rows, so neither a window
    // nor a filter coordinator outcome may fire. Same for a post-stats `where`
    // (having): the filter runs over buckets.
    const topTree = detectExplainOutcomes(capturedTreePlan(topOverPushedAggTree)).map(
      ({ outcome }) => outcome
    );
    const topLegacy = detectExplainOutcomes(capturedLegacyPlan(topOverPushedAggLegacy)).map(
      ({ outcome }) => outcome
    );
    const havingTree = detectExplainOutcomes(capturedTreePlan(havingOverPushedAggTree)).map(
      ({ outcome }) => outcome
    );

    for (const outcomes of [topTree, topLegacy, havingTree]) {
      expect(outcomes).toContain('aggregation:native');
      expect(outcomes).not.toContain('window:coordinator');
      expect(outcomes).not.toContain('filter:coordinator');
      expect(outcomes).not.toContain('sort:coordinator');
    }
  });

  it('reports a coordinator sort for TopK over a raw-row scan (text sort key)', () => {
    // `sort <text-field> | head N`: text has no doc values, the sort cannot
    // push, and the engine emits CalciteEnumerableTopK above a scan whose
    // PushDownContext carries only PROJECT->. That is a coordinator sort. The
    // benign TopK shape (over a pushed aggregation) is covered by the
    // bucket-space suppression test above via the deep_pipe detector case.
    const treeOutcomes = detectExplainOutcomes(capturedTreePlan(sortTextTopkTree)).map(
      ({ outcome }) => outcome
    );
    const legacyOutcomes = detectExplainOutcomes(capturedLegacyPlan(sortTextTopkLegacy)).map(
      ({ outcome }) => outcome
    );

    expect(treeOutcomes).toContain('sort:coordinator');
    expect(legacyOutcomes).toContain('sort:coordinator');
    expect(treeOutcomes).not.toContain('filter:coordinator');
  });

  it('does not suppress row-space outcomes: multi-scan joins and unpushed aggregations keep firing', () => {
    // Two scans (join): even though each scan pushed work, the join and any
    // residual rels above it are row-space and must be reported.
    const joinOutcomes = detectExplainOutcomes(capturedTreePlan(joinMergeJoinTree)).map(
      ({ outcome }) => outcome
    );
    expect(joinOutcomes).toContain('join:coordinator');

    // Single scan but the aggregation itself stayed in the coordinator: rels
    // above it are NOT bucket-space (the scan streams raw rows), so a window
    // above an EnumerableAggregate keeps firing.
    const coordinatorAggWithWindow: ExplainPlan = {
      isCalcite: true,
      physicalTree: {
        rels: [
          {
            id: '0',
            relOp: 'org.opensearch.sql.opensearch.storage.scan.CalciteEnumerableIndexScan',
            PushDownContext: ['PROJECT->[name]'],
          },
          { id: '1', relOp: 'org.apache.calcite.adapter.enumerable.EnumerableAggregate' },
          { id: '2', relOp: 'org.apache.calcite.adapter.enumerable.EnumerableWindow' },
        ],
      },
    };
    const outcomes = detectExplainOutcomes(coordinatorAggWithWindow).map(({ outcome }) => outcome);
    expect(outcomes).toContain('aggregation:coordinator');
    expect(outcomes).toContain('window:coordinator');
  });
});
