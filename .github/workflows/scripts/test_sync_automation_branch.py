"""Exercise automation branch synchronization against real, local Git remotes."""
import os
from pathlib import Path
import subprocess
import tempfile
import unittest


SCRIPT = Path(__file__).with_name("sync_automation_branch.sh").resolve()


class SyncAutomationBranchTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.remote = self.root / "remote.git"
        self.repo = self.root / "repo"
        self.env = {
            **os.environ,
            "GIT_AUTHOR_NAME": "Workflow Test",
            "GIT_AUTHOR_EMAIL": "workflow-test@example.invalid",
            "GIT_COMMITTER_NAME": "Workflow Test",
            "GIT_COMMITTER_EMAIL": "workflow-test@example.invalid",
            "GIT_CONFIG_NOSYSTEM": "1",
            "GIT_CONFIG_GLOBAL": os.devnull,
        }
        self.git("init", "--bare", str(self.remote), cwd=self.root)
        self.git("init", "-b", "main", str(self.repo), cwd=self.root)
        self.git("remote", "add", "origin", str(self.remote))
        self.commit("common.txt", "initial\n")
        self.git("push", "origin", "main")
        self.initial = self.git("rev-parse", "HEAD")
        self.branch = "autoloop/test-program"

    def git(self, *args, cwd=None):
        return subprocess.run(
            ["git", *args], cwd=cwd or self.repo, env=self.env,
            check=True, text=True, capture_output=True,
        ).stdout.strip()

    def commit(self, file, content):
        (self.repo / file).write_text(content)
        self.git("add", file)
        self.git("commit", "-m", f"Update {file}")

    def publish_branch(self, unique=False):
        self.git("checkout", "-b", self.branch)
        if unique:
            self.commit("branch.txt", "branch work\n")
        self.git("push", "origin", self.branch)
        self.original_tip = self.git("rev-parse", "HEAD")
        self.git("checkout", "main")

    def advance_main(self):
        self.commit("base.txt", "upstream work\n")
        self.git("push", "origin", "main")

    def sync(self, success=True):
        remote_before = self.git("ls-remote", "origin")
        result = subprocess.run(
            ["bash", str(SCRIPT), self.branch, "main"],
            cwd=self.repo, env=self.env, text=True, capture_output=True,
        )
        if success:
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertEqual(self.git("branch", "--show-current"), self.branch)
        else:
            self.assertNotEqual(result.returncode, 0)
        self.assertEqual(self.git("ls-remote", "origin"), remote_before)

    def assert_publishable(self):
        self.git("merge-base", "--is-ancestor", self.original_tip, "HEAD")
        self.git("merge-base", "--is-ancestor", "origin/main", "HEAD")
        # This is the exact non-force operation used by the safe-output handler.
        self.git("push", "origin", self.branch)

    def test_missing_branch_starts_at_main_without_publishing(self):
        self.sync()
        self.assertEqual(self.git("rev-parse", "HEAD"), self.initial)

    def test_equal_branch_is_unchanged(self):
        self.publish_branch()
        self.sync()
        self.assertEqual(self.git("rev-parse", "HEAD"), self.original_tip)
        self.assert_publishable()

    def test_branch_only_ahead_keeps_its_commits(self):
        self.publish_branch(unique=True)
        self.sync()
        self.assertEqual(self.git("rev-parse", "HEAD"), self.original_tip)
        self.assert_publishable()

    def test_branch_only_behind_fast_forwards(self):
        self.publish_branch()
        self.advance_main()
        self.sync()
        self.assertEqual(self.git("rev-parse", "HEAD"), self.git("rev-parse", "main"))
        self.assert_publishable()

    def test_divergent_branch_merges_without_rewriting(self):
        self.publish_branch(unique=True)
        self.advance_main()
        self.sync()
        self.assertEqual(len(self.git("show", "-s", "--format=%P").split()), 2)
        self.assertEqual((self.repo / "branch.txt").read_text(), "branch work\n")
        self.assertEqual((self.repo / "base.txt").read_text(), "upstream work\n")
        self.assert_publishable()

    def test_conflicting_merge_aborts_without_losing_branch_work(self):
        self.publish_branch()
        self.git("checkout", self.branch)
        self.commit("common.txt", "branch version\n")
        self.git("push", "origin", self.branch)
        self.original_tip = self.git("rev-parse", "HEAD")
        self.git("checkout", "main")
        self.commit("common.txt", "main version\n")
        self.git("push", "origin", "main")
        self.sync(success=False)
        self.assertEqual(self.git("rev-parse", "HEAD"), self.original_tip)
        self.assertEqual(self.git("status", "--porcelain"), "")

    def test_dirty_checkout_is_preserved(self):
        (self.repo / "common.txt").write_text("uncommitted\n")
        self.sync(success=False)
        self.assertEqual((self.repo / "common.txt").read_text(), "uncommitted\n")

    def test_non_automation_branch_is_rejected(self):
        self.branch = "main"
        self.sync(success=False)

    def test_goal_branch_uses_the_same_history_contract(self):
        self.branch = "goal/123-test-goal"
        self.publish_branch(unique=True)
        self.advance_main()
        self.sync()
        self.assert_publishable()


if __name__ == "__main__":
    unittest.main()
