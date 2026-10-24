#!/usr/bin/env bash
# SPDX-License-Identifier: Apache-2.0
# Test-merges the upstream-main mirror into main on a sync/<date> branch and pushes that branch.
# Prints the branch name on the last line of stdout, or nothing when main already contains the
# mirror. Exits 1 on a merge conflict, pushing nothing. Never touches main or upstream-main.
set -euo pipefail

fork_remote=${FORK_REMOTE:-origin}
branch=${SYNC_BRANCH:-sync/$(date -u +%F)}

git fetch --no-tags "$fork_remote" main upstream-main
main=$(git rev-parse "refs/remotes/$fork_remote/main")
mirror=$(git rev-parse "refs/remotes/$fork_remote/upstream-main")

if git merge-base --is-ancestor "$mirror" "$main"; then
  echo "main already contains upstream-main ($mirror)" >&2
  exit 0
fi

git switch -q -C "$branch" "$main"
if ! git merge -q --no-ff --no-edit -m "Merge upstream-main ($mirror) into main" "$mirror"; then
  echo "upstream-main does not merge cleanly into main; conflicts:" >&2
  git diff --name-only --diff-filter=U >&2
  git merge --abort
  exit 1
fi
# A sync branch is disposable: a rerun on the same day replaces it.
git push -q --force "$fork_remote" "HEAD:refs/heads/$branch"
echo "$branch"
