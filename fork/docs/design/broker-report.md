<!-- SPDX-License-Identifier: Apache-2.0 -->
# Design: the broker path's job report (W4-A, D16)

Status: **proposal, for r1 and r2 agreement before any code.** Fork-defined; Calvin can override D16.

## The problem

`pw job run` (the standalone runner) returns `usage` and `artifacts` and puts them on the terminal
`plantworks.job.state` event (PW-13, #90). A broker job doesn't. The broker records `done` from the
Pi seat's own closure of its qitem and writes `{text: null, artifacts: []}`
(`fork/src/broker/reconcile.ts`, the `store.transition(…, "done", …)` call).

Wave 3 established why it can't simply be added there (`wave3/report.md`, 00:26Z and 00:28Z, dev-build):
- **Only the seat closes the job.** The reconciler accepts only the latest `done` transition
  recorded as the Pi seat's own, with `transport:v1` provenance (`seatOutcome`, reconcile.ts).
  Upstream derives that actor from the transport header (`queue.ts:702-708`). The worker is a
  separate process and, by design, doesn't author that closure. That is the design's division of
  labour, not an enforced barrier: `transport:v1` isn't authentication, and a process that can reach
  the daemon's API can send the seat's name (`require-sender-identity.ts:7`–`:9`; see the broker
  README, "What a seat's closure proves").
- **The worker has no ordering point.** The usage tally lives in the worker's governor. A worker
  write before Pi closes races the reconciler, and a write after the terminal state is refused
  (`queue-repository.ts:2033-2037`).
- **Nobody knows the workspace.** On the broker path the worker doesn't launch Pi, and the team spec
  has no workspace field, so there is nothing to snapshot.

## Choice: (a) a seat-fenced report the reconciler waits on, bounded

| | (a) report endpoint, bounded wait | (b) a later `result` event |
|---|---|---|
| Terminal event carries usage and artifacts (the stated outcome) | yes | **no**: `done` goes out bare, and the data follows in another event |
| Contract change | additive, optional fields on the existing event, the D11 shapes `#70` already emits | a new event type, plus a consumer that joins two events and decides how long to wait for the second |
| Effect on `done` | delayed by at most the bound (default 30 s), **never blocked** | none |
| Failure | the worker never reports: `done` at the bound, with `unavailable(timeout)` | the worker never reports: no `result`, and every consumer has to time out itself |

(a) is smaller where it matters. It adds one route, three store columns and one wait in the reconciler,
and it keeps the consumer contract a single event. (b) moves the waiting into every consumer.

**Fail-closed is kept.** The seat's own closure stays the only thing that finishes a job. The report
is advisory: it can't make a job `done`, can't speed it up and can't change its outcome. A missing,
late, rejected or malformed report only means the data is `unavailable`, and `done` still lands at
the bound. A stuck worker cannot hold a job (or its slot) longer than the bound past the seat's
closure.

## Protocol

1. **The reconciler sees the seat's closure** (`seatOutcome` returns an outcome, and the job is
   `running`).
   - If the job has no `report_wait_since`, it records `report_wait_since = now` **and
     `report_closing_id`, the `transitionId` of the seat's closing transition** that `seatOutcome`
     accepted. It emits nothing. The job stays `running` and keeps its slot.
   - **The wait belongs to that exact closure** (r2). On every pass, if the closure the reconciler
     accepts now has a different `transitionId` from `report_closing_id`, it resets in one
     transaction: a new `report_wait_since = now`, the new `report_closing_id`, and any stored report
     dropped. This covers a qitem that was reopened and closed again between two polls, which the
     reconciler never sees as reopened, so an older wait or a report taken before the extra work
     can't attach to the later closure.
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
   - **It reads the stored report inside the same immediate transaction as that transition** (r1). A
     report landing in between is either included, or answered `job_settled` because the fence sees
     `done`. It is never stored silently on a `done` job.
   - The bound is refused below 10 s, roughly two worker polls plus a snapshot. A smaller value would
     defeat the report without anyone noticing. `0` remains the explicit "no report, immediate done".
2. **The worker learns it is wanted.** `GET /plantworks/v1/jobs/{jobId}`, which the worker already
   polls every `--poll-ms`, gains `reportWanted: {closingTransitionId}` while the wait is open.
