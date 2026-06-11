/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/* eslint-disable no-console */

/**
 * Axis 2 — debounce vs no-debounce over realistic typing sessions.
 *
 * Two parts:
 *  1. CORRECTNESS — validate the analytic trailing-edge model in
 *     debounce_model.ts against the REAL `scheduleLintHighlighting` semantics
 *     reproduced with Jest fake timers (a 500ms trailing-edge `setTimeout` that
 *     resets on every edit). This file is the ONLY benchmark file that touches
 *     fake timers; it never measures CPU (those numbers live in
 *     lint_perf.bench.test.ts), so there is no fake-timer/perf_hooks conflict.
 *  2. PROJECTION — combine the (validated) pass counts with the measured
 *     per-pass CPU from axis1_cpu.json to produce the with/without-debounce
 *     tables: passes, total CPU, first-marker latency, redundant passes.
 *
 * Always runs (it is fast and deterministic); the projection step degrades
 * gracefully to per-pass cost = 1.0ms placeholders when axis1_cpu.json is
 * absent (i.e. the CPU benchmark has not been run yet), and logs that it did.
 */

import fs from 'fs';
import path from 'path';
import {
  countWastedPasses,
  EditEvent,
  generateTypingSession,
  LINT_DEBOUNCE_MS,
  PROFILES,
  ProfileName,
  simulateDebounce,
  simulateNoDebounce,
} from './debounce_model';
import { CORPUS } from './corpus';

const RESULTS_DIR = path.join(__dirname, 'results');
const CPU_FILE = path.join(RESULTS_DIR, 'axis1_cpu.json');

/**
 * Reference implementation: drive the REAL trailing-edge debounce (the exact
 * shape of scheduleLintHighlighting in language.ts) with fake timers and count
 * how many times the lint callback actually fires. The events are dispatched at
 * their authored timestamps by advancing fake time between them.
 */
function runRealDebounce(events: EditEvent[], debounceMs: number): number {
  jest.useFakeTimers();
  let fires = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;

  // Mirror scheduleLintHighlighting: clear prior timer, arm a fresh one.
  const schedule = () => {
    if (timer !== undefined) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = undefined;
      fires += 1;
    }, debounceMs);
  };

  let prevT = 0;
  for (const ev of events) {
    const dt = ev.t - prevT;
    if (dt > 0) jest.advanceTimersByTime(dt);
    prevT = ev.t;
    schedule();
  }
  // Flush the trailing timer after the last edit.
  jest.advanceTimersByTime(debounceMs);
  jest.useRealTimers();
  return fires;
}

describe('Axis 2: debounce model correctness', () => {
  // Use representative queries spanning the size buckets.
  const queries = CORPUS.filter((q) =>
    [
      'tiny-head',
      'small-rex-bad',
      'medium-multi-pipe',
      'large-multi-rule',
      'xlarge-deep-pipeline',
    ].includes(q.id)
  );

  it('LINT_DEBOUNCE_MS matches the production constant (500)', () => {
    expect(LINT_DEBOUNCE_MS).toBe(500);
  });

  it.each(queries.flatMap((q) => PROFILES.map((p) => [q.id, p.name] as const)))(
    'analytic debounce pass-count matches real timers: %s / %s',
    (qid, profile) => {
      const q = CORPUS.find((c) => c.id === qid)!;
      const events = generateTypingSession(q.ppl, profile as ProfileName);
      const analytic = simulateDebounce(events, LINT_DEBOUNCE_MS).lintPasses;
      const real = runRealDebounce(events, LINT_DEBOUNCE_MS);
      expect(analytic).toBe(real);
    }
  );

  it('no-debounce pass count equals the number of edit events', () => {
    for (const q of queries) {
      for (const p of PROFILES) {
        const events = generateTypingSession(q.ppl, p.name);
        expect(simulateNoDebounce(events).lintPasses).toBe(events.length);
      }
    }
  });
});

interface PerPassCost {
  compiledP50: number;
  compiledP99: number;
  runtimeP50: number;
  runtimeP99: number;
}

/** Load measured per-pass cost by bucket, or null when the CPU bench is absent. */
function loadPerPassCost(): Record<string, PerPassCost> | null {
  if (!fs.existsSync(CPU_FILE)) return null;
  const data = JSON.parse(fs.readFileSync(CPU_FILE, 'utf8'));
  const byBucket: Record<string, PerPassCost> = {};
  for (const row of data.rows as any[]) {
    const b = (byBucket[row.bucket] ??= {
      compiledP50: 0,
      compiledP99: 0,
      runtimeP50: 0,
      runtimeP99: 0,
    });
    if (row.path === 'compiled-worker') {
      b.compiledP50 = row.stats.p50;
      b.compiledP99 = row.stats.p99;
    } else {
      b.runtimeP50 = row.stats.p50;
      b.runtimeP99 = row.stats.p99;
    }
  }
  return byBucket;
}

