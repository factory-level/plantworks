<!-- SPDX-License-Identifier: Apache-2.0 -->
# Broker (PW-17)

The job broker. It owns its own SQLite file and touches no upstream state, routes or migrations.

**The API is multi-team, behind one trusted credential.** A broker serves every team under
`--teams`. `PLANTWORKS_BROKER_TOKEN` is broker-wide, not scoped to a team: whoever holds it can
submit, read and cancel any team's jobs, and a `409 job_conflict` returns the existing record
whatever its team. The broker does not isolate teams. Its trusted caller, PW-24's MCP server, does
that, independent of how brokers are deployed: it checks `record.team` on every record it
returns and never forwards a conflict's `job`. ADR 0204 happens to deploy one broker per team,
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
| `POST /plantworks/v1/jobs/{jobId}/cancel` | `queued` or `held` becomes `cancelled` with reason `front-door`: `200` and the record. Already `cancelled`: `200` (idempotent). Any other state: `409 not_cancellable`. Unknown job: `404 not_found` |

The record is `fork/schema/job-record.schema.json`:
`{jobId, team, class, state, detail, createdAt, updatedAt, result}`.
- `class` is the resolved class.
- `detail` is the PW-09 detail for the current state.
- `result` is `null` until a worker reports (PW-21).

Errors are `{error, message}`, plus `errors` for an invalid envelope and `job` for a conflict:

| Status | `error` |
|---|---|
| 400 | `invalid_envelope`, `unknown_team`, `unknown_class`, `timeout_over_ceiling`, `approval_unsupported` |
| 401 | `unauthorized` |
| 404 | `not_found` |
| 409 | `job_conflict`, `not_cancellable` |
| 413 | `too_large` |

Submit checks, in order:
1. A valid envelope.
2. An existing jobId: the request is a replay, so the job comes back unchanged.
3. A known team.
4. The class is the envelope's `class`, or the spec's `defaultClass`, and must exist.
5. `timeoutSeconds` must be within that class's `timeoutSeconds`.

Submit never creates an upstream queue item and limits no concurrency. Claiming and the slot
cap belong to claim-next (PW-18, PW-19).

### claim-next (PW-18, `claim.ts`)

`POST /plantworks/v1/claim-next` with `{team, seat, class?}`. `seat` is the OpenRig session that
will do the work, for example `dev-worker@team`. No `class` means the team's `defaultClass`.

| Response | When |
|---|---|
| `200 {job, qitemId, seat, envelope}` | The oldest queued job of that class is now `claimed` by the seat. Its upstream qitem `qitemId` is addressed to the seat and claimed for it |
| `204` | Nothing claimable in that class |
| `400` | `invalid_claim`, `unknown_team`, `unknown_class` |
| `429 slot_cap_reached` | The team's `slotBudgetKey` already has its cap of jobs in flight (PW-19). The body has `{slotBudgetKey, cap, inFlight}`. Ask again later |
| `409 reservation_lost` | The job was cancelled, or its lease taken over, while it was being handed to this seat. Ask again |
| `503 daemon_unavailable` | The daemon refused or didn't answer. The job stays claimable at once |

This is **late binding**: the upstream qitem exists only from the moment a seat claims, and its
destination is that seat. Steps:
1. `reserve`, with a qitem id chosen first.
2. Close the expired holder's qitem, if this took over a lease.
3. Create the qitem with that id. Upstream treats a retried create with the same id as
   idempotent.
4. Claim it for the seat.
5. `confirmClaim`, then emit `claimed`.

Failure handling: on a daemon failure, the reservation is released and the qitem closed. On
`lost`, the broker's own qitem is closed. Nothing is ever emitted for a claim that didn't happen.

### Slot cap (PW-19, `slots.ts`)

`PLANTWORKS_SLOT_CAP` caps the jobs in flight per `slotBudgetKey`, counted across every team that
shares the key.

- **Format.** `key=n` entries, comma-separated, with an optional bare `n` for every other key,
  for example `social-media=1` or `2,social-media=1`.
- **Unset** means the Phase 0–1 default of **1 per key**; it never means unlimited. `0` stops
  claims for a key. A malformed value stops the broker from starting.
