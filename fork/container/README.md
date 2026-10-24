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
| `health` | the role-aware health check the image's `HEALTHCHECK` runs | |
| anything else | `plantworks <args>`, for example `--version`, `pw team emit ...` or `pw worker drain ...` | |

**Environment and paths:**
- **State:** `OPENRIG_HOME=/var/lib/fork` holds the daemon home and the broker's SQLite, so mount a volume there.
- **Team specs:** these are read from `/etc/fork/teams/<team>/team.json`; mount the emitted files read-only.
- **Broker settings:** `PLANTWORKS_PLATFORM_FILE` and `PLANTWORKS_BROKER_DB` pass `--platform` and `--db` through.
- **Worker settings:** the worker reads the same team specs and `PLANTWORKS_PLATFORM_FILE`, and runs its seat's call governor on `127.0.0.1:7535` (`PLANTWORKS_GOVERNOR_PORT`), so it needs `PLANTWORKS_LLM_URL` (and `PLANTWORKS_LLM_API_KEY` if the endpoint takes one). It writes the seat's Pi files under `OPENRIG_HOME`, so it shares the daemon's state volume, and it must start before the daemon launches the seat.
- **Secrets:** `PLANTWORKS_SLOT_CAP`, `PLANTWORKS_BROKER_TOKEN`, `PLANTWORKS_LLM_URL`, `PLANTWORKS_LLM_API_KEY` and `*_CALLBACK` are passed at run time. The build adds no secret of its own.

## How the roles fit together, and what this doesn't solve

- **One network namespace.** The daemon binds loopback only, because its queue routes aren't authenticated (see `../src/daemon/README.md`). So the broker and the workers must share its network namespace: containers in one pod, or `docker run --network container:<daemon>`. The broker reaches the daemon at `PLANTWORKS_DAEMON_URL` (default `http://127.0.0.1:7533`).
- **No remote seat transport.** Pi seats are local tmux sessions in the daemon's container, as upstream runs them. A worker in another pod can't drive a seat, and neither the S1 startup-options passthrough (PW-31) nor these images change that. It's a recorded deployment blocker, not something these images fix.
- **One worker per seat, with a stable identity.** Each worker container needs its own unique
  `PLANTWORKS_SEAT` that stays the same across restarts, and no two workers may ever run for the
  same seat at once. So don't run workers as one Deployment with replicas sharing a `--seat`:
  give each seat its own workload (for example a StatefulSet ordinal or one Deployment per seat).
  A second worker on the seat resumes it and voids an in-progress drain (which then exits 4),
  and overlapping workers interfere with reconciliation. A StatefulSet with seat = pod name is the
  safe shape. The seat must also be a Pi seat that the daemon in that pod actually runs.
- **The slot cap is unchanged.** It counts broker job states, not physical Pi execution. An ambiguous handoff keeps its slot, and stopping a worker container proves nothing about a Pi run in progress.
- **Health is liveness only.** The image's `HEALTHCHECK` runs `entrypoint.sh health`, which checks by role:
  - broker: `GET /healthz` (PW-22, unauthenticated) answers 200, so the broker serves and its store answers;
  - daemon: `daemon status` reports it running and not UNHEALTHY;
  - worker: the `pw worker run` process the role started (its recorded PID) is alive.

  It says nothing about jobs, slots or any Pi run.
- **Drain doesn't stop termination.** Use `plantworks pw worker drain --seat <seat> --timeout-s <n>` as the worker's preStop hook. It exits 0 when drained, 3 on timeout and 4 when another worker resumed the seat. A non-zero exit doesn't stop Kubernetes (or `docker stop`) from terminating the container after the grace period. Termination after 3 or 4 doesn't prove that Pi stopped, so the slot cap still counts only broker job states.

## Pins and how the image is built

- **Base:** upstream's digest-pinned Debian, `docker/testbed/base-image`. `build.sh` refuses a reference without `@sha256:`.
- **Node:** 22.22.1, upstream's testbed pin, checked against nodejs.org's `SHASUMS256.txt`.
- **Pi:** `@earendil-works/pi-coding-agent@1.4.0`, whose npm integrity is checked against the platform pin before install. Pi's own dependencies are still resolved from the npm registry at build time; they aren't pinned.
- **Source:** the build context is a clean `git archive` of one commit. Untracked and local files can't reach the image, but every file tracked at that commit does, so a secret committed to the repository would be included too; the archive is no substitute for keeping secrets out of git. The CLI and daemon are built with `npm ci` from the committed lockfile, and the fork imports their `dist/` by path.
- **Runtime:** the image runs as uid 10001 under `tini`. It is tagged locally only, with no registry and no published digest.
- **Labels:** `org.opencontainers.image.source` (the fork's repository), `licenses=Apache-2.0`, `base.name` (the digest-pinned base reference) and `revision` (the commit).
- **Upstream `rig`:** it is on `PATH` next to `plantworks`/`pwctl`, for Pi seats and operators. `OPENRIG_PORT=7533` and `OPENRIG_NO_KERNEL=1` point it at the same Pi-only daemon. Because the port comes from the environment, it takes precedence over the home's config file (upstream resolves env, then file, then default): in the image, `plantworks config set daemon.port` has no effect. Change the port with `-e OPENRIG_PORT=<port>` on every container instead; the roles, health check and smoke assume 7533. Start the daemon with the `daemon` role (`plantworks daemon start`), not `rig daemon start`.
- **CI:** Fork CI's `image-build` job runs `build.sh` and `smoke.sh` on every PR and push to main. It has no registry login and pushes nothing.

## Deliberately left out

- **No multi-arch or reproducible-digest builds, and no registry push.** Add them with the deployment work (#993).
- **Dev dependencies stay in the image.** Prune them if image size matters.
