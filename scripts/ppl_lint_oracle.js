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
 * Honest by construction: a rule reports AGREE only when its sub-layer(s)
 * positively confirm the premise on this engine; otherwise DRIFT (with the
 * observed verdicts) so the rule author can re-check `appliesTo`/`severity`.
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

async function post(url, query) {
  const started = Date.now();
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
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

// Pull the Calcite logical+physical plan text out of an `_explain` response.
function planText(r) {
  const c = r.body && r.body.calcite;
  if (!c) return '';
  return `${c.logical || ''}\n${c.physical || ''}`;
}

// Layer C" value assertions, expressed as predicates over a result frame.
const allNullColumn = (r) => {
  const rows = rowsOf(r);
  return !!rows && rows.length > 0 && rows.every((row) => row.every((v) => v === null));
};
const noNullColumn = (r) => {
  const rows = rowsOf(r);
  return !!rows && rows.length > 0 && rows.every((row) => row.every((v) => v !== null));
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
    // C': the trigger plan carries the literal `/ 0` (`DIVIDE($n, 0)`); control `/ 1`.
    planTriggerSignature: /DIVIDE\([^)]*,\s*0\)/,
    planControlAbsent: /DIVIDE\([^)]*,\s*0\)/,
    // C": the computed column is ALL NULL on the trigger, never null on control.
    valueTrigger: allNullColumn,
    valueControl: noNullColumn,
  },
  {
    rule: 'agg-on-text',
    family: 'silent',
    layers: ['Cvalue'],
    trigger: `source=${INDEX} | stats avg(firstname) as a`,
    control: `source=${INDEX} | stats avg(balance) as a`,
    // C": numeric aggregate over text resolves to NULL; over numeric it is a number.
    valueTrigger: (r) => firstCell(r) === null,
    valueControl: (r) => typeof firstCell(r) === 'number',
  },
  {
    rule: 'type-mismatch-numeric',
    family: 'silent',
    layers: ['Cprime', 'Cvalue'],
    trigger: `source=${INDEX} | where firstname > 5 | stats count() as c`,
    control: `source=${INDEX} | where balance > 5 | stats count() as c`,
    // C': the trigger filter coerces the text field via SAFE_CAST; control does not.
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
    // control does. Absence of a sort is exactly the nondeterminism premise.
    planTriggerAbsent: /SORT->/,
    planControlSignature: /SORT->/,
  },
];

function pad(s, n) {
  return String(s).padEnd(n);
}

async function evaluate(p) {
  const notes = [];
  let agree = true;

  // Layer C — result-frame loud/ok divergence.
  if (p.layers.includes('C')) {
    const t = await runQuery(p.trigger);
    const c = await runQuery(p.control);
    const ok = verdict(t) === 'LOUD' && verdict(c).startsWith('OK');
    notes.push(
      `C[result-frame]: trigger=${verdict(t)} control=${verdict(c)} → ${ok ? 'confirms' : 'NO'}`
    );
    agree = agree && ok;
  }

  // Layer C' — plan-structure oracle via _explain.
  if (p.layers.includes('Cprime')) {
    const tp = planText(await explain(p.trigger));
    const cp = planText(await explain(p.control));
    let ok = true;
    if (p.planTriggerSignature) ok = ok && p.planTriggerSignature.test(tp);
    if (p.planTriggerAbsent) ok = ok && !p.planTriggerAbsent.test(tp);
    if (p.planControlSignature) ok = ok && p.planControlSignature.test(cp);
    if (p.planControlAbsent) ok = ok && !p.planControlAbsent.test(cp);
    const hasPlan = tp.trim().length > 0;
    if (!hasPlan) {
      ok = false;
      notes.push(`C'[plan]: no Calcite plan returned (engine not Calcite?) → cannot confirm`);
    } else {
      notes.push(`C'[plan]: structural signature ${ok ? 'matched' : 'MISMATCH'} on this version`);
    }
    agree = agree && ok;
  }

  // Layer C" — per-rule value assertion on the result frame.
  if (p.layers.includes('Cvalue')) {
    const t = await runQuery(p.trigger);
    const c = await runQuery(p.control);
    const ok = (!p.valueTrigger || p.valueTrigger(t)) && (!p.valueControl || p.valueControl(c));
    notes.push(`C"[value]: assertion ${ok ? 'held' : 'FAILED'} (trigger vs control frame)`);
    agree = agree && ok;
  }

  // Order family with only a plan layer is informational about determinism too:
  // run twice and report if the frame ever diverges (a positive proof of the
  // nondeterminism premise that no single run can give).
  if (p.family === 'order') {
    const a = await runQuery(p.trigger);
    const b = await runQuery(p.trigger);
    if (!sameFrame(a, b)) {
      notes.push('order: two runs DIVERGED → nondeterminism positively observed');
    } else {
      notes.push('order: two runs stable (nondeterminism not disproven; plan layer is the proof)');
    }
  }

  return { agree, notes };
}

(async () => {
  const meta = await (await fetch(HOST)).json().catch(() => ({}));
  const version = meta && meta.version ? meta.version.number : '?';
  console.log('# PPL lint rule-validation oracle (Layer C / C\' / C")');
  console.log(`# host=${HOST}  index=${INDEX}  engine version=${version}`);
  console.log('#');
  console.log("# Each row (re)verifies one catalog rule's premise against the live engine.");
  console.log('# AGREE = premise confirmed on this version. DRIFT = re-check appliesTo/severity.');
  console.log('');

  let agreeCount = 0;
  const drift = [];

  for (const p of PROBES) {
    const { agree, notes } = await evaluate(p);
    if (agree) agreeCount++;
    else drift.push(p.rule);
    console.log(
      `${pad(p.rule, 30)} ${pad(`[${p.layers.join('+')}]`, 16)} ${agree ? 'AGREE' : 'DRIFT'}`
    );
    for (const n of notes) console.log(`    ${n}`);
  }

  console.log('');
  console.log('-'.repeat(72));
  console.log(
    `machine-checkable rules: ${agreeCount}/${PROBES.length} agree on engine ${version}.`
  );
  if (drift.length > 0) {
    console.log('');
    console.log('DRIFT REPORT — these rule premises did NOT confirm on this engine:');
    for (const r of drift) {
      console.log(`  ⚠️  ${r}: premise unconfirmed on ${version}. Re-check the rule's`);
      console.log(`      appliesTo (minVersion/maxVersion/engine) and severity in`);
      console.log(`      rules_catalog.json; the engine behavior the rule assumes may`);
      console.log(`      have changed. Drift is informational — never an auto-edit.`);
    }
    process.exitCode = 1;
  }
})();
