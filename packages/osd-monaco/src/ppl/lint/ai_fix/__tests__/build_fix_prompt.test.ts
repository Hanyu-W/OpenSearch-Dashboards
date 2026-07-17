/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

import { capLength, MAX_QUERY_CHARS } from '../build_fix_prompt';

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
