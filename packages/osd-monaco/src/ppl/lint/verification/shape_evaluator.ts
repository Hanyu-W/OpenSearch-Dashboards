/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

import type { ParseTree, ParserRuleContext } from 'antlr4ng';
import { isRuleNode } from '../rule_index';
import { GrammarSurface } from './grammar_surface';
import { ShapeAssertion, TextPredicate, TreeAnchor, VerificationResult } from './types';

/**
 * Evaluate a {@link ShapeAssertion} against a grammar surface: parse the
 * canonical query, resolve each anchor to exactly one node, and check every
 * relationship. Returns a structured result; never throws for expected failure
 * modes (parse failure, missing/ambiguous anchor, unmet relationship) — those
 * are reported entries (R7.2, R7.3, R7.4, R7.7).
 *
 * Surface applicability is the caller's responsibility via
 * {@link isShapeApplicable}; this function assumes the assertion applies to the
 * surface it is given.
 */
export function evaluateShapeAssertion(
  assertion: ShapeAssertion,
  surface: GrammarSurface
): VerificationResult {
  const entries: VerificationResult['entries'] = [];
  const baseContext = {
    surface: surface.name,
    rule: assertion.ruleId,
    query: assertion.canonicalQuery,
  };

  let tree: ParserRuleContext;
  try {
    tree = surface.parse(assertion.canonicalQuery);
  } catch (e) {
    return fail(
      assertion,
      surface,
      `Canonical query failed to parse: ${e instanceof Error ? e.message : String(e)}`
    );
  }

  // Resolve each anchor to exactly one node.
  const resolved = new Map<string, ParserRuleContext>();
  for (const anchor of assertion.expectedAnchors) {
    const matches = resolveAnchor(tree, anchor, surface);
    if (matches.length !== 1) {
      entries.push({
        category: 'shape',
        status: 'failure',
        message: `Anchor "${anchor.name}" (rule ${anchor.ruleName}) resolved to ${matches.length} nodes; expected exactly 1.`,
        context: baseContext,
      });
      continue;
    }
    resolved.set(anchor.name, matches[0]);
  }

  if (resolved.size !== assertion.expectedAnchors.length) {
    return { category: 'shape', passing: false, entries: [...entries] };
  }

  // Check relationships.
  for (const rel of assertion.expectedRelationships) {
    const ok = checkRelationship(rel, resolved);
    if (!ok) {
      entries.push({
        category: 'shape',
        status: 'failure',
        message: `Relationship ${describeRelationship(rel)} not satisfied.`,
        context: baseContext,
      });
    }
  }

  const passing = entries.every((e) => e.status !== 'failure');
  if (passing) {
    entries.push({
      category: 'shape',
      status: 'pass',
      message: `Shape "${assertion.assertionId}" holds.`,
      context: baseContext,
    });
  }
  return { category: 'shape', passing, entries: [...entries] };
}

/** Whether the assertion should run on this surface, per its surface scope. */
export function isShapeApplicable(assertion: ShapeAssertion, surface: GrammarSurface): boolean {
  if (assertion.notApplicableSurfaces.includes(surface.name)) {
    return false;
  }
  return assertion.applicableSurfaces.includes(surface.name);
}

function fail(
  assertion: ShapeAssertion,
  surface: GrammarSurface,
  message: string
): VerificationResult {
  return {
    category: 'shape',
    passing: false,
    entries: [
      {
        category: 'shape',
        status: 'failure',
        message,
        context: { surface: surface.name, rule: assertion.ruleId, query: assertion.canonicalQuery },
      },
    ],
  };
}

/** Collect every descendant rule node matching the anchor's rule name + text constraint. */
function resolveAnchor(
  tree: ParserRuleContext,
  anchor: TreeAnchor,
  surface: GrammarSurface
): ParserRuleContext[] {
  const idx = surface.ruleNameToIndex(anchor.ruleName);
  if (idx < 0) {
    return [];
  }
  const matches: ParserRuleContext[] = [];
  const stack: ParseTree[] = [tree];
  while (stack.length > 0) {
    const node = stack.pop()!;
    if (isRuleNode(node)) {
      if (node.ruleIndex === idx && matchesText(node.getText(), anchor)) {
        matches.push(node);
      }
      const children = node.children ?? [];
      for (const child of children) {
        stack.push(child);
      }
    }
  }
  return matches;
}

function matchesText(text: string, anchor: TreeAnchor): boolean {
  if (anchor.text !== undefined && text !== anchor.text) {
    return false;
  }
  if (anchor.predicate && !matchesPredicate(text, anchor.predicate)) {
    return false;
  }
  return true;
}

function matchesPredicate(text: string, predicate: TextPredicate): boolean {
  switch (predicate.kind) {
    case 'equals':
      return text === predicate.value;
    case 'includes':
      return text.includes(predicate.value);
    case 'matches':
      return new RegExp(predicate.source).test(text);
    default:
      return false;
  }
}

function checkRelationship(
  rel: ShapeAssertion['expectedRelationships'][number],
  resolved: Map<string, ParserRuleContext>
): boolean {
  switch (rel.kind) {
    case 'ancestor_of': {
      const ancestor = resolved.get(rel.ancestor);
      const descendant = resolved.get(rel.descendant);
      return Boolean(ancestor && descendant && isAncestor(ancestor, descendant));
    }
    case 'parent_of': {
      const parent = resolved.get(rel.parent);
      const child = resolved.get(rel.child);
      return Boolean(parent && child && (child.parent as ParserRuleContext | null) === parent);
    }
    case 'precedes_sibling': {
      const first = resolved.get(rel.first);
      const second = resolved.get(rel.second);
      return Boolean(first && second && precedesInPreOrder(first, second));
    }
    default:
      return false;
  }
}

function isAncestor(ancestor: ParserRuleContext, node: ParserRuleContext): boolean {
  for (
    let n: ParserRuleContext | null = node.parent as ParserRuleContext | null;
    n;
    n = n.parent as ParserRuleContext | null
  ) {
    if (n === ancestor) {
      return true;
    }
  }
  return false;
}

/** True when `first` starts strictly before `second` by token start offset. */
function precedesInPreOrder(first: ParserRuleContext, second: ParserRuleContext): boolean {
  const a = first.start?.start ?? -1;
  const b = second.start?.start ?? -1;
  return a >= 0 && b >= 0 && a < b;
}

function describeRelationship(rel: ShapeAssertion['expectedRelationships'][number]): string {
  switch (rel.kind) {
    case 'ancestor_of':
      return `${rel.ancestor} ancestor_of ${rel.descendant}`;
    case 'parent_of':
      return `${rel.parent} parent_of ${rel.child}`;
    case 'precedes_sibling':
      return `${rel.first} precedes_sibling ${rel.second}`;
    default:
      return 'unknown';
  }
}
