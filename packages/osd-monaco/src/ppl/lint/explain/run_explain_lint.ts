/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

import { Diagnostic } from '../diagnostic';
import { BundleRuleOverrides, CatalogEntry } from '../types';
import { getBundledCatalog } from '../catalog';
import { mergeConfig } from '../lint_runner';
import { appliesTo, OSD_KNOWN_VERSION } from '../version_filter';
import { getExplainDetector } from './explain_registry';
import { ExplainPlan } from './explain_types';

export interface RunExplainLintOptions {
  /** The query text the plan was produced for (sizes the whole-query range). */
  query: string;
  /** The catalog to iterate; defaults to the bundled catalog. */
  catalog?: CatalogEntry[];
  /** Per-rule overrides resolved on the host (enable/disable + severity). */
  overrides?: BundleRuleOverrides;
  dataSourceVersion?: string;
  /** True when the source is identified as running the Calcite engine. */
  isCalcite?: boolean;
  knownVersion?: string;
}

/**
 * Resolve the set of explain-backed catalog entries that would actually run for
 * the given source — enabled, version/engine applicable, and explain-tagged. A
 * caller uses this to decide whether to issue the `_explain` network call at
 * all: when it returns false there is no rule to feed, so the round-trip is
 * skipped.
 */
export function hasExplainRules(options: {
  catalog?: CatalogEntry[];
  overrides?: BundleRuleOverrides;
  dataSourceVersion?: string;
  isCalcite?: boolean;
  knownVersion?: string;
}): boolean {
  const {
    catalog = getBundledCatalog(),
    overrides,
    dataSourceVersion,
    isCalcite,
    knownVersion = OSD_KNOWN_VERSION,
  } = options;

  return catalog.some((localConfig) => {
    const config = mergeConfig(localConfig, overrides?.[localConfig.id]);
    if (!config.needsExplain || !config.enabled) {
      return false;
    }
    return appliesTo(config, dataSourceVersion, isCalcite, knownVersion);
  });
}

/**
 * The explain resolution pass. Iterates the catalog, applies the same override,
 * version, and engine filtering as the tree loop (`runLint`), but only over
 * explain-tagged rules, dispatching each through the explain registry inside
 * per-rule isolation so one failing rule cannot break the rest.
 */
export function runExplainLint(plan: ExplainPlan, options: RunExplainLintOptions): Diagnostic[] {
  const {
    query,
    catalog = getBundledCatalog(),
    overrides,
    dataSourceVersion,
    isCalcite,
    knownVersion = OSD_KNOWN_VERSION,
  } = options;

  const diagnostics: Diagnostic[] = [];

  for (const localConfig of catalog) {
    const config = mergeConfig(localConfig, overrides?.[localConfig.id]);

    // Only explain-backed rules run here; tree rules ran in `runLint`.
    if (!config.needsExplain) {
      continue;
    }

    if (!config.enabled) {
      continue;
    }

    // Version + engine filtering, identical to the tree loop.
    if (!appliesTo(config, dataSourceVersion, isCalcite, knownVersion)) {
      continue;
    }

    const detector = getExplainDetector(config.detector);
    if (!detector) {
      // eslint-disable-next-line no-console
      console.warn(`[ppl-lint] inert explain rule: no detector registered for "${config.id}"`);
      continue;
    }

    try {
      diagnostics.push(...detector(plan, config, { query }));
    } catch (e) {
      // eslint-disable-next-line no-console
      console.warn(`[ppl-lint] explain rule "${config.id}" threw and was skipped`, e);
    }
  }

  return diagnostics;
}
