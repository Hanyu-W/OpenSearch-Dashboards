/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

import { PPLLanguageAnalyzer } from '../../ppl_language_analyzer';
import type { LintRunContext } from '../types';

// `rex-scan-cost` is an advisory, `info`-severity rule that flags pattern
// extraction (`rex`/`parse`/`grok`) over a `text`-mapped source field. It ships
// disabled by default (like the explain-backed rules), so every assertion here
// enables it through the per-rule override, matching how the host resolves
// uiSettings into `context.overrides`.
//
// Assertions run on the compiled (simplified-grammar) surface, matching the
// existing analyzer_lint.test.ts / silent_failure_rules.test.ts suites. `rex`
// exists only on that surface; `parse`/`grok` exist on both.

describe('rex-scan-cost (compiled surface)', () => {
  let analyzer: PPLLanguageAnalyzer;

  beforeEach(() => {
    analyzer = new PPLLanguageAnalyzer();
  });

  const typeMap = new Map<string, string>([
    ['raw_log', 'text'],
    ['message', 'text'],
    ['email', 'text'],
    ['body', 'text'],
    ['host', 'keyword'],
    ['status', 'long'],
  ]);
  const fields = new Set<string>([...typeMap.keys()]);

  // Enable the default-off rule the same way the host does — via a per-rule
  // override threaded through the lint context.
  const enabled: LintRunContext = {
    fields,
    typeMap,
    overrides: { 'rex-scan-cost': { enabled: true } },
  };

  const ids = (code: string, context: LintRunContext): string[] =>
    analyzer.lint(code, context).diagnostics.map((d) => d.ruleId);

  const diag = (code: string, context: LintRunContext = enabled) =>
    analyzer.lint(code, context).diagnostics.find((d) => d.ruleId === 'rex-scan-cost');

  describe('fires on extraction over a text source field', () => {
    it('flags rex over a text field', () => {
      expect(ids('source=logs | rex field=raw_log "GET (?<path>\\S+)"', enabled)).toContain(
        'rex-scan-cost'
      );
    });

    it('flags parse over a text field', () => {
      expect(ids('source=logs | parse email "(?<user>.+)@"', enabled)).toContain('rex-scan-cost');
    });

    it('flags grok over a text field', () => {
      expect(ids('source=logs | grok message "%{IP:client}"', enabled)).toContain('rex-scan-cost');
    });

    it('resolves the rex source field, not an offset_field option', () => {
      // `off` is not in the typeMap; if the detector mistook the offset field for
      // the source field it would not fire. It fires on the text source `raw_log`.
      expect(
        ids('source=logs | rex field=raw_log offset_field=off "GET (?<path>\\S+)"', enabled)
      ).toContain('rex-scan-cost');
    });
  });

  describe('does not fire on non-text or unknown source fields', () => {
    it('does not flag rex over a keyword field', () => {
      expect(ids('source=logs | rex field=host "(?<h>\\S+)"', enabled)).not.toContain(
        'rex-scan-cost'
      );
    });

    it('does not flag parse over a numeric field', () => {
      expect(ids('source=logs | parse status "(?<s>\\d+)"', enabled)).not.toContain(
        'rex-scan-cost'
      );
    });

    it('does not flag extraction over a field missing from the typeMap', () => {
      expect(ids('source=logs | grok unknown_field "%{IP:client}"', enabled)).not.toContain(
        'rex-scan-cost'
      );
    });

    it('does not flag a Splunk-style "field=" parse shape (not a bare field)', () => {
      // `parse field=email "..."` is not a bare-field source; it is field-
      // validation's concern, not this rule's, so no scan-cost finding here.
      const found = analyzer
        .lint('source=logs | parse field=email "(?<u>.+)"', enabled)
        .diagnostics.filter((d) => d.ruleId === 'rex-scan-cost');
      expect(found).toHaveLength(0);
    });
  });

  describe('context and default gating', () => {
    it('self-suppresses without a typeMap', () => {
      expect(
        ids('source=logs | rex field=raw_log "GET (?<path>\\S+)"', {
          fields,
          overrides: { 'rex-scan-cost': { enabled: true } },
        })
      ).not.toContain('rex-scan-cost');
    });

    it('ships enabled by default', () => {
      expect(
        ids('source=logs | rex field=raw_log "GET (?<path>\\S+)"', { fields, typeMap })
      ).toContain('rex-scan-cost');
    });
  });

  describe('scope and shape', () => {
    it('does not fire for extraction inside an alternate-source subtree', () => {
      // The outer typeMap describes `logs`, not the appended `other` source, so a
      // parse inside the append must not be judged against the outer field types.
      expect(
        ids('source=logs | append [ source=other | parse message "(?<m>.+)" ]', enabled)
      ).not.toContain('rex-scan-cost');
    });

    it('attaches no quick-fix (advisory only)', () => {
      expect(diag('source=logs | rex field=raw_log "GET (?<path>\\S+)"')?.fix).toBeUndefined();
    });

    it('emits info severity', () => {
      expect(diag('source=logs | grok message "%{IP:client}"')?.severity).toBe('info');
    });

    it('never throws on the sample queries', () => {
      const samples = [
        'source=logs | rex field=raw_log "GET (?<path>\\S+)"',
        'source=logs | parse email "(?<user>.+)@"',
        'source=logs | grok message "%{IP:client}"',
      ];
      for (const sample of samples) {
        expect(() => analyzer.lint(sample, enabled)).not.toThrow();
      }
    });
  });

  describe('prefilter mitigation', () => {
    const advisory =
      'rex runs the pattern against every input row from text field "raw_log", even when it finds no match.';

    it('keeps an unsafe-to-insert prefix advisory-only', () => {
      const found = diag(`source=logs | rex field=raw_log '"level":"(?<lvl>[^"]+)"'`);
      expect(found?.message).toBe(advisory);
      expect(found?.aiFix).toEqual({ eligible: false });
    });

    it('decodes a doubled-double-quote literal before scanning', () => {
      const found = diag('source=logs | rex field=raw_log """level"":""(?<l>[^""]+)"""');
      expect(found?.message).toBe(advisory);
    });

    it('keeps a top-level alternation advisory-only', () => {
      const found = diag('source=logs | rex field=raw_log "GET|POST (?<m>\\S+)"');
      expect(found?.ruleId).toBe('rex-scan-cost'); // still fires
      expect(found?.message).toBe(advisory);
    });

    it('emits only the base message on a leading metaclass', () => {
      const found = diag('source=logs | rex field=raw_log "\\d{3}-(?<c>.*)"');
      expect(found?.message).not.toContain('the token');
    });

    it('emits only the base message on a punctuation-only leading run', () => {
      const found = diag('source=logs | rex field=raw_log "://(?<h>[^/]+)"');
      expect(found?.message).not.toContain('the token');
    });

    it('does not enrich the grok %{...} macro pattern', () => {
      const found = diag('source=logs | grok message "%{IP:client}"');
      expect(found?.ruleId).toBe('rex-scan-cost'); // still fires (message is text)
      expect(found?.message).not.toContain('the token');
    });

    it('keeps hover facts limited to source-field metadata', () => {
      // hoverFacts.suggestion renders as "Closest known field", which would
      // wrongly imply that a pattern token replaces the source field.
      const found = diag(`source=logs | rex field=raw_log '"level":"(?<lvl>[^"]+)"'`);
      expect(found?.hoverFacts).toEqual({ field: 'raw_log', esType: 'text' });
    });

    it('keeps the advisory posture on an unproven finding (info, no fix)', () => {
      const found = diag(`source=logs | rex field=raw_log '"level":"(?<lvl>[^"]+)"'`);
      expect(found?.severity).toBe('info');
      expect(found?.fix).toBeUndefined();
    });

    it('suppresses a rex with an exact preceding match_phrase prefilter', () => {
      expect(
        diag(
          "source=logs | where match_phrase(body, 'logtype') " +
            '| rex field=body "logtype=(?<logtype>[^\\s]+)"'
        )
      ).toBeUndefined();
    });

    it('suppresses a rex with an exact preceding substring prefilter', () => {
      expect(
        diag(
          "source=logs | where LIKE(body, '%logtype=%') " +
            '| rex field=body "logtype=(?<logtype>[^\\s]+)"'
        )
      ).toBeUndefined();
    });

    it('does not suppress for a wrong or post-extraction prefilter', () => {
      expect(
        diag(
          "source=logs | where match_phrase(body, 'message') " +
            '| rex field=body "logtype=(?<logtype>[^\\s]+)"'
        )
      ).toBeDefined();
      expect(
        diag(
          'source=logs | rex field=body "logtype=(?<logtype>[^\\s]+)" ' +
            "| where LIKE(body, '%logtype=%')"
        )
      ).toBeDefined();
    });

    it('suppresses only the extraction covered by the prefilter', () => {
      const diagnostics = analyzer
        .lint(
          "source=logs | where match_phrase(body, 'logtype') " +
            '| rex field=body "logtype=(?<logtype>[^\\s]+)" ' +
            '| rex field=body "message=(?<message>.*)"',
          enabled
        )
        .diagnostics.filter((candidate) => candidate.ruleId === 'rex-scan-cost');
      expect(diagnostics).toHaveLength(1);
      expect(diagnostics[0].range.startColumn).toBeGreaterThan(70);
    });

    it('marks the reported safe shape as AI-fixable with an exact LIKE contract', () => {
      const found = diag(
        'source=logs | rex field=body "logtype=(?<logtype>[^\\s]+)" ' +
          "| where logtype = 'ws:access'"
      );
      expect(found?.message).toContain('later WHERE on "logtype"');
      expect(found?.aiFix).toEqual(
        expect.objectContaining({
          eligible: true,
          instructions: expect.stringContaining("WHERE LIKE(body, '%logtype=%')"),
        })
      );
    });

    it('does not offer AI without an immediate null-rejecting consumer', () => {
      const found = diag(
        'source=logs | rex field=body "logtype=(?<logtype>[^\\s]+)" | stats count()'
      );
      expect(found?.aiFix).toEqual({ eligible: false });
    });

    it('fixes the reported detector loop with the exact-substring prefilter', () => {
      const original = [
        'source=logs-pr172502-2026.04.05',
        "| WHERE `@timestamp` >= '2026-04-05 00:00:00' AND `@timestamp` <= '2026-04-05 23:59:59'",
        '| rex field=body "logtype=(?<logtype>[^\\s]+) http_status=(?<httpstatus>\\d+) uri=\\"(?<uri>[^\\"]+)\\""',
        "| WHERE logtype = 'ws:access'",
        "| WHERE LIKE(httpstatus, '5%')",
        '| stats count() as errors by uri, httpstatus',
        '| eventstats sum(errors) as total_errors',
        '| eval error_share_pct = round(errors * 100.0 / total_errors, 2)',
        '| sort - errors, + uri',
        '| head 10',
      ].join(' ');
      expect(diag(original)).toBeDefined();

      const fixed = original.replace(
        '| rex field=body',
        "| WHERE LIKE(body, '%logtype=%') | rex field=body"
      );
      expect(diag(fixed)).toBeUndefined();
    });

    it('never throws on malformed or partially parsed extraction input', () => {
      for (const query of [
        'source=logs | rex field=body "logtype=(?<logtype>',
        'source=logs | where LIKE(body,',
        'source=logs | rex',
      ]) {
        expect(() => analyzer.lint(query, enabled)).not.toThrow();
      }
    });
  });
});
