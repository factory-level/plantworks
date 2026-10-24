<!-- SPDX-License-Identifier: Apache-2.0 -->
# Job contract (v1)

The job envelope and lifecycle shared by the broker, the Phase 0 runner, the state-event
emitter and tests.

- `job.ts`: types, `validateEnvelope()`, `parseJobId()`, and the state machine (`canTransition()`,
  `transition()`, `isTerminal()`).
- `../../schema/job-envelope.schema.json`: the published JSON Schema for the envelope, for
  consumers that do not run this code. `job.test.ts` fails if it drifts from the validator.

## Envelope

| Field | Required | Meaning |
|---|---|---|
| `jobId` | yes | `kb-<board>-<cardId>-a<attempt>`, the idempotency key. Re-submitting the same `jobId` returns the existing job. Only the front door creates a new attempt (`-a2`, ...). |
| `team` | yes | DNS-safe team name, equal to the Hermes profile name |
| `class` | no | Queue class from the team spec. Defaults to `quick`, the 16K class |
| `task.prompt` | yes | What the worker is asked to do |
| `task.title` | no | Short label for logs and events |
| `callback.url` | no | Where `plantworks.job.state` events are posted. Falls back to the team spec's `events.callbackDefault` |
| `timeoutSeconds` | no | Requested job timeout. The broker rejects values above the class ceiling |

Unknown fields are rejected, so that a misspelt field is never silently ignored.

## States

```
queued -> claimed -> running -> done | failed
held   -> queued | cancelled        approval granted, or denied / expired
queued -> cancelled                 cancelled by the front door
failed -> retried                   the front door submitted the next attempt
```

A job starts in `queued`, or in `held` when its class needs approval. `done`, `cancelled` and
`retried` are terminal. `failed` is terminal unless the front door retries it.

| Entering | Detail |
|---|---|
| `done` | `outcome`: `succeeded` or `rejected-by-checks`. Optional `closure: "handoff-sre"` when a person should take the job to an SRE agent |
| `failed` | `reason`: `call-deadline`, `timeout` or `error`. Optional `message` |
| `cancelled` | `reason`: `denied`, `approval-expired` or `cancelled`. Optional `message` |

The broker never retries content. Task-level retries belong to the front door, and seat
recovery belongs to the OpenRig daemon.

## Source and defaults

The field set and the states come from the job-lifecycle section of ADR 0204. The ADR's
detailed field list was not available, so these choices are **defaults, open for review**:

1. **`task: { prompt, title? }`**: the job's content. The ADR names no content field.
2. **`timeoutSeconds`**: the one envelope value the ADR's "within the class ceilings" rule
   applies to. Per-call budgets stay class-only.
3. **`callback` is optional**: the team spec's `callbackDefault` covers it.
4. **`jobId` board and card IDs are alphanumeric** (no `-`), so the ID parses unambiguously.
5. **Failure reasons** `timeout` and `error`, next to the ADR's `call-deadline`. **Cancel
   reasons** `denied`, `approval-expired` and `cancelled`.
6. **`claimed` can only go to `running`**. A runner that fails before work starts moves to
   `running` and then `failed`, so every failure is reported from the same state.
7. **No version field in the envelope**: the API path (`/plantworks/v1/jobs`) and the schema
   `$id` carry the version.

A change to the field set or the states needs an acknowledgement from the front-door owner.
