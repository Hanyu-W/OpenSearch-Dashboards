/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

import { monaco } from '../../monaco';
import { LINT_MARKER_SOURCE } from './diagnostic_to_marker';
import { getModelFix, markerFixKey } from './fix_registry';

/**
 * Code-action provider that surfaces quick-fixes for lint markers. It considers
 * only markers whose `source` is `ppl-lint` (R10.1) and, for each marker that
 * has an associated fix, returns a quick-fix code action with a workspace edit
 * (R10.2).
 *
 * The fix payload is NOT read off the marker: Monaco's MarkerService rebuilds
 * each marker from a fixed field list when `setModelMarkers` is called, dropping
 * any custom property, so a fix hung off the marker never survives to here.
 * Instead the lint lifecycle records fixes in a side table keyed by the marker
 * fields the service preserves (position + message); we re-associate them here.
 */
export const pplLintCodeActionProvider: monaco.languages.CodeActionProvider = {
  provideCodeActions(
    model: monaco.editor.ITextModel,
    _range: monaco.Range,
    context: monaco.languages.CodeActionContext
  ): monaco.languages.ProviderResult<monaco.languages.CodeActionList> {
    const actions: monaco.languages.CodeAction[] = [];

    for (const marker of context.markers) {
      if (marker.source !== LINT_MARKER_SOURCE) {
        continue;
      }

      const fix = getModelFix(model, markerFixKey(marker));

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
