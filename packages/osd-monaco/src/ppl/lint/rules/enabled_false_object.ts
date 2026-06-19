/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

import { Diagnostic } from '../diagnostic';
import { Detector } from '../types';
import { collectDottedPathNodes } from '../rule_index';
import { rangeFromContext } from '../range_utils';

// Engine ground truth (verified live, OpenSearch 3.7): a field inside an object
// mapped with `enabled: false` is not indexed. References to it return null with
// schema type `undefined` and HTTP 200 — a silent failure (contrast with
// flat_object subfields, which error loudly). The real value is never surfaced.
//
// `typeMap` cannot detect this: enabled:false fields are absent from
// `_field_caps`, which is where typeMap is built from. The host therefore
// supplies `disabledObjectFields` (the set of object field names mapped
// `enabled:false`), derived from a `_mappings` walk. Self-suppresses when that
// set is absent or empty.
//
// Grammar anchor (both surfaces): dotted references parse to a `qualifiedName`
// (where/eval/by) or a `wcQualifiedName` (fields projection); both carry the
// full dotted path as their text.

export const enabledFalseObjectDetector: Detector = (tree, config, context, ruleNameToIndex) => {
  const disabled = context.disabledObjectFields;
  if (!disabled || disabled.size === 0) {
    return []; // self-suppress without the disabled-object set
  }

  const diagnostics: Diagnostic[] = [];

  for (const node of collectDottedPathNodes(tree, ruleNameToIndex)) {
    const path = node.getText();
    const root = path.slice(0, path.indexOf('.'));
    if (!disabled.has(root)) {
      continue;
    }

    diagnostics.push({
      ruleId: config.id,
      severity: config.severity,
      message: `Field "${path}" lives inside object "${root}" mapped with enabled:false; it is not indexed and resolves to null.`,
      range: rangeFromContext(node),
      docUrl: config.docUrl,
      hoverFacts: { field: path, root },
    });
  }

  return diagnostics;
};
