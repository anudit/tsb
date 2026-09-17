"""Real work shares the publication lock; irrelevant events do not occupy it."""
import json
from pathlib import Path
import re
from types import SimpleNamespace
import unittest


WORKFLOWS = Path(__file__).resolve().parents[1]


def group_for(workflow, event_name, run_id, repo="owner/repo", **fields):
    source = (WORKFLOWS / (workflow + ".md")).read_text()
    block = source.split("\nconcurrency:\n", 1)[1].split("\npermissions:", 1)[0]
    group = re.search(r"  group: >-\n(.*?)  cancel-in-progress:", block, re.DOTALL).group(1)
    group = " ".join(group.split())
    event = SimpleNamespace(**{
        key: SimpleNamespace(body=fields.get(key, ""), number=fields.get("issue_number", 1))
        for key in ("comment", "issue", "pull_request", "discussion")
    }, inputs=SimpleNamespace(issue=fields.get("issue_number", 1), program=fields.get("program", "example")))
    github = SimpleNamespace(repository=repo, workflow=workflow.title(), event_name=event_name,
                             run_id=run_id, event=event)
    def evaluate(match):
        expression = match.group(1).strip().replace("||", "or").replace("&&", "and")
        return str(eval(expression, {"__builtins__": {}}, {
            "github": github, "fromJSON": json.loads,
            "contains": lambda values, value: value in values,
            "startsWith": lambda body, prefix: body.startswith(prefix),
        }))
    return re.sub(r"\$\{\{(.*?)\}\}", evaluate, group)


class AgentConcurrencyTest(unittest.TestCase):
    def test_scheduled_and_manual_work_share_one_workflow_slot_across_issues(self):
        for workflow in ("goal", "autoloop"):
            with self.subTest(workflow=workflow):
                scheduled = group_for(workflow, "schedule", "run1")
                self.assertEqual(scheduled, group_for(workflow, "workflow_dispatch", "run2", issue_number=1, program="first"))
                self.assertEqual(scheduled, group_for(workflow, "workflow_dispatch", "run3", issue_number=2, program="second"))
                self.assertTrue(scheduled.endswith("-work"))

    def test_every_command_event_shape_joins_the_same_slot(self):
        for workflow in ("goal", "autoloop"):
            scheduled = group_for(workflow, "schedule", "scheduled")
            for event, field in (("issues", "issue"), ("issue_comment", "comment"),
                                 ("pull_request", "pull_request"), ("pull_request_review_comment", "comment"),
                                 ("discussion", "discussion"), ("discussion_comment", "comment")):
                for body in ("/" + workflow, "/" + workflow + " #42", "/" + workflow + "\n#42"):
                    with self.subTest(workflow=workflow, event=event, body=body):
                        self.assertEqual(scheduled, group_for(workflow, event, "command", **{field: body}))

    def test_unrelated_events_have_independent_groups_even_on_a_goal_issue(self):
        for workflow in ("goal", "autoloop"):
            for event, fields in (("issue_comment", {"comment": "ordinary reply", "issue": "/" + workflow}),
                                  ("pull_request", {"pull_request": "ordinary PR"}),
                                  ("issues", {"issue": "ordinary issue"}),
                                  ("push", {})):
                with self.subTest(workflow=workflow, event=event):
                    one = group_for(workflow, event, "run1", **fields)
                    two = group_for(workflow, event, "run2", **fields)
                    self.assertNotEqual(one, two)
                    self.assertNotEqual(one, group_for(workflow, "schedule", "run3"))

    def test_repository_and_workflow_isolation(self):
        self.assertNotEqual(group_for("goal", "schedule", "1"), group_for("autoloop", "schedule", "1"))
        self.assertNotEqual(group_for("goal", "schedule", "1"), group_for("goal", "schedule", "1", repo="other/repo"))

    def test_top_level_queue_covers_publication_without_canceling_work(self):
        for workflow in ("goal", "autoloop"):
            with self.subTest(workflow=workflow):
                source = (WORKFLOWS / (workflow + ".md")).read_text()
                block = source.split("\nconcurrency:\n", 1)[1].split("\npermissions:", 1)[0]
                self.assertIn("cancel-in-progress: false", block)
                self.assertIn("queue: max", block)
                self.assertIn("job-discriminator: ${{ github.run_id }}", block)


if __name__ == "__main__":
    unittest.main()
