/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * The Monaco command id the AI ("Ask Olly to fix") quick-fix dispatches.
 *
 * Isolated in its own tiny module so the code-action provider can reference the
 * id without importing `ai_fix_command.ts`, which transitively pulls in the
 * compiled grammar + analyzer (heavy, and unwanted in the provider's import
 * graph and unit tests).
 */
export const AI_FIX_COMMAND_ID = 'ppl.lint.aiFix';
