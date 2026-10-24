<!-- SPDX-License-Identifier: Apache-2.0 -->
# Broker (PW-17)

The job broker. It owns its own SQLite file and touches no upstream state, routes or migrations.

**The API is multi-team, behind one trusted credential.** A broker serves every team under
`--teams`. `PLANTWORKS_BROKER_TOKEN` is broker-wide, not scoped to a team: whoever holds it can
submit, read and cancel any team's jobs, and a `409 job_conflict` returns the existing record
whatever its team. The broker does not isolate teams. Its trusted caller, PW-24's MCP server, is
to do that, independent of how brokers are deployed: it will check `record.team` on every record
it returns and never forward a conflict's `job`. PW-24 (PR #31) is not merged yet, so until it
lands nothing enforces team isolation. ADR 0204 happens to deploy one broker per team,
but that deployment shape is not the isolation mechanism.

```
plantworks pw broker serve --teams <dir> [--platform platform.json] [--db file] [--host 127.0.0.1] [--port 7534]
```

- **Teams.** It loads `<dir>/<team>/team.json` for every team, as written by `pw team emit`
  (`--teams`, or `PLANTWORKS_TEAMS_DIR`). Every spec is validated against `--platform`, as
  `pw team validate` does. Any invalid spec, a spec whose `team` doesn't match its directory, or
  an empty directory stops the broker before it listens.
- **Store.** `--db` defaults to `$OPENRIG_HOME/plantworks/broker.sqlite`, which is
  `~/.plantworks/plantworks/broker.sqlite` under the PW-16 home. It is never the daemon's
  database.
- **Bind.** Loopback by default. Any other address needs `PLANTWORKS_BROKER_TOKEN`, the same rule
  the daemon follows (PW-16).
- **Auth.** With `PLANTWORKS_BROKER_TOKEN` set, every request under `/plantworks/v1/` needs
  `Authorization: Bearer <token>`, including routes other cards add under `/plantworks/v1/`. Without it (loopback, Phase
  0-1 dev only), the API is open.
- **Events.** `plantworks.job.state` (PW-10) is posted to the team's `events.callbackDefault`.
  `${NAME}` placeholders in that value are read from the broker's environment at start, so the
  sample spec's `${PLANTWORKS_FRONTDOOR_CALLBACK}` works. Only names ending in `_CALLBACK` resolve,
  so a spec cannot copy a broker secret (its token, an endpoint key) into the URL events go to.
  Any other name, or an unset one, stops the broker.

## API

