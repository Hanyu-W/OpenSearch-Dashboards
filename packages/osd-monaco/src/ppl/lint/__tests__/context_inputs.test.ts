/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

import { PPLLanguageAnalyzer } from '../../ppl_language_analyzer';
import type { LintRunContext } from '../types';

// Fix 4: two context inputs that callers now populate must drive the rules that
// consume them. `disabled-join-type` reads `settings.allJoinTypesAllowed`;
// `wildcard-source-zero-match` reads `visibleIndices`. Both self-suppress (or
// false-fire) when the input is absent, so these assertions pin the threading.

describe('context-input rules (compiled surface)', () => {
  let analyzer: PPLLanguageAnalyzer;

  beforeEach(() => {
    analyzer = new PPLLanguageAnalyzer();
  });

  const ids = (code: string, context?: LintRunContext): string[] =>
    analyzer.lint(code, context).diagnostics.map((d) => d.ruleId);

  describe('disabled-join-type honors settings.allJoinTypesAllowed', () => {
    const crossJoin = 'search a | cross join left=l right=r on l.id = r.id b';

    it('fires when settings are absent (conservative default)', () => {
      expect(ids(crossJoin)).toContain('disabled-join-type');
    });

    it('fires when allJoinTypesAllowed is false', () => {
      expect(ids(crossJoin, { settings: { allJoinTypesAllowed: false } })).toContain(
        'disabled-join-type'
      );
    });

    it('does NOT fire when allJoinTypesAllowed is true', () => {
      expect(ids(crossJoin, { settings: { allJoinTypesAllowed: true } })).not.toContain(
        'disabled-join-type'
      );
    });
  });

  describe('wildcard-source-zero-match consumes visibleIndices', () => {
    const zeroMatch = 'source=`nope-*`';

    it('self-suppresses when visibleIndices is absent', () => {
      expect(ids(zeroMatch, { fields: new Set(['age']) })).not.toContain(
        'wildcard-source-zero-match'
      );
    });

    it('self-suppresses when visibleIndices is empty', () => {
      expect(ids(zeroMatch, { fields: new Set(['age']), visibleIndices: [] })).not.toContain(
        'wildcard-source-zero-match'
      );
    });

    it('fires when a visible-index list is present and the pattern matches none', () => {
      expect(
        ids(zeroMatch, {
          fields: new Set(['age']),
          visibleIndices: ['logs-2024', 'logs-2025', 'accounts'],
        })
      ).toContain('wildcard-source-zero-match');
    });
  });
});
