/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * PPL-lint configuration-change telemetry.
 *
 * Observes the single PPL-lint rules uiSetting
 * (`query:enhancements:pplLint:rules`) so we can answer "are people tuning the
 * lint rules — enabling/disabling them, changing severities — and which ones?".
 *
 * Two jobs from one registration (Approach D — baseline census + live per-rule
 * delta), using two distinct uiSettings channels so a failed save can't corrupt
 * the counts:
 *  - BASELINE census: a synchronous `get()` at subscribe time is the config this
 *    session is running with → recorded once as a `config_state` census. It seeds
 *    the diff snapshot and emits no deltas.
 *  - LIVE deltas: `getSaved$()` fires ONLY after a write is persisted on the
 *    server, so each emission is diffed per-rule against the prior snapshot →
 *    precise `rule_enabled` / `rule_disabled` / `rule_severity_changed` events.
 *
 * Why `getSaved$()` and not `get$()`: `set()` is optimistic — it updates the
 * local cache and fires `update$` (which `get$()` is built on) BEFORE the server
 * round-trip, then, if the server write fails, reverts the cache and fires
 * `update$` AGAIN with the old value. A `get$()`-driven diff would therefore
 * record a spurious `rule_disabled` (optimistic) followed by `rule_enabled`
 * (rollback) for a change that never persisted. `getSaved$()` fires only on the
 * confirmed-success path, so a failed save emits nothing.
 *
 * Both channels fire only on this client's own writes, so an edit in another tab
 * or by another user never reaches this subscription — deltas are not
 * double-counted across tabs. Register this exactly once per session (in the
 * plugin's `start()`), never in the query-editor hosts that already subscribe to
 * this key for revalidation, or the events would double-count.
 */

import { Subscription } from 'rxjs';
import { filter } from 'rxjs/operators';
import { getBundledCatalog } from '@osd/monaco';
import { UI_SETTINGS } from '../../../data/common';
import type { IUiSettingsClient } from '../../../../core/public';

type Severity = 'error' | 'warning' | 'info';
interface RuleSetting {
  enabled: boolean;
  severity: Severity;
}
type Rules = Record<string, RuleSetting>;

/**
 * Stable dashboard contract — the downstream dashboards key off these literals,
 * so a change here is a breaking contract change. Kept beside the shape used by
 * `PPL_LINT_TELEMETRY_EVENTS` in `@osd/monaco`.
 */
export const PPL_LINT_CONFIG_TELEMETRY_EVENTS = {
  /** Once per session on subscribe: the config this session is running with. */
  CONFIG_STATE: 'ppl_lint_config_state',
  /** A local write flipped a rule from disabled to enabled. */
  RULE_ENABLED: 'ppl_lint_rule_enabled',
  /** A local write flipped a rule from enabled to disabled. */
  RULE_DISABLED: 'ppl_lint_rule_disabled',
  /** A local write changed a rule's severity while it stayed enabled. */
  RULE_SEVERITY_CHANGED: 'ppl_lint_rule_severity_changed',
} as const;

// Dense default map seeded from the PUBLIC catalog (no cross-package import of
// the server-side PPL_LINT_RULE_DEFAULTS needed). Computed once from the bundled
// catalog, which is loaded synchronously with no network request.
const DEFAULT_RULES: Rules = Object.fromEntries(
  getBundledCatalog().map((r) => [r.id, { enabled: r.enabled, severity: r.severity as Severity }])
);

type RecordEvent = (event: { name: string; data: Record<string, any> }) => void;

const VALID_SEVERITIES: ReadonlySet<string> = new Set<Severity>(['error', 'warning', 'info']);

/**
 * Resolve the stored (sparse) setting into a dense map over the bundled catalog.
 * A non-object/array value (a malformed setting) yields all defaults, mirroring
 * the engine's no-op semantics for a malformed setting. Rules present in the
 * stored object but malformed (wrong field types, or a severity outside the
 * allowed literal set) fall back to their default, so a bogus value can never
 * surface as a spurious delta.
 */
function resolveRules(raw: unknown): Rules {
  const stored: Rules = raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Rules) : {};
  const out: Rules = {};
  for (const id of Object.keys(DEFAULT_RULES)) {
    const e = stored[id];
    out[id] =
      e && typeof e.enabled === 'boolean' && VALID_SEVERITIES.has(e.severity)
        ? { enabled: e.enabled, severity: e.severity }
        : DEFAULT_RULES[id];
  }
  return out;
}

