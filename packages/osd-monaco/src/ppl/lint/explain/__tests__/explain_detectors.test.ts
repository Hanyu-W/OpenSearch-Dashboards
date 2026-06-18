/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

import { CatalogEntry } from '../../types';
import { ExplainPlan } from '../explain_types';
import { operationNotPushedDetector } from '../rules/operation_not_pushed';
import { operationPushedAsScriptDetector } from '../rules/operation_pushed_as_script';

import aggNotPushedValues from '../__fixtures__/agg_not_pushed_values.json';
import deepPipe from '../__fixtures__/deep_pipe.json';
import evalDivScript from '../__fixtures__/eval_div_script.json';
import filterNotPushedWindow from '../__fixtures__/filter_not_pushed_window.json';
import filterPushed from '../__fixtures__/filter_pushed.json';
import filterScript from '../__fixtures__/filter_script.json';
import sortEval from '../__fixtures__/sort_eval.json';
import statsAgg from '../__fixtures__/stats_agg.json';

interface CalcitePayload {
  calcite: { logical: string; physical: string };
}

function toPlan(payload: CalcitePayload): ExplainPlan {
  return { isCalcite: true, physical: payload.calcite.physical, logical: payload.calcite.logical };
}

const NOT_PUSHED_CONFIG: CatalogEntry = {
  id: 'operation-not-pushed',
  detector: 'operation-not-pushed',
  enabled: true,
  severity: 'warning',
  message: 'fallback',
  docUrl: 'https://docs.opensearch.org/latest/sql-and-ppl/ppl/functions/',
  appliesTo: { minVersion: '3.3.0', engine: 'calcite' },
};

const PUSHED_AS_SCRIPT_CONFIG: CatalogEntry = {
  id: 'operation-pushed-as-script',
  detector: 'operation-pushed-as-script',
  enabled: true,
  severity: 'info',
  message: 'fallback',
  docUrl: 'https://docs.opensearch.org/latest/sql-and-ppl/ppl/functions/',
  appliesTo: { minVersion: '3.3.0', engine: 'calcite' },
};

// query text is only used to size the whole-query range; any string works here.
const CTX = { query: 'source=accounts | head 1' };

// The truth table from design §6.10, verified against the real engine payloads.
const FIXTURES: Array<{
  name: string;
  payload: CalcitePayload;
  notPushed: boolean;
  pushedAsScript: boolean;
}> = [
  {
    name: 'filter_pushed (where age > 30)',
    payload: filterPushed,
    notPushed: false,
    pushedAsScript: false,
  },
  {
    name: 'stats_agg (stats avg(age) by state)',
    payload: statsAgg,
    notPushed: false,
    pushedAsScript: false,
  },
  {
    name: 'deep_pipe (8-stage, all native)',
    payload: deepPipe,
    notPushed: false,
    pushedAsScript: false,
  },
  {
    name: 'filter_script (where age - 2 > 30)',
    payload: filterScript,
    notPushed: false,
    pushedAsScript: true,
  },
  {
    name: 'eval_div_script (eval r=balance/age | where r>100)',
    payload: evalDivScript,
    notPushed: false,
    pushedAsScript: true,
  },
  {
    name: 'sort_eval (eval x=age+balance | sort x)',
    payload: sortEval,
    notPushed: false,
    pushedAsScript: true,
  },
  {
    name: 'filter_not_pushed_window (eventstats avg | where)',
    payload: filterNotPushedWindow,
    notPushed: true,
    pushedAsScript: false,
  },
  {
    name: 'agg_not_pushed_values (stats values(state))',
    payload: aggNotPushedValues,
    notPushed: true,
    pushedAsScript: false,
  },
];

