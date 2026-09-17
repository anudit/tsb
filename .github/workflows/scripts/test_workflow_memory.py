"""The scheduler must read the directory whose edits gh-aw actually persists."""
import ast
from pathlib import Path
import re
import unittest


WORKFLOWS = Path(__file__).resolve().parents[1]


class WorkflowMemoryTest(unittest.TestCase):
    def test_scheduler_and_generated_memory_transport_use_the_same_directory(self):
        for name, variable in (("autoloop", "repo_memory_dir"), ("goal", "REPO_MEMORY_DIR")):
            with self.subTest(workflow=name):
                scheduler = WORKFLOWS / "scripts" / f"{name}_scheduler.py"
                tree = ast.parse(scheduler.read_text())
                assignment = next(
                    node for node in tree.body
                    if isinstance(node, ast.Assign)
                    and any(isinstance(target, ast.Name) and target.id == variable
                            for target in node.targets)
                )
                directory = ast.literal_eval(assignment.value)
                lock = (WORKFLOWS / f"{name}.lock.yml").read_text()
                source = (WORKFLOWS / f"{name}.md").read_text()
                clone_dirs = re.findall(r"^ +MEMORY_DIR: (.+)$", lock, re.MULTILINE)
                artifact_dirs = re.findall(r"^ +ARTIFACT_DIR: (.+)$", lock, re.MULTILINE)
                self.assertEqual(set(clone_dirs), {directory})
                self.assertEqual(set(artifact_dirs), {directory})
                self.assertIn(f"`{directory}/`", source)
                self.assertNotIn("Clone repo-memory for scheduling", source)
                self.assertLess(lock.index("clone_repo_memory_branch.sh"),
                                lock.index(f"{name}_scheduler.py"))


if __name__ == "__main__":
    unittest.main()
