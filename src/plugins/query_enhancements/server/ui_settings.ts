/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

import { schema } from '@osd/config-schema';
import { UiSettingsParams } from 'opensearch-dashboards/server';
// The rule-key prefix lives in data/common to avoid a dependency cycle (the
// data plugin's query editor reads the same keys). Importing the enum string
// value from core/server directly avoids pulling the data plugin's server code.
// eslint-disable-next-line @osd/eslint/no-restricted-paths
import { UiSettingScope } from '../../../core/server/ui_settings/types';
import { UI_SETTINGS } from '../../data/common';

// Bundled defaults for the per-rule lint settings. Mirrors the `enabled` and
// `severity` fields of each entry in @osd/monaco's rules_catalog.json; the
// registered default must match the catalog so "reset to default" and the
// sparse-storage diff in buildOverridesFromSettings agree on the baseline.
const PPL_LINT_RULE_DEFAULTS: ReadonlyArray<{
  id: string;
  enabled: boolean;
  severity: 'error' | 'warning' | 'info';
}> = [
  { id: 'invalid-capture-group-name', enabled: true, severity: 'error' },
  { id: 'unsupported-window-function-in-eventstats', enabled: true, severity: 'error' },
  { id: 'dedup-consecutive-unsupported', enabled: true, severity: 'warning' },
  { id: 'replace-wildcard-asymmetry', enabled: true, severity: 'error' },
  { id: 'union-min-datasets', enabled: true, severity: 'error' },
  { id: 'multisearch-min-subsearch', enabled: true, severity: 'error' },
  { id: 'disabled-join-type', enabled: true, severity: 'warning' },
  { id: 'head-without-sort', enabled: true, severity: 'info' },
  { id: 'field-validation', enabled: true, severity: 'warning' },
  { id: 'expand-on-non-array', enabled: true, severity: 'warning' },
  { id: 'wildcard-source-zero-match', enabled: true, severity: 'info' },
  { id: 'division-by-zero', enabled: true, severity: 'warning' },
  { id: 'agg-on-text', enabled: true, severity: 'warning' },
  { id: 'flat-object-subfield', enabled: true, severity: 'error' },
  { id: 'type-mismatch-numeric', enabled: true, severity: 'warning' },
  { id: 'enabled-false-object', enabled: true, severity: 'warning' },
  // Explain-backed rules ship disabled by default (opt-in); registering their
  // keys is what makes them individually toggleable via the per-rule override.
  { id: 'operation-not-pushed', enabled: false, severity: 'warning' },
  { id: 'operation-pushed-as-script', enabled: false, severity: 'info' },
];

/**
 * Build the per-rule uiSettings registrations. One key per rule
 * (`query:enhancements:pplLint:rule:<id>`) so OSD's per-key cross-scope merge
 * keeps each rule independent. Registered USER + GLOBAL always, plus WORKSPACE
 * when the workspace feature is on (mirrors the `defaultDataSource` precedent).
 * No `requiresPageReload` — the query editor live-revalidates on change.
 */
export function getPplLintRuleSettings(
  workspaceEnabled: boolean
): Record<string, UiSettingsParams<unknown>> {
  const scope = workspaceEnabled
    ? [UiSettingScope.USER, UiSettingScope.WORKSPACE, UiSettingScope.GLOBAL]
    : [UiSettingScope.USER, UiSettingScope.GLOBAL];

  return Object.fromEntries(
    PPL_LINT_RULE_DEFAULTS.map((rule) => [
      `${UI_SETTINGS.QUERY_ENHANCEMENTS_PPL_LINT_RULE_PREFIX}${rule.id}`,
      {
        name: `PPL linter rule: ${rule.id}`,
        value: { enabled: rule.enabled, severity: rule.severity },
        description: `Enable/disable and set the severity for the "${rule.id}" PPL lint rule.`,
        category: ['search'],
        scope,
        schema: schema.object({
          enabled: schema.boolean(),
          severity: schema.oneOf([
            schema.literal('error'),
            schema.literal('warning'),
            schema.literal('info'),
          ]),
        }),
      },
    ])
  );
}
