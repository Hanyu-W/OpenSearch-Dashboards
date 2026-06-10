/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

import { PPLLanguageAnalyzer } from '../../ppl_language_analyzer';
import type { LintRunContext } from '../types';

// Example-based tests for the five silent-failure rules added from
// silent-failure-report.md §6. Each rule's sample queries are taken from the
// queries verified live against an OpenSearch 3.7 cluster in that report.
//
// All assertions run on the compiled (simplified-grammar) surface, matching the
// existing analyzer_lint.test.ts suite.

describe('PPL silent-failure lint rules (compiled surface)', () => {
  let analyzer: PPLLanguageAnalyzer;

  beforeEach(() => {
    analyzer = new PPLLanguageAnalyzer();
  });

  // A context mirroring the report's `accounts` + `otel-logs-demo` indices.
  const typeMap = new Map<string, string>([
    ['age', 'long'],
    ['balance', 'long'],
    ['firstname', 'text'],
    ['state', 'text'],
    ['attributes', 'flat_object'],
    ['durationNano', 'long'],
    ['statusCode', 'long'],
  ]);
  const fields = new Set<string>([...typeMap.keys(), 'raw']);
  const ctx: LintRunContext = {
    fields,
    typeMap,
    disabledObjectFields: new Set(['raw']),
  };

  const ids = (code: string, context?: LintRunContext): string[] =>
    analyzer.lint(code, context).diagnostics.map((d) => d.ruleId);

  const diag = (code: string, ruleId: string, context: LintRunContext = ctx) =>
    analyzer.lint(code, context).diagnostics.find((d) => d.ruleId === ruleId);

  describe('division-by-zero', () => {
    it('flags division by literal zero', () => {
      expect(ids('search accounts | eval x = balance / 0 | fields x', ctx)).toContain(
        'division-by-zero'
      );
    });

    it('flags division by a decimal zero', () => {
      expect(ids('search accounts | eval x = balance / 0.0', ctx)).toContain('division-by-zero');
    });

    it('does not flag division by a non-zero literal', () => {
      expect(ids('search accounts | eval x = balance / 2', ctx)).not.toContain('division-by-zero');
    });

    it('does not flag modulo by zero (not verified as a silent failure)', () => {
      expect(ids('search accounts | eval x = balance % 0', ctx)).not.toContain('division-by-zero');
    });

    it('is Bucket A — fires even without a lint context', () => {
      expect(ids('search accounts | eval x = balance / 0')).toContain('division-by-zero');
    });
  });

  describe('agg-on-text', () => {
    it('flags a numeric aggregation on a text field', () => {
      expect(ids('search accounts | stats avg(firstname)', ctx)).toContain('agg-on-text');
    });

    it('does not flag a numeric aggregation on a numeric field', () => {
      expect(ids('search accounts | stats avg(balance)', ctx)).not.toContain('agg-on-text');
    });

    it('does not flag a type-agnostic aggregation like count', () => {
      expect(ids('search accounts | stats count(firstname)', ctx)).not.toContain('agg-on-text');
    });

    it('does not flag a computed aggregation argument (open-world self-suppress)', () => {
      expect(ids('search accounts | stats avg(balance / 2)', ctx)).not.toContain('agg-on-text');
    });

    it('self-suppresses without a typeMap', () => {
      expect(ids('search accounts | stats avg(firstname)', { fields })).not.toContain(
        'agg-on-text'
      );
    });
  });

  describe('flat-object-subfield', () => {
    it('flags a flat_object subfield in a where predicate', () => {
      expect(ids('search otel | where attributes.http.method = "GET"', ctx)).toContain(
        'flat-object-subfield'
      );
    });

    it('flags a flat_object subfield in a fields projection', () => {
      expect(ids('search otel | fields attributes.http.method', ctx)).toContain(
        'flat-object-subfield'
      );
    });

    it('does not flag a reference to the flat_object root itself', () => {
      expect(ids('search otel | fields attributes', ctx)).not.toContain('flat-object-subfield');
    });

    it('self-suppresses without a typeMap', () => {
      expect(ids('search otel | fields attributes.http.method', { fields })).not.toContain(
        'flat-object-subfield'
      );
    });
  });

  describe('type-mismatch-numeric', () => {
    it('flags a numeric field compared to a non-numeric string', () => {
      expect(ids('search accounts | where age = "thirty"', ctx)).toContain('type-mismatch-numeric');
    });

    it('flags the reversed operand order', () => {
      expect(ids('search accounts | where "thirty" = age', ctx)).toContain('type-mismatch-numeric');
    });

    it('does not flag a coercible quoted number (engine handles it correctly)', () => {
      expect(ids('search accounts | where age = "32"', ctx)).not.toContain('type-mismatch-numeric');
    });

    it('does not flag a comparison on a text field', () => {
      expect(ids('search accounts | where firstname = "AMY"', ctx)).not.toContain(
        'type-mismatch-numeric'
      );
    });

    it('does not flag a numeric literal comparison', () => {
      expect(ids('search accounts | where age = 30', ctx)).not.toContain('type-mismatch-numeric');
    });

    it('self-suppresses without a typeMap', () => {
      expect(ids('search accounts | where age = "thirty"', { fields })).not.toContain(
        'type-mismatch-numeric'
      );
    });
  });

  describe('enabled-false-object', () => {
    it('flags a field inside an enabled:false object in a fields projection', () => {
      expect(ids('search otel | fields raw.k.deep', ctx)).toContain('enabled-false-object');
    });

    it('flags a field inside an enabled:false object in a where predicate', () => {
      expect(ids('search otel | where raw.k.deep = 1', ctx)).toContain('enabled-false-object');
    });

    it('does not flag a reference to the object root itself', () => {
      expect(ids('search otel | fields raw', ctx)).not.toContain('enabled-false-object');
    });

    it('self-suppresses without the disabledObjectFields set', () => {
      expect(ids('search otel | fields raw.k.deep', { fields, typeMap })).not.toContain(
        'enabled-false-object'
      );
    });
  });

  describe('field-validation quick fix', () => {
    it('suggests the nearest field as an in-place replacement', () => {
      const d = diag('search accounts | where firstnam = "x"', 'field-validation');
      expect(d?.fix).toEqual({ title: 'Replace with "firstname"', text: 'firstname' });
      // Default range — the fix replaces the squiggled field reference.
      expect(d?.fix?.range).toBeUndefined();
    });

    it('offers no fix when no known field is close (still flags)', () => {
      const d = diag('search accounts | where zzzzzzzz = "x"', 'field-validation');
      expect(d).toBeDefined();
      expect(d?.fix).toBeUndefined();
    });
  });

  it('never throws on the silent-failure sample queries', () => {
    const samples = [
      'search accounts | eval x = balance / 0 | fields x',
      'search accounts | stats avg(firstname)',
      'search otel | where attributes.http.method = "GET"',
      'search accounts | where age = "thirty"',
      'search otel | fields raw.k.deep',
    ];
    for (const sample of samples) {
      expect(() => analyzer.lint(sample, ctx)).not.toThrow();
    }
  });
});
