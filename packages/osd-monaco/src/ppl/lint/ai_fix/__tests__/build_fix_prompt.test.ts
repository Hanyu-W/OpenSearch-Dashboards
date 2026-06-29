/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

import { buildFixPrompt, capLength, MAX_QUERY_CHARS } from '../build_fix_prompt';

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
  it('embeds the diagnostic message and the (verbatim) query', () => {
    const prompt = buildFixPrompt("source=accounts | where age = 'thirty'", {
      message: 'Comparing a numeric field to a non-numeric string matches no documents.',
      ruleId: 'type-mismatch-numeric',
    });
    expect(prompt).toContain('Comparing a numeric field to a non-numeric string');
    expect(prompt).toContain('Return ONLY the corrected PPL');
    expect(prompt).toContain('MINIMAL change');
    // Option B (raw egress): the query is sent verbatim — same posture as the
    // existing Query-Assist surface — so the agent can return a directly
    // applicable fix and re-validation stays coherent. The literal value is
    // present (no client-side redaction).
    expect(prompt).toContain("source=accounts | where age = 'thirty'");
    // The prompt no longer promises placeholders that the validator would reject.
    expect(prompt).not.toContain('<redacted>');
    expect(prompt).not.toContain('placeholders in place');
  });

  it('caps a pathologically long query before egress', () => {
    const huge = `source=logs | where x = '${'a'.repeat(MAX_QUERY_CHARS * 2)}'`;
    const prompt = buildFixPrompt(huge, { message: 'm', ruleId: 'r' });
    // The length cap bounds the egressed text regardless of input size.
    expect(prompt).toContain('[truncated]');
    expect(prompt.length).toBeLessThan(huge.length);
  });
});
