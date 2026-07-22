/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * PPL lint feature-usage telemetry.
 *
 * The lint engine (marker pass, hover card, quick-fix code actions) lives in
 * `@osd/monaco`, which cannot depend on OpenSearch Dashboards core and so cannot
 * call `core.telemetry.getPluginRecorder()` directly. Instead the host (the
 * `query_enhancements` plugin) injects a sink via {@link registerPPLLintTelemetry}
 * during its `start()`, and the engine emits structured, telemetry-API-agnostic
 * events through {@link emitPPLLintTelemetry}. This mirrors the sink-injection
 * pattern used by `lint_bridge.ts`.
 *
 * The engine knows nothing about `recordEvent`/OTel; the plugin-side callback is
 * the only place that touches the core telemetry API.
 */

/**
 * Lint feature-usage event names. They follow the `<domain>_<verb>` snake_case
 * convention shared with the PPL query emitter, and the downstream dashboards key
 * off the exact strings — treat them as a stable contract, not a display label.
 */
export const PPL_LINT_TELEMETRY_EVENTS = {
  /** A lint marker was produced for the model (deduped per rule per pass). */
  DIAGNOSTIC_SHOWN: 'ppl_lint_diagnostic_shown',
  /** The hover card rendered for a lint marker under the cursor. */
  HOVER_SHOWN: 'ppl_lint_hover_shown',
  /** The code-action provider offered a lint quick-fix. */
  QUICKFIX_OFFERED: 'ppl_lint_quickfix_offered',
  /** A lint quick-fix was invoked (its edit applied). */
  QUICKFIX_CLICKED: 'ppl_lint_quickfix_clicked',
  /**
   * The "✨ Ask AI to fix" action was offered (a lint marker had no deterministic
   * fix). Paired with {@link AI_FIX_CLICKED} it forms the AI-fix funnel, mirroring
   * {@link QUICKFIX_OFFERED}/{@link QUICKFIX_CLICKED} for deterministic fixes.
   */
  AI_FIX_OFFERED: 'ppl_lint_ai_fix_offered',
  /** The "✨ Ask AI to fix" action was clicked and the AI chat request was sent. */
  AI_FIX_CLICKED: 'ppl_lint_ai_fix_clicked',
} as const;

/**
 * Sentinel `rule` value for a marker that carries no resolvable rule id. Emitted
 * instead of `undefined` because `JSON.stringify` drops undefined-valued keys, so
 * an `undefined` rule would arrive downstream as a missing field — making a
 * genuine "unknown rule" indistinguishable from a broken emitter or schema
 * violation. A concrete sentinel lets the dashboards bucket these explicitly.
 */
export const PPL_LINT_UNKNOWN_RULE = 'unknown';

/** Map an optional rule id to the always-present `rule` field (see sentinel). */
export function ruleLabel(ruleId?: string): string {
  return ruleId ?? PPL_LINT_UNKNOWN_RULE;
}

/**
 * Opaque, stable-within-a-pass per-finding id derived from the marker's canonical
 * key (position + message + rule). Lets `offered`/`clicked`/`hover` events for the
 * same finding be correlated downstream (a per-finding funnel, not just per-rule)
 * without shipping the raw marker key — which embeds the diagnostic message and
 * can contain field names or query fragments. The hash is one-way and short, so
 * no message content is recoverable from it.
 */
export function markerTelemetryId(markerKey: string): string {
  let hash = 0;
  for (let i = 0; i < markerKey.length; i++) {
    hash = (hash * 31 + markerKey.charCodeAt(i)) % 4294967291;
  }
  return hash.toString(36).padStart(7, '0');
}

/**
 * Id of the Monaco command dispatched when a lint quick-fix is invoked, so the
 * engine can record a `quickfix_clicked` event. Monaco applies a code action's
 * `edit` before running its `command`, so attaching this to the quick-fix keeps
 * the fix behavior intact and adds a reliable "clicked" signal.
 */
export const PPL_LINT_QUICKFIX_COMMAND_ID = 'ppl.lint.quickfixApplied';

/**
 * A telemetry event the engine emits. Deliberately telemetry-API-agnostic: a
 * name plus a structured `data` object. `data` is always an object (never
 * omitted) because core's `TelemetryEvent.data` is required.
 *
 * `rule` is always present — a resolvable rule id or {@link PPL_LINT_UNKNOWN_RULE}
 * — so downstream never sees a missing field (see the sentinel note). `marker` is
 * an opaque per-finding correlation id (see {@link markerTelemetryId}) that lets
 * `offered`/`clicked`/`hover` events for the same finding be joined; it is absent
 * only for `diagnostic_shown`, which is a per-rule (not per-marker) count.
 */
export interface PPLLintTelemetryEvent {
  name: string;
  data: { rule: string; marker?: string };
}

type PPLLintTelemetrySink = (event: PPLLintTelemetryEvent) => void;

interface PPLLintTelemetryState {
  sink: PPLLintTelemetrySink | undefined;
}

// Use globalThis so multiple bundled Monaco/language modules share one sink,
// matching the `lint_bridge.ts` global-state precedent.
const PPL_LINT_TELEMETRY_STATE_KEY = '__osdPPLLintTelemetryState';

