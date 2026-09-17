# Goal #500: Execute scenario 7 against independent pandas snapshots

This file is maintained by the Goal workflow. Maintainers may edit guidance
sections directly.

## Machine State

| Field | Value |
|-------|-------|
| Issue | #500 |
| Branch | `goal/500-goal-execute-scenario-7-against-independent-pandas-snapshots` |
| PR | pending (to be created this run) |
| Status | active |
| Last Run | 2026-09-17T16:17Z (run 35245402945) |
| Run Count | 1 |
| Pending Tree | d0cbf2fd79a049fa5904436483ca3d492ebf36c8 |
| Pending Run | pending create_pull_request (run 35245402945) |
| Verified Head | - |
| Completed | false |
| Completed Reason | - |
| Blocked | false |
| Blocked Reason | - |

## Current Checkpoint

Added tests/xval/scenario_7.ts (executor calling real tsb public API:
combineFirstSeries, dataFrameUpdate, whereSeries, maskSeries, alignDataFrame,
combineFirstDataFrame), tests/xval/strict_compare.ts (label-type-preserving
comparator), and tests/xval/scenario_7.test.ts (10 positive step assertions,
4 negative-control tests, 1 comparator regression test for numeric vs string
labels). This is the full checkpoint for the issue's completion contract in
one commit; no further implementation checkpoints are planned unless CI
reveals an issue.

## Human Guidance

- Read new non-bot issue comments before every run.

## Evidence Log

- Local commit cc2bb2503c1c898b09a22200c70b19ff22d91978 on
  goal/500-goal-execute-scenario-7-against-independent-pandas-snapshots
  (tree d0cbf2fd79a049fa5904436483ca3d492ebf36c8).
- `bun test ./tests/xval/` → 25 pass, 0 fail (scenario_7 suite: 17 pass, 256
  expect() calls; includes 10 positive steps, 4 negative controls, 1
  comparator regression).
- `bun test ./tests/` → 9342 pass, 0 fail.
- `bun run typecheck` → clean (no errors).
- `bun run biome check` on the three new files → 0 errors (2 pre-existing
  style warnings identical to those already present in runner.test.ts, e.g.
  noNodejsModules on `node:fs`/`node:path`, which the existing codebase
  already uses).
- `python golden/generate.py` (pandas 2.2.3, numpy 2.1.3) then
  `git diff --exit-code -- golden/generate.py golden/snapshots/` → no diff;
  committed golden data is unchanged.
- Negative controls confirmed to fail as expected (no-op whereSeries,
  wrong-join alignDataFrame, no-op alignDataFrame, no-op maskSeries) —
  these are intentional test failures proving the comparison path rejects
  incorrect output, not production test failures.
- Scope: only tests/xval/** files changed (3 new files, 0 modified,
  516 insertions). No changes to src/**, golden/generate.py,
  golden/snapshots/**, README.md, .autoloop/programs/**, workflows, or
  package scripts/dependencies.
- Pending: exact-SHA CI run and PR publication not yet verified on a later
  run (per Goal workflow reconciliation policy).

## Run History

- Run 1 (workflow-run-id 35245402945, 2026-09-17): implemented scenario_7
  executor + strict comparator + tests; verified locally; publishing PR this
  run; pending remote reconciliation.
