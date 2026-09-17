"""Exercise benchmark accounting cheaply using fake TS/Python executables."""
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest


RUNNER = Path(__file__).resolve().parents[3] / "benchmarks" / "runner.py"


class BenchmarkRunnerTest(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        for directory in ("tsb", "pandas"):
            (self.root / "benchmarks" / directory).mkdir(parents=True)
        self.stub = self.root / "runtime"
        self.stub.write_text(f"#!{sys.executable}\n" + """import json,pathlib,sys,time
if sys.argv[1] == '--version':
    print('test-runtime-1')
elif sys.argv[1] == '-c':
    print(json.dumps({'python':'test-python','pandas':'test-pandas','numpy':'test-numpy'}))
else:
    script = pathlib.Path(sys.argv[1])
    behavior = script.read_text().strip()
    if behavior == 'fail':
        print('deliberate fixture failure', file=sys.stderr)
        sys.exit(7)
    if behavior == 'timeout':
        time.sleep(2)
    elif behavior == 'malformed':
        print('not JSON')
    elif behavior == 'nan':
        print('{"mean_ms": NaN}')
    elif behavior == 'infinity':
        print('{"mean_ms": 1, "total_ms": Infinity}')
    elif behavior == 'zero':
        print('{"mean_ms": 0}')
    elif behavior == 'boolean':
        print('{"mean_ms": true}')
    elif behavior == 'huge':
        print('{"mean_ms": 1e308}')
    elif behavior == 'tiny':
        print('{"mean_ms": 1e-308}')
    elif behavior == 'near_zero':
        print('{"mean_ms": 0.0002}')
    else:
        print(json.dumps({'function':script.stem[6:],'mean_ms':1 if script.suffix=='.ts' else 2,'iterations':2,'total_ms':4}))
""")
        self.stub.chmod(0o755)
        self.environment = {key: value for key, value in os.environ.items() if not key.startswith("BENCHMARK_")}

    def pair(self, name, ts="ok", pandas="ok"):
        (self.root / "benchmarks" / "tsb" / f"bench_{name}.ts").write_text(ts)
        (self.root / "benchmarks" / "pandas" / f"bench_{name}.py").write_text(pandas)

    def run_report(self, *extra, environment=None):
        result = subprocess.run([
            sys.executable, str(RUNNER), "--repo-root", str(self.root),
            "--ts-runner", str(self.stub), "--python-runner", str(self.stub),
            "--workers", "2", "--timeout", "0.3", *extra,
        ], capture_output=True, text=True, env=environment or self.environment)
        output = self.root / "benchmarks" / "results.json"
        return result, json.loads(output.read_text()) if output.exists() else None

    def test_success_preserves_legacy_array_and_records_provenance(self):
        self.pair("join")
        result, report = self.run_report("--strict")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(report["status"], "complete")
        self.assertEqual(report["summary"], {"total": 1, "completed": 1, "failed": 0, "failure_counts": {}})
        self.assertEqual(report["benchmarks"][0]["ratio"], 0.5)
        self.assertEqual(set(report["benchmarks"][0]), {"function", "tsb", "pandas", "ratio"})
        self.assertEqual(report["provenance"]["python_libraries"]["pandas"], "test-pandas")
        self.assertEqual(report["provenance"]["typescript_version"], "test-runtime-1")
        self.assertIn("candidate_sha", report["provenance"])
        self.assertEqual(report["provenance"]["workers"], 2)

    def test_every_failure_is_reported_and_default_publish_is_incomplete(self):
        for name, behavior in (("good", "ok"), ("broken", "fail"), ("slow", "timeout"), ("bad_json", "malformed"), ("nan", "nan"), ("infinite", "infinity")):
            self.pair(name, behavior)
        self.pair("zero_denominator", pandas="zero")
        self.pair("boolean_mean", ts="boolean")
        result, report = self.run_report()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("WARNING", result.stderr)
        self.assertEqual(report["status"], "incomplete")
        self.assertEqual(report["summary"]["total"], 8)
        self.assertEqual(report["summary"]["completed"], 1)
        self.assertEqual(report["summary"]["failed"], 7)
        outcomes = {item["function"]: item for item in report["outcomes"]}
        self.assertEqual(len(outcomes), 8)
        self.assertEqual(outcomes["broken"]["tsb"]["exit_code"], 7)
        self.assertEqual(outcomes["slow"]["status"], "timeout")
        self.assertEqual(outcomes["bad_json"]["status"], "malformed")
        self.assertEqual(outcomes["nan"]["status"], "non_finite")
        self.assertEqual(outcomes["infinite"]["status"], "non_finite")
        self.assertEqual(outcomes["zero_denominator"]["failed_sides"], ["pandas"])

    def test_strict_environment_fails_but_preserves_failure_report(self):
        self.pair("broken", "fail")
        result, report = self.run_report(environment={**self.environment, "BENCHMARK_STRICT": "1"})
        self.assertEqual(result.returncode, 1)
        self.assertEqual(report["summary"]["failed"], 1)

    def test_filter_runs_only_requested_pairs_and_records_universe(self):
        self.pair("join")
        self.pair("slow", "timeout")
        result, report = self.run_report("--filter", "join", "--strict")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(report["scope"]["kind"], "filtered")
        self.assertEqual(report["scope"]["discovered_pairs"], 2)
        self.assertEqual(report["scope"]["selected_pairs"], ["join"])
        self.assertEqual(report["scope"]["unselected_pairs"], 1)
        self.assertEqual(report["outcomes"][1], {"function": "slow", "status": "not_selected"})

    def test_unknown_selection_or_empty_universe_is_error_not_complete(self):
        result, report = self.run_report()
        self.assertEqual(result.returncode, 2)
        self.assertIsNone(report)
        self.pair("join")
        result, report = self.run_report("--filter", "unknown")
        self.assertEqual(result.returncode, 2)
        self.assertIsNone(report)

    def test_invalid_execution_limits_do_not_run(self):
        self.pair("join")
        for arguments in (("--workers", "0"), ("--timeout", "nan"), ("--timeout", "0")):
            result, report = self.run_report(*arguments)
            self.assertEqual(result.returncode, 2)
            self.assertIsNone(report)

    def test_finite_inputs_with_overflowing_ratio_are_rejected(self):
        self.pair("overflow", "huge", "tiny")
        result, report = self.run_report("--strict")
        self.assertEqual(result.returncode, 1)
        self.assertEqual(report["outcomes"][0]["status"], "non_finite")
        self.assertEqual(report["benchmarks"], [])

    def test_small_positive_ratio_preserves_precision(self):
        self.pair("precise", "near_zero")
        result, report = self.run_report("--strict")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(report["benchmarks"][0]["ratio"], 0.0001)

    def test_zero_timing_and_underflow_are_not_unlimited_wins(self):
        self.pair("zero_timing", "zero")
        self.pair("underflow", "tiny", "huge")
        result, report = self.run_report("--strict")
        self.assertEqual(result.returncode, 1)
        self.assertEqual(report["benchmarks"], [])
        self.assertEqual(report["summary"]["failed"], 2)
        self.assertTrue(all(outcome["status"] == "unresolvable" for outcome in report["outcomes"]))

    def test_shell_entrypoint_honors_filter_and_strict_environment(self):
        self.pair("join")
        self.pair("broken", "fail")
        (self.root / "benchmarks" / "pandas" / "bench_join.py").write_text('print(\'{"mean_ms": 2}\')\n')
        (self.root / "benchmarks" / "run_benchmarks.sh").write_text((RUNNER.parent / "run_benchmarks.sh").read_text())
        (self.root / "benchmarks" / "runner.py").symlink_to(RUNNER)
        (self.root / "bun").symlink_to(self.stub)
        python = self.root / "python3"
        python.write_text(f"#!{sys.executable}\nimport os,sys\n"
                          "if sys.argv[1:] == ['-c', 'import pandas']: sys.exit(0)\n"
                          f"os.execv({sys.executable!r}, [{sys.executable!r}, *sys.argv[1:]])\n")
        python.chmod(0o755)
        environment = {**self.environment, "PATH": f"{self.root}:{os.environ['PATH']}",
                       "BENCHMARK_FILTER": "join", "BENCHMARK_STRICT": "1"}
        result = subprocess.run(["bash", str(self.root / "benchmarks" / "run_benchmarks.sh")],
                                capture_output=True, text=True, env=environment)
        self.assertEqual(result.returncode, 0, result.stderr)
        report = json.loads((self.root / "benchmarks" / "results.json").read_text())
        self.assertEqual(report["scope"]["selected_pairs"], ["join"])
        self.assertEqual(report["summary"]["completed"], 1)


if __name__ == "__main__":
    unittest.main()
