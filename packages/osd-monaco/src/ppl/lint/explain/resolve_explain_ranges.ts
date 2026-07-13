/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

import { ParserRuleContext } from 'antlr4ng';
import { Diagnostic } from '../diagnostic';
import {
  buildPipelineShape,
  collectAlternateSourceSubtrees,
  PipelineStage,
} from '../pipeline_shape';
import { findAllDescendantsByRule, findChildByRule, RuleNameToIndex } from '../rule_index';
import { rangeFromContext } from '../range_utils';
import { buildFilterInversionFix } from './explain_quick_fix';

/**
 * Narrow the whole-query range on explain-backed diagnostics down to the command
 * that actually caused the pushdown problem.
 *
 * The explain detectors read a plan, not a parse tree (design §6, SoT discovery
 * #18), so they can only emit a whole-query range plus a structured
 * `explainTarget` (which operation, and — when the plan carried them — the fields
 * involved). This resolver runs where the parse tree lives (the runtime lint
 * layer) and, for each such diagnostic, finds the offending command node and
 * replaces the range with a precise one.
 *
 * Honest degradation is the rule: when the offending command cannot be located
 * unambiguously (zero candidates, or several and no field to disambiguate on),
 * the diagnostic is left with its whole-query range — we never point at the
 * *wrong* command. A diagnostic without an `explainTarget` (e.g. any non-explain
 * finding) is returned untouched.
 */

/** Command rule names that can carry each pushdown operation. */
const OPERATION_COMMANDS: Record<'filter' | 'aggregation' | 'sort', string[]> = {
  filter: ['whereCommand'],
  aggregation: ['statsCommand', 'eventstatsCommand', 'streamstatsCommand', 'timechartCommand'],
  sort: ['sortCommand'],
};

/**
 * Sub-rules to narrow to inside a matched command, in priority order. The first
 * one present becomes the range so the squiggle lands on the expression, not the
 * command keyword. Falls back to the whole command node when none is present.
 */
const OPERATION_NARROW_RULES: Record<'filter' | 'aggregation' | 'sort', string[]> = {
  filter: ['logicalExpression', 'expression'],
  aggregation: ['statsAggTerm', 'statsFunction'],
  sort: ['sortbyClause', 'sortField'],
};

/** Collect the field-name texts referenced inside a command node. */
function fieldTextsIn(node: ParserRuleContext, ruleNameToIndex: RuleNameToIndex): Set<string> {
  const out = new Set<string>();
  for (const fieldExpr of findAllDescendantsByRule(node, ruleNameToIndex, 'fieldExpression')) {
    const text = fieldExpr.getText();
    if (text) {
      out.add(text);
    }
  }
  return out;
}

/**
 * Pick the command stage that owns this operation. Prefers a stage in the outer
 * pipeline (not inside a subsearch / append / lookup) and, when the plan named
 * the fields, the stage whose source text references one of them. Returns
 * `undefined` when the choice is ambiguous so the caller keeps the whole-query
 * range.
 */
function pickStage(
  stages: PipelineStage[],
  targetFields: string[],
  alternateSubtrees: Set<ParserRuleContext>,
  ruleNameToIndex: RuleNameToIndex
): ParserRuleContext | undefined {
  // Prefer stages in the outer pipeline; an operation the optimizer flagged is
  // (almost always) on the outer scan, and an alternate-source subtree has its
  // own pushdown behavior we cannot attribute from the outer plan.
  const isInAlternate = (node: ParserRuleContext): boolean => {
    for (const subtree of alternateSubtrees) {
      // A stage is "inside" an alternate subtree when the subtree is an
      // ancestor. Walk parents rather than re-scanning descendants.
      let cur: ParserRuleContext | null = node;
      while (cur) {
        if (cur === subtree) {
          return true;
        }
        cur = cur.parent as ParserRuleContext | null;
      }
    }
    return false;
  };

  const outerStages = stages.filter((stage) => !isInAlternate(stage.node));
  const candidates = outerStages.length > 0 ? outerStages : stages;

  if (candidates.length === 0) {
    return undefined;
  }
  if (candidates.length === 1) {
    return candidates[0].node;
  }

  // Several candidates: disambiguate by field overlap when the plan named fields.
  if (targetFields.length > 0) {
    const matching = candidates.filter((stage) => {
      const fields = fieldTextsIn(stage.node, ruleNameToIndex);
      return targetFields.some((f) => fields.has(f));
    });
    if (matching.length === 1) {
      return matching[0].node;
    }
  }

  // Ambiguous — keep the whole-query range rather than guess.
  return undefined;
}

