/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

import type { monaco } from '@osd/monaco';

export type IEditorConstructionOptions = monaco.editor.IEditorConstructionOptions;

export const sharedEditorOptions: IEditorConstructionOptions = {
  minimap: { enabled: false },
  scrollBeyondLastLine: false,
  lineHeight: 18,
  fontSize: 12,
  cursorStyle: 'line-thin',
  wordWrap: 'on',
  lineDecorationsWidth: 0,
  renderLineHighlight: 'none',
  scrollbar: {
    vertical: 'visible',
    horizontalScrollbarSize: 1,
  },
  overviewRulerLanes: 0,
  hideCursorInOverviewRuler: true,
  fixedOverflowWidgets: true,
  // With `fixedOverflowWidgets`, the lint hover card renders in the
  // `.overflowingContentWidgets` container, which sits OUTSIDE the editor's
  // `.overflow-guard` (the node Monaco binds mouse-leave to). Monaco's mouse-
  // *move* handler applies a `hidingDelay` grace period so the pointer can
  // travel from the marker onto the card, but its mouse-*leave* handler has no
  // such grace — so once the pointer is on the card and then exits the query
  // box, the card is hidden instantly, reading as a flicker/disappear. `sticky`
  // (default true, set explicitly) keeps it open while the pointer is over it,
  // and a longer `hidingDelay` widens the grace window on the move path.
  hover: {
    sticky: true,
    hidingDelay: 600,
  },
};
