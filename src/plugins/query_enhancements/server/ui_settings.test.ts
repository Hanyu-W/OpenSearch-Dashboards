/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

import { readFileSync } from 'fs';
import { resolve } from 'path';
import { UiSettingScope, UiSettingsParams } from 'opensearch-dashboards/server';
import { getPplLintRuleSettings } from './ui_settings';
import { UI_SETTINGS } from '../../data/common';

// The bundled catalog is the source of truth for each rule's default `enabled`
// and `severity`. The registered default JSON blob must mirror it so "reset to
// default" and the sparse-storage diff agree on the baseline. Read the JSON at
// runtime rather than `import`-ing it: query_enhancements cannot import
// `@osd/monaco` server-side (jest mocks it), and a cross-package relative
// import into `packages/osd-monaco/src` would escape this project's TS rootDir
// under the project-reference build. A plain file read sidesteps both.
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

const KEY = UI_SETTINGS.QUERY_ENHANCEMENTS_PPL_LINT_RULES;

describe('query_enhancements PPL lint rules uiSetting', () => {
  describe('registration', () => {
    it('registers a single JSON key for all rules', () => {
      const settings = getPplLintRuleSettings();
      expect(Object.keys(settings)).toEqual([KEY]);
      expect(settings[KEY].type).toBe('json');
    });

    it('defaults to a JSON blob mirroring the bundled catalog enabled/severity', () => {
      const settings = getPplLintRuleSettings();
      const value = JSON.parse(settings[KEY].value as string);

      expect(Object.keys(value)).toHaveLength(bundledCatalog.length);
      for (const rule of bundledCatalog) {
        expect(value[rule.id]).toEqual({ enabled: rule.enabled, severity: rule.severity });
      }
    });

    it('does not set requiresPageReload (the editor live-revalidates)', () => {
      const settings = getPplLintRuleSettings();
      expect(settings[KEY].requiresPageReload).toBeFalsy();
    });

    it('groups the key under the search category', () => {
      const settings = getPplLintRuleSettings();
      expect(settings[KEY].category).toEqual(['search']);
    });

    it('is explicitly global scoped', () => {
      const settings = getPplLintRuleSettings();
      expect(settings[KEY].scope).toBe(UiSettingScope.GLOBAL);
    });
  });

  describe('value schema', () => {
    const validate = () => (value: unknown) => getPplLintRuleSettings()[KEY].schema.validate(value);

    it('accepts a map of well-formed { enabled, severity } entries for every severity', () => {
      const v = validate();
      expect(() =>
        v({
          'division-by-zero': { enabled: true, severity: 'error' },
          'agg-on-text': { enabled: true, severity: 'warning' },
          'head-without-sort': { enabled: false, severity: 'info' },
        })
      ).not.toThrow();
    });

    it('accepts an empty object (all rules fall back to defaults)', () => {
      const v = validate();
      expect(() => v({})).not.toThrow();
    });

    it('rejects an unknown severity', () => {
      const v = validate();
      expect(() => v({ 'division-by-zero': { enabled: true, severity: 'critical' } })).toThrow();
    });

    it('rejects a non-boolean enabled', () => {
      const v = validate();
      expect(() => v({ 'division-by-zero': { enabled: 'yes', severity: 'warning' } })).toThrow();
    });

    it('rejects a missing field', () => {
      const v = validate();
      expect(() => v({ 'division-by-zero': { enabled: true } })).toThrow();
      expect(() => v({ 'division-by-zero': { severity: 'warning' } })).toThrow();
    });

    it('rejects an extra/unknown field within a rule entry', () => {
      const v = validate();
      expect(() =>
        v({ 'division-by-zero': { enabled: true, severity: 'warning', foo: 1 } })
      ).toThrow();
    });

    it('rejects a non-object rule entry', () => {
      const v = validate();
      expect(() => v({ 'division-by-zero': 'warning' })).toThrow();
      expect(() => v({ 'division-by-zero': true })).toThrow();
    });
  });
});
