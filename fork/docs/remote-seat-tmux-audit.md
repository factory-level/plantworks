<!-- SPDX-License-Identifier: Apache-2.0 -->
# Remote seats: audit of the daemon's direct tmux users (PW-32)

The PW-32 router (`fork/src/remote/`) can only route tmux commands that reach it. It is injected
as both of the daemon's tmux executors. This audit asks which daemon code reaches tmux some other
way, and what each path would do for a remote seat.

- **Revision:** every `file:line` refers to `factory-level/plantworks` main at `81a0529e`, the
  merge of PR #65. Upstream `packages/daemon/src` is unchanged there from `54ceb979`.
- **Method:** source reading only. Each "remote seat" consequence is **source inference**. No
  probes were run for this audit, and nothing was run against a remote host. The behaviour the
  PR #65 tests show is cited as **tested** where it applies.
- **Scope:**
  - the three users the PW-32 card names;
  - every non-test file under `packages/daemon/src` that imports a tmux executor, spawns tmux,
    runs a `tmux …` string, or takes a tmux adapter or exec;
  - files that only mention "tmux" as text are listed once.
- **Status:** recommendations only. Nothing here changes code.

## How tmux is reached

- **The wiring.** `startup.ts:510`–`:516` builds one `TmuxAdapter` from
  `opts.tmuxExec ?? execCommand` and `opts.argvExec ?? execArgvCommand`. With the router
  injected, both are the router.
- **Control mode is off.** The control-mode client (`tmux-control.ts`, `spawnTmuxClient` at
  `tmux-exec.ts:112`) is built only when the argv exec is the default `execArgvCommand`
  (`startup.ts:514`–`:515`), so it never runs with the router.
- **No other executor imports.** Only `startup.ts` imports the executors. `routes/rigspec.ts:14`,
  `domain/bootstrap-orchestrator.ts:27` and `domain/rigspec-preflight.ts:6` import helpers from
  `preflight-exec.ts`, not executors.
- **Two direct `tmux …` shell strings outside the adapter.** One is `runtime-verifier.ts:59`
  (`tmux -V`). The other is the adapter's own shell calls (`tmux.ts:423`, `:456`, `:575`), which
  use the injected `tmuxExec`. No `spawn`/`execFile` of tmux exists outside `tmux-exec.ts`.