- **In flight** means `claimed` or `running`, or `queued` under a live (unexpired) claim-next
  reservation. So a handoff in progress holds its slot, while an expired reservation holds none.
- **A slot frees** when the job reaches a terminal state.
- **Never exceeded.** claim-next counts and reserves in one immediate SQLite transaction, so
  concurrent claims, or another broker on the same file, can't exceed the cap.
- **Separate from other caps.** This runtime cap is independent of the team spec's validation
  caps (`pw team validate --platform`) and of Hermes' `kanban.max_in_progress_per_profile`.

**Fail-closed: a slot is never freed on a timeout alone.** A seat that dies while holding a job
keeps its slot, because Pi may still be running and the cap protects the shared inference lane.
With cap 1, that stalls the key, which is the safe failure. The slot frees only on evidence that
the work stopped:
- the upstream qitem reaching a terminal state;
- proven evidence that the seat's Pi process is gone;
- an explicit, audited operator action.

Which of these exist is the worker lifecycle's job (PW-21).

The daemon is `PLANTWORKS_DAEMON_URL` (default `http://127.0.0.1:7533`, the PW-16 port), with
`OPENRIG_AUTH_BEARER_TOKEN` when set. Qitems are created as `PLANTWORKS_BROKER_SESSION` (default
`plantworks-broker`). The broker names the seat in the request body, so the daemon records it as
a claimed identity (`claimed:v1`). It never sends `X-OpenRig-Session`, which would assert the
seat's transport identity. Closing a qitem is `done` with `closureReason: canceled`.

## For other cards

- **Routes.** `createBroker({store, teams, routes})` takes `BrokerRoutes` functions,
  `(app, {store, teams, emit}) => void`. They add routes without editing `server.ts` (PW-18
  claim-next, PW-23 decisions).
- **Store.** `openStore(path)` returns:
  - `insert`, `get`, and `tx(fn)`;
  - `transition(jobId, to, detail, columns)`: one PW-09 transition and the row update, in one
    transaction. It refuses `claimed`, so a seat whose lease was taken over cannot claim around
    `confirmClaim`;
  - claim-next, in three steps:
    1. `reserve(team, class, seat, qitemId, leaseMs = RESERVATION_LEASE_MS)` returns
       `{job, previousQitemId}`. `previousQitemId` is the expired holder's qitem when this
       call took over a lease, and the caller closes it.
    2. `confirmClaim(jobId, seat, qitemId)` moves the job from `queued` to `claimed`, but only
       while the reservation is still this seat's with this qitem (a compare-and-set).
       Otherwise it returns `"lost"`, for example when a slow seat's lease was taken over or the
       job was cancelled, and the caller closes its own qitem.
    3. `release(jobId, seat, qitemId)` drops a reservation only while it is still this seat's
       with this qitem. The same seat may hold a newer reservation after its own lease ran out.

  A reservation leaves the job `queued` and emits nothing. Any transition clears it.

## Defaults open for review

- Port 7534, next to the daemon's 7533.
- `${NAME}` placeholders in `callbackDefault` are expanded from the broker's environment, for
  names ending in `_CALLBACK` only. The spec format leaves this undefined.
- Approval classes (`approval` other than `never`) are refused with `approval_unsupported` until
  PW-23 adds `held` and decisions, so no job runs unapproved.

## Limitations

- Event delivery is in memory (PW-10). A broker that stops while an event is still retrying
  loses that event. The job row is kept. The persistent outbox remains a follow-up.
- Nothing writes `result` yet. The worker report path (PW-21) adds it, and the bound on the
  stored text goes there.
- `held` and approvals are PW-23.
- **Nothing moves a job from `failed` to `retried` yet.** The ADR names the transition, but the
  broker has no trustworthy link from an attempt to its predecessor. Inferring one from the
  jobId string alone is not safe, so a failed attempt stays `failed` when Hermes submits the next
  one. The link is a recorded lifecycle gap.
- **Team boundary.** There is no per-team authorization in the broker. The token is one
  broker-wide trusted credential. Team isolation is the trusted caller's job (PW-24), whatever the
  deployment shape (see the top of this file).