| Request | Response |
|---|---|
| `POST /plantworks/v1/jobs` with the PW-09 envelope (at most 512 KiB) | `201` and the record for a new job. `200` and the existing record when the same envelope is posted again (key order doesn't matter). `409 job_conflict` when the jobId exists with a different envelope |
| `GET /plantworks/v1/jobs/{jobId}` | `200` and the record, or `404 not_found` |
| `POST /plantworks/v1/jobs/{jobId}/decision` with `{decision: "approve" \| "deny", by?, reason?}` | For a `held` job, see Approvals below: `200` and the record. The same decision again is `200`. `409 already_decided` (the other decision was made), `409 approval_expired`, `409 not_held` (never held, or cancelled by the front door), `404 not_found`, `400 invalid_decision` |
| `POST /plantworks/v1/jobs/{jobId}/cancel` | `queued` or `held` becomes `cancelled` with reason `front-door`: `200` and the record. Already `cancelled`: `200` (idempotent). Any other state, or a job being handed to a seat (reserved): `409 not_cancellable`. Unknown job: `404 not_found` |

The record is `fork/schema/job-record.schema.json`:
`{jobId, team, class, state, detail, createdAt, updatedAt, result}`.
- `class` is the resolved class.
- `detail` is the PW-09 detail for the current state.
- `result` is `null` until reconciliation records an authenticated logical completion (PW-21).

Errors are `{error, message}`, plus `errors` for an invalid envelope and `job` for a conflict:

| Status | `error` |
|---|---|
| 400 | `invalid_envelope`, `unknown_team`, `unknown_class`, `timeout_over_ceiling`, `invalid_decision` |
| 401 | `unauthorized` |
| 404 | `not_found` |
| 409 | `job_conflict`, `not_cancellable`, `already_decided`, `approval_expired`, `not_held` |
| 413 | `too_large` |

Submit checks, in order:
1. A valid envelope.
2. An existing jobId: the request is a replay, so the job comes back unchanged.
3. A known team.
4. The class is the envelope's `class`, or the spec's `defaultClass`, and must exist.
5. `timeoutSeconds` must be within that class's `timeoutSeconds`.

Submit never creates an upstream queue item and limits no concurrency. Claiming and the slot
cap belong to claim-next (PW-18, PW-19).

## Approvals (PW-23)

A job in a class whose `approval` is not `never` starts `held`. The broker emits
`plantworks.job.state held`, then `plantworks.approval.requested`, to the team's
`callbackDefault`:

```
data: {jobId, team, attempt, class, decisionUrl, expiresAt, title?}
```

- `decisionUrl` is `<public url>/plantworks/v1/jobs/{jobId}/decision`. The public URL is
  `--public-url` or `PLANTWORKS_BROKER_PUBLIC_URL`. On loopback it defaults to the listen
  address. Off loopback it is required, because `0.0.0.0` or a pod IP is not what callers reach,
  and the broker refuses to start without it.
- `expiresAt` is `null` when the class has no `approvalTtlSeconds`.
- A held job is not claimable.

A decision POSTed to `decisionUrl`, or a run-out TTL, resolves the job. Each outcome emits the
job.state event first, then `plantworks.approval.resolved` with `data: {jobId, team, attempt,
decision, by?, reason?}`:

| Outcome | State | job.state detail | `decision` |
|---|---|---|---|
| approve | `held -> queued` | none | `approved` |
| deny | `held -> cancelled` | `{reason: "denied", message?}`, where `message` is the decision's `reason` | `denied` |
| TTL runs out | `held -> cancelled` | `{reason: "approval-expired"}` | `expired` |

Event ids are `<jobId>:approval.requested` and `<jobId>:approval.resolved`, so a consumer
deduplicates them as it does job.state events.

**These are hooks only. No approval consumer or decider exists yet.** Nothing in Plantworks
turns `approval.requested` into a prompt or POSTs a decision. There is no Slack code, PW-24's
MCP server has no event push and never decides, and the ADR's Hermes approval path is not built.
Until an external trusted caller of the decision endpoint exists, a held job is either cancelled
as `approval-expired` when its TTL runs out, or stays `held` indefinitely if its class has no
TTL.

## claim-next (PW-18, `claim.ts`)

`POST /plantworks/v1/claim-next` with `{team, seat, class?}`. `seat` is the OpenRig session that
will do the work, for example `dev-worker@team`. No `class` means the team's `defaultClass`.

| Response | When |
|---|---|
| `200 {job, qitemId, seat, envelope}` | The oldest queued job of that class is now `claimed` by the seat. Its upstream qitem `qitemId` is addressed to the seat and claimed for it |
| `204` | Nothing claimable in that class |
| `400` | `invalid_claim`, `unknown_team`, `unknown_class` |
| `429 slot_cap_reached` | The team's `slotBudgetKey` already has its cap of jobs in flight (PW-19). The body has `{slotBudgetKey, cap, inFlight}`. Ask again later |
| `503 daemon_refused` | The daemon answered and refused to create the qitem (a 4xx other than 409), so nothing was delivered. The reservation is released and the job is claimable again |
| `503 handoff_unconfirmed {jobId, qitemId, seat}` | The outcome is unknown: a timeout, a 5xx or 409 on create, or a failed claim after the create. The qitem may exist and may have been delivered, so the job **stays reserved and counted** and can't be claimed again until reconciliation (PW-21) settles it |
| `409 reservation_lost` | Shouldn't happen: reservations are never taken over, and cancel refuses a reserved job. Left for reconciliation |

This is **late binding**: the upstream qitem exists only from the moment a seat claims, and its
destination is that seat. Steps:
1. `reserve` the oldest unreserved queued job, with a qitem id chosen first.
2. Create the qitem with that id. The daemon delivers (wakes the seat) when it creates the qitem,
   so from here on Pi may be working. Upstream treats a retried create with the same id as
   idempotent.
3. Claim it for the seat.
4. `confirmClaim`, then emit `claimed`.

**Fail-closed handoff.** A reservation is released only on evidence that nothing was delivered:
the daemon refusing the create. Every other failure, and a broker crash between `reserve` and
`confirmClaim`, leaves the reservation in place with its `reserved_qitem_id`. It counts against
the slot cap, it is never taken over however old it is, and it is never "cleaned up" by closing
the qitem, because a closed qitem doesn't prove Pi never started. Only `confirmClaim`, or a
`release` that reconciliation (PW-21) justifies from verified evidence, ends it. For example,
verified evidence could be that the daemon has no qitem with that id. Nothing is ever emitted
for a claim that didn't happen.

**Recovery (W3-A, `recoverHandoff`).** A handoff that a crash or a failed call left between
`reserve` and `confirmClaim` is finished by retrying the same steps with the same stored qitem
id, for the same seat. Reconciliation does this once a reservation is older than
`RESERVATION_LEASE_MS`, so a claim-next that is still in flight is never raced.
- **The daemon answers 404:** the broker creates the qitem. A retried create is idempotent
  upstream, so a create that did land answers as the same qitem. A refused create (4xx) releases
  the reservation, the same rule claim-next applies.
- **The qitem is pending for that seat:** the broker claims it.
- **After that,** reconciliation confirms the broker-side claim only once the daemon shows the
  qitem claimed. A pending qitem is never confirmed.
- **Anything else** leaves the reservation as it is: no answer, a 5xx, a qitem addressed to
  another seat, or one in another state.

**Precondition: the daemon's queue outlives a broker crash.** A 404 counts as "never created" only
while the daemon's `$OPENRIG_HOME` is persistent. If it is lost (an emptyDir, or a daemon restart
without its volume), a qitem that was delivered, and possibly worked on, would 404, and recovery
would deliver it again. Mount the volume that `fork/container/README.md` asks for at
`OPENRIG_HOME=/var/lib/fork`. A failing retry past the lease is tried again on every
reconciliation pass (2 s), with no backoff.

