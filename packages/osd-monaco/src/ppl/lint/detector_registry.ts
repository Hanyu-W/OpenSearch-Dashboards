/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

import { Detector } from './types';

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
 *
 * No detectors ship in this slice — the framework lands first and rule
 * detectors are registered here as they arrive in follow-up changes. Until
 * then every catalog entry resolves to no detector and is skipped as inert by
 * `runLint` (R6.4), so the framework is a safe no-op end to end.
 */
export function registerBuiltInDetectors(): void {
  // Intentionally empty; rule detectors are registered in follow-up changes.
}

// Register built-ins at module load.
registerBuiltInDetectors();
