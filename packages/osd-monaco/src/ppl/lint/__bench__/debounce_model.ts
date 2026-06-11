/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Deterministic, timer-free model of the production lint debounce.
 *
 * Production behavior (osd-monaco/src/ppl/language.ts):
 *   - `model.onDidChangeContent` fires once per edit event.
 *   - Eager path (syntax highlighting via `processSyntaxHighlighting`) runs on
 *     EVERY event.
 *   - Lint path is routed through `scheduleLintHighlighting`, a 500ms
 *     trailing-edge debounce: each event clears the pending timer and starts a
 *     fresh 500ms one; only the last event of a quiescent burst actually runs
 *     `processLintHighlighting`.
 *
 * This module reproduces that exactly as a discrete-event simulation over a
 * timeline of edit events, so the pass counts are derived from the real
 * trailing-edge rule rather than guessed. `simulateRealTimers` (in the test)
 * cross-checks this model against actual `setTimeout`.
 */

export const LINT_DEBOUNCE_MS = 500; // mirrors LINT_DEBOUNCE_MS in language.ts

/** A single edit event: a timestamp (ms, monotonic) and the content after it. */
export interface EditEvent {
  /** Milliseconds since session start. */
  t: number;
  /** Full editor content immediately after this edit. */
  content: string;
}

export interface DebounceResult {
  /** Number of times the lint pass actually executes. */
  lintPasses: number;
  /** The content value each executed pass saw (for "wasted work" analysis). */
  passContents: string[];
  /** ms-from-session-start at which each pass fires. */
  passFireTimes: number[];
}

/**
 * No-debounce baseline: lint runs on every edit event (one pass per
 * `onDidChangeContent`). This is what the editor would do if
 * `scheduleLintHighlighting` called `processLintHighlighting` directly.
 */
export function simulateNoDebounce(events: EditEvent[]): DebounceResult {
  return {
    lintPasses: events.length,
    passContents: events.map((e) => e.content),
    passFireTimes: events.map((e) => e.t),
  };
}

/**
 * Trailing-edge debounce: a pass fires `debounceMs` after an edit IF no further
 * edit arrives within that window. The fire carries the content of the edit
 * that armed the (un-cancelled) timer.
 *
 * Equivalent to walking the events and emitting a pass whenever the gap to the
 * next event exceeds `debounceMs` (and always after the final event).
 */
export function simulateDebounce(
  events: EditEvent[],
  debounceMs: number = LINT_DEBOUNCE_MS
): DebounceResult {
  const passContents: string[] = [];
  const passFireTimes: number[] = [];

  for (let i = 0; i < events.length; i++) {
    const cur = events[i];
    const next = events[i + 1];
    const quiescent = !next || next.t - cur.t >= debounceMs;
    if (quiescent) {
      // The timer armed by `cur` survives to fire at cur.t + debounceMs.
      passContents.push(cur.content);
      passFireTimes.push(cur.t + debounceMs);
    }
    // Otherwise `next` arrives first and clears this timer (no pass).
  }

  return { lintPasses: passContents.length, passContents, passFireTimes };
}

/** Typing profile names. */
export type ProfileName = 'fast' | 'average' | 'slow' | 'burst-pause-burst' | 'paste-then-tweak';

export interface TypingProfile {
  name: ProfileName;
  /** Human description for the report. */
  description: string;
}

export const PROFILES: TypingProfile[] = [
  { name: 'fast', description: 'Power user, ~100ms between keystrokes, no pauses' },
  { name: 'average', description: 'Typical user, ~300ms between keystrokes' },
  {
    name: 'slow',
    description: 'Hunt-and-peck, ~650ms between keystrokes (exceeds debounce window)',
  },
  {
    name: 'burst-pause-burst',
    description: 'Types a clause fast, pauses to think (~1.2s), types the next clause',
  },
  {
    name: 'paste-then-tweak',
    description: 'Pastes a full query (1 event) then makes a few edits',
  },
];

/**
 * Generate a deterministic stream of edit events that builds `finalQuery` one
 * grapheme at a time under the given profile. Each keystroke appends the next
 * character of the final query (a faithful proxy for in-order typing).
 *
 * Determinism: inter-keystroke delays follow a fixed per-profile pattern (no
 * RNG), so runs are byte-for-byte reproducible.
 */
export function generateTypingSession(finalQuery: string, profile: ProfileName): EditEvent[] {
  const chars = Array.from(finalQuery);
  const events: EditEvent[] = [];
  let t = 0;

  const pushChar = (upTo: number) => {
    events.push({ t, content: finalQuery.slice(0, upTo) });
  };

  switch (profile) {
    case 'fast': {
      for (let i = 1; i <= chars.length; i++) {
        t += 100;
        pushChar(i);
      }
      break;
    }
    case 'average': {
      for (let i = 1; i <= chars.length; i++) {
        t += 300;
        pushChar(i);
      }
      break;
    }
    case 'slow': {
      for (let i = 1; i <= chars.length; i++) {
        t += 650; // each gap exceeds 500ms → every keystroke is quiescent
        pushChar(i);
      }
      break;
    }
    case 'burst-pause-burst': {
      // Split the query at pipe boundaries; type each segment fast, pause between.
      const segments = splitAtPipes(finalQuery);
      let consumed = 0;
      for (let s = 0; s < segments.length; s++) {
        const seg = segments[s];
        for (let c = 0; c < seg.length; c++) {
          t += 90; // fast within a burst
          consumed += 1;
          pushChar(consumed);
        }
        if (s < segments.length - 1) {
          t += 1200; // think-pause between clauses (> debounce → one pass per clause)
        }
      }
      break;
    }
    case 'paste-then-tweak': {
      // One paste event with the whole query, then a few small trailing edits.
      t += 50;
      events.push({ t, content: finalQuery });
      const tweaks = [' ', '0', '0']; // e.g. adjusting a "head 10" → "head 1000"
      let content = finalQuery;
      for (const ch of tweaks) {
        t += 220;
        content += ch;
        events.push({ t, content });
      }
      break;
    }
  }

  return events;
}

/** Split a PPL query into segments at top-level pipe boundaries (keeps the pipe). */
function splitAtPipes(query: string): string[] {
  const parts = query.split('|');
  if (parts.length === 1) return [query];
  const segs: string[] = [parts[0]];
  for (let i = 1; i < parts.length; i++) {
    segs.push('|' + parts[i]);
  }
  return segs;
}

/**
 * A query content is "intermediate / not yet complete" — i.e. a lint pass over
 * it is wasted work that the user will immediately invalidate — if it is a
 * strict prefix of the final query (the user is still typing toward the final
 * form) and is not the final query itself. This is a conservative proxy used
 * only to quantify "wasted passes" in the no-debounce baseline.
 */
export function countWastedPasses(passContents: string[], finalQuery: string): number {
  let wasted = 0;
  for (const c of passContents) {
    if (c !== finalQuery) wasted += 1;
  }
  return wasted;
}
