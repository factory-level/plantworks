<!-- SPDX-License-Identifier: Apache-2.0 -->
# Platform requirements

What the platform under Plantworks must provide: one model endpoint, the models the worker
classes use, enough context for them, and the slot budget that caps concurrent jobs. Each item
names where it is read and checked. Processes, paths, ports and termination are in
[`runtime-contract.md`](runtime-contract.md).

## The model endpoint

| Requirement | Value | Read and checked by |
|---|---|---|
| One OpenAI-compatible base URL | `PLANTWORKS_LLM_URL`, http or https, with no credentials in the URL. For example `http://127.0.0.1:11434/v1` | `fork/src/llm/endpoint.ts:9`–`:18`. Unset, malformed or credentialed values are refused |
| Its key, if it needs one | `PLANTWORKS_LLM_API_KEY` | `fork/src/llm/endpoint.ts:19`. Only the per-seat governor sends it. Pi never sees the URL or the key |
| It lists its models | `GET <url>/models` | `plantworks pw llm preflight` checks reachability and that every model the team specs name is served. With `--teams <dir>`, or `$PLANTWORKS_TEAMS_DIR`, it reads the specs as the broker does (`--platform` passes the platform file). With `--class <c>` it checks one built-in class instead. It makes no inference call (`fork/src/llm/command.ts`, `fork/src/llm/endpoint.ts:26`) |

Plantworks runs no model server and manages no GPUs. Whoever runs the endpoint owns it.

## Models and context

| Requirement | Phase 0–1 value | Where |
|---|---|---|
| Served models | `qwen3.5:9b` | `CLASSES` (`fork/src/llm/classes.ts:14`) and the default platform `PHASE_0_1` (`fork/src/team/spec.ts:57`) |
| Context per call | The built-in `pw job run` classes: `quick`, the default, 16384 tokens; `long`, 32768. A team spec's classes set their own `context.maxContextTokens`, within the rules in `fork/src/team/README.md` | `fork/src/llm/classes.ts:14`–`:20` |
| Platform maximum context | 32768 tokens | `CEILINGS.maxContextTokens` (`fork/src/llm/classes.ts:22`) |
| Output and time per call | up to 1536 tokens at 16K context or less, 1024 above it. At most 60 s | `CEILINGS`. The platform may **lower** these with `PLANTWORKS_MAX_CALL_OUTPUT` and `PLANTWORKS_MAX_CALL_SECONDS`, never raise them. A higher or malformed value stops the broker (`fork/src/llm/classes.ts:31`) |

A team spec is validated against a platform file (`pw team validate --platform <file>`) with
these fields (`fork/src/team/spec.ts:46`–`:56`):

```jsonc
{
  "slotCaps": { "<slotBudgetKey>": 1 },   // concurrent jobs per budget key; a missing key counts as 0
  "models": ["qwen3.5:9b"],               // what the endpoint serves
  "maxContextTokens": 32768,              // the endpoint's maximum context
  "piBaselineTokens": 0,                  // optional: measured Pi prompt baseline
  "reserveTokens": 0                      // optional: reserve on top of baseline + output
}
```

Without `--platform`, the Phase 0–1 platform applies: the one model above, a 32768-token maximum
and no slots. A team that wants a slot therefore needs a platform file that grants one. See the
team README's validation rules, `fork/src/team/README.md`.

## Slot budget

| Requirement | Value | Where |
|---|---|---|
| The runtime cap on concurrent jobs per `slotBudgetKey` | `PLANTWORKS_SLOT_CAP`, for example `social-media=1` or `2,social-media=1`. **Unset means 1 per key, never unlimited.** `0` stops claims for a key. A malformed value stops the broker | `fork/src/broker/slots.ts:12`–`:22`. Read at broker start (`fork/src/broker/command.ts:36`) |

The cap counts broker job states, not running Pi processes. See "Slot cap" in
`fork/src/broker/README.md`.

- **At start:** `pw broker serve` **refuses to start** when the teams sharing a `slotBudgetKey` ask
  for more `slots` than `PLANTWORKS_SLOT_CAP` gives that key (`fork/src/broker/command.ts:38`,
  `slotCapProblems`). With the cap unset, that means more than 1. This is the most likely start
  failure on a new platform.
- **While running:** claim-next holds every key to its cap.
- **Validation only:** the platform file's `slotCaps` decides whether a spec is valid
  (`pw team validate`). It should agree with `PLANTWORKS_SLOT_CAP`.

## Not in this repository

- **The deployment footprint.** ADR 0204's deployment partner document (`k8s-footprint.md`) is
  not part of this repository, and nothing here links to it. Cluster manifests, endpoint
  hosting and slot moves on a live cluster belong to the deployment repository, not to Plantworks.
- **Who serves the model, and where.** This document names only the contract: a URL, a model
  list, a context size and a slot budget.
