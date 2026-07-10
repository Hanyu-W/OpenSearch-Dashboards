/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

import { attachPPLLintHoverPersistence } from './lint_hover_persistence';

// Only the DOM accessors this utility touches are needed from the editor.
jest.mock('@osd/monaco', () => ({}));

/**
 * Build a fake editor whose DOM mirrors the real layout: a root `.monaco-editor`
 * node that contains the `.overflowingContentWidgets` overflow container (where
 * the hover card renders under `fixedOverflowWidgets`).
 */
function makeEditor() {
  const root = document.createElement('div');
  root.className = 'monaco-editor';
  const overflow = document.createElement('div');
  overflow.className = 'overflowingContentWidgets';
  root.appendChild(overflow);
  document.body.appendChild(root);

  const editor = {
    getDomNode: () => root,
    // Mirror Monaco's default: no custom overflow node configured.
    getOverflowWidgetsDomNode: () => undefined,
  } as any;

  return { editor, root, overflow };
}

/** Add a hover card to the overflow container plus a Monaco-style hide listener. */
function addHoverCard(overflow: HTMLElement) {
  const card = document.createElement('div');
  card.className = 'monaco-hover';
  overflow.appendChild(card);
  const hide = jest.fn();
  // Monaco registers its own bubble-phase mouseleave that hides the card.
  card.addEventListener('mouseleave', hide, false);
  return { card, hide };
}

const leave = (el: HTMLElement) =>
  el.dispatchEvent(new MouseEvent('mouseleave', { bubbles: false }));
const enter = (el: HTMLElement) =>
  el.dispatchEvent(new MouseEvent('mouseenter', { bubbles: false }));

describe('attachPPLLintHoverPersistence', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    document.body.innerHTML = '';
  });
  afterEach(() => {
    jest.useRealTimers();
  });

  it('suppresses Monaco’s instant hide when the pointer leaves the card', () => {
    const { editor, overflow } = makeEditor();
    const detach = attachPPLLintHoverPersistence(editor);
    const { card, hide } = addHoverCard(overflow);

    leave(card);

    // The guard stopped Monaco’s bubble-phase handler for this leave.
    expect(hide).not.toHaveBeenCalled();
    detach();
  });

  it('hides after the grace window when the pointer does not return', () => {
    const { editor, overflow } = makeEditor();
    const detach = attachPPLLintHoverPersistence(editor, 600);
    const { card, hide } = addHoverCard(overflow);

    leave(card);
    expect(hide).not.toHaveBeenCalled();

    jest.advanceTimersByTime(600);

    // The replayed (tagged) mouseleave is let through to Monaco’s handler.
    expect(hide).toHaveBeenCalledTimes(1);
    detach();
  });

  it('cancels the pending hide when the pointer returns to the card', () => {
    const { editor, overflow } = makeEditor();
    const detach = attachPPLLintHoverPersistence(editor, 600);
    const { card, hide } = addHoverCard(overflow);

    leave(card);
    enter(card); // back on the card before the grace elapses
    jest.advanceTimersByTime(600);

    expect(hide).not.toHaveBeenCalled();
    detach();
  });

  it('does not guard leaves from non-hover overflow widgets (e.g. suggestions)', () => {
    const { editor, overflow } = makeEditor();
    const detach = attachPPLLintHoverPersistence(editor);
    const suggest = document.createElement('div');
    suggest.className = 'suggest-widget';
    overflow.appendChild(suggest);
    const hide = jest.fn();
    suggest.addEventListener('mouseleave', hide, false);

    leave(suggest);

    // Not a `.monaco-hover` — Monaco’s own handler is left to run.
    expect(hide).toHaveBeenCalledTimes(1);
    detach();
  });

  it('detaches cleanly: no guarding after teardown', () => {
    const { editor, overflow } = makeEditor();
    const detach = attachPPLLintHoverPersistence(editor);
    const { card, hide } = addHoverCard(overflow);

    detach();
    leave(card);

    // With the guard removed, Monaco’s instant hide runs as normal.
    expect(hide).toHaveBeenCalledTimes(1);
  });

  it('is a no-op when there is no overflow container', () => {
    const root = document.createElement('div');
    root.className = 'monaco-editor';
    document.body.appendChild(root);
    const editor = {
      getDomNode: () => root,
      getOverflowWidgetsDomNode: () => undefined,
    } as any;

    // Should not throw and should return a callable disposer.
    const detach = attachPPLLintHoverPersistence(editor);
    expect(typeof detach).toBe('function');
    detach();
  });
});
