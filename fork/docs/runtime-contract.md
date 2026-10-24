<!-- SPDX-License-Identifier: Apache-2.0 -->
# Runtime contract

What a platform has to provide to run Plantworks, and what it can rely on. Every row is backed
by the source it cites. Where the source does not establish something, this doc says so.

**Logical lifecycle is not physical execution.** The broker records job states (`queued`,
`claimed`, `running`, `done`, and so on). Nothing in `fork/` observes a Pi process. A state, a
timeout, a drain result or a container stopping is never evidence that Pi stopped.

## Processes

| Role | Processes | How many | Source |
|---|---|---|---|
| `daemon` | The upstream daemon (detached by `daemon start`), plus the entrypoint's bash loop and a `daemon logs --follow` child | One per pod. Every broker and worker of that pod talks to it | `fork/container/entrypoint.sh:27`–`:32` |
| Pi seat | One tmux session per seat, holding upstream's `pi-runner`. The runner spawns `pi --mode rpc`, and Pi spawns its tool processes | One per seat session, inside the daemon's container. Upstream launches these; nothing in `fork/` does | `packages/daemon/src/adapters/pi-runner-protocol.ts:10`–`:12` |
| `broker` | One Node process (`pw broker serve`), with an in-process reconciler on a 2 s interval | One per SQLite file is the tested shape. Several on one file can't exceed the slot cap, which is counted in one SQLite transaction; nothing else is claimed for that shape | `fork/src/broker/command.ts:33`, `:40`–`:47`; `fork/src/broker/README.md` "Slot cap" |
| `worker` | One Node process (`pw worker run`). It is the container's PID after `exec` | 0..N per team: **exactly one per seat name**, with a seat name that stays the same across restarts. A second process on the same name resumes the seat and voids a drain | `fork/container/entrypoint.sh:51`–`:52`; `fork/src/broker/worker.ts:18`–`:20` |
| Hermes kit (optional) | One Node process (`pw mcp serve --http`) | One per team | `fork/src/hermes/command.ts:9` |
| `pw job run` (Phase 0 only) | One Node process, an in-process per-seat governor, and one Pi child | One job at a time, with no daemon and no broker | `fork/src/job/run.ts:90`–`:96` |

## Storage and shared paths

| Path | Holds | Written by | Source |
|---|---|---|---|
| `$OPENRIG_HOME` (`/var/lib/fork` in the image, `~/.plantworks` otherwise) | The daemon home | the daemon | `fork/container/Dockerfile:61`; `fork/src/daemon/boot.ts:11`, `:20` |
| `$OPENRIG_HOME/plantworks/broker.sqlite`, or `--db` | Jobs, reservations, seat drains | the broker only. It is never the daemon's database | `fork/src/broker/command.ts:23`, `:33` |
| `$OPENRIG_HOME/state/pi/<session>/` | Pi seat state: `agent/` (`PI_CODING_AGENT_DIR`: `models.json`, `settings.json`, `auth.json`, skills), `sessions/` (`PI_CODING_AGENT_SESSION_DIR`) and `runner-state.json` | upstream's daemon and pi-runner. `fork/src/seat/` renders `agent/models.json` and `agent/settings.json` at the same path, today only from `pw job run` | `packages/daemon/src/startup.ts:693`; `packages/daemon/src/adapters/pi-runner-protocol.ts:23`–`:42`; `fork/src/seat/pi-seat-files.ts:17`–`:19`; `fork/src/job/run.ts:95` |
| `/etc/fork/teams/<team>/team.json` (`PLANTWORKS_TEAMS_DIR`) | Team specs emitted by `pw team emit`. Mount them read-only | an operator | `fork/container/Dockerfile:62`; `fork/src/broker/command.ts:28` |

**The seat-state volume.** Whatever writes a seat's `agent/` files and the daemon that launches
that seat must see the same `$OPENRIG_HOME`. In the images, that means one volume at
`/var/lib/fork` in the daemon's pod. The daemon's container needs it, and the broker needs it
too unless `--db` points elsewhere. A worker reads nothing from disk.

## Inputs

