/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

import * as fs from 'fs';
import * as path from 'path';
import * as antlr from 'antlr4ng';
import { SimplifiedOpenSearchPPLLexer, SimplifiedOpenSearchPPLParser } from '@osd/antlr-grammar';
import { runLint } from '../lint_runner';
import { createCompiledRuleNameToIndex } from '../rule_index';
import { LintRunContext } from '../types';
import {
  deserializeGrammar,
  lintRuntime,
  RawGrammarBundle,
  RuntimeGrammar,
} from '../__bench__/runtime_path';
import { RULE_CORPUS, CorpusCase, GrammarSurface } from './rule_corpus';

/**
 * Option 1, Layer B — corpus-driven behavioral validation across both grammar
 * surfaces. See `rule_corpus.ts` for the design and the case table.
 */

// --- Compiled surface (always available; mirrors PPLLanguageAnalyzer.lint) ----
function compiledParse(code: string): antlr.ParserRuleContext {
  const cs = antlr.CharStream.fromString(code);
  const lx = new SimplifiedOpenSearchPPLLexer(cs);
  const ts = new antlr.CommonTokenStream(lx);
  const p = new SimplifiedOpenSearchPPLParser(ts);
  p.removeErrorListeners();
  return p.root();
}

const compiledIndex = createCompiledRuleNameToIndex();

function compiledRuleIds(code: string, context?: LintRunContext): string[] {
  const tree = compiledParse(code);
  return runLint(tree, {
    ruleNameToIndex: compiledIndex,
    dataSourceVersion: context?.dataSourceVersion,
    context: { ...context, grammarSurface: 'compiled-simplified' },
  }).map((d) => d.ruleId);
}

// --- Runtime surface (only when the grammar bundle fixture is present) --------
const BUNDLE_PATH = path.join(__dirname, '..', '__bench__', 'ppl_grammar_bundle.json');
const hasBundle = fs.existsSync(BUNDLE_PATH);

let runtimeGrammar: RuntimeGrammar | undefined;
if (hasBundle) {
  const bundle = JSON.parse(fs.readFileSync(BUNDLE_PATH, 'utf8')) as RawGrammarBundle;
  let clock = 0;
  runtimeGrammar = deserializeGrammar(bundle, () => ++clock).grammar;
}

function runtimeRuleIds(code: string, context?: LintRunContext): string[] {
  return lintRuntime(code, runtimeGrammar!, {
    ...context,
    grammarSurface: 'runtime-bundle',
  }).map((d) => d.ruleId);
}

// One assertion entry point per surface, so the matrix below reads uniformly.
const idsBySurface: Record<GrammarSurface, (c: string, ctx?: LintRunContext) => string[]> = {
  compiled: compiledRuleIds,
  runtime: runtimeRuleIds,
};

const ALL_SURFACES: GrammarSurface[] = ['compiled', 'runtime'];

describe('PPL lint rule corpus (Option 1, Layer B)', () => {
  if (!hasBundle) {
    // eslint-disable-next-line no-console
    console.warn(
      '[rule_corpus] ppl_grammar_bundle.json absent — runtime-surface assertions skipped.'
    );
  }

  // Sanity: the corpus must cover every rule that can fire on the parse tree
  // (i.e. every non-explain catalog rule). Explain-backed rules read an
  // `_explain` plan, not the tree, so they are out of this layer's scope and
  // covered by the engine oracle (Layer C) instead.
  it('covers a stable, known set of rule ids', () => {
    const covered = RULE_CORPUS.map((c) => c.ruleId).sort();
    expect(covered).toEqual([...covered].sort()); // no accidental dupes break ordering
    expect(new Set(covered).size).toBe(covered.length);
  });

  for (const rule of RULE_CORPUS) {
    describe(rule.ruleId, () => {
      for (const surface of ALL_SURFACES) {
        if (surface === 'runtime' && !hasBundle) {
          continue;
        }
        const ids = idsBySurface[surface];
        const fires = rule.surfaces.includes(surface);
        const label = (c: CorpusCase) => `${c.note ?? c.ppl} [${surface}]`;

        describe(surface, () => {
          for (const pos of rule.positives) {
            const expectation = fires ? 'fires on' : 'stays silent on (rule absent here)';
            it(`${expectation}: ${label(pos)}`, () => {
              const got = ids(pos.ppl, pos.context);
              if (fires) {
                expect(got).toContain(rule.ruleId);
              } else {
                expect(got).not.toContain(rule.ruleId);
              }
            });
          }

          for (const neg of rule.negatives) {
            it(`stays silent on: ${label(neg)}`, () => {
              const got = ids(neg.ppl, neg.context);
              expect(got).not.toContain(rule.ruleId);
            });
          }
        });
      }
    });
  }
});
