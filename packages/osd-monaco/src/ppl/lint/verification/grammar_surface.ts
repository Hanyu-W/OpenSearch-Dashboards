/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

import { CharStream, CommonTokenStream, Lexer, Parser, ParserRuleContext } from 'antlr4ng';
import {
  OpenSearchPPLLexer,
  OpenSearchPPLParser,
  SimplifiedOpenSearchPPLLexer,
  SimplifiedOpenSearchPPLParser,
} from '@osd/antlr-grammar';
import { RuleNameToIndex } from '../rule_index';
import { SurfaceName } from './types';

/**
 * A parser + lexer grammar source the framework can verify: rule names, a
 * name→index resolver, vocabulary, ATN access, and a query→parse-tree builder.
 *
 * Two local surfaces are wrapped from `@osd/antlr-grammar`. Note the naming
 * inversion: the compiled *simplified* parser (`SimplifiedOpenSearchPPLParser`,
 * ~203 rules) is the one the lint plugin actually ships, so it maps to
 * `compiled_simplified`. The full `OpenSearchPPLParser` (~114 rules) is the
 * smaller in-repository proxy used before a runtime fixture exists. The
 * `runtime_fixture` surface is built separately from a serialized-ATN artifact.
 */
export interface GrammarSurface {
  name: SurfaceName;
  provenance: string;
  grammarHash?: string;
  parserRuleNames: readonly string[];
  vocabulary: VocabularyLike;
  /** The parser ATN, for FIRST-set / start-state derivation. */
  atn: ParserAtnLike;
  startRules: ReadonlySet<string>;
  /** Deterministic name→index resolver; returns -1 for absent names. */
  ruleNameToIndex: RuleNameToIndex;
  /** Build the error-recovered parse tree for a query on this surface. */
  parse(query: string): ParserRuleContext;
  /** Rule index of the start state used to derive command-start tokens. */
  getRuleIndex(name: string): number;
}

/** The vocabulary surface the inventory needs (a subset of antlr4ng Vocabulary). */
export interface VocabularyLike {
  getSymbolicName(tokenType: number): string | null;
  getMaxTokenType?(): number;
}

/** The ATN surface the inventory needs (a subset of antlr4ng ATN). */
export interface ParserAtnLike {
  ruleToStartState: ReadonlyArray<{ stateNumber?: number } | null | undefined>;
  nextTokens(state: unknown): { toArray(): number[] };
}

interface ParserCtor {
  new (input: CommonTokenStream): Parser & { root(): ParserRuleContext };
  ruleNames: string[];
}

type LexerCtor = new (input: CharStream) => Lexer;

function buildLocalSurface(
  name: SurfaceName,
  provenance: string,
  LexerClass: LexerCtor,
  ParserClass: ParserCtor
): GrammarSurface {
  const ruleNames: readonly string[] = ParserClass.ruleNames;
  const nameToIndex = new Map<string, number>();
  for (let i = 0; i < ruleNames.length; i++) {
    nameToIndex.set(ruleNames[i], i);
  }

  // A throwaway parser instance exposes vocabulary + ATN without needing input.
  const probe = new ParserClass(new CommonTokenStream(new LexerClass(CharStream.fromString(''))));

  const surface: GrammarSurface = {
    name,
    provenance,
    parserRuleNames: ruleNames,
    vocabulary: (probe.vocabulary as unknown) as VocabularyLike,
    atn: (probe.atn as unknown) as ParserAtnLike,
    startRules: new Set(ruleNames),
    ruleNameToIndex: (n: string) => nameToIndex.get(n) ?? -1,
    getRuleIndex: (n: string) => nameToIndex.get(n) ?? -1,
    parse(query: string): ParserRuleContext {
      const lexer = new LexerClass(CharStream.fromString(query));
      lexer.removeErrorListeners();
      const parser = new ParserClass(new CommonTokenStream(lexer));
      parser.removeErrorListeners();
      return parser.root();
    },
  };
  return surface;
}

/**
 * The compiled simplified grammar surface the lint plugin ships. Cached so a
 * single Jest run reuses one probe/resolver (R14.6).
 */
let compiledSurface: GrammarSurface | undefined;
export function compiledSimplifiedSurface(): GrammarSurface {
  if (!compiledSurface) {
    compiledSurface = buildLocalSurface(
      'compiled_simplified',
      '@osd/antlr-grammar SimplifiedOpenSearchPPLParser',
      (SimplifiedOpenSearchPPLLexer as unknown) as LexerCtor,
      (SimplifiedOpenSearchPPLParser as unknown) as ParserCtor
    );
  }
  return compiledSurface;
}

/**
 * The in-repository full grammar surface, used as a proxy before a runtime
 * fixture exists. Labeled explicitly so it is never mistaken for runtime
 * coverage (R3.1, R5.7).
 */
let proxySurface: GrammarSurface | undefined;
export function inRepoFullProxySurface(): GrammarSurface {
  if (!proxySurface) {
    proxySurface = buildLocalSurface(
      'in_repo_full_proxy',
      '@osd/antlr-grammar OpenSearchPPLParser (proxy)',
      (OpenSearchPPLLexer as unknown) as LexerCtor,
      (OpenSearchPPLParser as unknown) as ParserCtor
    );
  }
  return proxySurface;
}

/** The local fast-lane surfaces, in report order. */
export function localFastLaneSurfaces(): GrammarSurface[] {
  return [compiledSimplifiedSurface(), inRepoFullProxySurface()];
}

/** Test-only: clear the cached surfaces. */
export function resetSurfaceCache(): void {
  compiledSurface = undefined;
  proxySurface = undefined;
}
