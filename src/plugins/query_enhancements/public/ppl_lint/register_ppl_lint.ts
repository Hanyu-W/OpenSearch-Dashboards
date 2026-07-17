/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

import { registerPPLLintBridge, setPPLLintEnabled } from '@osd/monaco';
import { lintRuntimePPLQuery } from '../../../data/public';

/**
 * Wire the PPL linter into the Monaco editor. The linter is gated by the
 * `queryEnhancements.pplLint` dynamic app config capability (disabled by
 * default); when off this no-ops the engine so no markers are produced and the
 * worker never spins up.
 *
 * The bridge stays registered whenever the lint capability is enabled and
 * selects runtime or compiled behavior from the lint context. It can layer
 * explain-backed diagnostics over the compiled worker fallback; `_explain`
 * stays on the main thread where the HTTP client and model context live.
 *
 * @returns a disposer that unregisters the bridge, or `undefined` when nothing
 *   was registered (so callers can store and invoke it unconditionally).
 */
export function registerPplLint(enabled: boolean): (() => void) | undefined {
  setPPLLintEnabled(enabled);
  if (enabled) {
    return registerPPLLintBridge(lintRuntimePPLQuery);
  }
  return undefined;
}
