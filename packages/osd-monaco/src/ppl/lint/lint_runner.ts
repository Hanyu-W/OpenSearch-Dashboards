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

// True only when NO context resource is available — so a rule that needs a
// different resource (e.g. wildcard-source-zero-match needs visibleIndices,
// not fields) is not skipped just because the field list is empty. Each
// detector still runs its own resource self-check.
function isContextEmpty(context: LintRunContext | undefined): boolean {
  const noFields = !context?.fields || context.fields.size === 0;
  const noTypeMap = !context?.typeMap || context.typeMap.size === 0;
  const noDisabledObjects =
    !context?.disabledObjectFields || context.disabledObjectFields.size === 0;
  const noIndices = !context?.visibleIndices || context.visibleIndices.length === 0;
  return noFields && noTypeMap && noDisabledObjects && noIndices;
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

    // A `runtimeOnly` rule targets grammar productions that exist only in the
    // runtime-bundle surface (e.g. multisearch/union/replace arity). On the
    // compiled-simplified surface those productions are absent, so the detector
    // would find nothing — skip it there rather than let it run vacuously. This
    // is also the anti-vacuous guard the CI grammar-validation path relies on:
    // the headless lint API stamps `grammarSurface: 'runtime-bundle'` so these
    // rules DO fire against a candidate bundle.
    if (config.runtimeOnly && context?.grammarSurface !== 'runtime-bundle') {
      continue;
    }

    // R7 — version + engine filtering.
    if (!appliesTo(config, dataSourceVersion, context?.isCalcite, knownVersion)) {
      continue;
    }

    // R8.1, R8.2 — Bucket-B context gating.
    if (config.needsContext && isContextEmpty(context)) {
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
