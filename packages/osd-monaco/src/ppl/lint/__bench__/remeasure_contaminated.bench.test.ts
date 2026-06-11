/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/* eslint-disable no-console */

/**
 * Re-measure interpreter-path rows whose tail was contaminated by an OS-level
 * process suspension during the long full run (identified by CV > 1, i.e. a
 * single "iteration" that absorbed a multi-minute suspend). Re-runs ONLY the
 * named queries in isolation (no concurrent load) and patches axis1_cpu.json in
 * place, leaving the clean rows untouched. Gated behind PPL_BENCH_FIX=1.
 */

import fs from 'fs';
import path from 'path';
import { CORPUS, makeBenchContext } from './corpus';
import { deserializeGrammar, lintRuntime, RawGrammarBundle } from './runtime_path';
import { DEFAULT_BENCH, maybeGc, summarize, timeThunk, warmupRatio } from './measure';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { performance } = require('perf_hooks') as typeof import('perf_hooks');

const RUN = process.env.PPL_BENCH_FIX === '1';
const d = RUN ? describe : describe.skip;

const RESULTS = path.join(__dirname, 'results', 'axis1_cpu.json');
const BUNDLE = path.join(__dirname, 'ppl_grammar_bundle.json');
const TARGETS = (process.env.PPL_BENCH_FIX_IDS || 'medium-multi-pipe,xlarge-rex-storm').split(',');

d('re-measure contaminated interpreter rows', () => {
  it('re-runs targets and patches axis1_cpu.json', () => {
    const bundle = JSON.parse(fs.readFileSync(BUNDLE, 'utf8')) as RawGrammarBundle;
    const { grammar } = deserializeGrammar(bundle, () => performance.now());
    const c = makeBenchContext();
    const context = {
      fields: c.fields,
      typeMap: c.typeMap,
      isCalcite: c.isCalcite,
      visibleIndices: c.visibleIndices,
      dataSourceVersion: c.dataSourceVersion,
    };

    const data = JSON.parse(fs.readFileSync(RESULTS, 'utf8'));
    for (const id of TARGETS) {
      const q = CORPUS.find((x) => x.id === id)!;
      const work = () => lintRuntime(q.ppl, grammar, context).length;
      const ratio = warmupRatio(work);
      const samples = timeThunk(work, DEFAULT_BENCH);
      const stats = summarize(samples);
      const diagnostics = lintRuntime(q.ppl, grammar, context).length;
      const row = data.rows.find((r: any) => r.id === id && r.path === 'runtime-interpreter');
      if (row) {
        const oldCv = row.stats.cv;
        row.stats = stats;
        row.diagnostics = diagnostics;
        row.remeasured = true;
        console.log(
          `[remeasure] ${id}: cv ${oldCv.toFixed(2)} → ${stats.cv.toFixed(2)}, ` +
            `p50 ${stats.p50.toFixed(2)}ms p99 ${stats.p99.toFixed(2)}ms max ${stats.max.toFixed(
              2
            )}ms (warmupRatio ${ratio.toFixed(2)})`
        );
      }
      maybeGc();
      expect(stats.cv).toBeLessThan(1);
    }
    data.meta.patchedRows = TARGETS;
    fs.writeFileSync(RESULTS, JSON.stringify(data, null, 2));
    console.log('[remeasure] patched', RESULTS);
  }, 180_000);
});