function getTelemetryState(): PPLLintTelemetryState {
  const globalScope = globalThis as typeof globalThis & {
    [PPL_LINT_TELEMETRY_STATE_KEY]?: PPLLintTelemetryState;
  };

  if (!globalScope[PPL_LINT_TELEMETRY_STATE_KEY]) {
    globalScope[PPL_LINT_TELEMETRY_STATE_KEY] = { sink: undefined };
  }

  return globalScope[PPL_LINT_TELEMETRY_STATE_KEY]!;
}

/**
 * Register the host's telemetry sink. The `query_enhancements` plugin calls this
 * from its `start()` with a callback that forwards to
 * `core.telemetry.getPluginRecorder().recordEvent(...)`. When no sink is
 * registered (or the host passes none), {@link emitPPLLintTelemetry} is a no-op.
 *
 * @returns a disposer that clears the sink (only if it is still the current one).
 */
export function registerPPLLintTelemetry(sink?: PPLLintTelemetrySink): () => void {
  const state = getTelemetryState();
  state.sink = sink;
  return () => {
    if (state.sink === sink) {
      state.sink = undefined;
    }
  };
}

/**
 * Emit a lint feature-usage event through the host sink. Best-effort: no-ops when
 * no sink is registered, and swallows sink errors so telemetry never disrupts the
 * editor.
 */
export function emitPPLLintTelemetry(event: PPLLintTelemetryEvent): void {
  const { sink } = getTelemetryState();
  if (!sink) {
    return;
  }
  try {
    sink(event);
  } catch {
    // Telemetry is best-effort; never surface a sink failure to the editor.
  }
}

/**
 * Per-model, per-lint-pass dedup so `hover_shown` / `quickfix_offered` count
 * distinct user-facing occurrences rather than Monaco's repeated provider
 * invocations. Monaco re-invokes `provideHover` for every hover anchor (a single
 * character position) and auto-triggers `provideCodeActions` on every cursor move
 * over a marker, so emitting on each call would count mouse travel instead of
 * hovers/offers. This mirrors how `diagnostic_shown` counts once per rule per
 * pass: within one lint pass (a stable set of markers), each distinct marker's
 * hover/offer counts once; editing the query starts a new pass, which resets the
 * state and re-arms counting. Keyed by the model object via WeakMap so disposed
 * models are collected automatically; typed as `object` to keep the engine free
 * of a core/monaco type dependency here.
 */
interface PPLLintTelemetryDedup {
  /** Marker keys already counted as "hover shown" in the current lint pass. */
  hoveredKeys: Set<string>;
  /** Marker keys already counted as "quick-fix offered" in the current pass. */
  offeredKeys: Set<string>;
  /** Marker keys already counted as "AI-fix offered" in the current pass. */
  aiOfferedKeys: Set<string>;
}

const dedupByModel = new WeakMap<object, PPLLintTelemetryDedup>();

function getDedup(model: object): PPLLintTelemetryDedup {
  let dedup = dedupByModel.get(model);
  if (!dedup) {
    dedup = {
      hoveredKeys: new Set<string>(),
      offeredKeys: new Set<string>(),
      aiOfferedKeys: new Set<string>(),
    };
    dedupByModel.set(model, dedup);
  }
  return dedup;
}

/**
 * True the first time a hover card for `markerKey` is shown in the current lint
 * pass, collapsing Monaco's per-anchor re-invocation storm into one event per
 * distinct marker. A new lint pass resets the state so hovering the same finding
 * after an edit counts again.
 */
export function shouldEmitHoverShown(model: object, markerKey: string): boolean {
  const { hoveredKeys } = getDedup(model);
  if (hoveredKeys.has(markerKey)) {
    return false;
  }
  hoveredKeys.add(markerKey);
  return true;
}

/**
 * True the first time a quick-fix for `markerKey` is offered in the current lint
 * pass; repeat `provideCodeActions` calls for the same marker (Monaco auto-fires
 * these on every cursor move) are deduped until the next pass resets the state.
 */
export function shouldEmitQuickfixOffered(model: object, markerKey: string): boolean {
  const { offeredKeys } = getDedup(model);
  if (offeredKeys.has(markerKey)) {
    return false;
  }
  offeredKeys.add(markerKey);
  return true;
}

/**
 * True the first time an "Ask AI to fix" action for `markerKey` is offered in the
 * current lint pass; tracked separately from the deterministic quick-fix offer
 * (the two are mutually exclusive per marker, but keeping distinct counters keeps
 * each funnel independent) so Monaco's per-cursor-move re-invocation counts one
 * offer, not caret ticks.
 */
export function shouldEmitAiFixOffered(model: object, markerKey: string): boolean {
  const { aiOfferedKeys } = getDedup(model);
  if (aiOfferedKeys.has(markerKey)) {
    return false;
  }
  aiOfferedKeys.add(markerKey);
  return true;
}

/**
 * Reset a model's dedup state. Called by the lint lifecycle when a new pass
 * applies markers (a fresh opportunity, so the next hover/offer counts again)
 * and when a model is disposed or leaves PPL.
 */
export function resetPPLLintTelemetryDedup(model: object): void {
  dedupByModel.delete(model);
}
