/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Faithful, self-contained replica of the production runtime-grammar lint path
 * (src/plugins/data/public/antlr/opensearch_ppl/runtime_lint.ts). osd-monaco
 * cannot import the data plugin, so we reproduce `buildRuntimeTree` +
 * `runLint` here against a REAL grammar bundle deserialized from the live
 * cluster's `GET /_plugins/_ppl/_grammar` response.
 *
 * This is the steady-state lint path for every user on OpenSearch >= 3.6.0 with
 * runtime grammar enabled: it runs on the MAIN THREAD (LexerInterpreter +
 * ParserInterpreter from the deserialized ATN), and it receives a full
 * LintRunContext, so context-gated (Bucket-B) rules can fire.
 */

import {
  ATN,
  ATNDeserializer,
  CharStream,
  CommonTokenStream,
  LexerInterpreter,
  ParserInterpreter,
  ParserRuleContext,
  Vocabulary,
} from 'antlr4ng';
import { runLint } from '../lint_runner';
import { createRuntimeRuleNameToIndex } from '../rule_index';
import { LintRunContext } from '../types';
import { Diagnostic } from '../diagnostic';
import { PIPE_FIRST_PREFIX } from '../range_utils';

// Mirrors ATN_DESERIALIZE_OPTIONS in ppl_grammar_cache.ts.
const ATN_DESERIALIZE_OPTIONS = {
  readOnly: false,
  verifyATN: true,
  generateRuleBypassTransitions: true,
};

/** The fields of the bundle this harness consumes. */
export interface RawGrammarBundle {
  lexerSerializedATN: number[];
  parserSerializedATN: number[];
  lexerRuleNames: string[];
  parserRuleNames: string[];
  channelNames: string[];
  modeNames: string[];
  literalNames: Array<string | null>;
  symbolicNames: Array<string | null>;
  startRuleIndex: number;
}

/** The deserialized, reusable grammar — built once, mirrors CachedGrammar. */
export interface RuntimeGrammar {
  lexerATN: ATN;
  parserATN: ATN;
  vocabulary: Vocabulary;
  lexerRuleNames: string[];
  parserRuleNames: string[];
  channelNames: string[];
  modeNames: string[];
  startRuleIndex: number;
  runtimeRuleNameToIndex: Map<string, number>;
}

export interface DeserializeTiming {
  lexerMs: number;
  parserMs: number;
  totalMs: number;
}

/**
 * Deserialize the bundle's ATN bytes into a reusable RuntimeGrammar, mirroring
 * the work `ppl_grammar_cache` does once per datasource-switch. Returns the
 * grammar plus the one-time deserialization cost (the CPU half of cold start).
 */
export function deserializeGrammar(
  bundle: RawGrammarBundle,
  now: () => number
): { grammar: RuntimeGrammar; timing: DeserializeTiming } {
  const literalNames = (bundle.literalNames || []).map((n) => (n === '' ? null : n));
  const symbolicNames = (bundle.symbolicNames || []).map((n) => (n === '' ? null : n));
  const vocabulary = new Vocabulary(literalNames, symbolicNames);

  const t0 = now();
  const lexerATN = new ATNDeserializer(ATN_DESERIALIZE_OPTIONS).deserialize(
    bundle.lexerSerializedATN
  );
  const t1 = now();
  const parserATN = new ATNDeserializer(ATN_DESERIALIZE_OPTIONS).deserialize(
    bundle.parserSerializedATN
  );
  const t2 = now();

  const runtimeRuleNameToIndex = new Map<string, number>();
  for (let i = 0; i < bundle.parserRuleNames.length; i++) {
    runtimeRuleNameToIndex.set(bundle.parserRuleNames[i], i);
  }

  return {
    grammar: {
      lexerATN,
      parserATN,
      vocabulary,
      lexerRuleNames: bundle.lexerRuleNames,
      parserRuleNames: bundle.parserRuleNames,
      channelNames: bundle.channelNames,
      modeNames: bundle.modeNames,
      startRuleIndex: bundle.startRuleIndex ?? 0,
      runtimeRuleNameToIndex,
    },
    timing: { lexerMs: t1 - t0, parserMs: t2 - t1, totalMs: t2 - t0 },
  };
}

