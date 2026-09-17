"""Executable policy regressions without running the scheduler's API/file writes."""
from pathlib import Path
import re
import unittest

from autoloop_policy import (
    automatic_skip_reason, metric_direction, parse_machine_state,
    pending_candidate_kind, state_metadata,
)


WORKFLOWS = Path(__file__).resolve().parents[1]


class AutoloopPolicyTest(unittest.TestCase):
    def test_reads_current_machine_state_fields(self):
        state = parse_machine_state("""## ⚙️ Machine State
| Field | Value |
|-------|-------|
| Pending Tree | abc123 |
| Pending Run | https://example/run |
| Paused | false |
| Completed | true |
| Iteration Count | 42 |
| Recent Statuses | accepted, pending-ci |
## Lessons
| Paused | true |
""")
        self.assertEqual(state["pending_tree"], "abc123")
        self.assertEqual(state["iteration_count"], 42)
        self.assertEqual(state["recent_statuses"], ["accepted", "pending-ci"])
        self.assertFalse(state["paused"])
        self.assertTrue(state["completed"])

    def test_direction_from_frontmatter_or_explicit_evaluation_prose(self):
        self.assertEqual(metric_direction("---\nmetric_direction: lower # ratio\n---\n"), ("lower", None))
        for value in ("higher", "lower"):
            self.assertEqual(metric_direction(f"## Evaluation\n**{value.title()} is better.**\n"), (value, None))

    def test_ambiguous_invalid_or_conflicting_direction_is_not_defaulted(self):
        for content in (
            "## Evaluation\nA score.\n",
            "---\nmetric_direction: backwards\n---\n",
            "---\nmetric_direction: lower\nmetric_direction: higher\n---\n",
            "---\nmetric_direction: higher\n---\n## Evaluation\nLower is better.\n",
            "## Evaluation\nLower is better. Higher is better.\n",
            "## Goal\nLower is better.\n## Evaluation\nA score.\n",
        ):
            with self.subTest(content=content):
                direction, error = metric_direction(content)
                self.assertIsNone(direction)
                self.assertIsNotNone(error)

    def test_repository_program_contracts_resolve_without_definition_edits(self):
        programs = WORKFLOWS.parents[1] / ".autoloop" / "programs"
        for name, expected in (("perf-comparison", "higher"), ("tsb-perf-evolve", "lower")):
            self.assertEqual(metric_direction((programs / name / "program.md").read_text()), (expected, None))

    def test_current_pending_tree_or_run_is_reconciled_before_plateau(self):
        for field, expected in (("pending_tree", "tree"), ("pending_run", "legacy")):
            state = {field: "published-evidence", "recent_statuses": ["rejected"] * 5}
            self.assertEqual(pending_candidate_kind(state, ""), expected)
            self.assertIsNone(automatic_skip_reason(state, ""))

    def test_latest_legacy_population_and_history_are_reconciled_before_plateau(self):
        state = {"recent_statuses": ["pending-ci"] + ["rejected"] * 9}
        for content in (
            "## 🧬 Population (summary)\n- **c086** (gen 86, ⏳ pending-ci): commit abc.\n- **c085** rejected.\n",
            "## 📊 Iteration History\n### Iteration 86\n⏳ Pending CI | commit abc.\n### Iteration 85\nRejected.\n",
        ):
            self.assertEqual(pending_candidate_kind(state, content), "legacy")
            self.assertIsNone(automatic_skip_reason(state, content))

    def test_old_pending_or_future_prose_does_not_revive_resolved_work(self):
        content = """## 🧬 Population (summary)
- **c087** accepted.
- **c086** pending-ci.
## 📊 Iteration History
### Iteration 87
Accepted.
### Iteration 86
Pending CI.
## Future Directions
Resolve pending-ci someday.
"""
        state = {"recent_statuses": ["pending-ci"] + ["rejected"] * 9}
        self.assertIsNone(pending_candidate_kind(state, content))
        self.assertEqual(automatic_skip_reason(state, content), "plateau: 5 consecutive rejections")

    def test_explicit_pause_and_completion_win_over_pending_work(self):
        for field in ("paused", "completed"):
            for value in (True, "true"):
                state = {field: value, "pending_tree": "abc", "pause_reason": "human decision"}
                self.assertTrue(automatic_skip_reason(state, "").startswith(field))

    def test_resolved_entry_notes_cannot_revive_pending_work(self):
        content = """## 🧬 Population
### Candidate c087
- **Status**: accepted
- **Notes**: Reconciled the previous pending-ci attempt.
## 📊 Iteration History
### Iteration 87
Accepted; previous pending-ci is resolved.
"""
        self.assertIsNone(pending_candidate_kind({}, content))

    def test_latest_current_pending_status_can_reconcile_without_tree(self):
        state = {"recent_statuses": ["rejected"] * 5 + ["pending-ci"]}
        self.assertEqual(pending_candidate_kind(state, ""), "legacy")

    def test_state_size_matches_utf8_and_declared_memory_limit(self):
        metadata = state_metadata("🧬 café")
        self.assertEqual(metadata["state_file_size_bytes"], len("🧬 café".encode("utf-8")))
        declared = re.search(r"^    max-file-size: (\d+)$", (WORKFLOWS / "autoloop.md").read_text(), re.MULTILINE)
        self.assertEqual(metadata["state_file_max_bytes"], int(declared.group(1)))
        self.assertEqual(state_metadata("")["state_file_size_bytes"], 0)


if __name__ == "__main__":
    unittest.main()
