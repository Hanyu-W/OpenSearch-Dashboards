/*
 * SPDX-License-Identifier: Apache-2.0
 *
 * The OpenSearch Contributors require contributions made to
 * this file be licensed under the Apache-2.0 license or a
 * compatible open source license.
 *
 * Any modifications Copyright OpenSearch Contributors. See
 * GitHub history for details.
 */

import { readFileSync } from 'fs';
import { resolve } from 'path';
import { UiSettingsParams } from 'opensearch-dashboards/server';
import { getUiSettings } from './ui_settings';
import { UI_SETTINGS } from '../common';

// The bundled catalog is the source of truth for each rule's default `enabled`
// and `severity`. The registered per-rule defaults must mirror it (design §5.1)
// so "reset to default" and the sparse-storage diff agree on the baseline. Read
// the JSON at runtime rather than `import`-ing it: the data plugin cannot import
// `@osd/monaco` server-side (jest mocks it), and a cross-package relative import
// into `packages/osd-monaco/src` would escape this project's TS rootDir under
// the project-reference build. A plain file read sidesteps both.
interface BundledRule {
  id: string;
  enabled: boolean;
  severity: 'error' | 'warning' | 'info';
}
const bundledCatalog: BundledRule[] = JSON.parse(
  readFileSync(
    resolve(__dirname, '../../../../packages/osd-monaco/src/ppl/lint/rules_catalog.json'),
    'utf8'
  )
);

const PREFIX = UI_SETTINGS.QUERY_ENHANCEMENTS_PPL_LINT_RULE_PREFIX;

// The registered scope values equal the `UiSettingScope` enum string values
// (`'global'`, `'user'`, `'workspace'`); assert against those to avoid importing
// core/server (the data plugin cannot, due to a circular dependency — see the
// import note in ui_settings.ts).
const ruleKeys = (settings: Record<string, UiSettingsParams>) =>
  Object.keys(settings).filter((k) => k.startsWith(PREFIX));

describe('data plugin per-rule PPL lint uiSettings', () => {
  describe('registration', () => {
    it('registers one key per bundled catalog rule, with the rule prefix', () => {
      const settings = getUiSettings(false);
      const keys = ruleKeys(settings);

      expect(keys).toHaveLength(bundledCatalog.length);
      for (const rule of bundledCatalog) {
        expect(settings[`${PREFIX}${rule.id}`]).toBeDefined();
      }
    });

    it('mirrors the bundled catalog enabled/severity as the registered default (§5.1)', () => {
      const settings = getUiSettings(false);

      for (const rule of bundledCatalog) {
        expect(settings[`${PREFIX}${rule.id}`].value).toEqual({
          enabled: rule.enabled,
          severity: rule.severity,
        });
      }
    });

    it('does not set requiresPageReload (the editor live-revalidates, §6)', () => {
      const settings = getUiSettings(true);
      for (const key of ruleKeys(settings)) {
        expect(settings[key].requiresPageReload).toBeFalsy();
      }
    });

    it('groups the rule keys under the search category', () => {
      const settings = getUiSettings(false);
      for (const key of ruleKeys(settings)) {
        expect(settings[key].category).toEqual(['search']);
      }
    });
  });

  describe('scope', () => {
    it('registers USER + GLOBAL when the workspace feature is off', () => {
      const settings = getUiSettings(false);
      for (const key of ruleKeys(settings)) {
        expect(settings[key].scope).toEqual(['user', 'global']);
      }
    });

    // The dual/multi-scope registration mirrors the `defaultDataSource`
    // precedent (design §3). The per-rule config UI always sends an explicit
    // `?scope=`, so the `groupChanges` GLOBAL-default trap (a multi-scope key
    // routes to GLOBAL when scope is omitted) never applies in practice.
    it('adds WORKSPACE between USER and GLOBAL when the workspace feature is on', () => {
      const settings = getUiSettings(true);
      for (const key of ruleKeys(settings)) {
        expect(settings[key].scope).toEqual(['user', 'workspace', 'global']);
      }
    });
  });

  describe('value schema', () => {
    const validate = (settings: Record<string, UiSettingsParams>, ruleId: string) => (
      value: unknown
    ) => settings[`${PREFIX}${ruleId}`].schema.validate(value);

    it('accepts a well-formed { enabled, severity } object for every severity', () => {
      const v = validate(getUiSettings(false), 'division-by-zero');
      expect(() => v({ enabled: true, severity: 'error' })).not.toThrow();
      expect(() => v({ enabled: true, severity: 'warning' })).not.toThrow();
      expect(() => v({ enabled: false, severity: 'info' })).not.toThrow();
    });

    it('rejects an unknown severity', () => {
      const v = validate(getUiSettings(false), 'division-by-zero');
      expect(() => v({ enabled: true, severity: 'critical' })).toThrow();
    });

    it('rejects a non-boolean enabled', () => {
      const v = validate(getUiSettings(false), 'division-by-zero');
      expect(() => v({ enabled: 'yes', severity: 'warning' })).toThrow();
    });

    it('rejects a missing field', () => {
      const v = validate(getUiSettings(false), 'division-by-zero');
      expect(() => v({ enabled: true })).toThrow();
      expect(() => v({ severity: 'warning' })).toThrow();
    });

    it('rejects an extra/unknown field', () => {
      const v = validate(getUiSettings(false), 'division-by-zero');
      expect(() => v({ enabled: true, severity: 'warning', foo: 1 })).toThrow();
    });

    it('rejects a non-object value', () => {
      const v = validate(getUiSettings(false), 'division-by-zero');
      expect(() => v('warning')).toThrow();
      expect(() => v(true)).toThrow();
    });
  });
});
