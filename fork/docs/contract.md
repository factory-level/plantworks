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
| Consecutive model calls exceed their deadline | On standalone `pw job run`, `call-deadline` fails the job. On the broker worker path, it is logged only; broker state is unchanged and the slot remains held. A busy response alone does not change state |

The broker's upstream qitem ID is an internal reservation value, not a deterministic derivation
from `jobId`. Callers should use `jobId` for submit idempotency and should not construct qitem IDs.
The broker persists an ambiguous reservation and reconciles it before another seat can claim that
job.

**Decision (PW-09): no `qitem-<ts>-<sha256(jobId)[:16]>` derivation.** A derived ID exists so that a
retried create after a crash reuses the same ID. The broker already guarantees that by storing the
ID instead of deriving it:
- The ID is minted before the reservation and committed in the same transaction, before any daemon
  call (`fork/src/broker/claim.ts:132`–`:145`, `fork/src/broker/store.ts:185`–`:191`). No create
  can be sent without its ID already being durable.
- Every create, first attempt or recovery, uses the stored `reserved_qitem_id`
  (`fork/src/broker/claim.ts:161`, `:194`–`:198`, `:231`).
- Upstream absorbs a create with an existing ID and the same source and destination: no second
  row, event or wake. A different destination is `409 qitem_id_reuse`
  (`packages/daemon/src/domain/queue-repository.ts:1767`–`:1794`). The fork pins this in
  `fork/test/contract/upstream-queue-contract.test.mjs:52`–`:64`.
- A crash after create and before claim, and a crash between reserve and create, each end with
  exactly one qitem claimed for the reserving seat
  (`fork/src/broker/recovery.test.ts:76`, `:102`).

`repo`, `contextBudget`, and `origin` are additive fork-defined fields pending HarnessHG
acknowledgement. `repo` is an `owner/name` string, `contextBudget` a positive integer, and `origin`
an opaque non-empty `{ "kind", "ref" }` pair. `priority`, when present, is `urgent`, `high`,
`normal`, or `low`. The job contract and state details live in
[`../src/contract/README.md`](../src/contract/README.md).

## Card status

A front door moves its card from each `plantworks.job.state` event by this mapping (D15). It is
fork-defined, pending HarnessHG acknowledgement, and comes from the PW-24 bridge skill
([`../src/hermes/plantworks-bridge/SKILL.md`](../src/hermes/plantworks-bridge/SKILL.md)).

| Event state | Card |
|---|---|
| `queued`, `claimed`, `running` | in progress |
| `held` | blocked: pending an approval decision |
| `done`, outcome `succeeded` | done |
| `done`, outcome `rejected-by-checks` | blocked, with the checks' reason |
| `done`, closure `handoff-sre` (whatever the outcome) | blocked: a person brings in the SRE agent |
| `failed` | blocked, with the reason |
| `cancelled` | closed |
| `retried` | unchanged: the card follows the next attempt's job. A D15 addition (not in the PW-24 table), fork-defined pending HarnessHG acknowledgement |

The front-door consumer contract test (`fork/src/events/front-door.test.ts`) applies this
mapping to real broker events for every state, outcome and closure. Adding a job state or
outcome without a card in that test's mapping fails it, so this table and the test change together.
