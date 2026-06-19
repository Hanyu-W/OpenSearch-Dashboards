/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

import { Diagnostic } from '../diagnostic';
import { Detector } from '../types';
import { collectDottedPathNodes } from '../rule_index';
import { rangeFromContext } from '../range_utils';

// Engine ground truth (verified live, OpenSearch 3.7): referencing a subfield of
// a `flat_object` field (e.g. `attributes.http.method` where `attributes` is
// flat_object) raises `IllegalArgumentException: Field [...] not found.` (HTTP
// 400). The engine errors loudly, but only at run time — this rule surfaces the
// problem before Run, as an error. Self-suppresses without a typeMap.
//
// The existing `field-validation` rule does NOT catch this: it validates the
// leading segment (`attributes`), which is a known field, and so stays silent.
//
// Grammar anchor (both surfaces): dotted references parse to a `qualifiedName`
// (where/eval/by) or a `wcQualifiedName` (fields projection); both carry the
// full dotted path as their text.

const FLAT_OBJECT_TYPES: ReadonlySet<string> = new Set(['flat_object']);

export const flatObjectSubfieldDetector: Detector = (tree, config, context, ruleNameToIndex) => {
  const typeMap = context.typeMap;
  if (!typeMap) {
    return []; // self-suppress without type metadata
  }

  const diagnostics: Diagnostic[] = [];

  for (const node of collectDottedPathNodes(tree, ruleNameToIndex)) {
    const path = node.getText();
    const root = path.slice(0, path.indexOf('.'));
    const rootType = typeMap.get(root);
    if (rootType === undefined || !FLAT_OBJECT_TYPES.has(rootType)) {
      continue;
    }

    diagnostics.push({
      ruleId: config.id,
      severity: config.severity,
      message: `Subfield "${path}" of flat_object field "${root}" is not queryable; the engine rejects it with "Field [${path}] not found".`,
      range: rangeFromContext(node),
      docUrl: config.docUrl,
      hoverFacts: { field: path, root, esType: rootType },
    });
  }

  return diagnostics;
};
