"""Select and validate current-head CI evidence for deferred automation writes."""
import json
import sys


REQUIRED_JOBS = {
    "Test & Lint",
    "Playground E2E (Playwright)",
    "Build",
    "Validate Python Examples",
}


def latest_run_id(runs, head_sha):
    matching = [run for run in runs if run.get("headSha") == head_sha]
    if not matching:
        return None
    latest = max(matching, key=lambda run: (run["createdAt"], run["databaseId"]))
    return latest["databaseId"]


def ci_status(run, head_sha):
    if run.get("headSha") != head_sha:
        return "pending"
    if run.get("status") != "completed":
        return "pending"
    if run.get("conclusion") != "success":
        return "failure"
    jobs = [job for job in run.get("jobs", []) if job.get("name") in REQUIRED_JOBS]
    if {job["name"] for job in jobs} != REQUIRED_JOBS:
        return "pending"
    if any(job.get("status") != "completed" for job in jobs):
        return "pending"
    # Check every matching row, so duplicate failed/skipped gates cannot be
    # hidden by a successful row with the same name.
    if any(job.get("conclusion") != "success" for job in jobs):
        return "failure"
    return "success"


def pr_ci_status(pull_request, head_sha):
    if pull_request.get("headRefOid") != head_sha:
        return "pending"
    checks = [check for check in pull_request.get("statusCheckRollup", [])
              if check.get("name", check.get("context")) in REQUIRED_JOBS]
    if {check.get("name", check.get("context")) for check in checks} != REQUIRED_JOBS:
        return "pending"
    for check in checks:
        if "conclusion" in check:
            if (check.get("status") or "").lower() != "completed":
                return "pending"
            if (check.get("conclusion") or "").lower() != "success":
                return "failure"
        elif (check.get("state") or "").lower() != "success":
            return "pending" if (check.get("state") or "").lower() == "pending" else "failure"
    return "success"


if __name__ == "__main__":
    mode, sha = sys.argv[1:]
    data = json.load(sys.stdin)
    if mode == "select":
        run_id = latest_run_id(data, sha)
        if run_id is None:
            sys.exit(3)
        print(run_id)
    elif mode == "status":
        print(ci_status(data, sha))
    elif mode == "pr-status":
        print(pr_ci_status(data, sha))
    else:
        sys.exit("Expected select, status, or pr-status")
