#!/usr/bin/env bash
# SPDX-License-Identifier: Apache-2.0
# Fast-forward the fork's upstream-main mirror to upstream/main. Never forces: if the mirror is
# not an ancestor of upstream/main it stops, because a pristine mirror only ever fast-forwards.
set -euo pipefail

fork_remote=${FORK_REMOTE:-origin}
upstream_remote=${UPSTREAM_REMOTE:-upstream}

git fetch --no-tags "$upstream_remote" main
target=$(git rev-parse "refs/remotes/$upstream_remote/main")

if git fetch --no-tags "$fork_remote" upstream-main 2>/dev/null; then
  current=$(git rev-parse "refs/remotes/$fork_remote/upstream-main")
  if [ "$current" = "$target" ]; then
    echo "upstream-main already at $target"
    exit 0
  fi
  if ! git merge-base --is-ancestor "$current" "$target"; then
    echo "upstream-main ($current) is not an ancestor of $upstream_remote/main ($target); refusing to rewrite the mirror" >&2
    exit 1
  fi
fi

git push "$fork_remote" "$target:refs/heads/upstream-main"
echo "upstream-main -> $target"
