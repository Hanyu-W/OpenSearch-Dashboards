/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

import { monaco } from '../monaco';
import type { PPLValidationContext } from './validation_provider';
import type { LintResult } from './lint/diagnostic';
import type { BundleRuleOverrides } from './lint/types';

/**
 * Minimal HTTP client the explain-backed lint pass uses to POST the `_explain`
 * request. Declared structurally rather than as core's `HttpSetup` because the
 * `@osd/monaco` package cannot depend on OpenSearch Dashboards core. The host's
 * `services.http` is assignable to this. `body`/`query` follow core's
 * `HttpFetchOptions` shape; the return is left loose so the caller shapes it.
 */
export interface PPLLintHttpClient {
  post: (path: string, options?: { body?: any; query?: Record<string, any> }) => Promise<any>;
}

/**
 * Host-supplied lint context. Extends the validation context with the
 * field-metadata and settings that field-aware (Bucket B) rules consume.
 */
export interface PPLLintContext extends PPLValidationContext {
  /** True when the data source is identified as running the Calcite engine. */
  isCalcite?: boolean;
  /** Index field names; empty/absent suppresses Bucket-B rules. */
  fields?: Set<string>;
  /** Field name -> esTypes[0]. */
  typeMap?: Map<string, string>;
  /**
   * Names of object fields mapped with `enabled: false`. These are absent from
   * `_field_caps` (and therefore from `typeMap`), so they are sourced from a
   * `_mappings` walk. Used by the `enabled-false-object` rule.
   */
  disabledObjectFields?: Set<string>;
  /** Visible index names, for wildcard-source-zero-match. */
  visibleIndices?: string[];
  settings?: { allJoinTypesAllowed?: boolean };
  /**
   * Per-rule overrides resolved from uiSettings (enable/disable + severity).
   * Carried verbatim into `LintRunContext.overrides` so the engine merges them
   * over the bundled catalog. On the runtime (main-thread) path this rides
   * through automatically; the compiled worker fallback threads it explicitly.
   */
  overrides?: BundleRuleOverrides;
  /**
   * HTTP client for the explain-backed lint pass. Present only on the runtime
   * (main-thread) bridge path — the compiled worker fallback has no HTTP access,
   * so explain rules are silently skipped there (they are an enhancement; the
   * worker still ships every static rule). Non-serializable, so it never crosses
   * the worker `postMessage` boundary.
   */
  http?: PPLLintHttpClient;
}

export interface PPLLintBridgeRequest {
  content: string;
  model: monaco.editor.IModel;
  context?: PPLLintContext;
}

export type PPLLintBridge = (
  request: PPLLintBridgeRequest
) => Promise<LintResult | null> | LintResult | null;

interface PPLLintGlobalState {
  bridge: PPLLintBridge | undefined;
  contexts: WeakMap<monaco.editor.IModel, PPLLintContext>;
  enabled: boolean;
}

// Use globalThis so multiple bundled Monaco/language modules share one bridge
// registry and one per-model context map.
const PPL_LINT_GLOBAL_STATE_KEY = '__osdPPLLintGlobalState';

function getGlobalLintState(): PPLLintGlobalState {
  const globalScope = globalThis as typeof globalThis & {
    [PPL_LINT_GLOBAL_STATE_KEY]?: PPLLintGlobalState;
  };

  if (!globalScope[PPL_LINT_GLOBAL_STATE_KEY]) {
    globalScope[PPL_LINT_GLOBAL_STATE_KEY] = {
      bridge: undefined,
      contexts: new WeakMap<monaco.editor.IModel, PPLLintContext>(),
      // Default enabled; the host (data plugin) may disable via the
      // QUERY_ENHANCEMENTS_PPL_LINT setting (R1).
      enabled: true,
    };
  }

  return globalScope[PPL_LINT_GLOBAL_STATE_KEY]!;
}

/**
 * Enable or disable the linter feature globally. The data plugin calls this
 * from its `start()` based on the QUERY_ENHANCEMENTS_PPL_LINT advanced setting.
 * When disabled, `isPPLLintEnabled` returns false and the lifecycle skips
 * emitting `PPL_LINT` markers.
 */
export function setPPLLintEnabled(enabled: boolean): void {
  getGlobalLintState().enabled = enabled;
}

export function isPPLLintEnabled(): boolean {
  return getGlobalLintState().enabled;
}

export function registerPPLLintBridge(bridge?: PPLLintBridge): () => void {
  const state = getGlobalLintState();
  state.bridge = bridge;
  return () => {
    if (state.bridge === bridge) {
      state.bridge = undefined;
    }
  };
}

export function setPPLLintContext(model: monaco.editor.IModel, context: PPLLintContext): void {
  getGlobalLintState().contexts.set(model, context);
}

/**
 * Read the host-supplied lint context stored for a model. The runtime bridge
 * receives the context directly in its request, but the compiled-grammar
 * fallback runs in a web worker with no access to this registry, so the
 * lifecycle reads the context here on the main thread and forwards the parts
 * the worker needs (per-rule `overrides`) across `postMessage`.
 */
export function getPPLLintContext(model: monaco.editor.IModel): PPLLintContext | undefined {
  return getGlobalLintState().contexts.get(model);
}

export function clearPPLLintContext(model: monaco.editor.IModel): void {
  getGlobalLintState().contexts.delete(model);
}

/**
 * Resolve a lint result using the bridge contract:
 *  1. bridge returns non-null LintResult → use it (even when empty).
 *  2. bridge returns null/undefined → compiled fallback.
 *  3. bridge throws → compiled fallback.
 *  4. no bridge registered → compiled fallback.
 *  5/6 unregister + cross-bundle sharing handled by the global state above.
 */
export async function resolvePPLLintResult(
  model: monaco.editor.IModel,
  content: string,
  fallbackLint: (content: string) => Promise<LintResult>
): Promise<LintResult> {
  const state = getGlobalLintState();
  if (state.bridge) {
    try {
      const runtimeResult = await state.bridge({
        content,
        model,
        context: state.contexts.get(model),
      });
      // A non-null result — even with an empty diagnostics list — is a
      // completed lint that found nothing; do NOT fall back (R2.7).
      if (runtimeResult !== null && runtimeResult !== undefined) {
        return runtimeResult;
      }
    } catch {
      // Fall through to compiled lint on runtime-bridge failures (R2.4).
    }
  }

  return fallbackLint(content);
}
