/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

import type { ParserRuleContext } from 'antlr4ng';
import { Diagnostic } from '../diagnostic';
import { Detector } from '../types';
import { collectAlternateSourceSubtrees } from '../pipeline_shape';
import { rangeFromContext } from '../range_utils';
import {
  buildExtractionPrefilterSpec,
  canonicalField,
  collectExtractionTargets,
  exactSubstringWhereClause,
  findRecognizedPrefilter,
  proveSafePrefilterInsertion,
} from '../rex_prefilter';

// Advisory (no engine throw): `rex`, `parse`, and `grok` extract new fields by
// running a pattern over a source field for every input row. When that source
// field is a `text` mapping, the engine loads `_source`, decompresses, and
// evaluates the pattern per document — the dominant cost called out in the
// pattern-prefilter RFC (opensearch-project/sql#5608, perf idea #1). This rule
// surfaces that cost so a user can consider a selective prefilter or a
// purpose-built field.
//
// `rex`/`parse`/`grok` are row-preserving (planned as a Calcite Project, not a
// Filter), so a prefilter is normally advisory only: it deletes rows for which
// extraction would have produced null. A narrow automatic rewrite is eligible
// only when rex_prefilter proves that the immediately following WHERE already
// rejects every failed extraction and the proposed substring is required by
// every regex match.
//
// Grammar anchors:
//   rexCommand   : REX rexExpr
//   rexExpr      : FIELD EQUAL field=qualifiedName (rexOption)* pattern=stringLiteral (rexOption)*
//   grokCommand  : GROK (source_field = expression) (pattern = stringLiteral)
//   parseCommand : PARSE (source_field = expression) (pattern = stringLiteral)
// `rex` exists only on the simplified (compiled) surface; `parse`/`grok` exist on
// both. A command absent on the active surface resolves to -1 and no-ops.

// esTypes for which extraction incurs the analyzed-text scan cost this rule is
// about. `keyword` is deliberately excluded: its cost profile differs (whole-
// value, doc-values backed) and folding it in would dilute the message. See
// open question 2 in the design doc.
const TEXT_TYPES: ReadonlySet<string> = new Set(['text']);

function advisoryMessage(keyword: string, field: string): string {
  return `${keyword} runs the pattern against every input row from text field "${field}", even when it finds no match.`;
}

export const rexScanCostDetector: Detector = (tree, config, context, ruleNameToIndex) => {
  const typeMap = context.typeMap;
  if (!typeMap) {
    return []; // self-suppress without type metadata (Bucket-B)
  }

  // The outer index's typeMap does not apply inside lookup / append-with-source
  // / subsearch / join-right / union subtrees, so an extraction there could be
  // over a field of a different source. Prune those subtrees, mirroring
  // field-validation.
  const alternateSourceRoots = collectAlternateSourceSubtrees(tree, ruleNameToIndex);
  const isInsideAlternateSource = (node: ParserRuleContext): boolean => {
    for (let n: ParserRuleContext | null = node; n; n = n.parent as ParserRuleContext | null) {
      if (alternateSourceRoots.has(n)) {
        return true;
      }
    }
    return false;
  };

  const diagnostics: Diagnostic[] = [];

  for (const target of collectExtractionTargets(tree, ruleNameToIndex)) {
    if (isInsideAlternateSource(target.node)) {
      continue;
    }
    const esType = typeMap.get(target.field) ?? typeMap.get(canonicalField(target.field));
    if (esType === undefined || !TEXT_TYPES.has(esType)) {
      continue;
    }

    const spec = buildExtractionPrefilterSpec(target, ruleNameToIndex);
    if (spec && findRecognizedPrefilter(tree, spec, ruleNameToIndex)) {
      continue;
    }

    const proof = spec && proveSafePrefilterInsertion(tree, spec, ruleNameToIndex);
    const whereClause = spec && proof ? exactSubstringWhereClause(spec) : undefined;
    const message =
      proof !== undefined
        ? `${target.keyword} runs the pattern against every input row from text field ` +
          `"${target.field}". The later WHERE on "${proof.captureField}" drops nonmatches, so ` +
          `a literal prefilter is safe.`
        : advisoryMessage(target.keyword, target.field);

    diagnostics.push({
      ruleId: config.id,
      severity: config.severity,
      message,
      range: rangeFromContext(target.node),
      docUrl: config.docUrl,
      hoverFacts: { field: target.field, esType },
      aiFix: {
        eligible: proof !== undefined && whereClause !== undefined,
        ...(whereClause
          ? {
              instructions:
                `Insert exactly one \`${whereClause}\` stage immediately before the flagged ` +
                `${target.keyword} command. Do not use match_phrase. Keep every existing ` +
                `command and predicate unchanged.`,
            }
          : {}),
      },
    });
  }

  return diagnostics;
};
