<!-- SPDX-License-Identifier: Apache-2.0 -->
# Contributing to the fork

Upstream's `CONTRIBUTING.md` still applies. This file adds the one rule that keeps the fork
mergeable.

## The rule: additive first

Put new code under `fork/`, and reach upstream only through what it already exposes: exported
functions such as `createProgram()`, the CLI, the daemon's HTTP API, configuration and
environment variables, and files the runtime reads (for example Pi's `models.json`).

Modify an upstream file (a **seam**) only when no such injection point exists. When you do:

1. Add a row to `fork/PATCHES.md` (ID, file, reason, card) in the same pull request.
2. Mark the change with `fork-seam: <ID>` on the line above it.
3. Keep the change to the fewest lines possible: one call into `fork/` code is ideal.
4. Prefer adding the injection point upstream, then removing the seam once upstream ships it.

A file the fork adds outside `fork/` (for example a GitHub Actions workflow) gets a `fork-`
prefix and a row under "Additions outside fork/". The root `package.json` and
`package-lock.json` are never changed.

## Branches and upstream

`main` is the fork. Upstream arrives only as merge commits from the `upstream-main` mirror, and
nothing is pushed to upstream. See `fork/UPSTREAM.md`.

## Pull requests

- One card per branch and pull request, titled `PW-xx: ...`.
- Each pull request is reviewed by someone other than its author, and needs green CI before it
  merges.
- New files under `fork/` start with the SPDX header (`npm run check:headers` from `fork/`).
- This repository is public. No secrets, real hostnames or IP addresses, or personal or client
  details. Use `example.invalid` and documentation address ranges in tests and samples.
- Tests never call shared inference. Use a local stub OpenAI-compatible server.
