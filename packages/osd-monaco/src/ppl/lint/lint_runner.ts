/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

import type { ParserRuleContext } from 'antlr4ng';
import type { Diagnostic } from './diagnostic';
import { RexNoUnderscoreVisitor, REX_NO_UNDERSCORE_METADATA } from './rules/rex_no_underscore';

/**
 * Walk a typed simplified-grammar parse tree with all registered rule visitors
 * and collect diagnostics. Pure function over the tree; no Monaco, no I/O.
 * Runs inside the worker.
 *
 * Each rule's walk is isolated in a try/catch so a throwing visitor is skipped
 * and other rules still contribute — lint must never break the editor.
 */
export function runLint(tree: ParserRuleContext | null): Diagnostic[] {
  if (!tree) return [];

  const diagnostics: Diagnostic[] = [];

  // P0: single rule. Visitor list grows here as rules are added.
  const rexVisitor = new RexNoUnderscoreVisitor(REX_NO_UNDERSCORE_METADATA);
  try {
    rexVisitor.visit(tree);
    diagnostics.push(...rexVisitor.diagnostics);
  } catch {
    // A rule throwing must never break the editor — skip its output.
  }

  return diagnostics;
}