- **Other exec consumers get the injected exec.** `runtime-verifier` (`startup.ts:818`–`:821`),
  Compose (`:720`) and preflight (`:792`, `:1086`) all receive `opts.tmuxExec ?? …`. The router
  runs their non-tmux commands, and an untargeted `tmux -V`, on the local executor (tested in
  PR #65: "shell commands … run locally otherwise").

**Result:** no daemon code path runs tmux around the router once it is injected. The open risks
are in routed code that assumes the tmux server is on this host. They are listed under
"Findings".

## The three named users

| User | How it reaches tmux | Remote seat (source inference) |
|---|---|---|
| `domain/claim-service.ts` | The injected adapter (`startup.ts:1256`). It reads panes, sets options and sends through `SessionTransport`, and verifies the runtime by pane pid (`:462`, `:595`) | tmux calls are routed. The runtime proof reads the **local** process table (finding 1). A remote seat's runtime stays unproven and is recorded as drift ("runtime unverified", `:597`–`:598`). That is non-destructive |
| `terminal/TerminalSessionBroker.ts` | The injected adapter (`c.get("tmuxAdapter")`): `has-session`, `set-option`, `resize-window`, `send-keys`, `capture-pane`, and `pipe-pane` for the live view | Reads and writes are routed. Starting `pipe-pane` names a local sink, and the PR #65 agent refuses it, so a remote seat's live terminal stream fails instead of streaming (finding 2) |
| `adapters/stub-runtime-adapter.ts` | The injected adapter (`deps.tmux`, `startup.ts:890`): `sendText`, `sendKeys`, `hasSession`, `getPaneCommand` | Routed. Text ships as stdin (tested) |

## Other users

| File | Class | Remote seat (source inference) |
|---|---|---|
| `adapters/tmux-control.ts`, `adapters/tmux-exec.ts` | the default executors and control client | not used once the router is injected (`startup.ts:510`–`:516`) |
| `domain/runtime-verifier.ts:59` | injected `tmuxExec`, `tmux -V` | no target, so it runs locally and reports the local tmux version |
| `domain/seat-identity-reconciler.ts` | adapter (`startup.ts:569`–`:572`), plus pane pid against `listNativeProcesses` (`:122`) | tmux calls are routed. The pid is looked up locally (finding 1) |
| `domain/seat-attention-reconciler.ts` | adapter (`startup.ts:1315`), plus pane pid against `listNativeProcesses` (`:80`) | tmux calls are routed. The pid is looked up locally. The explanation already treats a missing row as "could not be verified", not as absence (`:78`–`:81`) |
| `domain/seat-lifecycle-service.ts`, `rig-teardown.ts`, `restore-orchestrator.ts`, `node-cmux-service.ts`, `routes/rig-cmux.ts`, `running-name-guard.ts` | adapter: `probeSession`, `killSession`, `startServer` | routed. An unreachable agent throws rather than reading as absent (tested). `tmux -D` stays local |
| `domain/node-launcher.ts`, `successor-session-launcher.ts` | adapter: `createSession`, env, `respawnPane` | routed. A scoped launch environment names a local temp file, so the router refuses it (finding 3) |
| `domain/session-transport.ts`, `routes/rigs.ts`, `transcript-rotation.ts`, `seat-structural-activity-service.ts`, `seat-activity-service.ts`, `pane-binding-observation.ts`, `node-inventory.ts` | adapter: send, capture, list | routed. `list-* -a` fans out and fails closed (tested) |
| `routes/transcripts.ts`, `domain/self-attach-service.ts` | adapter: `pipe-pane` transcript capture | refused for a remote seat (finding 2) |
| `domain/seat-switch-client-service.ts` | adapter: `list-clients`, `switch-client` | listing fans out. `switch-client` on a remote target is refused by the agent's allowlist |
| `domain/tmux-option-defaults.ts` | adapter: session and server options | session options are routed. Server-wide (`-s`/`-g`) options have no target and stay local |
| `context-monitor.ts`, `session-registry.ts`, `whoami-service.ts`, `rig-repository.ts`, `preview/preview-rate-limiter.ts`, `adapters/tmux-server.ts`, `routes/up.ts`, `cmux-layout-service.ts`, `terminal/view-composer.ts` | text only: labels, SQL literals, attach-command text | not tmux users. Attach commands print in the default-server form (`startup.ts:519`) |

## Findings and recommendations

1. **Remote pane pids are checked against the local process table.**
   - **Where:** `claim-service.ts:462` and `:595`, `seat-identity-reconciler.ts:122` and
     `seat-attention-reconciler.ts:80`. The pid comes from the routed `getPanePid`; the table is
     the local `ps` (`process-table.ts:43`).
   - **Effect, by inference:** a remote seat's runtime is never proven. Its identity verdict and
     claim projection show it unverified. If a remote pid happens to match a local process, the
     verdict could read another process's tree. Nothing found here kills a process or reaps a
     seat on this result; the kill path is closed separately by PR #65.
   - **Recommendation:** a follow-up card to give these consumers a remote-aware
     `listProcesses`, or to mark routed seats as "runtime not locally verifiable". Until then,
     document that remote seats never reach a green identity verdict.
2. **The live terminal stream and transcript capture don't work for remote seats.**
   - **Why:** `pipe-pane` takes a sink command that runs on the tmux server's host
     (`tmux.ts:1325`–`:1328`). The agent refuses to start one, which fails closed.
   - **Recommendation:** a transport-level stream from the agent, scoped with the real
     transport card.
3. **Scoped launch environments can't run on remote seats.**
   - **Why:** the staged env file is local (`tmux.ts:385`–`:388`), and the router refuses it.
   - **Recommendation:** ship the env through the agent (stdin) when a real transport exists,
     with the same allowlist review.
4. **Global reads stay local.**
   - **Why:** `show-options -g`, `show-environment -g` and the server options have no target
     (`tmux.ts:372`, `:375`, `:1210`, `:1289`, `:1549`, `:1564`).
   - **Effect, by inference:** defaults such as `default-shell` used for a remote seat come
     from the daemon's server.
   - **Recommendation:** accept and document this, or route per-seat reads when a seat needs
     its host's defaults.
5. **Attach commands print the local default-server form** (`startup.ts:519`). An operator
   can't attach to a remote seat from those commands. **Recommendation:** document it in the
   transport card.

None of these is fixed here. Findings 2 to 5 restate limits that `fork/src/remote/README.md`
already records. Finding 1 is new.
