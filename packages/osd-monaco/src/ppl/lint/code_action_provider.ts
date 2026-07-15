/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

import { monaco } from '../../monaco';
import { LINT_MARKER_SOURCE, SYNTAX_MARKER_SOURCE, ruleIdOf } from './diagnostic_to_marker';
import { getModelFix, getModelSyntaxFix, markerFixKey } from './fix_registry';
import { getPPLLintContext } from '../lint_bridge';
import { AI_FIX_COMMAND_ID } from './ai_fix/ai_fix_command_id';
import { getModelHoverFacts } from './hover/hover_registry';

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

    // The AI quick-fix is offered only when AI features are on and the host has
    // wired the AI chat opener/apply-tool flow. Computed once per provider
    // call so the lightbulb and hover card share the same availability rule.
    const lintCtx = getPPLLintContext(model);
    const aiFixAvailable = lintCtx?.enableAIFeatures !== false && !!lintCtx?.onAskAiFix;

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

      const markerRange = {
        startLineNumber: marker.startLineNumber,
        startColumn: marker.startColumn,
        endLineNumber: marker.endLineNumber,
        endColumn: marker.endColumn,
      };
      const editRange = fix?.range ?? markerRange;
      if (
        fix?.expectedText !== undefined &&
        model.getValueInRange(editRange) !== fix.expectedText
      ) {
        // The model changed after linting. Do not offer either the stale edit or
        // an AI action associated with the stale marker.
        continue;
      }

      // Deterministic-first, AI-as-fallback: ANY lint marker with no deterministic
      // fix gets an "✨ Ask AI to fix" action that dispatches a command (async LLM
      // round-trip after the click), distinct from the synchronous edit-carrying
      // quick-fixes below. The trigger is purely "this marker has no template fix"
      // — no per-rule allowlist — because whether a fix exists is decided per
      // marker, not per rule: e.g. field-validation ships a fix only when a near
      // field is found, and invalid-capture-group-name only when sanitizing yields
      // a valid name; the no-fix instances of those rules should still offer AI.
      // Never on the syntax channel; never when a deterministic fix already exists.
      // For the rare rule with no valid PPL fix at all (e.g. flat-object-subfield),
      // the action still shows but the apply tool's re-validation rejects the
      // candidate, surfacing an honest "couldn't produce a safe fix" rather than a
      // silently missing option.
      if (marker.source === LINT_MARKER_SOURCE && !fix && aiFixAvailable) {
        const ruleId = ruleIdOf(marker);
        const facts = getModelHoverFacts(model, key);
        const operation = facts?.operation;
        const outcome =
          operation && ruleId === 'operation-pushed-as-script'
            ? `${operation}:script`
            : operation && ruleId === 'operation-not-pushed'
            ? `${operation}:coordinator`
            : undefined;
        const relatedTexts = marker.relatedInformation
          ?.filter((related) => related.resource.toString() === model.uri.toString())
          .map((related) =>
            model.getValueInRange({
              startLineNumber: related.startLineNumber,
              startColumn: related.startColumn,
              endLineNumber: related.endLineNumber,
              endColumn: related.endColumn,
            })
          );
        actions.push({
          title: '✨ Ask AI to fix this',
          diagnostics: [marker],
          kind: 'quickfix',
          isAI: true,
          command: {
            id: AI_FIX_COMMAND_ID,
            title: 'Ask AI to fix this',
            arguments: [
              {
                modelUri: model.uri.toString(),
                ruleId,
                message: marker.message,
                operation,
                outcome,
                targetText: model.getValueInRange(markerRange),
                targetRange: {
                  startOffset: model.getOffsetAt({
                    lineNumber: markerRange.startLineNumber,
                    column: markerRange.startColumn,
                  }),
                  endOffset: model.getOffsetAt({
                    lineNumber: markerRange.endLineNumber,
                    column: markerRange.endColumn,
                  }),
                },
                relatedTexts,
              },
            ],
          },
        } as monaco.languages.CodeAction);
      }

      if (!fix) {
        continue;
      }

      // Use the fix's own range when it targets a span different from the
      // squiggle (e.g. deleting one character before the underlined name);
      // otherwise replace the marker's range.
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