Age only decides when a retry is attempted. Nothing releases on age, moves the job to another
seat, or closes a qitem.

A draining seat still gets its own reserved job delivered: that job was reserved before the
drain, and the drain waits for it.

### Slot cap (PW-19, `slots.ts`)

`PLANTWORKS_SLOT_CAP` caps the jobs in flight per `slotBudgetKey`, counted across every team that
shares the key.

- **Format.** `key=n` entries, comma-separated, with an optional bare `n` for every other key,
  for example `social-media=1` or `2,social-media=1`.
- **Unset** means the Phase 0–1 default of **1 per key**; it never means unlimited. `0` stops
  claims for a key. A malformed value stops the broker from starting.
- **In flight** means `claimed` or `running`, or `queued` under a claim-next reservation of
  **any age**. A handoff in progress, or one whose outcome is unknown, holds its slot.
- **A slot frees** when the job reaches a terminal state.
- **Never exceeded.** claim-next counts and reserves in one immediate SQLite transaction, so
  concurrent claims, or another broker on the same file, can't exceed the cap.
- **Separate from other caps.** This runtime cap is independent of the team spec's validation
  caps (`pw team validate --platform`) and of Hermes' `kanban.max_in_progress_per_profile`.

**What the cap enforces: broker job states, not physical execution.** The cap counts jobs by
their state in this broker. A slot frees when the broker records a terminal state for the job,
and only then. It doesn't observe Pi processes, and it can't prove that work physically stopped.

**Fail-closed.** Nothing frees a slot on a timeout alone. Node liveness doesn't free one
automatically, and there's no force-free. A seat that dies while holding a job keeps its slot,
because Pi may still be running. With cap 1, that stalls the key, which is the safe failure.

Which events justify recording a terminal state belongs to the worker lifecycle and its
reconciliation (PW-21). Those events must be verified, not assumed. For example, an upstream
qitem closed by administrative cancel isn't by itself proof that Pi stopped. Recovering a stalled
key is an operator procedure that first verifies the work stopped. It's documented with PW-21,
not a broker endpoint.

The daemon is `PLANTWORKS_DAEMON_URL` (default `http://127.0.0.1:7533`, the PW-16 port), with
`OPENRIG_AUTH_BEARER_TOKEN` when set. Qitems are created as `PLANTWORKS_BROKER_SESSION` (default
`plantworks-broker`). The broker names the seat in the request body, so the daemon records it as
a claimed identity (`claimed:v1`). It never sends `X-OpenRig-Session`, which would assert the
seat's transport identity. The broker does not close qitems during cleanup.

