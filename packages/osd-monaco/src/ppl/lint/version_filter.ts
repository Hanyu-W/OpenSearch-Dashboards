/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

import semver from 'semver';
import { CatalogEntry } from './types';

/**
 * The latest engine version the catalog was verified against. Manually
 * maintained — NOT derived from package.json (which is the OSD version, not the
 * engine version). Updated when the catalog is re-verified.
 */
export const OSD_KNOWN_VERSION = '3.7.0';

function coerce(version: string): string | null {
  const coerced = semver.coerce(version);
  return coerced ? coerced.version : null;
}

/**
 * Decide whether a rule applies to a given data-source version and engine.
 *
 * Implements the version-filtering policy (R7):
 *  - below minVersion → skip
 *  - above an *explicitly declared* maxVersion → skip (no phantom ceiling: a
 *    rule with no maxVersion is open-ended and runs on any newer cluster)
 *  - engine:'calcite' → applies only when the source runs Calcite
 *  - undefined version policy:
 *      minVersion-only, no engine        → runs
 *      open-ended maxVersion past horizon → self-suppress
 *      Calcite-gated error severity       → self-suppress
 *      Calcite-gated warning severity     → runs
 */
export function appliesTo(
  rule: CatalogEntry,
  dataSourceVersion: string | undefined,
  isCalcite: boolean | undefined,
  knownVersion: string = OSD_KNOWN_VERSION
): boolean {
  const { appliesTo: predicate, severity } = rule;
  const isCalciteGated = predicate.engine === 'calcite';

  if (dataSourceVersion === undefined) {
    // Engine gating first (R7.9, R7.10).
    if (isCalciteGated) {
      // Cannot confirm Calcite is active. Error-severity self-suppresses to
      // preserve the zero-false-positive bar; warning-severity runs.
      return severity !== 'error';
    }
    // No engine predicate.
    if (predicate.maxVersion !== undefined) {
      // Open-ended (declared) max past the horizon → self-suppress (R7.8).
      const effectiveMax = predicate.maxVersion;
      const coercedMax = coerce(effectiveMax);
      const coercedKnown = coerce(knownVersion);
      if (coercedMax && coercedKnown && semver.gt(coercedKnown, coercedMax)) {
        return false;
      }
    }
    // minVersion-only (or version-agnostic), no engine → runs (R7.7).
    return true;
  }

  // Defined version path.
  const coercedVersion = coerce(dataSourceVersion);
  if (!coercedVersion) {
    // Unparseable version — be conservative and run only non-Calcite rules.
    return !isCalciteGated;
  }

  // Engine gating (R7.5, R7.6).
  if (isCalciteGated && isCalcite !== true) {
    return false;
  }

  if (predicate.minVersion) {
    const coercedMin = coerce(predicate.minVersion);
    if (coercedMin && semver.lt(coercedVersion, coercedMin)) {
      return false; // R7.3
    }
  }

  if (predicate.maxVersion !== undefined) {
    const coercedMax = coerce(predicate.maxVersion);
    if (coercedMax && semver.gt(coercedVersion, coercedMax)) {
      return false; // R7.4 — explicit hard ceiling exceeded
    }
  }

  return true;
}
