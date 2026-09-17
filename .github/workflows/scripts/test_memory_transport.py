"""Exercise pinned gh-aw functions, not an approximation of its glob behavior."""
import hashlib
import json
from pathlib import Path
import re
import subprocess
import unittest


WORKFLOWS = Path(__file__).resolve().parents[1]
FIXTURES = Path(__file__).resolve().parent / "fixtures" / "gh-aw-v0.87.10"


class MemoryTransportTest(unittest.TestCase):
    def test_fixture_bytes_match_the_pinned_framework(self):
        for name, expected in (
            ("glob_pattern_helpers.cjs", "7f8f41db39abc0d1fdecc5a04fda79123fd7f9e1"),
            ("validate_memory_files.cjs", "2fe8bf15b7611c029ce5631e27b69f9a70a96dd0"),
        ):
            with self.subTest(file=name):
                data = (FIXTURES / name).read_bytes()
                blob = b"blob " + str(len(data)).encode() + b"\0" + data
                self.assertEqual(hashlib.sha1(blob).hexdigest(), expected)

    def test_actual_framework_accepts_root_markdown_without_weakening_file_types(self):
        script = r'''
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const vm = require("node:vm");
const fixture = process.argv[1];
const { globPatternToRegex } = require(path.join(fixture, "glob_pattern_helpers.cjs"));
const memory = fs.mkdtempSync(path.join(os.tmpdir(), "memory-transport-"));
try {
  // Exactly the invocation made by pinned push_repo_memory.cjs.
  for (const pattern of ["*.md", "**/*.md"]) {
    const regex = globPatternToRegex(pattern, { matchSubfolderRoot: !pattern.includes("/") });
    assert.equal(regex.test("program.md"), false);
    assert.equal(regex.test("nested/program.md"), true);
  }
  const moduleObject = { exports: {} };
  vm.runInNewContext(fs.readFileSync(path.join(fixture, "validate_memory_files.cjs"), "utf8"), {
    module: moduleObject,
    require: name => name === "./error_helpers.cjs"
      ? { getErrorMessage: error => error.message }
      : require(name),
  });
  const { validateMemoryFiles } = moduleObject.exports;
  const log = { info() {}, error() {} };
  fs.mkdirSync(path.join(memory, "nested"));
  fs.writeFileSync(path.join(memory, "program.md"), "# Current checkpoint\n");
  fs.writeFileSync(path.join(memory, "nested", "history.md"), "# Older checkpoint\n");
  assert.equal(validateMemoryFiles(memory, "repo", [".md"], log).valid, true);
  fs.writeFileSync(path.join(memory, "unexpected.js"), "unexpected\n");
  const rejected = validateMemoryFiles(memory, "repo", [".md"], log);
  assert.equal(rejected.valid, false);
  assert.equal(rejected.invalidFiles.length, 1);
  assert.equal(rejected.invalidFiles[0], "unexpected.js");
} finally {
  fs.rmSync(memory, { recursive: true, force: true });
}
'''
        subprocess.run(["node", "-e", script, str(FIXTURES)], check=True)

    def test_workflow_sources_use_depth_independent_markdown_allowlist(self):
        for name in ("autoloop", "goal"):
            with self.subTest(workflow=name):
                source = (WORKFLOWS / (name + ".md")).read_text()
                memory = source.split("  repo-memory:\n", 1)[1].split("\n\n", 1)[0]
                self.assertIn('allowed-extensions: [".md"]', memory)
                self.assertNotIn("file-glob:", memory)

    def test_generated_transport_keeps_the_same_restriction(self):
        for name in ("autoloop", "goal"):
            with self.subTest(workflow=name):
                lock = (WORKFLOWS / (name + ".lock.yml")).read_text()
                # The publication job must receive the real extension restriction,
                # not a silently reintroduced compiler-default glob.
                push = lock.split("id: push_repo_memory_default", 1)[1].split("\n  safe_outputs:", 1)[0]
                self.assertNotIn("FILE_GLOB_FILTER:", push)
                allowed = re.search(r"ALLOWED_EXTENSIONS: '([^']+)'", push)
                self.assertIsNotNone(allowed)
                self.assertEqual(json.loads(allowed.group(1)), [".md"])


if __name__ == "__main__":
    unittest.main()
