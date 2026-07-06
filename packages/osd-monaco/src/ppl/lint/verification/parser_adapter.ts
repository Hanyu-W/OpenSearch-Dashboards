/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

import type { ParseTree, ParserRuleContext, TerminalNode } from 'antlr4ng';
import { isRuleNode, isTerminalNode } from '../rule_index';
import { GrammarSurface } from './grammar_surface';
import { SurfaceName, VerificationResult } from './types';

/** A located parse failure. */
export interface ParseFailure {
  message: string;
  surfaceName: SurfaceName;
  query: string;
}

/** A successful parse. */
export interface ParseSuccess {
  ok: true;
  tree: ParserRuleContext;
  surfaceName: SurfaceName;
}

/** A failed parse. */
export interface ParseError {
  ok: false;
  error: ParseFailure;
}

/** The result of parsing a query on a surface. */
export type ParseResult = ParseSuccess | ParseError;

/** Type guard: did the parse fail? Narrows to {@link ParseError}. */
export function isParseError(result: ParseResult): result is ParseError {
  return !result.ok;
}

/**
 * Parse a query on a surface. A surface `parse` that throws (unrecoverable) is
 * turned into a located `ParseFailure`. Note: the local grammars are configured
 * for error recovery, so most malformed input still yields a (partial) tree;
 * detectors are expected to tolerate that. Callers that need a *clean* parse use
 * {@link parseStrict}.
 */
export function parse(query: string, surface: GrammarSurface): ParseResult {
  try {
    const tree = surface.parse(query);
    return { ok: true, tree, surfaceName: surface.name };
  } catch (e) {
    return {
      ok: false,
      error: {
        message: e instanceof Error ? e.message : String(e),
        surfaceName: surface.name,
        query,
      },
    };
  }
}

/**
 * Pretty-print a parse tree back to normalized PPL text: the concatenation of
 * terminal token texts in pre-order, separated by single spaces, which the same
 * surface accepts. This is a structural re-emission, not a formatter — it exists
 * so a round trip can prove the parser is deterministic over its own output.
 */
export function prettyPrint(tree: ParserRuleContext): string {
  const tokens: string[] = [];
  collectTerminals(tree, tokens);
  return tokens.join(' ').trim();
}

function collectTerminals(node: ParseTree, out: string[]): void {
  if (isTerminalNode(node)) {
    const text = (node as TerminalNode).getText();
    // Skip the synthetic EOF terminal, which has no source text.
    if (text && text !== '<EOF>') {
      out.push(text);
    }
    return;
  }
  if (isRuleNode(node)) {
    const children = node.children ?? [];
    for (const child of children) {
      collectTerminals(child, out);
    }
  }
}

/** A structural difference found during a round-trip comparison. */
export interface StructuralDifference {
  path: string;
  expected: string;
  actual: string;
}

/**
 * Parse, pretty-print, reparse, and compare the two trees in pre-order. Reports
 * the earliest structural difference by rule name, token type, token text, or
 * child count (R6.4, R6.6). Returns a passing result when the trees are
 * structurally equivalent (ignoring whitespace, which is not in the tree).
 */
export function assertRoundTrip(query: string, surface: GrammarSurface): VerificationResult {
  const first = parse(query, surface);
  if (isParseError(first)) {
    return roundTripFail(surface, query, `Original query failed to parse: ${first.error.message}`);
  }

  const printed = prettyPrint(first.tree);
  const second = parse(printed, surface);
  if (isParseError(second)) {
    return roundTripFail(
      surface,
      query,
      `Pretty-printed query "${printed}" was rejected: ${second.error.message}`
    );
  }

  const diff = firstStructuralDifference(first.tree, second.tree, surface);
  if (diff) {
    return roundTripFail(
      surface,
      query,
      `Round-trip structural difference at ${diff.path}: expected ${diff.expected}, got ${diff.actual}`
    );
  }

  return {
    category: 'shape',
    passing: true,
    entries: [
      {
        category: 'shape',
        status: 'pass',
        message: `Round trip preserved structure for "${query}".`,
        context: { surface: surface.name, query },
      },
    ],
  };
}

function roundTripFail(
  surface: GrammarSurface,
  query: string,
  message: string
): VerificationResult {
  return {
    category: 'shape',
    passing: false,
    entries: [
      { category: 'shape', status: 'failure', message, context: { surface: surface.name, query } },
    ],
  };
}

/**
 * Pre-order walk of both trees in lockstep; returns the first node where rule
 * name, terminal token type/text, or child structure diverges. Undefined when
 * equivalent.
 */
function firstStructuralDifference(
  a: ParseTree,
  b: ParseTree,
  surface: GrammarSurface,
  path = 'root'
): StructuralDifference | undefined {
  const aRule = isRuleNode(a);
  const bRule = isRuleNode(b);
  if (aRule !== bRule) {
    return {
      path,
      expected: aRule ? 'ruleNode' : 'terminal',
      actual: bRule ? 'ruleNode' : 'terminal',
    };
  }

  if (!aRule) {
    const at = (a as TerminalNode).getText();
    const bt = (b as TerminalNode).getText();
    if (at !== bt) {
      return { path, expected: `token "${at}"`, actual: `token "${bt}"` };
    }
    return undefined;
  }

  const aCtx = a as ParserRuleContext;
  const bCtx = b as ParserRuleContext;
  if (aCtx.ruleIndex !== bCtx.ruleIndex) {
    return {
      path,
      expected: ruleName(surface, aCtx.ruleIndex),
      actual: ruleName(surface, bCtx.ruleIndex),
    };
  }

  const aKids = aCtx.children ?? [];
  const bKids = bCtx.children ?? [];
  if (aKids.length !== bKids.length) {
    return { path, expected: `${aKids.length} children`, actual: `${bKids.length} children` };
  }

  for (let i = 0; i < aKids.length; i++) {
    const diff = firstStructuralDifference(
      aKids[i],
      bKids[i],
      surface,
      `${path}/${ruleName(surface, aCtx.ruleIndex)}[${i}]`
    );
    if (diff) {
      return diff;
    }
  }
  return undefined;
}

function ruleName(surface: GrammarSurface, ruleIndex: number): string {
  return surface.parserRuleNames[ruleIndex] ?? `rule#${ruleIndex}`;
}
