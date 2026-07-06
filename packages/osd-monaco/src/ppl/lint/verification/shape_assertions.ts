/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

import { ShapeAssertion } from './types';

/**
 * Canonical parse-shape assumptions detectors depend on but that rule-name
 * resolution alone cannot prove (R7.5). Each names its rule id, the surfaces it
 * applies to, a canonical query, the anchors it expects to resolve exactly once,
 * and the relationships that must hold between them.
 *
 * Anchor rule names and cardinalities are grounded in the ACTUAL compiled
 * grammar parse trees (verified by dumping the trees), not assumed:
 *  - division-by-zero: `a / 0` yields `valueExpression` nodes ["a/0","0","a"];
 *    the anchor targets the whole `a/0` arithmetic expression. (Note: `field` is
 *    a near-keyword and misparses to `logicalExpression`, so a neutral
 *    identifier like `a` is used — division_by_zero.ts navigates valueExpression.)
 *  - eval-created field: `eval created = 1` yields a `fieldExpression` whose text
 *    is `created` (pipeline_shape.ts collectCreatedFields reads evalClause).
 *  - AS-created field: `stats count() as total` names the alias via a
 *    `wcFieldExpression`/`wcQualifiedName` chain (NOT a plain `fieldExpression`).
 *  - alternate-source pruning: `lookup ref_table id` yields exactly one
 *    `lookupCommand` (collectAlternateSourceSubtrees prunes it).
 *
 * All shape assertions are scoped to `compiled_simplified` — the surface the
 * lint plugin ships and the detectors actually run against. The in-repo full
 * proxy (~114 rules) lacks several of these rules, so it is explicitly
 * not-applicable rather than a silent skip.
 */
export const SHAPE_ASSERTIONS: readonly ShapeAssertion[] = Object.freeze([
  {
    assertionId: 'division-by-zero-divisor-layout',
    ruleId: 'division-by-zero',
    applicableSurfaces: ['compiled_simplified'],
    notApplicableSurfaces: ['in_repo_full_proxy', 'runtime_fixture'],
    canonicalQuery: 'source=logs | eval x = a / 0',
    expectedAnchors: [
      {
        name: 'divisorExpr',
        ruleName: 'valueExpression',
        predicate: { kind: 'equals', value: 'a/0' },
      },
    ],
    expectedRelationships: [],
  },
  {
    assertionId: 'eval-created-field-layout',
    ruleId: 'field-validation',
    applicableSurfaces: ['compiled_simplified'],
    notApplicableSurfaces: ['in_repo_full_proxy', 'runtime_fixture'],
    canonicalQuery: 'source=t | eval created = 1',
    expectedAnchors: [
      { name: 'evalClause', ruleName: 'evalClause' },
      { name: 'newField', ruleName: 'fieldExpression', text: 'created' },
    ],
    expectedRelationships: [
      { kind: 'ancestor_of', ancestor: 'evalClause', descendant: 'newField' },
    ],
  },
  {
    assertionId: 'as-created-field-layout',
    ruleId: 'field-validation',
    applicableSurfaces: ['compiled_simplified'],
    notApplicableSurfaces: ['in_repo_full_proxy', 'runtime_fixture'],
    canonicalQuery: 'source=t | stats count() as total',
    expectedAnchors: [
      { name: 'statsCmd', ruleName: 'statsCommand' },
      { name: 'aliasField', ruleName: 'wcFieldExpression', text: 'total' },
    ],
    expectedRelationships: [
      { kind: 'ancestor_of', ancestor: 'statsCmd', descendant: 'aliasField' },
    ],
  },
  {
    assertionId: 'alternate-source-pruning',
    ruleId: 'field-validation',
    applicableSurfaces: ['compiled_simplified'],
    notApplicableSurfaces: ['in_repo_full_proxy', 'runtime_fixture'],
    canonicalQuery: 'source=t | lookup ref_table id',
    expectedAnchors: [{ name: 'lookupCmd', ruleName: 'lookupCommand' }],
    expectedRelationships: [],
  },
  {
    assertionId: 'field-slot-grammar-behavior',
    ruleId: 'field-validation',
    // `grok field=body` misparses to a comparison whose left operand is a
    // fieldExpression. The compiled surface reproduces the grok command shape;
    // the shape pass itself gates on the runtime surface, but the STRUCTURE is
    // present on the compiled surface, which is what this assertion checks.
    applicableSurfaces: ['compiled_simplified'],
    notApplicableSurfaces: ['in_repo_full_proxy', 'runtime_fixture'],
    canonicalQuery: 'source=t | grok field=body "x"',
    expectedAnchors: [{ name: 'grokCmd', ruleName: 'grokCommand' }],
    expectedRelationships: [],
  },
]);
