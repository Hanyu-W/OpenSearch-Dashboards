/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

import { monaco } from '../../monaco';
import { LINT_MARKER_SOURCE, SYNTAX_MARKER_SOURCE } from './diagnostic_to_marker';
import { getModelFix, getModelSyntaxFix, markerFixKey } from './fix_registry';
import { getPPLLintContext } from '../lint_bridge';
import { isAiFixableRule } from './ai_fix/ai_fixable_rules';
import { AI_FIX_COMMAND_ID } from './ai_fix/ai_fix_command_id';

/**
 * The ruleId rides on a marker's `code`: the plain-string form (rule with no doc
 * link) or `code.value` (object form, with a link). Mirrors `ruleIdOf` in the
 * hover provider so the two read the marker identically.
 */
function ruleIdOf(marker: monaco.editor.IMarkerData): string | undefined {
  const code = (marker as { code?: string | { value?: string } }).code;
  if (typeof code === 'string') {
    return code;
  }
  if (code && typeof code === 'object' && typeof code.value === 'string') {
    return code.value;
  }
  return undefined;
}

/**
 * Code-action provider that surfaces quick-fixes for PPL markers on two
 * channels: lint diagnostics (`ppl-lint`, owner PPL_LINT) and syntax errors
 * (`ppl-syntax`, owner PPL_WORKER — e.g. the command-typo suggestion). For each
 * marker with an associated fix it returns a quick-fix code action with a
 * workspace edit (R10.2). Markers from any other source are ignored (R10.1).
 *
 * The fix payload is NOT read off the marker: Monaco's MarkerService rebuilds
 * each marker from a fixed field list when `setModelMarkers` is called, dropping
 * any custom property, so a fix hung off the marker never survives to here.
 * Instead each lifecycle records fixes in a side table keyed by the marker
 * fields the service preserves (position + message); we re-associate them here,
 * reading the table that matches the marker's source.
 */
export const pplLintCodeActionProvider: monaco.languages.CodeActionProvider = {
  provideCodeActions(
    model: monaco.editor.ITextModel,
    _range: monaco.Range,
    context: monaco.languages.CodeActionContext
  ): monaco.languages.ProviderResult<monaco.languages.CodeActionList> {
    const actions: monaco.languages.CodeAction[] = [];

    // The AI quick-fix is offered only when AI features are on AND the active
    // dataset's index (datasetTitle) is known — both read from the per-model
    // lint context. Computed once per provider call. The live agent-probe is
    // deferred to the command handler (it is async and may degrade to a no-op
    // when no ML-Commons agent is configured), so the lightbulb appears
    // instantly and only does the round-trip after the user clicks.
    const lintCtx = getPPLLintContext(model);
    const aiFixAvailable = lintCtx?.enableAIFeatures !== false && !!lintCtx?.datasetTitle;

    for (const marker of context.markers) {
      const key = markerFixKey(marker);
      let fix;
      if (marker.source === LINT_MARKER_SOURCE) {
        fix = getModelFix(model, key);
      } else if (marker.source === SYNTAX_MARKER_SOURCE) {
        fix = getModelSyntaxFix(model, key);
      } else {
        continue;
      }

      // Deterministic-first: a lint marker with no deterministic fix but an
      // AI-fixable ruleId gets an "✨ Ask Olly to fix" action that dispatches a
      // command (async LLM round-trip after the click), distinct from the
      // synchronous edit-carrying quick-fixes below. Never offered on the syntax
      // channel and never when a deterministic fix already exists for the marker.
      if (marker.source === LINT_MARKER_SOURCE && !fix && aiFixAvailable) {
        const ruleId = ruleIdOf(marker);
        if (isAiFixableRule(ruleId)) {
          actions.push({
            title: '✨ Ask Olly to fix this',
            diagnostics: [marker],
            kind: 'quickfix',
            isAI: true,
            command: {
              id: AI_FIX_COMMAND_ID,
              title: 'Ask Olly to fix this',
              arguments: [
                {
                  modelUri: model.uri.toString(),
                  ruleId,
                  message: marker.message,
                },
              ],
            },
          } as monaco.languages.CodeAction);
        }
      }

      if (!fix) {
        continue;
      }

      // Use the fix's own range when it targets a span different from the
      // squiggle (e.g. deleting one character before the underlined name);
      // otherwise replace the marker's range.
      const editRange = fix.range ?? {
        startLineNumber: marker.startLineNumber,
        startColumn: marker.startColumn,
        endLineNumber: marker.endLineNumber,
        endColumn: marker.endColumn,
      };

      actions.push({
        title: fix.title,
        diagnostics: [marker],
        kind: 'quickfix',
        edit: {
          edits: [
            {
              resource: model.uri,

              textEdit: {
                range: editRange,
                text: fix.text,
              },
              versionId: model.getVersionId(),
            } as any,
          ],
        },
      });
    }

    return {
      actions,
      dispose: () => {},
    };
  },
};
