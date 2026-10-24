<!-- SPDX-License-Identifier: Apache-2.0 -->
# Job state events

`plantworks.job.state` tells the front door each time a job changes state. It is a
[CloudEvents 1.0](https://github.com/cloudevents/spec) event in structured JSON mode, sent as
`POST` with `content-type: application/cloudevents+json`.

| Attribute | Value |
|---|---|
| `type` | `plantworks.job.state` |
| `source` | `/plantworks/teams/<team>` |
| `id` | `<jobId>:<state>`. **Consumers deduplicate on it.** |
| `subject` | the `jobId` |
| `data` | `jobId`, `team`, `attempt`, `state`, plus that state's detail (`outcome` and `closure` for `done`; `reason` and `message` for `failed` and `cancelled`; see `../contract/README.md`) |

## Delivery

- **Destination:** the team spec's `events.callbackDefault`, which the operator configures. A job
  envelope can't name a destination. Redirects are not followed: a `3xx` reply is a permanent
  failure, so a consumer can't bounce the POST to another address.
- **Order:** events go out one at a time, in the order they were emitted. A failed event
  doesn't hold back the ones after it.
- **Retries:** network errors, request timeouts (10 s), `408`, `429` and `5xx` are retried with
  exponential backoff (0.5 s doubling, capped at 30 s) or the consumer's `Retry-After`, capped
  the same way. Any other `3xx` or `4xx` is permanent and is not retried.
- **Budget:** 8 attempts by default. With the default delays that is about 61.5 s of waiting
  plus up to 8 request timeouts, so **roughly 1 to 2.5 minutes**. A consumer that is down
  longer than that misses the event.

### What "at least once" means here

An event is delivered at least once **while the emitting process is alive and the consumer
recovers within the retry budget**. When it isn't delivered (permanent `3xx`/`4xx`, or the
budget ran out):

- the emitter reports it through `onDeliveryError` (default: a line on stderr), and `emit()`
  rejects with a `DeliveryError` carrying the event. **The event is then the caller's**: record
  it and re-emit it later. Await or catch every `emit()`.
- nothing is persisted. After a crash, a process can only re-emit the job's **current** state,
  so intermediate events (for example `claimed`, `running`) may never arrive.

**Consumers must therefore tolerate both duplicates** (deduplicate on `id`) **and gaps**
(treat a later state as implying the earlier ones). Restart durability arrives with the
broker's persistent outbox. Until then, nothing in Phase 0 should assume it.

The front door maps these events to its own actions (complete, block or attach on the card). That
mapping belongs to the front door, not to Plantworks.
