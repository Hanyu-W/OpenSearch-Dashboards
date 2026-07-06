/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

import { LabeledQueryCase } from '../behavioral_corpus';

/**
 * High-signal labeled behavioral cases exercised against the real detectors on
 * the compiled surface. Context-gated cases include the required lint metadata
 * and are labeled `detector_behavior`; empty-context cases are labeled
 * `self_suppression` so they do not count as behavior coverage (R9.1, R9.2).
 *
 * Field/type metadata is grounded in what each detector consumes:
 *  - field-validation reads `fields` (known field set).
 *  - division-by-zero is context-free (fires on `/ 0` regardless of context).
 *  - head-without-sort is context-free.
 */
export const LABELED_CASES: readonly LabeledQueryCase[] = [
  // division-by-zero — context-free, literal zero divisor variants.
  {
    caseId: 'div-zero-literal',
    ruleId: 'division-by-zero',
    query: 'source=t | eval x = a / 0',
    grammarSurface: 'compiled_simplified',
    lintContext: {},
    expectedFires: true,
    expectedDiagnosticCount: 1,
    coverageLabel: 'detector_behavior',
  },
  {
    caseId: 'div-zero-decimal',
    ruleId: 'division-by-zero',
    query: 'source=t | eval x = a / 0.0',
    grammarSurface: 'compiled_simplified',
    lintContext: {},
    expectedFires: true,
    expectedDiagnosticCount: 1,
    coverageLabel: 'detector_behavior',
  },
  {
    caseId: 'div-zero-paren',
    ruleId: 'division-by-zero',
    query: 'source=t | eval x = a / (0)',
    grammarSurface: 'compiled_simplified',
    lintContext: {},
    expectedFires: true,
    expectedDiagnosticCount: 1,
    coverageLabel: 'detector_behavior',
  },
  {
    caseId: 'div-nonzero-literal',
    ruleId: 'division-by-zero',
    query: 'source=t | eval x = a / 2',
    grammarSurface: 'compiled_simplified',
    lintContext: {},
    expectedFires: false,
    expectedDiagnosticCount: 0,
    coverageLabel: 'detector_behavior',
  },
  {
    caseId: 'div-field-denominator',
    ruleId: 'division-by-zero',
    query: 'source=t | eval x = a / b',
    grammarSurface: 'compiled_simplified',
    lintContext: {},
    expectedFires: false,
    expectedDiagnosticCount: 0,
    coverageLabel: 'detector_behavior',
  },

  // field-validation — context-gated on `fields`. Note: `source` is included in
  // every field set because the `source=<table>` clause on this branch surfaces
  // the `source` keyword to the existence pass (a latent artifact fixed on the
  // pr4 branch via a SOURCE_KEYWORDS skip). Including it isolates the detector's
  // real field-resolution behavior from that unrelated artifact.
  {
    caseId: 'field-known',
    ruleId: 'field-validation',
    query: 'source=t | where status = 200',
    grammarSurface: 'compiled_simplified',
    lintContext: { fields: new Set(['status', 'source']) },
    expectedFires: false,
    expectedDiagnosticCount: 0,
    coverageLabel: 'detector_behavior',
    requiredContextResources: ['fields'],
  },
  {
    caseId: 'field-unknown',
    ruleId: 'field-validation',
    query: 'source=t | where nope = 200',
    grammarSurface: 'compiled_simplified',
    lintContext: { fields: new Set(['status', 'source']) },
    expectedFires: true,
    expectedDiagnosticCount: 1,
    coverageLabel: 'detector_behavior',
    requiredContextResources: ['fields'],
  },
  {
    caseId: 'field-created-upstream',
    ruleId: 'field-validation',
    query: 'source=t | eval created = 1 | where created = 1',
    grammarSurface: 'compiled_simplified',
    lintContext: { fields: new Set(['status', 'source']) },
    expectedFires: false,
    expectedDiagnosticCount: 0,
    coverageLabel: 'detector_behavior',
    requiredContextResources: ['fields'],
  },
  {
    // All field refs here live inside the pruned lookupCommand subtree, so this
    // verifies alternate-source SUPPRESSION, not field-resolution — labeled
    // setup_only so it does not inflate detector-behavior coverage.
    caseId: 'field-alt-source-lookup',
    ruleId: 'field-validation',
    query: 'source=t | lookup ref_table id',
    grammarSurface: 'compiled_simplified',
    lintContext: { fields: new Set(['status', 'source']) },
    expectedFires: false,
    expectedDiagnosticCount: 0,
    coverageLabel: 'setup_only',
  },
  // Empty-context self-suppression: labeled so it is NOT counted as behavior
  // coverage. field-validation must NOT fire without a field set.
  {
    caseId: 'field-empty-context-self-suppress',
    ruleId: 'field-validation',
    query: 'source=t | where nope = 200',
    grammarSurface: 'compiled_simplified',
    lintContext: {},
    expectedFires: false,
    expectedDiagnosticCount: 0,
    coverageLabel: 'self_suppression',
  },
  // Pins the CURRENT source-keyword behavior on this branch: with only `status`
  // in the field set (no `source`), the `source=t` clause surfaces the `source`
  // keyword to the existence pass as an unknown field. This is a latent artifact
  // fixed on the pr4 branch (SOURCE_KEYWORDS skip); pinning it here means the
  // fix — or any regression — will flip this case and force a corpus update,
  // rather than the drift passing silently. setup_only: it locks branch behavior,
  // not the detector's field-resolution logic.
  {
    caseId: 'field-source-keyword-artifact-2-diagnostics',
    ruleId: 'field-validation',
    query: 'source=t | where nope = 200',
    grammarSurface: 'compiled_simplified',
    lintContext: { fields: new Set(['status']) },
    expectedFires: true,
    expectedDiagnosticCount: 2, // `source` (artifact) + `nope` (real)
    coverageLabel: 'setup_only',
  },

  // head-without-sort — context-free ordering advisory.
  {
    caseId: 'head-without-sort-fires',
    ruleId: 'head-without-sort',
    query: 'source=t | head 5',
    grammarSurface: 'compiled_simplified',
    lintContext: {},
    expectedFires: true,
    expectedDiagnosticCount: 1,
    coverageLabel: 'detector_behavior',
  },
  {
    caseId: 'head-with-sort-quiet',
    ruleId: 'head-without-sort',
    query: 'source=t | sort age | head 5',
    grammarSurface: 'compiled_simplified',
    lintContext: {},
    expectedFires: false,
    expectedDiagnosticCount: 0,
    coverageLabel: 'detector_behavior',
  },
];

/**
 * The number of cases that count as detector-behavior coverage (excludes
 * self_suppression / setup_only). Used to assert the corpus actually exercises
 * detectors rather than relying on empty-context suppression.
 */
export function detectorBehaviorCaseCount(
  cases: readonly LabeledQueryCase[] = LABELED_CASES
): number {
  return cases.filter((c) => c.coverageLabel === 'detector_behavior').length;
}
