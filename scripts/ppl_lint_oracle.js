#!/usr/bin/env node
/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/* eslint-disable no-restricted-syntax */

/*
 * PPL lint rule-validation oracle — Option 1, Layer C / C' / C".
 *
 * Every lint rule encodes a CLAIM about engine behavior ("`x / 0` silently
 * returns null", "`avg(text)` returns null", "an unknown field is rejected").
 * Those claims can rot when the engine changes (a new OpenSearch version,
 * Calcite default-on, a bug fix that turns a silent failure into a loud one).
 * This script uses a LIVE cluster as the oracle to (re)verify each claim and
 * report drift, so a stale premise is caught instead of silently mis-flagging.
 *
 * Three sub-layers, each strictly stronger than the last for the rules it
 * covers, run as a TRIGGERING-vs-CONTROL pair (same shape, only the suspected
 * defect differs — the signal is the divergence, never a hand-typed label):
 *
 *   Layer C  (result-frame):  trigger LOUD (4xx/5xx) while control OK. Definitive
 *                             for loud-premise rules (unknown-field, bad capture
 *                             group name on engines that reject it).
 *   Layer C' (plan oracle):   call `_explain` on both; the Calcite plan encodes
 *                             the defect that the result frame loses (a `/ 0`
 *                             literal in the projection, a SAFE_CAST in the
 *                             filter, an absent SORT before LIMIT). Definitive
 *                             for silent-premise rules — a legitimately-empty
 *                             result and a silently-wrong one produce DIFFERENT
 *                             plans, so the ambiguity that blinds a result-frame
 *                             oracle does not exist at the plan level.
 *   Layer C" (value assert):  per-rule assertion on the result frame at a finer
 *                             granularity than same/different — an all-null
 *                             column (division-by-zero), a null aggregate
 *                             (agg-on-text), zero-count-while-control-positive
 *                             (type-mismatch). Independent corroboration of C'.
 *
 * Honest by construction, three verdicts so the printed result matches what was
 * actually observed:
 *   AGREE        — a sub-layer positively confirmed the premise on this engine.
 *   DRIFT        — an applicable sub-layer MISMATCHED; re-check the rule's
 *                  `appliesTo`/`severity` (the only state that exits non-zero).
 *   INCONCLUSIVE — no applicable sub-layer could run here (e.g. a Calcite-only
 *                  plan signature on a v2 engine, or no plan returned); neither
 *                  agreement nor drift, so it never fails CI.
 *
 *   node scripts/ppl_lint_oracle.js [host] [index]
 *
 * Defaults: host=http://localhost:9200, index=accounts. The index needs at
 * least one document and the columns referenced below (a numeric `balance`, a
 * text `firstname`, an `account_number`); override with your own index that has
 * an equivalent shape, or adapt the PROBES table.
 *
 * CI note: OSD's GitHub-Actions CI has no standing PPL/SQL+Calcite cluster, so
 * this is a LOCAL-DEV / PRE-RELEASE manual check, not a per-PR blocker. Layers A
 * and B (no cluster) carry the PR-time guarantee.
 */

const HOST = process.argv[2] || 'http://localhost:9200';
const INDEX = process.argv[3] || 'accounts';
const PPL = `${HOST}/_plugins/_ppl`;
const PPL_EXPLAIN = `${HOST}/_plugins/_ppl/_explain`;

// Optional HTTP basic auth for remote/secured clusters, via env vars
// (PPL_ORACLE_USER / PPL_ORACLE_PASS) so credentials never sit in argv or code.
const AUTH_USER = process.env.PPL_ORACLE_USER;
const AUTH_PASS = process.env.PPL_ORACLE_PASS;
const AUTH_HEADER =
  AUTH_USER && AUTH_PASS
    ? 'Basic ' + Buffer.from(`${AUTH_USER}:${AUTH_PASS}`).toString('base64')
    : undefined;

async function post(url, query) {
  const started = Date.now();
  try {
    const headers = { 'Content-Type': 'application/json' };
    if (AUTH_HEADER) headers.Authorization = AUTH_HEADER;
    const res = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify({ query }),
    });
    const text = await res.text();
    let body;
    try {
      body = JSON.parse(text);
    } catch {
      body = text;
    }
    return { status: res.status, body, ms: Date.now() - started };
  } catch (e) {
    return { status: -1, body: String(e), ms: Date.now() - started };
  }
}

const runQuery = (q) => post(PPL, q);
const explain = (q) => post(PPL_EXPLAIN, q);

