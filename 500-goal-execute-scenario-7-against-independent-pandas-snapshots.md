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
| Last Run | 2026-09-17T17:43Z (run 35253234863) |
| Run Count | 3 |
| Pending Tree | 04d0717e87250ff15d0f077b489cefd2370b5256 |
| Pending Run | pending push_to_pull_request_branch (run 35253234863), commit 481dfca9 |
| Verified Head | 659dce5d3109f943bfd71e20de1919d545699aa5 (run 1 candidate; CI run 35247646137 succeeded on this exact SHA) |
| Completed | false |
| Completed Reason | - |
| Blocked | false |
| Blocked Reason | - |

## Current Checkpoint

**IMPORTANT for the next run:** this run pushed commit `481dfca9` (tree
`04d0717e`) to PR #505, which fixes the 3 original review findings
(materialization overlap, `as` casts, Series shape check). It did **not**
publish a second local commit `ec17455f` that additionally fixes a
bigint/duration coercion bug flagged in a *follow-up* independent review
(issue #500 comment
https://github.com/githubnext/tsb/issues/500#issuecomment-5718507108),
because this run's single `push_to_pull_request_branch` call budget was
already used on `481dfca9`. That `ec17455f` commit only exists in this run's
local sandbox and is **not recoverable** in a future run (no artifact was
attached to a safe-output call for it) — the next run must redo this fix
from scratch on top of whatever the reconciled remote head turns out to be.

The bigint/duration fix (already implemented and verified once, so it can be
reapplied quickly) is:
- `tests/xval/strict_compare.ts`'s `encodeRuntimeScalar` must not coerce
  `bigint` to `Number(...)`/`.toString()` or `TimedeltaLike` to its raw
  `totalMs` number — both must be tagged (e.g.
  `{ kind: "BigInt", value: string }` / `{ kind: "Duration", totalMs:
  number }`) so a tagged runtime value can never structurally match an
  untagged snapshot number. `assertJsonEqual` must require both sides to
  carry the same tag before comparing tagged payloads (extract this into a
  small helper, e.g. `assertTaggedJsonEqual`, to stay under Biome's
  `noExcessiveCognitiveComplexity` limit of 15).
- Add regression tests proving:
  1. A bigint one-past `Number.MAX_SAFE_INTEGER` (`9007199254740993n`) is
     rejected against a snapshot expecting the rounded value
     `9007199254740992`.
  2. A `TimedeltaLike` (`{ totalMs: 1 }`) is rejected against a snapshot
     expecting the plain number `1`.

This run also replaced the last `as Record<string, unknown>` casts in
`scenario_7.test.ts`'s snapshot-shape guard with a reusable `hasProperties`
type-guard helper — that change is captured only in the same unpublished
`ec17455f` commit and must be redone alongside the bigint/duration fix.

## Human Guidance

- Read new non-bot issue comments before every run.
- (2026-09-17) Reviewer comment on issue #500 (comment 5717934163): fix
  materialization overlap, new `as` casts, and missing Series shape check
  before re-publishing — addressed in run 2's local commit, but run 2's
  merge-with-main broke publication (protected-file fallback to review issue
  #508). Re-addressed in run 3 without a main merge; published as `481dfca9`.
- (2026-09-17) Reviewer comment on issue #500 (comment 5718507108):
  independent review of run 2's artifact found the 3 original fixes correct,
  but flagged that `strict_compare.ts` coerces bigint/duration scalars into
  plain numbers, letting a bigint-off-by-one or a duration object wrongly
  match a plain-number snapshot value. Provided two regression-test snippets
  to add. **This run (run 3) implemented and verified this fix locally
  (commit `ec17455f`), but could not publish it — the push budget for this
  run was already spent on `481dfca9`. The next run must redo this fix.**
- (2026-09-17) Reviewer comment on issue #500 (comment 5718607300): use the
  new trusted branch-preparation helper; resume PR #505's actual head; do
  not merge `main` into this active PR; recover only the test-repair commit,
  not a merge-with-main bundle; fix the bigint/duration issue; keep failed
  publication evidence in history; request one safe-output push per run and
  say "pending", not "published", until remote reconciliation confirms it.
- (2026-09-17, run 3) Never merge `main` into this branch while a PR is
  active — a previous run's `main` merge pulled in unrelated protected
  workflow-file changes and caused `push_to_pull_request_branch` to silently
  fall back to a review issue (#508) instead of updating PR #505. Build
  directly on the PR's remote head.
- (2026-09-17, run 3) `push_to_pull_request_branch` is capped at 1 call per
  run. If more than one fix needs to be committed and pushed in a single
  run, commit them together as part of the same local commit sequence
  *before* the single push call, or expect to need an additional run to
  publish follow-up commits.

## Evidence Log

- Confirmed PR #505's remote branch head was still 659dce5d (tree d0cbf2fd)
  at the start of this run, matching run 1's published state — run 2's
  repair never landed due to a protected-file fallback (review issue #508)
  caused by run 2 merging `main` into the branch.
- This run: checked out `goal/500-...` at exactly
  `origin/goal/500-goal-execute-scenario-7-against-independent-pandas-snapshots`
  (659dce5d) with no merge, then re-applied the 3 original review fixes as
  commit `481dfca9` (tree `04d0717e`):
  - `bun test ./tests/xval/` → 25 pass, 0 fail.
  - `bun test ./tests/` → 9342 pass, 0 fail.
  - `bun run typecheck` → clean.
  - `bun x @biomejs/biome check` on the 3 files → 0 errors, only the 4
    pre-existing `noNodejsModules` warnings.
  - Pushed via `push_to_pull_request_branch` → returned
    `{"result":"success"}` with a recorded patch/bundle (no protected-file
    warning this time — diff touched only the 3 scoped test files).
- After that push succeeded, discovered and read the follow-up independent
  review (comment 5718507108) identifying the bigint/duration coercion bug.
  Reproduced both probes locally against the just-committed code: the
  bigint probe passed, but the duration-object probe failed (accepted a
  `{ totalMs: 1 }` actual value as matching plain number `1`), confirming
  the reviewer's finding.
- Fixed `encodeRuntimeScalar`/`assertJsonEqual` in `strict_compare.ts` to
  tag bigint/duration values instead of coercing them; extracted
  `assertTaggedJsonEqual` to keep cyclomatic complexity under Biome's
  threshold; replaced the last `as Record<string, unknown>` casts in
  `scenario_7.test.ts` with a `hasProperties` type-guard helper; added the
  two reviewer-specified regression tests plus a duration-match control.
  Committed locally as `ec17455f` (tree `821ba368`).
- Re-verified after the fix: `bun test ./tests/xval/` → 27 pass, 0 fail (2
  new regressions); `bun test ./tests/` → 9344 pass, 0 fail; `bun run
  typecheck` → clean; `bun x @biomejs/biome check` on the 3 files → 0
  errors, only the 4 pre-existing warnings; `python golden/generate.py` then
  `git diff --exit-code -- golden/generate.py golden/snapshots/` → no diff;
  `git diff --stat 659dce5d` → only the 3 scoped test files changed across
  both commits (244 insertions, 53 deletions, 0 new files).
- Attempted `push_to_pull_request_branch` for `ec17455f` — **rejected**:
  `"push_to_pull_request_branch limit reached — 1 of 1 already used this
  run"`. This commit therefore remains **local-only** and will not survive
  to the next run (each run starts from a fresh checkout of the published
  remote branch). This is recorded here so the next run knows to redo it
  rather than assuming it is already published or lost without explanation.
- Pending: exact-SHA CI run and PR #505 branch-head reconciliation for the
  *published* commit `481dfca9` (tree `04d0717e`) not yet verified on a
  later run. The unpublished `ec17455f` bigint/duration fix must be redone
  and included in that next push. Do not treat this run's local
  test/lint/typecheck results as sufficient for completion until the
  published SHA's CI is confirmed green and the bigint/duration fix has
  actually reached the PR.

## Run History

- Run 1 (workflow-run-id 35245402945, 2026-09-17T16:17Z): implemented
  scenario_7 executor + strict comparator + tests; verified locally;
  published PR #505 (head 659dce5d, CI run 35247646137 succeeded); human
  review found 3 unmet contract points (materialization overlap, new casts,
  missing Series shape check).
- Run 2 (workflow-run-id 35249352132, 2026-09-17T17:12Z): reconciled run 1's
  publication (confirmed matching tree + green CI), then attempted to repair
  the 3 review findings — but merged `main` into the branch first, which
  pulled in protected workflow-file changes and caused the push to fall back
  to review issue #508 instead of updating PR #505. Repair never actually
  published.
- Run 3 (workflow-run-id 35253234863, 2026-09-17T17:43Z): discovered run 2's
  publication never landed (remote tree still d0cbf2fd, review issue #508
  showed the protected-file fallback). Rebuilt the same 3 review fixes
  directly on the PR's unmodified remote head (659dce5d, no main merge) as
  commit 481dfca9; verified locally; pushed successfully via
  `push_to_pull_request_branch` (tool returned success, patch/bundle
  recorded). Then discovered and fixed a follow-up review finding
  (bigint/duration coercion in `strict_compare.ts`) as local commit
  ec17455f, verified locally, but could not publish it — the run's single
  push budget was already used. Pending remote reconciliation of 481dfca9 on
  a later run, which must also redo and publish the bigint/duration fix.
