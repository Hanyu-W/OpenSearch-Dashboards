/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  ATNDeserializer,
  CharStream,
  CommonTokenStream,
  LexerInterpreter,
  ParserInterpreter,
  ParserRuleContext,
  Vocabulary,
} from 'antlr4ng';
import { GrammarSurface, ParserAtnLike, VocabularyLike } from './grammar_surface';

// Mirrors ATN_DESERIALIZE_OPTIONS in the production grammar cache and the bench
// replica so the reconstructed surface behaves identically.
const ATN_DESERIALIZE_OPTIONS = {
  readOnly: false,
  verifyATN: true,
  generateRuleBypassTransitions: true,
};

/**
 * A checked-in runtime grammar artifact. Mirrors the fields the live-cluster
 * `GET /_plugins/_ppl/_grammar` bundle carries (see
 * `lint/__bench__/ppl_grammar_bundle.json`), plus the provenance metadata the
 * verification framework requires before claiming runtime coverage.
 */
export interface RuntimeGrammarFixture {
  engineVersion: string;
  sourceModule: string;
  grammarProvenance: string;
  grammarHash: string;
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

/** A successful fixture setup. */
export interface RuntimeSetupSuccess {
  ok: true;
  surface: GrammarSurface;
}

/** A failed or pending fixture setup. */
export interface RuntimeSetupUnavailable {
  ok: false;
  pending: boolean;
  message: string;
}

/** The result of validating + reconstructing a runtime fixture. */
export type RuntimeSurfaceSetupResult = RuntimeSetupSuccess | RuntimeSetupUnavailable;

/** Type guard: setup did not produce a usable surface. */
export function isRuntimeSetupUnavailable(
  result: RuntimeSurfaceSetupResult
): result is RuntimeSetupUnavailable {
  return !result.ok;
}

/** True when a string is absent or blank after trimming. */
function isBlank(value: unknown): boolean {
  return typeof value !== 'string' || value.trim().length === 0;
}

/**
 * Validate the fixture and, on success, reconstruct a {@link GrammarSurface}
 * from the serialized ATNs (R12.1-R12.4). Failure labels runtime coverage as
 * unavailable and does NOT reconstruct a surface — the caller must not run
 * runtime checks. `expectedHash`, when provided, must match the fixture's hash.
 */
export function setupRuntimeFixture(
  fixture: RuntimeGrammarFixture | undefined,
  options: {
    expectedHash?: string;
    runSourceFreshnessCheck?: () => { ok: boolean; importPath?: string };
  } = {}
): RuntimeSurfaceSetupResult {
  if (!fixture) {
    return {
      ok: false,
      pending: true,
      message: 'Runtime grammar fixture is absent; coverage pending.',
    };
  }

  const requiredStrings: Array<[string, unknown]> = [
    ['engineVersion', fixture.engineVersion],
    ['sourceModule', fixture.sourceModule],
    ['grammarProvenance', fixture.grammarProvenance],
    ['grammarHash', fixture.grammarHash],
  ];
  for (const [field, value] of requiredStrings) {
    if (isBlank(value)) {
      return unavailable(`Runtime fixture metadata is incomplete: ${field} is blank.`);
    }
  }

  if (!Array.isArray(fixture.lexerSerializedATN) || fixture.lexerSerializedATN.length === 0) {
    return unavailable('Runtime fixture lexer ATN is missing.');
  }
  if (!Array.isArray(fixture.parserSerializedATN) || fixture.parserSerializedATN.length === 0) {
    return unavailable('Runtime fixture parser ATN is missing.');
  }
  if (
    !Array.isArray(fixture.lexerRuleNames) ||
    fixture.lexerRuleNames.length === 0 ||
    !Array.isArray(fixture.parserRuleNames) ||
    fixture.parserRuleNames.length === 0
  ) {
    return unavailable('Runtime fixture rule names are incomplete.');
  }
  if (
    !Array.isArray(fixture.symbolicNames) ||
    fixture.symbolicNames.length === 0 ||
    !Array.isArray(fixture.literalNames) ||
    fixture.literalNames.length === 0
  ) {
    return unavailable('Runtime fixture vocabulary is incomplete.');
  }

  if (options.expectedHash !== undefined && options.expectedHash !== fixture.grammarHash) {
    return unavailable(
      `Runtime fixture grammar hash does not match pinned artifact (expected ${options.expectedHash}, got ${fixture.grammarHash}).`
    );
  }

  // Built-import freshness: runtime lint imports resolve to built target output
  // in production; a stale build must not be treated as blocking runtime
  // coverage (R12.7, R12.8). The check is injected so the fast lane can supply a
  // no-op and a runtime lane can supply a real check.
  const freshness = options.runSourceFreshnessCheck?.() ?? { ok: true };
  if (!freshness.ok) {
    return unavailable(`Stale runtime import: ${freshness.importPath ?? 'unknown'}`);
  }

  // startRuleIndex must be a valid parser rule index, else parse() would target
  // a nonexistent rule (a corrupt-but-deserializable fixture).
  if (fixture.startRuleIndex < 0 || fixture.startRuleIndex >= fixture.parserRuleNames.length) {
    return unavailable(
      `Runtime fixture startRuleIndex ${fixture.startRuleIndex} is out of range (0..${
        fixture.parserRuleNames.length - 1
      }).`
    );
  }

  let surface: GrammarSurface;
  try {
    surface = reconstructRuntimeSurface(fixture);
  } catch (e) {
    return unavailable(
      `Runtime fixture ATN reconstruction failed: ${e instanceof Error ? e.message : String(e)}`
    );
  }

  // Exercise the reconstructed surface before claiming it usable: a fixture can
  // deserialize yet be unusable (mismatched ATN/vocabulary). A trivial parse
  // must not throw.
  try {
    surface.parse('source=t | head 1');
  } catch (e) {
    return unavailable(
      `Runtime fixture reconstructed but failed a smoke parse: ${
        e instanceof Error ? e.message : String(e)
      }`
    );
  }

  return { ok: true, surface };
}

function unavailable(message: string): RuntimeSurfaceSetupResult {
  return { ok: false, pending: false, message };
}

/**
 * Reconstruct a {@link GrammarSurface} from a validated fixture, mirroring the
 * production runtime path (LexerInterpreter + ParserInterpreter over the
 * deserialized ATN). Parsing uses `startRuleIndex` for non-pipe-first queries.
 */
export function reconstructRuntimeSurface(fixture: RuntimeGrammarFixture): GrammarSurface {
  const literalNames = fixture.literalNames.map((n) => (n === '' ? null : n));
  const symbolicNames = fixture.symbolicNames.map((n) => (n === '' ? null : n));
  const vocabulary = new Vocabulary(literalNames, symbolicNames);

  const lexerATN = new ATNDeserializer(ATN_DESERIALIZE_OPTIONS).deserialize(
    fixture.lexerSerializedATN
  );
  const parserATN = new ATNDeserializer(ATN_DESERIALIZE_OPTIONS).deserialize(
    fixture.parserSerializedATN
  );

  const ruleNames = fixture.parserRuleNames;
  const nameToIndex = new Map<string, number>();
  for (let i = 0; i < ruleNames.length; i++) {
    nameToIndex.set(ruleNames[i], i);
  }
  const startRuleIndex = fixture.startRuleIndex ?? 0;

  const surface: GrammarSurface = {
    name: 'runtime_fixture',
    provenance: `${fixture.grammarProvenance} (${fixture.engineVersion}, ${fixture.grammarHash})`,
    grammarHash: fixture.grammarHash,
    parserRuleNames: ruleNames,
    vocabulary: (vocabulary as unknown) as VocabularyLike,
    atn: (parserATN as unknown) as ParserAtnLike,
    startRules: new Set(ruleNames),
    ruleNameToIndex: (n: string) => nameToIndex.get(n) ?? -1,
    getRuleIndex: (n: string) => nameToIndex.get(n) ?? -1,
    parse(query: string): ParserRuleContext {
      const lexer = new LexerInterpreter(
        'PPL',
        vocabulary,
        fixture.lexerRuleNames,
        fixture.channelNames,
        fixture.modeNames,
        lexerATN,
        CharStream.fromString(query)
      );
      lexer.removeErrorListeners();
      const tokenStream = new CommonTokenStream(lexer);
      tokenStream.fill();
      const parser = new ParserInterpreter('PPL', vocabulary, ruleNames, parserATN, tokenStream);
      parser.removeErrorListeners();
      parser.buildParseTrees = true;
      const tree = parser.parse(startRuleIndex);
      if (!tree) {
        throw new Error('Runtime parser produced no tree');
      }
      return tree;
    },
  };
  return surface;
}
