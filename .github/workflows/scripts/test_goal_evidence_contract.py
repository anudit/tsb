"""Prevent evidence-shaped no-ops from satisfying runtime-dependent goals."""
from pathlib import Path
import unittest


class GoalEvidenceContractTest(unittest.TestCase):
    def test_completion_requires_executed_assertions_and_runtime_identity(self):
        source = (Path(__file__).resolve().parents[1] / "goal.md").read_text()
        completion = source.split("## Completion\n", 1)[1].split("## Blocked Runs\n", 1)[0]
        for requirement in (
            "must execute the implementation", "not just materialize expected",
            "Count the assertions actually exercised", "identify the runtime",
            "Wasm rather than its fallback", "Missing-runtime early returns",
            "silently skipped tests are missing evidence",
        ):
            with self.subTest(requirement=requirement):
                self.assertIn(requirement, completion)


if __name__ == "__main__":
    unittest.main()
