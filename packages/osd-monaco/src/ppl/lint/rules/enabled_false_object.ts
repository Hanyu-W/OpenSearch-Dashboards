/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

import type { ParserRuleContext } from 'antlr4ng';
import { Diagnostic } from '../diagnostic';
import { Detector } from '../types';
import { findAllDescendantsByRule } from '../rule_index';
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

const FIELD_PATH_RULES = ['qualifiedName', 'wcQualifiedName'];

export const enabledFalseObjectDetector: Detector = (tree, config, context, ruleNameToIndex) => {
  const disabled = context.disabledObjectFields;
  if (!disabled || disabled.size === 0) {
    return []; // self-suppress without the disabled-object set
  }

  const diagnostics: Diagnostic[] = [];
  const seen = new Set<number>();

  const pathNodes: ParserRuleContext[] = [];
  for (const ruleName of FIELD_PATH_RULES) {
    pathNodes.push(...findAllDescendantsByRule(tree, ruleNameToIndex, ruleName));
  }

  for (const node of pathNodes) {
    const path = node.getText();
    const dot = path.indexOf('.');
    if (dot === -1) {
      continue; // a reference to the object itself is not the silent-null case
    }
    const root = path.slice(0, dot);
    if (!disabled.has(root)) {
      continue;
    }

    const startIndex = node.start?.start ?? -1;
    if (seen.has(startIndex)) {
      continue;
    }
    seen.add(startIndex);

    diagnostics.push({
      ruleId: config.id,
      severity: config.severity,
      message: `Field "${path}" lives inside object "${root}" mapped with enabled:false; it is not indexed and resolves to null.`,
      range: rangeFromContext(node),
      docUrl: config.docUrl,
    });
  }

  return diagnostics;
};
