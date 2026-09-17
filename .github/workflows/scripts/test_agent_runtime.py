"""Provisioning is gated, pinned, sandbox-visible, and invalidated by new locks."""
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

import provision_agent_runtime as runtime


VERSIONS = {"python": "3.12.8", "pandas": "2.2.3", "numpy": "2.1.3"}


class AgentRuntimeTest(unittest.TestCase):
    def make_root(self, directory):
        root = Path(directory)
        (root / "package.json").write_text('{"name":"test"}')
        (root / "bun.lock").write_text("lock-one")
        return root

    def test_null_selection_does_not_install_or_probe_tools(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            selected, result = root / "selection.json", root / "runtime.json"
            selected.write_text('{"selected":null}')
            with patch.object(runtime, "prepare", side_effect=AssertionError("no setup")):
                self.assertEqual(runtime.main(["--selection", str(selected), "--output", str(result)]), 0)
            self.assertEqual(json.loads(result.read_text())["status"], "skipped")

    def test_missing_selection_and_scheduler_errors_fail_honestly(self):
        for payload in (None, {}, [], {"selected": None, "error": "offline"}):
            with self.subTest(payload=payload), tempfile.TemporaryDirectory() as directory:
                selected, result = Path(directory) / "selection.json", Path(directory) / "runtime.json"
                if payload is not None:
                    selected.write_text(json.dumps(payload))
                self.assertEqual(runtime.main(["--selection", str(selected), "--output", str(result)]), 1)
                self.assertEqual(json.loads(result.read_text())["status"], "setup_error")

    def test_missing_lock_never_falls_back_to_unfrozen_install(self):
        with tempfile.TemporaryDirectory() as directory, self.assertRaises(ValueError):
            runtime.dependency_fingerprint(Path(directory))

    def test_branch_lock_or_manifest_changes_invalidate_fingerprint(self):
        with tempfile.TemporaryDirectory() as directory:
            root = self.make_root(directory)
            original = runtime.dependency_fingerprint(root)
            (root / "bun.lock").write_text("lock-two")
            changed = runtime.dependency_fingerprint(root)
            self.assertNotEqual(original, changed)
            (root / "package.json").write_text('{"name":"changed"}')
            self.assertNotEqual(changed, runtime.dependency_fingerprint(root))

    def test_version_checks_reject_wrong_runtimes_and_libraries(self):
        for field, value in (("python", "3.13.1"), ("pandas", "3.0.0"), ("numpy", "2.2.0")):
            with self.subTest(field=field), patch.object(runtime, "python_versions", return_value={**VERSIONS, field: value}), self.assertRaises(ValueError):
                runtime.verify_tools("python", "bun", Path("."))
        with patch.object(runtime, "python_versions", return_value=VERSIONS), \
                patch.object(runtime, "output", return_value="1.3.0"), self.assertRaises(ValueError):
            runtime.verify_tools("python", "bun", Path("."))

    def test_ready_environment_reuses_dependencies_but_changed_lock_reinstalls(self):
        for changed in (False, True):
            with self.subTest(changed=changed), tempfile.TemporaryDirectory() as directory:
                root = self.make_root(directory)
                (root / "node_modules").mkdir()
                source = root / "bun"
                source.write_text("fixture")
                previous = {"status": "ready", "dependency_fingerprint": runtime.dependency_fingerprint(root)}
                if changed:
                    (root / "bun.lock").write_text("changed")
                def command(command, unused):
                    if command[0] == "git":
                        return "a" * 40
                    return "1.4.2" if command[-1] == "--version" else "3.12.8"
                with patch.object(runtime, "output", side_effect=command), \
                        patch.object(runtime.shutil, "which", return_value=str(source)), \
                        patch.dict(runtime.os.environ, {"RUNNER_TOOL_CACHE": str(root / "cache")}), \
                        patch.object(runtime, "python_versions", return_value=VERSIONS), \
                        patch.object(runtime.subprocess, "run") as install:
                    report = runtime.prepare(root, previous)
                self.assertEqual(install.call_count, int(changed))
                if changed:
                    self.assertEqual(install.call_args.args[0][1:], ["install", "--frozen-lockfile", "--ignore-scripts"])
                self.assertIn("cache/tsb-bun/1.4.2/bin/bun", report["bun_executable"])
                self.assertTrue(Path(report["bun_executable"]).exists())
                self.assertEqual(report["head_sha"], "a" * 40)

    def test_missing_python_packages_install_once_then_verify(self):
        with tempfile.TemporaryDirectory() as directory:
            root = self.make_root(directory)
            source = root / "bun"
            source.write_text("fixture")
            with patch.object(runtime, "output", side_effect=lambda command, unused: "1.4.2" if command[-1] == "--version" else "3.12.8"), \
                    patch.object(runtime.shutil, "which", return_value=str(source)), \
                    patch.dict(runtime.os.environ, {"RUNNER_TOOL_CACHE": str(root / "cache")}), \
                    patch.object(runtime, "python_versions", side_effect=[{}, VERSIONS]), \
                    patch.object(runtime.subprocess, "run") as install:
                runtime.prepare(root, {})
            self.assertEqual(install.call_count, 2)
            self.assertEqual(install.call_args.args[0][-2:], ["pandas==2.2.3", "numpy==2.1.3"])
            self.assertIn("--only-binary=:all:", install.call_args.args[0])

    def test_sandbox_check_uses_recorded_paths_and_rejects_new_branch_lock(self):
        for changed in (False, True):
            with self.subTest(changed=changed), tempfile.TemporaryDirectory() as directory:
                root = self.make_root(directory)
                (root / "node_modules").mkdir()
                result = root / "runtime.json"
                result.write_text(json.dumps({"status": "ready", "python_executable": "/pinned/python",
                    "bun_executable": "/pinned/bun", "dependency_fingerprint": runtime.dependency_fingerprint(root)}))
                if changed:
                    (root / "bun.lock").write_text("changed")
                with patch.object(runtime, "verify_tools", return_value=VERSIONS) as verify, \
                        patch.object(runtime, "prepare", side_effect=AssertionError("check must not install")):
                    self.assertEqual(runtime.main(["--check-only", "--repo-root", str(root), "--output", str(result)]), int(changed))
                verify.assert_called_once_with("/pinned/python", "/pinned/bun", root)

    def test_selected_work_writes_explicit_tool_paths_without_repo_mutation(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            selected, result = root / "selection.json", root / "runtime.json"
            selected.write_text('{"selected":{"number":42}}')
            report = {"status": "ready", "python_executable": "/tool cache/python/bin/python3",
                      "bun_executable": "/tool cache/bun/bin/bun", "versions": VERSIONS}
            with patch.object(runtime, "prepare", return_value=report):
                self.assertEqual(runtime.main(["--selection", str(selected), "--output", str(result)]), 0)
            self.assertEqual(json.loads(result.read_text()), report)
            self.assertEqual(result.with_suffix(".env").read_text(),
                             'export PATH=\'/tool cache/bun/bin\':\'/tool cache/python/bin\':"$PATH"\n')

    def test_workflows_pin_tools_and_provision_after_selection(self):
        workflows = Path(__file__).resolve().parents[1]
        for name in ("goal", "autoloop"):
            with self.subTest(workflow=name):
                source = (workflows / (name + ".md")).read_text()
                self.assertIn("bun:\n    version: '1.4.2'", source)
                self.assertIn("python:\n    version: '3.12'", source)
                self.assertLess(source.index(name + "_scheduler.py"), source.index("provision_agent_runtime.py --selection"))
                self.assertIn("--check-only", source)
                self.assertIn("After switching/synchronizing branches", source)
                self.assertIn("not blind\ninstaller retries", source)


if __name__ == "__main__":
    unittest.main()
