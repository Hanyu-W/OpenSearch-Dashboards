/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Microbenchmark timing + statistics utilities for the PPL lint benchmark.
 *
 * Timer choice: `performance.now()` from the Node built-in `perf_hooks` module,
 * NOT the global `process.hrtime` or global `performance`. Jest's sinonjs fake
 * timers patch `_global.process.hrtime` and `_global.performance`; the built-in
 * `perf_hooks` module is not patched, so importing it here keeps CPU
 * measurements honest even if another test in the worker activates fake timers.
 */
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { performance } = require('perf_hooks') as typeof import('perf_hooks');

export interface Stats {
  n: number;
  mean: number;
  p50: number;
  p90: number;
  p99: number;
  min: number;
  max: number;
  /** Coefficient of variation (stddev/mean) — a warmup-adequacy signal. */
  cv: number;
}

/** Percentile via linear interpolation on the sorted sample (R-7 / Excel-style). */
export function percentile(sortedAsc: number[], q: number): number {
  const n = sortedAsc.length;
  if (n === 0) return NaN;
  if (n === 1) return sortedAsc[0];
  const idx = q * (n - 1);
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  if (lo === hi) return sortedAsc[lo];
  const frac = idx - lo;
  return sortedAsc[lo] * (1 - frac) + sortedAsc[hi] * frac;
}

export function summarize(samples: number[]): Stats {
  const sorted = [...samples].sort((a, b) => a - b);
  const n = sorted.length;
  const mean = sorted.reduce((s, x) => s + x, 0) / n;
  const variance = sorted.reduce((s, x) => s + (x - mean) * (x - mean), 0) / n;
  const stddev = Math.sqrt(variance);
  return {
    n,
    mean,
    p50: percentile(sorted, 0.5),
    p90: percentile(sorted, 0.9),
    p99: percentile(sorted, 0.99),
    min: sorted[0],
    max: sorted[n - 1],
    cv: mean === 0 ? 0 : stddev / mean,
  };
}

export interface BenchOptions {
  warmupIters: number;
  measureIters: number;
  /** Called between corpus entries to flush GC if --expose-gc is available. */
  gcBetweenGroups?: boolean;
}

export const DEFAULT_BENCH: BenchOptions = {
  warmupIters: 100,
  // 5000 samples → P99 estimated from the top ~50 observations; stable across runs.
  measureIters: 5000,
  gcBetweenGroups: true,
};

let sink = 0;

/**
 * Time a thunk `measureIters` times after `warmupIters` warmups. The thunk must
 * return a number derived from its real work (e.g. diagnostics.length) which is
 * accumulated into a module-level sink, defeating V8 dead-code elimination of
 * the measured call. Returns per-iteration milliseconds.
 *
 * IMPORTANT: warm up with the SAME thunk (hence the same query) you measure, so
 * the ANTLR DFA cache entries for this query's token sequences are populated
 * before measurement and the samples reflect steady-state DFA-hit cost, not
 * one-time LL(*) fallback.
 */
export function timeThunk(work: () => number, opts: BenchOptions = DEFAULT_BENCH): number[] {
  for (let i = 0; i < opts.warmupIters; i++) {
    sink += work();
  }
  const samples: number[] = new Array(opts.measureIters);
  for (let i = 0; i < opts.measureIters; i++) {
    const t0 = performance.now();
    const r = work();
    const t1 = performance.now();
    samples[i] = t1 - t0;
    sink += r;
  }
  return samples;
}

/** Read + reset the sink so a caller can assert it was exercised (anti-DCE). */
export function readSink(): number {
  const v = sink;
  return v;
}

/** Flush GC between measurement groups when Node was started with --expose-gc. */
export function maybeGc(): void {
  const g = (global as unknown) as { gc?: () => void };
  if (typeof g.gc === 'function') {
    g.gc();
  }
}

/**
 * Warmup-adequacy guard: run the thunk twice back-to-back (each a short burst)
 * and return the ratio second/first. A ratio well below 1 means the first burst
 * was still paying cold-DFA cost; the caller can warn. Ratio near 1 = warm.
 */
export function warmupRatio(work: () => number, burst = 50): number {
  let a = 0;
  const a0 = performance.now();
  for (let i = 0; i < burst; i++) a += work();
  const a1 = performance.now();
  let b = 0;
  const b0 = performance.now();
  for (let i = 0; i < burst; i++) b += work();
  const b1 = performance.now();
  sink += a + b;
  const first = a1 - a0;
  const second = b1 - b0;
  return first === 0 ? 1 : second / first;
}