| Variable | Read by | Required | Default | Notes |
|---|---|---|---|---|
| `OPENRIG_HOME` | all | no | `~/.plantworks`; `/var/lib/fork` in the image | Read once, at upstream import (`fork/src/daemon/boot.ts:16`–`:20`) |
| `OPENRIG_NO_KERNEL` | daemon | forced to `1` | | Not overridable (`fork/src/daemon/boot.ts:21`) |
| `OPENRIG_BIND_HOST` | daemon | no | `127.0.0.1` | The image refuses anything but loopback, with exit 2 (`fork/container/entrypoint.sh:21`–`:24`) |
| `OPENRIG_AUTH_BEARER_TOKEN` | daemon, broker | for a non-loopback daemon bind | | Not request auth on the queue routes (`fork/src/daemon/README.md`, Limitations). The broker sends it to the daemon when set (`fork/src/broker/command.ts:36`) |
| `PLANTWORKS_TEAMS_DIR` | broker | yes, or `--teams` | `/etc/fork/teams` in the image | |
| `PLANTWORKS_DAEMON_URL` | broker | no | `http://127.0.0.1:7533` | `fork/src/broker/command.ts:14`, `:36` |
| `PLANTWORKS_BROKER_HOST`, `PLANTWORKS_BROKER_PORT` | image `broker` role | no | `127.0.0.1`, `7534` | `fork/container/entrypoint.sh:38` |
| `PLANTWORKS_BROKER_TOKEN` | broker, worker, kit | for a non-loopback broker bind | | When set, every `/plantworks/v1/` request needs it (`fork/src/broker/server.ts:95`–`:97`). Without it, a non-loopback bind is refused (`:168`–`:171`) |
| `PLANTWORKS_BROKER_PUBLIC_URL` | broker | for any non-loopback bind, unless `--public-url` is given | the listen address | The broker refuses to start without it off loopback (`fork/src/broker/server.ts:174`–`:176`). Used for approval `decisionUrl`s |
| `PLANTWORKS_PLATFORM_FILE`, `PLANTWORKS_BROKER_DB` | image `broker` role | no | | Passed as `--platform` and `--db` (`fork/container/entrypoint.sh:39`–`:40`) |
| `PLANTWORKS_SLOT_CAP` | broker | no | 1 per `slotBudgetKey` | A malformed value stops the broker (`fork/src/broker/command.ts:38`) |
| `PLANTWORKS_BROKER_SESSION` | broker | no | `plantworks-broker` | The qitem source session |
| `*_CALLBACK` | broker, `pw job run` | when a team spec names one | | `callbackDefault` must be exactly `${NAME_CALLBACK}`; the operator supplies the URL |
| `PLANTWORKS_CALLBACK_TOKEN_<NAME>` | broker | when team `events.auth.secretRef` names `<NAME>` | | Only this dedicated operator credential namespace is available to team refs; broker/daemon process variables are not addressable. Unknown or unset references stop broker startup; values are not logged or emitted. |
| `PLANTWORKS_BROKER_URL` | worker, kit | no | `http://127.0.0.1:7534` | `fork/src/broker/worker.ts:11` |
| `PLANTWORKS_TEAM`, `PLANTWORKS_SEAT`, `PLANTWORKS_CLASS` | image `worker` role | team and seat | | `fork/container/entrypoint.sh:46`–`:49` |
| `PLANTWORKS_TEAM` | kit | yes | | The kit serves exactly one team (`fork/src/hermes/command.ts:12`–`:13`) |
| `FORK_ROLE_FILE` | image entrypoint | no | `/tmp/fork-role` | Where a long-running role records itself for `HEALTHCHECK` (`fork/container/entrypoint.sh:16`) |
| `PLANTWORKS_LLM_URL`, `PLANTWORKS_LLM_API_KEY` | `pw job run` (governor), `pw llm preflight` | for those commands | | Never passed to Pi (`fork/src/job/run.ts:140`) |
| `PLANTWORKS_MCP_TOKEN` | kit, `--http` | yes with `--http` | | |

## Fork-defined contract additions

The following additive shapes are **fork-defined pending HarnessHG acknowledgement**. They are
validated and documented here to make the current implementation explicit; they do not claim an
upstream or HarnessHG contract decision.

- Optional envelope `repo` (an `owner/name` string), `contextBudget` (positive integer tokens; absent
  uses the selected class context), and opaque `origin: { kind, ref }`.
- `plantworks.job.state` data may include known `qitemId`, `seat`, `summary` (at most 2 KiB in
  UTF-8), `artifacts: [{ name, uri }]`, `evidence: [{ kind, uri }]`, and `usage` with prompt and
  completion token counts only when known.
- Broker event ids use the persisted `job_transitions.id` directly:
  `<jobId>:<transitionSeq>`. The id is stable across replay and distinct for repeated states. The
  sequence is globally increasing and increasing per job, but not dense per job.
- Callback URL remains operator-owned in `events.callbackDefault`, which must be exactly
  `${NAME_CALLBACK}`; literal or mixed URLs are rejected. Optional team
  `events.auth: { secretRef: NAME }` resolves only `PLANTWORKS_CALLBACK_TOKEN_NAME`, an explicit
  callback-only operator credential. No general process environment name is addressable. There is
  no job-envelope callback URL or auth field. With auth absent, callbacks remain unauthenticated.
- The broker keeps a durable delivery cursor per team. It retries each event for at most three
  exhausted emitter budgets (eight HTTP attempts per budget), then records it as parked and logs
  once; other teams continue independently. Parked events remain in transition history and the
  failure table, but no HTTP replay or pull endpoint is provided yet.

## Network

