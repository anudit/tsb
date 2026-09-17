# Goal #500: Execute scenario 7 against independent pandas snapshots

This file is maintained by the Goal workflow. Maintainers may edit guidance
sections directly.

## Machine State

| Field | Value |
|-------|-------|
| Issue | #500 |
| Branch | `goal/500-goal-execute-scenario-7-against-independent-pandas-snapshots` |
| PR | #505 |
| Status | active |
| Last Run | 2026-09-17T17:12Z (run 35249352132) |
| Run Count | 2 |
| Pending Tree | 43e0905f601fde2ae23ae85bdc65610d37fded37 |
| Pending Run | pending push_to_pull_request_branch (run 35249352132) |
| Verified Head | 659dce5d3109f943bfd71e20de1919d545699aa5 (run 1 candidate; CI run 35247646137 succeeded on this exact SHA — reconciled this run) |
| Completed | false |
| Completed Reason | - |
| Blocked | false |
| Blocked Reason | - |

## Current Checkpoint

Reconciled run 1's publication: PR #505's remote branch tree
(659dce5d3109f943bfd71e20de1919d545699aa5, tree
d0cbf2fd79a049fa5904436483ca3d492ebf36c8) matched the locally recorded
Pending Tree, and CI run 35247646137 (workflow `CI`, event `pull_request`,
head_sha 659dce5d) succeeded. That confirmed run 1's candidate published and
passed CI, but the human review comment
(https://github.com/githubnext/tsb/issues/500#issuecomment-5717934163) found
three unmet completion-contract requirements in that candidate:

1. `runner.test.ts` still replayed scenario_7 through the circular
   `materializeSnapshotStep`/`assertStep` path alongside the new executor,
   rather than instead of it.
2. `strict_compare.ts` and `scenario_7.test.ts` contained 14 `as` casts,
   violating the issue's and AGENTS.md's no-new-casts constraint.
3. `strict_compare.ts`'s Series branch never asserted `step.shape`, so a
   wrong-length actual Series with a probe-crafted index could pass.

This run repairs all three on the same canonical branch/PR:

- `tests/xval/runner.test.ts`: scenario_7 is now skipped in the
  materialization replay loop (with an explanatory comment); the
  `replayScenario7` function and its switch case are removed. Scenarios 1-6
  (50 steps) remain fixture/materialization-only checks, unchanged.
- `tests/xval/strict_compare.ts`: replaced every `as` cast with type guards
  (`isEncodedNaN`, `isMatrix`, `isVector`) and exhaustive `Scalar` member
  narrowing in `encodeRuntimeScalar` (number/string/boolean/bigint/Date/
  TimedeltaLike, all without casts). `assertSeriesStrict` now asserts
  `[...actual.shape]` equals `[...(step.shape ?? [])]`, mirroring the
  DataFrame branch's existing shape check.
- `tests/xval/scenario_7.test.ts`: replaced the `JSON.parse(...) as
  ScenarioSnapshot` cast with a type-guard-based `assertScenarioSnapshot`/
  `isScenarioSnapshotShape` narrowing helper. Added a new regression test
  ("Series shape mismatch must be rejected") proving a length-5 actual
  Series with a matching index is still rejected when `step.shape` is
  `[999]`, directly covering the reviewer's probe.

No other files changed; scope remains `tests/xval/**` only.

## Human Guidance

- Read new non-bot issue comments before every run.
- (2026-09-17) Reviewer comment on issue #500: fix materialization overlap,
  new `as` casts, and missing Series shape check before re-publishing;
  addressed this run.

## Evidence Log

- Local commit 7294b753 on
  goal/500-goal-execute-scenario-7-against-independent-pandas-snapshots
  (tree 43e0905f601fde2ae23ae85bdc65610d37fded37), built on top of a merge
  of `main` into the branch (commit ff072f04) to pick up unrelated upstream
  changes with no conflicts.
- Reconciliation of run 1: remote branch head 659dce5d matched Pending Tree
  d0cbf2fd; CI run 35247646137 (exact SHA) concluded `success`; PR #505
  `mergeable_state` was `clean`. This confirmed run 1's candidate published
  and passed CI, motivating a repair commit rather than a fresh checkpoint.
- `bun test ./tests/xval/` → 25 pass, 0 fail (includes new shape-mismatch
  regression test; scenario_7 suite now has 18 tests, up from 17, since
  runner.test.ts no longer contains a scenario_7 case and a new dedicated
  shape regression test was added in scenario_7.test.ts).
- `bun test ./tests/` → 9342 pass, 0 fail.
- `bun run typecheck` → clean (no errors).
- `bun x @biomejs/biome check` on the 3 changed files → 0 new-pattern
  warnings; only the 4 pre-existing `noNodejsModules` warnings for
  `node:fs`/`node:path` imports remain (identical pattern already present in
  the unmodified `helpers.ts`).
- `python golden/generate.py` (pandas 2.2.3, numpy 2.1.3, pinned versions
  confirmed via `python3 -c "import pandas, numpy; print(...)"`) →
  succeeded (wrote all 7 scenario files); `git diff --exit-code --
  golden/generate.py golden/snapshots/` → no diff.
- Scope check: `git status --porcelain` shows only
  `tests/xval/runner.test.ts`, `tests/xval/scenario_7.test.ts`,
  `tests/xval/strict_compare.ts` modified (0 new files this run, 104
  insertions / 55 deletions). No changes to `src/**`, `golden/generate.py`,
  `golden/snapshots/**`, `README.md`, `.autoloop/programs/**`, workflows, or
  package scripts/dependencies.
- Pending: exact-SHA CI run and PR publication for *this* commit
  (7294b753) not yet verified on a later run (per Goal workflow
  reconciliation policy). Do not treat this run's local test/lint/typecheck
  results as sufficient for completion until the published SHA's CI is
  confirmed green on a subsequent run.

## Run History

- Run 1 (workflow-run-id 35245402945, 2026-09-17T16:17Z): implemented
  scenario_7 executor + strict comparator + tests; verified locally;
  published PR #505 (head 659dce5d, CI run 35247646137 succeeded); human
  review found 3 unmet contract points (materialization overlap, new casts,
  missing Series shape check).
- Run 2 (workflow-run-id 35249352132, 2026-09-17T17:12Z): reconciled run 1's
  publication (confirmed matching tree + green CI), then repaired all 3
  review findings on the same branch/PR; verified locally; publishing this
  commit; pending remote reconciliation on a later run.
