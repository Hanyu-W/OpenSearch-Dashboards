/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

import type { ParserRuleContext, ParseTree } from 'antlr4ng';
import { isRuleNode, isTerminalNode, findAllDescendantsByRule } from './rule_index';
import { RuleNameToIndex } from './rule_index';

export interface PipelineStage {
  command: string;
  node: ParserRuleContext;
}

export interface PipelineShape {
  /** Command stages in pipe (source) order. */
  stages: PipelineStage[];
  /** Field names created upstream in the pipeline. */
  createdFields: Set<string>;
}

// Command rule names recognized as pipeline stages, mapped to a short label.
const COMMAND_RULE_NAMES = [
  'searchCommand',
  'whereCommand',
  'fieldsCommand',
  'tableCommand',
  'joinCommand',
  'renameCommand',
  'statsCommand',
  'eventstatsCommand',
  'streamstatsCommand',
  'dedupCommand',
  'sortCommand',
  'evalCommand',
  'headCommand',
  'binCommand',
  'topCommand',
  'rareCommand',
  'grokCommand',
  'parseCommand',
  'spathCommand',
  'patternsCommand',
  'lookupCommand',
  'fillnullCommand',
  'trendlineCommand',
  'appendcolCommand',
  'appendCommand',
  'expandCommand',
  'flattenCommand',
  'reverseCommand',
  'regexCommand',
  'timechartCommand',
  'rexCommand',
  'replaceCommand',
  'unionCommand',
  'multisearchCommand',
];

function buildIndexToCommandName(ruleNameToIndex: RuleNameToIndex): Map<number, string> {
  const map = new Map<number, string>();
  for (const name of COMMAND_RULE_NAMES) {
    const idx = ruleNameToIndex(name);
    if (idx !== -1) {
      map.set(idx, name);
    }
  }
  return map;
}

/**
 * Collect created field names from a single command node. Best-effort: it scans
 * for `... AS <name>` patterns and known LHS positions.
 */
function collectCreatedFields(
  stage: PipelineStage,
  ruleNameToIndex: RuleNameToIndex,
  out: Set<string>
): void {
  // Walk descendants looking for an `AS` terminal followed by a name node.
  const stack: ParseTree[] = [stage.node];
  while (stack.length > 0) {
    const node = stack.pop()!;
    if (!isRuleNode(node)) {
      continue;
    }
    const children = node.children ?? [];
    for (let i = 0; i < children.length; i++) {
      const child = children[i];
      if (isTerminalNode(child) && child.getText().toLowerCase() === 'as') {
        const next = children[i + 1];
        if (isRuleNode(next)) {
          const name = next.getText();
          if (name) {
            out.add(name);
          }
        }
      }
    }

    stack.push(...children);
  }

  // eval LHS names: evalClause's first fieldExpression child.
  const fieldExprIdx = ruleNameToIndex('fieldExpression');
  const evalClauseIdx = ruleNameToIndex('evalClause');
  if (evalClauseIdx !== -1) {
    const evalStack: ParseTree[] = [stage.node];
    while (evalStack.length > 0) {
      const node = evalStack.pop()!;
      if (!isRuleNode(node)) {
        continue;
      }
      if (node.ruleIndex === evalClauseIdx) {
        const first = (node.children ?? []).find(
          (c) => isRuleNode(c) && c.ruleIndex === fieldExprIdx
        ) as ParserRuleContext | undefined;
        if (first) {
          const name = first.getText();
          if (name) {
            out.add(name);
          }
        }
      }
      evalStack.push(...(node.children ?? []));
    }
  }
}

/**
 * Pre-order DFS that visits parse-tree nodes in source order and collects the
 * pipeline command stages plus the set of field names created upstream.
 */
export function buildPipelineShape(
  tree: ParserRuleContext,
  ruleNameToIndex: RuleNameToIndex
): PipelineShape {
  const indexToCommand = buildIndexToCommandName(ruleNameToIndex);
  const stages: PipelineStage[] = [];
  const createdFields = new Set<string>();

  // Pre-order traversal preserving child order.
  const visit = (node: ParseTree): void => {
    if (isRuleNode(node)) {
      const commandName = indexToCommand.get(node.ruleIndex);
      if (commandName) {
        stages.push({ command: commandName, node });
      }
      const children = node.children ?? [];
      for (const child of children) {
        visit(child);
      }
    }
  };
  visit(tree);

  for (const stage of stages) {
    collectCreatedFields(stage, ruleNameToIndex, createdFields);
  }

  return { stages, createdFields };
}

/**
 * Collect the parse-tree nodes whose internal field references belong to a
 * *different* source than the outer pipeline's index. Field-validation prunes
 * these subtrees entirely so it never flags a legitimate alternate-source
 * reference as an unknown field. Covers:
 *  - `lookup` (whole command — its columns come from the lookup table)
 *  - `append [source=... | ...]` (only when it embeds its own `searchCommand`;
 *    an `append [| where f=1]` with no inner source runs against the outer
 *    index and is left to be validated)
 *  - `subSearch` (scalar / IN / EXISTS subqueries *and* a join's right side —
 *    `tableOrSubqueryClause` wraps a `subSearch`)
 *  - `unionDataset` (runtime-grammar-only; a no-op on the compiled surface
 *    where `ruleNameToIndex` returns -1 and the descendant scan yields nothing)
 *
 * Each membership test in the caller is O(1) (`Set.has`); building the set is a
 * handful of descendant scans over the tree.
 */
export function collectAlternateSourceSubtrees(
  tree: ParserRuleContext,
  ruleNameToIndex: RuleNameToIndex
): Set<ParserRuleContext> {
  const subtrees = new Set<ParserRuleContext>();

  for (const node of findAllDescendantsByRule(tree, ruleNameToIndex, 'lookupCommand')) {
    subtrees.add(node);
  }

  for (const node of findAllDescendantsByRule(tree, ruleNameToIndex, 'appendCommand')) {
    if (findAllDescendantsByRule(node, ruleNameToIndex, 'searchCommand').length > 0) {
      subtrees.add(node);
    }
  }

  for (const node of findAllDescendantsByRule(tree, ruleNameToIndex, 'subSearch')) {
    subtrees.add(node);
  }

  for (const node of findAllDescendantsByRule(tree, ruleNameToIndex, 'unionDataset')) {
    subtrees.add(node);
  }

  return subtrees;
}