### Worker lifecycle (PW-21)

`plantworks pw worker run --team <team> --seat <session>` claims one job at a time and polls its
broker record. It asks for another job only after the broker reports `done`. A worker process
exit, timeout, unreadable qitem, daemon outage, generic failure/cancellation, administrative
closure, or `handed-off` state does not release the slot. The broker reconciler polls persisted
qitem IDs in rotating batches of 16 every two seconds and can continue after a worker or broker
restart. It reports an unreadable qitem at most once per minute and keeps only 128 diagnostic
timestamps in memory.

The reconciler treats a qitem as logically complete only when the exact stored qitem ID is
returned as `done` with `no-follow-on`, has no closure target, and its closing transition matches
the latest terminal transition with actor equal to the qitem destination and
`identityProvenance: transport:v1`. It first confirms any matching queued reservation, then
records broker `running` and `done`. Ambiguous evidence stays in flight. This is authenticated
logical completion; it does not prove the Pi process exited or bound physical execution
concurrency. An unresolved job can therefore hold a slot indefinitely and requires an operator to
verify that work stopped before any manual recovery.

## Runtime contract (PW-22, `runtime.ts`)

What a platform needs to run the broker and its workers. Nothing here stops, fails, releases or
closes a job.

| Request | Auth | Response |
|---|---|---|
| `GET /healthz` | none | `200 {status: "ok"}` when the broker's SQLite file answers, `503 {status: "unavailable"}` when it doesn't. It names no team, job or seat, so a probe needs no secret |
| `GET /plantworks/v1/stats` | bearer | Live job counts, below. It stays behind the broker token: an autoscaler (KEDA `metrics-api`) authenticates like any other caller, for example with a TriggerAuthentication fed from a secret. There is no exemption |
| `GET /plantworks/v1/seats/{seat}/drain` | bearer | `{seat, draining, inFlight: [jobId]}` |
| `POST /plantworks/v1/seats/{seat}/drain` | bearer | Marks the seat draining, so claim-next gives it nothing new (`409 seat_draining`). Returns the same view |
| `DELETE /plantworks/v1/seats/{seat}/drain` | bearer | Resumes the seat |

**Stats.** `{active, teams: {<team>: {active, held, queued, reserved, claimed, running, classes: {<class>: {...}}}}, slots: {<slotBudgetKey>: {inFlight, cap}}, drainingSeats}`:
- `active` = `queued + claimed + running`: the work a worker pool exists for. This is the chart's
  KEDA target, for example `teams.<team>.active`.
- `queued` includes `reserved`, which is a queued job mid-handoff to a seat.
- `held` jobs wait for an approval decision. They are counted, but are not `active`, because no
  worker can take them.
- `slots` repeats the PW-19 count claim-next enforces: claimed, running, and reserved-queued of
  any age, against `PLANTWORKS_SLOT_CAP`. A held job takes no slot.

These are lifecycle counts, not observed execution. A job counts until the broker records its end.

**Drain.** A seat's in-flight jobs are the ones claimed or running for it, plus any queued job
under its reservation, of any age: once the daemon may have delivered the qitem, the seat may be
working on it. Draining a seat changes none of those jobs. It only stops new claims. The flag is
kept in the broker's SQLite file (`seat_drains`), so it survives a broker restart.

- `plantworks pw worker drain --seat <session> [--timeout-s 300]` is the worker's preStop hook.
  It sets the drain, then polls until the seat holds nothing:
  - exit `0`: drained;
  - exit `3` on timeout: the jobs are listed, the seat stays draining, and the broker still
    tracks them. **A timeout does not prove execution stopped.** Pi may still be working, and
    reconciliation settles the jobs later.
  - exit `4`: another worker resumed the seat during the drain, so the seat takes work again and
    the drain is void.
- `plantworks pw worker run --seat <session>` resumes its own seat, and only that seat, when it
  starts, so a pod that replaces a drained one takes work again. **Run one worker process per
  seat name.** A second `worker run` on the same name (a Deployment sharing a fixed `--seat`, a
  surge pod, a supervisor restart) ends any drain on it. A StatefulSet with pod-name seats does
  not overlap.
