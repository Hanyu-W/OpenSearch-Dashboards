/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

import { schema } from '@osd/config-schema';
import { UiSettingScope, UiSettingsParams } from 'opensearch-dashboards/server';
import { UI_SETTINGS } from '../../data/common';

// Bundled defaults for the lint settings. Mirrors the `enabled` and `severity`
// fields of each entry in @osd/monaco's rules_catalog.json; the registered
// default must match the catalog so "reset to default" and the sparse-storage
// diff in buildOverridesFromSettings agree on the baseline.
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
  { id: 'field-validation', enabled: true, severity: 'error' },
  { id: 'expand-on-non-array', enabled: true, severity: 'warning' },
  { id: 'wildcard-source-zero-match', enabled: true, severity: 'info' },
  { id: 'division-by-zero', enabled: true, severity: 'warning' },
  { id: 'agg-on-text', enabled: true, severity: 'warning' },
  { id: 'flat-object-subfield', enabled: true, severity: 'error' },
  { id: 'type-mismatch-numeric', enabled: true, severity: 'warning' },
  { id: 'enabled-false-object', enabled: true, severity: 'warning' },
  { id: 'rex-scan-cost', enabled: true, severity: 'info' },
  { id: 'operation-not-pushed', enabled: true, severity: 'warning' },
  { id: 'operation-pushed-as-script', enabled: true, severity: 'info' },
];

// The bundled default rendered as the JSON editor's initial value: an object
// keyed by rule id. Kept pretty-printed (2-space) to match how Advanced
// Settings shows other `type: 'json'` settings (e.g. timepicker:quickRanges).
const DEFAULT_RULES_VALUE = Object.fromEntries(
  PPL_LINT_RULE_DEFAULTS.map((rule) => [
    rule.id,
    { enabled: rule.enabled, severity: rule.severity },
  ])
);

/**
 * Register the PPL linter rule configuration as a single JSON uiSetting
 * (`query:enhancements:pplLint:rules`), modeled on `timepicker:quickRanges`:
 * one `type: 'json'` key that Advanced Settings renders as a JSON editor. The
 * value is an object mapping each rule id to `{ enabled, severity }`.
 *
 * Global-scoped like `timepicker:quickRanges` — a single shared config rather
 * than the per-user/workspace cross-scope merge. No `requiresPageReload`: the
 * query editor live-revalidates when this key changes.
 */
export function getPplLintRuleSettings(): Record<string, UiSettingsParams<unknown>> {
  return {
    [UI_SETTINGS.QUERY_ENHANCEMENTS_PPL_LINT_RULES]: {
      name: 'PPL linter rules',
      value: JSON.stringify(DEFAULT_RULES_VALUE, null, 2),
      type: 'json',
      description:
        'Per-rule configuration for the PPL linter. An object keyed by rule id, ' +
        'each with "enabled" (boolean) and "severity" ("error", "warning", or "info"). ' +
        'Rules omitted from this object fall back to their bundled defaults.',
      category: ['search'],
      scope: UiSettingScope.GLOBAL,
      schema: schema.recordOf(
        schema.string(),
        schema.object({
          enabled: schema.boolean(),
          severity: schema.oneOf([
            schema.literal('error'),
            schema.literal('warning'),
            schema.literal('info'),
          ]),
        })
      ),
    },
  };
}