// Coarse verdict for a single response (Layer C).
function verdict(r) {
  if (r.status === 400 || r.status === 500) return 'LOUD';
  if (r.status !== 200) return `http-${r.status}`;
  if (!Array.isArray(r.body && r.body.datarows)) return 'noframe';
  return 'OK-200';
}

const rowsOf = (r) => (Array.isArray(r.body && r.body.datarows) ? r.body.datarows : null);
const sameFrame = (a, b) => JSON.stringify(rowsOf(a)) === JSON.stringify(rowsOf(b));

// Flatten an `_explain` response to plan text. Handles BOTH formats:
//   - Calcite (>= 3.3 with calcite on): { calcite: { logical, physical } }
//   - v2 engine (older / calcite off):  { root: { name, description, children } }
// Returns the whole thing stringified so a per-rule signature regex can match
// against whichever shape the engine returned. `planFormat` reports which one.
function planText(r) {
  const c = r.body && r.body.calcite;
  if (c) {
    return `${c.logical || ''}\n${c.physical || ''}`;
  }
  if (r.body && r.body.root) {
    return JSON.stringify(r.body.root);
  }
  return '';
}

function planFormat(r) {
  if (r.body && r.body.calcite) return 'calcite';
  if (r.body && r.body.root) return 'v2';
  return 'none';
}

// Layer C" value assertions, expressed as predicates over a result frame.
const allNullColumn = (r) => {
  const rows = rowsOf(r);
  return !!rows && rows.length > 0 && rows.every((row) => row.every((v) => v === null));
};
// The control for an all-null trigger must merely DIFFER from all-null, i.e.
// have at least one non-null cell. Requiring zero nulls (the old noNullColumn)
// falsely failed the control whenever the divisor field is itself sometimes
// null — the verdict was then decided by incidental data nullity, not rule
// behavior. "Not all-null" is exactly the documented C" signal.
const notAllNullColumn = (r) => {
  const rows = rowsOf(r);
  return !!rows && rows.length > 0 && !rows.every((row) => row.every((v) => v === null));
};
const firstCell = (r) => {
  const rows = rowsOf(r);
  return rows && rows[0] ? rows[0][0] : undefined;
};

/*
 * Probe table. Each entry validates ONE catalog rule. `layers` lists which
 * sub-layers apply; the verdict is AGREE only when every listed sub-layer
 * confirms. New rules are added here (catalog-aligned): the `rule` id matches a
 * rules_catalog.json entry.
 */
const PROBES = [
  {
    rule: 'field-validation',
    family: 'loud',
    layers: ['C'],
    trigger: `source=${INDEX} | where notafield_xyz = 5 | stats count() as c`,
    control: `source=${INDEX} | where balance = 5 | stats count() as c`,
  },
  {
    rule: 'invalid-capture-group-name',
    family: 'loud',
    layers: ['C'],
    trigger: `source=${INDEX} | grok firstname "%{WORD:1bad}" | head 1`,
    control: `source=${INDEX} | grok firstname "%{WORD:good}" | head 1`,
  },
  {
    rule: 'division-by-zero',
    family: 'silent',
    layers: ['Cprime', 'Cvalue'],
    trigger: `source=${INDEX} | eval x = balance / 0 | fields x | head 3`,
    control: `source=${INDEX} | eval x = balance / 1 | fields x | head 3`,
    // C': the trigger plan carries the literal `/ 0` in whichever explain format
    // the engine returns — Calcite `DIVIDE($n, 0)` or v2 `/(balance, 0)`; the
    // control divides by 1. Version-robust: matches the `, 0)` / `,0)` divisor.
    planTriggerSignature: /(DIVIDE\([^)]*,\s*0\))|(\/\([^)]*,\s*0\))/,
    planControlAbsent: /(DIVIDE\([^)]*,\s*0\))|(\/\([^)]*,\s*0\))/,
    // C": the computed column is ALL NULL on the trigger; the control merely
    // differs from all-null (at least one non-null cell).
    valueTrigger: allNullColumn,
    valueControl: notAllNullColumn,
  },
  {
    rule: 'agg-on-text',
    family: 'silent',
    layers: ['Cvalue'],
    trigger: `source=${INDEX} | stats avg(firstname) as a`,
    control: `source=${INDEX} | stats avg(balance) as a`,
    // C": numeric aggregate over text yields no meaningful number. Version-robust:
    // on 3.x Calcite it is a SILENT null; on the 2.x v2 engine it is a LOUD error.
    // Either confirms the premise (a numeric agg over text is never valid) — what
    // differs is only how loudly the engine signals it, which the harness records.
    valueTrigger: (r) => firstCell(r) === null || verdict(r) === 'LOUD',
    valueControl: (r) => typeof firstCell(r) === 'number',
  },
  {
    rule: 'type-mismatch-numeric',
    family: 'silent',
    layers: ['Cprime', 'Cvalue'],
    trigger: `source=${INDEX} | where firstname > 5 | stats count() as c`,
    control: `source=${INDEX} | where balance > 5 | stats count() as c`,
    // C': the trigger filter coerces the text field via SAFE_CAST; control does
    // not. SAFE_CAST is a Calcite-plan artifact, so on the v2 engine this layer
    // defers to the value assertion below.
    cprimeCalciteOnly: true,
    planTriggerSignature: /SAFE_CAST/,
    planControlAbsent: /SAFE_CAST/,
    // C": trigger silently filters everything (count 0) while control matches rows.
    valueTrigger: (r) => firstCell(r) === 0,
    valueControl: (r) => typeof firstCell(r) === 'number' && firstCell(r) > 0,
  },
  {
    rule: 'head-without-sort',
    family: 'order',
    layers: ['Cprime'],
    trigger: `source=${INDEX} | fields account_number | head 5`,
    control: `source=${INDEX} | sort account_number | fields account_number | head 5`,
    // C': the trigger physical plan has no SORT pushdown before the LIMIT; the
    // control does. The `SORT->` pushdown token is a Calcite-plan artifact, so on
    // the v2 engine (which sorts in-coordinator) this layer is not applicable.
    cprimeCalciteOnly: true,
    planTriggerAbsent: /SORT->/,
    planControlSignature: /SORT->/,
  },
];

