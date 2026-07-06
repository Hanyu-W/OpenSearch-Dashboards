/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

import { compiledSimplifiedSurface, resetSurfaceCache } from '../grammar_surface';
import { runLabeledCase } from '../behavioral_corpus';
import { LABELED_CASES, detectorBehaviorCaseCount } from '../corpus/labeled_cases';
import { runVersionContextMatrix, VERSION_CONTEXT_CASES } from '../version_context_matrix';

describe('Labeled behavioral corpus (Property 8: parsed, shape-checked, exact)', () => {
  beforeEach(resetSurfaceCache);

  it('every compiled-surface labeled case matches its expectation', () => {
    const surface = compiledSimplifiedSurface();
    for (const testCase of LABELED_CASES) {
      if (testCase.grammarSurface !== 'compiled_simplified') continue;
      const result = runLabeledCase(testCase, surface);
      if (!result.passing) {
        throw new Error(
          `${testCase.caseId}: ` +
            result.entries
              .filter((e) => e.status === 'failure')
              .map((e) => e.message)
              .join('; ')
        );
      }
      expect(result.passing).toBe(true);
    }
  });

  it('counts self-suppression cases separately from detector-behavior coverage', () => {
    const behaviorCount = detectorBehaviorCaseCount();
    const selfSuppress = LABELED_CASES.filter((c) => c.coverageLabel === 'self_suppression');
    expect(behaviorCount).toBeGreaterThan(0);
    expect(selfSuppress.length).toBeGreaterThan(0);
    // Self-suppression cases are not part of the behavior count.
    expect(behaviorCount).toBe(
      LABELED_CASES.filter((c) => c.coverageLabel === 'detector_behavior').length
    );
  });

  it('fails a detector-behavior case that is missing a required context resource', () => {
    const surface = compiledSimplifiedSurface();
    const bad = {
      caseId: 'ctx-incomplete',
      ruleId: 'field-validation',
      query: 'source=logs | where nope = 1',
      grammarSurface: 'compiled_simplified' as const,
      lintContext: {}, // missing fields
      expectedFires: true,
      expectedDiagnosticCount: 1,
      coverageLabel: 'detector_behavior' as const,
      requiredContextResources: ['fields' as const],
    };
    const result = runLabeledCase(bad, surface);
    expect(result.passing).toBe(false);
    expect(result.entries.some((e) => e.category === 'version-context')).toBe(true);
  });

  it('detects a false negative', () => {
    const surface = compiledSimplifiedSurface();
    const fn = {
      caseId: 'fn',
      ruleId: 'head-without-sort',
      query: 'source=logs | sort a | head 5', // does NOT fire
      grammarSurface: 'compiled_simplified' as const,
      lintContext: {},
      expectedFires: true, // but we claim it should
      expectedDiagnosticCount: 1,
      coverageLabel: 'detector_behavior' as const,
    };
    const result = runLabeledCase(fn, surface);
    expect(result.passing).toBe(false);
    expect(result.entries.some((e) => e.message.includes('False negative'))).toBe(true);
  });
});

describe('Version/context matrix (Property 9: explicitly routed)', () => {
  it('every version/context case matches its declared outcome', () => {
    const result = runVersionContextMatrix(VERSION_CONTEXT_CASES);
    if (!result.passing) {
      throw new Error(
        result.entries
          .filter((e) => e.status === 'failure')
          .map((e) => e.message)
          .join('; ')
      );
    }
    expect(result.passing).toBe(true);
  });

  it('exercises both sides of maxVersion via synthetic catalog cases', () => {
    const ids = VERSION_CONTEXT_CASES.map((c) => c.caseId);
    expect(ids).toEqual(
      expect.arrayContaining(['maxVersion-at-or-below-applies', 'maxVersion-above-skips'])
    );
  });
});
