/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

import { ParserRuleContext } from 'antlr4ng';
import { Diagnostic } from './diagnostic';
import { BundleRuleOverrides, CatalogEntry, LintRunContext } from './types';
import { RuleNameToIndex } from './rule_index';
import { getBundledCatalog } from './catalog';
import { getDetector } from './detector_registry';
import { appliesTo, OSD_KNOWN_VERSION } from './version_filter';

// `BundleRuleOverrides` now lives in `./types` so `LintRunContext` can reference
// it without a cycle. Re-exported here for existing importers.
export type { BundleRuleOverrides };

export interface RunLintOptions {
  /** The catalog to iterate; defaults to the bundled catalog. */
  catalog?: CatalogEntry[];
  /** Runtime-bundle per-rule overrides (bundle-over-local). */
  bundleOverrides?: BundleRuleOverrides;
  dataSourceVersion?: string;
  ruleNameToIndex: RuleNameToIndex;
  context?: LintRunContext;
  knownVersion?: string;
}

/**
 * Shallow-merge a per-rule override patch over a bundled catalog entry, with the
 * nested `appliesTo` merged one level deep. Shared by the synchronous tree loop
 * (below) and the asynchronous explain pass (`explain/run_explain_lint.ts`) so
 * both resolve overrides identically.
 */
export function mergeConfig(local: CatalogEntry, override?: Partial<CatalogEntry>): CatalogEntry {
  if (!override) {
    return local;
  }
  return {
    ...local,
    ...override,
    appliesTo: { ...local.appliesTo, ...(override.appliesTo ?? {}) },
  };
}

function isEmptyFields(context: LintRunContext | undefined): boolean {
  return !context?.fields || context.fields.size === 0;
}

/**
 * The resolution loop. Pure over the tree. Iterates the catalog, applies bundle
 * overrides, version + engine filtering, context gating, and runs each detector
 * inside per-rule isolation so one failing rule cannot break the rest.
 */
export function runLint(tree: ParserRuleContext, options: RunLintOptions): Diagnostic[] {
  const {
    catalog = getBundledCatalog(),
    bundleOverrides,
    dataSourceVersion,
    ruleNameToIndex,
    context,
    knownVersion = OSD_KNOWN_VERSION,
  } = options;

  const diagnostics: Diagnostic[] = [];

  // An explicit `bundleOverrides` option wins (the future runtime-bundle path);
  // otherwise fall back to overrides threaded through the context (the host's
  // resolved uiSettings path). Both are per-rule patch maps merged the same way.
  const effectiveOverrides = bundleOverrides ?? context?.overrides;

  for (const localConfig of catalog) {
    const config = mergeConfig(localConfig, effectiveOverrides?.[localConfig.id]);

    // R6.3 — disabled rules are skipped.
    if (!config.enabled) {
      continue;
    }

    // Explain-backed rules read an `_explain` plan, not the parse tree. They run
    // in the asynchronous explain pass (see `explain/run_explain_lint.ts`); skip
    // them here so the synchronous tree loop never logs them as "inert".
    if (config.needsExplain) {
      continue;
    }

    // R7 — version + engine filtering.
    if (!appliesTo(config, dataSourceVersion, context?.isCalcite, knownVersion)) {
      continue;
    }

    // R8.1, R8.2 — Bucket-B context gating.
    if (config.needsContext && isEmptyFields(context)) {
      continue;
    }

    // R6.4 — missing detector logged as inert and skipped (never silent).
    const detector = getDetector(config.detector);
    if (!detector) {
      // eslint-disable-next-line no-console
      console.warn(`[ppl-lint] inert rule: no detector registered for "${config.id}"`);
      continue;
    }

    // R6.5-R6.8 — per-rule isolation.
    try {
      const ruleDiagnostics = detector(tree, config, context ?? {}, ruleNameToIndex);
      diagnostics.push(...ruleDiagnostics);
    } catch (e) {
      // eslint-disable-next-line no-console
      console.warn(`[ppl-lint] rule "${config.id}" threw and was skipped`, e);
    }
  }

  return diagnostics;
}
