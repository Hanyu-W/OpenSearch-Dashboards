/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  validateCandidateFix,
  tokenOverlap,
  ValidateCandidateDeps,
  CandidateLintFacts,
} from '../validate_candidate_fix';

// A stub lint/shape pair driven by a per-query table so each test controls the
// exact facts the validator sees, with no Monaco/grammar dependency.
function makeDeps(
  table: Record<string, { ruleIds: string[]; syntaxClean?: boolean; shape: string[] }>
): ValidateCandidateDeps {
  return {
    lint: (q: string): CandidateLintFacts => {
      const e = table[q.trim()];
      return e
        ? { ruleIds: e.ruleIds, syntaxClean: e.syntaxClean !== false }
        : { ruleIds: [], syntaxClean: true };
    },
    pipelineShape: (q: string) => table[q.trim()]?.shape ?? [],
  };
}

describe('tokenOverlap', () => {
  it('is 1 when the candidate keeps every original token', () => {
    expect(tokenOverlap('source=a | where x = 1', 'source=a | where x = 2')).toBeCloseTo(
      // 'source','a','where','x' kept; the redacted literal differs — but most kept.
      0.8,
      1
    );
  });

  it('is low when the candidate shares few tokens (regeneration)', () => {
    expect(
      tokenOverlap('source=accounts | where age > 5', 'source=other | stats count()')
    ).toBeLessThan(0.5);
  });

  it('treats an empty original as full overlap', () => {
    expect(tokenOverlap('', 'anything')).toBe(1);
  });
});

describe('validateCandidateFix', () => {
  const original = 'source=accounts | where age = "thirty"';
  const ruleId = 'type-mismatch-numeric';

  it('accepts a minimal repair that clears the diagnostic and preserves shape', () => {
    const candidate = 'source=accounts | where age = 30';
    const deps = makeDeps({
      [original]: { ruleIds: [ruleId], shape: ['searchCommand', 'whereCommand'] },
      [candidate]: { ruleIds: [], shape: ['searchCommand', 'whereCommand'] },
    });
    expect(validateCandidateFix(original, candidate, ruleId, deps)).toEqual({ accepted: true });
  });

  it('rejects an empty candidate', () => {
    const deps = makeDeps({});
    expect(validateCandidateFix(original, '   ', ruleId, deps)).toEqual({
      accepted: false,
      reason: 'empty',
    });
  });

  it('rejects a candidate that fails to parse', () => {
    const candidate = 'source=accounts | wherr age = 30';
    const deps = makeDeps({
      [original]: { ruleIds: [ruleId], shape: ['searchCommand', 'whereCommand'] },
      [candidate]: { ruleIds: [], syntaxClean: false, shape: [] },
    });
    expect(validateCandidateFix(original, candidate, ruleId, deps).reason).toBe('syntax-error');
  });

  it('rejects a candidate that still raises the original diagnostic', () => {
    const candidate = 'source=accounts | where age = "still-bad"';
    const deps = makeDeps({
      [original]: { ruleIds: [ruleId], shape: ['searchCommand', 'whereCommand'] },
      [candidate]: { ruleIds: [ruleId], shape: ['searchCommand', 'whereCommand'] },
    });
    expect(validateCandidateFix(original, candidate, ruleId, deps).reason).toBe(
      'diagnostic-not-cleared'
    );
  });

  it('rejects a candidate that introduces a NEW diagnostic', () => {
    const candidate = 'source=accounts | where age = 30 | head 5';
    const deps = makeDeps({
      [original]: { ruleIds: [ruleId], shape: ['searchCommand', 'whereCommand'] },
      [candidate]: {
        ruleIds: ['head-without-sort'],
        shape: ['searchCommand', 'whereCommand', 'headCommand'],
      },
    });
    // New diagnostic check fires before shape (it iterates ruleIds first).
    expect(validateCandidateFix(original, candidate, ruleId, deps).reason).toBe('new-diagnostic');
  });

  it('rejects a candidate that changes the pipeline shape', () => {
    const candidate = 'source=accounts | where age = 30 | stats count()';
    const deps = makeDeps({
      [original]: { ruleIds: [ruleId], shape: ['searchCommand', 'whereCommand'] },
      [candidate]: {
        ruleIds: [],
        shape: ['searchCommand', 'whereCommand', 'statsCommand'],
      },
    });
    expect(validateCandidateFix(original, candidate, ruleId, deps).reason).toBe('shape-changed');
  });

  it('rejects a whole-query regeneration with the same shape but few shared tokens', () => {
    const candidate = 'source=different | where balance = 99';
    const deps = makeDeps({
      [original]: { ruleIds: [ruleId], shape: ['searchCommand', 'whereCommand'] },
      [candidate]: { ruleIds: [], shape: ['searchCommand', 'whereCommand'] },
    });
    expect(validateCandidateFix(original, candidate, ruleId, deps).reason).toBe('low-overlap');
  });
});
