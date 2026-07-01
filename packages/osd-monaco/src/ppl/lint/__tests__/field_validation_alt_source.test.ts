/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

import { PPLLanguageAnalyzer } from '../../ppl_language_analyzer';
import type { LintRunContext } from '../types';

// Fix 3: field-validation must not flag field references that legitimately
// belong to a different source — join aliases, lookup-table columns, append /
// subsearch inner sources — nor backtick-quoted identifiers. It must still flag
// genuinely unknown fields on the outer source. All assertions run on the
// compiled (simplified-grammar) surface, matching analyzer_lint.test.ts.

describe('field-validation alternate-source suppression (compiled surface)', () => {
  let analyzer: PPLLanguageAnalyzer;

  beforeEach(() => {
    analyzer = new PPLLanguageAnalyzer();
  });

  // The outer source `accounts` exposes exactly these fields.
  const ctx: LintRunContext = {
    fields: new Set<string>(['age', 'response', 'id', 'status', 'name']),
  };

  const fieldDiags = (code: string): string[] =>
    analyzer
      .lint(code, ctx)
      .diagnostics.filter((d) => d.ruleId === 'field-validation')
      .map((d) => d.message);

  describe('join aliases', () => {
    it('does NOT flag a left-alias ref downstream', () => {
      expect(
        fieldDiags(
          'search accounts | join left=l right=r on l.id = r.id departments | where l.response = 200'
        )
      ).toEqual([]);
    });

    it('does NOT flag a right-alias ref downstream', () => {
      expect(
        fieldDiags(
          'search accounts | join left=l right=r on l.id = r.id departments | where r.status = 1'
        )
      ).toEqual([]);
    });

    it('does NOT flag alias refs in the ON clause', () => {
      expect(
        fieldDiags('search accounts | join left=l right=r on l.id = r.id departments')
      ).toEqual([]);
    });

    it('STILL flags a bare unknown field in a join pipeline', () => {
      expect(
        fieldDiags(
          'search accounts | join left=l right=r on l.id = r.id departments | where nope = 1'
        )
      ).toEqual([expect.stringContaining('Unknown field "nope"')]);
    });

    it('STILL flags a dotted ref whose prefix is not a declared alias', () => {
      expect(
        fieldDiags(
          'search accounts | join left=l right=r on l.id = r.id departments | where x.response = 200'
        )
      ).toEqual([expect.stringContaining('Unknown field "x.response"')]);
    });
  });

  describe('alternate-source subtrees', () => {
    it('does NOT flag lookup-table columns', () => {
      expect(fieldDiags('search accounts | lookup departments dept AS d | where age > 1')).toEqual(
        []
      );
    });

    it('does NOT flag fields inside append with its own source', () => {
      expect(
        fieldDiags(
          'search accounts | append [search departments | where really_unknown = 1] | where age > 1'
        )
      ).toEqual([]);
    });

    it('does NOT flag fields inside an IN subsearch', () => {
      expect(
        fieldDiags('search accounts | where status IN [search departments | fields dept_id]')
      ).toEqual([]);
    });

    it('scopes the prune: the same unknown field STILL fires on the outer source', () => {
      // `really_unknown` is suppressed inside the append source above, but a
      // bare reference on the outer `accounts` source must still fire — proving
      // the prune is scoped to the alternate-source subtree, not global.
      expect(fieldDiags('search accounts | where really_unknown = 1')).toEqual([
        expect.stringContaining('Unknown field "really_unknown"'),
      ]);
    });
  });

  describe('backtick-quoted identifiers', () => {
    it('does NOT flag a backtick-quoted known field', () => {
      expect(fieldDiags('search accounts | where `age` > 30')).toEqual([]);
    });

    it('STILL flags a backtick-quoted unknown field', () => {
      expect(fieldDiags('search accounts | where `bogus` > 30')).toEqual([
        expect.stringContaining('Unknown field "bogus"'),
      ]);
    });
  });

  // B2: suggestField must prefer a distance-0 (case-only) match over a
  // distance-1 one seen earlier in the field set — otherwise the quick-fix
  // rewrites the user's case-typo into the *wrong* field.
  describe('suggestion prefers an exact case-insensitive match (B2)', () => {
    // `ages` (distance 1 from `AGE`) is listed before `age` (distance 0) so the
    // old `break` at distance 1 would have returned `ages`.
    const caseCtx: LintRunContext = { fields: new Set<string>(['ages', 'age']) };
    const caseDiags = (code: string): string[] =>
      analyzer
        .lint(code, caseCtx)
        .diagnostics.filter((d) => d.ruleId === 'field-validation')
        .map((d) => d.message);

    it('suggests the exact-but-for-case field, not a distance-1 neighbor', () => {
      expect(caseDiags('search accounts | where AGE > 30')).toEqual([
        'Unknown field "AGE". Did you mean "age"?',
      ]);
    });
  });

  // ─── Extraction-command created fields ───────────────────────────────────────

  describe('capture-pattern extraction (grok/parse/rex)', () => {
    // --- POSITIVE: extracted field resolves downstream ---

    it('grok: extracted field used in WHERE is not flagged', () => {
      expect(
        fieldDiags('search accounts | grok status "%{NUMBER:duration}" | where duration > 5')
      ).toEqual([]);
    });

    it('grok: underscore in semantic name resolves correctly', () => {
      expect(
        fieldDiags('search accounts | grok status "%{IP:client_ip}" | where client_ip = "1.2.3.4"')
      ).toEqual([]);
    });

    it('grok: multiple captures all resolve downstream', () => {
      expect(
        fieldDiags(
          'search accounts | grok status "%{IP:src_ip} %{NUMBER:port}" | where src_ip = "x" | where port > 0'
        )
      ).toEqual([]);
    });

    it('parse: Java named group resolves in WHERE', () => {
      expect(
        fieldDiags('search accounts | parse name "(?<firstWord>\\\\w+)" | where firstWord = "x"')
      ).toEqual([]);
    });

    it('parse: Python (?P<name>) opener resolves', () => {
      expect(
        fieldDiags('search accounts | parse name "(?P<token>\\\\w+)" | where token = "x"')
      ).toEqual([]);
    });

    it('rex: extracted field resolves in STATS BY', () => {
      expect(
        fieldDiags(
          'search accounts | rex field=name "(?<firstWord>\\\\w+)" | stats count() by firstWord'
        )
      ).toEqual([]);
    });

    it('extracted field used in arithmetic expression resolves', () => {
      expect(
        fieldDiags('search accounts | grok status "%{NUMBER:latency}" | where latency + 1 > 100')
      ).toEqual([]);
    });

    // --- NEGATIVE: things that SHOULD still be flagged ---

    it('STILL flags an unknown grok SOURCE field', () => {
      expect(
        fieldDiags('search accounts | grok nope "%{NUMBER:duration}" | where duration > 5')
      ).toEqual([expect.stringContaining('Unknown field "nope"')]);
    });

    it('STILL flags an unknown parse SOURCE field', () => {
      expect(fieldDiags('search accounts | parse nope "(?<x>\\\\w+)" | where x = "y"')).toEqual([
        expect.stringContaining('Unknown field "nope"'),
      ]);
    });

    it('invalid Java group name is NOT registered — downstream typo still flagged', () => {
      // `user_id` is an invalid Java group name (underscore) — the engine
      // never creates it, so `bogus` should still be caught.
      expect(
        fieldDiags('search accounts | parse name "(?<user_id>\\\\d+)" | where bogus = 1')
      ).toEqual([expect.stringContaining('Unknown field "bogus"')]);
    });

    it('a field referenced BEFORE the extraction (upstream) is not flagged (order-insensitive)', () => {
      // Known limitation: createdFields is a flat, order-insensitive set, so a
      // reference before the grok still resolves. Documented, not a defect.
      expect(
        fieldDiags('search accounts | where duration > 5 | grok status "%{NUMBER:duration}"')
      ).toEqual([]);
    });

    it('grok with no captures (%{SYNTAX} without colon) registers nothing', () => {
      expect(fieldDiags('search accounts | grok status "%{NUMBER}" | where bogus > 5')).toEqual([
        expect.stringContaining('Unknown field "bogus"'),
      ]);
    });
  });

  describe('named-slot extraction (patterns/spath)', () => {
    // --- POSITIVE: output field resolves ---

    it('patterns NEW_FIELD output resolves in WHERE', () => {
      expect(
        fieldDiags('search accounts | patterns name NEW_FIELD=\'tpl\' | where tpl = "x"')
      ).toEqual([]);
    });

    it('patterns_field ALSO resolves even when NEW_FIELD is set (3.6 ignores NEW_FIELD)', () => {
      // The 3.6 runtime engine ignores NEW_FIELD and always emits
      // `patterns_field`, while Calcite 2.19 honors NEW_FIELD. Registering both
      // keeps the linter correct regardless of the target engine version.
      expect(
        fieldDiags('search accounts | patterns name NEW_FIELD=\'tpl\' | where patterns_field = "x"')
      ).toEqual([]);
    });

    it('patterns default output field resolves when NEW_FIELD omitted', () => {
      // When NEW_FIELD is absent, the engine uses its default name.
      expect(fieldDiags('search accounts | patterns name | where patterns_field = "x"')).toEqual(
        []
      );
    });

    it('patterns companion `tokens` column resolves downstream', () => {
      // The engine emits a `tokens` struct column alongside the pattern field
      // (confirmed on the live Calcite 2.19 engine), so referencing it must not
      // be flagged.
      expect(
        fieldDiags("search accounts | patterns name NEW_FIELD='tpl' | stats count() by tokens")
      ).toEqual([]);
    });

    it('spath OUTPUT field resolves in WHERE', () => {
      expect(
        fieldDiags('search accounts | spath input=name output=parsed | where parsed = "x"')
      ).toEqual([]);
    });

    it('spath OUTPUT field NOT double-flagged at its declaration site', () => {
      // The grammar parses `output=parsed` with `parsed` as a fieldExpression.
      // Registering it in createdFields before PASS 2 walks suppresses both
      // the declaration-site flag AND any downstream flag.
      expect(fieldDiags('search accounts | spath input=name output=parsed')).toEqual([]);
    });

    it('spath with PATH (no OUTPUT) derives field from path text', () => {
      expect(
        fieldDiags('search accounts | spath input=name path=address | where address = "x"')
      ).toEqual([]);
    });

    // --- NEGATIVE: source still validated ---

    it('STILL flags an unknown spath INPUT (source) field', () => {
      expect(fieldDiags('search accounts | spath input=nope output=parsed')).toEqual([
        expect.stringContaining('Unknown field "nope"'),
      ]);
    });

    it('STILL flags unrelated unknown fields after extraction', () => {
      expect(
        fieldDiags('search accounts | grok status "%{NUMBER:duration}" | where bogus > 5')
      ).toEqual([expect.stringContaining('Unknown field "bogus"')]);
    });
  });

  describe('extraction + alternate-source interaction', () => {
    it('grok inside append does not disturb an outer known-field WHERE', () => {
      expect(
        fieldDiags(
          'search accounts | append [search logs | grok status "%{NUMBER:dur}"] | where age > 1'
        )
      ).toEqual([]);
    });

    it('extraction after a join still resolves (no interference)', () => {
      expect(
        fieldDiags(
          'search accounts | join left=l right=r on l.id = r.id departments | grok status "%{NUMBER:dur}" | where dur > 5'
        )
      ).toEqual([]);
    });
  });
});
