# PPL Lint — Specific Doc Links + Doc-Drift Tests (Plan)

**Author:** Hanyu Wei (`weihanyu@`)
**Date:** 2026-06-12
**Scope:** `packages/osd-monaco/src/ppl/lint/`
**Goal:** Replace every rule's generic `docUrl` with the most-specific verified anchor on the
published docs, and add tests that fail when those linked docs drift (move, lose the anchor, or
have their documenting text rewritten).

---

## 0. TL;DR

1. Today all **16** rules in `rules_catalog.json` point at one dead-ish generic URL:
   `https://opensearch.org/docs/latest/search-plugins/sql/ppl/functions/`. That base path is
   **stale** — the docs site migrated and the old `/search-plugins/sql/ppl/cmd/<x>/` paths now
   **404**. So today's links are both generic *and* broken on redirect for command pages.
2. Re-point each rule at a specific section of the **current** docs
   (`docs.opensearch.org/latest/sql-and-ppl/...`), chosen to match the rule's verified engine
   behavior — see §2. All 15 targets verified live (HTTP 200 + anchor id present); the 16th
   (`union`) is **unpublished upstream** and handled as a doc gap (§2.1, §5).
3. Add a **two-tier drift test** (§3): an always-on offline snapshot test (deterministic, catches
   code-side drift) plus an env-gated live test (fetches each URL, fails on 404 / missing anchor /
   changed documenting text). Normal CI stays green; drift is caught nightly / on demand.
4. File doc-improvement follow-ups for the rules with weak / absent published coverage (§5).

---

## 1. Current state (verified)

- **Single edit point.** Every detector emits `docUrl: config.docUrl`, sourced from
  `rules_catalog.json` → `Diagnostic.docUrl` → `marker.code.target` in `diagnostic_to_marker.ts`.
  Changing the link for a rule = changing one `docUrl` string in the catalog. No detector code
  changes needed for the link work itself.
- **16 rules**, all with `"docUrl": "https://opensearch.org/docs/latest/search-plugins/sql/ppl/functions/"`.
- **`catalog.ts`** validates each entry requires a non-empty `docUrl` string (`typeof … !== 'string'`
  drops the entry). It does **not** validate URL shape or specificity — that gap is what lets all 16
  share one generic link today.
- **Tests are pure offline Jest.** There is no network/nock/msw harness anywhere under
  `packages/osd-monaco/`. The live tier of the drift test (§3.2) must therefore be **opt-in** so it
  never runs in the sandboxed default `yarn test:jest`.

### 1.1 Published-docs ground truth (confirmed 2026-06-12)

- Base path migrated to **`docs.opensearch.org/latest/sql-and-ppl/...`**, generated from
  `opensearch-project/documentation-website` under `_sql-and-ppl/`.
  - Commands: `…/sql-and-ppl/ppl/commands/<cmd>/`
  - Functions: `…/sql-and-ppl/ppl/functions/<category>/`
  - Limitations: `…/sql-and-ppl/limitation/` (singular). **Its published headings differ from the
    `sql` repo's `docs/user/ppl/limitations/limitations.md`** — do not assume the repo's section
    titles exist on the published page.
  - Type/mapping behavior: `…/mappings/...` (separate from the SQL/PPL section).
- **Anchor slug algorithm** (verified against live HTML `id=` attributes): lowercase, spaces→`-`,
  punctuation dropped, **underscores preserved**. Examples confirmed live: `var_samp`, `max_match`,
  `string-to-numeric-type-conversion`, `disabling-object-fields`.
- **Ground-truth method** (WebFetch's summarizer returns the nav sidebar, not page bodies — use curl):

  ```bash
  # live rendered anchor ids
  curl -sL "https://docs.opensearch.org/latest/sql-and-ppl/ppl/commands/rex/" \
    | grep -oE '<h[1-4][^>]*id="[^"]*"' | sed -E 's/.*id="([^"]*)".*/\1/'
  # a soft-404 shows the id "oops-this-isnt-the-page-youre-looking-for"

  # verbatim headings / body text from source
  curl -sL "https://raw.githubusercontent.com/opensearch-project/documentation-website/main/_sql-and-ppl/ppl/commands/rex.md"
  ```

---

## 2. The mapping (recommended `docUrl` per rule)

Each row was chosen to match the rule's verified engine behavior (from each detector's
"Engine ground truth" docblock) and verified live: page returns HTTP 200 and the anchor `id`
exists in the rendered HTML. `Quality` is how well the anchored section actually documents the
behavior the rule flags.

