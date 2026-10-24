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
| `jobId` | yes | `kb-<board>-<cardId>-a<attempt>`, the idempotency key. The board is a Hermes kanban board slug (lowercase, 1–64 characters, may contain `-` and `_`); the card is a Hermes kanban task ID such as `t_3fa9c01e` (1–64 characters, letters, digits and `_`, no `-`); the attempt is a positive number. Example: `kb-social-media-t_3fa9c01e-a1`. Re-submitting the same `jobId` returns the existing job. Only the front door creates a new attempt (`-a2`, ...). |
| `team` | yes | DNS-safe team name, equal to the Hermes profile name |
| `class` | no | Queue class from the team spec. When absent, the broker uses the team's default class (the 16K class in the sample spec). The envelope never names a default itself |
| `task.prompt` | yes | What the worker is asked to do, at most 65,536 characters |
| `task.title` | no | Short label for logs and events, at most 200 characters |
| `timeoutSeconds` | no | Requested job timeout. The broker rejects values above the class ceiling |
| `repo` | no | Optional `owner/name` repository string; fork-defined and pending HarnessHG acknowledgement |
| `contextBudget` | no | Optional positive token count; when absent, the selected class context applies; fork-defined and pending HarnessHG acknowledgement |
| `origin` | no | Optional opaque `{ kind, ref }` reference; fork-defined and pending HarnessHG acknowledgement |

Unknown fields are rejected, so that a misspelt field is never silently ignored.

**There is no per-job callback or auth.** Events go only to the operator-configured team
`events.callbackDefault`. Optional `events.auth.secretRef` names a configured callback credential;
the broker sends it as bearer auth and refuses to start if the reference cannot be resolved. The
callback URL and credential remain operator-owned. These additive envelope fields and the event
mapping are fork-defined pending HarnessHG acknowledgement.

## States

```
queued -> claimed -> running -> done | failed
claimed -> failed                   the seat died or timed out before work started
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
| `cancelled` | `reason`: `denied`, `approval-expired` or `front-door` (cancelled by the front door). Optional `message` |

The broker never retries content. Task-level retries belong to the front door, and seat
recovery belongs to the OpenRig daemon.

## Source and defaults

The field set and the states come from the job-lifecycle section of ADR 0204. The ADR's
detailed field list was not available, so these choices are **defaults, open for review**:

1. **`task: { prompt, title? }`**: the job's content. The ADR names no content field.
2. **`timeoutSeconds`**: the one envelope value the ADR's "within the class ceilings" rule
   applies to. Per-call budgets stay class-only.
3. **No per-job callback**: events go to the team spec's `callbackDefault` only (see above).
4. **`jobId` format**: matched to Hermes' kanban IDs. Board slugs follow Hermes'
   `^[a-z0-9][a-z0-9\-_]{0,63}$`, and task IDs are `t_` plus 8 hex characters. A card ID never
   contains `-`, so it is always the second-to-last segment and the ID parses unambiguously. A
   card source with `-` in its IDs would need its own mapping. Checked against the Hermes
   source; the front-door owner has not acknowledged it yet.
5. **Failure reasons** `timeout` and `error`, next to the ADR's `call-deadline`. **Cancel
   reasons** `denied`, `approval-expired` and `front-door`.
6. **`claimed -> failed`** is allowed, so a seat that dies before work
   starts never reports a `running` that did not happen.
7. **No version field in the envelope**: the API path (`/plantworks/v1/jobs`) and the schema
   `$id` carry the version.
8. **Size limits**: `task.prompt` at most 65,536 characters, `task.title` at most 200, plus the
   `jobId` part lengths above. The broker's HTTP body limit is a separate, outer bound.

A change to the field set or the states needs an acknowledgement from the front-door owner.
