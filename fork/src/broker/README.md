<!-- SPDX-License-Identifier: Apache-2.0 -->
# Broker (PW-17)

The job broker. It owns its own SQLite file and touches no upstream state, routes or migrations.

**Run one broker per team**, as ADR 0204 deploys it (one broker StatefulSet per team). One
process can load several teams, but that is for development only. The token, the jobs and every
route are broker-wide, so any caller can read every team's jobs, and a `409 job_conflict` on
another team's jobId returns that team's record.

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
| `POST /plantworks/v1/jobs` with the PW-09 envelope (at most 512 KiB) | `201` and the record for a new job. If the previous attempt (`-a<N-1>`) of the same card has `failed`, it becomes `retried`. `200` and the existing record when the same envelope is posted again (key order doesn't matter). `409 job_conflict` when the jobId exists with a different envelope |
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
    3. `release(jobId, seat)` drops a reservation the seat still holds.

  A reservation leaves the job `queued` and emits nothing. Any transition clears it.

## Defaults open for review

- Port 7534, next to the daemon's 7533.
- `${NAME}` placeholders in `callbackDefault` are expanded from the broker's environment, for
  names ending in `_CALLBACK` only. The spec format leaves this undefined.
- Submitting attempt N retires a `failed` attempt N-1 as `retried`. The ADR names the
  transition but not its trigger.
- Approval classes (`approval` other than `never`) are refused with `approval_unsupported` until
  PW-23 adds `held` and decisions, so no job runs unapproved.

## Limitations

- Event delivery is in memory (PW-10). A broker that stops while an event is still retrying
  loses that event. The job row is kept. The persistent outbox remains a follow-up.
- Nothing writes `result` yet. The worker report path (PW-21) adds it, and the bound on the
  stored text goes there.
- `held` and approvals are PW-23.