/**
 * Replica of runtime_lint.ts:buildRuntimeTree.
 *
 * Two deliberate simplifications, both verified to be behavior-preserving for
 * this benchmark's corpus:
 *
 *  1. START RULE. Production calls `pickStartRuleIndex(query, grammar)`. For a
 *     NON-pipe-first query that function returns exactly `grammar.startRuleIndex
 *     ?? 0` (see runtime_grammar_utils.ts: it early-returns the default unless
 *     the query `trimStart().startsWith('|')`). The benchmark corpus contains
 *     no pipe-first queries (all begin with `source=`/`search`), so this
 *     `startRuleIndex` is identical to what production would pick. The
 *     `assertCorpusIsNonPipeFirst` guard below enforces that invariant.
 *
 *  2. ERROR LISTENER. Production attaches a `GeneralErrorListener`, but that
 *     class is a *passive* `ANTLRErrorListener` — its only method,
 *     `syntaxError()`, pushes to an `errors[]` array. It does NOT override
 *     `recover`/`recoverInline`/`sync`, so it does not influence ANTLR's error
 *     recovery or the shape of the parse tree the linter walks. Omitting it
 *     therefore leaves the measured tree (and thus the lint CPU) unchanged; we
 *     only lose the error list, which lint does not consume.
 */
export function buildRuntimeTree(
  query: string,
  grammar: RuntimeGrammar
): ParserRuleContext | undefined {
  const isPipeFirst = query.trimStart().startsWith('|');
  const effective = isPipeFirst ? PIPE_FIRST_PREFIX + query : query;
  // Matches pickStartRuleIndex for non-pipe-first queries (see note above).
  const startRuleIndex = grammar.startRuleIndex ?? 0;

  const lexer = new LexerInterpreter(
    'PPL',
    grammar.vocabulary,
    grammar.lexerRuleNames,
    grammar.channelNames,
    grammar.modeNames,
    grammar.lexerATN,
    CharStream.fromString(effective)
  );
  lexer.removeErrorListeners();

  const tokenStream = new CommonTokenStream(lexer);
  tokenStream.fill();

  const parser = new ParserInterpreter(
    'PPL',
    grammar.vocabulary,
    grammar.parserRuleNames,
    grammar.parserATN,
    tokenStream
  );
  parser.removeErrorListeners();
  parser.buildParseTrees = true;

  try {
    const tree = parser.parse(startRuleIndex);
    return tree ?? undefined;
  } catch {
    return undefined;
  }
}

/**
 * Replica of runtime_lint.ts:lintWithGrammar — the full main-thread pass:
 * parse via interpreter, then runLint with the caller's context.
 */
export function lintRuntime(
  query: string,
  grammar: RuntimeGrammar,
  context?: LintRunContext
): Diagnostic[] {
  if (!query.trim()) return [];
  const tree = buildRuntimeTree(query, grammar);
  if (!tree) return [];
  return runLint(tree, {
    ruleNameToIndex: createRuntimeRuleNameToIndex(grammar.runtimeRuleNameToIndex),
    dataSourceVersion: context?.dataSourceVersion,
    context,
  });
}

/**
 * Guard enforcing the start-rule simplification in `buildRuntimeTree` (note 1):
 * the harness only matches production for NON-pipe-first queries. Throws if any
 * query begins with a leading pipe, which would route production through a
 * different start rule. Call this once before benchmarking a corpus.
 */
export function assertCorpusIsNonPipeFirst(queries: string[]): void {
  const offenders = queries.filter((q) => q.trimStart().startsWith('|'));
  if (offenders.length > 0) {
    throw new Error(
      `runtime_path benchmark harness assumes non-pipe-first queries, but found ` +
        `${offenders.length}: ${offenders.slice(0, 3).join(' ; ')}. Add pickStartRuleIndex ` +
        `support to buildRuntimeTree before benchmarking pipe-first queries.`
    );
  }
}
