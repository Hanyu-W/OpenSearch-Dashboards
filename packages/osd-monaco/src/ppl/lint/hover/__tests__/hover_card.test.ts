/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

import { getBundledCatalogEntry } from '../../catalog';
import { HoverCardInput, renderHoverCard } from '../hover_card';

function render(overrides: Partial<HoverCardInput> = {}): string {
  return renderHoverCard({
    severityLabel: 'Warning',
    message: 'Something happened.',
    ...overrides,
  });
}

describe('renderHoverCard', () => {
  it('renders a concise, action-oriented division-by-zero card', () => {
    const md = render({
      message: 'Dividing by zero returns no value (null) instead of an error.',
      docUrl:
        'https://docs.opensearch.org/latest/sql-and-ppl/ppl/functions/expressions/#arithmetic-operators',
      content: getBundledCatalogEntry('division-by-zero'),
      facts: { literal: '0' },
    });

    expect(md).toContain('⚠️ **Warning**');
    expect(md).toContain('Dividing by zero returns no value');
    expect(md).toContain('**Fix** — Use the intended divisor');
    expect(md).toContain(
      '[Learn more →](https://docs.opensearch.org/latest/sql-and-ppl/ppl/functions/expressions/#arithmetic-operators)'
    );
    expect(md).not.toContain('Engine behavior');
    expect(md).not.toContain('Why warning');
    expect(md).not.toContain('verified on');
    expect(md).not.toContain('division-by-zero');
    expect(md).not.toContain('Offending value');
  });

  it('adds an attributed field for an explain-backed finding', () => {
    const md = render({
      message:
        'This filter runs after the index scan, so rows it rejects are still read and returned to the PPL engine.',
      content: getBundledCatalogEntry('operation-not-pushed'),
      facts: { operation: 'filter', field: 'balance', literal: '30' },
    });

    expect(md).toContain('**Details** — Affected field: `balance`. Comparison value: `30`.');
    expect(md).toContain('**Fix** — Rewrite the highlighted operation');
  });

  it('does not add an empty details section when no field was attributed', () => {
    const md = render({
      message:
        'OpenSearch evaluates this filter as a script for every candidate document instead of using a native index query.',
      content: getBundledCatalogEntry('operation-pushed-as-script'),
      facts: { operation: 'filter' },
    });

    expect(md).not.toContain('**Details**');
    expect(md).not.toContain('undefined');
  });

  it('does not repeat field metadata already present in the diagnostic message', () => {
    const md = render({
      message:
        'avg cannot calculate a number from text field "response_body", so it returns no value (null).',
      content: getBundledCatalogEntry('agg-on-text'),
      facts: { field: 'response_body', esType: 'text', aggName: 'avg' },
    });

    expect(md).toContain('text field "response\\_body"');
    expect(md).toContain('**Fix** — Use a numeric field');
    expect(md).not.toContain('**Details**');
    expect(md.match(/response\\_body/g)).toHaveLength(1);
  });

  it('adds visible-index counts and similar names for a wildcard source', () => {
    const md = render({
      severityLabel: 'Info',
      message: 'Source pattern "logs-*" matches no known index.',
      content: getBundledCatalogEntry('wildcard-source-zero-match'),
      facts: { pattern: 'logs-*', totalIndices: 47, candidateIndices: ['logs_2024', 'logs_2025'] },
    });

    expect(md).toContain('ℹ️ **Info**');
    expect(md).toContain('**Details** — Checked 47 visible indices.');
    expect(md).toContain('Similar names: `logs_2024`, `logs_2025`.');
  });

  it('renders a deterministic quick-fix preview without repeating the suggestion facts', () => {
    const md = render({
      severityLabel: 'Error',
      message: 'Unknown field "reveneu". Did you mean "revenue"?',
      content: getBundledCatalogEntry('field-validation'),
      facts: { field: 'reveneu', suggestion: 'revenue' },
      fixText: 'revenue',
    });

    expect(md).toContain('**Quick fix available** — `revenue`');
    expect(md).not.toContain('Closest known field');
  });

  it('renders an error rule without extra sections', () => {
    const md = render({
      severityLabel: 'Error',
      message:
        'Subfield "attributes.http.method" of flat_object field "attributes" is not queryable.',
      content: getBundledCatalogEntry('flat-object-subfield'),
      facts: { field: 'attributes.http.method', root: 'attributes', esType: 'flat_object' },
    });

    expect(md).toContain('❌ **Error**');
    expect(md).toContain('**Fix** — Use another field');
    expect(md).not.toContain('**Details**');
  });

  it('fences a quick fix containing a backtick verbatim', () => {
    const md = render({ fixText: 'weird`name' });
    expect(md).toContain('weird`name');
    expect(md).not.toContain('weirdˋname');
  });

  it('escapes markdown-significant characters in the detector message', () => {
    const md = render({ message: 'use *star*, _under_, [brackets], ~~strike~~, and pipe |' });
    expect(md).toContain(
      'use \\*star\\*, \\_under\\_, \\[brackets\\], \\~\\~strike\\~\\~, and pipe \\|'
    );
  });

  it('percent-encodes parentheses in the doc link target', () => {
    const md = render({
      docUrl: 'https://docs.example/path_(disambiguation)/#a',
    });
    expect(md).toContain('[Learn more →](https://docs.example/path_%28disambiguation%29/#a)');
  });

  it('degrades to the severity and message when no rule help is available', () => {
    const md = render({ severityLabel: 'Info', message: 'Something happened.' });
    expect(md).toBe('ℹ️ **Info**\n\nSomething happened.');
  });

  it('never renders the AI-fix action on the card', () => {
    const md = render({
      message: 'Comparing numeric field to a string literal.',
      content: getBundledCatalogEntry('type-mismatch-numeric'),
    });
    expect(md).not.toContain('Ask AI to fix this');
    expect(md).not.toContain('command:');
  });
});
