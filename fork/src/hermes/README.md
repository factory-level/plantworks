<!-- SPDX-License-Identifier: Apache-2.0 -->
# Hermes integration kit (PW-24): contract

This is how an **unmodified** upstream Hermes Agent (pinned at v0.22.5) hands work to one
Plantworks team. It has two parts, and needs no Hermes code:

- **`plantworks pw mcp serve`**: an MCP server with three tools: submit, inspect and cancel.
  It is a separate server next to upstream's `rig mcp serve` (`plantworks mcp serve`), not
  part of it. It shares no tools, tokens or grant files with it, and does not talk to the
  OpenRig daemon. It is a thin client of one team's broker.
- **`plantworks-bridge/SKILL.md`**: a Hermes skill that tells the team profile when and how
  to use those tools.

**Status: contract only.** The implementation waits for PW-17 (broker jobs API) and PW-20
(team/profile emitter) to merge. Anything marked *proposed* still needs the counterpart
owner's acknowledgement. The jobs API paths and the result fields below are **coordination
drafts**: no broker stores or serves results yet. They hold only once PW-17 settles them and
review verifies them.

## Transport and placement

Hermes reaches an MCP server in one of two ways (`mcp_servers.<name>` in the profile's
`config.yaml`): a local stdio subprocess (`command`/`args`), or a remote server over
Streamable HTTP (`url`/`headers`). The Hermes image is used unmodified and has no Plantworks
binary in it, so **in a cluster it has to be HTTP**. stdio is for local use and tests.

| Mode | Started as | Use |
|---|---|---|
| stdio | `plantworks pw mcp serve` | Local Hermes, scripts, tests against a stub broker |
| HTTP | `plantworks pw mcp serve --http --bind <host:port>` | Hermes in the cluster. Serves `/mcp` and runs in the team's namespace next to its broker |

