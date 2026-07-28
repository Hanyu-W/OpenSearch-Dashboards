/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

import type { ParserRuleContext } from 'antlr4ng';
import {
  findAllChildrenByRule,
  findAllDescendantsByRule,
  findChildByRule,
  isRuleNode,
  isTerminalNode,
  RuleNameToIndex,
} from './rule_index';
import { analyzeLeadingLiteral, decodePatternLiteral, findPatternLiteral } from './pattern_literal';
import { extractCreatedFieldNames } from './pattern_fields';
import { buildPipelineShape, getPipelineStagesForCommand, PipelineStage } from './pipeline_shape';

export type ExtractionCommandName = 'rexCommand' | 'parseCommand' | 'grokCommand';

export interface ExtractionTarget {
  command: ExtractionCommandName;
  keyword: 'rex' | 'parse' | 'grok';
  node: ParserRuleContext;
  field: string;
}

export interface ExtractionPrefilterSpec {
  command: ExtractionCommandName;
  field: string;
  literalRun: string;
  token: string;
  captureFields: Set<string>;
  extraction: ParserRuleContext;
}

export type RecognizedPrefilterKind = 'exact-substring' | 'match-phrase';

export interface RecognizedPrefilter {
  kind: RecognizedPrefilterKind;
  where: ParserRuleContext;
  field: string;
  literal: string;
}

export interface SafePrefilterInsertionProof {
  where: ParserRuleContext;
  captureField: string;
  pattern: string;
}

export type RexPrefilterRewriteReason =
  | 'unsafe-prefilter'
  | 'prefilter-not-before-extraction'
  | 'prefilter-not-exact-substring'
  | 'nonmatching-prefilter-field'
  | 'no-null-rejecting-consumer'
  | 'multiple-command-changes';

export interface RexPrefilterRewriteResult {
  accepted: boolean;
  reason?: RexPrefilterRewriteReason;
}

interface ExtractionDefinition {
  command: ExtractionCommandName;
  keyword: ExtractionTarget['keyword'];
}

const EXTRACTION_DEFINITIONS: readonly ExtractionDefinition[] = [
  { command: 'rexCommand', keyword: 'rex' },
  { command: 'parseCommand', keyword: 'parse' },
  { command: 'grokCommand', keyword: 'grok' },
];

export function canonicalField(raw: string): string {
  return raw.replace(/`((?:``|[^`])*)`/g, (_match, value: string) => value.replace(/``/g, '`'));
}

function rexSourceField(
  command: ParserRuleContext,
  ruleNameToIndex: RuleNameToIndex
): string | undefined {
  const rexExpr = findChildByRule(command, ruleNameToIndex, 'rexExpr');
  const field = rexExpr && findChildByRule(rexExpr, ruleNameToIndex, 'qualifiedName');
  return field?.getText();
}

function bareFieldSource(
  command: ParserRuleContext,
  ruleNameToIndex: RuleNameToIndex
): string | undefined {
  const expression = findChildByRule(command, ruleNameToIndex, 'expression');
  if (!expression) {
    return undefined;
  }
  const fields = findAllDescendantsByRule(expression, ruleNameToIndex, 'fieldExpression');
  if (fields.length !== 1 || fields[0].getText() !== expression.getText()) {
    return undefined;
  }
  return fields[0].getText();
}

export function collectExtractionTargets(
  tree: ParserRuleContext,
  ruleNameToIndex: RuleNameToIndex
): ExtractionTarget[] {
  const targets: ExtractionTarget[] = [];
  for (const definition of EXTRACTION_DEFINITIONS) {
    for (const node of findAllDescendantsByRule(tree, ruleNameToIndex, definition.command)) {
      const field =
        definition.command === 'rexCommand'
          ? rexSourceField(node, ruleNameToIndex)
          : bareFieldSource(node, ruleNameToIndex);
      if (field !== undefined) {
        targets.push({ ...definition, node, field });
      }
    }
  }
  return targets.sort(
    (left, right) => (left.node.start?.start ?? 0) - (right.node.start?.start ?? 0)
  );
}

