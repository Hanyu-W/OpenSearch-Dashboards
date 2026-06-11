/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

import { monaco } from '../../monaco';

/**
 * A quick-fix payload in Monaco coordinates, ready for the code-action provider
 * to turn into a workspace edit. Mirrors the `fix` shape attached to markers by
 * {@link diagnosticToMarker}, but lives in a side table rather than on the
 * marker object.
 */
export interface MarkerFix {
  title: string;
  text: string;
  range?: {
    startLineNumber: number;
    startColumn: number;
    endLineNumber: number;
    endColumn: number;
  };
}

/**
 * Fields a marker keeps after passing through Monaco's MarkerService. The key
 * is built only from these because the service rebuilds marker objects from a
 * fixed field list and drops everything else (see note below).
 */
interface MarkerKeyParts {
  startLineNumber: number;
  startColumn: number;
  endLineNumber: number;
  endColumn: number;
  message: string;
}

interface FixRegistryState {
  byModel: WeakMap<monaco.editor.ITextModel, Map<string, MarkerFix>>;
}

// Shared via globalThis so that, even when osd-monaco is bundled more than once,
// the writer (language.ts) and reader (code_action_provider.ts) see one table.
const FIX_REGISTRY_KEY = '__osdPPLLintFixRegistry';

function getState(): FixRegistryState {
  const globalScope = globalThis as typeof globalThis & {
    [FIX_REGISTRY_KEY]?: FixRegistryState;
  };

  if (!globalScope[FIX_REGISTRY_KEY]) {
    globalScope[FIX_REGISTRY_KEY] = { byModel: new WeakMap() };
  }

  return globalScope[FIX_REGISTRY_KEY]!;
}

/**
 * Stable key correlating a stored fix with a marker after the marker has
 * round-tripped through Monaco's MarkerService.
 *
 * `setModelMarkers` stores markers via `MarkerService._toMarker`, which rebuilds
 * each marker from only its documented fields (code, severity, message, source,
 * the four position fields, relatedInformation, tags) and discards any custom
 * property. So a `fix` hung directly off the marker never reaches the
 * code-action provider. We key off the position + message, all of which the
 * service preserves verbatim, so the provider can re-associate the fix.
 */
export function markerFixKey(marker: MarkerKeyParts): string {
  return [
    marker.startLineNumber,
    marker.startColumn,
    marker.endLineNumber,
    marker.endColumn,
    marker.message,
  ].join(':');
}

/**
 * Replace the fix table for a model. An empty map clears the entry so stale
 * fixes never outlive the markers they belong to.
 */
export function setModelFixes(
  model: monaco.editor.ITextModel,
  fixes: Map<string, MarkerFix>
): void {
  if (fixes.size === 0) {
    getState().byModel.delete(model);
    return;
  }
  getState().byModel.set(model, fixes);
}

export function getModelFix(model: monaco.editor.ITextModel, key: string): MarkerFix | undefined {
  return getState().byModel.get(model)?.get(key);
}

export function clearModelFixes(model: monaco.editor.ITextModel): void {
  getState().byModel.delete(model);
}
