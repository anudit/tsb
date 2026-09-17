"""Exercise Evergreen's CI activation and branch update with a fake GitHub API."""
import json
import os
from pathlib import Path
import subprocess
import tempfile
import textwrap
import unittest


SOURCE = Path(__file__).resolve().parents[1] / "evergreen.md"


class EvergreenCITest(unittest.TestCase):
    def test_green_but_behind_branch_requires_an_update(self):
        source = SOURCE.read_text()
        labels = textwrap.dedent(source[source.index("          pr_has_label() {"):
                                          source.index("          edit_pr_label() {")])
        gates = textwrap.dedent(source[source.index("          check_names() {"):
                                         source.index("          reconcile_ready_label() {")])
        names = ["Test & Lint", "Playground E2E (Playwright)", "Build", "Validate Python Examples"]
        for merge_state, expected in (("BEHIND", "needs_branch_update"), ("CLEAN", "ready")):
            with self.subTest(merge_state=merge_state):
                env = {
                    **os.environ,
                    "OPT_IN_LABEL": "evergreen",
                    "EXHAUSTED_LABEL": "evergreen-exhausted",
                    "CHECK_GATE_MODE": "configured",
                    "REQUIRED_CHECKS_JSON": json.dumps(names),
                    "PR_JSON": json.dumps({
                        "labels": [{"name": "evergreen"}],
                        "mergeStateStatus": merge_state,
                        "statusCheckRollup": [{"name": name, "conclusion": "SUCCESS"} for name in names],
                    }),
                }
                result = subprocess.run(
                    ["bash", "-c", labels + gates + '\nevaluate_readiness "$PR_JSON"\n'],
                    env=env, text=True, capture_output=True, check=True,
                )
                self.assertEqual(result.stdout.strip(), expected)

    def invoke(self, operation="trigger_ci_if_needed", runs=None, token="test-ci-token",
               head="current", fork=False, lookup_error=False):
        source = SOURCE.read_text()
        start = source.index("          ci_gh() {")
        end = source.index("          consider_pr() {", start)
        functions = textwrap.dedent(source[start:end])
        harness = '''
set -euo pipefail
set_result() { printf '%s\\n' "$*" >> "$GITHUB_OUTPUT"; }
pr_json() { printf '%s\\n' "$PR_JSON"; }
gh() {
  if [ "$1 $2" = "run list" ]; then
    [ "$LOOKUP_ERROR" = false ] || return 1
    printf '%s\\n' "$RUNS"
  else
    printf '%s|%s\\n' "$GH_TOKEN" "$*" >> "$CALL_LOG"
  fi
}
'''
        with tempfile.TemporaryDirectory() as directory:
            output = Path(directory) / "output"
            calls = Path(directory) / "calls"
            output.touch()
            calls.touch()
            env = {
                **os.environ,
                "GH_TOKEN": "test-default-token",
                "CI_TRIGGER_TOKEN": token,
                "REPO": "owner/repo",
                "GITHUB_OUTPUT": str(output),
                "CALL_LOG": str(calls),
                "PR_JSON": json.dumps({
                    "headRefOid": head,
                    "headRefName": "autoloop/program",
                    "isCrossRepository": fork,
                }),
                "RUNS": json.dumps(runs or []),
                "LOOKUP_ERROR": str(lookup_error).lower(),
            }
            # Branch-update success deliberately returns 1 to keep selection
            # scanning; inspect the state/output rather than treating it as failure.
            result = subprocess.run(
                ["bash", "-c", harness + functions + f'\n{operation} 123 current scheduled || true\n'],
                env=env, text=True, capture_output=True,
            )
            self.assertEqual(result.returncode, 0, result.stderr)
            return output.read_text(), calls.read_text()

    def test_missing_ci_dispatches_with_trigger_token(self):
        state, calls = self.invoke()
        self.assertIn("waiting ci_dispatch:requested", state)
        self.assertIn("test-ci-token|workflow run ci.yml --repo owner/repo --ref autoloop/program", calls)

    def test_pending_ci_is_not_dispatched_again(self):
        _, calls = self.invoke(runs=[{"databaseId": 123, "status": "in_progress"}])
        self.assertEqual(calls, "")

    def test_missing_token_does_not_fall_back_to_default_token(self):
        state, calls = self.invoke(token="")
        self.assertIn("blocked ci_dispatch:failed", state)
        self.assertEqual(calls, "")

    def test_failed_read_is_not_mistaken_for_missing_ci(self):
        state, calls = self.invoke(lookup_error=True)
        self.assertIn("blocked ci_lookup:failed", state)
        self.assertEqual(calls, "")

    def test_dispatch_rechecks_head_and_same_repository(self):
        for args in ({"head": "changed"}, {"fork": True}):
            with self.subTest(args=args):
                state, calls = self.invoke(**args)
                self.assertIn("blocked ci_dispatch:head_changed_or_fork", state)
                self.assertEqual(calls, "")

    def test_branch_update_uses_trigger_token_and_expected_head(self):
        state, calls = self.invoke(operation="update_branch_if_needed")
        self.assertIn("waiting scheduled:branch_update_requested", state)
        self.assertIn("test-ci-token|api --method PUT", calls)
        self.assertIn("expected_head_sha=current", calls)

    def test_branch_update_without_token_or_current_same_repo_head_stops(self):
        for args in ({"token": ""}, {"head": "changed"}, {"fork": True}):
            with self.subTest(args=args):
                state, calls = self.invoke(operation="update_branch_if_needed", **args)
                self.assertIn("blocked", state)
                self.assertEqual(calls, "")


if __name__ == "__main__":
    unittest.main()
