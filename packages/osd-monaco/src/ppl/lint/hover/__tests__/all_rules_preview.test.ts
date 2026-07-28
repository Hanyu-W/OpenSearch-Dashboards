/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

import { getBundledCatalog } from '../../catalog';
import { HoverFacts } from '../hover_registry';
import { HoverCardInput, renderHoverCard, SeverityLabel } from '../hover_card';

interface PreviewCase {
  ruleId: string;
  message: string;
  facts?: HoverFacts;
  fixText?: string;
}

const PREVIEW_CASES: PreviewCase[] = [
  {
    ruleId: 'invalid-capture-group-name',
    message:
      'Capture group name "user_name" is invalid. Start with a letter and use only letters and numbers.',
    fixText: 'username',
  },
  {
    ruleId: 'unsupported-window-function-in-eventstats',
    message:
      'Window function "rank" is not supported in eventstats/streamstats. Only row_number is supported.',
  },
  {
    ruleId: 'dedup-consecutive-unsupported',
    message: 'consecutive=true uses an older query engine and may make this query slower.',
  },
  {
    ruleId: 'replace-wildcard-asymmetry',
    message:
      'The replace match has 2 "*" wildcards, but the replacement has 1. The counts must match.',
  },
  {
    ruleId: 'union-min-datasets',
    message: 'The union command requires at least two datasets.',
  },
  {
    ruleId: 'multisearch-min-subsearch',
    message: 'The multisearch command requires at least two subsearches.',
  },
  {
    ruleId: 'disabled-join-type',
    message:
      'A "cross" join can produce one result row for every pair of input rows and is disabled by default.',
  },
  {
    ruleId: 'head-without-sort',
    message: 'Without sort, head can return different rows each time the query runs.',
  },
  {
    ruleId: 'field-validation',
    message: 'Unknown field "reveneu". Did you mean "revenue"?',
    fixText: 'revenue',
  },
  {
    ruleId: 'expand-on-non-array',
    message:
      'Field "status" may contain only one value, so expand may have nothing to split into rows.',
  },
  {
    ruleId: 'wildcard-source-zero-match',
    message: 'Source pattern "lgos-*" matches no known index.',
    facts: {
      pattern: 'lgos-*',
      totalIndices: 47,
      candidateIndices: ['logs-2026.07.25'],
    },
    fixText: '`logs-2026.07.25`',
  },
  {
    ruleId: 'division-by-zero',
    message: 'Dividing by zero returns no value (null) instead of an error.',
  },
  {
    ruleId: 'agg-on-text',
    message:
      'avg cannot calculate a number from text field "message", so it returns no value (null).',
  },
  {
    ruleId: 'flat-object-subfield',
    message:
      'PPL cannot search "attributes.region" because it is stored inside the flat_object field "attributes".',
  },
  {
    ruleId: 'type-mismatch-numeric',
    message:
      'Field "status_code" is numeric, but "error" is not a number, so the comparison returns no rows.',
  },
  {
    ruleId: 'enabled-false-object',
    message: 'Field "metadata.trace_id" is stored but not searchable, so PPL returns null for it.',
  },
  {
    ruleId: 'rex-scan-cost',
    message:
      'rex runs the pattern against every input row from text field "body", even when it finds no match.',
  },
  {
    ruleId: 'operation-not-pushed',
    message:
      'This filter runs after the index scan, so rows it rejects are still read and returned to the PPL engine.',
    facts: { operation: 'filter', field: 'age', literal: '30' },
    fixText: 'age > 32',
  },
  {
    ruleId: 'operation-pushed-as-script',
    message:
      'OpenSearch evaluates this filter as a script for every candidate document instead of using a native index query.',
    facts: { operation: 'filter', field: 'age', literal: '30' },
    fixText: 'age > 32',
  },
];

function severityLabel(severity: string): SeverityLabel {
  switch (severity) {
    case 'error':
      return 'Error';
    case 'warning':
      return 'Warning';
    default:
      return 'Info';
  }
}

describe('all rule hover preview', () => {
  it('renders a reviewable card for every catalog rule', () => {
    const catalog = getBundledCatalog();
    const byId = new Map(catalog.map((entry) => [entry.id, entry]));

    expect(PREVIEW_CASES.map(({ ruleId }) => ruleId).sort()).toEqual(
      catalog.map(({ id }) => id).sort()
    );

    const preview = PREVIEW_CASES.map(({ ruleId, message, facts, fixText }) => {
      const entry = byId.get(ruleId)!;
      const input: HoverCardInput = {
        severityLabel: severityLabel(entry.severity),
        message,
        docUrl: entry.docUrl,
        content: entry,
        facts,
        fixText,
      };
      return `## \`${ruleId}\`\n\n${renderHoverCard(input)}`;
    }).join('\n\n---\n\n');

    expect(preview).toMatchSnapshot();
  });
});
