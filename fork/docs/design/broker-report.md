<!-- SPDX-License-Identifier: Apache-2.0 -->
# Design: the broker path's job report (W4-A, D16)

Status: **proposal, for r1 and r2 agreement before any code.** Fork-defined; Calvin can override D16.

## The problem

`pw job run` (the standalone runner) returns `usage` and `artifacts` and puts them on the terminal
`plantworks.job.state` event (PW-13, #90). A broker job doesn't. The broker records `done` from the
Pi seat's own closure of its qitem and writes `{text: null, artifacts: []}`
(`fork/src/broker/reconcile.ts`, the `store.transition(…, "done", …)` call).

Wave 3 established why it can't simply be added there (`wave3/report.md`, 00:26Z and 00:28Z, dev-build):
- **Only the seat can close the job.** The reconciler trusts only the Pi seat's own
  transport-authenticated `done` transition, the latest one (`seatOutcome`, reconcile.ts). The
  worker is a separate process and cannot author that closure: upstream derives the actor from the
  transport header (`queue.ts:687-693`).
- **The worker has no ordering point.** The usage tally lives in the worker's governor. A worker
  write before Pi closes races the reconciler, and a write after the terminal state is refused
  (`queue-repository.ts:1986-1990`).
- **Nobody knows the workspace.** On the broker path the worker doesn't launch Pi, and the team spec
  has no workspace field, so there is nothing to snapshot.

## Choice: (a) a seat-fenced report the reconciler waits on, bounded

| | (a) report endpoint, bounded wait | (b) a later `result` event |
|---|---|---|
| Terminal event carries usage and artifacts (the stated outcome) | yes | **no**: `done` goes out bare, and the data follows in another event |
| Contract change | additive, optional fields on the existing event, the D11 shapes `#70` already emits | a new event type, plus a consumer that joins two events and decides how long to wait for the second |
| Effect on `done` | delayed by at most the bound (default 30 s), **never blocked** | none |
| Failure | the worker never reports: `done` at the bound, with `unavailable(timeout)` | the worker never reports: no `result`, and every consumer has to time out itself |

(a) is smaller where it matters. It adds one route, two store columns and one wait in the reconciler,
and it keeps the consumer contract a single event. (b) moves the waiting into every consumer.

**Fail-closed is kept.** The seat's own closure stays the only thing that finishes a job. The report
is advisory: it can't make a job `done`, can't speed it up and can't change its outcome. A missing,
late, rejected or malformed report only means the data is `unavailable`, and `done` still lands at
the bound. A stuck worker cannot hold a job (or its slot) longer than the bound past the seat's
closure.

## Protocol

1. **The reconciler sees the seat's closure** (`seatOutcome` returns an outcome, and the job is
   `running`).
   - If the job has no report and no `report_wait_since`, it records `report_wait_since = now` and
     emits nothing. The job stays `running` and keeps its slot.
   - On later passes:
     - **report stored:** `done` with `result = {text: null, artifacts, usage, report: "ok"}`. The
       event carries the D11 fields.
     - **no report and `now - report_wait_since >= bound`:** `done` with
       `result = {text: null, artifacts: [], usage: null, report: "unavailable(timeout)"}`. The event
       carries neither field.
     - **otherwise:** keep waiting.
   - The bound is `PLANTWORKS_REPORT_WAIT_S` (default 30; `0` keeps today's immediate `done`).
   - **No sleep in the reconciler** (dev-build). It stays the existing poll, and each pass only
     compares the clock with the persisted `report_wait_since`, so a broker restart resumes the bound
     instead of restarting it.
   - Finalising writes **one** transition, `running -> done`, carrying the result, so D12 event ids
     stay one per transition.
2. **The worker learns it is wanted.** `GET /plantworks/v1/jobs/{jobId}`, which the worker already
   polls every `--poll-ms`, gains `reportWanted: true` while the wait is open.
3. **The worker reports.** `POST /plantworks/v1/jobs/{jobId}/report` with the bearer token and
   `{seat, qitemId, usage, artifacts}`. The broker accepts it only if all of these hold, checked and
   stored in one immediate transaction:
   - the job is `running`;
   - `claimed_by = seat` and `qitem_id = qitemId`;
   - `report_wait_since` is set, meaning the seat has already closed: no snapshot is taken mid-work;
   - no report is stored yet.

   **First write wins** (dev-build). Answers:
   - 200 when stored;
   - 409 `report_exists` for any second report, identical or not; the worker treats it as already
     reported and does not retry;
   - 409 `job_settled` once the job is past `running`;
   - 409 `report_not_wanted` before the closure;
   - 400 for a bad shape.

   Sizes are capped: 256 files, 2 KB per path.
4. **A reopened or handed-off qitem** during the wait (`seatOutcome` null again) clears
   `report_wait_since` and any stored report, because the snapshot predates further work. The job
   simply stays `running`, as today.
5. **A job that leaves `running` any other way during the wait** (dev-build): the stored report is
   dropped, and the wait never emits `done`. Today nothing but this path moves a broker job out of
   `running`.

Restart and crash, which are the cases the tests cover:

| Event | Result |
|---|---|
| Broker restarts during the wait | `report_wait_since` and `report` are in SQLite, so the wait continues from the stored time and isn't restarted |
| Worker dies before reporting | `done` at the bound, `unavailable(timeout)`: no lost `done` |
| Worker dies after reporting | the report is stored, so `done` carries it |
| Worker restarts and reports again | 409 `report_exists`: the first write wins, so there is no double report |
| Report arrives after `done` | 409 `job_settled`, nothing changes |
| Two brokers on one SQLite file | the immediate transaction plus the conditional UPDATE, as for claims (PW-19) |

## The worker's side

- **Per-job usage.** The governor's `usage()` is cumulative per seat, so the worker records it when it
  takes the job (claim, or start-up recovery) and reports the difference.
  - Whether a job's model calls are all inside that window is decided by the worker's
    one-job-at-a-time rule (PW-21) and by #96's `setPriority` bracket.
  - After a worker restart the governor's count starts again at 0 and calls made before the restart
    are lost, so a recovered job reports `usage: null` with `report: "unavailable(worker restarted)"`
    rather than an undercount.
- **Artifacts.** D16 adds an optional per-class `workspace` to the team spec, an absolute path. The
  worker runs #90's `snapshotWork` on it, with the same plumbing and the same refusals: nothing the
  job planted runs, `.gitignore` is honoured, an existing `pw/<jobId>` branch is never overwritten,
  and unborn, mid-operation and sparse trees are handled. No `workspace` gives
  `{branch: null, skipped: "no workspace"}`, which is the current behaviour.
- **A baseline per job.** A broker seat's workspace lives across jobs, and a job leaves its changes in
  the work tree, so a snapshot against HEAD would also show earlier jobs' changes.
  - At take-up, the worker records a baseline tree of the workspace with the same temp-index plumbing:
    `write-tree`, plus an unreferenced `commit-tree` on HEAD.
  - The job's commit takes that baseline as its parent, so `pw/<jobId>` = baseline + the job's
    changes, and `files` lists only what this job changed.
  - After a worker restart the baseline is gone, so the snapshot falls back to HEAD and says so
    (`baseline: "HEAD (worker restarted)"`).

## Open points for the reviewers

1. **D16's "the worker launches Pi with that cwd".** On the broker path the daemon launches the Pi
   seat in tmux, and the worker never starts Pi. So `workspace` can only name the directory the
   deployment runs the seat in, and the worker snapshots it without being able to check that Pi
   really works there: runner-state.json doesn't record a cwd, and the worker doesn't know Pi's PID.
   - Proposal: document it as a deployment contract, `workspace` = the seat's cwd, and have the
     worker refuse to start when the path is missing or not absolute.
   - Making the worker launch Pi itself would be a different and much larger design.
2. **The bound.** 30 s is the brief's default. The worker polls every 2 s and a snapshot is seconds,
   so 30 s leaves margin. It delays `done`, and the slot's release, by up to that long when a worker
   is gone.
3. **`.pi/SYSTEM.md` in the workspace.** With a workspace known, the worker could also refuse, at
   start, a workspace that ships `.pi/SYSTEM.md` or `APPEND_SYSTEM.md`. That is the broker half of
   PW-12's `6adc1667`, which #73 left open. It is cheap, but it is a separate item: in or out?

## Slices and owners (proposal)

1. **This doc** (build2), reviewed by r1 and r2.
2. **Broker side** (store columns, the report route, the reconciler wait): dev-build, who has agreed
   to it. Store and reconcile are its territory. Reviewer r1.
3. **Worker side** (the spec `workspace` field, the baseline, the usage delta, the report call):
   build2. Reviewer r1.

Each slice is one PR. Tests are sealed (#75 containment) and cover the restart and crash table above.

## Out of scope

- The worker launching Pi.
- Pushing `pw/<jobId>` anywhere: branches stay in the seat's repository.
- A text result from Pi: `text` stays `null`, as today.
- Any change to who can finish a job.
