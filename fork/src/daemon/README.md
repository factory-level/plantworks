<!-- SPDX-License-Identifier: Apache-2.0 -->
# Daemon boot (PW-16)

`plantworks daemon start` runs the unmodified upstream daemon as a Pi-only daemon. Every
`plantworks` command shares these defaults, so `plantworks ps`, `plantworks queue ...` and the
`pw` verbs all talk to the same daemon and home. `boot.ts` sets them as environment that upstream
already reads, before any upstream module loads. Nothing outside `fork/` changes.

| Setting | Plantworks | Upstream `rig` | Overridden by |
|---|---|---|---|
| Home | `~/.plantworks` | `~/.openrig` | `PLANTWORKS_HOME`, then `OPENRIG_HOME`. `PLANTWORKS_HOME` wins when both are set: inside an OpenRig seat `OPENRIG_HOME` is that seat's own home. With `PLANTWORKS_HOME` set, the inherited `OPENRIG_URL`, `OPENRIG_HOST` and `OPENRIG_PORT` (and their `RIGGED_` names) are ignored with a notice, even an intentional port: it comes from the selected home's `daemon.port`, else 7533. So are the database, transcripts, shared-docs, slices and dogfood-evidence paths that resolve outside that home, through any symlink |
| Port | 7533 | 7433 | `OPENRIG_PORT`, `daemon.port` in the home's config file, `--port` |
| Bind | `127.0.0.1` only | loopback, plus the Tailscale interface when one is detected | in precedence order: `daemon start --host` (the last one wins), `OPENRIG_BIND_HOST`, `daemon.host` in the config file |
| A second daemon on a database another daemon holds (`daemon.db_conflict`) | `stop`: it exits before opening the database | `warn` | `OPENRIG_DAEMON_DB_CONFLICT`, or `daemon.dbConflict` in the home's config file. `daemon start --allow-db-conflict` lets one start through |
| Kernel (Claude/Codex operator and advisor) | always off (`OPENRIG_NO_KERNEL=1`) | on | not overridable |
| Start-time bearer check (not request auth; see Limitations) | a token must be set before any non-loopback bind, Tailscale addresses included | required for public binds; Tailscale is exempt | `OPENRIG_AUTH_BEARER_TOKEN` |

With a non-loopback bind and no `OPENRIG_AUTH_BEARER_TOKEN`, `plantworks daemon start` exits 2
before it starts anything. Every other command only warns and pins any daemon it auto-starts
(`up`, `context`) to `127.0.0.1`, so `plantworks config set daemon.host 127.0.0.1` still works
as a fix. With a token, `OPENRIG_TERMINAL_BEARER_TOKEN` defaults to that token too, because
upstream leaves the terminal routes open on a Tailscale bind.

Pi-only means that nothing in the boot needs Claude or Codex. The test boots the daemon with
neither of them on `PATH`. Pi seats are started later by the broker and the workers (PW-17 and
PW-21).

## Defaults open for review

- A database conflict stops a start by default. Upstream confirms a conflict only when `lsof`
  shows another process holding the file and that daemon's `daemon.json` and `/healthz` agree.
  It reads a slow or failing probe (`lsof` over 1 s, `/healthz` over 500 ms) as "no holder" and
  starts. So under `stop`, `plantworks daemon start` first runs the same probes itself
  (`db-conflict.ts`, 2 s each), before upstream spawns its daemon. A confirmed other daemon, or a
  probe that can't answer (a missing or hanging `lsof`, an unreadable `daemon.json`, a `/healthz`
  that doesn't answer for a matching record), stops the start with one line and exit 2. A database
  that doesn't exist yet skips the probes. `warn`, `--allow-db-conflict` and
  `OPENRIG_ALLOW_DB_CONFLICT=1` skip the pre-check and keep upstream's behaviour. It is a
  best-effort check for a confirmed holder, not an atomic lock: a daemon that opens the database
  after the check isn't seen, and neither is a holder in another container. The runtime image installs `lsof`
  (`fork/container/Dockerfile`). Its smoke test runs the boot regressions as uid 10001 in
  a disposable container with no network or host mounts, including a refused second daemon
  on the same database and the deliberate `--allow-db-conflict` escape.

- Explicit-home containment resolves dangling symlinks too, so an inherited link cannot
  redirect a newly created database or write directory outside the selected home. A path
  must be inside both as the filesystem reads it (symlinks before `..`) and after lexical
  `..` normalisation, the way upstream's `path.join`/`resolve` reads it. Cycles and paths
  whose identity cannot be established stop the binary before upstream initialization,
  with one line naming the variable (exit 2).
  In-home overrides are retained; a deliberate external DB can still be selected through
  `daemon start --db` or the selected home's `db.path` config. Explicit ports use `--port`
  or that home's `daemon.port`. Without `PLANTWORKS_HOME`, the existing OpenRig environment
  overrides retain their original precedence.

- The port is 7533, so the daemon can run next to an OpenRig daemon on 7433.
- The kernel is always off. Plantworks never wants the operator or advisor seats.
- The bearer token is required even on Tailscale binds. This is stricter than upstream, which
  treats the tailnet's ACLs as the auth boundary.

## Limitations

- **A non-loopback bind is unsupported in Phase 0-1.** The token is not daemon authentication.
  It gates only what upstream gates with it: the terminal routes, and the Mission Control, hosts
  and rig-mode verbs. It does **not** authenticate queue reads or writes. On a non-loopback bind
  with a token set, `/api/ps`, `/api/rigs` and `/api/queue/list` still answer without one, and
  `POST /api/queue/create` with a self-asserted `X-OpenRig-Session` header still creates work for
  a seat. So any network peer could read the fleet and queue work. Binding beyond loopback
  needs real route-level auth first, which is not built.
- The daemon still needs `tmux`, because upstream's preflight checks for it.
- On boot, upstream tries to fetch its plugin bundle over the network. It falls back to the
  vendored copy when the fetch fails, so the daemon also boots offline.