- A drain row stays until something resumes the seat. An operator clears a stale one, for example
  for a pod name that never comes back, with `DELETE /plantworks/v1/seats/{seat}/drain`.

## For other cards

- **Routes.** `createBroker({store, teams, routes})` takes `BrokerRoutes` functions,
  `(app, {store, teams, emit}) => void`. They add routes without editing `server.ts` (PW-18
  claim-next, PW-23 decisions).
- **Store.** `openStore(path)` returns:
  - `insert`, `get`, and `tx(fn)`;
  - `transition(jobId, to, detail, columns)`: one PW-09 transition and the row update, in one
    transaction. It refuses `claimed`, so nothing can claim around `confirmClaim`;
  - claim-next, in three steps:
    1. `reserve(team, class, seat, qitemId)` returns the oldest **unreserved** queued job, now
       reserved, or `undefined`. A reserved job is never taken over.
       `RESERVATION_LEASE_MS` is only the age at which reconciliation looks at a reservation,
       and age never releases one.
    2. `confirmClaim(jobId, seat, qitemId)` moves the job from `queued` to `claimed`, but only
       while the reservation is still this seat's with this qitem (a compare-and-set).
       Otherwise it returns `"lost"`.
    3. `release(jobId, seat, qitemId)` drops a reservation only while it is still this seat's
       with this qitem. Call it only on evidence that the qitem was never delivered.

  A reservation leaves the job `queued` and emits nothing. Any transition clears it.

## Defaults open for review

- Port 7534, next to the daemon's 7533.
- `${NAME}` placeholders in `callbackDefault` are expanded from the broker's environment, for
  names ending in `_CALLBACK` only. The spec format leaves this undefined.
- `approval: per-job` holds every job, like `always`, but with no TTL unless the class sets
  `approvalTtlSeconds`. The ADR does not say what decides "per job". The envelope has no field
  for it, and adding one would change the PW-09 contract, so no job in such a class runs
  unapproved.
- Approval events go to the team's `callbackDefault`. `events.approvalConsumer` must be
  `frontdoor`, the ADR's default. Any other value stops the broker. Nothing consumes them yet
  (see Approvals).
- The broker does not check who may decide (ADR open decision 8, approvers). `by` is recorded in
  the resolved event, not verified. Anyone holding the broker token can decide. **That includes
  the submitter**: Hermes, or PW-24's MCP server, holds the same token and could approve its own
  job. Until an approver policy exists, `held` records a decision but does not guarantee a person
  made it.

## Limitations

- Drain is per seat. There is no broker-wide drain, and a seat that is never drained or resumed
  explicitly keeps whatever state it last had. `/healthz` checks only the broker's own file, not
  the daemon.
- Event delivery is in memory (PW-10). A broker that stops while an event is still retrying
  loses that event. The job row is kept. The persistent outbox remains a follow-up.
- Worker reconciliation does not capture the worker's output; until that reporting path exists, it
  stores `{text: null, artifacts: []}` after authenticated logical completion. It does not infer
  process exit.
- A held job cancelled through `/cancel` gets `plantworks.job.state cancelled` (reason
  `front-door`) but no `approval.resolved`. Any token holder can cancel, not only the front door.
  **Consumer rule:** close any open approval prompt on `job.state cancelled`, whatever the
  reason. A decision that arrives later gets `409 not_held`, so nothing revives the job.
- **No integrated approval consumer or decider.** Held jobs need an external trusted caller of
  `/decision`. Otherwise they expire at their TTL, or stay held forever in a class without one,
  such as `per-job` without `approvalTtlSeconds`.
- The TTL sweep runs every second inside the broker. A broker that is down when a TTL runs out
  expires that job at its next sweep, or when a decision for it arrives.
- **Nothing moves a job from `failed` to `retried` yet.** The ADR names the transition, but the
  broker has no trustworthy link from an attempt to its predecessor. Inferring one from the
  jobId string alone is not safe, so a failed attempt stays `failed` when Hermes submits the next
  one. The link is a recorded lifecycle gap.
- **Team boundary.** There is no per-team authorization in the broker. The token is one
  broker-wide trusted credential. Team isolation is the trusted caller's job (PW-24), whatever the
  deployment shape (see the top of this file).
