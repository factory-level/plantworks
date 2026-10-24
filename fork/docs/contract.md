<!-- SPDX-License-Identifier: Apache-2.0 -->
# Submitting jobs

Submit a JSON envelope to `POST /plantworks/v1/jobs`. The examples in
[`../schema/examples/`](../schema/examples/) show the smallest accepted envelope and one with
optional fields. They are checked against the runtime validator by the fork test suite. The
[JSON Schema](../schema/job-envelope.schema.json) is available to clients; unknown fields are
rejected.

| Caller action | Broker behavior |
|---|---|
| Submit a new `jobId` | Creates a queued job, or a held job when the selected class requires approval; returns `201` |
| Retry the same `jobId` with the same envelope | Returns the existing job with `200`; it does not create another job |
| Reuse a `jobId` with a different envelope | Returns `409 job_conflict` |
| Retry work after a terminal failure | The front door chooses the next attempt and submits a new `jobId`, such as `-a2`; the broker does not retry task content |
| Endpoint returns `503` because it is busy | The governor waits and retries the model call; the broker job state and attempt do not change |
| Consecutive model calls exceed their deadline | The worker reports `call-deadline`; this can fail the job. A busy response alone does not |

The broker's upstream qitem ID is an internal reservation value, not a deterministic derivation
from `jobId`. Callers should use `jobId` for submit idempotency and should not construct qitem IDs.
The broker persists an ambiguous reservation and reconciles it before another seat can claim that
job.

`repo`, `contextBudget`, and `origin` are additive fork-defined fields pending HarnessHG
acknowledgement. `repo` is an `owner/name` string, `contextBudget` a positive integer, and `origin`
an opaque non-empty `{ "kind", "ref" }` pair. `priority`, when present, is `urgent`, `high`,
`normal`, or `low`. The job contract and state details live in
[`../src/contract/README.md`](../src/contract/README.md).
