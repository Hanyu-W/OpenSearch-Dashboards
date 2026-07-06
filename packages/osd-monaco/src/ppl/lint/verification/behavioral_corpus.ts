/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

import { runLint } from '../lint_runner';
import { getBundledCatalog } from '../catalog';
import { LintRunContext } from '../types';
import { GrammarSurface } from './grammar_surface';
import { evaluateShapeAssertion } from './shape_evaluator';
import { ShapeAssertion, SurfaceName, VerificationResult } from './types';

/**
 * A labeled behavioral case run through the real detectors. `coverageLabel`
 * distinguishes true detector-behavior coverage from empty-context
 * self-suppression (which must not count as behavior coverage — R9.2).
 */
export interface LabeledQueryCase {
  caseId: string;
  ruleId: string;
  query: string;
  grammarSurface: SurfaceName;
  lintContext: LintRunContext;
  expectedFires: boolean;
  expectedDiagnosticCount: number;
  requiredShape?: ShapeAssertion;
  coverageLabel: 'detector_behavior' | 'self_suppression' | 'setup_only';
  /** Lint context resources this rule requires when labeled detector_behavior. */
  requiredContextResources?: ReadonlyArray<keyof LintRunContext>;
}

/**
 * Run a labeled case: parse on its surface, evaluate any required shape before
 * comparing diagnostics, verify context-completeness for detector-behavior
 * cases, then compare rule-id presence and exact diagnostic count. Distinguishes
 * parse failure, shape failure, context-incomplete setup, false negative, false
 * positive, and diagnostic-count drift (R8.1-R8.8, R9.1, R9.7).
 */
export function runLabeledCase(
  testCase: LabeledQueryCase,
  surface: GrammarSurface
): VerificationResult {
  const ctx = { rule: testCase.ruleId, query: testCase.query, surface: surface.name };

  // Parse first.
  let tree;
  try {
    tree = surface.parse(testCase.query);
  } catch (e) {
    return single(
      'behavioral',
      'failure',
      `Parse failed: ${e instanceof Error ? e.message : String(e)}`,
      ctx
    );
  }

  // Required shape before diagnostics.
  if (testCase.requiredShape) {
    const shape = evaluateShapeAssertion(testCase.requiredShape, surface);
    if (!shape.passing) {
      return {
        category: 'behavioral',
        passing: false,
        entries: [
          {
            category: 'behavioral',
            status: 'failure',
            message: `Required shape "${testCase.requiredShape.assertionId}" failed; skipping diagnostic comparison.`,
            context: ctx,
          },
        ],
      };
    }
  }

  // Context-completeness for detector-behavior cases (R9.7).
  if (testCase.coverageLabel === 'detector_behavior' && testCase.requiredContextResources) {
    const missing = testCase.requiredContextResources.filter((key) =>
      isResourceEmpty(testCase.lintContext, key)
    );
    if (missing.length > 0) {
      return single(
        'version-context',
        'failure',
        `Case labeled detector_behavior is missing required context resources: ${missing.join(
          ', '
        )}.`,
        ctx
      );
    }
  }

  const diagnostics = runLint(tree, {
    ruleNameToIndex: surface.ruleNameToIndex,
    catalog: getBundledCatalog(),
    context: testCase.lintContext,
    dataSourceVersion: testCase.lintContext.dataSourceVersion,
  });
  const actualCount = diagnostics.filter((d) => d.ruleId === testCase.ruleId).length;

  if (testCase.expectedFires && actualCount === 0) {
    return single(
      'behavioral',
      'failure',
      `False negative: expected "${testCase.ruleId}" to fire, got none.`,
      ctx
    );
  }
  if (!testCase.expectedFires && actualCount > 0) {
    return single(
      'behavioral',
      'failure',
      `False positive: expected "${testCase.ruleId}" not to fire, got ${actualCount}.`,
      ctx
    );
  }
  if (actualCount !== testCase.expectedDiagnosticCount) {
    return single(
      'behavioral',
      'failure',
      `Diagnostic-count drift for "${testCase.ruleId}": expected ${testCase.expectedDiagnosticCount}, got ${actualCount}.`,
      ctx
    );
  }

  return single('behavioral', 'pass', `Case "${testCase.caseId}" matched expectation.`, ctx);
}

/** True when a lint-context resource is absent or empty. */
function isResourceEmpty(context: LintRunContext, key: keyof LintRunContext): boolean {
  const value = context[key];
  if (value == null) {
    return true;
  }
  if (value instanceof Set || value instanceof Map) {
    return value.size === 0;
  }
  if (Array.isArray(value)) {
    return value.length === 0;
  }
  return false;
}

function single(
  category: VerificationResult['category'],
  status: 'pass' | 'failure',
  message: string,
  context: { rule?: string; query?: string; surface?: SurfaceName }
): VerificationResult {
  return {
    category,
    passing: status !== 'failure',
    entries: [{ category, status, message, context }],
  };
}