| Listener | Default | Auth | Who must reach it |
|---|---|---|---|
| daemon | `127.0.0.1:7533`, loopback only in the image | none on the queue routes | the broker. The daemon also wakes seats in its own container |
| broker | `127.0.0.1:7534` | bearer when the token is set. `GET /healthz` is open | workers, the kit, an autoscaler (with the bearer) and the approval decider |
| kit | `127.0.0.1:7535` | bearer (`PLANTWORKS_MCP_TOKEN`) | Hermes |

Because the daemon binds loopback only, **the broker and every worker share the daemon's network
namespace**: containers in one pod, or `docker run --network container:<daemon>`
(`fork/container/README.md`). The broker is the only process that calls the daemon. A worker
calls only the broker.

## Termination

| Process | On SIGTERM | Bound | Source |
|---|---|---|---|
| worker | Sets a stop flag. The loop leaves at its next check, which is after the current sleep (`--poll-ms`, default 2000) and any request in flight (15 s timeout). It does not touch the job it waits for: the broker still counts it | about poll + 15 s | `fork/src/broker/worker.ts:21`–`:42` |
| `worker drain` (preStop) | Sets the drain, then polls until the seat holds nothing, until `--timeout-s` (default 300) runs out, or until another worker resumes the seat. It exits 0, 3 or 4 | `--timeout-s` (its first request counts inside it), then at most one more poll sleep and one 15 s request | `fork/src/broker/worker.ts:47`–`:82` |
| broker | Stops the reconciler and the approval and outbox timers, aborts any in-flight event delivery (including one waiting out a retry backoff), closes the HTTP server, then closes SQLite. An aborted job-state delivery records no failure and doesn't advance the cursor, so the next start replays it with the same event id. An aborted approval event is lost, as approval events are in memory only | prompt for event delivery: no retry backoff outlives the stop. Closing the HTTP server waits for open requests | `fork/src/broker/command.ts:51`–`:53`; `fork/src/broker/server.ts` (`startBroker` close); `fork/src/events/outbox.ts` (`stop`) |
| daemon role | The entrypoint traps TERM and runs `plantworks daemon stop` | not bounded in source | `fork/container/entrypoint.sh:31` |
| `pw job run` | No signal handler. Its Pi stop sequence (RPC `abort` 3 s, close stdin and wait 5 s, SIGTERM and wait 2 s, then SIGKILL) runs only when the job ends, times out or hits `call-deadline` | about 10 s, plus the exit after SIGKILL | `fork/src/job/run.ts:216`–`:231` |

**Grace period.** A job can only finish before the kill if the drain waits as long as the job may
run:
- Set `--timeout-s` to at least the largest class `timeoutSeconds` that the seat serves (for
  example, 3600 for a `long` class), not the default 300.
- Set the worker's termination grace period above `--timeout-s` + one poll + 15 s. Add the
  worker's own SIGTERM bound (about poll + 15 s) on top so it exits cleanly. Otherwise it is
  SIGKILLed, which leaves broker state unchanged.
- With the default drain timeout and poll, the drain alone needs more than 317 s.

Even that bound doesn't guarantee a job ends. `timeoutSeconds` is checked only at submit, against
the class ceiling (`fork/src/broker/server.ts:120`–`:121`). Nothing on the broker or worker path
enforces it on a running job. A job that outlasts the drain ends the drain with exit 3, which is
the expected outcome.

Kubernetes counts the preStop hook inside the grace period, and kills the container when the
period runs out whatever the hook would have returned. `docker stop` runs no preStop hook at
all.

**What a drain result proves:**
- `0` means the broker records nothing in flight for the seat.
- `3` (timeout) and `4` (resumed by another worker) leave the jobs in flight in the broker.
- None of the three, nor the container being killed, establishes that Pi stopped.

The slot cap keeps counting the job until reconciliation records a terminal state from verified
qitem evidence (`fork/src/broker/README.md`, "Worker lifecycle").

## Current limitations

- **No remote seat transport.** Pi seats are tmux sessions in the daemon's container. A worker
  outside that pod can't drive one (PW-32).
- **The broker path doesn't render seat files.** Only `pw job run` writes `agent/models.json`
  and `settings.json`, and starts the per-seat governor. Pi seats launched by the daemon use
  whatever their `PI_CODING_AGENT_DIR` holds, so the team's per-call limits are validated but not
  enforced on that path (W3-B).
- **Nothing in `fork/` launches the daemon's Pi seats**, and `pw team emit` writes no rig spec.
  The seats a worker names must already run in that daemon.
- **A worker leaves its wait only on `done`.** Reconciliation records `running` and `done` for a
  claimed job. Any other outcome keeps the worker, and the slot, waiting (`fork/src/broker/worker.ts:41`).
- **Worker health is process liveness only.** It doesn't read Pi's `runner-state.json` (W3-B).
- **Shutdown after `daemon stop` is not established here.** Neither the broker nor `daemon stop`
  is bounded in `fork/` source, and nothing here shows what `daemon stop` does to running Pi
  seats.
- **`pw job run` has no signal handler.** A signal to the runner skips Pi's stop sequence.
- **Nothing here is verified on a deployed cluster.** These are source facts and stub-tested
  behavior only.
