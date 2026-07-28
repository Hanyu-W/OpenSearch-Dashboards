/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

import { appliesTo, OSD_KNOWN_VERSION } from '../version_filter';
import { CatalogEntry } from '../types';

function makeRule(overrides: Partial<CatalogEntry>): CatalogEntry {
  return {
    id: 'r',
    detector: 'r',
    enabled: true,
    severity: 'error',
    message: 'm',
    howToFix: 'fix',
    docUrl: 'd',
    appliesTo: {},
    ...overrides,
  };
}

describe('version_filter appliesTo', () => {
  describe('defined version window', () => {
    it('skips below minVersion', () => {
      const rule = makeRule({ appliesTo: { minVersion: '3.4.0' } });
      expect(appliesTo(rule, '3.3.0', undefined)).toBe(false);
    });

    it('applies at and above minVersion', () => {
      const rule = makeRule({ appliesTo: { minVersion: '3.4.0' } });
      expect(appliesTo(rule, '3.4.0', undefined)).toBe(true);
      expect(appliesTo(rule, OSD_KNOWN_VERSION, undefined)).toBe(true);
    });

    it('minVersion-only rule fires on a cluster newer than OSD_KNOWN_VERSION', () => {
      const rule = makeRule({ appliesTo: { minVersion: '3.4.0' } });
      expect(appliesTo(rule, '99.0.0', undefined)).toBe(true);
    });

    it('version-agnostic rule fires on a cluster newer than OSD_KNOWN_VERSION', () => {
      const rule = makeRule({ appliesTo: {} });
      expect(appliesTo(rule, '3.8.0', undefined)).toBe(true);
    });

    it('respects an explicit maxVersion', () => {
      const rule = makeRule({ appliesTo: { maxVersion: '3.5.0' } });
      expect(appliesTo(rule, '3.5.0', undefined)).toBe(true);
      expect(appliesTo(rule, '3.6.0', undefined)).toBe(false);
    });
  });

  describe('engine predicate', () => {
    it('applies a calcite rule only when source is calcite', () => {
      const rule = makeRule({ severity: 'warning', appliesTo: { engine: 'calcite' } });
      expect(appliesTo(rule, '3.7.0', true)).toBe(true);
      expect(appliesTo(rule, '3.7.0', false)).toBe(false);
    });

    it('ignores engine for rules with no predicate', () => {
      const rule = makeRule({ appliesTo: {} });
      expect(appliesTo(rule, '3.7.0', false)).toBe(true);
    });
  });

  describe('engine-type predicate', () => {
    const KNOWN = OSD_KNOWN_VERSION;

    it('applies a requiresEngineType rule only on that engine type', () => {
      const rule = makeRule({ appliesTo: { requiresEngineType: 'AnalyticEngine' } });
      expect(appliesTo(rule, '3.5.0', true, KNOWN, 'AnalyticEngine')).toBe(true);
      expect(appliesTo(rule, '3.5.0', true, KNOWN, 'OpenSearch')).toBe(false);
    });

    it('self-suppresses a requiresEngineType rule when the engine type is unknown', () => {
      // The engine type is resolved once at data-source registration and fails
      // open, so an unconfirmed value must not satisfy the predicate.
      const rule = makeRule({ appliesTo: { requiresEngineType: 'AnalyticEngine' } });
      expect(appliesTo(rule, '3.5.0', true, KNOWN, undefined)).toBe(false);
    });

    it('suppresses an excludesEngineType rule on that engine type', () => {
      const rule = makeRule({ appliesTo: { excludesEngineType: 'AnalyticEngine' } });
      expect(appliesTo(rule, '3.5.0', true, KNOWN, 'AnalyticEngine')).toBe(false);
      expect(appliesTo(rule, '3.5.0', true, KNOWN, 'OpenSearch')).toBe(true);
    });

    it('runs an excludesEngineType rule when the engine type is unknown', () => {
      // Fail-open: an unknown engine type keeps the rule's prior behaviour.
      const rule = makeRule({ appliesTo: { excludesEngineType: 'AnalyticEngine' } });
      expect(appliesTo(rule, '3.5.0', true, KNOWN, undefined)).toBe(true);
    });

    it('gates on engine type even when the version is undefined', () => {
      const requires = makeRule({ appliesTo: { requiresEngineType: 'AnalyticEngine' } });
      expect(appliesTo(requires, undefined, undefined, KNOWN, 'AnalyticEngine')).toBe(true);
      expect(appliesTo(requires, undefined, undefined, KNOWN, 'OpenSearch')).toBe(false);

      const excludes = makeRule({ appliesTo: { excludesEngineType: 'AnalyticEngine' } });
      expect(appliesTo(excludes, undefined, undefined, KNOWN, 'AnalyticEngine')).toBe(false);
    });

    it('combines an engine-type predicate with version and calcite gates', () => {
      // Mirrors dedup-consecutive-unsupported: calcite AND AnalyticEngine AND >= 3.3.
      const rule = makeRule({
        appliesTo: {
          minVersion: '3.3.0',
          engine: 'calcite',
          requiresEngineType: 'AnalyticEngine',
        },
      });
      expect(appliesTo(rule, '3.5.0', true, KNOWN, 'AnalyticEngine')).toBe(true);
      expect(appliesTo(rule, '3.5.0', false, KNOWN, 'AnalyticEngine')).toBe(false);
      expect(appliesTo(rule, '3.2.0', true, KNOWN, 'AnalyticEngine')).toBe(false);
      expect(appliesTo(rule, '3.5.0', true, KNOWN, 'OpenSearch')).toBe(false);
    });
  });

  describe('undefined version policy', () => {
    it('runs a minVersion-only no-engine rule', () => {
      const rule = makeRule({ appliesTo: { minVersion: '3.4.0' } });
      expect(appliesTo(rule, undefined, undefined)).toBe(true);
    });

    it('self-suppresses an open-ended maxVersion rule past the horizon', () => {
      const rule = makeRule({ appliesTo: { maxVersion: '3.0.0' } });
      expect(appliesTo(rule, undefined, undefined)).toBe(false);
    });

    it('self-suppresses a calcite error rule', () => {
      const rule = makeRule({ severity: 'error', appliesTo: { engine: 'calcite' } });
      expect(appliesTo(rule, undefined, undefined)).toBe(false);
    });

    it('runs a calcite warning rule', () => {
      const rule = makeRule({ severity: 'warning', appliesTo: { engine: 'calcite' } });
      expect(appliesTo(rule, undefined, undefined)).toBe(true);
    });

    it('treats a blank version string like an undefined version', () => {
      const rule = makeRule({
        severity: 'info',
        appliesTo: { minVersion: '3.3.0', engine: 'calcite' },
      });
      expect(appliesTo(rule, '', true)).toBe(true);
      expect(appliesTo(rule, '   ', true)).toBe(true);
    });
  });
});
