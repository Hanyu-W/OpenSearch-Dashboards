/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/* eslint-disable no-console */

/**
 * PPL lint performance benchmark — Axis 1 (steady-state per-pass CPU) and
 * Axis 3 (grammar deserialization, the CPU half of cold start).
 *
 * This file does NOT use fake timers. It must never share a Jest worker with a
 * file that calls jest.useFakeTimers() (see debounce.bench.test.ts, which is a
 * separate file for exactly that reason). Timing uses perf_hooks (see
 * measure.ts), which is immune to sinonjs fake-timer global patching.
 *
 * Gated behind PPL_BENCH=1 so it never runs in normal CI (it takes minutes and
 * the percentiles are environment-sensitive). Run with:
 *   PPL_BENCH=1 node --expose-gc scripts/jest \
 *     packages/osd-monaco/src/ppl/lint/__bench__/lint_perf.bench.test.ts \
 *     --runInBand
 *
 * Results are written to packages/osd-monaco/src/ppl/lint/__bench__/results/.
 */

import fs from 'fs';
import path from 'path';
import * as antlr from 'antlr4ng';
import { SimplifiedOpenSearchPPLLexer, SimplifiedOpenSearchPPLParser } from '@osd/antlr-grammar';
import { PPLLanguageAnalyzer } from '../../ppl_language_analyzer';
import { runLint } from '../lint_runner';
import { createCompiledRuleNameToIndex } from '../rule_index';
import { getBundledCatalog } from '../catalog';
import { LintRunContext } from '../types';
import { CORPUS, makeBenchContext, SizeBucket } from './corpus';
import {
  assertCorpusIsNonPipeFirst,
  deserializeGrammar,
  lintRuntime,
  RawGrammarBundle,
  RuntimeGrammar,
} from './runtime_path';
import {
  DEFAULT_BENCH,
  maybeGc,
  readSink,
  Stats,
  summarize,
  timeThunk,
  warmupRatio,
} from './measure';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { performance } = require('perf_hooks') as typeof import('perf_hooks');

const RUN = process.env.PPL_BENCH === '1';
const describeBench = RUN ? describe : describe.skip;

const RESULTS_DIR = path.join(__dirname, 'results');
const BUNDLE_PATH = path.join(__dirname, 'ppl_grammar_bundle.json');

function ctxToRun(): LintRunContext {
  const c = makeBenchContext();
  return {
    fields: c.fields,
    typeMap: c.typeMap,
    isCalcite: c.isCalcite,
    visibleIndices: c.visibleIndices,
    dataSourceVersion: c.dataSourceVersion,
  };
}

/** Build a compiled-grammar parse tree (what the Web Worker's analyzer does). */
function compiledParse(code: string): antlr.ParserRuleContext {
  const cs = antlr.CharStream.fromString(code);
  const lx = new SimplifiedOpenSearchPPLLexer(cs);
  const ts = new antlr.CommonTokenStream(lx);
  const p = new SimplifiedOpenSearchPPLParser(ts);
  p.removeErrorListeners();
  return p.root();
}

interface Row {
  id: string;
  bucket: SizeBucket;
  chars: number;
  path: 'compiled-worker' | 'runtime-interpreter';
  context: 'none' | 'full';
  diagnostics: number;
  stats: Stats;
}

