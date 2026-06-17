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
 * Read the per-rule lint uiSettings into a {@link BundleRuleOverrides} map the
 * lint engine merges over the bundled catalog.
 *
 * Sparse by design: a field is emitted only when it actually differs from the
 * bundled default, so an unchanged rule contributes nothing and the engine
 * keeps using the catalog entry verbatim. Severity is clamped up to the
 * silent-failure floor before being emitted.
 */
export function buildOverridesFromSettings(uiSettings: IUiSettingsClient): BundleRuleOverrides {
  const overrides: BundleRuleOverrides = {};

  for (const entry of getBundledCatalog()) {
    const key = `${UI_SETTINGS.QUERY_ENHANCEMENTS_PPL_LINT_RULE_PREFIX}${entry.id}`;
    // For a registered key with no user value, get() returns the registered
    // default object ({ enabled, severity }) rather than undefined — so this
    // does NOT short-circuit unchanged rules; the per-field comparisons below
    // are what make those rules contribute nothing. The guard only handles a
    // missing/unregistered key or a non-object value.
    const stored = uiSettings.get<StoredRuleSetting | undefined>(key, undefined);
    if (!stored || typeof stored !== 'object') {
      continue;
    }

    const patch: Partial<CatalogEntry> = {};

    if (typeof stored.enabled === 'boolean' && stored.enabled !== entry.enabled) {
      patch.enabled = stored.enabled;
    }

    if (stored.severity) {
      // Clamp up to the silent-failure floor first, then emit only if the
      // effective severity still differs from the catalog default — a downgrade
      // clamped back to the default contributes nothing (sparse).
      const floor = MIN_SEVERITY[entry.id];
      const effective =
        floor && SEV_RANK[stored.severity] < SEV_RANK[floor] ? floor : stored.severity;
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
