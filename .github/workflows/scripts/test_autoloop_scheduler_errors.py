"""Execute the scheduler: failed discovery must not select a partial queue."""
from contextlib import chdir, redirect_stdout
import http.client
import io
import json
import os
from pathlib import Path
import runpy
import tempfile
import unittest
from unittest.mock import patch
import urllib.error


SCHEDULER = Path(__file__).resolve().with_name("autoloop_scheduler.py")
PROGRAM = "## Goal\nImprove this artifact.\n## Evaluation\nHigher is better.\n"


class AutoloopSchedulerErrorsTest(unittest.TestCase):
    def run_scheduler(self, response=b"[]", failure=None, env=None):
        """Isolate all scheduler writes, including its fixed framework paths."""
        real_open = open
        real_makedirs = os.makedirs
        real_isfile = os.path.isfile
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            programs = root / ".autoloop/programs"
            programs.mkdir(parents=True)
            (programs / "local.md").write_text(PROGRAM)
            framework = root / "framework"
            framework.mkdir()
            output = framework / "autoloop.json"
            output.write_text('{"selected": "stale-selection"}')

            def remap(path):
                if isinstance(path, (str, os.PathLike)):
                    value = os.fspath(path)
                    if value == "/tmp/gh-aw" or value.startswith("/tmp/gh-aw/"):
                        return framework / value.removeprefix("/tmp/gh-aw").lstrip("/")
                return path

            def urlopen(request, timeout):
                if "/issues?" in request.full_url:
                    if failure:
                        raise failure
                    return io.BytesIO(response)
                # Successful discovery may look for a canonical PR; none exists.
                return io.BytesIO(b"[]")

            environment = {"GITHUB_REPOSITORY": "owner/repo", "GITHUB_TOKEN": "test-token",
                           "AUTOLOOP_PROGRAM": ""}
            environment.update(env or {})
            stdout = io.StringIO()
            with chdir(root), patch.dict(os.environ, environment), redirect_stdout(stdout), \
                    patch("builtins.open", side_effect=lambda path, *args, **kwargs:
                          real_open(remap(path), *args, **kwargs)), \
                    patch("os.makedirs", side_effect=lambda path, *args, **kwargs:
                          real_makedirs(remap(path), *args, **kwargs)), \
                    patch("os.path.isfile", side_effect=lambda path: real_isfile(remap(path))), \
                    patch("urllib.request.urlopen", side_effect=urlopen) as http:
                exit_code = 0
                try:
                    runpy.run_path(str(SCHEDULER), run_name="__main__")
                except SystemExit as result:
                    exit_code = result.code
            data = json.loads(output.read_text())
            issue_files = list((framework / "issue-programs").glob("*.md"))
            return exit_code, data, stdout.getvalue(), http.call_count, issue_files

    def assert_discovery_failed(self, **kwargs):
        code, data, stdout, calls, issue_files = self.run_scheduler(**kwargs)
        self.assertEqual(code, 1)
        self.assertIsNone(data["selected"])
        self.assertFalse(data["no_programs"])
        self.assertTrue(data["error"])
        self.assertEqual(data["issue_programs"], {})
        self.assertEqual(data["deferred"], [])
        self.assertEqual(issue_files, [])
        self.assertIn("ERROR:", stdout)
        self.assertNotIn("Selected program:", stdout)
        self.assertLessEqual(calls, 1, "Failed discovery must not continue into PR lookup")
        return calls

    def test_http_network_timeout_and_invalid_json_fail_closed(self):
        for failure in (
            urllib.error.HTTPError("https://api.github.com", 403, "rate limited", {}, None),
            urllib.error.HTTPError("https://api.github.com", 500, "unavailable", {}, None),
            urllib.error.URLError("offline"),
            TimeoutError("timed out"),
            http.client.IncompleteRead(b"[", 20),
        ):
            with self.subTest(failure=failure):
                self.assert_discovery_failed(failure=failure)
        for response in (b"not json", b"[", b"\xff"):
            with self.subTest(response=response):
                self.assert_discovery_failed(response=response)

    def test_missing_credentials_fail_before_any_api_request(self):
        for env in ({"GITHUB_TOKEN": ""}, {"GITHUB_REPOSITORY": ""}):
            with self.subTest(env=env):
                self.assertEqual(self.assert_discovery_failed(env=env), 0)

    def test_wrong_response_roots_are_errors_not_empty_queues(self):
        for response in (None, {}, {"message": "rate limited"}, "", 0, False):
            with self.subTest(response=response):
                self.assert_discovery_failed(response=json.dumps(response).encode())

    def test_malformed_issue_after_valid_issue_cannot_partially_register_work(self):
        valid = {"number": 1, "title": "Issue program", "body": PROGRAM}
        malformed = [None, "issue", [], {},
                     {**valid, "number": True}, {**valid, "number": "2"},
                     {**valid, "number": 0}, {**valid, "number": -1},
                     {**valid, "title": []}, {**valid, "body": []},
                     {"number": 2, "title": "Missing body"},
                     {**valid, "pull_request": "invalid"}]
        for issue in malformed:
            with self.subTest(issue=issue):
                self.assert_discovery_failed(response=json.dumps([valid, issue]).encode())

    def test_forced_local_program_cannot_bypass_failed_discovery(self):
        self.assert_discovery_failed(failure=urllib.error.URLError("offline"),
                                     env={"AUTOLOOP_PROGRAM": "local"})

    def test_proven_empty_issue_list_still_allows_local_program(self):
        code, data, _, calls, _ = self.run_scheduler()
        self.assertEqual(code, 0)
        self.assertEqual(data["selected"], "local")
        self.assertNotIn("error", data)
        self.assertGreater(calls, 1)

    def test_valid_issue_is_discovered_and_pull_requests_are_ignored(self):
        issues = [
            {"number": 1, "title": "[Autoloop] [Autoloop: local]", "body": None},
            {"number": 2, "title": "Issue program", "body": PROGRAM},
            {"number": 3, "title": "Not a program", "body": PROGRAM,
             "pull_request": {"url": "https://api.github.com/repos/owner/repo/pulls/3"}},
        ]
        code, data, _, _, _ = self.run_scheduler(response=json.dumps(issues).encode())
        self.assertEqual(code, 0)
        self.assertEqual(data["issue_programs"], {"issue-program": 2})
        self.assertEqual(data["selected"], "issue-program")


if __name__ == "__main__":
    unittest.main()
