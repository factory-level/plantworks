<!-- SPDX-License-Identifier: Apache-2.0 -->
# Remote seats: routing exec and seat agent (PW-32)

The unmodified upstream daemon drives tmux through two injectable executors. One takes argv,
used for most commands; the other takes a shell string, used for `new-session` probes,
`if-shell`, `tmux -D` and `kill <pid>`. The router replaces both, through the PW-31 seam:

```ts
const router = createSeatRouter({ routes: new Map([["rs-worker-1", transport]]) });
await startServer(port, { argvExec: router.argvExec, tmuxExec: router.tmuxExec });
```

A tmux command aimed at a session in `routes` goes to that session's **seat agent** over a
`SeatTransport`. Everything else runs locally through upstream's own executors
(`execArgvCommand`, `execPreflightCommand`). The agent runs on the host that holds the seats.
It checks each command, runs tmux with argv, and returns tmux's exit code, stdout and stderr
unmodified.

**No real transport ships.** There is no SSH, no listener and no auth: only the `SeatTransport`
type and `inProcessTransport`, the test fake. There is also no `pw` verb, because without a
transport there is nothing to route to. A real transport and its auth are a separate card.

## What upstream sees

Upstream sees tmux's own text, and gets a failure wherever the router can't reproduce local
behaviour.

