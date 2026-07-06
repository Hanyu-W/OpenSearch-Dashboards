/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

import { appliesTo, OSD_KNOWN_VERSION } from '../version_filter';
import { CatalogEntry } from '../types';
import { VerificationResult } from './types';

/**
 * A single version/context applicability case: a synthetic catalog entry plus
 * the evaluation inputs and the exactly-one expected outcome (R9.3).
 */
export interface VersionContextCase {
  caseId: string;
  entry: CatalogEntry;
  dataSourceVersion: string | undefined;
  isCalcite: boolean | undefined;
  knownVersion?: string;
  expectApplicable: boolean;
}

/** A synthetic catalog entry factory for exercising `appliesTo` branches. */
function syntheticEntry(overrides: Partial<CatalogEntry>): CatalogEntry {
  return {
    id: overrides.id ?? 'synthetic-rule',
    detector: overrides.detector ?? 'synthetic-rule',
    enabled: true,
    severity: overrides.severity ?? 'warning',
    message: 'synthetic',
    docUrl: 'https://example.invalid',
    appliesTo: overrides.appliesTo ?? {},
    runtimeOnly: overrides.runtimeOnly,
    needsContext: overrides.needsContext,
    needsExplain: overrides.needsExplain,
  };
}

/**
 * The version/context matrix. Because NO shipping catalog entry declares a
 * `maxVersion`, synthetic entries are the only way to exercise both sides of the
 * maxVersion filter — included here to cover R9.4.
 */
export const VERSION_CONTEXT_CASES: readonly VersionContextCase[] = [
  // minVersion below/at/above.
  {
    caseId: 'minVersion-below-skips',
    entry: syntheticEntry({ appliesTo: { minVersion: '3.5.0' } }),
    dataSourceVersion: '3.4.0',
    isCalcite: undefined,
    expectApplicable: false,
  },
  {
    caseId: 'minVersion-at-applies',
    entry: syntheticEntry({ appliesTo: { minVersion: '3.5.0' } }),
    dataSourceVersion: '3.5.0',
    isCalcite: undefined,
    expectApplicable: true,
  },
  // maxVersion both sides (defined version path) — synthetic, R9.4.
  {
    caseId: 'maxVersion-at-or-below-applies',
    entry: syntheticEntry({ appliesTo: { maxVersion: '3.6.0' } }),
    dataSourceVersion: '3.6.0',
    isCalcite: undefined,
    expectApplicable: true,
  },
  {
    caseId: 'maxVersion-above-skips',
    entry: syntheticEntry({ appliesTo: { maxVersion: '3.6.0' } }),
    dataSourceVersion: '3.7.0',
    isCalcite: undefined,
    expectApplicable: false,
  },
  // maxVersion undefined-version self-suppression past horizon (R7.8).
  {
    caseId: 'maxVersion-undefined-version-past-horizon-self-suppress',
    entry: syntheticEntry({ appliesTo: { maxVersion: '3.6.0' } }),
    dataSourceVersion: undefined,
    isCalcite: undefined,
    knownVersion: '3.7.0',
    expectApplicable: false,
  },
  // engine:'calcite' gating.
  {
    caseId: 'calcite-gated-non-calcite-defined-version-skips',
    entry: syntheticEntry({ appliesTo: { engine: 'calcite' } }),
    dataSourceVersion: '3.7.0',
    isCalcite: false,
    expectApplicable: false,
  },
  {
    caseId: 'calcite-gated-calcite-defined-version-applies',
    entry: syntheticEntry({ appliesTo: { engine: 'calcite' } }),
    dataSourceVersion: '3.7.0',
    isCalcite: true,
    expectApplicable: true,
  },
  {
    caseId: 'calcite-gated-undefined-version-warning-runs',
    entry: syntheticEntry({ appliesTo: { engine: 'calcite' }, severity: 'warning' }),
    dataSourceVersion: undefined,
    isCalcite: undefined,
    expectApplicable: true,
  },
  {
    caseId: 'calcite-gated-undefined-version-error-self-suppress',
    entry: syntheticEntry({ appliesTo: { engine: 'calcite' }, severity: 'error' }),
    dataSourceVersion: undefined,
    isCalcite: undefined,
    expectApplicable: false,
  },
];

/**
 * Evaluate every version/context case and verify the actual applicability
 * outcome matches the declared expectation exactly (R9.3, R9.4).
 */
export function runVersionContextMatrix(
  cases: readonly VersionContextCase[] = VERSION_CONTEXT_CASES
): VerificationResult {
  const entries: VerificationResult['entries'] = [];
  let passing = true;

  for (const testCase of cases) {
    const actual = appliesTo(
      testCase.entry,
      testCase.dataSourceVersion,
      testCase.isCalcite,
      testCase.knownVersion ?? OSD_KNOWN_VERSION
    );
    if (actual !== testCase.expectApplicable) {
      passing = false;
      entries.push({
        category: 'version-context',
        status: 'failure',
        message: `Version/context case "${testCase.caseId}" expected applicable=${testCase.expectApplicable}, got ${actual}.`,
        context: { rule: testCase.entry.id },
      });
    }
  }

  if (passing) {
    entries.push({
      category: 'version-context',
      status: 'pass',
      message: `All ${cases.length} version/context cases matched expectation.`,
      context: {},
    });
  }
  return { category: 'version-context', passing, entries: [...entries] };
}
