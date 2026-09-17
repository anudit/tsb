# Goal #496: Fix missing-value parity in real Wasm rolling kernels

This file is maintained by the Goal workflow. Maintainers may edit guidance
sections directly.

## Machine State

| Field | Value |
|-------|-------|
| Issue | #496 |
| Branch | `goal/496-goal-fix-missing-value-parity-in-real-wasm-rolling-kernels` |
| PR | #499 |
| Status | completed |
| Last Run | 2026-09-17T15:56Z (run 35243290517) |
| Run Count | 2 |
| Pending Tree | - |
| Pending Run | - |
| Verified Head | 7e8bdd7655189d4cc52365ef247b20748a632e66 |
| Completed | true |
| Completed Reason | CI and Wasm verification workflows both passed on the verified head SHA; check-runs (Build, Test & Lint, Build and verify real Wasm, Playground E2E) all completed with conclusion=success. |
| Blocked | false |
| Blocked Reason | - |

## Current Checkpoint

- Reconciled publication for the fix landed in run 1: `slice_median` empty-slice
  panic (root cause of the Wasm `unreachable` trap) fixed to return `NaN`, and
  `rolling_min_f64`/`rolling_max_f64` accumulator seeds corrected to
  `Infinity`/`-Infinity` to match the TypeScript fallback. Confirmed PR #499 is
  open, files touched match the declared scope
  (`rust/src/rolling.rs`, `rust/pkg/*`, `tests/wasm/*`), and both the `CI`
  workflow run (35242801708) and the dedicated `Wasm verification` workflow
  run (35242801522) completed with `conclusion: success` on head SHA
  `7e8bdd7655189d4cc52365ef247b20748a632e66`.

## Human Guidance

- Read new non-bot issue comments before every run.

## Evidence Log

- Run 1 (2026-09-17, run 35240671430): Reproduced and fixed `slice_median`
  empty-vector panic and `rolling_min_f64`/`rolling_max_f64` seeding bug in
  `rust/src/rolling.rs`. `cargo test`: 50/50 passed (8 new regression tests).
  `wasm-pack build --target nodejs`: rebuilt from source, doc-comment-only
  diff. `bun test tests/wasm/`: 71/71 passed (real accelerated wrappers +
  isolated child-process fallback check). `bun test tests/window/`: 199/199
  passed. `bun run typecheck`: passed. `npx biome check`: 0 new errors.
  Committed (SHA a2e11dfd22d0aadfb198db766bf3645e76689486) and requested
  `create_pull_request`.
- Run 2 (2026-09-17, run 35243290517): Verified via GitHub API (MCP,
  read-only) that PR #499 is open against `main`, head SHA
  `7e8bdd7655189d4cc52365ef247b20748a632e66`, changed files exactly
  `rust/src/rolling.rs`, `rust/pkg/{tsb_wasm.d.ts,tsb_wasm.js,tsb_wasm_bg.wasm,
  tsb_wasm_bg.wasm.d.ts}`, `tests/wasm/{fallback-check.ts,
  fallback-isolated.test.ts, parity.test.ts}`. `pull_request_read
  get_check_runs`: 8 check runs, all `completed`/`success` (or intentionally
  `skipped` for OpenEvolve benchmark), including "Build and verify real Wasm"
  and "Test & Lint". `actions_list list_workflow_runs` filtered on head SHA
  confirms the `CI` workflow (run 35242801708) and the `Wasm verification`
  workflow (run 35242801522, path `.github/workflows/wasm-verification.yml`)
  both completed with `conclusion: success`. No pending or failing required
  checks remain on this head SHA.

## Run History

- Run 1: 2026-09-17T15:50:04Z — implemented fix, added tests, opened PR #499
  (pending publication/CI confirmation).
- Run 2: 2026-09-17T15:56Z — reconciled: confirmed PR #499 published, CI and
  Wasm verification workflows green on head SHA
  `7e8bdd7655189d4cc52365ef247b20748a632e66`. Marked goal complete.
