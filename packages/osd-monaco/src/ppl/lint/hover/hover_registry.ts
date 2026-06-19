/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

import { monaco } from '../../../monaco';
import type { HoverFacts } from '../hover_facts';
import { markerFixKey } from '../fix_registry';

// Canonical definition lives in `lint/hover_facts.ts` so it can be shared with
// `diagnostic.ts` (which must not depend on the hover UI module). Re-exported
// here for the existing hover-module importers.
export type { HoverFacts } from '../hover_facts';

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
