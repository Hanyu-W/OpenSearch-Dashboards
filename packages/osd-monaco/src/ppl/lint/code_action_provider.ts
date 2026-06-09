/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

import { monaco } from '../../monaco';
import { LINT_MARKER_SOURCE } from './diagnostic_to_marker';

/**
 * Code-action provider that surfaces quick-fixes for lint markers. It considers
 * only markers whose `source` is `ppl-lint` (R10.1) and, for each marker that
 * carries an available fix, returns a quick-fix code action with a workspace
 * edit (R10.2).
 *
 * v1 ships the provider plumbing; individual rules attach their fixes via the
 * marker `code`/`tags` channel. Markers without an associated fix yield no
 * action.
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

      const fix = (marker as monaco.editor.IMarkerData & {
        fix?: { title: string; text: string };
      }).fix;

      if (!fix) {
        continue;
      }

      actions.push({
        title: fix.title,
        diagnostics: [marker],
        kind: 'quickfix',
        edit: {
          edits: [
            {
              resource: model.uri,

              textEdit: {
                range: {
                  startLineNumber: marker.startLineNumber,
                  startColumn: marker.startColumn,
                  endLineNumber: marker.endLineNumber,
                  endColumn: marker.endColumn,
                },
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
