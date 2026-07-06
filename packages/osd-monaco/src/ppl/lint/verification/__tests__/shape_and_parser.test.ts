/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

import { compiledSimplifiedSurface, resetSurfaceCache } from '../grammar_surface';
import { evaluateShapeAssertion, isShapeApplicable } from '../shape_evaluator';
import { SHAPE_ASSERTIONS } from '../shape_assertions';
import { parse, prettyPrint, assertRoundTrip, isParseError } from '../parser_adapter';
import { ShapeAssertion } from '../types';

describe('Shape assertions (Property 7: explicit and preserved)', () => {
  beforeEach(resetSurfaceCache);

  it('covers the five required parse-shape assumptions', () => {
    const ids = SHAPE_ASSERTIONS.map((a) => a.assertionId);
    expect(ids).toEqual(
      expect.arrayContaining([
        'division-by-zero-divisor-layout',
        'eval-created-field-layout',
        'as-created-field-layout',
        'alternate-source-pruning',
        'field-slot-grammar-behavior',
      ])
    );
  });

  it('every applicable shape assertion holds on the compiled surface', () => {
    const surface = compiledSimplifiedSurface();
    for (const assertion of SHAPE_ASSERTIONS) {
      if (isShapeApplicable(assertion, surface)) {
        const result = evaluateShapeAssertion(assertion, surface);
        if (!result.passing) {
          throw new Error(
            `${assertion.assertionId}: ` +
              result.entries
                .filter((e) => e.status === 'failure')
                .map((e) => e.message)
                .join('; ')
          );
        }
        expect(result.passing).toBe(true);
      }
    }
  });

  it('fails a shape assertion whose anchor is ambiguous', () => {
    const surface = compiledSimplifiedSurface();
    const ambiguous: ShapeAssertion = {
      assertionId: 'ambiguous',
      ruleId: 'x',
      applicableSurfaces: ['compiled_simplified'],
      notApplicableSurfaces: [],
      canonicalQuery: 'source=logs | eval x = a / 0',
      // valueExpression matches 3 nodes → not exactly one.
      expectedAnchors: [{ name: 've', ruleName: 'valueExpression' }],
      expectedRelationships: [],
    };
    const result = evaluateShapeAssertion(ambiguous, surface);
    expect(result.passing).toBe(false);
    expect(result.entries.some((e) => e.message.includes('resolved to 3 nodes'))).toBe(true);
  });

  it('skips a not-applicable surface explicitly', () => {
    const surface = compiledSimplifiedSurface();
    const notHere: ShapeAssertion = {
      ...SHAPE_ASSERTIONS[0],
      applicableSurfaces: ['runtime_fixture'],
      notApplicableSurfaces: ['compiled_simplified'],
    };
    expect(isShapeApplicable(notHere, surface)).toBe(false);
  });
});

describe('ParserAdapter + pretty printer (Property 6: reproducible round trips)', () => {
  beforeEach(resetSurfaceCache);

  it('parses an accepted query into a tree', () => {
    const result = parse('source=logs | where a = 1', compiledSimplifiedSurface());
    expect(result.ok).toBe(true);
  });

  it('pretty-prints a tree back to surface-accepted text', () => {
    const surface = compiledSimplifiedSurface();
    const parsed = parse('source=logs | where a = 1', surface);
    expect(isParseError(parsed)).toBe(false);
    if (!isParseError(parsed)) {
      const printed = prettyPrint(parsed.tree);
      expect(printed.length).toBeGreaterThan(0);
      // The printed text reparses cleanly.
      expect(parse(printed, surface).ok).toBe(true);
    }
  });

  it('round-trips canonical queries with structural equivalence', () => {
    const surface = compiledSimplifiedSurface();
    for (const query of [
      'source=logs | where a = 1',
      'source=logs | eval x = a / 0',
      'source=logs | sort a | head 5',
      'source=logs | stats count() by a',
    ]) {
      const result = assertRoundTrip(query, surface);
      if (!result.passing) {
        throw new Error(
          result.entries
            .filter((e) => e.status === 'failure')
            .map((e) => e.message)
            .join('; ')
        );
      }
      expect(result.passing).toBe(true);
    }
  });
});
