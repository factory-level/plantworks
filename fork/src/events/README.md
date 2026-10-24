<!-- SPDX-License-Identifier: Apache-2.0 -->
# Job state events

`plantworks.job.state` tells the front door each time a job changes state. It is a
[CloudEvents 1.0](https://github.com/cloudevents/spec) event in structured JSON mode, sent as
`POST` with `content-type: application/cloudevents+json`.

| Attribute | Value |
|---|---|
| `type` | `plantworks.job.state` |
| `source` | `/plantworks/teams/<team>` |
| `id` | `<jobId>:<transitionSeq>`, where `transitionSeq` is the persisted transition-history row id. **Consumers deduplicate on it.** It is globally monotonic and strictly increasing per job, but not dense per job. |
| `subject` | the `jobId` |
| `data` | `jobId`, `team`, `attempt`, `state`, plus known `qitemId`, `seat`, a summary capped at 2 KiB, known artifacts/evidence/usage, and that state's detail (`outcome` and `closure` for `done`; `reason` and `message` for `failed` and `cancelled`; see `../contract/README.md`) |

## Delivery

- **Destination:** `events.callbackDefault` must be exactly an operator-supplied `${NAME_CALLBACK}`
  reference. Literal or mixed URLs are rejected, and a job envelope can't name a destination.
  Redirects are not followed.
- **Authentication:** optional `events.auth.secretRef: NAME` resolves only the operator's
  `PLANTWORKS_CALLBACK_TOKEN_NAME` variable. It cannot address arbitrary broker or daemon
  environment variables. An unresolved reference stops broker startup; its value is never put in
  the event or error message. Without `events.auth`, callbacks remain unauthenticated as before.
- **Order:** events go out one at a time per team, in transition order. Each team has an independent
  durable cursor, so a failing callback does not hold up another team. Standalone emits are not
  persisted.
- **Retries:** network errors, request timeouts (10 s), `408`, `429` and `5xx` are retried with
  exponential backoff (0.5 s doubling, capped at 30 s) or the consumer's `Retry-After`, capped
  the same way. Any other `3xx` or `4xx` is permanent and is not retried.
- **Budget:** 8 HTTP attempts per emitter cycle; the durable outbox parks an event after 3 exhausted
  cycles (at most 24 attempts), records the final error, and logs once. With default delays that is
  at most about 3 minutes of backoff plus up to 4 minutes of request timeouts. Later events for that
  team continue after the park. Other teams continue independently.

### Restart behavior

The broker stores every committed transition in `job_transitions`. After a restart it replays from
each team's first unacknowledged row with the same event id. A successful delivery advances that
team's cursor. A permanently failing event is recorded in `event_outbox_failures` and parked after
the retry budget, allowing that team's later transitions to proceed. There is not yet an HTTP
endpoint to replay a parked event. Delivery is at least once before a park, so consumers deduplicate
by event id. When enabling the outbox on a broker file that already has transition history, those
existing rows are replayed on first start. Approval events remain in-memory and are not replayed.
Standalone `pw job run` has no broker transition history and only tracks its local transitions.

When a callback returns a permanent `3xx`/`4xx`, or the retry budget runs out, the outbox retries
the next pump cycle until the three-cycle budget is exhausted, then records and logs the park once.

Consumers must tolerate duplicates and should process events in transition order. The standalone
runner's local event counter is not a durable broker sequence; reusing the same `jobId` across
separate `pw job run` invocations can reuse event IDs.

The front door maps these events to its own actions (complete, block or attach on the card). That
mapping belongs to the front door, not to Plantworks.
