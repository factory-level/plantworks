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
  envelope can't name a destination.
- **At least once:** each event is retried until the consumer answers `2xx`. A consumer can
  see the same `id` more than once and must treat repeats as no-ops.
- **Retries:** network errors, `408`, `429` and `5xx` are retried with exponential backoff
  (0.5 s doubling, capped at 30 s, 8 attempts by default). Any other `4xx` is permanent and is
  not retried.
- **Order:** events go out one at a time, in the order they were emitted. A permanently
  failed event doesn't hold back the ones after it.
- **Limit:** retries are held in memory until the broker has a persistent outbox. A process that
  crashes loses undelivered events, so re-emit from the job's recorded state.

The front door maps these events to its own actions (complete, block or attach on the card). That
mapping belongs to the front door, not to Plantworks.
