# Goal #500: Execute scenario 7 against independent pandas snapshots

This file is maintained by the Goal workflow. Maintainers may edit guidance
sections directly.

## Machine State

| Field | Value |
|-------|-------|
| Issue | #500 |
| Branch | `goal/500-goal-execute-scenario-7-against-independent-pandas-snapshots` |
| PR | #505 |
| Status | completed |
| Last Run | 2026-09-17T18:53Z (run 35261222408) |
| Run Count | 5 |
| Pending Tree | - |
| Pending Run | - |
| Verified Head | 38e876329d9ab4cfd9eb02e82513b0fe1abec60e (tree 4fec5aef851162c2a92b9ec8624dc43c08fcb573) — this run confirmed via `git rev-parse` that the local synced branch head's tree matches the pending tree recorded at the end of run 4, i.e. commit `4d5c7bf1` did land on PR #505 (the framework added a same-tree "ci: trigger checks" commit on top). Independently confirmed via authenticated MCP `pull_request_read` (PR #505 `head.sha` = this exact SHA, `mergeable_state: clean`, still `draft`). |
| Completed | true |
| Completed Reason | All 6 completion-contract points satisfied with evidence gathered this run against the exact published head 38e87632: (1)(2) `tests/xval/scenario_7.ts`/`strict_compare.ts` build inputs independently from `golden/generate.py` literals and call the real public tsb API, comparing all 10 steps with label-type-preserving strict comparison; (3) 4 negative-control tests + numeric/string label regression test present and passing; (4) scenario 7 no longer uses `materializeSnapshotStep`, other scenarios' materialization-only checks untouched (`git diff --stat` confirms only `tests/xval/**` changed since main); (5) dtype/in-place-mutation limits documented in code comments and PR body, not silently normalized; (6) native CI run 35261251110 for this exact head shows `conclusion: success` with all 4 required jobs (Test & Lint, Playground E2E, Build, Validate Python Examples) individually `completed`/`success`, verified via the trusted `automation_ci.py rest-status` helper. |
| Blocked | false |
| Blocked Reason | - |

## Current Checkpoint

**Completion reconciliation (run 5, this run):** Followed the maintainer's
final-reconciliation instructions (issue comment 5719625658). Read the
read-only branch-state snapshot (`38e876...` head), synced/verified the
branch offline, then independently re-derived every fact rather than
trusting prior memory:

- `git rev-parse HEAD^{tree}` on the synced branch == `git rev-parse
  4d5c7bf1^{tree}` == `4fec5aef851162c2a92b9ec8624dc43c08fcb573` — proves the
  last checkpoint's tree is unchanged all the way to the current head; the
  extra commit on top (`38e87632`, "ci: trigger checks") is a same-tree,
  CI-trigger-only commit, not a content change.
