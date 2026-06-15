/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

import { monaco } from '../../../monaco';
import { markerFixKey } from '../fix_registry';

/**
 * Per-instance facts a detector extracts about *this* finding (not the rule in
 * general): the actual offending field, its actual mapped type, the actual
 * literal/divisor, candidate indices, etc. Rendered into the "Your query" line
 * of the hover card so the card is about the user's query, not a generic rule.
 *
 * All fields are optional; a detector populates only what it knows. Lists are
 * pre-sliced by the detector (e.g. <=5 candidate indices) so we never hold a
 * large array reference per diagnostic.
 */
export interface HoverFacts {
  /** Actual offending field name (or dotted path). */
  field?: string;
  /** Its actual mapped esType, from typeMap. */
  esType?: string;
  /** Root object name, for enabled-false-object / flat-object subfields. */
  root?: string;
  /** Actual literal / divisor text, verbatim from the query. */
  literal?: string;
  /** Aggregation function name, for agg-on-text. */
  aggName?: string;
  /** Closest known field, already computed by field-validation. */
  suggestion?: string;
  /** Wildcard source pattern, for wildcard-source-zero-match. */
  pattern?: string;
  /** Pre-sliced (<=5) candidate index names near the pattern. */
  candidateIndices?: string[];
  /** Count of visible indices checked, for "matched 0 of N". */
  totalIndices?: number;
}

/**
 * Re-association table for per-instance hover facts. Mirrors `fix_registry.ts`
 * exactly: Monaco's MarkerService rebuilds each marker from a fixed field list
 * and drops custom properties, so facts hung directly off a marker never reach
 * the hover provider. We key off the marker fields the service preserves
 * (position + message, via `markerFixKey`) and re-associate on hover.
 */
interface HoverRegistryState {
  byModel: WeakMap<monaco.editor.ITextModel, Map<string, HoverFacts>>;
}

// Shared via globalThis so that, even when osd-monaco is bundled more than once,
// the writer (language.ts) and reader (hover_provider.ts) see one table.
const HOVER_REGISTRY_KEY = '__osdPPLLintHoverRegistry';

function getState(): HoverRegistryState {
  const globalScope = globalThis as typeof globalThis & {
    [HOVER_REGISTRY_KEY]?: HoverRegistryState;
  };

  if (!globalScope[HOVER_REGISTRY_KEY]) {
    globalScope[HOVER_REGISTRY_KEY] = { byModel: new WeakMap() };
  }

  return globalScope[HOVER_REGISTRY_KEY]!;
}

/**
 * Replace the facts table for a model. An empty map clears the entry so stale
 * facts never outlive the markers they belong to.
 */
export function setModelHoverFacts(
  model: monaco.editor.ITextModel,
  facts: Map<string, HoverFacts>
): void {
  if (facts.size === 0) {
    getState().byModel.delete(model);
    return;
  }
  getState().byModel.set(model, facts);
}

export function getModelHoverFacts(
  model: monaco.editor.ITextModel,
  key: string
): HoverFacts | undefined {
  return getState().byModel.get(model)?.get(key);
}

export function clearModelHoverFacts(model: monaco.editor.ITextModel): void {
  getState().byModel.delete(model);
}

// Re-export so callers build keys from the same function the fix table uses.
export { markerFixKey };
