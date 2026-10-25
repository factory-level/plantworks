<!-- SPDX-License-Identifier: Apache-2.0 -->
# Adding a team

For a team author: how to describe a team, check it, and hand it to the platform. "Plantworks" is
this fork's code name. The details live in the linked READMEs, and this page puts them in order.

## 1. Adding a team is a GitOps change

A team is never added by hand on a running system. The steps:

1. **Write the team definition** (`team.json`, the shape below).
2. **Validate it** against the platform file the platform gives you:
   `plantworks pw team validate team.json --platform platform.json`.
3. **Emit the files the platform reads:**
   `plantworks pw team emit team.json --out out/ --platform platform.json`. It writes
   `out/<team>/team.json`, the Hermes profile (`hermes-profile/config.yaml`) and the bridge skill.
   Nothing is written if the definition is invalid. See `../src/team/README.md`.
4. **Open a pull request with `out/<team>/`** against the platform's GitOps repository. The
   platform registers the team's Hermes profile and deploys its broker and workers from there.
   That repository, and how it rolls changes out, belong to the platform, not to this fork.

**Removing a team** is the same kind of change: delete `<team>/` from the spec set. Cancel or
finish the team's live jobs first. See "Removing a team" in `../src/team/README.md`.

## 2. Pick classes

A class is a queue with its own model, limits and approval policy. Jobs without a class run in the
team's `defaultClass`.

- **Limits.** Each class sets `context.maxContextTokens`, and `perCall` with at most 60 s and
  1536 output tokens (1024 above a 16K context).
  - The default class has at most a 16384-token context; 32K is opt-in per class.
  - A job's `timeoutSeconds` and `contextBudget` must fit the class, and the broker refuses one
    that doesn't.
  - All validator rules: "Validator rules" in `../src/team/README.md`.
- **Pi on the seat.** Each worker seat gets `models.json` and `settings.json` rendered from its
  class. The provider is the per-seat call governor, never the endpoint itself. Compaction is
  sized to the class's context.
  - `toolProfile: trimmed` (opt-in per class) gives Pi fewer tools and a short system prompt.
  - See `../src/seat/pi-seat-files.ts`, and "Render" in `../src/team/README.md` for the seat
    layout.
- **Seats per class.** `trains × perTrain.workers[class]` workers serve a class. There must be at
  least as many as its `slots`.

## 3. Request slots from the platform

Slots are capacity on the shared model endpoint. You ask for them; the platform grants them.

- **The request.** Set `slots` per class and an `endpoint.slotBudgetKey`. Teams that share a key
  share its budget.
- **Validation needs a grant.** A spec only validates against a platform file whose `slotCaps`
  grants that key enough slots. With no platform file, any class with `slots` > 0 is refused.
- **The broker enforces the runtime cap.** It uses `PLANTWORKS_SLOT_CAP` per key, and with that
  unset, 1 in flight per key. It refuses to start when the teams on a key ask for more slots than
  the cap.

See [`platform-requirements.md`](platform-requirements.md) for what the platform provides: the
endpoint, the served models, the context limits and the slot cap.

## 4. Approvals

A class whose `approval` is not `never` holds each job until a decision arrives:
- the broker emits `plantworks.approval.requested`, with a `decisionUrl`, to the team's callback;
- a trusted caller POSTs approve or deny there;
- `approval: always` needs an `approvalTtlSeconds`, after which an undecided job is cancelled as
  `approval-expired`.

**No approval decider is integrated today.** Nothing in this fork turns the request into a prompt
for a person. The Hermes kit can report that a job is held, but it can't approve it. Until a
trusted caller of the decision endpoint exists, a held job waits for its TTL, or indefinitely if
it has none. See "Approvals" in `../src/broker/README.md`.

## 5. What the contract is

- **Submitting jobs, the envelope and its examples:** [`contract.md`](contract.md). The state
  events are in `../src/events/README.md`.
- **What runs, where state lives, inputs, termination:**
  [`runtime-contract.md`](runtime-contract.md).
- **What the platform must provide:** [`platform-requirements.md`](platform-requirements.md).
- **How Hermes submits and follows jobs:** `../src/hermes/README.md`, the kit with its four tools
  and the bridge skill.

## Not covered here

- **Handing a job off to an SRE agent via Slack** is not built. It is gated, and this page
  will describe it once it exists. A job closed as `handoff-sre` is only reported, as the bridge
  skill says.
- **The platform's own design documents** (its front-door and approval design, its cluster
  footprint) are not in this public repository. Ask the platform team for them.
- **Releases and images.** Tagged releases and published images are separate, gated work.
