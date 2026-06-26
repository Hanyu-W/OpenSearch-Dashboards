/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

import { AI_FIXABLE_RULES, isAiFixableRule } from '../ai_fixable_rules';

describe('AI-fixable rule registry', () => {
  it('includes the no-deterministic-template rules', () => {
    expect(isAiFixableRule('type-mismatch-numeric')).toBe(true);
    expect(isAiFixableRule('enabled-false-object')).toBe(true);
    expect(isAiFixableRule('flat-object-subfield')).toBe(true);
    expect(isAiFixableRule('agg-on-text')).toBe(true);
  });

  it('excludes rules that already ship a deterministic fix (Idea V)', () => {
    // field-validation has a Levenshtein fix; division-by-zero has an obvious guard.
    expect(isAiFixableRule('field-validation')).toBe(false);
    expect(isAiFixableRule('division-by-zero')).toBe(false);
  });

  it('excludes unknown / undefined rule ids', () => {
    expect(isAiFixableRule('not-a-rule')).toBe(false);
    expect(isAiFixableRule(undefined)).toBe(false);
  });

  it('is a non-empty, frozen-style set used by the code-action provider', () => {
    expect(AI_FIXABLE_RULES.size).toBeGreaterThan(0);
  });
});
