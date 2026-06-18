/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

import semver from 'semver';
import { getBundledCatalog, loadCatalog, validateCatalogEntry } from '../catalog';
import { OSD_KNOWN_VERSION } from '../version_filter';

describe('catalog loading', () => {
  it('loads the bundled catalog with the expected rule ids', () => {
    const ids = getBundledCatalog().map((c) => c.id);
    expect(ids).toEqual(
      expect.arrayContaining([
        'invalid-capture-group-name',
        'unsupported-window-function-in-eventstats',
        'dedup-consecutive-unsupported',
        'replace-wildcard-asymmetry',
        'union-min-datasets',
        'multisearch-min-subsearch',
        'disabled-join-type',
        'head-without-sort',
        'field-validation',
        'expand-on-non-array',
        'wildcard-source-zero-match',
        'division-by-zero',
        'agg-on-text',
        'flat-object-subfield',
        'type-mismatch-numeric',
        'enabled-false-object',
      ])
    );
  });

  it('keeps exactly the valid entries and drops malformed ones', () => {
    const entries = [
      {
        id: 'a',
        detector: 'a',
        enabled: true,
        severity: 'error',
        message: 'm',
        docUrl: 'd',
        appliesTo: {},
      },
      { id: 'b' }, // malformed
      {
        id: 'c',
        detector: 'c',
        enabled: true,
        severity: 'bogus',
        message: 'm',
        docUrl: 'd',
        appliesTo: {},
      },
      null,
      'not an object',
    ];
    const result = loadCatalog(entries);
    expect(result.map((e) => e.id)).toEqual(['a']);
  });

  it('returns an empty catalog for a non-array', () => {
    expect(loadCatalog({} as unknown)).toEqual([]);
  });

  it('validates a single entry', () => {
    expect(validateCatalogEntry({ id: 'x' })).toBeNull();
    expect(
      validateCatalogEntry({
        id: 'x',
        detector: 'x',
        enabled: true,
        severity: 'warning',
        message: 'm',
        docUrl: 'd',
        appliesTo: { minVersion: '3.4.0', engine: 'calcite' },
      })
    ).not.toBeNull();
  });

  it('preserves the needsExplain flag through validation', () => {
    const entry = validateCatalogEntry({
      id: 'operation-not-pushed',
      detector: 'operation-not-pushed',
      enabled: false,
      severity: 'warning',
      message: 'm',
      docUrl: 'd',
      appliesTo: { minVersion: '3.3.0', engine: 'calcite' },
      runtimeOnly: true,
      needsExplain: true,
    });
    expect(entry).not.toBeNull();
    expect(entry!.needsExplain).toBe(true);
  });

  it('rejects a non-boolean needsExplain', () => {
    expect(
      validateCatalogEntry({
        id: 'x',
        detector: 'x',
        enabled: true,
        severity: 'warning',
        message: 'm',
        docUrl: 'd',
        appliesTo: {},
        needsExplain: 'yes',
      })
    ).toBeNull();
  });

  it('loads the two explain rules with needsExplain set, disabled by default', () => {
    const byId = new Map(getBundledCatalog().map((c) => [c.id, c]));
    for (const id of ['operation-not-pushed', 'operation-pushed-as-script']) {
      const entry = byId.get(id);
      expect(entry).toBeDefined();
      expect(entry!.needsExplain).toBe(true);
      expect(entry!.enabled).toBe(false);
    }
  });

  it('rejects an invalid engine predicate', () => {
    expect(
      validateCatalogEntry({
        id: 'x',
        detector: 'x',
        enabled: true,
        severity: 'warning',
        message: 'm',
        docUrl: 'd',
        appliesTo: { engine: 'spark' },
      })
    ).toBeNull();
  });

  // OSD_KNOWN_VERSION is the *undefined-version* self-suppress horizon: when a
  // cluster's version is unknown, rules with minVersion above this threshold are
  // suppressed (conservative). It is NOT a ceiling for known-version clusters.
  // This test guards against forgetting to bump OSD_KNOWN_VERSION when adding a
  // new rule — without a bump, the rule would be suppressed on unknown-version
  // clusters even if the rule's minVersion is reachable.
  it('keeps OSD_KNOWN_VERSION at or above every rule minVersion', () => {
    const knownVersion = semver.coerce(OSD_KNOWN_VERSION)?.version;
    expect(knownVersion).toBeTruthy();

    for (const entry of getBundledCatalog()) {
      const minVersion = entry.appliesTo.minVersion;
      if (!minVersion) {
        continue;
      }
      const coercedMin = semver.coerce(minVersion)?.version;
      expect(coercedMin).toBeTruthy();
      expect(semver.gte(knownVersion!, coercedMin!)).toBe(true);
    }
  });
});
