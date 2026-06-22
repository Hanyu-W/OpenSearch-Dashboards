/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  IntervalSet,
  Parser,
  RecognitionException,
  Recognizer,
  Token,
  ATNSimulator,
} from 'antlr4ng';

/**
 * Curated baseline of PPL command keyword symbolic name -> lowercase spelling.
 * No longer load-bearing for suggestion logic (candidates come from the ATN);
 * kept as the grammar-guard test's coverage baseline and `suggestCommand`
 * fixture data. A superset spanning both the compiled and server grammars.
 */
export const PPL_COMMAND_KEYWORDS: ReadonlyMap<string, string> = new Map<string, string>([
  // Leading commands (statement position).
  ['SEARCH', 'search'],
  ['DESCRIBE', 'describe'],
  ['SHOW', 'show'],
  ['EXPLAIN', 'explain'],
  // Piped commands (post-`|` position).
  ['WHERE', 'where'],
  ['FIELDS', 'fields'],
  ['TABLE', 'table'],
  ['RENAME', 'rename'],
  ['STATS', 'stats'],
  ['EVENTSTATS', 'eventstats'],
  ['DEDUP', 'dedup'],
  ['SORT', 'sort'],
  ['EVAL', 'eval'],
  ['HEAD', 'head'],
  ['BIN', 'bin'],
  ['TOP', 'top'],
  ['RARE', 'rare'],
  ['PARSE', 'parse'],
  ['SPATH', 'spath'],
  ['REGEX', 'regex'],
  ['REX', 'rex'],
  ['GROK', 'grok'],
  ['PATTERNS', 'patterns'],
  ['KMEANS', 'kmeans'],
  ['AD', 'ad'],
  ['ML', 'ml'],
  ['FILLNULL', 'fillnull'],
  ['FLATTEN', 'flatten'],
  ['EXPAND', 'expand'],
  ['TRENDLINE', 'trendline'],
  ['TIMECHART', 'timechart'],
  ['APPENDCOL', 'appendcol'],
  ['APPEND', 'append'],
  ['JOIN', 'join'],
  ['LOOKUP', 'lookup'],
  ['REVERSE', 'reverse'],
  ['REPLACE', 'replace'],
  // Server-grammar / future command keywords; harmless when absent from a surface.
  ['MULTISEARCH', 'multisearch'],
  ['UNION', 'union'],
]);

/** A confident, structured command-typo correction that drives a Monaco quick-fix. */
export interface CommandSuggestion {
  /** Stable machine-readable identity, independent of the prose. */
  code: 'UNKNOWN_COMMAND';
  /** The misspelled token as typed, e.g. `wherre`. */
  typed: string;
  /** The nearest known command, e.g. `where`. */
  suggestion: string;
  /** Composed user-facing message; reconstructible from the parts. */
  message: string;
  /** Deterministic correction the marker builder turns into a lightbulb. */
  fix: { title: string; text: string };
}

/**
 * Largest expected-token set treated as a "command position"; larger sets are
 * low-signal (a dangling expression) where a command typo is implausible.
 * Measured on both surfaces: command positions are 40 (simplified) / 101
 * (server); dangling expressions are 270-499. 150 sits in the gap with headroom.
 */
const MAX_COMMAND_CANDIDATES = 150;

/**
 * Optimal String Alignment (Damerau-Levenshtein restricted to adjacent
 * transpositions), so a transposition typo costs 1 edit. Returns early with a
 * value `> maxDistance` once an entire row exceeds the bound.
 */
