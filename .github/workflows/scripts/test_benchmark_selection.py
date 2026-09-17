"""A benchmark change must select bounded, exact pairs on the actual PR head."""
import json
from pathlib import Path
import subprocess
import tempfile
import unittest
from unittest.mock import patch

import benchmark_selection as selection


class BenchmarkSelectionTest(unittest.TestCase):
    def test_exact_changed_pairs_are_deduplicated_not_the_whole_corpus(self):
        result = selection.select_pairs("pull_request", {"join", "join_outer", "rolling_mean"}, [
            "benchmarks/tsb/bench_join.ts", "benchmarks/pandas/bench_join.py", "src/join.ts",
        ], "")
        self.assertEqual(result["pairs"], ["join"])

    def test_lookalike_and_injected_paths_are_not_pair_names(self):
        result = selection.select_pairs("pull_request", {"join"}, [
            "nested/benchmarks/tsb/bench_join.ts", "benchmarks/tsb/bench_join.ts\nother",
            "benchmarks/tsb/../bench_join.ts", "benchmarks/tsb/bench_join.ts; echo unsafe",
            "benchmarks/tsb/bench_join.ts.bak",
        ], "")
        self.assertEqual(result["pairs"], [])

    def test_runner_or_worker_edits_include_smoke_and_every_changed_pair(self):
        available = set(selection.SMOKE_PAIRS) | {"other", "unchanged"}
        for path in selection.SMOKE_PATHS:
            with self.subTest(path=path):
                result = selection.select_pairs("pull_request", available, [path, "benchmarks/tsb/bench_other.ts"], "")
                self.assertEqual(result["pairs"], sorted(set(selection.SMOKE_PAIRS) | {"other"}))
                self.assertEqual(result["reason"], "runner_or_worker_smoke_and_changed_pairs")

    def test_runner_only_edits_still_select_just_fixed_smoke(self):
        available = set(selection.SMOKE_PAIRS) | {"unchanged"}
        result = selection.select_pairs("pull_request", available, ["benchmarks/runner.py"], "")
        self.assertEqual(result["pairs"], sorted(selection.SMOKE_PAIRS))

    def test_smoke_and_changed_pair_union_remains_bounded(self):
        changed = {f"pair{index}" for index in range(selection.MAX_PAIRS - len(selection.SMOKE_PAIRS) + 1)}
        available = set(selection.SMOKE_PAIRS) | changed
        paths = ["benchmarks/runner.py"] + [f"benchmarks/tsb/bench_{name}.ts" for name in changed]
        with self.assertRaisesRegex(ValueError, "tranche limit"):
            selection.select_pairs("pull_request", available, paths, "")

    def test_both_deleted_sides_are_explicit_not_fabricated_results(self):
        result = selection.select_pairs("pull_request", {"join"}, ["benchmarks/tsb/bench_removed.ts"], "")
        self.assertEqual(result["pairs"], [])
        self.assertEqual(result["removed_pairs"], ["removed"])

    def test_one_remaining_side_fails_for_additions_deletions_and_mixed_smoke(self):
        for changed in (
            ["benchmarks/tsb/bench_incomplete.ts"],
            ["benchmarks/pandas/bench_incomplete.py"],
            ["benchmarks/runner.py", "benchmarks/tsb/bench_incomplete.ts"],
        ):
            with self.subTest(changed=changed), self.assertRaises(selection.IncompletePairError) as caught:
                selection.select_pairs("pull_request", set(selection.SMOKE_PAIRS), changed, "",
                                       set(selection.SMOKE_PAIRS) | {"incomplete"})
            self.assertEqual(caught.exception.names, ["incomplete"])

    def test_manual_input_validates_names_and_deduplicates(self):
        result = selection.select_pairs("workflow_dispatch", {"join", "rolling_mean"}, [], " join,rolling_mean,join ")
        self.assertEqual(result["pairs"], ["join", "rolling_mean"])
        for value in ("", "join,", "join,missing", "join; echo unsafe", "$(secret)", "../join", "join\nother"):
            with self.subTest(value=value), self.assertRaises(ValueError):
                selection.select_pairs("workflow_dispatch", {"join"}, [], value)

    def test_large_change_or_manual_request_fails_without_silent_sampling(self):
        names = {f"pair{index}" for index in range(selection.MAX_PAIRS + 1)}
        with self.assertRaisesRegex(ValueError, "tranche limit"):
            selection.select_pairs("pull_request", names, [f"benchmarks/tsb/bench_{name}.ts" for name in names], "")
        with self.assertRaisesRegex(ValueError, "tranche limit"):
            selection.select_pairs("workflow_dispatch", names, [], ",".join(names))

    def test_missing_smoke_pair_fails_visibly(self):
        with self.assertRaisesRegex(ValueError, "do not exist"):
            selection.select_pairs("pull_request", {"join"}, ["benchmarks/runner.py"], "")

    def test_diff_is_nul_delimited_and_passes_validated_shas_as_arguments(self):
        with patch.object(selection.subprocess, "run", return_value=subprocess.CompletedProcess(
            [], 0, stdout=b"benchmarks/tsb/bench_join.ts\0a path with\na newline\0"
        )) as run:
            paths = selection.changed_paths(Path("."), "a" * 40, "b" * 40)
        self.assertEqual(paths, ["benchmarks/tsb/bench_join.ts", "a path with\na newline"])
        self.assertEqual(run.call_args.args[0], ["git", "diff", "--name-only", "-z", "--no-renames", "a" * 40 + "..." + "b" * 40, "--"])
        with self.assertRaises(ValueError):
            selection.changed_paths(Path("."), "--output=unsafe", "b" * 40)

    def test_pair_discovery_requires_both_sides(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            for path in ("tsb/bench_join.ts", "pandas/bench_join.py", "tsb/bench_unpaired.ts"):
                target = root / "benchmarks" / path
                target.parent.mkdir(parents=True, exist_ok=True)
                target.touch()
            self.assertEqual(selection.paired_names(root), {"join"})

    def test_wrong_checkout_fails_and_preserves_error_artifact(self):
        with tempfile.TemporaryDirectory() as directory:
            output = Path(directory) / "selection.json"
            with patch.dict(selection.os.environ, {"EVENT_NAME": "workflow_dispatch", "EXPECTED_HEAD_SHA": "a" * 40}), \
                    patch.object(selection.subprocess, "run", return_value=subprocess.CompletedProcess([], 0, stdout="b" * 40)):
                self.assertEqual(selection.main(["--output", str(output)]), 1)
            report = json.loads(output.read_text())
            self.assertEqual(report["status"], "selection_error")
            self.assertEqual(report["expected_head_sha"], "a" * 40)

    def test_incomplete_pair_failure_preserves_names_and_actual_sha(self):
        with tempfile.TemporaryDirectory() as directory:
            output = Path(directory) / "selection.json"
            with patch.dict(selection.os.environ, {"EVENT_NAME": "pull_request", "EXPECTED_HEAD_SHA": "a" * 40}), \
                    patch.object(selection.subprocess, "run", return_value=subprocess.CompletedProcess([], 0, stdout="a" * 40)), \
                    patch.object(selection, "changed_paths", return_value=["benchmarks/tsb/bench_incomplete.ts"]), \
                    patch.object(selection, "benchmark_names", return_value=({"incomplete"}, set())):
                self.assertEqual(selection.main(["--output", str(output)]), 1)
            report = json.loads(output.read_text())
            self.assertEqual(report["status"], "selection_error")
            self.assertEqual(report["incomplete_pairs"], ["incomplete"])
            self.assertEqual(report["head_sha"], "a" * 40)

    def test_workflow_is_read_only_strict_serial_and_keeps_failure_artifacts(self):
        source = (Path(__file__).resolve().parents[1] / "benchmark-verification.yml").read_text()
        self.assertNotIn("pull_request_target", source)
        self.assertNotIn("\n  push:", source)
        self.assertNotIn("secrets.", source)
        self.assertNotIn(": write", source)
        for required in ("contents: read", "persist-credentials: false", "github.event.pull_request.head.sha || github.sha",
                         "BENCHMARK_WORKERS: '1'", "BENCHMARK_STRICT: '1'", "bun-version: '1.4.2'",
                         "python-version: '3.12'", "pandas==2.2.3 numpy==2.1.3", "if: always()"):
            with self.subTest(required=required):
                self.assertIn(required, source)


if __name__ == "__main__":
    unittest.main()
