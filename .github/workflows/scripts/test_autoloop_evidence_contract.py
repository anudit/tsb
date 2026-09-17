"""Source-contract checks for guardrails; live runs still verify agent behavior."""
from pathlib import Path
import unittest


WORKFLOWS = Path(__file__).resolve().parents[1]


class AutoloopEvidenceContractTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.source = (WORKFLOWS / "autoloop.md").read_text()
        cls.guard = cls.source.split("## Objective And Evidence Guard\n", 1)[1].split(
            "## Command Mode\n", 1
        )[0]
        cls.direction = cls.source.split("### Metric Direction\n", 1)[1].split(
            "## Program Definition\n", 1
        )[0]

    def test_stale_memory_cannot_expand_scope_or_pad_metrics(self):
        for requirement in (
            "every mode and program-specific strategy",
            "repo-memory is working history, not permission",
            "bulk domain generation",
            "one small, useful checkpoint",
            "metric-contract-mismatch",
            "edit protected program definitions or issue #1",
            "reset instead",
        ):
            with self.subTest(requirement=requirement):
                self.assertIn(requirement, self.guard)

    def test_parity_requires_independent_executed_behavior(self):
        for requirement in (
            "Tests must execute the tsb operation",
            "independently generated pandas results",
            "not\n  differential evidence",
            "in-scope denominator and a verified numerator",
            "completeness as\n  unknown",
        ):
            with self.subTest(requirement=requirement):
                self.assertIn(requirement, self.guard)

    def test_performance_requires_equivalent_measured_work(self):
        for requirement in (
            "verify equivalent outputs",
            "measured SHA, repeated\n  timings, and variability",
            "Separate cold work from repeated-input cache hits",
            "Do not add import-time JIT primers",
            "counts or successful parsing do not prove execution or speedup",
        ):
            with self.subTest(requirement=requirement):
                self.assertIn(requirement, self.guard)

    def test_missing_scheduler_direction_uses_contract_or_stops(self):
        self.assertIn("If the scheduler field is missing", self.direction)
        self.assertIn("program frontmatter or Evaluation prose", self.direction)
        self.assertIn("ambiguous or\nconflicting, stop", self.direction)
        self.assertNotIn("defaults to `higher` when unset", self.source)
        self.assertNotIn("program falls back to `higher`", self.source)


if __name__ == "__main__":
    unittest.main()
