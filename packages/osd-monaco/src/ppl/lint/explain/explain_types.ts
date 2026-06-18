/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

import { Diagnostic } from '../diagnostic';
import { CatalogEntry } from '../types';

/**
 * The physical/logical plan returned by `POST /_plugins/_ppl/_explain`, narrowed
 * to what the explain detectors read.
 *
 * On a Calcite-enabled cluster (3.3+) the engine returns
 * `{ calcite: { logical, physical } }`; the host maps that into this shape with
 * `isCalcite: true`. On a non-Calcite cluster the response is `{ root: {...} }`
 * and the host produces `isCalcite: false`, which makes every detector no-op.
 */
export interface ExplainPlan {
  /** True only when the response carried a Calcite plan. */
  isCalcite: boolean;
  /** The physical plan text (with `PushDownContext=[[...]]` blocks). */
  physical: string;
  /** The logical plan text. */
  logical: string;
}

/**
 * Per-run inputs an explain detector consumes alongside the plan. Kept separate
 * from `LintRunContext` (the tree-pass context) because explain rules carry the
 * raw query text — used to range the whole-query diagnostic — rather than a
 * parse tree.
 */
export interface ExplainLintContext {
  /** The user's query text, used to size the whole-query diagnostic range. */
  query: string;
}

/**
 * An explain-backed detector. Mirrors the tree-based {@link Detector} contract
 * but reads the {@link ExplainPlan} instead of a parse tree. Returns zero or
 * more diagnostics. Must no-op when `plan.isCalcite` is false.
 */
export type ExplainDetector = (
  plan: ExplainPlan,
  config: CatalogEntry,
  context: ExplainLintContext
) => Diagnostic[];
