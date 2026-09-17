"""Unavailable scheduling evidence must never look like no work or no PR."""
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch
import urllib.error

import goal_scheduler
from goal_scheduler import SchedulerError, fetch_goal_issues, find_existing_pr_for_branch


class GoalSchedulerErrorsTest(unittest.TestCase):
    def test_http_failure_is_not_a_successful_empty_result(self):
        with patch.object(goal_scheduler.urllib.request, "urlopen",
                          side_effect=urllib.error.URLError("unavailable")):
            with self.assertRaises(SchedulerError):
                goal_scheduler._http_get_json("https://api.github.com", {})

    def test_missing_credentials_fail(self):
        with self.assertRaises(SchedulerError):
            fetch_goal_issues("owner/repo", "")
        with self.assertRaises(SchedulerError):
            find_existing_pr_for_branch("owner/repo", "goal/1-example", "")

    def test_only_a_real_empty_list_means_no_goals(self):
        self.assertEqual(fetch_goal_issues("owner/repo", "test-token",
                                          http_get_json=lambda *args: ([], "")), [])
        for result in (None, {"message": "rate limited"}, [None], [{"labels": None}]):
            with self.subTest(result=result), self.assertRaises(SchedulerError):
                fetch_goal_issues("owner/repo", "test-token",
                                 http_get_json=lambda *args: (result, ""))

    def test_failed_pr_lookup_cannot_create_a_duplicate_pr(self):
        for result in (None, {"message": "rate limited"}, [None], [{}], [{"number": True}]):
            with self.subTest(result=result), self.assertRaises(SchedulerError):
                find_existing_pr_for_branch("owner/repo", "goal/1-example", "test-token",
                                            http_get_json=lambda *args: (result, ""))

    def test_proven_no_pr_and_existing_pr_are_distinct(self):
        self.assertIsNone(find_existing_pr_for_branch(
            "owner/repo", "goal/1-example", "test-token", http_get_json=lambda *args: ([], "")))
        self.assertEqual(find_existing_pr_for_branch(
            "owner/repo", "goal/1-example", "test-token",
            http_get_json=lambda *args: ([{"number": 77}], "")), 77)

    def test_partial_issue_page_failure_is_not_partial_success(self):
        pages = iter([
            ([{"labels": [{"name": "goal"}]}],
             '<https://api.github.com/repos/owner/repo/issues?page=2>; rel="next"'),
            (None, None),
        ])
        with self.assertRaises(SchedulerError):
            fetch_goal_issues("owner/repo", "test-token", http_get_json=lambda *args: next(pages))

    def test_api_failure_is_persisted_as_error_not_no_goals(self):
        with tempfile.TemporaryDirectory() as directory:
            output_file = Path(directory) / "goal.json"
            with patch.object(goal_scheduler, "OUTPUT_DIR", directory), \
                    patch.object(goal_scheduler, "OUTPUT_FILE", str(output_file)), \
                    patch.object(goal_scheduler, "fetch_goal_issues", side_effect=SchedulerError("offline")):
                self.assertEqual(goal_scheduler.main(), 1)
            data = json.loads(output_file.read_text())
            self.assertEqual(data["error"], "offline")
            self.assertFalse(data["no_goals"])
            self.assertIsNone(data["selected"])


if __name__ == "__main__":
    unittest.main()
