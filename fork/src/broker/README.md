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
| `POST /plantworks/v1/jobs/{jobId}/cancel` | `queued` or `held` becomes `cancelled` with reason `front-door`: `200` and the record. Already `cancelled`: `200` (idempotent). Any other state: `409 not_cancellable`. Unknown job: `404 not_found` |

The record is `fork/schema/job-record.schema.json`:
`{jobId, team, class, state, detail, createdAt, updatedAt, result}`.
- `class` is the resolved class.
- `detail` is the PW-09 detail for the current state.
- `result` is `null` until a worker reports (PW-21).

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
deduplicates them as it does job.state events. There is no Slack code here. The front door
(Hermes) turns `approval.requested` into a prompt and POSTs the person's answer.

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
- `approval: per-job` holds every job, like `always`, but with no TTL unless the class sets
  `approvalTtlSeconds`. The ADR does not say what decides "per job". The envelope has no field
  for it, and adding one would change the PW-09 contract, so no job in such a class runs
  unapproved.
- Approval events go to the team's `callbackDefault`. `events.approvalConsumer` must be
  `frontdoor`, the ADR's default (Hermes). Any other value stops the broker.
- The broker does not check who may decide (ADR open decision 8, approvers). `by` is recorded in
  the resolved event, not verified. Anyone holding the broker token can decide. **That includes
  the submitter**: Hermes, or PW-24's MCP server, holds the same token and could approve its own
  job. Until an approver policy exists, `held` records a decision but does not guarantee a person
  made it.

## Limitations

- Event delivery is in memory (PW-10). A broker that stops while an event is still retrying
  loses that event. The job row is kept. The persistent outbox remains a follow-up.
- Nothing writes `result` yet. The worker report path (PW-21) adds it, and the bound on the
  stored text goes there.
- A held job cancelled through `/cancel` gets `plantworks.job.state cancelled` (reason
  `front-door`) but no `approval.resolved`. Any token holder can cancel, not only the front door.
  **Consumer rule:** close any open approval prompt on `job.state cancelled`, whatever the
  reason. A decision that arrives later gets `409 not_held`, so nothing revives the job.
- The TTL sweep runs every second inside the broker. A broker that is down when a TTL runs out
  expires that job at its next sweep, or when a decision for it arrives.
- **Nothing moves a job from `failed` to `retried` yet.** The ADR names the transition, but the
  broker has no trustworthy link from an attempt to its predecessor. Inferring one from the
  jobId string alone is not safe, so a failed attempt stays `failed` when Hermes submits the next
  one. The link is a recorded lifecycle gap.
- **Team boundary.** There is no per-team authorization in the broker. The token is one
  broker-wide trusted credential. Team isolation is the trusted caller's job (PW-24), whatever the
  deployment shape (see the top of this file).