/** Narrow a matched command node to its field-bearing sub-expression. */
function narrow(
  command: ParserRuleContext,
  operation: 'filter' | 'aggregation' | 'sort',
  ruleNameToIndex: RuleNameToIndex
): ParserRuleContext {
  for (const ruleName of OPERATION_NARROW_RULES[operation]) {
    const child = findChildByRule(command, ruleNameToIndex, ruleName);
    if (child) {
      return child;
    }
    // The narrow target may be a deeper descendant (e.g. the first
    // statsFunction inside a statsCommand's aggregation list).
    const [descendant] = findAllDescendantsByRule(command, ruleNameToIndex, ruleName);
    if (descendant) {
      return descendant;
    }
  }
  return command;
}

/**
 * Attempt a Tier-1 quick-fix for a filter finding. The fix is derived from the
 * comparison node that owns the single `comparisonOperator` in the command — NOT
 * the whole narrowed `where`/`logicalExpression` node — for three reasons:
 *  1. `comparisonOperator` exists on BOTH the compiled and the runtime-bundle
 *     grammar (the runtime grammar has no `comparisonExpression` rule), so this
 *     works on the live ≥3.6 surface, not just in the compiled-grammar tests.
 *  2. `getText()` concatenates tokens with no whitespace, so reading it off a
 *     node that includes the `where` / `NOT` keyword would fuse e.g. `NOT`+`age`
 *     into `NOTage`, which the field pattern would wrongly accept — dropping the
 *     negation. The comparison node (the operator's parent) excludes `NOT`.
 *  3. A compound predicate (`a > 1 and b < 2`) has several comparison operators;
 *     requiring exactly one declines the compound case, which the
 *     single-comparison rewrite cannot safely handle anyway.
 *
 * Returns the fix plus the exact source node the fix replaces, or `undefined`.
 */
function buildFilterFix(
  command: ParserRuleContext,
  ruleNameToIndex: RuleNameToIndex,
  typeMap: Map<string, string> | undefined
): { fix: ReturnType<typeof buildFilterInversionFix>; node: ParserRuleContext } | undefined {
  const operators = findAllDescendantsByRule(command, ruleNameToIndex, 'comparisonOperator');
  if (operators.length !== 1) {
    return undefined;
  }
  // The comparison expression is the operator's parent (`<left> <op> <right>`),
  // whose text is the bare predicate — no `where`/`NOT`/`and` tokens to fuse.
  const comparison = (operators[0].parent as ParserRuleContext | null) ?? operators[0];
  const fix = buildFilterInversionFix(comparison.getText(), typeMap);
  return fix ? { fix, node: comparison } : undefined;
}

/**
 * Resolve precise ranges — and, for filter findings, a Tier-1 quick-fix — for
 * explain-backed diagnostics against the parse tree. Returns a new array;
 * diagnostics without an `explainTarget`, and those whose command cannot be
 * located unambiguously, are returned with their range intact and no fix.
 *
 * `typeMap` (field name → `esTypes[0]`) gates the additive quick-fix to
 * integer-mapped fields (the only exact-by-construction case); when absent, no
 * fix is offered.
 */
export function resolveExplainRanges(
  diagnostics: Diagnostic[],
  tree: ParserRuleContext,
  ruleNameToIndex: RuleNameToIndex,
  typeMap?: Map<string, string>
): Diagnostic[] {
  const explainDiagnostics = diagnostics.filter((d) => d.explainTarget);
  if (explainDiagnostics.length === 0) {
    return diagnostics;
  }

  const { stages } = buildPipelineShape(tree, ruleNameToIndex);
  const alternateSubtrees = collectAlternateSourceSubtrees(tree, ruleNameToIndex);

  return diagnostics.map((diagnostic) => {
    const target = diagnostic.explainTarget;
    if (!target) {
      return diagnostic;
    }

    const commandRules = OPERATION_COMMANDS[target.operation];
    const operationStages = stages.filter((stage) => commandRules.includes(stage.command));
    const node = pickStage(operationStages, target.fields, alternateSubtrees, ruleNameToIndex);
    if (!node) {
      return diagnostic;
    }

    const narrowed = narrow(node, target.operation, ruleNameToIndex);
    const range = rangeFromContext(narrowed);

    // Filter findings whose predicate matches a provably-safe inversion get a
    // quick-fix. The fix range is the comparison node's own span (not the
    // narrowed `where` span), so the replacement text lines up with the source.
    // Non-filter operations and unfixable predicates just get the precise range.
    if (target.operation === 'filter') {
      const result = buildFilterFix(node, ruleNameToIndex, typeMap);
      if (result && result.fix) {
        const fixRange = rangeFromContext(result.node);
        return {
          ...diagnostic,
          range,
          fix: { title: result.fix.title, text: result.fix.text, range: fixRange },
          hoverFacts: {
            ...diagnostic.hoverFacts,
            field: result.fix.field,
            literal: result.fix.literal,
          },
        };
      }
    }

    return { ...diagnostic, range };
  });
}
