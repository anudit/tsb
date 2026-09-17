"""Pure policy helpers for Autoloop's side-effecting scheduling entry point."""
import re


STATE_FILE_MAX_BYTES = 30720


def parse_machine_state(content):
    """Read the machine-state table without interpreting research prose as state."""
    state = {}
    section = re.search(r"## ⚙️ Machine State.*?\n(.*?)(?=\n## |\Z)", content, re.DOTALL)
    if not section:
        return state
    for row in re.finditer(r"\|\s*(.+?)\s*\|\s*(.+?)\s*\|", section.group(0)):
        raw_key, raw_val = (value.strip() for value in row.groups())
        if raw_key.lower() in ("field", "---", ":---", ":---:", "---:"):
            continue
        key = raw_key.lower().replace(" ", "_")
        state[key] = None if raw_val in ("—", "-", "") else raw_val
    for field in ("iteration_count", "consecutive_errors"):
        if field in state:
            try:
                state[field] = int(state[field])
            except (ValueError, TypeError):
                state[field] = 0
    for field in ("paused", "completed"):
        if field in state:
            state[field] = str(state[field]).lower() == "true"
    state["recent_statuses"] = [
        value.strip().lower() for value in (state.get("recent_statuses") or "").split(",")
        if value.strip()
    ]
    return state


def metric_direction(content):
    """Return (direction, error); never reverse an explicit evaluation contract."""
    stripped = re.sub(r"^(\s*<!--.*?-->\s*\n)*", "", content, flags=re.DOTALL)
    frontmatter = re.match(r"^---\s*\n(.*?)\n---\s*\n", stripped, re.DOTALL)
    declared = None
    if frontmatter:
        matches = re.findall(r"^metric_direction:\s*(.*?)\s*$", frontmatter.group(1), re.MULTILINE)
        if len(matches) > 1:
            return None, "duplicate metric_direction fields"
        if matches:
            declared = matches[0].split("#", 1)[0].strip().strip("\"'")
            if declared not in ("higher", "lower"):
                return None, "invalid metric_direction: expected higher or lower"
    evaluation = re.search(r"^## Evaluation\s*\n(.*?)(?=^## |\Z)", content, re.MULTILINE | re.DOTALL)
    directions = set()
    if evaluation:
        prose = re.sub(r"[`*_]", "", evaluation.group(1))
        directions = set(re.findall(r"\b(higher|lower)\s+is\s+better\b", prose.lower()))
    if len(directions) > 1 or (declared and directions and declared not in directions):
        return None, "conflicting metric direction in the program contract"
    if declared:
        return declared, None
    if directions:
        return directions.pop(), None
    return None, "metric direction missing from frontmatter and Evaluation"


def state_metadata(content):
    """Count UTF-8 bytes, matching repo-memory's configured per-file bound."""
    return {
        "state_file_size_bytes": len(content.encode("utf-8")),
        "state_file_max_bytes": STATE_FILE_MAX_BYTES,
    }


def _latest_entry(content, title):
    section = re.search(
        rf"^## [^\n]*\b{title}\b[^\n]*\n(.*?)(?=^## |\Z)",
        content, re.MULTILINE | re.DOTALL,
    )
    if not section:
        return ""
    body = section.group(1)
    entry = re.search(r"^### [^\n]+\n.*?(?=^### |\Z)", body, re.MULTILINE | re.DOTALL)
    if entry:
        return entry.group(0)
    # Older compact population files put the newest candidate on the first bullet.
    bullet = re.search(r"^- [^\n]*\bc\d+\b[^\n]*$", body, re.MULTILINE)
    return bullet.group(0) if bullet else ""


def pending_candidate_kind(state, content):
    """Pending work is a reason to reconcile, never evidence for acceptance."""
    if state.get("pending_tree"):
        return "tree"
    if state.get("pending_run") or (state.get("recent_statuses") or [None])[-1] == "pending-ci":
        return "legacy"
    # Do not let an old entry or a prose mention revive a resolved candidate.
    for title in ("Population", "Iteration History"):
        entry = _latest_entry(content, title)
        status = re.search(r"^\s*-?\s*\*{0,2}Status\*{0,2}:\s*(.+)$", entry, re.MULTILINE)
        if status:
            is_pending = re.search(r"\bpending[- ]ci\b", status.group(1), re.IGNORECASE)
        elif entry.startswith("- "):
            is_pending = re.search(r"\bpending[- ]ci\b", entry, re.IGNORECASE)
        else:
            is_pending = re.search(r"^\s*(?:⏳\s*)?Pending[- ]CI\b", entry, re.MULTILINE | re.IGNORECASE)
        if is_pending:
            return "legacy"
    return None


def automatic_skip_reason(state, content):
    """Explicit stops win; an automatic plateau cannot strand pending evidence."""
    if str(state.get("completed", "")).lower() == "true":
        return "completed: target metric reached"
    if str(state.get("paused", "")).lower() == "true":
        return f"paused: {state.get('pause_reason') or 'unknown'}"
    recent = state.get("recent_statuses", [])[-5:]
    if len(recent) == 5 and all(status == "rejected" for status in recent):
        if not pending_candidate_kind(state, content):
            return "plateau: 5 consecutive rejections"
    return None