export function damerauLevenshtein(a: string, b: string, maxDistance: number): number {
  const m = a.length;
  const n = b.length;
  if (m === 0) return n;
  if (n === 0) return m;
  // Three rolling rows: two-back (for transpositions), one-back, current.
  let prevPrev = new Array<number>(n + 1).fill(0);
  let prev = new Array<number>(n + 1);
  let curr = new Array<number>(n + 1);
  for (let j = 0; j <= n; j++) prev[j] = j;
  for (let i = 1; i <= m; i++) {
    curr[0] = i;
    let rowMin = curr[0];
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      let val = Math.min(prev[j] + 1, curr[j - 1] + 1, prev[j - 1] + cost);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) {
        val = Math.min(val, prevPrev[j - 2] + 1);
      }
      curr[j] = val;
      if (val < rowMin) rowMin = val;
    }
    if (rowMin > maxDistance) {
      return maxDistance + 1;
    }
    const spare = prevPrev;
    prevPrev = prev;
    prev = curr;
    curr = spare;
  }
  return prev[n];
}

/**
 * Nearest command spelling to `typed` within an edit-distance threshold (1 for
 * short names, 2 for >= 8 chars), or undefined when none is close enough.
 */
export function suggestCommand(typed: string, candidates: Iterable<string>): string | undefined {
  const lower = typed.toLowerCase();
  const threshold = lower.length >= 8 ? 2 : 1;
  let best: string | undefined;
  let bestDistance = Infinity;
  for (const candidate of candidates) {
    if (Math.abs(candidate.length - lower.length) > threshold) {
      continue;
    }
    const distance = damerauLevenshtein(lower, candidate, threshold);
    if (distance < bestDistance) {
      bestDistance = distance;
      best = candidate;
      // Safe to stop at 1 here: callers only invoke this for a token already
      // known NOT to be a valid command, so distance 0 never occurs.
      if (bestDistance === 1) {
        break;
      }
    }
  }
  return best && bestDistance <= threshold ? best : undefined;
}

/** Only word-shaped tokens can be command typos (rules out pipes, numbers, EOF). */
const IDENTIFIER_RE = /^[A-Za-z][A-Za-z0-9_]*$/;

/** A keyword-shaped symbolic name: all uppercase letters/digits (`WHERE`, `EVENTSTATS`). */
const KEYWORD_SYMBOLIC_RE = /^[A-Z][A-Z0-9]*$/;

function isParser<T extends ATNSimulator>(
  recognizer: Recognizer<T>
): recognizer is Recognizer<T> & Parser {
  return typeof ((recognizer as unknown) as Parser).getExpectedTokens === 'function';
}

/**
 * Command spellings the grammar accepts, derived from FIRST(`commands`) via the
 * ATN so it auto-adapts to grammar changes. Returns undefined when there is no
 * `commands` rule or the FIRST set is implausibly large (a low-signal position).
 */
function commandCandidatesFromATN<T extends ATNSimulator>(
  recognizer: Recognizer<T> & Parser
): Set<string> | undefined {
  const ruleIndex = recognizer.getRuleIndex('commands');
  if (ruleIndex < 0) {
    return undefined;
  }
  const startState = recognizer.atn.ruleToStartState[ruleIndex];
  if (!startState) {
    return undefined;
  }
  const tokenTypes = recognizer.atn.nextTokens(startState).toArray();
  if (tokenTypes.length > MAX_COMMAND_CANDIDATES) {
    return undefined;
  }
  const spellings = new Set<string>();
  for (const tokenType of tokenTypes) {
    const symbolic = recognizer.vocabulary.getSymbolicName(tokenType);
    if (symbolic && KEYWORD_SYMBOLIC_RE.test(symbolic)) {
      spellings.add(symbolic.toLowerCase());
    }
  }
  return spellings.size > 0 ? spellings : undefined;
}

/**
 * Command spellings in the mismatch follow-set, intersected with the grammar's
 * command vocabulary. The intersection drops `EOF` (all-caps, alpha-only) so a
 * source-first `{EOF}` follow-set does not wrongly short-circuit the fallback.
 */