3. **The worker reports.** `POST /plantworks/v1/jobs/{jobId}/report` with the bearer token and
   `{seat, qitemId, closingTransitionId, usage, artifacts}`. The broker accepts it only if all of these
   hold, checked and stored in one immediate transaction:
   - the job is `running`;
   - `claimed_by = seat` and `qitem_id = qitemId`;
   - `report_wait_since` is set, meaning the seat has already closed: no snapshot is taken mid-work;
   - `closingTransitionId = report_closing_id`, so the report answers this closure and not an
     earlier one (409 `report_stale` otherwise);
   - no report is stored yet.

   **What the fence is, and isn't** (r1). It checks consistency, not identity: `{seat, qitemId}` is
   asserted by the caller and authenticated only by the broker-wide bearer token. As PW-17 ruled, the
   bearer is not per-seat authorisation. Any bearer holder who knows a running job's `qitemId` (it is
   on the job record and the events) could report first. The report's contents, `usage` and
   `artifacts` (`branch`, `commit`, `files`), are **worker-asserted**: the broker can't check a commit
   in the seat's repository. So the stored result carries `reportProvenance: "worker-asserted"`, and
   the event field descriptions say the same. Consumers must not treat `artifacts` as
   broker-verified. That is acceptable for Phase 0-1, where every bearer holder is a trusted platform
   component.

   **First write wins** (dev-build). Answers:
   - 200 when stored;
   - 409 `report_exists` for any second report, identical or not; the worker treats it as already
     reported and does not retry;
   - 409 `job_settled` once the job is past `running`;
   - 409 `report_not_wanted` before the closure;
   - 400 for a bad shape.

   Sizes are capped: 256 files, 2 KB per path.
4. **A reopened or handed-off qitem** during the wait (`seatOutcome` null again) clears
   `report_wait_since`, `report_closing_id` and any stored report, because the snapshot predates
   further work. The job simply stays `running`, as today. A reopen and re-close the reconciler didn't
   see between polls is caught by the `report_closing_id` check in step 1.
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
| The qitem reopens and closes again between two polls | the new closing `transitionId` differs from `report_closing_id`, so the wait restarts and the old report is dropped. A worker report for the old closure gets 409 `report_stale` |
| Report arrives after `done` | 409 `job_settled`, nothing changes |
| Two brokers on one SQLite file | the immediate transaction plus the conditional UPDATE, as for claims (PW-19) |
| The daemon is unreachable during the wait | `seatOutcome` can't be read, so the pass changes nothing and the job stays `running` (the existing fail-closed rule). The bound doesn't fire on its own; once the daemon answers, it counts from the original `report_wait_since` |

## The worker's side