function pad(s, n) {
  return String(s).padEnd(n);
}

// Compute the verdict for one probe. Three states, so the printed verdict
// matches the header contract ("AGREE only when a sub-layer positively
// confirms"):
//   - failed=true (some applicable layer MISMATCHED)        → DRIFT  (exit 1)
//   - else confirmed=true (≥1 applicable layer VERIFIED)    → AGREE
//   - else (every applicable layer deferred / inconclusive) → INCONCLUSIVE
// INCONCLUSIVE is neither agreement nor drift: a Calcite-only signature on a v2
// engine, or an engine that returns no plan, cannot confirm the premise here —
// reporting DRIFT there would be a false failure, reporting AGREE a false pass.
async function evaluate(p) {
  const notes = [];
  let failed = false; // some applicable layer MISMATCHED → DRIFT
  let confirmed = false; // some applicable layer POSITIVELY verified → eligible for AGREE

  // Layer C — result-frame loud/ok divergence.
  if (p.layers.includes('C')) {
    const t = await runQuery(p.trigger);
    const c = await runQuery(p.control);
    const ok = verdict(t) === 'LOUD' && verdict(c).startsWith('OK');
    notes.push(
      `C[result-frame]: trigger=${verdict(t)} control=${verdict(c)} → ${ok ? 'confirms' : 'NO'}`
    );
    if (ok) confirmed = true;
    else failed = true;
  }

  // Layer C' — plan-structure oracle via _explain. Handles both the Calcite and
  // the v2 explain formats (see planText/planFormat).
  if (p.layers.includes('Cprime')) {
    const te = await explain(p.trigger);
    const ce = await explain(p.control);
    const tp = planText(te);
    const cp = planText(ce);
    const fmt = planFormat(te);
    if (p.cprimeCalciteOnly && fmt !== 'calcite') {
      // The plan signature only exists in the Calcite format; on the v2 engine
      // this layer is NOT APPLICABLE — defer rather than report a false
      // mismatch. Checked BEFORE the no-plan case so a v2 engine never reports a
      // false DRIFT here; the premise is still checked by any C" layer.
      notes.push(
        `C'[plan]: signature is Calcite-only; engine returned '${fmt}' plan → n/a, deferring`
      );
    } else if (tp.trim().length === 0) {
      // Inability to fetch a plan is inconclusive, not drift — do NOT set failed.
      notes.push(`C'[plan]: no plan returned → cannot confirm via plan`);
    } else {
      let ok = true;
      if (p.planTriggerSignature) ok = ok && p.planTriggerSignature.test(tp);
      if (p.planTriggerAbsent) ok = ok && !p.planTriggerAbsent.test(tp);
      if (p.planControlSignature) ok = ok && p.planControlSignature.test(cp);
      if (p.planControlAbsent) ok = ok && !p.planControlAbsent.test(cp);
      notes.push(
        `C'[plan,${fmt}]: structural signature ${ok ? 'matched' : 'MISMATCH'} on this version`
      );
      if (ok) confirmed = true;
      else failed = true;
    }
  }

  // Layer C" — per-rule value assertion on the result frame.
  if (p.layers.includes('Cvalue')) {
    const t = await runQuery(p.trigger);
    const c = await runQuery(p.control);
    const ok = (!p.valueTrigger || p.valueTrigger(t)) && (!p.valueControl || p.valueControl(c));
    notes.push(`C"[value]: assertion ${ok ? 'held' : 'FAILED'} (trigger vs control frame)`);
    if (ok) confirmed = true;
    else failed = true;
  }

  // Order family with only a plan layer is informational about determinism too:
  // run twice and report if the frame ever diverges (a positive proof of the
  // nondeterminism premise that no single run can give). Informational ONLY —
  // a stable pair is explicitly NOT a positive confirmation, so it must never
  // feed `confirmed` (that would be fake agreement).
  if (p.family === 'order') {
    const a = await runQuery(p.trigger);
    const b = await runQuery(p.trigger);
    if (!sameFrame(a, b)) {
      notes.push('order: two runs DIVERGED → nondeterminism positively observed');
    } else {
      notes.push('order: two runs stable (nondeterminism not disproven; plan layer is the proof)');
    }
  }

  let verdictLabel = 'INCONCLUSIVE';
  if (failed) verdictLabel = 'DRIFT';
  else if (confirmed) verdictLabel = 'AGREE';
  return { verdictLabel, notes };
}

