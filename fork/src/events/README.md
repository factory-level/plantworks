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

- **Destination:** the team spec's `events.callbackDefault`, which the operator configures. A job
  envelope can't name a destination. Redirects are not followed: a `3xx` reply is a permanent
  failure, so a consumer can't bounce the POST to another address.
- **Authentication:** optional `events.auth.secretRef` resolves a credential from the broker's
  configured environment and sends `Authorization: Bearer …`. An unresolved reference stops broker
  startup; its value is never put in the event or error message. Without `events.auth`, callbacks
  remain unauthenticated as before.
- **Order:** events go out one at a time, in transition order. The durable broker outbox pauses at the first
  failed row; later transitions wait behind it until delivery succeeds. Standalone emits are not
  persisted.
- **Retries:** network errors, request timeouts (10 s), `408`, `429` and `5xx` are retried with
  exponential backoff (0.5 s doubling, capped at 30 s) or the consumer's `Retry-After`, capped
  the same way. Any other `3xx` or `4xx` is permanent and is not retried.
- **Budget:** 8 attempts by default. With the default delays that is about 61.5 s of waiting
  plus up to 8 request timeouts, so **roughly 1 to 2.5 minutes**. A consumer that is down
  longer than that misses the event.

### Restart behavior

The broker stores every committed transition in the outbox cursor's source, `job_transitions`.
After a restart it replays from the first unacknowledged row with the same event id. It advances
the cursor only after a 2xx. Delivery is at least once, so consumers deduplicate by event id.
Standalone `pw job run` has no broker transition history and only tracks its local transitions.

When a callback returns a permanent `3xx`/`4xx`, or the retry budget runs out, the outbox logs the
failure and pauses at that row. A later pump retries it and later rows stay behind it.

Consumers must tolerate duplicates and should process events in transition order. The standalone
runner's local event counter is not a durable broker sequence.

The front door maps these events to its own actions (complete, block or attach on the card). That
mapping belongs to the front door, not to Plantworks.
