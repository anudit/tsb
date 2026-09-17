#!/usr/bin/env bash
# Prepare an automation branch locally. Publication belongs to gh-aw safe outputs.
set -euo pipefail

sync_automation_branch() {
  local branch="${1:?automation branch required}"
  local base="${2:?base branch required}"
  local remote_head

  case "$branch" in
    autoloop/*|goal/*) ;;
    *) echo "Expected an autoloop/ or goal/ branch" >&2; return 1 ;;
  esac
  git check-ref-format --branch "$branch" >/dev/null
  git check-ref-format --branch "$base" >/dev/null
  [ "$branch" != "$base" ] || return 1
  if [ -n "$(git status --porcelain)" ]; then
    echo "Refusing to switch branches with uncommitted changes" >&2
    return 1
  fi

  git fetch origin "+refs/heads/$base:refs/remotes/origin/$base"
  # An empty successful response means the branch is absent. Network and
  # permission failures must stop instead of being mistaken for a first run.
  remote_head="$(git ls-remote --heads origin "refs/heads/$branch")"
  if [ -z "$remote_head" ]; then
    git checkout -b "$branch" "refs/remotes/origin/$base"
    return
  fi

  git fetch origin "+refs/heads/$branch:refs/remotes/origin/$branch"
  git checkout -B "$branch" "refs/remotes/origin/$branch"
  if ! git merge --no-edit "refs/remotes/origin/$base"; then
    git merge --abort
    echo "Base merge conflicts require a focused repair before the next iteration" >&2
    return 1
  fi
  # Both the old remote tip and current base must remain reachable. Rebase or
  # reset on a divergent branch would make the safe-output push non-fast-forward.
  git merge-base --is-ancestor "refs/remotes/origin/$branch" HEAD
  git merge-base --is-ancestor "refs/remotes/origin/$base" HEAD
}

sync_automation_branch "$@"
