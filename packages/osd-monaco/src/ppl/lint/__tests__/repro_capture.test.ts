/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

import { PPLLanguageAnalyzer } from '../../ppl_language_analyzer';

describe('invalid-capture-group-name: realistic multi-group queries (compiled surface)', () => {
  const analyzer = new PPLLanguageAnalyzer();
  const ids = (code: string): string[] => analyzer.lint(code).diagnostics.map((d) => d.ruleId);

  it('flags a hyphenated group name in parse with a following valid group', () => {
    const q =
      'source=otel-sample-logs-70million-test | parse body "(?<log-level>\\\\w+) (?<content>.*)"';
    expect(ids(q)).toContain('invalid-capture-group-name');
  });

  it('flags an underscore group name in rex with a following valid group', () => {
    const q =
      'source=otel-sample-logs-70million-test | rex field=body "(?<bad_name>\\\\w+) (?<level>\\\\w+)"';
    expect(ids(q)).toContain('invalid-capture-group-name');
  });
});
