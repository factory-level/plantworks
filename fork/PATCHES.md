<!-- SPDX-License-Identifier: Apache-2.0 -->
# Seam ledger

This is the single list of places where the fork touches files outside `fork/`.
`fork/scripts/check-seams.mjs` parses the two tables below, so keep their columns as they are:
one row per file, paths relative to the repository root, no wildcards.

The rule (see `CONTRIBUTING-fork.md`) is **additive first**. A row belongs here only when no
upstream injection point exists.

## Seams

Upstream files the fork modifies. Every modified region carries the marker comment
`fork-seam: <ID>`, in the file's own comment syntax, on the line above the change. Keep the
change as small as possible, so that conflicts land on one obvious line.

| ID | File | Reason | Card |
|---|---|---|---|
| PW-31 | `packages/daemon/src/index.ts` | Pass optional daemon options through `startServer` while retaining server-owned settings | PW-31 |
| PW-31 | `packages/daemon/test/index.test.ts` | Pin default startup behavior and supplied options passthrough | PW-31 |

## Additions outside fork/

Files the fork adds outside `fork/`, because a tool only reads them from a fixed place (for
example GitHub Actions workflows in `.github/workflows/`). They carry no marker. Their names
start with `fork-` so they never collide with an upstream file.

| File | Reason | Card |
|---|---|---|
| `.github/workflows/fork-ci.yml` | GitHub Actions reads workflows only from `.github/workflows/`. Runs the seam check, upstream build, fork tests and header check on every PR | PW-04 |
| `.github/workflows/fork-upstream-sync.yml` | GitHub Actions reads workflows only from `.github/workflows/`. Nightly upstream test-merge into a `sync/<date>` branch, checked, then a PR | PW-05 |

## Never

- The root `package.json` and `package-lock.json` stay byte-identical to upstream. They never get
  a row.
- Upstream files are never deleted or renamed.
