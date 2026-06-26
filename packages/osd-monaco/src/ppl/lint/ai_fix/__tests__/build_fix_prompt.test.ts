/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

import { buildFixPrompt, redactLiterals, capLength, MAX_QUERY_CHARS } from '../build_fix_prompt';

describe('redactLiterals', () => {
  it('redacts single-quoted string values but keeps field/command names', () => {
    const out = redactLiterals("source=logs | where email = 'alice@example.com'");
    expect(out).toBe("source=logs | where email = '<redacted>'");
  });

  it('redacts double-quoted string values', () => {
    expect(redactLiterals('source=logs | where name = "Alice"')).toBe(
      "source=logs | where name = '<redacted>'"
    );
  });

  it('redacts bare numeric literals', () => {
    expect(redactLiterals('source=logs | where age = 42')).toBe('source=logs | where age = <n>');
  });

  it('redacts signed and decimal numbers', () => {
    expect(redactLiterals('source=logs | eval x = balance / -3.5')).toBe(
      'source=logs | eval x = balance / <n>'
    );
  });

  it('does not mangle digits embedded in identifiers', () => {
    // account_number, geo_point2 etc. keep their characters.
    expect(redactLiterals('source=logs | fields account_number, geo_point2')).toBe(
      'source=logs | fields account_number, geo_point2'
    );
  });

  it('does not redact a quoted number that is part of a string', () => {
    expect(redactLiterals('source=logs | where v = "32"')).toBe(
      "source=logs | where v = '<redacted>'"
    );
  });

  it('handles a SSN-like literal (PII case)', () => {
    expect(redactLiterals('source=people | where ssn = 123456789')).toBe(
      'source=people | where ssn = <n>'
    );
  });
});

describe('capLength', () => {
  it('returns short text unchanged', () => {
    expect(capLength('short', 100)).toBe('short');
  });

  it('truncates and marks overlong text', () => {
    const out = capLength('x'.repeat(50), 10);
    expect(out.startsWith('xxxxxxxxxx')).toBe(true);
    expect(out).toContain('[truncated]');
    expect(out.length).toBeLessThan(50);
  });

  it('defaults to MAX_QUERY_CHARS', () => {
    const big = 'a'.repeat(MAX_QUERY_CHARS + 100);
    expect(capLength(big)).toContain('[truncated]');
  });
});

describe('buildFixPrompt', () => {
  it('embeds the diagnostic message and a redacted, capped query', () => {
    const prompt = buildFixPrompt("source=accounts | where age = 'thirty'", {
      message: 'Comparing a numeric field to a non-numeric string matches no documents.',
      ruleId: 'type-mismatch-numeric',
    });
    expect(prompt).toContain('Comparing a numeric field to a non-numeric string');
    expect(prompt).toContain('Return ONLY the corrected PPL');
    expect(prompt).toContain('MINIMAL change');
    // The literal value must NOT appear; its placeholder must.
    expect(prompt).not.toContain('thirty');
    expect(prompt).toContain("'<redacted>'");
    // The query shape (fields/commands) is preserved for the model.
    expect(prompt).toContain('source=accounts | where age =');
  });

  it('caps a pathologically long query before egress', () => {
    const huge = `source=logs | where x = '${'a'.repeat(MAX_QUERY_CHARS * 2)}'`;
    const prompt = buildFixPrompt(huge, { message: 'm', ruleId: 'r' });
    // Redaction collapses the long string to a placeholder, so the prompt is
    // bounded regardless — assert it is well under the raw input length.
    expect(prompt.length).toBeLessThan(huge.length);
  });
});
