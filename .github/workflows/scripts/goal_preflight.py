"""Skip idle Goal runs before gh-aw initializes a model or its tools.

This only discovers whether work exists. The normal scheduler retains ownership
of selection and reads restored repo-memory; explicit steering must not be lost
just because it names an issue that is not yet labeled as a goal.
"""
from __future__ import annotations

import json
import os
import re
import sys
import urllib.error
import urllib.parse
import urllib.request


class PreflightError(RuntimeError):
    """Discovery failed; an empty queue has not been established."""


def _get_page(url: str, token: str):
    request = urllib.request.Request(url, headers={
        "Authorization": "Bearer " + token,
        "Accept": "application/vnd.github+json",
    })
    try:
        with urllib.request.urlopen(request, timeout=30) as response:
            return json.load(response), response.headers.get("Link", "")
    except (urllib.error.URLError, ValueError, OSError) as error:
        # Do not include response bodies or credential-bearing request objects.
        raise PreflightError("Could not read goal issues from GitHub") from error


def _next_page(link_header: str, initial_url: str) -> str | None:
    for part in link_header.split(","):
        match = re.match(r'^\s*<([^>]+)>;\s*rel="next"\s*$', part)
        if match:
            url = match.group(1)
            candidate = urllib.parse.urlsplit(url)
            initial = urllib.parse.urlsplit(initial_url)
            if ((candidate.scheme, candidate.netloc, candidate.path) !=
                    (initial.scheme, initial.netloc, initial.path)):
                raise PreflightError("Unexpected pagination URL from GitHub")
            return url
    return None


def has_open_goal(repo: str, token: str, api_url: str = "https://api.github.com",
                  get_page=_get_page) -> bool:
    if not token or not re.fullmatch(r"[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+", repo):
        raise PreflightError("Goal discovery requires a repository and GitHub token")
    initial_url = (api_url.rstrip("/") + "/repos/" + repo +
                   "/issues?labels=goal&state=open&per_page=100")
    url = initial_url
    visited = set()
    while url:
        if url in visited:
            raise PreflightError("GitHub repeated a goal issue page")
        visited.add(url)
        body, link_header = get_page(url, token)
        if not isinstance(body, list):
            raise PreflightError("GitHub did not return a goal issue list")
        for issue in body:
            if not isinstance(issue, dict):
                raise PreflightError("GitHub returned an invalid goal issue")
            if issue.get("pull_request") or issue.get("state") != "open":
                continue
            labels = issue.get("labels")
            if not isinstance(labels, list) or any(
                not isinstance(label, dict) or not isinstance(label.get("name"), str)
                for label in labels
            ):
                raise PreflightError("GitHub returned invalid goal labels")
            names = {label["name"] for label in labels}
            if "goal" in names and "goal-completed" not in names:
                return True
        url = _next_page(link_header, initial_url)
    return False


def has_goal_command(event_name: str, event: dict) -> bool:
    if event_name in ("issue_comment", "pull_request_review_comment", "discussion_comment"):
        entity = event.get("comment", {})
    elif event_name in ("issues", "pull_request", "discussion"):
        entity = event.get({"issues": "issue"}.get(event_name, event_name), {})
    else:
        return False
    body = entity.get("body", "") if isinstance(entity, dict) else ""
    return isinstance(body, str) and (
        body == "/goal" or body.startswith("/goal ") or body.startswith("/goal\n")
    )


def requested_issue_is_unfinished(repo: str, token: str, number: int,
                                  api_url: str = "https://api.github.com", get_page=_get_page) -> bool:
    if not token or not re.fullmatch(r"[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+", repo):
        raise PreflightError("Goal discovery requires a repository and GitHub token")
    if not isinstance(number, int) or isinstance(number, bool) or number <= 0:
        raise PreflightError("Requested goal issue must be a positive issue number")
    issue, _ = get_page(api_url.rstrip("/") + "/repos/" + repo + "/issues/" + str(number), token)
    if (not isinstance(issue, dict) or "pull_request" in issue or
            type(issue.get("number")) is not int or issue["number"] != number or
            issue.get("state") not in ("open", "closed")):
        raise PreflightError("GitHub did not return the requested goal issue")
    labels = issue.get("labels")
    if not isinstance(labels, list) or any(
        not isinstance(label, dict) or not isinstance(label.get("name"), str)
        for label in labels
    ):
        raise PreflightError("GitHub returned invalid goal labels")
    return issue["state"] == "open" and "goal-completed" not in {label["name"] for label in labels}


def should_run(event_name: str, event: dict, discover, inspect_issue=None) -> tuple[bool, str]:
    if has_goal_command(event_name, event):
        # gh-aw's existing author/command authorization still applies.
        return True, "Explicit goal steering"
    if event_name == "workflow_dispatch":
        inputs = event.get("inputs") or {}
        if not isinstance(inputs, dict):
            raise PreflightError("Invalid workflow dispatch inputs")
        issue = inputs.get("issue", "")
        if issue is not None and str(issue).strip():
            text = str(issue).strip()
            if not re.fullmatch(r"[1-9][0-9]*", text):
                raise PreflightError("Requested goal issue must be a positive issue number")
            if inspect_issue is None:
                raise PreflightError("Explicit issue inspection is required")
            if inspect_issue(int(text)):
                return True, "Requested goal issue is open and unfinished"
            return False, "Requested goal issue is closed or completed; no model needed"
    elif event_name != "schedule":
        return False, "No goal command"
    if discover():
        return True, "Open unfinished goals exist"
    return False, "No open unfinished goal issues; no model needed"


def main() -> int:
    try:
        with open(os.environ["GITHUB_EVENT_PATH"], encoding="utf-8") as handle:
            event = json.load(handle)
        if not isinstance(event, dict):
            raise PreflightError("Invalid GitHub event")
        decision, reason = should_run(
            os.environ.get("GITHUB_EVENT_NAME", ""), event,
            lambda: has_open_goal(
                os.environ.get("GITHUB_REPOSITORY", ""),
                os.environ.get("GITHUB_TOKEN", ""),
                os.environ.get("GITHUB_API_URL", "https://api.github.com"),
            ),
            lambda number: requested_issue_is_unfinished(
                os.environ.get("GITHUB_REPOSITORY", ""),
                os.environ.get("GITHUB_TOKEN", ""), number,
                os.environ.get("GITHUB_API_URL", "https://api.github.com"),
            ),
        )
        with open(os.environ["GITHUB_OUTPUT"], "a", encoding="utf-8") as handle:
            handle.write("should_run=" + str(decision).lower() + "\n")
        print(reason)
        return 0
    except (PreflightError, OSError, ValueError, KeyError) as error:
        print("::error::Goal preflight failed: " + str(error), file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(main())