| # | Rule id | New `docUrl` | Quality | Why this anchor |
|---|---------|--------------|---------|-----------------|
| 1 | `invalid-capture-group-name` | `…/sql-and-ppl/ppl/commands/rex/#parameters` | **exact** | rex Parameters table: "Group names must start with a letter and contain only letters and digits"; the page body also states capture-group names cannot contain underscores. |
| 2 | `unsupported-window-function-in-eventstats` | `…/sql-and-ppl/ppl/commands/eventstats/#aggregation-functions` | close | eventstats "Aggregation functions" lists the supported set; `row_number` is the only window-style fn. (`streamstats/#aggregation-functions` is the equivalent sibling.) |
| 3 | `dedup-consecutive-unsupported` | `…/sql-and-ppl/limitation/#unsupported-functionalities` | **exact** | Limitations page explicitly lists "`dedup` with `consecutive=true`" under V3/Calcite unsupported functionalities. |
| 4 | `replace-wildcard-asymmetry` | `…/sql-and-ppl/ppl/commands/replace/#limitations` | **exact** | replace Limitations covers wildcard-count symmetry. |
| 5 | `union-min-datasets` | *(doc gap — see §2.1)* | **no published coverage** | The `union` command page is **unpublished upstream**; live page soft-404s and the md is absent from the repo tree. |
| 6 | `multisearch-min-subsearch` | `…/sql-and-ppl/ppl/commands/multisearch/#limitations` | **exact** | multisearch Limitations states ≥2 subsearches required. |
| 7 | `disabled-join-type` | `…/sql-and-ppl/ppl/commands/join/#limitations` | **exact** | join Limitations covers `right`/`full`/`cross` being disabled by default. (`#configuration` is a fallback if Limitations is later restructured.) |
| 8 | `head-without-sort` | `…/sql-and-ppl/ppl/commands/head/` *(page root)* | weak | head page has no nondeterminism section; page root is the honest target. Doc-improvement follow-up filed (§5). |
| 9 | `field-validation` | `…/sql-and-ppl/ppl/commands/fields/` *(page root)* | weak | No published section documents unknown-field resolution. `fields` is the most on-topic command page. **Overrides the workflow's `identifiers/#case-sensitivity`, which is off-topic.** Follow-up (§5). |
| 10 | `expand-on-non-array` | `…/sql-and-ppl/ppl/commands/expand/#limitations` | **exact** | expand Limitations covers nested-array-only / use `mvexpand` for primitives. |
| 11 | `wildcard-source-zero-match` | `…/sql-and-ppl/ppl/commands/search/` *(page root)* | weak | Advisory host-side check; no published "zero-match" section. `search` (source patterns) is the closest command page. **Overrides the workflow's `identifiers/#regular-identifiers`.** Follow-up (§5). |
| 12 | `division-by-zero` | `…/sql-and-ppl/ppl/functions/expressions/#arithmetic-operators` | close | Arithmetic operators section is where `/` semantics live. (`functions/math/#divide` is an alternate.) |
| 13 | `agg-on-text` | `…/sql-and-ppl/ppl/functions/aggregations/` *(page root)* | weak | The null-on-text behavior isn't documented per-function; `#sum` (workflow pick) is misleadingly narrow. Page root + follow-up (§5). |
| 14 | `flat-object-subfield` | `…/mappings/supported-field-types/flat-object/#limitations` | close | flat_object field-type Limitations is the canonical home for "subfields not queryable", outside the SQL/PPL section. |
| 15 | `type-mismatch-numeric` | `…/sql-and-ppl/ppl/functions/conversion/#string-to-numeric-type-conversion` | **exact** | Documents string↔numeric coercion — exactly the `age = "thirty"` vs `age = "32"` distinction the rule encodes. |
| 16 | `enabled-false-object` | `…/mappings/mapping-parameters/enabled/#disabling-object-fields` | close | `enabled` mapping parameter doc, "Disabling object fields" — the canonical source for why such fields aren't indexed. |

> Full URLs use the prefix `https://docs.opensearch.org/latest`. All 15 published targets were
> confirmed live on 2026-06-12 (HTTP 200 + anchor `id` present).

### 2.1 The `union` doc gap

`union` exists in the `sql` repo source (`docs/user/ppl/cmd/union.md`, with a `## Limitations`
section stating "At least two datasets must be specified") but is **not yet published** to
`documentation-website` — it's absent from the repo's command tree and the live page soft-404s.

Decision: **do not** link `union-min-datasets` at the multisearch page (the workflow's auto-pick —
wrong command, would mislead users). Until `union` is published, set its `docUrl` to the PPL
commands index page root:

```
https://docs.opensearch.org/latest/sql-and-ppl/ppl/commands/
```