function commandSpellingsInFollowSet(
  expected: IntervalSet,
  commandSet: ReadonlySet<string>,
  vocabulary: { getSymbolicName(tokenType: number): string | null }
): Set<string> {
  const spellings = new Set<string>();
  const tokenTypes = expected.toArray();
  if (tokenTypes.length > MAX_COMMAND_CANDIDATES) {
    return spellings;
  }
  for (const tokenType of tokenTypes) {
    const symbolic = vocabulary.getSymbolicName(tokenType);
    if (symbolic) {
      const spelling = symbolic.toLowerCase();
      if (commandSet.has(spelling)) {
        spellings.add(spelling);
      }
    }
  }
  return spellings;
}

/**
 * Whether the offending token immediately follows a `PIPE` in the raw token
 * stream. This is the only reliable command-position signal once a source-first
 * `| <typo>` mismatch on the server grammar unwinds the `(PIPE commands)*`
 * closure back to `root` and collapses the follow-set to `{EOF}`.
 */
function offendingFollowsPipe<T extends ATNSimulator>(
  recognizer: Recognizer<T> & Parser,
  offendingSymbol: Token | null
): boolean {
  const tokenIndex = offendingSymbol?.tokenIndex;
  const stream = recognizer.inputStream;
  if (tokenIndex == null || tokenIndex <= 0 || !stream) {
    return false;
  }
  for (let i = tokenIndex - 1; i >= 0; i--) {
    const prev = stream.get(i);
    if (prev.channel !== Token.DEFAULT_CHANNEL) {
      continue;
    }
    return recognizer.vocabulary.getSymbolicName(prev.type) === 'PIPE';
  }
  return false;
}

/**
 * Decide whether a syntax error is a misspelled command and, if so, produce a
 * structured correction. Returns undefined when there is no confident suggestion
 * (the caller then keeps ANTLR's original message). Candidates come from the
 * follow-set intersected with the command vocabulary (primary) or, when that is
 * empty on a source-first server-grammar mismatch, from FIRST(`commands`) gated
 * by a PIPE-lookback (fallback). `e.getExpectedTokens()` is preferred over
 * `recognizer.getExpectedTokens()`, which returns a useless post-recovery set.
 */
export function buildCommandSuggestion<S extends Token, T extends ATNSimulator>(
  recognizer: Recognizer<T>,
  offendingSymbol: S | null,
  e: RecognitionException | null
): CommandSuggestion | undefined {
  const typed = offendingSymbol?.text;
  if (!typed || !IDENTIFIER_RE.test(typed)) {
    return undefined;
  }
  if (!isParser(recognizer)) {
    return undefined; // lexer error — no expected-token set to read.
  }

  // The grammar's command vocabulary, derived from the ATN. Doubles as the
  // "is this already a valid command" oracle and as the fallback candidate set.
  const validCommands = commandCandidatesFromATN(recognizer);
  if (!validCommands || validCommands.size === 0) {
    return undefined; // grammar exposes no `commands` rule — can't reason here.
  }

  // A correctly-spelled command here means the error is structural, not a typo.
  if (validCommands.has(typed.toLowerCase())) {
    return undefined;
  }

  const expected = e?.getExpectedTokens() ?? recognizer.getExpectedTokens();
  const followSetCommands = expected
    ? commandSpellingsInFollowSet(expected, validCommands, recognizer.vocabulary)
    : undefined;

  const candidates =
    followSetCommands && followSetCommands.size > 0
      ? followSetCommands
      : offendingFollowsPipe(recognizer, offendingSymbol)
      ? validCommands
      : undefined;

  if (!candidates || candidates.size === 0) {
    return undefined; // not a command position.
  }

  const suggestion = suggestCommand(typed, candidates);
  if (!suggestion) {
    return undefined;
  }

  return {
    code: 'UNKNOWN_COMMAND',
    typed,
    suggestion,
    message: `Unknown command "${typed}". Did you mean "${suggestion}"?`,
    // Title matches field_validation's `Replace with "..."` convention.
    fix: { title: `Replace with "${suggestion}"`, text: suggestion },
  };
}
