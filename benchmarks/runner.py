#!/usr/bin/env python3
"""Accountable benchmark collection; success records retain the existing schema."""
import argparse
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone
import json
import math
import os
from pathlib import Path
import re
import subprocess
import sys
import tempfile
import time


def command_output(command, cwd):
    try:
        result = subprocess.run(command, cwd=cwd, capture_output=True, text=True, timeout=10)
        return result.stdout.strip() if result.returncode == 0 else None
    except (OSError, subprocess.TimeoutExpired, UnicodeError):
        return None


def provenance(root, ts_runner, python_runner, workers, timeout):
    sha = command_output(["git", "rev-parse", "HEAD"], root)
    sha_source = "git"
    if not sha or not re.fullmatch(r"[0-9a-f]{40,64}", sha):
        sha, sha_source = os.environ.get("GITHUB_SHA"), "GITHUB_SHA"
        if not sha or not re.fullmatch(r"[0-9a-f]{40,64}", sha):
            sha = None
    dirty = command_output(["git", "status", "--porcelain"], root)
    versions = command_output([
        python_runner, "-c",
        "import json,platform,pandas,numpy; print(json.dumps({'python':platform.python_version(),"
        "'pandas':pandas.__version__,'numpy':numpy.__version__}))",
    ], root)
    try:
        python_versions = json.loads(versions) if versions else None
    except (ValueError, TypeError):
        python_versions = None
    return {
        "candidate_sha": sha,
        "sha_source": sha_source if sha else None,
        "working_tree_dirty": bool(dirty) if dirty is not None else None,
        "typescript_runner": ts_runner,
        "typescript_version": command_output([ts_runner, "--version"], root),
        "python_runner": python_runner,
        "python_libraries": python_versions,
        "workers": workers,
        "timeout_seconds": timeout,
    }


def contains_non_finite(value):
    if isinstance(value, float):
        return not math.isfinite(value)
    if isinstance(value, dict):
        return any(contains_non_finite(item) for item in value.values())
    if isinstance(value, list):
        return any(contains_non_finite(item) for item in value)
    return False


def run_side(command, root, timeout):
    start = time.monotonic()
    try:
        process = subprocess.run(command, cwd=root, capture_output=True, text=True, timeout=timeout)
    except subprocess.TimeoutExpired:
        return {"status": "timeout", "reason": f"exceeded {timeout:g}s"}, None
    except OSError as error:
        return {"status": "error", "reason": str(error)[:1000]}, None
    except UnicodeError:
        return {"status": "malformed", "reason": "output is not valid text"}, None
    outcome = {"exit_code": process.returncode, "elapsed_ms": round((time.monotonic() - start) * 1000, 3)}
    if process.returncode:
        return {**outcome, "status": "error", "reason": process.stderr.strip()[-1000:] or "non-zero exit"}, None
    try:
        result = json.loads(process.stdout)
    except (ValueError, TypeError, RecursionError):
        return {**outcome, "status": "malformed", "reason": "stdout is not one JSON result"}, None
    if contains_non_finite(result):
        return {**outcome, "status": "non_finite", "reason": "result contains NaN or infinity"}, None
    mean = result.get("mean_ms") if isinstance(result, dict) else None
    if isinstance(mean, bool) or not isinstance(mean, (int, float)) or mean < 0:
        return {**outcome, "status": "malformed", "reason": "mean_ms must be a positive number"}, None
    if mean == 0:
        return {**outcome, "status": "unresolvable", "reason": "zero mean_ms is below timer resolution, not a speedup"}, None
    return {**outcome, "status": "success"}, result


def run_pair(name, root, ts_runner, python_runner, timeout):
    outcomes, values = {}, {}
    for side, runner, directory, extension in (
        ("tsb", ts_runner, "tsb", "ts"), ("pandas", python_runner, "pandas", "py"),
    ):
        outcomes[side], values[side] = run_side(
            [runner, str(root / "benchmarks" / directory / f"bench_{name}.{extension}")],
            root, timeout,
        )
    failed = [side for side in outcomes if outcomes[side]["status"] != "success"]
    if failed:
        return {"function": name, "status": outcomes[failed[0]]["status"], "failed_sides": failed, **outcomes}, None
    try:
        ratio = values["tsb"]["mean_ms"] / values["pandas"]["mean_ms"]
        finite = math.isfinite(ratio)
    except OverflowError:
        finite = False
    if not finite:
        return {"function": name, "status": "non_finite", "reason": "timing ratio is not finite", **outcomes}, None
    if ratio == 0:
        return {"function": name, "status": "unresolvable", "reason": "timing ratio underflowed to zero", **outcomes}, None
    return {"function": name, "status": "success", **outcomes}, {
        "function": name, "tsb": values["tsb"], "pandas": values["pandas"], "ratio": ratio,
    }


