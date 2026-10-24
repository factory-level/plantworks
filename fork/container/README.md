<!-- SPDX-License-Identifier: Apache-2.0 -->
# Container image (PW-25)

One image, `fork-runtime`, runs each Plantworks role. The name is brand-neutral, as `fork/` is.

```
fork/container/build.sh [commit]   # builds fork-runtime:<commit> locally and prints the tag; never pushes
fork/container/smoke.sh [image]    # checks every role against stubs (needs Docker)
```

| Role (first argument) | Runs | Listens |
|---|---|---|
| `daemon` | `plantworks daemon start` (PW-16: Pi-only, no kernel), then follows its log; the container stops when the daemon does | `127.0.0.1:7533` only. Any other `OPENRIG_BIND_HOST` is refused (exit 2) |
| `broker` | `plantworks pw broker serve` (PW-17/18/19) | `PLANTWORKS_BROKER_HOST:PLANTWORKS_BROKER_PORT`, default `127.0.0.1:7534`. A non-loopback bind needs `PLANTWORKS_BROKER_TOKEN` (the broker refuses otherwise) |
| `worker` | `plantworks pw worker run --team $PLANTWORKS_TEAM --seat $PLANTWORKS_SEAT [--class $PLANTWORKS_CLASS]` (PW-21) | nothing |
| anything else | `plantworks <args>`, for example `--version`, `pw team emit ...` or `pw worker drain ...` once PW-22 merges | |

**Environment and paths:**
- **State:** `OPENRIG_HOME=/var/lib/fork` holds the daemon home and the broker's SQLite, so mount a volume there.
- **Team specs:** these are read from `/etc/fork/teams/<team>/team.json`; mount the emitted files read-only.
- **Broker settings:** `PLANTWORKS_PLATFORM_FILE` and `PLANTWORKS_BROKER_DB` pass `--platform` and `--db` through.
- **Secrets:** `PLANTWORKS_SLOT_CAP`, `PLANTWORKS_BROKER_TOKEN`, `PLANTWORKS_LLM_URL`, `PLANTWORKS_LLM_API_KEY` and `*_CALLBACK` are read as usual. No secret is baked into the image.

## How the roles fit together, and what this doesn't solve

- **One network namespace.** The daemon binds loopback only, because its queue routes aren't authenticated (see `../src/daemon/README.md`). So the broker and the workers must share its network namespace: containers in one pod, or `docker run --network container:<daemon>`. The broker reaches the daemon at `PLANTWORKS_DAEMON_URL` (default `http://127.0.0.1:7533`).
- **No remote seat transport.** Pi seats are local tmux sessions in the daemon's container, as upstream runs them. A worker in another pod can't drive a seat, and neither the S1 startup-options passthrough (PW-31) nor these images change that. It's a recorded deployment blocker, not something these images fix.
- **The slot cap is unchanged.** It counts broker job states, not physical Pi execution. An ambiguous handoff keeps its slot, and stopping a worker container proves nothing about a Pi run in progress.
- **No health checks or drain hooks yet.** The image defines no `HEALTHCHECK`. The broker's `/healthz` and `worker drain` come with PW-22; add them once it merges.

## Pins and how the image is built

- **Base:** upstream's digest-pinned Debian, `docker/testbed/base-image`. `build.sh` refuses a reference without `@sha256:`.
- **Node:** 22.22.1, upstream's testbed pin, checked against nodejs.org's `SHASUMS256.txt`.
- **Pi:** `@earendil-works/pi-coding-agent@1.4.0`, whose npm integrity is checked against the platform pin before install. Pi's own dependencies are still resolved from the npm registry at build time; they aren't pinned.
- **Source:** the build context is a clean `git archive` of one commit, so untracked files can't reach the image. The CLI and daemon are built with `npm ci` from the committed lockfile, and the fork imports their `dist/` by path.
- **Runtime:** the image runs as uid 10001 under `tini`. It is tagged locally only, with no registry and no published digest.

## Deliberately left out

- **No multi-arch or reproducible-digest builds, and no registry push.** Add them with the deployment work (#993).
- **Dev dependencies stay in the image.** Prune them if image size matters.
- **No CI image build.** It takes several minutes, so `smoke.sh` runs locally. Add a CI job if images start changing often.
