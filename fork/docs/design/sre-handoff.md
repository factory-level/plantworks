<!-- SPDX-License-Identifier: Apache-2.0 -->
# Design: the Plantworks side of the SRE handoff (PW-34)

Status: design note for review. Every shape here is **fork-defined, pending HarnessHG
acknowledgement**. The fork has no Slack or Eve code (ADR 0204: harness-hg owns Slack ingress,
the Eve SRE agents and the `sre.*` events).

PW-34 asks the fork for two independent things:
1. **Handoff out.** A job can end by asking a person to bring in an SRE agent. The broker emits
   `plantworks.handoff.requested`.
2. **Wake pause in.** While an Eve SRE agent wakes, the broker stops starting new work, and
   resumes on `sre.wake.ready` or after 120 s.

Neither one holds or resumes a job. A handoff job is terminal (`done`), and the pause works on
dispatch, not on jobs. See [Rejected alternatives](#rejected-alternatives).

## 1. Handoff out

### How a job ends with a handoff

The handoff is the seat's own closure, under the same rule as the other outcomes
(`fork/src/broker/reconcile.ts` `seatOutcome`). The seat closes its qitem `done` with closure
reason `escalation` and closure target `handoff-sre`.

Upstream already has `escalation` with a required target (`hot-potato-enforcer.ts`). The target
text is this fork's convention, as with `denied` / `rejected-by-checks`. As today, only the exact
qitem's latest `done` transition counts, made by its destination with `transport:v1` identity.
Administrative or foreign closures prove nothing, and the job stays in flight. `transport:v1` is how
the daemon got the closer's name (the `X-OpenRig-Session` header), not authentication, so this is
the seat's recorded closure rather than a proven one (broker README, "What a seat's closure proves").

The job's transition is then `done` with `{outcome, closure: "handoff-sre"}`. The contract
already allows this (`fork/src/contract/job.ts`).

`outcome` comes from the handoff report (below). When the report doesn't state it, `outcome`
defaults to **`rejected-by-checks`**, so a handoff never claims success by default. The front
door ignores `outcome` for a `handoff-sre` closure (D15 mapping, `fork/docs/contract.md`).

### The handoff artifact

It rides on the W4-A ordered report path (`fork/docs/design/broker-report.md`, not yet on main) as an optional
`handoff` member. The report is the only seat-to-broker channel for content. This note adds no
second one.

```jsonc
"handoff": {
  "targetAgent": "platform-sre",        // key in the team spec's sre.agents (required)
  "summary": "…",                       // required, 1..2000 chars
  "suggestedAction": "…",               // required, 1..1000 chars
  "evidence": [{ "kind": "log", "uri": "…" }],  // 0..20, same {kind, uri} shape as job.state evidence
  "outcome": "succeeded" | "rejected-by-checks" // optional, default rejected-by-checks
}
```

Unknown fields are rejected, as for the envelope.

### How the artifact gets from Pi to the report (r1)

The worker can't see Pi's output, only usage and the workspace tree (#105). So the channel is
**one file in the class `workspace`: `.plantworks/handoff.json`**. The seat's Pi writes it before
closing with `escalation` / `handoff-sre`. The qitem closure text isn't used, because upstream's
`closure_target` is a short reason string, and `handoff-sre` already fills it.

The worker reads the file once, when it builds the #105 report, and puts the result in the
report's `handoff` member. The read fails closed:
- **No `workspace`** for the class, or a workspace that fails #105's co-location check →
  `unavailable: missing`.
- **File absent**, or unchanged from the take-up baseline → `unavailable: missing`. A stale file
  left by an earlier job never counts; the worker records its hash in the #105 per-job baseline.
- **Not a regular file:** a symlink (`lstat`), a directory, over 16 KiB, unreadable, not UTF-8
  JSON, or a path that resolves outside the workspace → `unavailable: invalid: <why>`.
- **Parses** → the broker validates it as above.

`.plantworks/` is fork-owned scratch and is excluded from the #105 artifact file list.

The artifact inherits #105's caveats unchanged:
- It is **worker-asserted**. It is stored with `reportProvenance: "worker-asserted"`, the broker
  can't verify it, and consumers must not treat it as broker-verified.
- It has the same co-location limit, because it is read from the tree the worker checks.

### The `targetAgent` mapping (team spec)

A new optional top-level team spec member is added in `fleet.schema.json` and validated by
`pw team validate`:

```yaml
sre:
  agents:
    platform-sre: { slackApp: "${PLANTWORKS_SRE_SLACK_PLATFORM}" }
```

- The keys are DNS-safe names.
- `slackApp` is an opaque operator environment reference. It follows the same rule as
  `events.callbackDefault`: exactly one `${PLANTWORKS_SRE_SLACK_*}` reference, never a literal.
- The fork reads the mapping and never interprets the value. Hermes resolves it. harness-hg owns
  the Slack apps.
- A spec without `sre` has no handoff targets.

### Fail-closed validation

The broker validates the artifact when it finalises the `done`:

| Report | Job transition | `handoff.requested` data |
|---|---|---|
| Valid, known `targetAgent` | `done {outcome, closure: handoff-sre}` | the artifact, with `targetAgent` and the mapped `slackApp` reference name |
| Missing, timed out (W4-A bound), invalid, or `targetAgent` not in the spec | `done {outcome: rejected-by-checks, closure: handoff-sre}` | `{"unavailable": "<timeout \| missing \| invalid: <first error> \| unknown-target: <name>>"}`, with **no** `targetAgent` |

The seat's recorded closure is the logical fact, so the `done` is never lost or blocked (the
W4-A rule). The broker **never routes to a guessed or default agent**. An unusable artifact still
reaches a person, because the card is blocked ("a person brings in the SRE agent"), and the event
says why the details are missing.

### The event

`plantworks.handoff.requested` is a CloudEvent 1.0, with the same envelope as `plantworks.job.state`:

| Field | Value |
|---|---|
| `type` | `plantworks.handoff.requested` |
| `source` | `/plantworks/teams/<team>` |
| `id` | `<jobId>:<transitionId>:handoff.requested` (the `done` transition's persisted id) |
| `subject` | `<jobId>` |
| `data` | `{jobId, team, attempt, qitemId?, seat?, outcome, …artifact or unavailable}` |

**Delivery.** The event is derived from the same persisted `done` transition row by the durable
per-team job-state outbox (`fork/src/events/outbox.ts` `eventForTransition`). It is emitted
**after** that transition's `plantworks.job.state`, and resumes after a broker restart.

It must **not** use the in-memory `ctx.send` path that approval events use, which can lose events
(see the broker README's Limitations). That gives at-least-once delivery like PW-10. Consumers
dedupe on `id`, and a redelivery is byte-identical.

**Two events, one transition (r1).** The outbox cursor, failure, backoff and park rows are all
keyed by `(team, transition_id)`, so a handoff `done` is delivered as **one pair**:
- `job.state` goes first, then `handoff.requested`. **The cursor advances only after both are
  delivered.**
- **A transient failure of either** records one failure row for the transition, and the existing
  exponential backoff applies to the pair. The retry redelivers **both**, from `job.state`, with
  unchanged ids. A `job.state` that was already delivered is then a duplicate, which
  at-least-once already allows. No sub-cursor is added.
- **A permanent failure of either** parks the transition as today: the park and the cursor
  advance are one transaction, and the log names the failing event's id. An event already
  delivered stays delivered. Parking means the pair isn't guaranteed, not that both failed.
- An aborted delivery (the outbox stopping) records nothing and moves no cursor, as today.

**Consumer contract** (Hermes and the bridge skill, not fork code): post the handoff in Slack
addressed to the mapped SRE agent's app, then wait for a person (HITL). Plantworks never calls
Eve or an SRE agent, and has no cluster access.

## 2. Wake pause in

### Inbound

`POST /plantworks/v1/sre/wake` takes a structured CloudEvent, at most 4 KiB:

```jsonc
{ "specversion": "1.0", "type": "sre.wake.requested" | "sre.wake.ready",
  "id": "…", "source": "…", "data": { "wakeId": "…", "agent": "platform-sre" } }
```

- `wakeId` is required: 1..200 chars, matching `[A-Za-z0-9._:-]`. It pairs requested with ready.
- `agent` is recorded for stats and logs only. An agent the spec doesn't know is accepted, because
  the pause is broker-wide.
- It returns `202`. A malformed body gets `400 invalid_wake`, and an unknown `type` gets `400`.
- **Auth:** the same `PLANTWORKS_BROKER_TOKEN` bearer as every `/plantworks/v1/` route. This is an
  open item: see [open questions](#open-questions).

### Semantics

The broker keeps a map `wakeId → {agent, until}`. It is in memory and **per broker process**,
so a second broker process would need its own copy of each event. The deployment rule is one
broker per team.

| Event | Effect |
|---|---|
| `requested`, new `wakeId` | add it, with `until` = now + **120 s** |
| `requested`, `wakeId` already active | no-op. **A replay never extends the pause** |
| `requested`, `wakeId` already resolved or expired | no-op. A reordered or replayed request can't re-pause |
| `ready`, active `wakeId` | remove it |
| `ready`, unknown `wakeId` | record it as resolved, so a late `requested` is ignored. Returns `202` |

- Resolved and expired ids are remembered for 10 minutes, which bounds the memory.
- **Dispatch is paused while any wake is active and unexpired.**

While paused:
- `claim-next` returns **`204`** (nothing claimable) with the header `Plantworks-Dispatch: paused`.
  Workers already treat `204` as "try later", so worker code doesn't change.
  - The check runs at claim-next entry, so a reservation already in flight completes.
  - Recovery of a stuck reservation (`recoverHandoff`) still runs, because it finishes an existing
    claim rather than starting new work.
- **Unchanged:**
  - claimed and running jobs: they are never killed, unclaimed or released;
  - reconciliation to `done` / `failed`;
  - submit, which still queues work;
  - `/decision`, `/cancel` and the approval TTL sweep;
  - event delivery.
- `/plantworks/v1/stats` adds `dispatch: {paused, wakes: [{wakeId, agent, until}]}`.

### What fails which way

The pause is a capacity courtesy to a waking SRE agent on the shared GPU. It is **not a safety
barrier**, and the card requires a timeout that resumes dispatch.

**Toward dispatch (by design):**
- the 120 s timeout;
- a broker restart, because pause state is in memory and a restart is equivalent to every timeout
  firing at once.

**Never, by any path:**
- killing, unclaiming or signalling a running job;
- pausing longer than 120 s from a single `wakeId`;
- re-pausing from a replayed or reordered event.

A stream of new `wakeId`s can keep dispatch paused. Each one is bounded, and only a bearer holder
can send them. See open questions.

## 3. Contract tests (implementation row, sealed per #75)

1. **Reconcile:** a seat's own `escalation`/`handoff-sre` closure gives
   `done {outcome, closure: handoff-sre}`. The same closure from a non-destination, an
   administrative closure, or one followed by a reopen gives nothing (still in flight).
2. **Artifact:**
   - valid → event carries it;
   - each failure row in the table → `unavailable` with no `targetAgent`;
   - a missing `outcome` → `rejected-by-checks`;
   - unknown fields → invalid.
3. **Team spec:**
   - `sre.agents` validates;
   - a literal `slackApp` is rejected;
   - a spec without `sre` makes every handoff `unknown-target`.
4. **Event:**
   - id `<jobId>:<transitionId>:handoff.requested`;
   - emitted after that transition's `job.state`;
   - survives a broker restart mid-retry (outbox);
   - a redelivery is identical;
   - the pair: a transient failure of `handoff.requested` after `job.state` was delivered leaves
     the cursor in place, backs off once for the transition, and redelivers both with unchanged
     ids;
   - a permanent failure of either parks the transition, advances the cursor in the same
     transaction, and lets the next transition deliver.
   - **Artifact read** (worker side), each giving the `unavailable` reason above:
     - no workspace;
     - file absent;
     - stale file unchanged since take-up;
     - a symlink;
     - over 16 KiB;
     - bad JSON;
     - a valid file → `handoff` in the report, with `reportProvenance: "worker-asserted"`.
5. **Front door** (`fork/src/events/front-door.test.ts`): `handoff-sre` → blocked, as today, plus a
   consumer fixture for `handoff.requested` that dedupes on `id`.
6. **Pause:**
   - `requested` → claim-next `204` + header with queued work present;
   - `ready` → the next claim succeeds;
   - an injected clock at 120 s → resumes;
   - a replayed `requested` doesn't extend the pause;
   - `ready` before `requested` → no pause;
   - a running job reconciles to `done` during the pause;
   - submit, decision and cancel work during the pause;
   - a restart clears the pause.
7. **Boundary:** a check (`check-seams` style) that `fork/src` imports no Slack or Eve client, and
   that broker and worker have no team-specific branches.

## Rejected alternatives

- **A held job that resumes on `sre.wake.*`.** It isn't on the card. It would need a new
  `done → held` or `running → held` edge in the state machine, which breaks terminal `done` and
  the D15 card mapping. `held` would also mean two different things: approval and SRE. A follow-up
  after SRE work is a **new job** (`-a2` or a new card), submitted by the front door.
- **Per-job or per-class pause.** The card specifies broker dispatch. One broker serves one team,
  so it's per team in practice.
- **Persisting pause state.** That adds a store migration for a 120 s courtesy whose failure mode
  is "dispatch resumes", which is already the timeout behaviour.
- **Fork-chosen event names.** The ADR's diagram says `sre.waking` / `sre.ready`. The card's
  acceptance says `sre.wake.requested` / `sre.wake.ready`. This note uses the card's names, and the
  HarnessHG ack settles the final ones.

## Open questions (for the HarnessHG ack)

1. **Credential.** `/sre/wake` uses the shared broker bearer, so the front door could also pause
   dispatch. Should a separate ingress token (`PLANTWORKS_SRE_WAKE_TOKEN`) gate this route?
2. **Global cap.** Should overlapping `wakeId`s be capped (for example 120 s of total pause per
   10 minutes)?
3. **Names.** `sre.wake.*` (card) or `sre.waking` / `sre.ready` (ADR diagram).
4. **Report dependency.** The handoff artifact needs W4-A's report path. Until it lands, every
   handoff is `unavailable: missing`, which is safe but carries no content.