describe('Axis 2: debounce projection (passes, CPU, latency)', () => {
  it('produces the with/without-debounce session table', () => {
    const perPass = loadPerPassCost();
    if (!perPass) {
      console.warn(
        '[axis2] axis1_cpu.json not found — run lint_perf.bench.test.ts first for real CPU; ' +
          'using 1.0ms placeholder per pass so the pass-count/latency columns are still exact.'
      );
    }
    if (!fs.existsSync(RESULTS_DIR)) fs.mkdirSync(RESULTS_DIR, { recursive: true });

    const rows: any[] = [];
    // Use medium + large + xlarge — the buckets where per-pass CPU is non-trivial.
    const benchQueries = CORPUS.filter((q) =>
      ['medium-multi-pipe', 'large-multi-rule', 'xlarge-deep-pipeline'].includes(q.id)
    );

    for (const q of benchQueries) {
      const cost = perPass?.[q.bucket];
      for (const p of PROFILES) {
        const events = generateTypingSession(q.ppl, p.name);
        const nd = simulateNoDebounce(events);
        const db = simulateDebounce(events, LINT_DEBOUNCE_MS);

        // Redundant passes = passes whose content is not the final query, i.e.
        // results discarded by the staleness guard (the user kept typing). This
        // is "passes started but result discarded", per the review's framing.
        const ndRedundant = countWastedPasses(nd.passContents, q.ppl);
        const dbRedundant = countWastedPasses(db.passContents, q.ppl);

        // CPU projection for the main-thread (runtime) path — the one debounce
        // protects from UI jank. p50 used for "typical" total occupancy.
        const runtimeP50 = cost?.runtimeP50 ?? 1.0;
        const compiledP50 = cost?.compiledP50 ?? 1.0;

        // SETTLE LATENCY — the honest, universal debounce penalty: how long after
        // the user's LAST edit does the final/stable lint marker appear?
        //   no-debounce: the pass fires on the last edit → ≈ one per-pass CPU.
        //   debounce:    the trailing timer waits the full window → 500ms + CPU.
        // This is a flat +500ms regardless of typing profile, and is the right
        // number to weigh against the CPU/flicker savings (NOT the continuous-
        // typing "first marker" artifact, which conflates "first marker" with
        // "marker after typing stops").
        const settleNoDebounce = +runtimeP50.toFixed(2);
        const settleDebounce = +(LINT_DEBOUNCE_MS + runtimeP50).toFixed(2);

        // CONTINUOUS-TYPING first marker — when the very first lint marker appears
        // if the user never pauses. No-debounce shows a (flickering) marker on the
        // first fragment almost immediately; debounce shows nothing until the first
        // quiescent gap. Reported for transparency, clearly labelled.
        const ndFirstMarker = nd.passFireTimes.length ? nd.passFireTimes[0] : 0;
        const dbFirstMarker = db.passFireTimes.length ? db.passFireTimes[0] : 0;

        rows.push({
          query: q.id,
          bucket: q.bucket,
          profile: p.name,
          events: events.length,
          passes_noDebounce: nd.lintPasses,
          passes_debounce: db.lintPasses,
          passes_saved: nd.lintPasses - db.lintPasses,
          redundant_noDebounce: ndRedundant,
          redundant_debounce: dbRedundant,
          // Main-thread occupancy (runtime interpreter path) over the whole session:
          mainThreadMs_noDebounce: +(nd.lintPasses * runtimeP50).toFixed(2),
          mainThreadMs_debounce: +(db.lintPasses * runtimeP50).toFixed(2),
          // Worker CPU (off-main-thread) — informational, does not block UI:
          workerMs_noDebounce: +(nd.lintPasses * compiledP50).toFixed(2),
          workerMs_debounce: +(db.lintPasses * compiledP50).toFixed(2),
          // Settle latency: the honest, profile-independent debounce penalty.
          settleMs_noDebounce: settleNoDebounce,
          settleMs_debounce: settleDebounce,
          settlePenaltyMs: +(settleDebounce - settleNoDebounce).toFixed(2),
          // Continuous-typing first marker (transparency; labelled in report).
          firstMarkerMs_noDebounce: ndFirstMarker,
          firstMarkerMs_debounce: dbFirstMarker,
        });
      }
    }

    const out = {
      meta: {
        debounceMs: LINT_DEBOUNCE_MS,
        perPassCostSource: perPass ? 'measured (axis1_cpu.json)' : 'placeholder 1.0ms',
        note:
          'passes_noDebounce assumes one onDidChangeContent per single-character edit; ' +
          'a paste fires ONE event (see paste-then-tweak profile). Validate/syntax passes ' +
          'are NOT counted here — they are eager (one per keystroke) regardless of debounce.',
      },
      rows,
    };
    fs.writeFileSync(path.join(RESULTS_DIR, 'axis2_debounce.json'), JSON.stringify(out, null, 2));

    console.log(
      '\n  query                profile             events  pass(nd→db)  saved  mainMs(nd→db)  settleMs(nd→db)'
    );
    for (const r of rows) {
      console.log(
        `  ${r.query.padEnd(20)} ${r.profile.padEnd(18)} ${String(r.events).padStart(6)}  ` +
          `${String(r.passes_noDebounce).padStart(4)}→${String(r.passes_debounce).padStart(
            3
          )}    ` +
          `${String(r.passes_saved).padStart(4)}   ` +
          `${String(r.mainThreadMs_noDebounce).padStart(6)}→${String(
            r.mainThreadMs_debounce
          ).padStart(5)}   ` +
          `${String(r.settleMs_noDebounce).padStart(6)}→${String(r.settleMs_debounce).padStart(6)}`
      );
    }
    expect(rows.length).toBeGreaterThan(0);
  });
});
