/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

import { PPLLanguageAnalyzer } from '../../ppl_language_analyzer';

describe('REPRO: live capture-group queries (compiled surface)', () => {
  const analyzer = new PPLLanguageAnalyzer();
  const ids = (code: string): string[] => analyzer.lint(code).diagnostics.map((d) => d.ruleId);

  it('parse with hyphen group name', () => {
    const q =
      'source=otel-sample-logs-70million-test | parse body "(?<log-level>\\\\w+) (?<content>.*)"';
    // eslint-disable-next-line no-console
    console.log('PARSE diagnostics:', JSON.stringify(analyzer.lint(q).diagnostics, null, 2));
    expect(ids(q)).toContain('invalid-capture-group-name');
  });

  it('rex with underscore group name', () => {
    const q =
      'source=otel-sample-logs-70million-test | rex field=body "(?<bad_name>\\\\w+) (?<level>\\\\w+)"';
    // eslint-disable-next-line no-console
    console.log('REX diagnostics:', JSON.stringify(analyzer.lint(q).diagnostics, null, 2));
    expect(ids(q)).toContain('invalid-capture-group-name');
  });
});
