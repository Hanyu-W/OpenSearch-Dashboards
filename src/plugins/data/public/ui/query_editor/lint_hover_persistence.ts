/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

import { monaco } from '@osd/monaco';

/**
 * Keep the PPL lint hover card from vanishing the instant the pointer leaves it.
 *
 * Why this is needed. The query editors run with `fixedOverflowWidgets: true`
 * so the hover card is not clipped by the small query-box container — it renders
 * in Monaco's `.overflowingContentWidgets` node, which sits OUTSIDE the editor's
 * bounding rect. Monaco's content-hover widget attaches its own `mouseleave`
 * handler (`ContentHoverWidgetWrapper._onMouseLeave`) that hides the card
 * IMMEDIATELY whenever the pointer leaves the card and lands outside
 * `editor.getDomNode()`'s rect. Because the card floats outside that rect, the
 * ordinary gesture "move onto the card, then off it toward the page" satisfies
 * the "outside the editor" test and closes the card with no grace period —
 * making it hard to reach a doc link or the suggested-fix affordance on the
 * card. Neither `hover.sticky` nor `hover.hidingDelay` affects that path; the
 * hide there is unconditional.
 *
 * The fix. Intercept `mouseleave` on the overflow-widgets container in the
 * CAPTURE phase (so it runs before Monaco's own bubble-phase handler on the
 * card) and `stopImmediatePropagation()` it when it originates from the hover
 * card, replacing Monaco's instant hide with a short grace timer. Re-entering
 * the card cancels the timer (so it stays open while in use); otherwise, when
 * the timer elapses, we re-dispatch the same `mouseleave` to the card — this
 * second event is tagged so the capture guard lets it through to Monaco's own
 * handler, which then closes the card via its normal path. No private Monaco
 * internals are touched, so the fix stays correct across editor versions.
 */

/** Marker on the replayed event so the capture guard passes it to Monaco. */
const REPLAY_FLAG = '__pplHoverReplay';

export function attachPPLLintHoverPersistence(
  editor: monaco.editor.IStandaloneCodeEditor,
  // The grace window before a card the pointer has left is allowed to close.
  // Matches the editor's hover `hidingDelay` so the two hide paths feel the same.
  hideGraceMs = 600
): () => void {
  // Locate the container that actually holds overflowing content widgets (the
  // hover card). When no custom `overflowWidgetsDomNode` is configured — our
  // case — Monaco appends `.overflowingContentWidgets` directly under the
  // editor's root DOM node, and `getOverflowWidgetsDomNode()` returns undefined.
  // So resolve the node from the DOM rather than that accessor.
  const editorDom = editor.getDomNode();
  const overflowNode =
    (editor as {
      getOverflowWidgetsDomNode?: () => HTMLElement | undefined;
    }).getOverflowWidgetsDomNode?.() ??
    editorDom?.querySelector<HTMLElement>('.overflowingContentWidgets') ??
    undefined;
  if (!overflowNode) {
    // No overflow container (fixedOverflowWidgets off) — Monaco's default
    // behavior already keeps the card within the editor rect, so nothing to do.
    return () => {};
  }

  let hideTimer: ReturnType<typeof setTimeout> | undefined;

  const clearHideTimer = () => {
    if (hideTimer !== undefined) {
      clearTimeout(hideTimer);
      hideTimer = undefined;
    }
  };

  const hoverCardOf = (node: EventTarget | null): Element | null =>
    node instanceof Element ? node.closest('.monaco-hover') : null;

  const onCaptureMouseLeave = (event: MouseEvent) => {
    // The delayed replay (below) is tagged so it flows through to Monaco's own
    // handler and performs the real hide.
    if ((event as MouseEvent & { [REPLAY_FLAG]?: boolean })[REPLAY_FLAG]) {
      return;
    }
    const card = hoverCardOf(event.target);
    if (!card) {
      // Not the hover card (e.g. the suggestion list) — leave Monaco's other
      // overflow widgets to manage their own lifecycle.
      return;
    }
    // Suppress Monaco's instant-hide handler for this leave and hide on a grace
    // timer instead, so a pointer travelling off the card is not cut off.
    event.stopImmediatePropagation();
    clearHideTimer();
    hideTimer = setTimeout(() => {
      hideTimer = undefined;
      const replay = new MouseEvent('mouseleave', {
        bubbles: false,
        clientX: event.clientX,
        clientY: event.clientY,
      });
      (replay as MouseEvent & { [REPLAY_FLAG]?: boolean })[REPLAY_FLAG] = true;
      card.dispatchEvent(replay);
    }, hideGraceMs);
  };

  const onCaptureMouseEnter = (event: MouseEvent) => {
    // Moving back onto the card cancels a pending hide, so re-entering keeps it
    // open (matching sticky-hover expectations).
    if (hoverCardOf(event.target)) {
      clearHideTimer();
    }
  };

  overflowNode.addEventListener('mouseleave', onCaptureMouseLeave, true);
  overflowNode.addEventListener('mouseenter', onCaptureMouseEnter, true);

  return () => {
    clearHideTimer();
    overflowNode.removeEventListener('mouseleave', onCaptureMouseLeave, true);
    overflowNode.removeEventListener('mouseenter', onCaptureMouseEnter, true);
  };
}
