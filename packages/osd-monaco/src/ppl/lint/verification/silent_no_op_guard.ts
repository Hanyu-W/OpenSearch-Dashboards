/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

import { GrammarSurface } from './grammar_surface';
import { ClassificationManifest, RuleReference, SurfaceName, VerificationResult } from './types';

/**
 * Policy for a navigated rule reference that is neither declared applicable nor
 * declared excluded for the active surface. `evaluate` verifies it anyway;
 * `skip` leaves it alone. Default is `skip` so out-of-scope references do not
 * produce noise.
 */
export type GuardApplicabilityPolicy = 'evaluate' | 'skip';

type Applicability = 'evaluate' | 'skip' | 'pending-runtime-fixture';

/**
 * Verify that every applicable navigated rule reference resolves to a
 * non-negative rule index on the surface, before any detector runs (R5.1-R5.7).
 * A reference that resolves to -1 on a surface it applies to is a silent no-op
 * and fails verification with detector id, rule name, and surface.
 */
export function assertAllNavigatedRulesResolve(
  surface: GrammarSurface,
  manifest: ClassificationManifest,
  options: { runtimeFixtureAvailable?: boolean; policy?: GuardApplicabilityPolicy } = {}
): VerificationResult {
  const policy: GuardApplicabilityPolicy = options.policy ?? 'skip';
  const runtimeFixtureAvailable = options.runtimeFixtureAvailable ?? false;
  const entries: VerificationResult['entries'] = [];
  let passing = true;

  for (const reference of manifest.navigatedRuleReferences) {
    const applicability = classifyApplicability(
      reference,
      surface.name,
      policy,
      runtimeFixtureAvailable
    );

    if (applicability === 'pending-runtime-fixture') {
      entries.push({
        category: 'no-op',
        status: 'pending',
        message: `Runtime-only reference "${reference.ruleName}" pending until a runtime fixture exists.`,
        context: {
          detector: reference.detectorId,
          rule: reference.ruleName,
          surface: surface.name,
        },
      });
      continue;
    }

    if (applicability === 'skip') {
      continue;
    }

    const ruleIndex = surface.ruleNameToIndex(reference.ruleName);
    if (ruleIndex < 0) {
      passing = false;
      entries.push({
        category: 'no-op',
        status: 'failure',
        message: `Navigated rule name "${reference.ruleName}" does not resolve on ${surface.name} (detector "${reference.detectorId}" would silently no-op).`,
        context: {
          detector: reference.detectorId,
          rule: reference.ruleName,
          surface: surface.name,
        },
      });
    }
  }

  if (passing && entries.every((e) => e.status !== 'failure')) {
    entries.push({
      category: 'no-op',
      status: 'pass',
      message: `All applicable navigated rule references resolve on ${surface.name}.`,
      context: { surface: surface.name },
    });
  }

  return { category: 'no-op', passing, entries: [...entries] };
}

/** Classify a reference for a surface: evaluate, skip, or pending. */
export function classifyApplicability(
  reference: RuleReference,
  surfaceName: SurfaceName,
  policy: GuardApplicabilityPolicy,
  runtimeFixtureAvailable: boolean
): Applicability {
  // Explicit exclusion always wins.
  if (reference.excludedSurfaces?.includes(surfaceName)) {
    return 'skip';
  }

  // Runtime-only references are pending until a runtime fixture exists, and are
  // only ever evaluated on the runtime fixture surface.
  if (reference.runtimeOnly) {
    if (surfaceName !== 'runtime_fixture') {
      return 'skip';
    }
    return runtimeFixtureAvailable ? 'evaluate' : 'pending-runtime-fixture';
  }

  // In scope for this surface.
  if (reference.appliesTo.includes(surfaceName)) {
    return 'evaluate';
  }

  // Out of scope and no explicit exclusion → follow policy.
  return policy;
}
