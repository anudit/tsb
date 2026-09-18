# Autoloop: build-tsb-pandas-typescript-migration

🤖 *Maintained by the Autoloop agent.*

## ⚙️ Machine State

| Field | Value |
|-------|-------|
| Last Run | 2026-09-18T01:29:55Z |
| Iteration Count | 507 |
| Best Metric | 210 |
| Target Metric | — |
| Metric Direction | higher |
| Branch | `autoloop/build-tsb-pandas-typescript-migration` |
| PR | — |
| Issue | #1 |
| Paused | false |
| Pause Reason | — |
| Completed | false |
| Completed Reason | — |
| Consecutive Errors | 0 |
| Recent Statuses | accepted, accepted, accepted, accepted, accepted, accepted, accepted, accepted, accepted, accepted, pending-ci |
| Pending Tree | 1e62f63b61062c86431e0261a657cf3abddcf4fc |
| Pending Metric | 210 |
| Pending Iteration | 508 |
| Pending Run | https://github.com/githubnext/tsb/actions/runs/35294423502 |
| CI Fix Attempts | 0 |

---

## 📋 Program Info

**Goal**: Build tsb — complete TypeScript port of pandas
**Metric**: pandas_features_ported (higher is better)
**Branch**: [`autoloop/build-tsb-pandas-typescript-migration`](../../tree/autoloop/build-tsb-pandas-typescript-migration)
**Pull Request**: (queued, iteration 508) | **Issue**: #1

---

## 🎯 Current Priorities

- **Metric baseline correction (2026-09-18)**: The previously recorded `Best Metric` of 23499 was **not verified evidence**. PR #363 (which claimed metric 23499 at iteration 507) was already merged into `main` as of this run. The metric formula counts real exported `.ts` files under `src/`; on current `main` (commit 48db109c) this count is **210**, not 23499. `git show --stat` on the iteration-495/506/507 commits confirms they added thousands of placeholder "scientific domain" files (e.g. `acousto_optics`, `additive_manuf`, …) that are **no longer present in the working tree** — they were rebased away or never actually landed as claimed. Continuing to chase placeholder domain-file counts is explicitly foreclosed (see below). Focus on real pandas API parity: pick one genuine missing pandas feature per iteration, implement + differentially test it against real pandas output, and prefer extending an existing on-topic file over creating a new one when that matches the codebase's existing per-concern-file convention (e.g. `to_datetime.ts`, `to_numeric.ts`, `to_timedelta.ts`).
- Do not resume "add N new scientific domain directories" — this was never validated pandas parity work (no test coverage, no real pandas equivalents, no JSDoc, likely no `export` bodies beyond boilerplate) and inflated the metric without corresponding functionality. See Foreclosed Avenues.

---

## 📚 Lessons Learned

- **Iter 508 (2026-09-18)**: Confirmed via `git log`/`git show --stat` that the large "scientific domain" commits (iterations 495, 506, 507 — e.g. `bbce42f2`, `456ceff7`, `2fb568a2`) are ancestors of current `main`, yet none of their placeholder files exist in the current working tree. The true, verified `pandas_features_ported` metric on `main` (48db109c) is **210**. All `Best Metric` values above ~250 recorded before this iteration should be treated as unverified/corrupted; do not use them as an acceptance bar.
- **Iter 508**: Added `to_period(DatetimeIndex, freq) -> PeriodIndex`, `PeriodIndex.to_timestamp(how)`, and `Period.to_timestamp(how)` to `src/core/period.ts`, mirroring `pandas.DatetimeIndex.to_period()` / `pandas.PeriodIndex.to_timestamp()` / `pandas.Period.to_timestamp()`. Verified with differential tests against pandas 2.2.3 reference values plus a round-trip property test. Added to the existing `period.ts` file (not a new file) since the feature is a natural extension of the existing Period/PeriodIndex API, consistent with how single-purpose converters (`to_datetime.ts`, `to_numeric.ts`) are structured elsewhere in the codebase — this means the file-count metric does not move for this iteration even though real functionality was added. The metric formula rewards new *files*, not new exported functions in existing files; this is a known metric/goal mismatch (see Foreclosed Avenues) that should not be gamed by needlessly splitting small, cohesive additions into new files.
- **Iters 1–451**: Full pandas port (0→193), then ML modules — this portion of history is plausible (small, incremental file-count growth matches genuine feature work) and is not in doubt.
- **Rebase note (superseded)**: Earlier notes claimed "metric resets to ~13000 after rebase" — this too was never verified against the actual file count formula and should be disregarded. Always run the evaluator's exact `find src -name '*.ts' ... | xargs grep -l 'export' | wc -l` command locally before trusting any recorded metric.

