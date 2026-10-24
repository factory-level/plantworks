<!-- SPDX-License-Identifier: Apache-2.0 -->
# Daemon boot (PW-16)

`plantworks daemon start` runs the unmodified upstream daemon as a Pi-only daemon. Every
`plantworks` command shares these defaults, so `plantworks ps`, `plantworks queue ...` and the
`pw` verbs all talk to the same daemon and home. `boot.ts` sets them as environment that upstream
already reads, before any upstream module loads. Nothing outside `fork/` changes.

| Setting | Plantworks | Upstream `rig` | Overridden by |
|---|---|---|---|
| Home | `~/.plantworks` | `~/.openrig` | `OPENRIG_HOME` |
| Port | 7533 | 7433 | `OPENRIG_PORT`, `daemon.port` in the home's config file, `--port` |
| Bind | `127.0.0.1` only | loopback, plus the Tailscale interface when one is detected | `--host`, `OPENRIG_BIND_HOST`, `daemon.host` in the config file |
| Kernel (Claude/Codex operator and advisor) | always off (`OPENRIG_NO_KERNEL=1`) | on | not overridable |
| Bearer token | required for any non-loopback bind, Tailscale addresses included | required for public binds; Tailscale is exempt | `OPENRIG_AUTH_BEARER_TOKEN` |

With a non-loopback bind and no `OPENRIG_AUTH_BEARER_TOKEN`, the binary exits 2 before it
starts anything. With a token, `OPENRIG_TERMINAL_BEARER_TOKEN` defaults to that token too,
because upstream leaves the terminal routes open on a Tailscale bind.

Pi-only means that nothing in the boot needs Claude or Codex. The test boots the daemon with
neither of them on `PATH`. Pi seats are started later by the broker and the workers (PW-17 and
PW-21).

## Defaults open for review

- The port is 7533, so the daemon can run next to an OpenRig daemon on 7433.
- The kernel is always off. Plantworks never wants the operator or advisor seats.
- The bearer token is required even on Tailscale binds. This is stricter than upstream, which
  treats the tailnet's ACLs as the auth boundary.

## Limitations

- The bearer token protects only what upstream gates with it: Mission Control write verbs, the
  terminal routes, and the routes that reuse those tokens. Most read and queue routes stay
  unauthenticated on any bind. Phase 0-1 binds loopback only; route coverage should be revisited
  before a cluster deploy exposes a non-loopback bind.
- The daemon still needs `tmux`, because upstream's preflight checks for it.
- On boot, upstream tries to fetch its plugin bundle over the network. It falls back to the
  vendored copy when the fetch fails, so the daemon also boots offline.
