<!-- SPDX-License-Identifier: Apache-2.0 -->
# Tracking upstream

This repository is a fork of [`mvschwarz/openrig`](https://github.com/mvschwarz/openrig). It has
to keep taking upstream changes without merge pain, so it has two long-lived branches and two
remotes.

## Branches

| Branch | What it is | How it moves |
|---|---|---|
| `upstream-main` | An exact mirror of `upstream/main`, with no fork commits | Fast-forward only, through `fork/scripts/sync-upstream-main.sh`. A repository ruleset blocks force-pushes and deletion. |
| `main` | The fork | Pull requests. Upstream changes arrive only as **merge commits** from `upstream-main`. Never rebase `main`: published commit IDs stay pinned. |

`upstream-main` makes the question "what did upstream change?" a plain diff
(`git diff upstream-main main`), and it gives the nightly test-merge a fixed base.

## Remotes

| Remote | URL | Push |
|---|---|---|
| `origin` | `git@github.com:factory-level/plantworks.git` | Yes, by pull request |
| `upstream` | `https://github.com/mvschwarz/openrig.git` | **Disabled.** Nothing is ever pushed upstream from this fork. |

Set up a clone:

```bash
git remote add upstream https://github.com/mvschwarz/openrig.git
git remote set-url --push upstream DISABLED   # any push to upstream now fails
git fetch upstream
```

## Updating the mirror

```bash
fork/scripts/sync-upstream-main.sh
```

The script fetches `upstream/main` and pushes it to `origin/upstream-main` as a fast-forward. If
the mirror is not an ancestor of `upstream/main` (upstream rewrote history), it stops without
pushing. A person then decides what to do.

## Taking upstream into `main`

```bash
git switch -c sync/$(date +%F) origin/main
git merge --no-ff origin/upstream-main
# run upstream and fork checks, then open a pull request into main
```

Resolve conflicts in the merge commit. Never cherry-pick or rebase upstream commits onto `main`.
