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
| Last Run | 2026-09-17T15:53:36Z |
| Run Count | 2 |
| Pending Tree | - |
| Pending Run | - |
| Verified Head | 7e8bdd7655189d4cc52365ef247b20748a632e66 |
| Completed | true |
| Completed Reason | PR #499 open, mergeable_state=clean, all 8 CI check runs completed (7 success, 1 expected skip: OpenEvolve benchmark). Evidence includes rebuilt rust/pkg/ wasm artifacts, rust/src/rolling.rs fix (slice_median empty-slice panic; rolling_min_f64/rolling_max_f64 Infinity/-Infinity seeding), and new tests (tests/wasm/parity.test.ts, tests/wasm/fallback-isolated.test.ts, tests/wasm/fallback-check.ts). |
| Blocked | false |
| Blocked Reason | - |

## Current Checkpoint

- Reconciled publication: PR #499 confirmed open against candidate head
  7e8bdd7655189d4cc52365ef247b20748a632e66, mergeable_state clean, all 8
  check runs completed successfully (Build, Test & Lint, Build and verify
  real Wasm, Playground E2E, Validate Python Examples, Reconcile PR 499,
  Resolve pull requests all "success"; OpenEvolve benchmark "skipped" as
  expected/not required). Completion contract satisfied — issue closed out.

## Human Guidance

- Read new non-bot issue comments before every run.

## Evidence Log

- Run 1 (2026-09-17T15:50): Reproduced the `unreachable` Wasm trap
  (slice_median panic on empty Vec) and the min/max NaN-vs-Infinity
  semantic mismatch. Fixed in `rust/src/rolling.rs`. Added 8 Rust
  regression tests (`cargo test --locked --manifest-path rust/Cargo.toml`:
  50 passed, 0 failed). Rebuilt Wasm from source
  (`wasm-pack build --target nodejs rust/ --out-dir pkg`). Added
  `tests/wasm/parity.test.ts` (real Wasm-loaded wrapper calls) and
  `tests/wasm/fallback-isolated.test.ts` + `fallback-check.ts` (isolated
  child-process fallback verification). `bun test tests/wasm/`: 71 passed;
  `bun test tests/window/`: 199 passed; `bun run typecheck`: passed;
  `npx biome check`: 0 new errors. Committed to canonical branch (SHA
  a2e11dfd22d0aadfb198db766bf3645e76689486) and requested
  `create_pull_request`.
- Run 2 (2026-09-17T15:53): Confirmed PR #499 published
  (`https://github.com/githubnext/tsb/pull/499`), open, draft, base main,
  head `goal/496-...` at SHA 7e8bdd7655189d4cc52365ef247b20748a632e66,
  mergeable_state=clean. Verified via GitHub MCP `pull_request_read
  get_check_runs`: 8/8 check runs `status=completed`, 7 `conclusion=success`
  (Build, Test & Lint, Build and verify real Wasm, Playground E2E,
  Validate Python Examples, Reconcile PR 499, Resolve pull requests), 1
  `conclusion=skipped` (OpenEvolve benchmark — not a required gate).
  Confirmed changed files include `rust/src/rolling.rs`,
  `rust/pkg/tsb_wasm*` (rebuilt artifacts), and the three new
  `tests/wasm/*` test files. No git network access available in this
  sandbox (firewall blocks github.com for `git fetch`), so CI/PR state
  was verified via the read-only GitHub MCP tool instead of local `gh`.

## Run History

- Run 1: 2026-09-17T15:50 — implemented fix, added tests, opened PR #499.
- Run 2: 2026-09-17T15:53 — reconciled PR #499 publication and CI status;
  completion contract satisfied; marking goal completed.