function extractionTargetForNode(
  node: ParserRuleContext,
  ruleNameToIndex: RuleNameToIndex
): ExtractionTarget | undefined {
  const definition = EXTRACTION_DEFINITIONS.find(
    ({ command }) => ruleNameToIndex(command) === node.ruleIndex
  );
  if (!definition) {
    return undefined;
  }
  const field =
    definition.command === 'rexCommand'
      ? rexSourceField(node, ruleNameToIndex)
      : bareFieldSource(node, ruleNameToIndex);
  return field === undefined ? undefined : { ...definition, node, field };
}

export function buildExtractionPrefilterSpec(
  target: ExtractionTarget,
  ruleNameToIndex: RuleNameToIndex
): ExtractionPrefilterSpec | undefined {
  const pattern = findPatternLiteral(target.node, ruleNameToIndex);
  if (!pattern) {
    return undefined;
  }
  const leading = analyzeLeadingLiteral(decodePatternLiteral(pattern.getText()));
  if (!leading?.token) {
    return undefined;
  }
  return {
    command: target.command,
    field: target.field,
    literalRun: leading.literalRun,
    token: leading.token,
    captureFields: extractionCaptureFields(target.node, ruleNameToIndex),
    extraction: target.node,
  };
}

function extractionCaptureFields(
  extraction: ParserRuleContext,
  ruleNameToIndex: RuleNameToIndex
): Set<string> {
  const pattern = findPatternLiteral(extraction, ruleNameToIndex);
  return new Set(
    (pattern ? extractCreatedFieldNames(pattern.getText()) : []).map((field) =>
      canonicalField(field)
    )
  );
}

function extractionOutputFields(
  extraction: ParserRuleContext,
  ruleNameToIndex: RuleNameToIndex
): Set<string> {
  const fields = extractionCaptureFields(extraction, ruleNameToIndex);
  for (const option of findAllDescendantsByRule(extraction, ruleNameToIndex, 'rexOption')) {
    const offsetField = findChildByRule(option, ruleNameToIndex, 'qualifiedName');
    if (offsetField) {
      fields.add(canonicalField(offsetField.getText()));
    }
  }
  return fields;
}