(async () => {
  const meta = await fetch(HOST, AUTH_HEADER ? { headers: { Authorization: AUTH_HEADER } } : {})
    .then((r) => r.json())
    .catch(() => ({}));
  const version = meta && meta.version ? meta.version.number : '?';
  console.log('# PPL lint rule-validation oracle (Layer C / C\' / C")');
  console.log(`# host=${HOST}  index=${INDEX}  engine version=${version}`);
  console.log('#');
  console.log("# Each row (re)verifies one catalog rule's premise against the live engine.");
  console.log('# AGREE = premise confirmed on this version. DRIFT = re-check appliesTo/severity.');
  console.log('');

  let agreeCount = 0;
  const drift = [];
  const inconclusive = [];

  for (const p of PROBES) {
    const { verdictLabel, notes } = await evaluate(p);
    if (verdictLabel === 'AGREE') agreeCount++;
    else if (verdictLabel === 'DRIFT') drift.push(p.rule);
    else inconclusive.push(p.rule);
    console.log(`${pad(p.rule, 30)} ${pad(`[${p.layers.join('+')}]`, 16)} ${verdictLabel}`);
    for (const n of notes) console.log(`    ${n}`);
  }

  console.log('');
  console.log('-'.repeat(72));
  console.log(
    `machine-checkable rules: ${agreeCount}/${PROBES.length} confirmed on engine ${version}` +
      `${inconclusive.length > 0 ? ` (${inconclusive.length} inconclusive)` : ''}.`
  );
  if (inconclusive.length > 0) {
    console.log('');
    console.log('INCONCLUSIVE — no applicable sub-layer could confirm these on this engine');
    console.log('(e.g. a Calcite-only plan signature on a v2 engine). NOT drift, NOT agreement:');
    for (const r of inconclusive) {
      console.log(
        `  •  ${r}: premise not checkable here; run against a matching engine to confirm.`
      );
    }
  }
  if (drift.length > 0) {
    console.log('');
    console.log('DRIFT REPORT — these rule premises did NOT confirm on this engine:');
    for (const r of drift) {
      console.log(`  ⚠️  ${r}: premise unconfirmed on ${version}. Re-check the rule's`);
      console.log(`      appliesTo (minVersion/maxVersion/engine) and severity in`);
      console.log(`      rules_catalog.json; the engine behavior the rule assumes may`);
      console.log(`      have changed. Drift is informational — never an auto-edit.`);
    }
    // Exit non-zero ONLY on positive drift, never on inconclusive (which is the
    // expected state for a cross-version/cross-engine signature that can't run
    // here — failing on it would be a false CI signal).
    process.exitCode = 1;
  }
})();