**A routed non-zero exit** becomes the error that upstream's `withExecOutput` builds for a local
one: `Command failed: …` with the output, and `execStderr` set to the remote stderr. Upstream's
classifiers therefore read the remote tmux's own words. A remote `can't find session` is absent,
and a remote `no server running` is `transport_unavailable`.

**A router refusal or an unreachable agent** throws an error that starts with
`plantworks remote seat:`. It never contains any text upstream reads as absence. The tests pin
that list against upstream's classifiers. Upstream therefore never reads an unreachable seat as
gone, and never detaches or reaps it. A probe throws, and a write fails as `unknown`.

**The router never retries.** One routed call is one attempt. Timeouts belong to the transport,
and a timeout surfaces as unreachable.

## Routing rules

| Command | Where it goes |
|---|---|
| `-t` (or `-s` for `new-session`) names a routed session: `name`, `=name`, `name:0.0` | that session's agent |
| `-t` is an id (`$N`, `@N`, `%N`) | the server whose output reported it. Ids are per server, so an id seen on two servers is refused, and an id seen on neither stays local |
| `list-sessions`, `list-panes -a`, `list-windows -a`, `list-clients` | local plus each agent once, lines concatenated. If any agent is unreachable or fails, the call throws, because a partial list would read a remote seat as dead. An agent with no tmux server contributes no lines |
| `load-buffer -b <buf> <file>` | local, as upstream does it; the router also keeps the contents. A buffer has no target, so the routed `paste-buffer -b <buf>` that follows first ships it to the agent (`load-buffer … -`, contents on stdin) and then deletes the unpasted local copy |
| `[start-server ;] source-file <file>` | the router reads the staged file. If its one command targets a routed session, the file is sent as `source-file -` with the contents on stdin |
| any other routed command naming a path under the temp dir | refused. Staged scripts and the scoped launch env file only exist locally |
| shell strings | parsed strictly (bare words, `'…'`, `"…"` without `$`, `` ` `` or `\`). A routed target goes to the agent. Unparseable text that names a routed session is refused; otherwise it runs locally |
| `tmux -D …` | always local |
| `kill -TERM\|-KILL <pid>`, with any route configured | only for a local tmux pane's process or a descendant of one (Linux `/proc`), and never for a pid seen in routed `pane_pid` output. Otherwise it is refused |

The kill rule closes a real hazard. `getPanePid()` is argv-routed, so it returns a remote pid,
and `signalPaneProcess` and `signalPid` then run a local `kill`. Without the rule, a remote
seat's restart or cutover could signal an unrelated local process. With it, the router never
signals a remote process: a stop aimed at a remote seat fails, and the seat is not reported
stopped.

## Seat agent

`createSeatAgent({ prefix, run })` accepts only `tmux` with a subcommand that upstream's adapter
sends to a seat:

> `has-session`, `new-session`, `kill-session`, `display-message`, `capture-pane`, `send-keys`,
> `load-buffer`, `paste-buffer`, `delete-buffer`, `list-panes`, `list-windows`, `list-sessions`,
> `list-clients`, `set-option`, `show-option`, `show-options`, `set-environment`,
> `show-environment`, `respawn-pane`, `resize-window`, `pipe-pane`, `if-shell`, `source-file`

Anything else, and any shape below that doesn't match, gets exit `2` with
`plantworks seat-agent: …` on stderr. That covers global flags such as `-L` or `-D`, and any
non-tmux argv.

- **Scope.** Every target must be a session whose name starts with `prefix`. An id target is
  resolved to its session first.
- **Enumeration** gets a `-f` filter for that prefix, so an agent never lists another session.
- **Option commands** may not use `-g` or `-s`, because those reach the whole server.
- **Separators.** No argument may end in `;`, the tmux command separator, except in the one
  `start-server ; source-file -` form.
- **`pipe-pane`** may only stop a pipe; starting one carries a shell command.
- **`if-shell`** is accepted only in upstream's guarded kill form,
  `-F -t $N <cond> "kill-session -t '$N'" "display-message -p kept"`.
- **`source-file -`** must hold exactly one `new-session` or `set-environment` line, in the
  strict quoting upstream writes. **`load-buffer`** and **`delete-buffer`** are accepted only as
  `-b <name> [-]`.

**The allowlist is not a sandbox.** `new-session`, `respawn-pane` and `send-keys` run commands
in seats by design, so whoever can reach an agent can run code on its host. The transport's auth
is the boundary, and it isn't built.

## Decisions (spec open questions)

- **Prefix.** It is configurable, and `rs-` is the suggested convention. The routes map should
  list every session an agent's prefix covers. Otherwise upstream sees an unrouted remote session
  in an enumeration and looks for it locally.
- **`respawn-pane` is allowed.** It grants nothing that `send-keys` doesn't already grant, and
  upstream's restart-in-place and the parent-env respawn after `new-session` use it.

## Limits

- **No remote stop.** Nothing here physically stops a remote Pi or process, and no timeout,
  drain or grace period should be read as one.
- **Scoped launch environments can't run on a remote seat.** Upstream stages the env file
  locally, so the router refuses that `new-session`. Launching a remote seat with a scoped
  environment fails closed.
- **Transcript piping can't run on a remote seat.** Starting a `pipe-pane` carries a local sink
  command, and the agent refuses it.
- **Global reads stay local.** `show-options -g`, `show-environment -g` and the server options
  have no target, so they read the daemon's local server.
- **Injecting `tmuxExec` changes two things in upstream.** Upstream prints attach commands in the
  default-server form (`setDaemonTmuxServer([])`, `startup.ts:519`). Injecting `argvExec` turns
  off tmux control mode (`OPENRIG_TMUX_CONTROL`, `startup.ts:514`). A daemon on a non-default
  tmux server isn't handled.
- **Id learning skips pane text.** Ids are learned from tmux output, not from `capture-pane`.
  An id that first appears in some other place is treated as local.
- **Nothing is verified against a real remote host,** or under latency.

## Tests

| File | What it runs against |
|---|---|
| `router.test.ts` | fakes. Covers routing, ids, error parity through upstream's `TmuxAdapter` (with the absence list pinned to upstream's classifiers), enumeration fan-out, temp-file shipping and strict shell parsing |
| `remote-tmux.test.ts` | two private tmux sockets on this host. Covers the agent allowlist and scope; the kill guard, with a live remote pane process as the witness; create, write, read and kill through upstream's adapter; and `startServer` end to end. The daemon lists the remote seat, and fails the listing when the agent is down rather than drop the seat. Skipped without tmux |
