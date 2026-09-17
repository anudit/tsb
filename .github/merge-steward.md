# Merge Steward policy

Merge Steward coordinates pull requests targeting `main`. The live coordinator
may dispatch a single, guarded Merge Steward Diagnosis workflow for an unresolved
exception. Automatic merging is **off** and no merge adapter is installed.

## Readiness

The policy retains the four CI requirements accepted on 2026-09-03:
`Test & Lint`, `Playground E2E (Playwright)`, `Build`, and
`Validate Python Examples`. Only `success` counts. Skipped, neutral, missing,
stale or incomplete jobs cannot establish readiness.

The path-filtered Wasm and bounded benchmark workers are inventoried as
advisory to the existing merge contract: their exact-commit results are required
by the corresponding Goal/Autoloop completion contracts, not newly installed
repository merge gates. They execute contributor code without secrets or write
tokens, keep failure artifacts, and are not Steward-dispatchable. Goal's cheap
work-selection preflight is also advisory, never implementation evidence.

Evidence comes from the latest associated CI PR run, or the current internal
Autoloop push run when no PR run exists. The coordinator verifies workflow path,
repository, PR/head association, run attempt, job identity and trusted workflow
contents. A run must begin after declared workflow and policy changes. Old
success cannot hide a newer pending or failed attempt. Unclassified jobs and
unsupported policy extensions block progress until reviewed.

GitHub branch protection remains authoritative and currently requires
`Test & Lint`; no additional required check is installed. Neither approvals nor
resolved review threads are currently mandatory in the accepted policy. Drafts,
`needs-review`, `mq:pause` and `mq:paused` prevent all automatic actions. A
requested-changes review also requires human attention. PRs changing automation
definitions require maintainer review.
That known review boundary, including newly unclassified jobs, is reported
deterministically as `attention / automation-review-required`; it never invokes
a diagnosis agent or repeats a human comment. Unknown policy ambiguity remains
eligible for guarded diagnosis.

## Live capabilities

- Trusted default-branch code resolves candidates and reconciles each PR under
  one concurrency group across PR, CI-completion and recovery events.
- The coordinator reloads current PR evidence before every effect and compares
  repository, PR, head, current base and trusted policy. A default-branch update
  makes an in-flight effect a no-op; a subsequent event replans it.
- Only `merge-steward-diagnose.lock.yml` is dispatchable, always from `main`.
  Reasons are `failure-exhausted`, `unknown-failure` and `policy-ambiguity`.
  Retry budget remains zero. Existing CI owns ordinary PR builds and retries.
- Diagnosis reuses the deterministic planner before model activation. It must
  match the expected head, base, policy digest and exception key, and be the
  first workflow run for that key. Workflow-run history supplies deduplication
  for its GitHub retention period; deleting that history also clears the record.
- The diagnosis agent is read-only. Comment and label outputs remain staged.
  Automatic missing-tool, incomplete-work and failure issues are disabled.
  Results and plans appear in Actions summaries and artifacts.
- No worker dispatch, branch update, run approval, label mutation, comment,
  deployment or merge is performed by the coordinator. Pages, Copilot setup,
  Autoloop, Goal, Evergreen and CI Doctor keep their existing triggers.

Green, pending, draft, paused, stale and duplicate events never need a model.
The coordinator exits after planning or dispatch rather than waiting for CI.
The recovery schedule runs twice an hour and also observes review changes.

## Operating it

Run **Merge Steward Reconcile** from `main` with a PR number, or leave it empty
for all open PRs to `main`. Set `observe_only` to preview without dispatching.
Set `defaults.operation_mode: observe` to disable all coordinator effects.
Existing branch rules and independent workflows remain in force.

Native squash auto-merge was recorded as an eventual capability in the earlier
observation policy. It needs a separate explicit activation decision and a
reviewed merge adapter. A future adapter must guard the expected head and
preserve main CI and Pages, because GitHub suppresses normal push-triggered
workflows after merges made with `GITHUB_TOKEN`. Changing `auto_merge` alone
cannot enable merging in this installation.

The machine-readable contract is `merge-steward.yml`, validated against the
bundled `merge-steward.schema.json`. The audited worker inventory is in
`merge-steward-inventory.md`. Run deterministic tests with
`node --test .github/merge-steward/*.test.mjs`; they also run inside `Test & Lint`.
Compile the diagnosis source with `gh aw compile merge-steward-diagnose --validate`
and commit its generated lock file together with the source.
