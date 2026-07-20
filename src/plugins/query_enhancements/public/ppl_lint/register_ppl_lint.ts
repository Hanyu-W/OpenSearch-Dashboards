/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  PPLLintTelemetryEvent,
  registerPPLLintBridge,
  registerPPLLintTelemetry,
  setPPLLintEnabled,
} from '@osd/monaco';
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
 * When a `telemetrySink` is supplied and lint is enabled, feature-usage events
 * (diagnostic shown, hover shown, quick-fix offered/clicked) are forwarded to it.
 * The sink is wired whenever lint is enabled — the compiled-worker fallback still
 * produces those interactions even where the runtime bridge is not the active
 * lint path.
 *
 * @returns a disposer that unregisters everything registered here, or
 *   `undefined` when nothing was registered (so callers can store and invoke it
 *   unconditionally).
 */
export function registerPplLint(
  enabled: boolean,
  telemetrySink?: (event: PPLLintTelemetryEvent) => void
): (() => void) | undefined {
  setPPLLintEnabled(enabled);
  if (!enabled) {
    return undefined;
  }

  const disposers: Array<() => void> = [];
  if (telemetrySink) {
    disposers.push(registerPPLLintTelemetry(telemetrySink));
  }
  disposers.push(registerPPLLintBridge(lintRuntimePPLQuery));

  return () => disposers.forEach((dispose) => dispose());
}
