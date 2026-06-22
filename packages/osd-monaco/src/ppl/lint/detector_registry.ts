/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

import { Detector } from './types';
import { headWithoutSortDetector } from './rules/head_without_sort';
import { divisionByZeroDetector } from './rules/division_by_zero';

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
  registerDetector('head-without-sort', headWithoutSortDetector);
  registerDetector('division-by-zero', divisionByZeroDetector);
}

// Register built-ins at module load.
registerBuiltInDetectors();
