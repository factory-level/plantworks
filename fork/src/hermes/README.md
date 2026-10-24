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
owner's acknowledgement.

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

Hermes profile entry (*proposed*: written into the Hermes profile file that PW-20 emits):

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
- **Broker credentials stay server-side.** If the broker needs a credential (PW-17,
  *open*), the MCP server reads it from its own environment. Hermes never sees it and no
  tool returns it.
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
| `attempt` | yes | positive integer. A new attempt is how Hermes retries a `failed` job |
| `prompt` | yes | `task.prompt`, at most 65,536 characters |
| `title` | no | `task.title`, at most 200 characters |
| `class` | no | queue class. When absent the broker uses the team's default (16K) class |
| `timeoutSeconds` | no | at most the class ceiling, which the broker enforces |

The server builds `jobId = kb-<board>-<cardId>-a<attempt>` and `team` itself, then checks the
envelope with `validateEnvelope()` from `../contract/job.ts` before calling the broker. The
broker remains the authority.

Output: `{ jobId, state, created }`. `created: false` means an existing job came back.

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
  "result": {                    // only when state is done or failed and the broker has one
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
| `not_cancellable` | cancel on a job that is not `queued`, `held` or `cancelled` |
| `broker_rejected` | the broker returned another 4xx (for example, timeout above the class ceiling, or an unknown class). It carries the broker's code and message |
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
3. **Team scope only.** A server reads only its own team's broker, and only by exact
   `jobId`. There is no list or search tool, so a caller cannot enumerate jobs or read
   another team's results.
4. **Retention is the broker's.** A result is readable while the broker keeps the job
   (PW-17 owns retention). Once it is gone, inspect returns `not_found`, and the kit keeps
   no copy.
5. **Results are untrusted data.** A Pi worker that runs code produced them. The skill tells
   Hermes to treat result text as data to report, never as instructions to follow.
6. **Errors stay terse.** The `message` of a failed job is passed through, at most 2,000
   characters. Stack traces and broker internals are never returned.

## How Hermes learns a job finished

The broker sends `plantworks.job.state` (PW-10) to the operator-set `events.callbackDefault`.
An unmodified Hermes accepts inbound events only through its webhook adapter, which needs
an HMAC signature (`X-Webhook-Signature-V2` plus `X-Webhook-Timestamp`). The PW-10 emitter
does not sign today. **Until it does, or until a relay signs on its behalf, the kit does not
claim event push into Hermes.** The skill polls with `job_inspect` (at most once every 60
seconds, while the job is not terminal). Signing is a gap outside PW-24, raised with the
lead. It changes no event fields.

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

No real Hermes, broker or inference is involved.

## Open, needs counterpart acknowledgement

| Item | Owner | Proposed |
|---|---|---|
| Jobs API paths | build (PW-17) | `POST /plantworks/v1/jobs` (201 new, 200 existing), `GET /plantworks/v1/jobs/{jobId}`, `POST /plantworks/v1/jobs/{jobId}/cancel` |
| Result shape on the job record | build (PW-17) | `result: { text, artifacts: [{ name, bytes, sha256 }] }` on `done`/`failed` |
| Broker authentication | build (PW-17) | a bearer token the MCP server holds, or none inside the namespace (NetworkPolicy) |
| `mcp_servers.plantworks` in the emitted profile | build2 (PW-20) | the block above, with `${PLANTWORKS_MCP_URL}` and `${PLANTWORKS_MCP_TOKEN}` left as references |
| Event signing for Hermes webhooks | lead (no card) | optional HMAC V2 signing in the PW-10 emitter, or a signing relay |