describeBench('PPL lint performance benchmark', () => {
  const allRows: Row[] = [];
  let runtimeGrammar: RuntimeGrammar;
  let deserMs = { lexerMs: 0, parserMs: 0, totalMs: 0 };

  beforeAll(() => {
    if (!fs.existsSync(RESULTS_DIR)) fs.mkdirSync(RESULTS_DIR, { recursive: true });

    // The runtime harness only matches production for non-pipe-first queries
    // (see runtime_path.ts buildRuntimeTree note 1). Enforce that here.
    assertCorpusIsNonPipeFirst(CORPUS.map((q) => q.ppl));

    const bundle = JSON.parse(fs.readFileSync(BUNDLE_PATH, 'utf8')) as RawGrammarBundle;
    // Axis 3 CPU half: measure ATN deserialization many times for a stable median.
    const deserSamples: number[] = [];
    for (let i = 0; i < 40; i++) {
      const { timing } = deserializeGrammar(bundle, () => performance.now());
      deserSamples.push(timing.totalMs);
    }
    deserSamples.sort((a, b) => a - b);
    const mid = deserSamples[Math.floor(deserSamples.length / 2)];
    const built = deserializeGrammar(bundle, () => performance.now());
    runtimeGrammar = built.grammar;
    deserMs = built.timing;
    console.log(
      `[deserialize] one-time ATN deserialize: median ${mid.toFixed(1)}ms ` +
        `(lexer ${deserMs.lexerMs.toFixed(1)}ms, parser ${deserMs.parserMs.toFixed(1)}ms)`
    );
  });

  it('catalog shape is as documented (16 entries, 7 context-gated)', () => {
    const cat = getBundledCatalog();
    expect(cat.length).toBe(16);
    expect(cat.filter((c) => c.enabled).length).toBe(16);
    expect(cat.filter((c) => c.needsContext).length).toBe(7);
  });

  // ── Axis 1a — compiled-worker path (no context, ~9 rules eligible) ────────
  describe('Axis 1a: compiled fallback (Web Worker path, no context)', () => {
    const analyzer = new PPLLanguageAnalyzer();

    it.each(CORPUS.map((q) => [q.id, q] as const))(
      'lint() over %s',
      (_id, q) => {
        // No context argument — deliberately matching the Web Worker, which
        // calls `analyzer.lint(content)` with no context (ppl.worker.ts), so
        // all 7 needsContext rules are skipped on this path. This is the
        // representative worker-path measurement, not an omission.
        // Warm up on the EXACT query so the ANTLR DFA cache is hot.
        const work = () => analyzer.lint(q.ppl).diagnostics.length;
        const ratio = warmupRatio(work);
        const samples = timeThunk(work, DEFAULT_BENCH);
        const stats = summarize(samples);
        const diagnostics = analyzer.lint(q.ppl).diagnostics.length;
        allRows.push({
          id: q.id,
          bucket: q.bucket,
          chars: q.ppl.length,
          path: 'compiled-worker',
          context: 'none',
          diagnostics,
          stats,
        });
        if (ratio > 1.25) {
          console.warn(
            `[warmup] ${q.id}: second burst ${ratio.toFixed(2)}x first — DFA may be cold`
          );
        }
        maybeGc();
        expect(stats.p50).toBeGreaterThan(0);
      },
      120_000
    );
  });

  // ── Axis 1b — runtime-interpreter path (full context, up to 16 rules) ─────
  describe('Axis 1b: runtime bridge (main-thread interpreter, full context)', () => {
    const context = ctxToRun();

    it.each(CORPUS.map((q) => [q.id, q] as const))(
      'lintRuntime() over %s',
      (_id, q) => {
        const work = () => lintRuntime(q.ppl, runtimeGrammar, context).length;
        const ratio = warmupRatio(work);
        const samples = timeThunk(work, DEFAULT_BENCH);
        const stats = summarize(samples);
        const diagnostics = lintRuntime(q.ppl, runtimeGrammar, context).length;
        allRows.push({
          id: q.id,
          bucket: q.bucket,
          chars: q.ppl.length,
          path: 'runtime-interpreter',
          context: 'full',
          diagnostics,
          stats,
        });
        if (ratio > 1.25) {
          console.warn(
            `[warmup] ${q.id}: second burst ${ratio.toFixed(2)}x first — DFA may be cold`
          );
        }
        maybeGc();
        expect(stats.p50).toBeGreaterThan(0);
      },
      120_000
    );
  });

  // ── Cross-check: confirm the compiled path equals analyzer.lint exactly ───
  it('compiled parse tree + runLint matches analyzer.lint output size', () => {
    const idx = createCompiledRuleNameToIndex();
    for (const q of CORPUS) {
      const tree = compiledParse(q.ppl);
      const viaRunLint = runLint(tree, { ruleNameToIndex: idx }).length;
      const viaAnalyzer = new PPLLanguageAnalyzer().lint(q.ppl).diagnostics.length;
      expect(viaRunLint).toBe(viaAnalyzer);
    }
  });

  afterAll(() => {
    const out = {
      meta: {
        node: process.version,
        warmupIters: DEFAULT_BENCH.warmupIters,
        measureIters: DEFAULT_BENCH.measureIters,
        gcExposed: typeof (global as any).gc === 'function',
        sink: readSink(),
      },
      deserializeMs: deserMs,
      rows: allRows,
    };
    const file = path.join(RESULTS_DIR, 'axis1_cpu.json');
    fs.writeFileSync(file, JSON.stringify(out, null, 2));
    console.log(`\n[results] wrote ${file} (${allRows.length} rows)`);

    // Console summary table.
    const fmt = (n: number) => n.toFixed(3).padStart(8);
    console.log(
      '\n  path                 ctx   bucket  chars  diags     p50      p90      p99      max'
    );
    for (const r of allRows) {
      console.log(
        `  ${r.path.padEnd(20)} ${r.context.padEnd(5)} ${r.bucket.padEnd(7)} ` +
          `${String(r.chars).padStart(5)} ${String(r.diagnostics).padStart(5)}  ` +
          `${fmt(r.stats.p50)} ${fmt(r.stats.p90)} ${fmt(r.stats.p99)} ${fmt(r.stats.max)}`
      );
    }
  });
});
