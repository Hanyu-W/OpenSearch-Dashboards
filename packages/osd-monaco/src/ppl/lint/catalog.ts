/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

import { AppliesTo, CatalogEntry } from './types';
import { LintSeverity } from './diagnostic';
import rawCatalog from './rules_catalog.json';

// TRACKING: OSD#<number> — set `invalid-capture-group-name` maxVersion when
// opensearch-project/sql#4549 ships (engine accepts underscore/hyphen group
// names). Until then maxVersion is left open. See requirements R7.11/R14.

const VALID_SEVERITIES: ReadonlySet<string> = new Set<LintSeverity>(['error', 'warning', 'info']);

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

function isValidAppliesTo(value: unknown): value is AppliesTo {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const candidate = value as Record<string, unknown>;
  if (candidate.minVersion !== undefined && typeof candidate.minVersion !== 'string') {
    return false;
  }
  if (candidate.maxVersion !== undefined && typeof candidate.maxVersion !== 'string') {
    return false;
  }
  if (candidate.engine !== undefined && candidate.engine !== 'calcite') {
    return false;
  }
  return true;
}

/**
 * Validate a single catalog entry against the schema. Returns the typed entry
 * when valid, or null when malformed.
 */
export function validateCatalogEntry(value: unknown): CatalogEntry | null {
  if (typeof value !== 'object' || value === null) {
    return null;
  }
  const candidate = value as Record<string, unknown>;

  if (
    !isNonEmptyString(candidate.id) ||
    !isNonEmptyString(candidate.detector) ||
    typeof candidate.enabled !== 'boolean' ||
    typeof candidate.severity !== 'string' ||
    !VALID_SEVERITIES.has(candidate.severity) ||
    typeof candidate.message !== 'string' ||
    typeof candidate.docUrl !== 'string' ||
    !isValidAppliesTo(candidate.appliesTo)
  ) {
    return null;
  }

  if (candidate.runtimeOnly !== undefined && typeof candidate.runtimeOnly !== 'boolean') {
    return null;
  }
  if (candidate.needsContext !== undefined && typeof candidate.needsContext !== 'boolean') {
    return null;
  }
  if (candidate.needsExplain !== undefined && typeof candidate.needsExplain !== 'boolean') {
    return null;
  }

  return {
    id: candidate.id,
    detector: candidate.detector,
    enabled: candidate.enabled,
    severity: candidate.severity as LintSeverity,
    message: candidate.message,
    docUrl: candidate.docUrl,
    appliesTo: candidate.appliesTo as AppliesTo,
    runtimeOnly: candidate.runtimeOnly as boolean | undefined,
    needsContext: candidate.needsContext as boolean | undefined,
    needsExplain: candidate.needsExplain as boolean | undefined,
  };
}

/**
 * Load and validate a catalog. Malformed entries are dropped and logged; the
 * remaining valid entries are returned. Never throws to the editor (R4.3-R4.5).
 */
export function loadCatalog(entries: unknown): CatalogEntry[] {
  if (!Array.isArray(entries)) {
    // eslint-disable-next-line no-console
    console.warn('[ppl-lint] catalog is not an array; loading empty catalog');
    return [];
  }

  const valid: CatalogEntry[] = [];
  for (const entry of entries) {
    const parsed = validateCatalogEntry(entry);
    if (parsed) {
      valid.push(parsed);
    } else {
      // eslint-disable-next-line no-console
      console.warn('[ppl-lint] dropped malformed catalog entry', entry);
    }
  }
  return valid;
}

let bundledCatalog: CatalogEntry[] | undefined;

/**
 * Get the bundled rule catalog, loaded synchronously from the bundle with no
 * network request (R4.2). Computed once and reused.
 */
export function getBundledCatalog(): CatalogEntry[] {
  if (!bundledCatalog) {
    // Under some module interop settings a JSON array import is wrapped in a
    // `default` property; normalize both shapes.
    const source = Array.isArray(rawCatalog)
      ? rawCatalog
      : (rawCatalog as { default?: unknown }).default;
    bundledCatalog = loadCatalog(source);
  }
  return bundledCatalog;
}
