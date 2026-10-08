#!/bin/bash
# shellcheck disable=SC2034 # DRY and ALLOW_UNPUSHED are set by the scripts that source this
# Shared by dev/deploy/hub.sh and dev/deploy/web.sh (sourced, not run): the guards, dry-run, the build tree.
# README.md "Deploy without CI".

REPO=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)
DRY=0
ALLOW_UNPUSHED=0

say() { printf '\033[1m==> %s\033[0m\n' "$*" >&2; }
die() { printf 'error: %s\n' "$*" >&2; exit 1; }

# run CMD...: runs it, or with --dry-run prints it.
run() {
  if [ "$DRY" = 1 ]; then printf '[dry-run] %s\n' "$*" >&2; else "$@"; fi
}

# A refusal stops a real run; a dry run reports it and goes on, so the whole plan can be read.
refuse() {
  if [ "$DRY" = 1 ]; then printf '[dry-run] WOULD REFUSE: %s\n' "$*" >&2; else die "$*"; fi
}

# The deploy is the commit HEAD as it is on origin/main: a clean tree (tracked files; untracked ones never reach the
# build, which is made from `git archive HEAD`), on main, and main neither behind nor diverged from origin/main.
# Ahead (commits not pushed yet) only with --allow-unpushed.
guard_tree() {
  local branch ahead behind
  git -C "$REPO" diff --quiet HEAD -- || refuse "the tree has uncommitted changes (git status)"
  git -C "$REPO" diff --cached --quiet || refuse "the index has staged changes"
  branch=$(git -C "$REPO" symbolic-ref --quiet --short HEAD || echo detached)
  [ "$branch" = main ] || refuse "on branch '$branch', not main"
  say "fetching origin/main"
  git -C "$REPO" fetch --quiet origin main || refuse "git fetch origin main failed"
  ahead=$(git -C "$REPO" rev-list --count origin/main..HEAD)
  behind=$(git -C "$REPO" rev-list --count HEAD..origin/main)
  if [ "$ahead" -gt 0 ] && [ "$behind" -gt 0 ]; then
    refuse "main and origin/main have diverged ($ahead ahead, $behind behind): rebase or merge first"
  elif [ "$behind" -gt 0 ]; then
    refuse "main is $behind commit(s) behind origin/main: pull first (this would deploy older code)"
  elif [ "$ahead" -gt 0 ] && [ "$ALLOW_UNPUSHED" != 1 ]; then
    refuse "main is $ahead commit(s) ahead of origin/main: push first, or pass --allow-unpushed"
  fi
  SHA=$(git -C "$REPO" rev-parse HEAD)
  say "deploying $SHA ($(git -C "$REPO" log -1 --format=%s HEAD))"
}

# build_tree: a fresh copy of HEAD (exactly the committed files) in a temp directory; prints its path.
build_tree() {
  local dir
  dir=$(mktemp -d "${TMPDIR:-/tmp}/trommi-deploy.XXXXXX")
  git -C "$REPO" archive HEAD | tar -x -C "$dir"
  printf '%s\n' "$dir"
}