/**
 * Read the authoritative, densified rules from uiSettings. `get()` resolves a
 * `type:'json'` setting by JSON.parse-ing the stored value (its registered
 * default is a JSON *string*), so no object default override is passed — that
 * would make core try to `JSON.parse` an object and throw for every session that
 * has not customized the setting. `resolveRules` then densifies whatever object
 * core returns, matching `buildOverridesFromSettings` (which also reads this key
 * with no object default).
 */
function readRules(uiSettings: IUiSettingsClient): Rules {
  return resolveRules(uiSettings.get<unknown>(UI_SETTINGS.QUERY_ENHANCEMENTS_PPL_LINT_RULES));
}

/**
 * Subscribe to the PPL-lint rules setting and emit config telemetry. Returns a
 * disposer that unsubscribes.
 *
 * @param uiSettings   the core uiSettings client (browser).
 * @param recordEvent  the same recorder callback the engine usage-events use.
 * @param masterEnabled  the PPL-lint master capability flag, captured on the
 *   census (it is a dynamic app config capability, not a uiSetting, so it is not
 *   observable via the settings client and never emits a change event). Recorded
 *   even when `false` so the "eligible but not using the feature" cohort is
 *   observable; register this whenever telemetry is available, not only when the
 *   feature is enabled.
 */
export function registerPPLLintConfigTelemetry(
  uiSettings: IUiSettingsClient,
  recordEvent: RecordEvent,
  masterEnabled: boolean
): () => void {
  // (1) BASELINE census — a synchronous read of the config this session runs
  // with. Seeds the diff snapshot; emits no deltas.
  let previous: Rules = readRules(uiSettings);
  const list = Object.entries(previous).map(([rule, s]) => ({ rule, ...s }));
  const deviations = list.filter(
    (r) =>
      DEFAULT_RULES[r.rule] &&
      (r.enabled !== DEFAULT_RULES[r.rule].enabled || r.severity !== DEFAULT_RULES[r.rule].severity)
  );
  recordEvent({
    name: PPL_LINT_CONFIG_TELEMETRY_EVENTS.CONFIG_STATE,
    data: {
      master_enabled: masterEnabled,
      total_rules: list.length,
      enabled_count: list.filter((r) => r.enabled).length,
      disabled_count: list.filter((r) => !r.enabled).length,
      deviations, // only rules differing from their bundled default
    },
  });

  // (2) LIVE DELTAS — driven by `getSaved$()`, which fires ONLY after a write is
  // persisted on the server. `set()` is optimistic (it fires `update$`/`get$`
  // before the round-trip and again on rollback), so a `get$()`-driven diff
  // would record a spurious disable/enable pair for a change that never
  // persisted. On each confirmed save we re-read the authoritative value via
  // `get()` — rather than trusting the event payload, whose shape varies (object
  // vs JSON string vs null on reset) — and diff it against the prior snapshot.
  const sub: Subscription = uiSettings
    .getSaved$()
    .pipe(filter((update) => update.key === UI_SETTINGS.QUERY_ENHANCEMENTS_PPL_LINT_RULES))
    .subscribe(() => {
      const current = readRules(uiSettings);
      const prev = previous;
      for (const rule of Object.keys(current)) {
        const before = prev[rule];
        const after = current[rule];
        if (!before) {
          continue;
        }
        if (before.enabled !== after.enabled) {
          recordEvent({
            name: after.enabled
              ? PPL_LINT_CONFIG_TELEMETRY_EVENTS.RULE_ENABLED
              : PPL_LINT_CONFIG_TELEMETRY_EVENTS.RULE_DISABLED,
            data: { rule, severity: after.severity },
          });
        }
        // A severity change is reported only while the rule stays enabled on both
        // sides; a simultaneous disable is already signaled once by RULE_DISABLED.
        if (before.enabled && after.enabled && before.severity !== after.severity) {
          recordEvent({
            name: PPL_LINT_CONFIG_TELEMETRY_EVENTS.RULE_SEVERITY_CHANGED,
            data: { rule, from: before.severity, to: after.severity },
          });
        }
      }
      previous = current;
    });

  return () => sub.unsubscribe();
}
