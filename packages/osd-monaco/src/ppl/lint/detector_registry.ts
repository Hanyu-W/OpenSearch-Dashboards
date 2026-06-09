/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

import { Detector } from './types';
import { invalidCaptureGroupNameDetector } from './rules/invalid_capture_group_name';
import { unsupportedWindowFunctionDetector } from './rules/unsupported_window_function';
import { dedupConsecutiveUnsupportedDetector } from './rules/dedup_consecutive_unsupported';
import { replaceWildcardAsymmetryDetector } from './rules/replace_wildcard_asymmetry';
import { unionMinDatasetsDetector } from './rules/union_min_datasets';
import { multisearchMinSubsearchDetector } from './rules/multisearch_min_subsearch';
import { disabledJoinTypeDetector } from './rules/disabled_join_type';
import { headWithoutSortDetector } from './rules/head_without_sort';
import { fieldValidationDetector } from './rules/field_validation';
import { expandOnNonArrayDetector } from './rules/expand_on_non_array';
import { wildcardSourceZeroMatchDetector } from './rules/wildcard_source_zero_match';

const registry = new Map<string, Detector>();

/**
 * Register a detector under a key. Re-registering a key overwrites the prior
 * factory (last write wins).
 */
export function registerDetector(key: string, detector: Detector): void {
  registry.set(key, detector);
}

/**
 * Return the detector registered for a key, or undefined when none is
 * registered (R5.3).
 */
export function getDetector(key: string): Detector | undefined {
  return registry.get(key);
}

/**
 * Reset the registry. Test-only helper.
 */
export function resetDetectorRegistry(): void {
  registry.clear();
  registerBuiltInDetectors();
}

/**
 * Register every shipping detector, keyed by its catalog `detector` key.
 */
export function registerBuiltInDetectors(): void {
  registerDetector('invalid-capture-group-name', invalidCaptureGroupNameDetector);
  registerDetector('unsupported-window-function-in-eventstats', unsupportedWindowFunctionDetector);
  registerDetector('dedup-consecutive-unsupported', dedupConsecutiveUnsupportedDetector);
  registerDetector('replace-wildcard-asymmetry', replaceWildcardAsymmetryDetector);
  registerDetector('union-min-datasets', unionMinDatasetsDetector);
  registerDetector('multisearch-min-subsearch', multisearchMinSubsearchDetector);
  registerDetector('disabled-join-type', disabledJoinTypeDetector);
  registerDetector('head-without-sort', headWithoutSortDetector);
  registerDetector('field-validation', fieldValidationDetector);
  registerDetector('expand-on-non-array', expandOnNonArrayDetector);
  registerDetector('wildcard-source-zero-match', wildcardSourceZeroMatchDetector);
}

// Register built-ins at module load.
registerBuiltInDetectors();
