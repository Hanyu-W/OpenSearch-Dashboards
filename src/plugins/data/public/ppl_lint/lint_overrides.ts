/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

import { IUiSettingsClient } from 'opensearch-dashboards/public';
import { BundleRuleOverrides, CatalogEntry, getBundledCatalog, LintSeverity } from '@osd/monaco';
import { UI_SETTINGS } from '../../common';

const SEV_RANK: Record<LintSeverity, number> = { info: 0, warning: 1, error: 2 };

/**
 * Silent-failure rules an admin may pin: a user may disable the squiggle but
 * may not *downgrade* its severity below `warning` (the design's §8 safety
 * floor). These are the catches with no other signal — an HTTP 200 with a
 * wrong/null answer. OSD's generic per-key merge can't express a per-field
 * floor, so it is clamped here on the client before the override is applied.
 */
const MIN_SEVERITY: Record<string, LintSeverity> = {
  'division-by-zero': 'warning',
  'agg-on-text': 'warning',
  'type-mismatch-numeric': 'warning',
  'enabled-false-object': 'warning',
};

interface StoredRuleSetting {
  enabled?: boolean;
  severity?: LintSeverity;
}

/**
 * Read the single lint-rules uiSetting into a {@link BundleRuleOverrides} map
 * the lint engine merges over the bundled catalog. The stored value is one
 * `type: 'json'` object keyed by rule id → { enabled, severity }; get() returns
 * it already parsed.
 *
 * Sparse by design: a field is emitted only when it actually differs from the
 * bundled default, so an unchanged rule contributes nothing and the engine
 * keeps using the catalog entry verbatim. Severity is clamped up to the
 * silent-failure floor before being emitted.
 */
export function buildOverridesFromSettings(uiSettings: IUiSettingsClient): BundleRuleOverrides {
  const overrides: BundleRuleOverrides = {};

  const stored = uiSettings.get<Record<string, StoredRuleSetting> | undefined>(
    UI_SETTINGS.QUERY_ENHANCEMENTS_PPL_LINT_RULES,
    undefined
  );
  if (!stored || typeof stored !== 'object') {
    return overrides;
  }

  for (const entry of getBundledCatalog()) {
    const ruleSetting = stored[entry.id];
    if (!ruleSetting || typeof ruleSetting !== 'object') {
      continue;
    }

    const patch: Partial<CatalogEntry> = {};

    if (typeof ruleSetting.enabled === 'boolean' && ruleSetting.enabled !== entry.enabled) {
      patch.enabled = ruleSetting.enabled;
    }

    if (ruleSetting.severity && ruleSetting.severity in SEV_RANK) {
      // Clamp up to the silent-failure floor first, then emit only if the
      // effective severity still differs from the catalog default — a downgrade
      // clamped back to the default contributes nothing (sparse).
      const floor = MIN_SEVERITY[entry.id];
      const effective =
        floor && SEV_RANK[ruleSetting.severity] < SEV_RANK[floor] ? floor : ruleSetting.severity;
      if (effective !== entry.severity) {
        patch.severity = effective;
      }
    }

    if (Object.keys(patch).length > 0) {
      overrides[entry.id] = patch;
    }
  }

  return overrides;
}
