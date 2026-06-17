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
 * The runtime bridge lints against the runtime grammar fetched from the data
 * source. When no runtime grammar is cached the bridge returns null and the
 * editor's worker lints against the compiled grammar instead, so the bridge is
 * only registered when the runtime grammar is also enabled.
 *
 * @returns a disposer that unregisters the bridge, or `undefined` when nothing
 *   was registered (so callers can store and invoke it unconditionally).
 */
export function registerPplLint(
  enabled: boolean,
  runtimeGrammarEnabled: boolean
): (() => void) | undefined {
  setPPLLintEnabled(enabled);
  if (enabled && runtimeGrammarEnabled) {
    return registerPPLLintBridge(lintRuntimePPLQuery);
  }
  return undefined;
}