- Authenticated MCP `pull_request_read` on PR #505: `head.sha ==
  38e876329d9ab4cfd9eb02e82513b0fe1abec60e`, `state: open`, `draft: true`,
  `mergeable_state: clean` — confirms this tree is genuinely the PR's real,
  current remote head (not stale local state).
- Authenticated MCP `actions_list` (`list_workflow_runs`, full first page,
  `total_count` preserved) + `mcp-select` helper: resolved run
  `35261251110` as the run whose `head_sha` matches the actual head exactly.
- Authenticated MCP `actions_get`/`get_workflow_run` + `list_workflow_jobs`
  for that run, validated via `automation_ci.py rest-status`: returned
  `success`. All four required jobs (`Test & Lint`, `Validate Python
  Examples`, `Playground E2E (Playwright)`, `Build`) are individually
  `status: completed`, `conclusion: success`.
- Re-ran the full local evidence suite directly on this exact checked-out
  head (not from memory): `bun test ./tests/xval/` → 27 pass, 0 fail, 15981
  expect() calls; `bun run typecheck` → clean (tsc --noEmit, exit 0);
  `bun run lint` → exit 0 (1262 pre-existing warnings only, no new errors);
  `python golden/generate.py` (pandas 2.2.3, numpy 2.1.3) then `git diff
  --exit-code -- golden/generate.py golden/snapshots/` → no diff.
- `grep` across the three new/changed xval files confirmed zero `as `
  casts, `any`, or `@ts-ignore` (only comment-text matches of the word
  "as"). `git diff --stat` from `main` (7b200b07) confirms only
  `tests/xval/**` changed (4 files, 733 insertions, 26 deletions), matching
  the scope constraint.

All 6 completion contract points (see Completed Reason above) are satisfied
by this exact-head evidence. No code change was needed this run — this was
a pure reconciliation/acceptance run per the workflow's rules. Marked
`Completed: true`, applying `goal-completed` and removing `goal`.

**Prior reconciliation (run 4):** independent review (issue #500 comment
5719873...) confirmed PR #505's actual observed head after run 3 was
`ec17455f` (tree `821ba368`), containing **both** `481dfca9` and `ec17455f`
— the bigint/duration fix was in fact published despite run 3's
`push_to_pull_request_branch` call limit message; the prior run's memory
claiming it was unpublished/unrecoverable was stale and has been corrected
above. This run re-verified that head directly (`git log`/`git diff` against
the actual checked-out branch, not from memory) before making any change.

CI for that exact head (run 35255712600) is `action_required` with 0 jobs,
not a pass — the configured CI-trigger token's guard only fires an extra
commit for exactly 1 new commit, and this head carries 2 new commits since
`659dce5d`, so it never got a fresh CI run. This is a known, intentional
security guard (do not change token scope/approval settings to work around
it).

**This run's change:** removed the single remaining `as const` type
assertion in `tests/xval/scenario_7.test.ts` (flagged by review as the last
unmet "no new `as` casts" contract point), replacing it with an explicit
readonly union-type array annotation — no behavior change, `hasProperties`
still narrows without a cast. Committed as `4d5c7bf1` (tree `4fec5aef`) on
top of the real published head `ec17455f`, with no `main` merge.

Verification on this new commit:
- `bun test ./tests/xval/` → 27 pass, 0 fail (same as prior baseline).
- `bun test ./tests/` → 9344 pass, 0 fail (same as prior baseline).
- `bun run typecheck` → clean (initially caught 7 new `noPropertyAccessFromIndexSignature`-style TS4111 errors from the first attempt using `readonly string[]`; fixed by using an explicit readonly union-literal array type instead, then typecheck passed clean).
- `bun x @biomejs/biome check` on the 3 xval files → 0 errors, only the 4 pre-existing `noNodejsModules` warnings.
- `python golden/generate.py` then `git diff --exit-code -- golden/generate.py golden/snapshots/` → no diff.
- `git diff --stat` from the actual PR head (`ec17455f`) → only `tests/xval/scenario_7.test.ts` changed, 8 insertions/8 deletions.

Requested exactly one `push_to_pull_request_branch` call this run for
`4d5c7bf1`. Publication and its own exact-SHA CI run remain pending until a
later run reconciles the actual remote branch head and CI evidence — do not
treat this run's local verification as sufficient for completion.


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
  to add. Run 3 implemented this as local commit `ec17455f`; run 4 confirmed
  (via authenticated MCP read) that it was in fact published to PR #505
  alongside `481dfca9`, contrary to run 3's own uncertainty about it.
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
- (2026-09-17) Reviewer comment on issue #500 (comment 5719...): **trust
  actual observed remote head/tree over prior run's own narrative about what
  did/didn't publish.** Run 3's memory incorrectly claimed `ec17455f` was
  unpublished/unrecoverable; the real PR #505 head already included it. Run
  4 always re-reads the actual branch/PR via `git log`/authenticated MCP
  before trusting memory's publication claims. Also: the CI-trigger token
  only fires an extra commit when exactly 1 new commit is pushed at once;
  pushing 2+ commits together means no fresh CI run triggers automatically,
  so `action_required`/no-jobs is expected in that case, not a failure to
  fix — do not touch the token/approval configuration to work around it.

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
- **Run 4 (this run):** re-verified the actual PR #505 head via
  authenticated MCP `pull_request_read` — confirmed `ec17455f` (tree
  `821ba368`) is the real published head, i.e. run 3's bigint/duration fix
  *was* published despite its own push-limit rejection message. CI for that
  exact head (run 35255712600) is `action_required` (0 jobs) — per reviewer
  explanation, the CI-trigger token's guard only fires for exactly 1 new
  commit per push, and this head carried 2. Fixed the last outstanding
  contract point (removed `as const` in `tests/xval/scenario_7.test.ts`,
  line 66) as new commit `4d5c7bf1` (tree `4fec5aef`) directly on top of
  `ec17455f`, no `main` merge. Verified: `bun test ./tests/xval/` → 27
  pass, 0 fail; `bun test ./tests/` → 9344 pass, 0 fail; `bun run
  typecheck` → clean (after switching from `readonly string[]` to an
  explicit readonly union-literal array type to avoid new TS4111 errors);
  `bun x @biomejs/biome check` on the 3 xval files → 0 errors, 4
  pre-existing warnings; `python golden/generate.py` +
  `git diff --exit-code` → no diff; `git diff --stat` from `ec17455f` →
  only `tests/xval/scenario_7.test.ts` changed (8 insertions, 8 deletions).
  Requested one `push_to_pull_request_branch` call for `4d5c7bf1`. Pending:
  reconciliation of this new commit's actual remote landing and its own
  exact-SHA CI run on a later run — this is not yet completion evidence.

## Run History

- Run 5 (workflow-run-id 35261222408, 2026-09-17T18:53Z): pure
  reconciliation/acceptance run, no code changes. Independently re-verified
  every fact: local tree == remote PR #505 head tree (`4fec5aef`, via
  `38e876329d9ab4cfd9eb02e82513b0fe1abec60e`); native CI run 35261251110 for
  that exact head is `success` with all 4 required jobs individually green
  (verified via authenticated MCP + `automation_ci.py rest-status`);
  re-ran full local test/typecheck/lint/golden-regen suite directly on the
  checked-out head with matching results; confirmed no `as` casts/`any`/
  `@ts-ignore` and scope confined to `tests/xval/**`. All 6 completion
  contract points satisfied. Marked Goal #500 completed; applied
  `goal-completed`, removed `goal`. PR #505 left open/draft for maintainer
  review/merge.
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
- Run 4 (workflow-run-id 35259997105, 2026-09-17T18:44Z): reconciled via
  authenticated MCP that PR #505's actual head is `ec17455f`, containing
  both `481dfca9` and run 3's bigint/duration fix — correcting run 3's own
  mistaken "unpublished" claim. Confirmed CI on that exact head is
  `action_required`/0-jobs due to the CI-trigger token's 1-new-commit-only
  guard (2 commits were pushed together), not a failure. Fixed the last
  contract gap (removed `as const` in `scenario_7.test.ts`) as commit
  `4d5c7bf1`; verified full local evidence; requested one
  `push_to_pull_request_branch` push. Remote landing + CI for `4d5c7bf1`
  pending reconciliation on a later run.