def collect(root, ts_runner, python_runner, workers, timeout, selected_names):
    ts_names = {path.stem[6:] for path in (root / "benchmarks" / "tsb").glob("bench_*.ts")}
    py_names = {path.stem[6:] for path in (root / "benchmarks" / "pandas").glob("bench_*.py")}
    universe = sorted(ts_names & py_names)
    if not universe:
        raise ValueError("no matched benchmark pairs discovered")
    requested = {name.strip() for name in selected_names.split(",")} if selected_names else set(universe)
    if "" in requested or requested - set(universe):
        raise ValueError(f"unknown or empty BENCHMARK_FILTER selections: {sorted(requested - set(universe))}")
    selected = sorted(requested)
    metadata = provenance(root, ts_runner, python_runner, workers, timeout)
    with ThreadPoolExecutor(max_workers=workers) as pool:
        pairs = list(pool.map(lambda name: run_pair(name, root, ts_runner, python_runner, timeout), selected))
    by_name = {outcome["function"]: outcome for outcome, _ in pairs}
    outcomes = [by_name.get(name, {"function": name, "status": "not_selected"}) for name in universe]
    benchmarks = [result for _, result in pairs if result is not None]
    failures = [outcome for outcome, _ in pairs if outcome["status"] != "success"]
    counts = {}
    for outcome in failures:
        counts[outcome["status"]] = counts.get(outcome["status"], 0) + 1
    return {
        "schema_version": 2,
        "benchmarks": benchmarks,
        "timestamp": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "status": "incomplete" if failures else "complete",
        "scope": {
            "kind": "filtered" if selected_names else "all",
            "discovered_pairs": len(universe), "selected_pairs": selected,
            "unselected_pairs": len(universe) - len(selected),
            "unpaired_typescript": sorted(ts_names - py_names), "unpaired_pandas": sorted(py_names - ts_names),
        },
        "summary": {"total": len(selected), "completed": len(benchmarks), "failed": len(failures), "failure_counts": counts},
        "provenance": metadata,
        "outcomes": outcomes,
    }


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--repo-root", type=Path, default=Path(__file__).resolve().parents[1])
    parser.add_argument("--ts-runner", required=True)
    parser.add_argument("--python-runner", default=sys.executable)
    parser.add_argument("--workers", type=int, default=os.environ.get("BENCHMARK_WORKERS", "8"))
    parser.add_argument("--timeout", type=float, default=os.environ.get("BENCHMARK_TIMEOUT", "30"))
    parser.add_argument("--filter", default=os.environ.get("BENCHMARK_FILTER", ""))
    parser.add_argument("--strict", action="store_true", default=os.environ.get("BENCHMARK_STRICT", "").lower() in ("1", "true", "yes"))
    parser.add_argument("--output", type=Path)
    args = parser.parse_args(argv)
    if args.workers < 1 or not math.isfinite(args.timeout) or args.timeout <= 0:
        parser.error("workers and timeout must be positive finite values")
    try:
        report = collect(args.repo_root.resolve(), args.ts_runner, args.python_runner, args.workers, args.timeout, args.filter)
    except ValueError as error:
        parser.error(str(error))
    output = args.output or args.repo_root / "benchmarks" / "results.json"
    with tempfile.NamedTemporaryFile(mode="w", dir=output.parent, delete=False) as temporary:
        json.dump(report, temporary, indent=2, allow_nan=False)
        temporary.write("\n")
    os.replace(temporary.name, output)
    summary = report["summary"]
    message = f"{report['status'].upper()}: {summary['completed']}/{summary['total']} selected pairs completed; {summary['failed']} failed ({report['scope']['kind']} scope)."
    print(message)
    print(f"Report: {output}")
    if report["status"] == "incomplete":
        print("WARNING: failed, timed-out, or invalid benchmarks remain; this is not a complete performance result.", file=sys.stderr)
        return 1 if args.strict else 0
    return 0


if __name__ == "__main__":
    sys.exit(main())