// V1 emits a single-quoted PPL literal with no LIKE escape clause. Decline any
// run whose exact encoding would require escaping or whose meaning LIKE would
// reinterpret.
const UNSAFE_AUTOMATIC_LITERAL = /[%_\\'"\u0000-\u001f\u007f]/;

export function exactSubstringPattern(spec: ExtractionPrefilterSpec): string | undefined {
  return UNSAFE_AUTOMATIC_LITERAL.test(spec.literalRun) ? undefined : `%${spec.literalRun}%`;
}

export function exactSubstringWhereClause(spec: ExtractionPrefilterSpec): string | undefined {
  const pattern = exactSubstringPattern(spec);
  return pattern === undefined ? undefined : `WHERE LIKE(${spec.field}, '${pattern}')`;
}

function sameSpan(left: ParserRuleContext, right: ParserRuleContext): boolean {
  return (
    left.start?.start !== undefined &&
    left.stop?.stop !== undefined &&
    left.start.start === right.start?.start &&
    left.stop.stop === right.stop?.stop
  );
}

function directTerminal(node: ParserRuleContext, text: string): boolean {
  const expected = text.toUpperCase();
  return (node.children ?? []).some(
    (child) => isTerminalNode(child) && child.getText().toUpperCase() === expected
  );
}

function exactDescendant(
  node: ParserRuleContext,
  ruleNameToIndex: RuleNameToIndex,
  ruleName: string
): ParserRuleContext | undefined {
  const ruleIndex = ruleNameToIndex(ruleName);
  if (ruleIndex !== -1 && node.ruleIndex === ruleIndex) {
    return node;
  }
  return findAllDescendantsByRule(node, ruleNameToIndex, ruleName).find((child) =>
    sameSpan(node, child)
  );
}

function exactField(node: ParserRuleContext, ruleNameToIndex: RuleNameToIndex): string | undefined {
  const field = exactDescendant(node, ruleNameToIndex, 'fieldExpression');
  if (field) {
    return canonicalField(field.getText());
  }
  const qualified = exactDescendant(node, ruleNameToIndex, 'qualifiedName');
  return qualified ? canonicalField(qualified.getText()) : undefined;
}

function exactString(
  node: ParserRuleContext,
  ruleNameToIndex: RuleNameToIndex
): string | undefined {
  const literal = exactDescendant(node, ruleNameToIndex, 'stringLiteral');
  return literal ? decodePatternLiteral(literal.getText()) : undefined;
}

interface AtomicFunction {
  name: string;
  args: ParserRuleContext[];
}

function readAtomicFunction(
  logical: ParserRuleContext,
  ruleNameToIndex: RuleNameToIndex
): AtomicFunction | undefined {
  for (const ruleName of ['evalFunctionCall', 'booleanFunctionCall']) {
    const call = findAllDescendantsByRule(logical, ruleNameToIndex, ruleName).find((candidate) =>
      sameSpan(logical, candidate)
    );
    if (!call) {
      continue;
    }
    const name =
      findChildByRule(call, ruleNameToIndex, 'evalFunctionName') ??
      findChildByRule(call, ruleNameToIndex, 'conditionFunctionBase');
    const args = findChildByRule(call, ruleNameToIndex, 'functionArgs');
    if (name && args) {
      return {
        name: name.getText().toUpperCase(),
        args: findAllChildrenByRule(args, ruleNameToIndex, 'functionArg'),
      };
    }
  }
  return undefined;
}

interface AtomicPrefilter {
  kind: RecognizedPrefilterKind;
  field: string;
  literal: string;
}

function readAtomicPrefilter(
  logical: ParserRuleContext,
  ruleNameToIndex: RuleNameToIndex
): AtomicPrefilter | undefined {
  const relevance = findAllDescendantsByRule(
    logical,
    ruleNameToIndex,
    'singleFieldRelevanceFunction'
  ).find((candidate) => sameSpan(logical, candidate));
  if (relevance) {
    const name = findChildByRule(relevance, ruleNameToIndex, 'singleFieldRelevanceFunctionName');
    const fieldNode = findChildByRule(relevance, ruleNameToIndex, 'relevanceField');
    const queryNode = findChildByRule(relevance, ruleNameToIndex, 'relevanceQuery');
    const field = fieldNode && exactField(fieldNode, ruleNameToIndex);
    const literal = queryNode && exactString(queryNode, ruleNameToIndex);
    if (name?.getText().toUpperCase() === 'MATCH_PHRASE' && field && literal !== undefined) {
      return { kind: 'match-phrase', field, literal };
    }
  }

  const fn = readAtomicFunction(logical, ruleNameToIndex);
  if (fn?.name !== 'LIKE' || fn.args.length !== 2) {
    return undefined;
  }
  const field = exactField(fn.args[0], ruleNameToIndex);
  const literal = exactString(fn.args[1], ruleNameToIndex);
  return field && literal !== undefined ? { kind: 'exact-substring', field, literal } : undefined;
}

function parenthesizedLogical(
  logical: ParserRuleContext,
  ruleNameToIndex: RuleNameToIndex
): ParserRuleContext | undefined {
  const text = logical.getText();
  if (!text.startsWith('(') || !text.endsWith(')')) {
    return undefined;
  }
  const inner = text.slice(1, -1);
  return findAllDescendantsByRule(logical, ruleNameToIndex, 'logicalExpression').find(
    (candidate) => candidate.getText() === inner
  );
}

function evaluateRequiredPredicate<T>(
  logical: ParserRuleContext,
  ruleNameToIndex: RuleNameToIndex,
  atom: (node: ParserRuleContext) => T | undefined
): T | undefined {
  const children = findAllChildrenByRule(logical, ruleNameToIndex, 'logicalExpression');
  if (directTerminal(logical, 'NOT') || directTerminal(logical, 'XOR')) {
    return undefined;
  }
  if (directTerminal(logical, 'OR')) {
    const matches = children.map((child) =>
      evaluateRequiredPredicate(child, ruleNameToIndex, atom)
    );
    return matches.length > 0 && matches.every((match) => match !== undefined)
      ? matches[0]
      : undefined;
  }
  if (directTerminal(logical, 'AND') || children.length >= 2) {
    for (const child of children) {
      const match = evaluateRequiredPredicate(child, ruleNameToIndex, atom);
      if (match !== undefined) {
        return match;
      }
    }
    return undefined;
  }
  const nested = parenthesizedLogical(logical, ruleNameToIndex);
  return nested ? evaluateRequiredPredicate(nested, ruleNameToIndex, atom) : atom(logical);
}

function whereLogical(
  where: ParserRuleContext,
  ruleNameToIndex: RuleNameToIndex
): ParserRuleContext | undefined {
  return findChildByRule(where, ruleNameToIndex, 'logicalExpression');
}

function recognizeWhere(
  where: ParserRuleContext,
  spec: ExtractionPrefilterSpec,
  ruleNameToIndex: RuleNameToIndex
): RecognizedPrefilter | undefined {
  const logical = whereLogical(where, ruleNameToIndex);
  if (!logical) {
    return undefined;
  }
  const substringPattern = exactSubstringPattern(spec);
  const match = evaluateRequiredPredicate(logical, ruleNameToIndex, (node) => {
    const candidate = readAtomicPrefilter(node, ruleNameToIndex);
    if (!candidate || candidate.field !== canonicalField(spec.field)) {
      return undefined;
    }
    if (candidate.kind === 'match-phrase' && candidate.literal === spec.token) {
      return candidate;
    }
    return candidate.kind === 'exact-substring' &&
      substringPattern !== undefined &&
      candidate.literal === substringPattern
      ? candidate
      : undefined;
  });
  return match ? { ...match, where } : undefined;
}

const SOURCE_FIELD_PRESERVING_STAGES = new Set([
  'searchCommand',
  'whereCommand',
  'sortCommand',
  'headCommand',
  'dedupCommand',
  'reverseCommand',
  'regexCommand',
]);

function stageMayChangeSourceField(
  stage: PipelineStage,
  sourceField: string,
  ruleNameToIndex: RuleNameToIndex
): boolean {
  if (stage.command === 'evalCommand') {
    return findAllDescendantsByRule(stage.node, ruleNameToIndex, 'evalClause').some((clause) => {
      const target = findChildByRule(clause, ruleNameToIndex, 'fieldExpression');
      return (
        target !== undefined && canonicalField(target.getText()) === canonicalField(sourceField)
      );
    });
  }
  if (
    stage.command === 'rexCommand' ||
    stage.command === 'parseCommand' ||
    stage.command === 'grokCommand'
  ) {
    if (stage.command === 'rexCommand') {
      const target = extractionTargetForNode(stage.node, ruleNameToIndex);
      const rewritesSource =
        target !== undefined &&
        canonicalField(target.field) === canonicalField(sourceField) &&
        findAllDescendantsByRule(stage.node, ruleNameToIndex, 'rexOption').some((option) =>
          directTerminal(option, 'SED')
        );
      if (rewritesSource) {
        return true;
      }
    }
    return extractionOutputFields(stage.node, ruleNameToIndex).has(canonicalField(sourceField));
  }
  // Any other recognized stage can create, replace, remove, or introduce rows
  // that did not pass an earlier prefilter (for example stats, append, join,
  // lookup, rename, or field-producing commands). Stop rather than attributing
  // that prefilter to a different source-field value.
  return !SOURCE_FIELD_PRESERVING_STAGES.has(stage.command);
}

export function findRecognizedPrefilter(
  tree: ParserRuleContext,
  spec: ExtractionPrefilterSpec,
  ruleNameToIndex: RuleNameToIndex
): RecognizedPrefilter | undefined {
  const stages = getPipelineStagesForCommand(tree, spec.extraction, ruleNameToIndex);
  const extractionIndex = stages.findIndex((stage) => stage.node === spec.extraction);
  for (let index = extractionIndex - 1; index >= 0; index--) {
    const stage = stages[index];
    if (stageMayChangeSourceField(stage, spec.field, ruleNameToIndex)) {
      break;
    }
    if (stage.command === 'whereCommand') {
      const recognized = recognizeWhere(stage.node, spec, ruleNameToIndex);
      if (recognized) {
        return recognized;
      }
    }
  }
  return undefined;
}

function readComparisonCapture(
  logical: ParserRuleContext,
  captures: Set<string>,
  ruleNameToIndex: RuleNameToIndex
): string | undefined {
  for (const operator of findAllDescendantsByRule(logical, ruleNameToIndex, 'comparisonOperator')) {
    const comparison = operator.parent;
    if (!comparison || !isRuleNode(comparison) || !sameSpan(logical, comparison)) {
      continue;
    }
    for (const child of comparison.children ?? []) {
      if (!isRuleNode(child) || child === operator) {
        continue;
      }
      const field = exactField(child, ruleNameToIndex);
      if (field && captures.has(field)) {
        return field;
      }
    }
  }
  return undefined;
}

function nullRejectingCapture(
  where: ParserRuleContext,
  captures: Set<string>,
  ruleNameToIndex: RuleNameToIndex
): string | undefined {
  const logical = whereLogical(where, ruleNameToIndex);
  if (!logical) {
    return undefined;
  }
  return evaluateRequiredPredicate(logical, ruleNameToIndex, (node) => {
    const comparison = readComparisonCapture(node, captures, ruleNameToIndex);
    if (comparison) {
      return comparison;
    }
    const fn = readAtomicFunction(node, ruleNameToIndex);
    if (!fn || (fn.name !== 'ISNOTNULL' && fn.name !== 'LIKE') || fn.args.length === 0) {
      return undefined;
    }
    const field = exactField(fn.args[0], ruleNameToIndex);
    return field && captures.has(field) ? field : undefined;
  });
}

export function proveSafePrefilterInsertion(
  tree: ParserRuleContext,
  spec: ExtractionPrefilterSpec,
  ruleNameToIndex: RuleNameToIndex
): SafePrefilterInsertionProof | undefined {
  const pattern = exactSubstringPattern(spec);
  if (pattern === undefined || spec.captureFields.size === 0) {
    return undefined;
  }
  const stages = getPipelineStagesForCommand(tree, spec.extraction, ruleNameToIndex);
  const extractionIndex = stages.findIndex((stage) => stage.node === spec.extraction);
  const consumer = stages[extractionIndex + 1];
  if (!consumer || consumer.command !== 'whereCommand') {
    return undefined;
  }
  const captureField = nullRejectingCapture(consumer.node, spec.captureFields, ruleNameToIndex);
  return captureField ? { where: consumer.node, captureField, pattern } : undefined;
}

function atomicWherePrefilter(
  where: ParserRuleContext,
  ruleNameToIndex: RuleNameToIndex
): AtomicPrefilter | undefined {
  let logical = whereLogical(where, ruleNameToIndex);
  while (logical) {
    const children = findAllChildrenByRule(logical, ruleNameToIndex, 'logicalExpression');
    if (
      directTerminal(logical, 'NOT') ||
      directTerminal(logical, 'AND') ||
      directTerminal(logical, 'OR') ||
      directTerminal(logical, 'XOR') ||
      children.length >= 2
    ) {
      return undefined;
    }
    const nested = parenthesizedLogical(logical, ruleNameToIndex);
    if (!nested) {
      return readAtomicPrefilter(logical, ruleNameToIndex);
    }
    logical = nested;
  }
  return undefined;
}

function stageTextEqual(left: PipelineStage, right: PipelineStage): boolean {
  return left.command === right.command && left.node.getText() === right.node.getText();
}

interface AddedWhereMatch {
  candidateIndex: number;
  originalStages: PipelineStage[];
  candidateStages: PipelineStage[];
}

function findSingleAddedWhere(
  originalTree: ParserRuleContext,
  candidateTree: ParserRuleContext,
  ruleNameToIndex: RuleNameToIndex
): AddedWhereMatch | undefined {
  const originalStages = buildPipelineShape(originalTree, ruleNameToIndex).stages;
  const candidateStages = buildPipelineShape(candidateTree, ruleNameToIndex).stages;
  if (candidateStages.length !== originalStages.length + 1) {
    return undefined;
  }
  for (let extra = 0; extra < candidateStages.length; extra++) {
    if (candidateStages[extra].command !== 'whereCommand') {
      continue;
    }
    const unchanged = originalStages.every((stage, originalIndex) => {
      const candidateIndex = originalIndex < extra ? originalIndex : originalIndex + 1;
      return stageTextEqual(stage, candidateStages[candidateIndex]);
    });
    if (unchanged) {
      return { candidateIndex: extra, originalStages, candidateStages };
    }
  }
  return undefined;
}

export function validateRexPrefilterRewrite(
  originalTree: ParserRuleContext,
  candidateTree: ParserRuleContext,
  ruleNameToIndex: RuleNameToIndex
): RexPrefilterRewriteResult {
  const added = findSingleAddedWhere(originalTree, candidateTree, ruleNameToIndex);
  if (!added) {
    return { accepted: false, reason: 'multiple-command-changes' };
  }

  const inserted = added.candidateStages[added.candidateIndex];
  const branch = getPipelineStagesForCommand(candidateTree, inserted.node, ruleNameToIndex);
  const branchIndex = branch.findIndex((stage) => stage.node === inserted.node);
  const candidateExtractionStage = branch[branchIndex + 1];
  if (!candidateExtractionStage) {
    return { accepted: false, reason: 'prefilter-not-before-extraction' };
  }
  const candidateTarget = extractionTargetForNode(candidateExtractionStage.node, ruleNameToIndex);
  if (!candidateTarget) {
    return { accepted: false, reason: 'prefilter-not-before-extraction' };
  }

  const candidateGlobalIndex = added.candidateStages.findIndex(
    (stage) => stage.node === candidateExtractionStage.node
  );
  const originalIndex =
    candidateGlobalIndex < added.candidateIndex ? candidateGlobalIndex : candidateGlobalIndex - 1;
  const originalExtractionStage = added.originalStages[originalIndex];
  const originalTarget =
    originalExtractionStage &&
    extractionTargetForNode(originalExtractionStage.node, ruleNameToIndex);
  const spec = originalTarget && buildExtractionPrefilterSpec(originalTarget, ruleNameToIndex);
  if (!spec || exactSubstringPattern(spec) === undefined) {
    return { accepted: false, reason: 'unsafe-prefilter' };
  }

  const proposed = atomicWherePrefilter(inserted.node, ruleNameToIndex);
  if (!proposed || proposed.kind === 'match-phrase') {
    return { accepted: false, reason: 'unsafe-prefilter' };
  }
  if (proposed.field !== canonicalField(spec.field)) {
    return { accepted: false, reason: 'nonmatching-prefilter-field' };
  }
  if (proposed.literal !== exactSubstringPattern(spec)) {
    return { accepted: false, reason: 'prefilter-not-exact-substring' };
  }
  if (!proveSafePrefilterInsertion(originalTree, spec, ruleNameToIndex)) {
    return { accepted: false, reason: 'no-null-rejecting-consumer' };
  }
  return { accepted: true };
}