and add a tracked follow-up to re-point it at `…/ppl/commands/union/#limitations` once that page
is live. The drift test's `expectedUnpublished` list (§3.2) records this so the suite *reminds* us
when `union` appears (the live check will start passing for the future URL).

---

## 3. Doc-drift tests (two-tier)

**Goal restated:** if a linked doc page moves, drops its anchor, or rewrites the section that
documents a rule's behavior, a test fails so we notice and re-point the link.

Two complementary tiers. The offline tier is the safety net that always runs; the live tier is the
real drift detector that runs on a schedule / on demand.

### 3.1 Tier 1 — offline snapshot (always on)

**File:** `packages/osd-monaco/src/ppl/lint/__tests__/doc_links.test.ts`
**Companion fixture:** `packages/osd-monaco/src/ppl/lint/__tests__/__fixtures__/doc_links.snapshot.json`

A committed fixture pins, per rule id, the agreed link metadata:

```jsonc
// doc_links.snapshot.json  (one entry per rule)
{
  "invalid-capture-group-name": {
    "docUrl": "https://docs.opensearch.org/latest/sql-and-ppl/ppl/commands/rex/#parameters",
    "page":   "https://docs.opensearch.org/latest/sql-and-ppl/ppl/commands/rex/",
    "anchor": "parameters",
    "quality": "exact",
    "contentHash": "sha256:…",        // hash of the verbatim documenting excerpt (see §3.3)
    "excerpt": "Group names must start with a letter and contain only letters and digits."
  }
  // …16 entries
}
```

Tier-1 assertions (no network — pure structural invariants):

1. **Every catalog rule has a snapshot entry and vice-versa** (no rule silently un-pinned; no stale
   fixture rows). Iterate `getBundledCatalog()` and the fixture; assert equal id sets.
2. **Catalog `docUrl` === snapshot `docUrl`** for each rule. This is the deterministic guard: if
   someone edits a link in the catalog without updating the fixture (and the excerpt/hash behind
   it), this fails. Catches *code-side* drift immediately, offline, in normal CI.
3. **No rule still uses the legacy generic URL.** Assert no `docUrl` contains
   `search-plugins/sql/ppl` and none equals the old generic link — prevents regressing to a generic
   link. (Enforces the whole point of this change in CI.)
4. **URL shape sanity.** Each `docUrl` starts with `https://docs.opensearch.org/latest/`, and any
   rule whose snapshot `quality` is `exact`/`close` has a non-empty `anchor` (i.e. `#…`). `weak`
   rules are allowed to be page-root. This stops "specificity rot" — a future edit can't quietly
   downgrade an anchored link to a bare page without flipping `quality` and acknowledging it.
5. **`expectedUnpublished` honesty.** `union-min-datasets` (and any other gap rule) carries
   `"quality": "no-published-coverage"` and is listed in an `expectedUnpublished` array the test
   reads, so the suite documents the gap rather than asserting a dead anchor.

Tier 1 is fast, deterministic, and is the line that actually blocks a bad catalog edit in PR CI.

### 3.2 Tier 2 — live drift (env-gated; nightly / on-demand)

**File:** `packages/osd-monaco/src/ppl/lint/__tests__/doc_links.live.test.ts`

Guarded so it is a **no-op unless explicitly enabled**:

```ts
const LIVE = process.env.RUN_DOC_DRIFT_LIVE === '1';
(LIVE ? describe : describe.skip)('doc links — live drift', () => { … });
```

For each rule's snapshot entry, fetch the `page` URL (Node 22 global `fetch`; 15s timeout;
small retry for transient 5xx/network) and assert, with **two clearly separated signals**:

- **Link liveness (hard fail):**
  - HTTP status is 200, and
  - the response is **not** the soft-404 page — assert the body does **not** contain
    `id="oops-this-isnt-the-page-youre-looking-for"`, and
  - if the entry has an `anchor`, the body contains `id="<anchor>"`.
  This is the high-value signal: it catches page moves, slug renames, and section deletions —
  exactly the drift that silently breaks a "learn more" link.

- **Content drift (soft signal):** recompute the `contentHash` from the live documenting excerpt
  (§3.3) and compare to the snapshot. On mismatch, **fail by default** (so a behavior rewrite is
  surfaced and a human re-confirms the link still fits), with an opt-out
  `DOC_DRIFT_HASH=warn` that downgrades a hash-only mismatch to a `console.warn` for editorial-only
  churn. Link-liveness failures are never downgradable.

`expectedUnpublished` rules (e.g. `union`) are asserted the *other* way: their future URL is
*expected to 404 today*; if it starts resolving, the test fails with "union is now published —
re-point its docUrl and remove it from expectedUnpublished." That turns the gap into an actionable
signal instead of a forgotten TODO.