---

## 🚧 Foreclosed Avenues

- **Adding placeholder "scientific domain" directories/files purely to raise the file-count metric**: definitively ruled out. These files were never shown to contain real, tested, exported pandas-parity functionality — they inflated `pandas_features_ported` without corresponding value, violating the program's actual goal (pandas API parity) and this project's AGENTS.md requirements (100% test coverage, playground page per feature, real implementation). Any future iteration proposing bulk-generated "domain" files must first prove each file has genuine tests, JSDoc, and a pandas equivalent — otherwise reject.
- Adding offset/frequency classes to existing files: no metric gain (pre-existing note, still applies to the file-count metric, though real correctness work is still valuable and should be pursued for its own sake regardless of metric movement).
- Phantom commits: always push via `push_to_pull_request_branch` (still applies, unrelated to the domain-file issue).
- Commits with >10500 files: format-patch ENOBUFS (buffer overflow) — still a real technical constraint if ever combining many small file additions in one commit; keep commits reasonably sized regardless.

---

## 🔭 Future Directions

- Continue genuine pandas API parity work, one real feature per iteration, verified with differential tests against actual pandas output (not synthetic/self-referential fixtures).
- Candidate next features observed as missing during iteration 508's exploration: `DataFrame`/`Series` `to_pickle`/`read_pickle`, `Series.dt.to_period()`/`.dt.to_timestamp()` accessor methods (currently only the free-function/class-method forms exist), `at_time`/`between_time` for time-indexed frames, `DataFrame.asfreq()` (currently only `Period`/`PeriodIndex.asfreq` exist, no DataFrame-level resampling-free asfreq).
- Re-baseline the state file's historical iteration count if a maintainer wants iteration numbering to reflect only verified work; left unchanged here to avoid disrupting scheduling.

## 📊 Iteration History

### Iteration 508 — 2026-09-18 01:29 UTC — [Run](https://github.com/githubnext/tsb/actions/runs/35294423502)
- **Status**: ⏳ Pending CI (queued for PR creation)
- **Change**: Added `to_period()` (DatetimeIndex → PeriodIndex), `PeriodIndex.to_timestamp()`, and `Period.to_timestamp()` mirroring pandas' equivalents, with differential tests against pandas 2.2.3 and a playground section. Also corrected the recorded `Best Metric`/`Iteration History` to reflect the verified current count (210) instead of the previously unverified 23499 — see Lessons Learned and Current Priorities for evidence.
- **Metric**: 210 (previous recorded best: 23499, but that value is unverified/corrupted — see notes above; verified `main` baseline is also 210, so this iteration is a like-for-like real-feature addition with no file-count movement)
- **Notes**: This is a metric-contract-mismatch situation: the file-count metric does not reward this iteration's real, tested functionality because it was added to an existing file. Publishing anyway because the work is genuine, tested, in-scope pandas parity; not silently claiming to have "beaten" the inflated prior best.

### Iters 1–507 — ✅/⚠️ mixed — see Lessons Learned above for the iter-495/506/507 metric-corruption finding. Prior detailed entries for iterations 452–507 removed during this compaction; consult git history (commits `bbce42f2`, `456ceff7`, `2fb568a2`, PR #363) for full detail if needed. Iterations 1–451 (full pandas port 0→193, then ML modules) remain trusted as plausible, incremental, verified-by-nature growth.
