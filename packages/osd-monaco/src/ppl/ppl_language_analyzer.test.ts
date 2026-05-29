/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

import { PPLLanguageAnalyzer, getPPLLanguageAnalyzer } from './ppl_language_analyzer';

describe('PPLLanguageAnalyzer', () => {
  let analyzer: PPLLanguageAnalyzer;

  beforeEach(() => {
    analyzer = new PPLLanguageAnalyzer();
  });

  describe('Tokenizer', () => {
    it('should tokenize simple search query', () => {
      const query = 'search source=logs';

      const result = analyzer.tokenize(query);

      expect(result.length).toBeGreaterThan(0);
      expect(result[0].type).toBe('search');
      expect(result[0].value).toBe('search');
    });

    it('should tokenize search with pipe query', () => {
      const query = 'search source=logs | head 10';

      const result = analyzer.tokenize(query);

      expect(result.length).toBeGreaterThan(2);
      expect(result.some((token) => token.type === 'search')).toBe(true);
      expect(result.some((token) => token.type === 'pipe')).toBe(true);
      expect(result.some((token) => token.type === 'head')).toBe(true);
    });

    it('should tokenize stats query', () => {
      const query = 'search source=nginx | stats count() by status';

      const result = analyzer.tokenize(query);

      expect(result.length).toBeGreaterThan(5);
      expect(result.some((token) => token.type === 'stats')).toBe(true);
      expect(result.some((token) => token.type === 'count')).toBe(true);
      expect(result.some((token) => token.type === 'by')).toBe(true);
    });

    it('should tokenize where clause query', () => {
      const query = 'search source=logs | where status=200';

      const result = analyzer.tokenize(query);

      expect(result.length).toBeGreaterThan(4);
      expect(result.some((token) => token.type === 'where')).toBe(true);
    });

    it('should handle empty query', () => {
      const query = '';

      const result = analyzer.tokenize(query);

      expect(result).toEqual([]);
    });

    it('should tokenize multiline query', () => {
      const query = `search source=logs
      | where status > 200
      | head 5`;

      const result = analyzer.tokenize(query);

      expect(result.length).toBeGreaterThan(6);
      expect(result.some((token) => token.line > 1)).toBe(true);
    });
  });

  describe('Validator', () => {
    it('should validate correct simple search query', () => {
      const query = 'search source=logs';

      const result = analyzer.validate(query);

      expect(result.isValid).toBe(true);
      expect(result.errors).toEqual([]);
    });

    it('should validate correct search with head query', () => {
      const query = 'search source=logs | head 10';

      const result = analyzer.validate(query);

      expect(result.isValid).toBe(true);
      expect(result.errors).toEqual([]);
    });

    it('should validate correct stats query', () => {
      const query = 'search source=nginx | stats count() by status';

      const result = analyzer.validate(query);

      expect(result.isValid).toBe(true);
      expect(result.errors).toEqual([]);
    });

    it('should validate correct where query', () => {
      const query = 'search source=logs | where status=200 | head 5';

      const result = analyzer.validate(query);

      expect(result.isValid).toBe(true);
      expect(result.errors).toEqual([]);
    });

    it('should detect syntax error in invalid command', () => {
      const query = 'search source=logs | invalid_command';

      const result = analyzer.validate(query);

      expect(result.isValid).toBe(false);
      expect(result.errors.length).toBeGreaterThan(0);
      expect(result.errors[0]).toHaveProperty('message');
      expect(result.errors[0]).toHaveProperty('line');
      expect(result.errors[0]).toHaveProperty('column');
    });

    it('should detect syntax error in incomplete query', () => {
      const query = 'search source=logs |';

      const result = analyzer.validate(query);

      expect(result.isValid).toBe(false);
      expect(result.errors.length).toBeGreaterThan(0);
    });

    it('should detect syntax error in malformed where clause', () => {
      const query = 'search source=logs | where';

      const result = analyzer.validate(query);

      expect(result.isValid).toBe(false);
      expect(result.errors.length).toBeGreaterThan(0);
    });

    it('should detect syntax error in malformed stats command', () => {
      const query = 'search source=logs | stats';

      const result = analyzer.validate(query);

      expect(result.isValid).toBe(false);
      expect(result.errors.length).toBeGreaterThan(0);
    });

    it('should handle empty query validation', () => {
      const query = '';

      const result = analyzer.validate(query);

      expect(result.isValid).toBe(true);
    });

    it('should detect multiple syntax errors', () => {
      const query = 'invalid_start | invalid_command | another_invalid';

      const result = analyzer.validate(query);

      expect(result.isValid).toBe(false);
      expect(result.errors.length).toBeGreaterThan(0);
    });
  });

  describe('Complex Query Scenarios', () => {
    it('should handle complex aggregation query', () => {
      const query =
        'source=logs | stats avg(response_time) as avg_time, count() as total by status_code | sort - avg_time';

      const validationResult = analyzer.validate(query);
      const tokenResult = analyzer.tokenize(query);

      expect(tokenResult.length).toBeGreaterThan(10);
      expect(validationResult.isValid).toBe(true);
    });

    it('should handle query with multiple where conditions', () => {
      const query = 'search source=logs | where status > 200 and response_time < 1000 | head 20';

      const validationResult = analyzer.validate(query);
      const tokenResult = analyzer.tokenize(query);

      expect(tokenResult.length).toBeGreaterThan(8);
      expect(validationResult.isValid).toBe(true);
    });
  });

  describe('lint (M4)', () => {
    it('returns no diagnostics for a clean query', () => {
      const result = analyzer.lint('source=logs');

      expect(result).toEqual({ diagnostics: [] });
    });

    it('emits one diagnostic for an offending source-prefixed query', () => {
      const result = analyzer.lint('source=t | rex field=m "(?<a_b>x)"');

      expect(result.diagnostics).toHaveLength(1);
      expect(result.diagnostics[0].ruleId).toBe('rex-no-underscore');
    });

    it('still emits the rex diagnostic when an unrelated syntax error follows (no gate)', () => {
      const result = analyzer.lint('source=t | rex field=m "(?<a_b>x)" | nonsense###');

      expect(result.diagnostics.length).toBeGreaterThanOrEqual(1);
      expect(result.diagnostics.some((d) => d.ruleId === 'rex-no-underscore')).toBe(true);
    });

    it('returns no diagnostics for an empty string', () => {
      const result = analyzer.lint('');

      expect(result.diagnostics).toEqual([]);
    });

    it('fires once for a pipe-first query and maps the column to the un-prefixed position', () => {
      const query = '| rex field=m "(?<a_b>x)"';
      const result = analyzer.lint(query);

      expect(result.diagnostics).toHaveLength(1);

      // The diagnostic's start column must point at the literal in the ORIGINAL
      // (un-prefixed) content, not offset by the synthetic 'source=t ' prefix.
      const literalIndex = query.indexOf('"'); // ANTLR 0-based column on line 1
      expect(result.diagnostics[0].range.startLine).toBe(1);
      expect(result.diagnostics[0].range.startColumn).toBe(literalIndex);
    });
  });

  describe('lint pipe-first multi-line remap (M8)', () => {
    it('shifts only line-1 columns; line-2 columns are unchanged', () => {
      const query = '| where x>1\n| rex field=m "(?<a_b>x)"';
      const result = analyzer.lint(query);

      expect(result.diagnostics).toHaveLength(1);

      const diagnostic = result.diagnostics[0];
      // The offending literal is on line 2, so its columns must NOT be shifted by
      // the pipe-first remap (the prefix added no newline).
      expect(diagnostic.range.startLine).toBe(2);
      const line2 = '| rex field=m "(?<a_b>x)"';
      const literalIndex = line2.indexOf('"');
      expect(diagnostic.range.startColumn).toBe(literalIndex);
    });

    it('leaves a non-pipe-first query byte-for-byte unaffected by the remap path', () => {
      const query = 'source=t | rex field=m "(?<a_b>x)"';
      const result = analyzer.lint(query);

      expect(result.diagnostics).toHaveLength(1);
      const literalIndex = query.indexOf('"');
      expect(result.diagnostics[0].range.startColumn).toBe(literalIndex);
    });
  });
});

describe('getPPLLanguageAnalyzer singleton', () => {
  it('should return the same instance on multiple calls', () => {
    const instance1 = getPPLLanguageAnalyzer();
    const instance2 = getPPLLanguageAnalyzer();

    expect(instance1).toBe(instance2);
    expect(instance1).toBeInstanceOf(PPLLanguageAnalyzer);
  });

  it('should return valid analyzer instance', () => {
    const instance = getPPLLanguageAnalyzer();
    const query = 'search source=test';

    const result = instance.validate(query);

    expect(result.isValid).toBe(true);
  });
});
