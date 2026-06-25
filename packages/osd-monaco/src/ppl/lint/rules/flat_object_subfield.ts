/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

import { Diagnostic } from '../diagnostic';
import { Detector } from '../types';
import { DOTTED_PATH_RULES, findAllDescendantsByRule } from '../rule_index';
import { rangeFromContext } from '../range_utils';

// Engine ground truth (live-verified 2026-06-25, OpenSearch 3.8 with Calcite on;
// see ppl-flat-object-engine-behavior.md): a `flat_object` field cannot be
// referenced in PPL at all. Both a dotted subfield (`attributes.http.method`)
// AND the bare root (`attributes`) raise `IllegalArgumentException: Field [...]
// not found.` Bare `source=t` (no projection) silently drops the column;
// `flatten`/`cast`/bracket access also fail. The data is reachable only at the
// DSL/document level, never through a PPL expression. The engine errors at run
// time — this rule surfaces it before Run, as an error. Self-suppresses without
// a typeMap.
//
// No quick-fix: there is no valid PPL rewrite target (verified — neither the
// root, a flatten, nor a cast works), so the rule is diagnostic-only.
//
// Earlier drafts flagged only the dotted subfield, on the assumption that
// `field-validation` already covers the bare root. It does not: field-validation
// stays silent because the root IS present in `_field_caps` (as a flat_object),
// so a bare `fields attributes` slips through both rules. This rule therefore
// flags the whole reference — dotted or not — whose root is a flat_object.
//
// Grammar anchor (both surfaces): field references parse to a `qualifiedName`
// (where/eval/by) or a `wcQualifiedName` (fields projection); both carry the
// full reference text.

const FLAT_OBJECT_TYPES: ReadonlySet<string> = new Set(['flat_object']);

export const flatObjectSubfieldDetector: Detector = (tree, config, context, ruleNameToIndex) => {
  const typeMap = context.typeMap;
  if (!typeMap) {
    return []; // self-suppress without type metadata
  }

  const diagnostics: Diagnostic[] = [];
  const seen = new Set<number>();

  for (const ruleName of DOTTED_PATH_RULES) {
    for (const node of findAllDescendantsByRule(tree, ruleNameToIndex, ruleName)) {
      const path = node.getText();
      // The root is the first dotted segment, or the whole text for a bare
      // reference — both forms are unqueryable for a flat_object.
      const dotIndex = path.indexOf('.');
      const root = dotIndex === -1 ? path : path.slice(0, dotIndex);
      const rootType = typeMap.get(root);
      if (rootType === undefined || !FLAT_OBJECT_TYPES.has(rootType)) {
        continue;
      }

      // Dedup by source position so a node reachable via more than one rule name
      // is reported once.
      const startIndex = node.start?.start ?? -1;
      if (seen.has(startIndex)) {
        continue;
      }
      seen.add(startIndex);

      const isSubfield = dotIndex !== -1;
      const message = isSubfield
        ? `Subfield "${path}" of flat_object field "${root}" cannot be queried in PPL; flat_object values are only retrievable at the document level, not addressable in a query.`
        : `flat_object field "${root}" cannot be referenced in a PPL expression; its values are only retrievable at the document level.`;

      diagnostics.push({
        ruleId: config.id,
        severity: config.severity,
        message,
        range: rangeFromContext(node),
        docUrl: config.docUrl,
        hoverFacts: { field: path, root, esType: rootType },
      });
    }
  }

  return diagnostics;
};