- **Per-job usage.** The governor's `usage()` is cumulative per seat, so the worker records it when it
  takes the job (claim, or start-up recovery) and reports the difference.
  - Whether a job's model calls are all inside that window is decided by the worker's
    one-job-at-a-time rule (PW-21) and by the hold described next.
  - `governor.usage()` is `undefined` until a call reports (#90), so a baseline taken before any call
    counts as 0, not as unknown.
  - After a worker restart the governor's count starts again at 0 and calls made before the restart
    are lost, so a recovered job reports `usage: null` with `report: "unavailable(worker restarted)"`
    rather than an undercount.
- **Artifacts.** D16 adds an optional per-class `workspace` to the team spec, an absolute path.
  **Decision (lead):** `workspace` is the declared seat-host path the deployment must run the seat in.
  - The worker doesn't trust it. At take-up it checks that the path is absolute, exists, is a git work
    tree and is readable.
  - **It also checks co-location with the seat** (r1). Those checks pass for any repository the worker
    can see at that path. A worker in another container, or a remote seat (PW-32), could see a
    different tree at the same path string. So the worker also requires two things:
    - the seat's own state, `$OPENRIG_HOME/state/pi/<seat>/runner-state.json`, is visible and `live`
      (`pw worker live`);
    - the workspace is on the same filesystem as that state directory (`st_dev` matches, a cheap
      shared-mount signal).

    Otherwise it's `"workspace unverifiable: not co-located with the seat"`. Every artifact report
    says `observedBy: "worker"`. That is a heuristic, not proof that Pi works in that tree: the
    deployment contract (`workspace` = the seat's cwd) still carries the rest.
  - If any check fails, the artifacts are `{branch: null, skipped: "workspace unverifiable: <why>"}`.
    The job itself is unaffected (fail-closed for the data only).
  - If the checks pass, the worker runs #90's `snapshotWork` on it, with the same plumbing and the same refusals: nothing the
  job planted runs, `.gitignore` is honoured, an existing `pw/<jobId>` branch is never overwritten,
  and unborn, mid-operation and sparse trees are handled. No `workspace` gives
  `{branch: null, skipped: "no workspace"}`, which is the current behaviour.
- **The baselines come before Pi can act** (r1).
  - On the broker path the daemon wakes the seat when claim-next creates the qitem, which is before
    the worker has the claim answer. Pi can change the tree only after a model reply.
  - So, whenever a class has a `workspace`, the governor holds every completion until the worker arms
    it. This uses #96's hold (`priorityKnown`), applied when a workspace is configured and not only
    under `priorityHints`; without hints, no priority is written into the body.
  - The worker records the usage baseline and the tree baseline first, then arms the governor
    (`setPriority`), at take-up and at start-up recovery alike.
  - So no reply, and so no edit, can come before the baselines. Calls a seat made before the worker
    started at all can't be held, and that case is the start-up-recovery one: "baseline lost".
- **A baseline per job.** A broker seat's workspace lives across jobs, and a job leaves its changes in
  the work tree, so a snapshot against HEAD would also show earlier jobs' changes.
  - At take-up, the worker records a baseline tree of the workspace with the same temp-index plumbing:
    `write-tree`, plus an unreferenced `commit-tree` on HEAD.
  - The job's commit takes that baseline as its parent, so `pw/<jobId>` = baseline + the job's
    changes, and `files` lists only what this job changed.
  - **Decision (lead):** when there is no usable baseline, no snapshot is taken. The artifacts are
    `{branch: null, skipped: "<why>"}`, never a snapshot against HEAD that would mix in earlier jobs'
    work. The cases:
    - a worker restart lost it: `"baseline lost (worker restarted)"`;
    - it couldn't be written or read: `"baseline unreadable: <why>"`. The baseline is an unreferenced commit, so a
      user's `git gc --prune=now` during the job removes it; that is expected, and lands here.

## Open points for the reviewers

1. **D16's "the worker launches Pi with that cwd"** (decided above; the lead is flagging the wording to
   the coordinator). On the broker path the daemon launches the Pi seat in tmux, and the worker never
   starts Pi. So `workspace` names the directory the deployment must run the seat in. The worker
   verifies the directory but can't verify that Pi really works there: runner-state.json doesn't
   record a cwd, and the worker doesn't know Pi's PID. Making the worker launch Pi itself would be a
   different and much larger design.
2. **The bound** (r1: fine as the default). It is 30 s. The worker polls every 2 s and a snapshot is
   seconds, so that leaves margin. It delays `done`, and the slot's release, by up to that long when a
   worker is gone. Drain sees the job as in flight during the wait, which is correct. Values under
   10 s are refused (above).
3. **`.pi/SYSTEM.md` in the workspace** (r1: in, as part of slice 3). The worker refuses to claim
   for a workspace that ships `.pi/SYSTEM.md` or `APPEND_SYSTEM.md`. The check runs at worker start
   and again **before each `claim-next`**, never after one: once claimed, the qitem exists and Pi is
   awake, so a refusal then would leave a claimed job. That is the broker half
   of PW-12's `6adc1667`. It inherits the co-location caveat, since it inspects the tree the worker
   sees, so it is worded "refused when seen".

## Slices and owners (proposal)

1. **This doc** (build2), reviewed by r1 and r2.
2. **Broker side** (store columns `report`, `report_wait_since` and `report_closing_id`; the report
   route; the reconciler wait): dev-build, who has agreed to it. Store and reconcile are its
   territory. Reviewer r1.
3. **Worker side** (the spec `workspace` field, the baseline, the usage delta, the report call):
   build2. Reviewer r1.

Each slice is one PR. Tests are sealed (#75 containment) and cover the restart and crash table
above, including r2's inter-poll reopen and re-close case in slice 2.

## Out of scope

- The worker launching Pi.
- Pushing `pw/<jobId>` anywhere: branches stay in the seat's repository.
- A text result from Pi: `text` stays `null`, as today.
- Any change to who can finish a job.
