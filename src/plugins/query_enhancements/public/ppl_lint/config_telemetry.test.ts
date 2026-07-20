/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

import { BehaviorSubject } from 'rxjs';
import { map } from 'rxjs/operators';

// A small, deterministic bundled catalog so the tests do not depend on the real
// 19-rule set. `getBundledCatalog` is the only @osd/monaco symbol this module
// uses, so the whole barrel can be replaced.
const CATALOG = [
  { id: 'division-by-zero', enabled: true, severity: 'warning' },
  { id: 'head-without-sort', enabled: true, severity: 'info' },
  { id: 'rex-scan-cost', enabled: false, severity: 'info' },
];
jest.mock('@osd/monaco', () => ({
  getBundledCatalog: () => CATALOG,
}));

import {
  registerPPLLintConfigTelemetry,
  PPL_LINT_CONFIG_TELEMETRY_EVENTS,
} from './config_telemetry';
import { UI_SETTINGS } from '../../../data/common';

type Event = { name: string; data: Record<string, any> };

// uiSettings stub that mirrors core's real `type:'json'` semantics: the stored
// value is a JSON *string* and core JSON.parse-es it (resolveValue). The setting
// is registered with a JSON-string default, so a caller must NOT pass a JS
// object as the default override — that would make core JSON.parse an object and
// throw. `initial` here is the parsed object the tests want to observe; the stub
// stringifies it to reproduce the storage layer, and get$ parses it back.
//
// The DEFAULT_JSON constant is the registered server default (a JSON string of
// the bundled defaults), returned when the caller passes no object override and
// the user has not customized the setting.
const DEFAULT_JSON = JSON.stringify(
  Object.fromEntries(CATALOG.map((r) => [r.id, { enabled: r.enabled, severity: r.severity }]))
);

function makeUiSettings(initialObject: unknown) {
  // Storage holds a JSON string (undefined => user has not customized).
  const storedString = initialObject === undefined ? undefined : JSON.stringify(initialObject);
  const subject = new BehaviorSubject<string | undefined>(storedString);
  const uiSettings = {
    get$: (key: string, defaultOverride?: unknown) => {
      expect(key).toBe(UI_SETTINGS.QUERY_ENHANCEMENTS_PPL_LINT_RULES);
      // Regression guard for the critical JSON.parse bug: a JS object default
      // override would be JSON.parse-d by core and throw. The caller must pass
      // no override (undefined) and let the registered string default apply.
      expect(defaultOverride).toBeUndefined();
      return subject.pipe(
        // Mirror core resolveValue: JSON.parse the stored string, or the
        // registered JSON-string default when the user value is null.
        map((raw: string | undefined) => JSON.parse(raw ?? DEFAULT_JSON))
      );
    },
  };
  // `set` pushes a new stored value the way a local write would.
  const set = (value: unknown) => subject.next(JSON.stringify(value));
  return { uiSettings: uiSettings as any, set };
}

