"""Idle discovery must be cheap, fail visibly, and preserve explicit requests."""
import json
from pathlib import Path
import re
from types import SimpleNamespace
import unittest
from unittest.mock import Mock

from goal_preflight import PreflightError, has_open_goal, should_run


def issue(*labels, **fields):
    return {"state": "open", "labels": [{"name": label} for label in labels], **fields}


class GoalPreflightTest(unittest.TestCase):
    def test_job_filter_avoids_checkout_for_irrelevant_events(self):
        source = (Path(__file__).resolve().parents[1] / "goal.md").read_text()
        job = source.split("  preflight:\n", 1)[1].split("\nif:", 1)[0]
        expression = re.search(r"    if: >-\n(.*?)    runs-on:", job, re.DOTALL).group(1)
        # This condition uses only equality, boolean operators, and the two
        # string/list helpers below; evaluate the actual source expression.
        expression = " ".join(expression.split()).replace("||", "or").replace("&&", "and")

        def matches(event_name, **bodies):
            event = SimpleNamespace(**{
                key: SimpleNamespace(body=bodies.get(key, ""))
                for key in ("comment", "issue", "pull_request", "discussion")
            })
            return eval(expression, {"__builtins__": {}}, {
                "github": SimpleNamespace(event_name=event_name, event=event),
                "contains": lambda values, value: value in values,
                "fromJSON": json.loads,
                "startsWith": lambda body, prefix: body.startswith(prefix),
            })

        self.assertTrue(matches("schedule"))
        self.assertTrue(matches("workflow_dispatch"))
        self.assertFalse(matches("push"))
        self.assertFalse(matches("issue_comment", comment="ordinary comment", issue="/goal 77"))
        self.assertFalse(matches("pull_request", pull_request="ordinary PR"))
        for event_name, key in (
            ("issues", "issue"), ("issue_comment", "comment"),
            ("pull_request", "pull_request"), ("pull_request_review_comment", "comment"),
            ("discussion", "discussion"), ("discussion_comment", "comment"),
        ):
            for body in ("/goal", "/goal #77", "/goal\n#77"):
                with self.subTest(event=event_name, body=body):
                    self.assertTrue(matches(event_name, **{key: body}))

    def test_manual_preflight_is_pinned_but_automatic_uses_default_branch(self):
        source = (Path(__file__).resolve().parents[1] / "goal.md").read_text()
        job = source.split("  preflight:\n", 1)[1].split("\nif:", 1)[0]
        self.assertIn("ref: ${{ github.event_name == 'workflow_dispatch' && github.sha || github.event.repository.default_branch }}", job)
        self.assertIn("persist-credentials: false", job)
        self.assertIn("contents: read", job)
        self.assertIn("issues: read", job)
        self.assertNotIn(": write", job)

    def test_idle_schedules_and_untargeted_dispatch_skip(self):
        for event_name in ("schedule", "workflow_dispatch"):
            with self.subTest(event=event_name):
                discover = Mock(return_value=False)
                self.assertFalse(should_run(event_name, {}, discover)[0])
                discover.assert_called_once_with()

    def test_schedule_with_work_runs(self):
        self.assertTrue(should_run("schedule", {}, lambda: True)[0])

    def test_explicit_dispatch_does_not_depend_on_labels_or_api(self):
        discover = Mock(side_effect=AssertionError("must not discover"))
        self.assertTrue(should_run("workflow_dispatch", {"inputs": {"issue": "77"}}, discover)[0])
        discover.assert_not_called()

    def test_slash_commands_keep_the_existing_event_contract(self):
        for event_name, key in (
            ("issues", "issue"), ("issue_comment", "comment"),
            ("pull_request", "pull_request"), ("pull_request_review_comment", "comment"),
            ("discussion", "discussion"), ("discussion_comment", "comment"),
        ):
            for body in ("/goal", "/goal #77", "/goal\n#77"):
                with self.subTest(event=event_name, body=body):
                    discover = Mock(side_effect=AssertionError("must not discover"))
                    self.assertTrue(should_run(event_name, {key: {"body": body}}, discover)[0])
                    discover.assert_not_called()

    def test_other_comments_do_not_query_or_run(self):
        for body in (None, "hello", "please /goal #77", "/goalpost", "/goal\t77"):
            discover = Mock(side_effect=AssertionError("must not discover"))
            self.assertFalse(should_run("issue_comment", {"comment": {"body": body}}, discover)[0])

    def test_empty_list_is_proven_idle(self):
        self.assertFalse(has_open_goal("owner/repo", "test-token", get_page=lambda *args: ([], "")))

    def test_live_goal_is_work(self):
        self.assertTrue(has_open_goal("owner/repo", "test-token",
                                      get_page=lambda *args: ([issue("goal")], "")))

    def test_completed_closed_and_pull_requests_do_not_count(self):
        entries = [issue("goal", "goal-completed"), issue("goal", state="closed"),
                   issue("goal", pull_request={"url": "test"}), issue("other")]
        self.assertFalse(has_open_goal("owner/repo", "test-token",
                                       get_page=lambda *args: (entries, "")))

    def test_completed_page_does_not_hide_later_work(self):
        get_page = Mock(side_effect=[
            ([issue("goal", "goal-completed")],
             '<https://api.github.com/repos/owner/repo/issues?page=2>; rel="next"'),
            ([issue("goal")], ""),
        ])
        self.assertTrue(has_open_goal("owner/repo", "test-token", get_page=get_page))
        self.assertEqual(get_page.call_count, 2)

    def test_errors_are_not_reported_as_an_empty_queue(self):
        discover = Mock(side_effect=PreflightError("HTTP failure"))
        with self.assertRaises(PreflightError):
            should_run("schedule", {}, discover)

    def test_bad_api_shapes_fail_visibly(self):
        for body in ({"message": "API rate limit exceeded"}, [None],
                     [{"state": "open", "labels": "goal"}],
                     [{"state": "open", "labels": [None]}]):
            with self.subTest(body=body), self.assertRaises(PreflightError):
                has_open_goal("owner/repo", "test-token", get_page=lambda *args: (body, ""))

    def test_missing_credentials_and_invalid_repository_fail(self):
        for repo, token in (("owner/repo", ""), ("", "test-token"), ("../bad/repo", "test-token")):
            with self.subTest(repo=repo), self.assertRaises(PreflightError):
                has_open_goal(repo, token)

    def test_pagination_cannot_send_credentials_to_another_endpoint(self):
        for url in ("https://attacker.example/issues", "http://api.github.com/repos/owner/repo/issues",
                    "https://api.github.com/repos/other/repo/issues"):
            with self.subTest(url=url), self.assertRaises(PreflightError):
                has_open_goal("owner/repo", "test-token",
                              get_page=lambda *args: ([], '<' + url + '>; rel="next"'))

    def test_repeated_page_is_an_error_not_an_infinite_loop(self):
        with self.assertRaises(PreflightError):
            has_open_goal("owner/repo", "test-token", get_page=lambda *args: (
                [], '<https://api.github.com/repos/owner/repo/issues?labels=goal&state=open&per_page=100>; rel="next"'))


if __name__ == "__main__":
    unittest.main()
