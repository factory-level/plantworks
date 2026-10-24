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

## Additions outside fork/

Files the fork adds outside `fork/`, because a tool only reads them from a fixed place (for
example GitHub Actions workflows in `.github/workflows/`). They carry no marker. Their names
start with `fork-` so they never collide with an upstream file.

| File | Reason | Card |
|---|---|---|

## Never

- The root `package.json` and `package-lock.json` stay byte-identical to upstream. They never get
  a row.
- Upstream files are never deleted or renamed.