describe('registerPPLLintConfigTelemetry', () => {
  let events: Event[];
  let recordEvent: (e: Event) => void;

  beforeEach(() => {
    events = [];
    recordEvent = (e) => events.push(e);
  });

  it('emits a single config_state census on subscribe and no deltas', () => {
    const { uiSettings } = makeUiSettings(undefined); // undefined => all defaults
    const dispose = registerPPLLintConfigTelemetry(uiSettings, recordEvent, true);

    expect(events).toHaveLength(1);
    expect(events[0]).toEqual({
      name: PPL_LINT_CONFIG_TELEMETRY_EVENTS.CONFIG_STATE,
      data: {
        master_enabled: true,
        total_rules: 3,
        enabled_count: 2,
        disabled_count: 1,
        deviations: [], // stored===defaults → no deviation
      },
    });
    dispose();
  });

  it('reports deviations from the bundled defaults in the census', () => {
    // division-by-zero disabled + head-without-sort severity bumped to error.
    const { uiSettings } = makeUiSettings({
      'division-by-zero': { enabled: false, severity: 'warning' },
      'head-without-sort': { enabled: true, severity: 'error' },
    });
    registerPPLLintConfigTelemetry(uiSettings, recordEvent, true);

    expect(events).toHaveLength(1);
    const { deviations, enabled_count, disabled_count } = events[0].data;
    // division-by-zero disabled + rex-scan-cost disabled-by-default → 1 enabled
    // (head-without-sort), 2 disabled.
    expect(enabled_count).toBe(1);
    expect(disabled_count).toBe(2);
    expect(deviations).toEqual(
      expect.arrayContaining([
        { rule: 'division-by-zero', enabled: false, severity: 'warning' },
        { rule: 'head-without-sort', enabled: true, severity: 'error' },
      ])
    );
    expect(deviations).toHaveLength(2);
  });

  it('emits rule_disabled when a rule is turned off', () => {
    const { uiSettings, set } = makeUiSettings(undefined);
    registerPPLLintConfigTelemetry(uiSettings, recordEvent, true);
    events.length = 0; // drop the census

    set({ 'division-by-zero': { enabled: false, severity: 'warning' } });

    expect(events).toEqual([
      {
        name: PPL_LINT_CONFIG_TELEMETRY_EVENTS.RULE_DISABLED,
        data: { rule: 'division-by-zero', severity: 'warning' },
      },
    ]);
  });

  it('emits rule_enabled when a disabled-by-default rule is turned on', () => {
    const { uiSettings, set } = makeUiSettings(undefined);
    registerPPLLintConfigTelemetry(uiSettings, recordEvent, true);
    events.length = 0;

    set({ 'rex-scan-cost': { enabled: true, severity: 'info' } });

    expect(events).toEqual([
      {
        name: PPL_LINT_CONFIG_TELEMETRY_EVENTS.RULE_ENABLED,
        data: { rule: 'rex-scan-cost', severity: 'info' },
      },
    ]);
  });

  it('emits rule_severity_changed when severity changes while the rule stays enabled', () => {
    const { uiSettings, set } = makeUiSettings(undefined);
    registerPPLLintConfigTelemetry(uiSettings, recordEvent, true);
    events.length = 0;

    set({ 'division-by-zero': { enabled: true, severity: 'error' } });

    expect(events).toEqual([
      {
        name: PPL_LINT_CONFIG_TELEMETRY_EVENTS.RULE_SEVERITY_CHANGED,
        data: { rule: 'division-by-zero', from: 'warning', to: 'error' },
      },
    ]);
  });

  it('emits only rule_disabled (not severity_changed) when a rule is disabled and its severity also differs', () => {
    const { uiSettings, set } = makeUiSettings(undefined);
    registerPPLLintConfigTelemetry(uiSettings, recordEvent, true);
    events.length = 0;

    set({ 'division-by-zero': { enabled: false, severity: 'error' } });

    expect(events).toEqual([
      {
        name: PPL_LINT_CONFIG_TELEMETRY_EVENTS.RULE_DISABLED,
        data: { rule: 'division-by-zero', severity: 'error' },
      },
    ]);
  });

  it('emits nothing on a no-op re-save (identical value)', () => {
    const { uiSettings, set } = makeUiSettings({
      'division-by-zero': { enabled: false, severity: 'warning' },
    });
    registerPPLLintConfigTelemetry(uiSettings, recordEvent, true);
    events.length = 0;

    // Re-emit the same effective config.
    set({ 'division-by-zero': { enabled: false, severity: 'warning' } });

    expect(events).toHaveLength(0);
  });

  it('treats a malformed (non-object) value as all-defaults, emitting no deltas after baseline', () => {
    const { uiSettings, set } = makeUiSettings(undefined);
    registerPPLLintConfigTelemetry(uiSettings, recordEvent, true);
    events.length = 0;

    // An array is malformed for this recordOf setting → resolves to all defaults,
    // which equals the baseline, so no deltas.
    set(['not', 'an', 'object']);

    expect(events).toHaveLength(0);
  });

  it('stops observing after the disposer runs', () => {
    const { uiSettings, set } = makeUiSettings(undefined);
    const dispose = registerPPLLintConfigTelemetry(uiSettings, recordEvent, true);
    events.length = 0;
    dispose();

    set({ 'division-by-zero': { enabled: false, severity: 'warning' } });
    expect(events).toHaveLength(0);
  });

  it('exposes the stable config-event-name contract', () => {
    expect(PPL_LINT_CONFIG_TELEMETRY_EVENTS).toEqual({
      CONFIG_STATE: 'ppl_lint_config_state',
      RULE_ENABLED: 'ppl_lint_rule_enabled',
      RULE_DISABLED: 'ppl_lint_rule_disabled',
      RULE_SEVERITY_CHANGED: 'ppl_lint_rule_severity_changed',
    });
  });
});
