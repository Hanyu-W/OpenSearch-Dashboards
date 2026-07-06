/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * PPL lint grammar-verification framework. Test-lane assets only — this module
 * adds no user-facing lint rules and is not re-exported from the osd-monaco
 * public barrels (it is consumed by Jest suites via relative imports).
 *
 * Design: `.kiro/specs/ppl-lint-grammar-verification/`.
 */

export * from './types';
export * from './report';
export * from './classification_manifest';
export * from './manifest_validation';
export * from './shape_assertions';
export * from './grammar_surface';
export * from './grammar_command_inventory';
export * from './silent_no_op_guard';
export * from './conformance_census';
export * from './shape_evaluator';
export * from './parser_adapter';
export * from './behavioral_corpus';
export * from './version_context_matrix';
export * from './generated_cases';
export * from './engine_facts_baseline';
export * from './metamorphic';
export * from './runtime_grammar_fixture';
export * from './run_verification';
export { LABELED_CASES, detectorBehaviorCaseCount } from './corpus/labeled_cases';