describe('explain detectors against captured engine payloads', () => {
  describe.each(FIXTURES)('$name', ({ payload, notPushed, pushedAsScript }) => {
    const plan = toPlan(payload);

    it(`operation-not-pushed ${notPushed ? 'fires' : 'stays silent'}`, () => {
      const diagnostics = operationNotPushedDetector(plan, NOT_PUSHED_CONFIG, CTX);
      expect(diagnostics.length > 0).toBe(notPushed);
      diagnostics.forEach((d) => expect(d.ruleId).toBe('operation-not-pushed'));
    });

    it(`operation-pushed-as-script ${pushedAsScript ? 'fires' : 'stays silent'}`, () => {
      const diagnostics = operationPushedAsScriptDetector(plan, PUSHED_AS_SCRIPT_CONFIG, CTX);
      expect(diagnostics.length > 0).toBe(pushedAsScript);
      diagnostics.forEach((d) => expect(d.ruleId).toBe('operation-pushed-as-script'));
    });
  });

  it('the two rules are mutually exclusive for every payload', () => {
    for (const { payload } of FIXTURES) {
      const plan = toPlan(payload);
      const a = operationNotPushedDetector(plan, NOT_PUSHED_CONFIG, CTX).length > 0;
      const b = operationPushedAsScriptDetector(plan, PUSHED_AS_SCRIPT_CONFIG, CTX).length > 0;
      expect(a && b).toBe(false);
    }
  });

  it('both detectors no-op when the plan is not Calcite', () => {
    const nonCalcite: ExplainPlan = { isCalcite: false, physical: '', logical: '' };
    expect(operationNotPushedDetector(nonCalcite, NOT_PUSHED_CONFIG, CTX)).toEqual([]);
    expect(operationPushedAsScriptDetector(nonCalcite, PUSHED_AS_SCRIPT_CONFIG, CTX)).toEqual([]);
  });

  it('emits a context-specific message and a whole-query range', () => {
    const plan = toPlan(aggNotPushedValues);
    const [diag] = operationNotPushedDetector(plan, NOT_PUSHED_CONFIG, {
      query: 'source=accounts | stats values(state)',
    });
    expect(diag.message).toContain('aggregation');
    // Whole-query range: starts at line 1 col 0, ends at a concrete in-bounds col.
    expect(diag.range.startLine).toBe(1);
    expect(diag.range.startColumn).toBe(0);
    expect(diag.range.endColumn).toBe('source=accounts | stats values(state)'.length);
    expect(Number.isFinite(diag.range.endColumn)).toBe(true);
  });
});

// Fixture-drift canary: if an engine upgrade changes the plan vocabulary, this
// fails loudly before the rules silently stop firing (design §7).
describe('fixture-drift canary', () => {
  it('filter_pushed still carries a native FILTER-> push tag', () => {
    expect(filterPushed.calcite.physical).toContain('FILTER->');
  });
  it('stats_agg still carries a native AGGREGATION-> push tag', () => {
    expect(statsAgg.calcite.physical).toContain('AGGREGATION->');
  });
  it('filter_script still carries SCRIPT-> + opensearch_compounded_script', () => {
    expect(filterScript.calcite.physical).toContain('SCRIPT->');
    expect(filterScript.calcite.physical).toContain('opensearch_compounded_script');
  });
  it('sort_eval still carries SORT_EXPR-> + opensearch_compounded_script', () => {
    expect(sortEval.calcite.physical).toContain('SORT_EXPR->');
    expect(sortEval.calcite.physical).toContain('opensearch_compounded_script');
  });
  it('filter_not_pushed_window still carries a residual $condition= with no push tag', () => {
    expect(filterNotPushedWindow.calcite.physical).toContain('$condition=');
    expect(filterNotPushedWindow.calcite.physical).not.toContain('FILTER->');
    expect(filterNotPushedWindow.calcite.physical).not.toContain('SCRIPT->');
  });
  it('agg_not_pushed_values still carries a residual EnumerableAggregate with no AGGREGATION->', () => {
    expect(aggNotPushedValues.calcite.physical).toContain('EnumerableAggregate');
    expect(aggNotPushedValues.calcite.physical).not.toContain('AGGREGATION->');
  });
  it('deep_pipe carries opensearch_compounded_script but no SCRIPT->/SORT_EXPR-> (no false positive)', () => {
    expect(deepPipe.calcite.physical).toContain('opensearch_compounded_script');
    expect(deepPipe.calcite.physical).not.toContain('SCRIPT->');
    expect(deepPipe.calcite.physical).not.toContain('SORT_EXPR->');
  });
});