**Wiring:** add a script (e.g. `yarn test:doc-drift` → `RUN_DOC_DRIFT_LIVE=1 jest doc_links.live`)
and a nightly GitHub Actions job that runs only this file. It must not be added to the default
`build-test` matrix (network + external-site dependency would make required CI flaky).

### 3.3 The "documenting excerpt" + hash

For tiers to detect *content* drift without snapshotting whole pages, pin a **small verbatim
excerpt** (1–3 sentences) of the text under each anchor that actually documents the behavior
(captured during this mapping; e.g. rex's "Group names must start with a letter…"). Store the
excerpt and its `sha256` in the fixture. The live tier extracts the section under the anchor from
the fetched HTML/markdown, normalizes whitespace, and hashes it. This is deliberately *section-
scoped*, not page-scoped, so unrelated edits elsewhere on a big page (e.g. the `search` page) don't
trip the hash.

A tiny capture script (`scripts/capture_doc_snapshot.ts`, run manually) regenerates the fixture
from live docs after an intentional re-point, so updating the snapshot is one command, not hand-
editing hashes.

---

## 4. Implementation steps

1. **Edit `rules_catalog.json`** — set each rule's `docUrl` to its §2 value. (16 one-line changes;
   `union` → commands index root per §2.1.) No detector changes.
2. **Add the snapshot fixture** `__tests__/__fixtures__/doc_links.snapshot.json` with all 16 entries
   (docUrl, page, anchor, quality, excerpt, contentHash). Generate excerpts/hashes via the capture
   script so they match live text exactly.
3. **Add `__tests__/doc_links.test.ts`** (Tier 1, §3.1) — runs in normal `yarn test:jest`.
4. **Add `__tests__/doc_links.live.test.ts`** (Tier 2, §3.2) — `describe.skip` unless
   `RUN_DOC_DRIFT_LIVE=1`.
5. **Add `scripts/capture_doc_snapshot.ts`** + a `test:doc-drift` package script.
6. **Optional hardening:** extend `catalog.ts` `validateCatalogEntry` to reject the legacy generic
   URL and to require `https://docs.opensearch.org/` prefix — moves guard #3/#4 from test-time to
   load-time. (Keep it permissive enough that a future docs-domain change is a deliberate edit.)
7. **CI:** add the nightly workflow for Tier 2.
8. **Verify:** `yarn typecheck` + `yarn test:jest packages/osd-monaco/src/ppl/lint`; then
   `RUN_DOC_DRIFT_LIVE=1 yarn test:doc-drift` once locally to confirm all 15 live links pass and
   `union` is correctly flagged unpublished.

---

## 5. Doc-improvement follow-ups (separate from the link change)

These rules have weak / absent published coverage. The link change above points them at the closest
honest target; each deserves an upstream doc improvement so a future re-point can be `exact`:

| Rule | Gap | Suggested upstream fix |
|------|-----|------------------------|
| `union-min-datasets` | `union` command page unpublished | Get `_sql-and-ppl/ppl/commands/union.md` published; then re-point to `…/union/#limitations`. |
| `head-without-sort` | No nondeterminism note on `head` page | Add a note: `head` without preceding `sort` returns nondeterministic rows. |
| `field-validation` | No unknown-field-resolution section | Document field-resolution behavior (likely on `fields` or a PPL semantics page). |
| `wildcard-source-zero-match` | No zero-match note for `source=` wildcards | Add a note on `search`/source patterns matching zero indices. |
| `agg-on-text` | Null-on-text not documented per-aggregation | Note that numeric aggs on `text`/`keyword` return null (aggregations functions page). |

Track these in Taskei under the lint project (sql#5405); they are **not** blockers for the link +
drift-test change.

---

## 6. Why this shape

- **Catalog is the single source of truth**, so re-pointing is data-only and the offline test can
  assert catalog↔snapshot equality cheaply and deterministically.
- **Two tiers** because the literal ask ("tests fail when the linked docs change") requires the
  network, but OSD's default test run is offline/sandboxed — a pure-live test would make required CI
  flaky on docs-site availability. Tier 1 gives a deterministic always-on guard; Tier 2 gives the
  real external-drift signal where flakiness is acceptable (nightly / opt-in).
- **Liveness vs content split** so the common, high-value failure (link rot: 404 / missing anchor)
  is always a hard fail, while editorial wording churn can be tuned down — without ever masking a
  broken link.
- **Doc gaps are first-class** (`quality`, `expectedUnpublished`) rather than hidden behind a
  plausible-looking but wrong anchor (e.g. union→multisearch), which would mislead users and pass a
  naive liveness check.
