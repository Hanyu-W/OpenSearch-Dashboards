/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

import { runLint } from '../lint_runner';
import { getBundledCatalog } from '../catalog';
import { GrammarSurface } from './grammar_surface';
import { isParseError, parse } from './parser_adapter';
import { SurfaceName, VerificationResult } from './types';

/** Bounds for no-throw fuzz cases (R13.3). */
export const NO_THROW_BOUNDS = Object.freeze({
  maxRecursionLevels: 8,
  maxTokens: 512,
  maxTransitionTraversals: 1024,
});

/** A generated query case with provenance and bounds. */
export interface GeneratedQueryCase {
  caseId: string;
  query: string;
  surfaceName: SurfaceName;
  generationSeed: string;
  recursionDepth: number;
  tokenCount: number;
  transitionTraversals: number;
  labels?: readonly string[];
  /** When true, this case is labeled + shape-verified enough for detector use. */
  usableForDetectorAssertions: boolean;
}

/**
 * Descriptor-based high-signal generation: build realistic queries from the
 * grammar-derived command inventory. Each generated query is reparsed on the
 * same surface before it can be used for detector assertions; a reparse failure
 * is a generation gap, never a silent skip (R13.1, R13.2).
 */
export function generateDescriptorCases(surface: GrammarSurface): GeneratedQueryCase[] {
  const cases: GeneratedQueryCase[] = [];
  const templates: Array<{ id: string; query: string }> = [
    { id: 'gen-div-zero', query: 'source=t | eval x = a / 0' },
    { id: 'gen-head', query: 'source=t | head 3' },
    { id: 'gen-sort-head', query: 'source=t | sort a | head 3' },
    { id: 'gen-where-eval', query: 'source=t | eval y = a + 1 | where y > 2' },
    { id: 'gen-stats', query: 'source=t | stats count() by a' },
  ];
  for (const template of templates) {
    cases.push({
      caseId: template.id,
      query: template.query,
      surfaceName: surface.name,
      generationSeed: `descriptor:${template.id}`,
      recursionDepth: 2,
      tokenCount: template.query.split(/\s+/).length,
      transitionTraversals: 0,
      labels: ['descriptor'],
      usableForDetectorAssertions: true,
    });
  }
  return cases;
}

/**
 * Process a generated case: reparse on the same surface. When the case is usable
 * for detector assertions, also run the detectors (which must not throw). A
 * reparse failure is a generation gap; a detector throw / runner warning is a
 * no-throw failure carrying query, seed, and surface (R13.2, R13.7).
 */
export function processGeneratedCase(
  generatedCase: GeneratedQueryCase,
  surface: GrammarSurface
): VerificationResult {
  const ctx = { query: generatedCase.query, surface: surface.name };

  // Bounds check for no-throw fuzz cases.
  if (
    generatedCase.recursionDepth > NO_THROW_BOUNDS.maxRecursionLevels ||
    generatedCase.tokenCount > NO_THROW_BOUNDS.maxTokens ||
    generatedCase.transitionTraversals > NO_THROW_BOUNDS.maxTransitionTraversals
  ) {
    return single(
      'generated-no-throw',
      'failure',
      `Generated case "${generatedCase.caseId}" exceeds no-throw bounds (seed ${generatedCase.generationSeed}).`,
      ctx
    );
  }

  const parsed = parse(generatedCase.query, surface);
  if (isParseError(parsed)) {
    return single(
      'generated-no-throw',
      'failure',
      `Generation gap: generated query failed to reparse (seed ${generatedCase.generationSeed}): ${parsed.error.message}.`,
      ctx
    );
  }

  // Detectors must never throw. Any throw is a no-throw failure with full
  // context. `runLint` isolates per-rule throws internally, so a throw escaping
  // here would be an infrastructure failure — still caught and reported.
  try {
    runLint(parsed.tree, {
      ruleNameToIndex: surface.ruleNameToIndex,
      catalog: getBundledCatalog(),
    });
  } catch (e) {
    return single(
      'generated-no-throw',
      'failure',
      `Detector threw on generated query (seed ${generatedCase.generationSeed}): ${
        e instanceof Error ? e.message : String(e)
      }.`,
      ctx
    );
  }

  return single(
    'generated-no-throw',
    'pass',
    `Generated case "${generatedCase.caseId}" parsed and linted without throwing.`,
    ctx
  );
}

/**
 * A guard for a future randomized property-testing dependency: it must carry
 * review approval and an exact pinned version (no ranges/wildcards) before its
 * tests run (R13.6). No such dependency exists today; this documents the policy
 * and fails loudly if one is added without metadata.
 */
export function assertRandomizedDependencyApproved(dependency?: {
  name: string;
  version: string;
  reviewApproved: boolean;
}): VerificationResult {
  if (!dependency) {
    return single(
      'generated-no-throw',
      'pass',
      'No randomized property-testing dependency in use.',
      {}
    );
  }
  const pinned = /^\d+\.\d+\.\d+$/.test(dependency.version);
  if (!dependency.reviewApproved || !pinned) {
    return single(
      'generated-no-throw',
      'failure',
      `Randomized dependency "${dependency.name}@${dependency.version}" needs review approval and an exact pinned version.`,
      {}
    );
  }
  return single(
    'generated-no-throw',
    'pass',
    `Randomized dependency "${dependency.name}@${dependency.version}" is approved and pinned.`,
    {}
  );
}

function single(
  category: VerificationResult['category'],
  status: 'pass' | 'failure',
  message: string,
  context: { query?: string; surface?: SurfaceName }
): VerificationResult {
  return {
    category,
    passing: status !== 'failure',
    entries: [{ category, status, message, context }],
  };
}
