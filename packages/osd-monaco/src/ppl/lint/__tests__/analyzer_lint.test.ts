/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

import { PPLLanguageAnalyzer } from '../../ppl_language_analyzer';

describe('PPLLanguageAnalyzer.lint (compiled surface)', () => {
  let analyzer: PPLLanguageAnalyzer;

  beforeEach(() => {
    analyzer = new PPLLanguageAnalyzer();
  });

  const ruleIds = (code: string): string[] => analyzer.lint(code).diagnostics.map((d) => d.ruleId);

  const diag = (code: string, ruleId: string) =>
    analyzer.lint(code).diagnostics.find((d) => d.ruleId === ruleId);

  it('returns a LintResult with a diagnostics array', () => {
    const result = analyzer.lint('search source=logs');
    expect(Array.isArray(result.diagnostics)).toBe(true);
  });

  it('never throws on arbitrary / broken input', () => {
    expect(() => analyzer.lint('')).not.toThrow();
    expect(() => analyzer.lint('|||')).not.toThrow();
    expect(() => analyzer.lint('search source=')).not.toThrow();
    expect(() => analyzer.lint('🙂 not ppl at all ###')).not.toThrow();
  });

  describe('invalid-capture-group-name', () => {
    it('flags an invalid capture group name in rex', () => {
      const ids = ruleIds('source=logs | rex field=msg "(?<bad-name>\\\\d+)"');
      expect(ids).toContain('invalid-capture-group-name');
    });

    it('does not flag a valid capture group name', () => {
      const ids = ruleIds('source=logs | rex field=msg "(?<good>\\\\d+)"');
      expect(ids).not.toContain('invalid-capture-group-name');
    });

    it('flags the Python/PCRE opener', () => {
      const ids = ruleIds('source=logs | rex field=msg "(?P<name>\\\\d+)"');
      expect(ids).toContain('invalid-capture-group-name');
    });

    it('does not flag grok %{PATTERN:subname} syntax', () => {
      const ids = ruleIds('source=logs | grok msg "%{NUMBER:duration}"');
      expect(ids).not.toContain('invalid-capture-group-name');
    });

    describe('quick fixes', () => {
      it('offers a delete-P fix (explicit range) for the Python opener', () => {
        const d = diag(
          'source=logs | rex field=msg "(?P<name>\\\\d+)"',
          'invalid-capture-group-name'
        );
        expect(d?.fix).toBeDefined();
        expect(d?.fix?.text).toBe('');
        // Explicit range pointing at the single `P` (width 1).
        expect(d?.fix?.range).toBeDefined();
        const r = d!.fix!.range!;
        expect(r.startLine).toBe(r.endLine);
        expect(r.endColumn - r.startColumn).toBe(1);
      });

      it('offers a sanitize fix (default range) for a dashed name', () => {
        const d = diag(
          'source=logs | rex field=msg "(?<bad-name>\\\\d+)"',
          'invalid-capture-group-name'
        );
        expect(d?.fix).toEqual({ title: 'Remove invalid characters → "badname"', text: 'badname' });
        expect(d?.fix?.range).toBeUndefined();
      });

      it('strips an underscore to suggest a valid name', () => {
        const d = diag(
          'source=logs | rex field=msg "(?<user_id>\\\\d+)"',
          'invalid-capture-group-name'
        );
        expect(d?.fix?.text).toBe('userid');
      });

      it('strips leading digits so the first-character rule holds', () => {
        const d = diag(
          'source=logs | rex field=msg "(?<1name>\\\\d+)"',
          'invalid-capture-group-name'
        );
        expect(d?.fix?.text).toBe('name');
      });

      it('offers no fix when sanitizing leaves nothing valid (still flags)', () => {
        const d = diag(
          'source=logs | rex field=msg "(?<123>\\\\d+)"',
          'invalid-capture-group-name'
        );
        expect(d).toBeDefined();
        expect(d?.fix).toBeUndefined();
      });
    });
  });

  describe('unsupported-window-function-in-eventstats', () => {
    it('flags rank as a window function', () => {
      const ids = ruleIds('source=logs | eventstats rank() as r by status');
      expect(ids).toContain('unsupported-window-function-in-eventstats');
    });

    it('does not flag row_number', () => {
      const ids = ruleIds('source=logs | eventstats row_number() as r by status');
      expect(ids).not.toContain('unsupported-window-function-in-eventstats');
    });

    it('does not flag a plain aggregate like avg', () => {
      const ids = ruleIds('source=logs | eventstats avg(bytes) as a by status');
      expect(ids).not.toContain('unsupported-window-function-in-eventstats');
    });
  });

  describe('head-without-sort', () => {
    it('flags a head with no preceding sort', () => {
      const ids = ruleIds('source=logs | head 10');
      expect(ids).toContain('head-without-sort');
    });

    it('does not flag a head preceded by sort', () => {
      const ids = ruleIds('source=logs | sort age | head 10');
      expect(ids).not.toContain('head-without-sort');
    });

    it('flags a head when sort appears only after it', () => {
      const ids = ruleIds('source=logs | head 10 | sort age');
      expect(ids).toContain('head-without-sort');
    });
  });

  describe('field-validation field-slot shape', () => {
    it('flags grok field=body with an actionable fix on the compiled surface', () => {
      const query = 'source=logs | grok field=body "%{WORD:first}"';
      const d = diag(query, 'field-validation');
      expect(d?.severity).toBe('error');
      expect(d?.fix?.text).toBe('body');
      expect(d?.message).toContain('grok');
      expect(d?.range).toEqual({
        startLine: 1,
        startColumn: query.indexOf('field=body'),
        endLine: 1,
        endColumn: query.indexOf('field=body') + 'field=body'.length,
      });
    });

    it('flags parse field = message with an actionable fix on the compiled surface', () => {
      const d = diag('source=logs | parse field = message "x"', 'field-validation');
      expect(d?.severity).toBe('error');
      expect(d?.fix?.text).toBe('message');
      expect(d?.message).toContain('parse');
    });

    it('flags patterns field=body on the compiled surface', () => {
      const d = diag('source=logs | patterns field=body', 'field-validation');
      expect(d?.severity).toBe('error');
      expect(d?.fix?.text).toBe('body');
      expect(d?.message).toContain('patterns');
    });

    it('does not flag a bare source field', () => {
      expect(ruleIds('source=logs | grok body "%{WORD:first}"')).not.toContain('field-validation');
    });

    it('remaps field-slot ranges for pipe-first queries', () => {
      const d = diag('| grok field=body "x"', 'field-validation');
      expect(d?.range).toEqual({ startLine: 1, startColumn: 7, endLine: 1, endColumn: 17 });
      expect(d?.fix?.text).toBe('body');
    });

    it('does not duplicate unknown-field diagnostics inside the shape range', () => {
      const diags = analyzer
        .lint('source=logs | grok field=body "x"', { fields: new Set(['other']) })
        .diagnostics.filter((d) => d.ruleId === 'field-validation');

      expect(diags).toHaveLength(1);
      expect(diags[0].message).not.toContain('Unknown field');
    });
  });

  // The existence pass self-suppresses without a field list. On the compiled
  // (3.5) surface the worker only fires it once the host context — including
  // `fields` — is forwarded across postMessage (see worker_context.ts). These
  // guard that path: field-aware linting must work on the compiled analyzer,
  // not just the runtime grammar.
  describe('field-validation existence pass (compiled surface, with field list)', () => {
    it('flags an unknown field and suggests the closest known field', () => {
      const d = analyzer
        .lint('source=logs | where severtyText = "x"', {
          fields: new Set(['severityText', 'body', 'status']),
        })
        .diagnostics.find((diagnostic) => diagnostic.ruleId === 'field-validation');
      expect(d?.message).toContain('Unknown field "severtyText"');
      expect(d?.message).toContain('Did you mean "severityText"');
    });

    it('does not flag a field that exists in the list', () => {
      const ids = analyzer
        .lint('source=logs | where severityText = "x"', {
          fields: new Set(['severityText', 'body']),
        })
        .diagnostics.map((d) => d.ruleId);
      expect(ids).not.toContain('field-validation');
    });

    it('self-suppresses when no field list is present (R22.3)', () => {
      const ids = ruleIds('source=logs | where severtyText = "x"');
      expect(ids).not.toContain('field-validation');
    });
  });

  describe('disabled-join-type', () => {
    it('flags a cross join', () => {
      const ids = ruleIds('source=a | cross join left=l right=r on l.id = r.id b');
      expect(ids).toContain('disabled-join-type');
    });

    it('does not flag an inner join', () => {
      const ids = ruleIds('source=a | inner join left=l right=r on l.id = r.id b');
      expect(ids).not.toContain('disabled-join-type');
    });

    it('does not flag an outer (left alias) join', () => {
      const ids = ruleIds('source=a | left outer join left=l right=r on l.id = r.id b');
      expect(ids).not.toContain('disabled-join-type');
    });
  });

  describe('runtime-only rules no-op on the compiled surface', () => {
    it('does not emit replace/union/multisearch diagnostics', () => {
      const ids = ruleIds('source=logs | head 10');
      expect(ids).not.toContain('replace-wildcard-asymmetry');
      expect(ids).not.toContain('union-min-datasets');
      expect(ids).not.toContain('multisearch-min-subsearch');
    });
  });
});
