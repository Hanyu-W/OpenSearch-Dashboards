/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

import type { ParserRuleContext } from 'antlr4ng';
import { Diagnostic } from '../diagnostic';
import { Detector } from '../types';
import { findAllDescendantsByRule, findChildByRule, RuleNameToIndex } from '../rule_index';
import { rangeFromContext, rangeWithinToken } from '../range_utils';

// Engine ground truth: RegexCommonUtils.isValidJavaRegexGroupName validates
// names against this pattern (core/.../parse/RegexCommonUtils.java:73,101,105).
const VALID_GROUP_NAME = /^[A-Za-z][A-Za-z0-9]*$/;

// Matches both the Java `(?<name>` opener and the Python/PCRE `(?P<name>`
// opener. Group 1 captures the `P` when the Python opener is used; group 2
// captures the name.
const CAPTURE_GROUP_OPENER = /\(\?(P?)<([^>]*)>/g;

// Rule names whose string-literal argument carries a regex with capture groups.
const REGEX_COMMAND_RULES = ['rexExpr', 'parseCommand', 'grokCommand'];

interface ExtractedGroup {
  name: string;
  isPythonOpener: boolean;
  /** 0-based offset of the name within the raw (quoted) literal text. */
  nameOffsetInLiteral: number;
}

function extractGroups(literalRaw: string): ExtractedGroup[] {
  const groups: ExtractedGroup[] = [];
  CAPTURE_GROUP_OPENER.lastIndex = 0;
  let match: RegExpExecArray | null;

  while ((match = CAPTURE_GROUP_OPENER.exec(literalRaw)) !== null) {
    const isPythonOpener = match[1] === 'P';
    const name = match[2];
    // Offset of the name within the literal: opener start + length up to name.
    const openerStart = match.index;
    const prefixLength = isPythonOpener ? '(?P<'.length : '(?<'.length;
    groups.push({
      name,
      isPythonOpener,
      nameOffsetInLiteral: openerStart + prefixLength,
    });
  }
  return groups;
}

function findStringLiteral(
  command: ParserRuleContext,
  ruleNameToIndex: RuleNameToIndex
): ParserRuleContext | undefined {
  // Direct child first (grok/parse), then descendant (rexExpr → stringLiteral).
  const direct = findChildByRule(command, ruleNameToIndex, 'stringLiteral');
  if (direct) {
    return direct;
  }
  const descendants = findAllDescendantsByRule(command, ruleNameToIndex, 'stringLiteral');
  return descendants[descendants.length - 1];
}

export const invalidCaptureGroupNameDetector: Detector = (
  tree,
  config,
  _context,
  ruleNameToIndex
) => {
  const diagnostics: Diagnostic[] = [];

  const commands: ParserRuleContext[] = [];
  for (const ruleName of REGEX_COMMAND_RULES) {
    commands.push(...findAllDescendantsByRule(tree, ruleNameToIndex, ruleName));
  }

  for (const command of commands) {
    const literalNode = findStringLiteral(command, ruleNameToIndex);
    if (!literalNode) {
      continue;
    }
    const literalRaw = literalNode.getText();
    const groups = extractGroups(literalRaw);
    const literalToken = literalNode.start;

    for (const group of groups) {
      const range = literalToken
        ? rangeWithinToken(literalToken, group.nameOffsetInLiteral, Math.max(1, group.name.length))
        : rangeFromContext(literalNode);

      if (group.isPythonOpener) {
        diagnostics.push({
          ruleId: config.id,
          severity: config.severity,
          message: `Python/PCRE named-group opener "(?P<${group.name}>" is invalid in Java regex; use "(?<${group.name}>" instead.`,
          range,
          docUrl: config.docUrl,
        });
        continue;
      }

      if (!VALID_GROUP_NAME.test(group.name)) {
        diagnostics.push({
          ruleId: config.id,
          severity: config.severity,
          message: `Invalid capture group name "${group.name}". Names must match ^[A-Za-z][A-Za-z0-9]*$.`,
          range,
          docUrl: config.docUrl,
        });
      }
    }
  }

  return diagnostics;
};
