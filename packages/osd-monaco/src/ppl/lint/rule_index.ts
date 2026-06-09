/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

import type { ParserRuleContext, ParseTree, TerminalNode } from 'antlr4ng';
import { SimplifiedOpenSearchPPLParser } from '@osd/antlr-grammar';

/**
 * Resolves a grammar rule name to its numeric rule index on the active grammar
 * surface. Returns -1 when the rule name is absent on that surface, which makes
 * a detector for an absent command gracefully no-op (R3.2, R12.1).
 */
export type RuleNameToIndex = (name: string) => number;

// Duck-type guards that work across duplicate module instances in bundled
// environments (Rspack worker bundles antlr4ng separately from the main thread,
// breaking `instanceof` checks against the main-thread class identity).

export function isRuleNode(node: unknown): node is ParserRuleContext {
  return (
    node != null &&
    typeof (node as any).ruleIndex === 'number' &&
    (node as any).ruleIndex >= 0 &&
    'children' in (node as any)
  );
}

export function isTerminalNode(node: unknown): node is TerminalNode {
  return (
    node != null &&
    typeof (node as any).symbol === 'object' &&
    (node as any).symbol != null &&
    !('ruleIndex' in (node as any) && (node as any).ruleIndex >= 0)
  );
}

/**
 * Lazily-built, reused name→index map for the compiled grammar surface.
 * Built once on first use (R3.3) rather than calling `.indexOf` per node.
 */
let compiledRuleNameToIndexMap: Map<string, number> | undefined;

function getCompiledRuleNameToIndexMap(): Map<string, number> {
  if (!compiledRuleNameToIndexMap) {
    compiledRuleNameToIndexMap = new Map<string, number>();
    const ruleNames = SimplifiedOpenSearchPPLParser.ruleNames;
    for (let i = 0; i < ruleNames.length; i++) {
      compiledRuleNameToIndexMap.set(ruleNames[i], i);
    }
  }
  return compiledRuleNameToIndexMap;
}

/**
 * Build a {@link RuleNameToIndex} resolver for the compiled grammar surface,
 * using the prebuilt name→index map from `SimplifiedOpenSearchPPLParser`.
 */
export function createCompiledRuleNameToIndex(): RuleNameToIndex {
  const map = getCompiledRuleNameToIndexMap();
  return (name: string) => map.get(name) ?? -1;
}

/**
 * Build a {@link RuleNameToIndex} resolver for a runtime grammar surface,
 * given the runtime grammar's rule-name→index map.
 */
export function createRuntimeRuleNameToIndex(
  runtimeRuleNameToIndex: Map<string, number>
): RuleNameToIndex {
  return (name: string) => runtimeRuleNameToIndex.get(name) ?? -1;
}

/**
 * Type guard: is this parse tree node a `ParserRuleContext`?
 */
export function isParserRuleContext(node: ParseTree | null | undefined): node is ParserRuleContext {
  return isRuleNode(node);
}

/**
 * Find the first child of `ctx` matching the given rule name. Returns undefined
 * when the rule name is absent on the active surface or no child matches.
 */
export function findChildByRule(
  ctx: ParserRuleContext,
  ruleNameToIndex: RuleNameToIndex,
  ruleName: string
): ParserRuleContext | undefined {
  const idx = ruleNameToIndex(ruleName);
  if (idx === -1) {
    return undefined;
  }
  const children = ctx.children ?? [];
  for (const child of children) {
    if (isRuleNode(child) && child.ruleIndex === idx) {
      return child as ParserRuleContext;
    }
  }
  return undefined;
}

/**
 * Find all children of `ctx` matching the given rule name. Returns an empty
 * array when the rule name is absent on the active surface.
 */
export function findAllChildrenByRule(
  ctx: ParserRuleContext,
  ruleNameToIndex: RuleNameToIndex,
  ruleName: string
): ParserRuleContext[] {
  const idx = ruleNameToIndex(ruleName);
  if (idx === -1) {
    return [];
  }
  const children = ctx.children ?? [];
  return children.filter((c): c is ParserRuleContext => isRuleNode(c) && c.ruleIndex === idx);
}

/**
 * Recursively find all descendants (any depth) of `ctx` matching the rule name.
 */
export function findAllDescendantsByRule(
  ctx: ParserRuleContext,
  ruleNameToIndex: RuleNameToIndex,
  ruleName: string
): ParserRuleContext[] {
  const idx = ruleNameToIndex(ruleName);
  if (idx === -1) {
    return [];
  }
  const matches: ParserRuleContext[] = [];
  const stack: ParseTree[] = [...(ctx.children ?? [])];
  while (stack.length > 0) {
    const node = stack.pop()!;
    if (isRuleNode(node)) {
      if (node.ruleIndex === idx) {
        matches.push(node as ParserRuleContext);
      }
      if (node.children) {
        stack.push(...node.children);
      }
    }
  }
  return matches;
}

/**
 * Concatenate the terminal token text of a node's direct children.
 */
export function getTokenText(ctx: ParserRuleContext): string {
  const children = ctx.children ?? [];
  return children
    .filter((c): c is TerminalNode => isTerminalNode(c))
    .map((c) => c.getText())
    .join('');
}