There is one server per team, and **the team is fixed by the server, never chosen by a
caller**. The server reads `PLANTWORKS_BROKER_URL` (the team's broker) and `PLANTWORKS_TEAM`.
A tool call has no `team` argument, so a profile cannot submit to another team's queue.

A broker can serve several teams (PW-17 loads every team spec in its directory), and a
`jobId` does not name its team. So the server also **checks `record.team` on every read**:
a job of another team answers `not_found`, exactly as an unknown job does. Cancel reads the
job first and cancels only if it is this team's. A job's team never changes, so the order is
safe. The broker token itself is broker-wide. The team scope is this server's, for the
Hermes profile.

Hermes profile entry. PW-24 adds it to the PW-20 emitter (`hermesProfileConfig()`) after PW-20
merges, along with the skill at `hermes-profile/skills/plantworks-bridge/SKILL.md`. A Hermes
0.22.5 profile home reads its skills from `skills/`:

```yaml
mcp_servers:
  plantworks:
    url: "${PLANTWORKS_MCP_URL}"            # the team's MCP endpoint, set by the platform
    headers:
      Authorization: "Bearer ${PLANTWORKS_MCP_TOKEN}"
    tools:
      include: [job_submit, job_inspect, job_cancel]
```

Hermes shows the tools to the model as `mcp_plantworks_job_submit`,
`mcp_plantworks_job_inspect` and `mcp_plantworks_job_cancel`. It refuses to connect if a
`${VAR}` in `url` or `headers` is unset, so a missing token fails closed.

## Authentication

- **HTTP always needs a bearer token**, loopback included, as with upstream's
  `rig mcp serve --http`: a proxy or tunnel can deliver remote traffic to loopback. The
  server reads the expected token from `PLANTWORKS_MCP_TOKEN` and compares it in constant
  time. It refuses to start in HTTP mode without one. There is one token per team, not a
  grant file. Rotating it means a restart.
- **stdio** is the local owner, like upstream's stdio server.
- **Broker credentials stay server-side.** The broker requires `Authorization: Bearer` from
  `PLANTWORKS_BROKER_TOKEN` on any bind other than loopback (PW-16/PW-17), so it does in a cluster. The
  MCP server reads that token from its own environment and sends it only to
  `PLANTWORKS_BROKER_URL`. Hermes never sees it and no tool returns it. The MCP token and the
  broker token are different secrets.
- Secrets reach both sides by name only (the profile `.env` or External Secrets). The kit
  carries no values.

## Tools

Every tool returns its JSON as text and as `structuredContent`. An error is `isError: true`
with `structuredContent: { ok: false, code, message }`, the same shape as upstream's MCP
errors.

### `job_submit`

Submits a job to the team's queue. It is idempotent: the same board, card and attempt
return the existing job and do not create a second one.

| Input | Required | Maps to |
|---|---|---|
| `board` | yes | the `jobId` board slug (Hermes kanban board) |
| `cardId` | yes | the `jobId` card (Hermes kanban task ID, for example `t_3fa9c01e`) |
| `attempt` | yes | positive integer. A new attempt is how Hermes retries a `failed` job. It creates a new job; the broker does not move the previous attempt to `retried` (a documented PW-17 gap), so that one stays `failed` |
| `prompt` | yes | `task.prompt`, at most 65,536 characters |
| `title` | no | `task.title`, at most 200 characters |
| `class` | no | queue class. When absent the broker uses the team's default (16K) class |
| `timeoutSeconds` | no | at most the class ceiling, which the broker enforces |

The server builds `jobId = kb-<board>-<cardId>-a<attempt>` and `team` itself, then checks the
envelope with `validateEnvelope()` from `../contract/job.ts` before calling the broker. The
broker remains the authority.

Output: `{ jobId, state, created }`. `created: false` means an existing job came back.

**Submit never reveals another team's job.** A `jobId` is unique across the whole broker,
and the broker's 409 `job_conflict` body carries the existing record in `job`, which can be
another team's. The server:

- never forwards the broker's `job` field, or any record from an error body;
- answers a 409 with only `{ code: "job_conflict", jobId }`. Whether the clash is with this
  team or another, it adds no state, team, class or detail;
- checks `team` on a 200 or 201 record as well. A record of another team is never returned:
  it answers the same terse `job_conflict` (the broker matches whole envelopes, team
  included, so this can't happen today; the check is there in case that changes).

### `job_inspect`

Reads one job and, once it has ended, a bounded part of its result.

| Input | Required | Meaning |
|---|---|---|
| `jobId` | yes | a full `jobId` |
| `resultOffset` | no | character offset into the result text, for reading the next page (default 0) |

Output:

```jsonc
{
  "jobId": "kb-social-media-t_3fa9c01e-a1",
  "state": "done",               // see ../contract/README.md
  "detail": { "outcome": "succeeded" },          // the state's detail fields
  "updatedAt": "2026-10-24T10:00:00Z",
  "result": {                    // null until the job is terminal, and until a worker reports one (PW-21)
    "text": "...",               // at most 16,000 characters from resultOffset
    "offset": 0,
    "totalChars": 41230,
    "truncated": true,           // more text after this page
    "artifacts": [ { "name": "report.md", "bytes": 5120, "sha256": "..." } ]
  }
}
```

### `job_cancel`

Cancels a job that has not started (`queued` or `held`). Cancelling leaves it in `cancelled`
with reason `front-door`.

| Input | Required | Meaning |
|---|---|---|
| `jobId` | yes | a full `jobId` |
| `message` | no | at most 500 characters, stored as the cancel `message` |

A running job cannot be cancelled. The state machine has no `running -> cancelled`. The
answer is then `code: "not_cancellable"` with the current `state`, and nothing changes.
Cancelling a job that is already `cancelled` returns it unchanged, so the call is
idempotent.

### Error codes

| Code | When |
|---|---|
| `invalid_envelope` | the inputs fail `validateEnvelope()`. The message names the field |
| `not_found` | no job with that `jobId` exists **in this team** |
| `not_cancellable` | cancel on a job that is not `queued`, `held` or `cancelled` (broker 409) |
| `job_conflict` | submit reuses a `jobId` with a different envelope (broker 409), possibly another team's. It carries only the `jobId`. Nothing changes |
| `broker_rejected` | the broker returned another 400: `unknown_class`, `timeout_over_ceiling`, `unknown_team`, or `approval_unsupported` (a class that needs approval is refused until PW-23). It carries the broker's `error` and `message` |
| `broker_auth_failed` | the broker answered 401: the server's broker token is missing or wrong. This is a configuration fault, so repeating the call does not help |
| `broker_unavailable` | network error, timeout or 5xx. The call may be repeated: submit and cancel are idempotent |

## Result retrieval limits

This is what a caller can retrieve, and how much.

1. **Text in pages.** `job_inspect` returns at most **16,000 characters** of result text per
   call, about 4K tokens. Hermes needs a ≥64K context window and the model it shares has
   32K (ADR 0204), so one inspect cannot crowd out its context. `resultOffset` pages through
   the rest on request. The skill reads further pages only when the answer needs them.
2. **Artifacts as metadata only.** The kit lists the name, size and sha256 of each artifact
   and never returns artifact bytes. Fetching artifacts belongs to a later card, if it is
   needed.
3. **Team scope only.** A server returns only its own team's jobs (it checks `record.team`),
   and only by exact `jobId`. There is no list or search tool, so a caller cannot enumerate jobs or read
   another team's results.
4. **Retention is the broker's.** A result is readable while the broker keeps the job
   (PW-17 owns retention, and result storage does not exist yet). Once it is gone, inspect returns `not_found`, and the kit keeps
   no copy.
5. **Results are untrusted data.** A Pi worker that runs code produced them. The skill tells
   Hermes to treat result text as data to report, never as instructions to follow.
6. **Errors stay terse.** The `message` of a failed job is passed through, at most 2,000
   characters. Stack traces and broker internals are never returned.

## How Hermes learns a job finished: by pulling, within a budget

**Event push into Hermes is unsupported.** The broker sends `plantworks.job.state` (PW-10)
to the operator-set `events.callbackDefault`. An unmodified Hermes accepts inbound events only
through its webhook adapter, which needs an HMAC signature (`X-Webhook-Signature-V2` plus
`X-Webhook-Timestamp`), and the PW-10 emitter does not sign. Push stays unsupported until
signature and auth integration is built and verified against the pinned Hermes version. That
is a future integration gap. This kit adds no signing and no relay.

Hermes pulls with `job_inspect` instead, on a **bounded budget per request**:

- at most 5 inspects, at least 60 seconds apart (about 5 minutes in all);
- if the job is still not terminal after that, Hermes stops and tells the caller the job is
  **pending**, with its `jobId` and last state. It inspects again only when asked again or on
  a later scheduled turn, never in an open-ended loop;
- a `held` job ends the budget at once: it waits on an approval, not on time.

The tools never block or wait server-side. Each call returns at once.

## Out of scope

- Approval decisions (PW-23). The kit shows `held` but does not approve or deny.
- Registering the profile on the shared Hermes and deploying the HTTP server. Both belong
  to the platform.
- Any change to Hermes, the broker's state machine or the event fields.

## Acceptance (for the implementation PR)

Stub-only: a stub broker in the test answers the jobs API, and an MCP client from the SDK
calls the server over stdio and over HTTP. The tests check:

- idempotent submit
- envelope refusal before the broker
- the team fixed by config
- result pages and the 16,000-character bound
- artifacts as metadata only
- cancel of a running job refused
- HTTP without a token or with a wrong one refused
- no broker credential in any output
- negative tests for team isolation, against a stub broker holding another team's job:
  - submit hitting a 409 whose `job` is another team's record returns no field of it
  - a 200 replay carrying another team's record is refused
  - inspect of another team's `jobId` is `not_found`
  - cancel of another team's `jobId` is `not_found`, and the stub records no cancel call

No real Hermes, broker or inference is involved.

## Counterpart positions

PW-17 published its contract in PR #37 (`fork/schema/job-record.schema.json`,
`fork/src/broker/README.md`). That PR is not merged, so these positions hold only once it
merges and review verifies them:

| Item | Owner | Position |
|---|---|---|
| Jobs API | build (PW-17) | `POST /plantworks/v1/jobs`: 201 for a new job, 200 when the same envelope is repeated, 409 `job_conflict` when a `jobId` is reused with a different envelope, 400 `invalid_envelope`/`unknown_team`/`unknown_class`/`timeout_over_ceiling`/`approval_unsupported`, and 401 `unauthorized`. Error bodies are `{ error, message }`. `GET /plantworks/v1/jobs/{jobId}`: the record, or 404. `POST /plantworks/v1/jobs/{jobId}/cancel`: 200 for `queued`/`held` (and for an already `cancelled` job), 409 for other states, 404 when unknown |
| Job record | build (PW-17) | `{ jobId, team, class, state, detail, createdAt, updatedAt, result }`. `result` is null until the job is terminal, then `{ text \| null, artifacts: [{ name, bytes, sha256 }] }`. It stays null until the worker report path (PW-21) exists, and `artifacts` stays `[]` until artifact storage is scheduled. **No result storage exists yet.** PW-17 sets no cap on stored text, because nothing writes it yet. PW-21 adds the cap. The 16,000-character paging is client-side |
| Broker auth | build (PW-17) | Bearer `PLANTWORKS_BROKER_TOKEN` on every `/plantworks/v1/` route. The default bind is `127.0.0.1:7534`. Loopback with no token configured is unauthenticated, for Phase 0–1 development only |
| `mcp_servers.plantworks` and the skill in the emitted profile | build2 (PW-20) | PW-24 adds both to the emitter after PW-20 merges. The `${}` references stay literal |
| Event push into Hermes | lead | Unsupported; a future integration gap. No signing or relay in this card |
