"""Prevent absent, stale, duplicate, or skipped CI evidence from passing."""
import unittest

from automation_ci import REQUIRED_JOBS, ci_status, latest_run_id, pr_ci_status


class AutomationCITest(unittest.TestCase):
    def passing_run(self):
        return {
            "headSha": "current",
            "status": "completed",
            "conclusion": "success",
            "jobs": [
                {"name": name, "status": "completed", "conclusion": "success"}
                for name in REQUIRED_JOBS
            ],
        }

    def test_no_runs_has_no_candidate(self):
        self.assertIsNone(latest_run_id([], "current"))

    def test_stale_sha_is_never_selected(self):
        self.assertIsNone(latest_run_id([{"headSha": "old"}], "current"))

    def test_latest_run_selected_by_time_then_id_not_response_order(self):
        runs = [
            {"headSha": "current", "createdAt": "2026-09-17T02:00:00Z", "databaseId": 3},
            {"headSha": "current", "createdAt": "2026-09-17T01:00:00Z", "databaseId": 1},
            {"headSha": "current", "createdAt": "2026-09-17T02:00:00Z", "databaseId": 2},
            {"headSha": "old", "createdAt": "2026-09-17T03:00:00Z", "databaseId": 4},
        ]
        self.assertEqual(latest_run_id(runs, "current"), 3)

    def test_all_four_current_gates_are_required(self):
        self.assertEqual(ci_status(self.passing_run(), "current"), "success")
        run = self.passing_run()
        run["jobs"].pop()
        self.assertEqual(ci_status(run, "current"), "pending")

    def test_empty_jobs_do_not_pass(self):
        run = self.passing_run()
        run["jobs"] = []
        self.assertEqual(ci_status(run, "current"), "pending")

    def test_old_head_success_is_pending(self):
        self.assertEqual(ci_status(self.passing_run(), "new-head"), "pending")

    def test_nonterminal_run_and_jobs_are_pending(self):
        for state in ("queued", "in_progress", "waiting"):
            with self.subTest(state=state):
                run = self.passing_run()
                run["status"] = state
                self.assertEqual(ci_status(run, "current"), "pending")
                run = self.passing_run()
                run["jobs"][0]["status"] = state
                self.assertEqual(ci_status(run, "current"), "pending")

    def test_failed_and_skipped_gates_do_not_pass(self):
        for conclusion in ("failure", "cancelled", "skipped", "neutral", "timed_out", ""):
            with self.subTest(conclusion=conclusion):
                run = self.passing_run()
                run["jobs"][0]["conclusion"] = conclusion
                self.assertEqual(ci_status(run, "current"), "failure")
                run = self.passing_run()
                run["conclusion"] = conclusion
                self.assertEqual(ci_status(run, "current"), "failure")

    def test_duplicate_failed_gate_cannot_hide_behind_success(self):
        run = self.passing_run()
        run["jobs"].append({
            "name": "Build", "status": "completed", "conclusion": "failure",
        })
        self.assertEqual(ci_status(run, "current"), "failure")

    def test_green_run_cannot_mask_failing_or_pending_pr_gates(self):
        self.assertEqual(ci_status(self.passing_run(), "current"), "success")
        for status, conclusion in (("COMPLETED", "FAILURE"), ("IN_PROGRESS", "")):
            with self.subTest(status=status):
                pull = {
                    "headRefOid": "current",
                    "statusCheckRollup": self.passing_run()["jobs"] + [{
                        "name": "Build", "status": status, "conclusion": conclusion,
                    }],
                }
                self.assertNotEqual(pr_ci_status(pull, "current"), "success")

    def test_pr_checks_require_all_gates_for_the_current_head(self):
        pull = {"headRefOid": "current", "statusCheckRollup": self.passing_run()["jobs"]}
        self.assertEqual(pr_ci_status(pull, "current"), "success")
        self.assertEqual(pr_ci_status(pull, "new-head"), "pending")
        pull["statusCheckRollup"].pop()
        self.assertEqual(pr_ci_status(pull, "current"), "pending")

    def test_classic_status_contexts_are_checked(self):
        pull = {
            "headRefOid": "current",
            "statusCheckRollup": [{"context": name, "state": "SUCCESS"} for name in REQUIRED_JOBS],
        }
        self.assertEqual(pr_ci_status(pull, "current"), "success")
        for state in ("PENDING", "ERROR", "FAILURE"):
            pull["statusCheckRollup"][0]["state"] = state
            self.assertNotEqual(pr_ci_status(pull, "current"), "success")


if __name__ == "__main__":
    unittest.main()
