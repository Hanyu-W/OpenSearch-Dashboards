/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

import type { ParserRuleContext, ParseTree } from 'antlr4ng';
import {
  isRuleNode,
  isTerminalNode,
  findAllDescendantsByRule,
  findChildByRule,
} from './rule_index';
import { RuleNameToIndex } from './rule_index';
import { extractCreatedFieldNames } from './pattern_fields';

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

// Default output field name `patterns` uses when NEW_FIELD is omitted.
const PATTERNS_DEFAULT_FIELD = 'patterns_field';

// `patterns` also emits a companion `tokens` struct column alongside its main
// output field (confirmed against the live Calcite 2.19 engine). Register it so
// a downstream reference to `tokens` isn't false-flagged.
const PATTERNS_TOKENS_FIELD = 'tokens';

function unquote(raw: string): string {
  return raw.length >= 2 && /^['"]/.test(raw) && raw[0] === raw[raw.length - 1]
    ? raw.slice(1, -1)
    : raw;
}

/**
 * Value of a named-slot parameter: find the terminal matching `keyword`, then
 * return the text of the first rule-node sibling after it. Used to read
 * `NEW_FIELD = <literal>` (patterns) and `OUTPUT = <expr>` (spath).
 */
function findSlotValueAfterKeyword(node: ParserRuleContext, keyword: string): string | undefined {
  const stack: ParseTree[] = [node];
  while (stack.length > 0) {
    const n = stack.pop()!;
    if (!isRuleNode(n)) continue;
    const children = n.children ?? [];
    for (let i = 0; i < children.length; i++) {
      const c = children[i];
      if (isTerminalNode(c) && c.getText().toUpperCase() === keyword) {
        for (let j = i + 1; j < children.length; j++) {
          const v = children[j];
          if (isRuleNode(v)) return v.getText();
        }
      }
    }
    stack.push(...children);
  }
  return undefined;
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

  // (a) Capture-pattern extraction: grok / parse / rex. The created names live
  // inside the pattern string literal, which the AS/eval scans never descend
  // into. grok/parse type the pattern as the last stringLiteral in the command;
  // rex has a single stringLiteral (its pattern). Picking the last-starting
  // literal is correct for all three.
  if (
    stage.command === 'grokCommand' ||
    stage.command === 'parseCommand' ||
    stage.command === 'rexCommand'
  ) {
    const literals = findAllDescendantsByRule(stage.node, ruleNameToIndex, 'stringLiteral');
    let pattern: ParserRuleContext | undefined;
    for (const lit of literals) {
      if (!pattern || (lit.start?.start ?? -1) > (pattern.start?.start ?? -1)) {
        pattern = lit;
      }
    }
    if (pattern) {
      for (const name of extractCreatedFieldNames(pattern.getText())) {
        out.add(name);
      }
    }
  }

  // (b) Named-slot extraction: patterns. Engine versions disagree on the output
  // name: the Calcite 2.19 engine honors `NEW_FIELD='x'` (output column `x`) and
  // also emits a companion `tokens` struct; the 3.6 runtime engine ignores
  // NEW_FIELD entirely and always names the column `patterns_field` (no
  // `tokens`). Both behaviors were confirmed live. Since over-registering a
  // created field only risks missing a rare typo while under-registering causes
  // a false "unknown field" flag, register the union: the explicit NEW_FIELD
  // name (when present), the default `patterns_field`, and `tokens`.
  if (stage.command === 'patternsCommand') {
    const newFieldLit = findSlotValueAfterKeyword(stage.node, 'NEW_FIELD');
    if (newFieldLit) {
      out.add(unquote(newFieldLit));
    }
    out.add(PATTERNS_DEFAULT_FIELD);
    out.add(PATTERNS_TOKENS_FIELD);
  }

  // (c) Named-slot extraction: spath. Each spathParameter either names its
  // output via `OUTPUT = <name>` or, absent that, derives the field from the
  // indexable path text. `INPUT` is deliberately left unregistered so the
  // source field is still validated.
  if (stage.command === 'spathCommand') {
    for (const param of findAllDescendantsByRule(stage.node, ruleNameToIndex, 'spathParameter')) {
      const output = findSlotValueAfterKeyword(param, 'OUTPUT');
      if (output) {
        out.add(unquote(output));
        continue;
      }
      const path = findChildByRule(param, ruleNameToIndex, 'indexablePath');
      if (path) {
        out.add(path.getText());
      }
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
